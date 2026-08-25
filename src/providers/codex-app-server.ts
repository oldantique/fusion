/**
 * codex over `codex app-server`: one long-lived JSON-RPC daemon per service process instead of a
 * fresh `codex exec` per call. Why: exec's cold start is roughly half of a trivial lane's time
 * (measure with `npm run smoke`), its `--json` output is an unversioned shape that has changed
 * silently before, and a cancel had to kill the whole process. app-server's protocol is a
 * generated, checked-in schema (`codex app-server generate-json-schema`), a turn can be
 * interrupted without losing the daemon, token usage arrives per turn, and one daemon holding
 * one `auth.json` is exactly the serialization OpenAI asks for.
 *
 * Each call is still stateless: a fresh `ephemeral` thread, read-only sandbox, web search off,
 * the same empty sandbox cwd, then `thread/unsubscribe`. Conversation history is replayed in the
 * prompt by the synthesizer layer, never by the server (see the history policy in
 * src/synth/prompts.ts).
 *
 * Lifecycle: spawned lazily on the first call inside the same bwrap jail as every other lane;
 * a daemon that dies fails the in-flight turn with a retryable kind, so `runLane`'s retry
 * respawns it; idle for a while and it is shut down so a sleeping service holds no process.
 * The child's stdio is unref'd while no turn is running so scripts (smoke, canary, fuse) exit
 * on their own; ref'd during a turn so the event loop stays alive for it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import { config } from "../config.ts";
import type { CallOptions, LaneErrorKind, LaneEvent, Provider, Usage } from "../types.ts";
import { PROVIDER_LABELS } from "../types.ts";
import { classifyFailure } from "./base.ts";
import { childEnv, jailArgv, type JailMounts } from "./process.ts";

/** The only host path the daemon sees besides the OS and its install (same list as the exec lane). */
export const CODEX_MOUNTS: JailMounts = { rw: ["~/.codex"] };

/** A daemon with no turn for this long is stopped; the next call starts a fresh one. */
const IDLE_SHUTDOWN_MS = 10 * 60_000;
/** After `turn/interrupt`, how long to wait for the server's `turn/completed` before killing it. */
const INTERRUPT_GRACE_MS = 10_000;
/** `initialize` must answer within this or the spawn is treated as failed (a hung binary, not a slow model). */
const HANDSHAKE_MS = 30_000;

export interface RpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code?: number; message?: string; data?: unknown };
}

/** What the daemon needs from a child process; a test substitutes streams fed from a fixture. */
export interface DaemonChild {
  pid?: number;
  stdin: NodeJS.WritableStream & { unref?(): void; ref?(): void };
  stdout: NodeJS.ReadableStream & { unref?(): void; ref?(): void };
  stderr?: (NodeJS.ReadableStream & { unref?(): void; ref?(): void }) | null;
  on(event: "close", cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
  unref?(): void;
  ref?(): void;
}

/** The real spawn: `codex app-server` over stdio, jailed exactly like an exec lane. */
export function spawnAppServer(): DaemonChild {
  let cmd = "codex";
  let args = ["app-server", "--listen", "stdio://"];
  let env = childEnv();
  const cwd = config.sandboxDir;
  if (config.jail) {
    if (!config.bwrapPath) throw new Error("bwrap not found: the lane jail needs bubblewrap (apt install bubblewrap); FUSION_JAIL=off disables it");
    ({ cmd, args, env } = jailArgv(cmd, args, CODEX_MOUNTS, env, cwd));
    cmd = config.bwrapPath;
  }
  return spawn(cmd, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true }) as unknown as DaemonChild;
}

class DaemonExited extends Error {
  constructor(detail: string) {
    super(`codex app-server exited: ${detail}`);
    this.name = "DaemonExited";
  }
}

class RpcError extends Error {
  constructor(method: string, err: RpcMessage["error"]) {
    super(`${method}: ${err?.message ?? "unknown JSON-RPC error"}`);
    this.name = "RpcError";
  }
}

type Listener = (msg: RpcMessage) => void;

interface Running {
  child: DaemonChild;
  ready: Promise<void>;
  pending: Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>;
  stderr: string;
  exitDetail: string | null;
}

export interface DaemonOptions {
  spawn?: () => DaemonChild;
  idleShutdownMs?: number;
  interruptGraceMs?: number;
  handshakeMs?: number;
}

/**
 * The JSON-RPC side: one child at a time, request/response by id, notifications fanned out by
 * threadId. Everything here is transport; `codexTurn` below turns one call into lane events.
 */
export class CodexDaemon {
  private running: Running | null = null;
  private nextId = 1;
  private readonly listeners = new Map<string, Listener>();
  private activeTurns = 0;
  private idleTimer: NodeJS.Timeout | undefined;
  private readonly spawnChild: () => DaemonChild;
  private readonly idleShutdownMs: number;
  readonly interruptGraceMs: number;
  private readonly handshakeMs: number;
  /** Number of daemons spawned so far; a restart after a crash is visible here (and in tests). */
  spawns = 0;

  constructor(opts: DaemonOptions = {}) {
    this.spawnChild = opts.spawn ?? spawnAppServer;
    this.idleShutdownMs = opts.idleShutdownMs ?? IDLE_SHUTDOWN_MS;
    this.interruptGraceMs = opts.interruptGraceMs ?? INTERRUPT_GRACE_MS;
    this.handshakeMs = opts.handshakeMs ?? HANDSHAKE_MS;
  }

  get alive(): boolean {
    return this.running !== null;
  }

  /** Spawn + `initialize` handshake if no daemon is up; resolves once requests can be sent. */
  ensureStarted(): Promise<void> {
    if (this.running) return this.running.ready;
    let child: DaemonChild;
    try {
      child = this.spawnChild();
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
    this.spawns++;
    const run: Running = { child, ready: Promise.resolve(), pending: new Map(), stderr: "", exitDetail: null };
    this.running = run;

    child.stderr?.setEncoding?.("utf8");
    child.stderr?.on("data", (d: string) => {
      run.stderr = (run.stderr + d).slice(-8_000);
    });
    child.stdin.on("error", () => {});
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => this.onLine(run, line));

    const onGone = (detail: string) => {
      if (run.exitDetail !== null) return;
      run.exitDetail = detail;
      if (this.running === run) this.running = null;
      const err = new DaemonExited(`${detail}${run.stderr.trim() ? ` | ${tail(run.stderr)}` : ""}`);
      for (const p of run.pending.values()) p.reject(err);
      run.pending.clear();
      // Threads mid-turn learn about it as a synthetic notification so their loop can end.
      for (const l of this.listeners.values()) l({ method: "fusion/daemonExited", params: { message: err.message } });
    };
    child.on("close", (code, signal) => onGone(`exit ${code}${signal ? ` (${signal})` : ""}`));
    child.on("error", (err) => onGone(`spawn error: ${err.message}`));

    run.ready = (async () => {
      const timer = setTimeout(() => {
        onGone(`no answer to initialize within ${this.handshakeMs / 1000}s`);
        this.kill(run);
      }, this.handshakeMs);
      try {
        await this.request("initialize", { clientInfo: { name: "fusion", version: "0" } }, run);
        this.send(run, { jsonrpc: "2.0", method: "initialized", params: {} });
      } finally {
        clearTimeout(timer);
      }
      this.applyRef();
    })();
    run.ready.catch(() => {
      if (this.running === run) this.running = null;
      this.kill(run);
    });
    return run.ready;
  }

  /** Send a request and wait for its response; rejects on a JSON-RPC error or if the daemon dies. */
  request(method: string, params: unknown, run: Running | null = this.running): Promise<any> {
    if (!run) return Promise.reject(new DaemonExited("not running"));
    if (run.exitDetail !== null) return Promise.reject(new DaemonExited(run.exitDetail));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      run.pending.set(id, {
        resolve,
        reject: (e) => reject(e),
      });
      this.send(run, { jsonrpc: "2.0", id, method, params });
    }).then(
      (msg: any) => {
        if (msg.error) throw new RpcError(method, msg.error);
        return msg.result;
      },
    );
  }

  /** Route notifications carrying this threadId to `listener` until `unsubscribe` is called. */
  subscribe(threadId: string, listener: Listener): () => void {
    this.listeners.set(threadId, listener);
    return () => this.listeners.delete(threadId);
  }

  /** Mark a turn as running/finished: keeps the event loop alive during one, arms idle shutdown after. */
  turnStarted() {
    this.activeTurns++;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.applyRef();
  }

  turnFinished() {
    this.activeTurns = Math.max(0, this.activeTurns - 1);
    if (this.activeTurns === 0) {
      this.idleTimer = setTimeout(() => this.shutdown(), this.idleShutdownMs);
      this.idleTimer.unref();
    }
    this.applyRef();
  }

  /** Stop the daemon now (idle timeout, service shutdown, or a turn that will not end). */
  shutdown() {
    const run = this.running;
    if (!run) return;
    this.running = null;
    this.kill(run);
  }

  /** Last lines the daemon wrote to stderr; for diagnostics on a failed turn. */
  get stderrTail(): string {
    return tail(this.running?.stderr ?? "");
  }

  private applyRef() {
    const c = this.running?.child;
    if (!c) return;
    const on = this.activeTurns > 0;
    for (const s of [c, c.stdin, c.stdout, c.stderr]) (on ? s?.ref : s?.unref)?.call(s);
  }

  private kill(run: Running) {
    const pid = run.child.pid;
    try {
      run.child.stdin.end();
    } catch {
      /* already closed */
    }
    if (pid !== undefined) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        run.child.kill("SIGTERM");
      }
      const t = setTimeout(() => {
        if (run.exitDetail === null) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            run.child.kill("SIGKILL");
          }
        }
      }, 5_000);
      t.unref();
    } else {
      run.child.kill("SIGTERM");
    }
  }

  private send(run: Running, msg: RpcMessage) {
    try {
      run.child.stdin.write(JSON.stringify(msg) + "\n");
    } catch {
      /* the close handler reports it */
    }
  }

  private onLine(run: Running, line: string) {
    let msg: RpcMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not protocol: keep out of the way, stderr carries the real diagnostics
    }
    if (msg.id !== undefined && msg.method === undefined) {
      const p = run.pending.get(Number(msg.id));
      if (p) {
        run.pending.delete(Number(msg.id));
        p.resolve(msg);
      }
      return;
    }
    if (msg.method !== undefined && msg.id !== undefined) {
      // A server → client request (approval, user input, elicitation). None should arrive with
      // approvalPolicy "never" and a read-only sandbox; answer with an error rather than hang.
      this.send(run, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `fusion does not serve ${msg.method}` } });
      return;
    }
    const threadId = msg.params?.threadId;
    if (typeof threadId === "string") this.listeners.get(threadId)?.(msg);
  }
}

function tail(s: string, n = 600): string {
  const t = s.trim();
  return t.length > n ? "…" + t.slice(-n) : t;
}

/** Map a `codexErrorInfo` (typed) or message text onto our error kinds. */
export function classifyTurnError(err: { message?: string; codexErrorInfo?: unknown } | null | undefined): { message: string; kind: LaneErrorKind } {
  const message = String(err?.message ?? "codex turn failed");
  const info = err?.codexErrorInfo;
  const code = typeof info === "string" ? info : info && typeof info === "object" ? Object.keys(info)[0] : undefined;
  if (code === "usageLimitExceeded" || code === "serverOverloaded") return { message, kind: "rate_limit" };
  return { message, kind: classifyFailure(message, "exit") };
}

/**
 * One lane call as a turn on the daemon. Never throws: every failure is an `error` event with a
 * kind `runLane` knows how to treat. Yields text deltas as they stream, then one `done`.
 */
export async function* codexTurn(daemon: CodexDaemon, opts: CallOptions): AsyncGenerator<LaneEvent, void, void> {
  try {
    await daemon.ensureStarted();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    yield { type: "error", message: `codex app-server failed to start: ${message}`, kind: e instanceof DaemonExited ? "exit" : "spawn" };
    return;
  }

  daemon.turnStarted();
  let threadId: string | undefined;
  let unsubscribe: (() => void) | undefined;
  const timers: NodeJS.Timeout[] = [];
  let onAbort: (() => void) | undefined;
  try {
    const started = await daemon.request("thread/start", {
      ephemeral: true,
      sandbox: "read-only",
      approvalPolicy: "never",
      cwd: config.sandboxDir,
      model: config.models.codex,
      developerInstructions: opts.system,
      // Server-side web search is a Responses API tool, so the sandbox's networkAccess=false does
      // not cover it; this config key does (same as `web_search = "disabled"` in config.toml).
      config: { web_search: "disabled" },
    });
    threadId = started.thread.id as string;

    // Notifications are queued from the moment the thread exists so nothing between
    // thread/start and turn/start is lost.
    const queue: RpcMessage[] = [];
    let wake: (() => void) | undefined;
    unsubscribe = daemon.subscribe(threadId, (msg) => {
      queue.push(msg);
      wake?.();
    });

    const turn = await daemon.request("turn/start", {
      threadId,
      input: [{ type: "text", text: opts.prompt }],
      effort: opts.effort ?? config.effort,
    });
    const turnId = turn.turn.id as string;

    let text = "";
    let streamed = "";
    let usage: Usage | undefined;
    let reason: "aborted" | "timeout" | undefined;
    let lastError: { message: string; kind: LaneErrorKind } | undefined;
    let interrupted = false;
    const interrupt = (why: "aborted" | "timeout") => {
      if (interrupted) return;
      interrupted = true;
      reason = why;
      daemon.request("turn/interrupt", { threadId, turnId }).catch(() => {});
      // A server that never acknowledges the interrupt is a stuck daemon: restart it.
      const t = setTimeout(() => daemon.shutdown(), daemon.interruptGraceMs);
      t.unref();
      timers.push(t);
      wake?.();
    };
    onAbort = () => interrupt("aborted");
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => interrupt("timeout"), config.laneTimeoutMs);
    timers.push(timeout);

    while (true) {
      if (queue.length === 0) await new Promise<void>((r) => (wake = r));
      wake = undefined;
      const msg = queue.shift();
      if (!msg) continue;
      switch (msg.method) {
        case "item/agentMessage/delta": {
          const d = String(msg.params.delta ?? "");
          streamed += d;
          if (d) yield { type: "delta", text: d };
          break;
        }
        case "item/completed":
          // Several agent messages can complete in one turn (a plan, then the answer); keep the last.
          if (msg.params.item?.type === "agentMessage" && typeof msg.params.item.text === "string") {
            text = msg.params.item.text;
            streamed = "";
          }
          break;
        case "thread/tokenUsage/updated": {
          const u = msg.params.tokenUsage?.last;
          if (u) usage = { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cachedInputTokens };
          break;
        }
        case "error":
          if (msg.params.willRetry === false) lastError = classifyTurnError(msg.params.error);
          break;
        case "fusion/daemonExited":
          // The daemon we killed for not honouring an interrupt is still our abort/timeout.
          if (reason) yield { type: "error", message: reason === "timeout" ? `timed out after ${config.laneTimeoutMs / 1000}s (daemon restarted)` : "aborted", kind: reason };
          else yield { type: "error", message: `${msg.params.message} (mid-turn)`, kind: "exit" };
          return;
        case "turn/completed": {
          const status = msg.params.turn?.status;
          if (status === "completed") {
            const answer = text || streamed;
            if (!answer.trim()) {
              yield { type: "error", message: `empty answer: ${daemon.stderrTail || "(no diagnostics)"}`, kind: "empty" };
              return;
            }
            yield { type: "done", text: answer, usage };
            return;
          }
          if (status === "interrupted" || reason) {
            const why = reason ?? "aborted";
            yield { type: "error", message: why === "timeout" ? `timed out after ${config.laneTimeoutMs / 1000}s` : "aborted", kind: why };
            return;
          }
          const err = classifyTurnError(msg.params.turn?.error) ;
          const message = msg.params.turn?.error ? err.message : lastError?.message ?? "codex turn failed";
          yield { type: "error", message, kind: msg.params.turn?.error ? err.kind : lastError?.kind ?? "exit" };
          return;
        }
        default:
          break; // turn/started, item/started, reasoning deltas, mcp status, ...
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // A dead daemon is retryable (the retry respawns it); a rejected request is a contract
    // mismatch and retrying will not help — still `exit` so the message reaches the UI.
    yield { type: "error", message, kind: e instanceof DaemonExited ? "exit" : classifyFailure(message, "exit") };
  } finally {
    for (const t of timers) clearTimeout(t);
    if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
    unsubscribe?.();
    if (threadId && daemon.alive) daemon.request("thread/unsubscribe", { threadId }).catch(() => {});
    daemon.turnFinished();
  }
}

/** The process-wide daemon; scripts and the server share it. */
export const codexDaemon = new CodexDaemon();

export const codexAppServer: Provider = {
  id: "codex",
  label: PROVIDER_LABELS.codex,
  streams: true,
  supportsJsonSchema: false,
  call: (opts) => codexTurn(codexDaemon, opts),
};
