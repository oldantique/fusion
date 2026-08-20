/**
 * Spawn a CLI and yield its stdout line by line (NDJSON). Handles timeout, abort,
 * stderr capture and exit status in one place so providers stay declarative.
 */
import { spawn } from "node:child_process";
import readline from "node:readline";
import { config } from "../config.ts";

export interface RunOptions {
  cmd: string;
  args: string[];
  /** Written to stdin then closed; undefined means stdin is /dev/null. */
  stdin?: string;
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

export type ProcessLine = { kind: "line"; line: string };
export type ProcessExit = {
  kind: "exit";
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
};

export class ProcessError extends Error {
  readonly exit: ProcessExit;
  constructor(message: string, exit: ProcessExit) {
    super(message);
    this.exit = exit;
  }
}

/**
 * Environment for child CLIs: drop variables a parent Claude Code session would leak into us
 * (they mark the child as a nested session and can override effort/model), keep everything else.
 */
export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_") || k === "CLAUDE_PID" || k === "CLAUDE_EFFORT") continue;
    // Note this also drops CLAUDE_CODE_MAX_OUTPUT_TOKENS. Deliberate for now: the CLI's per-model
    // default is generous and it auto-continues past the cap (only --output-format json loses the
    // head of the answer; the stream parser accumulates every message). If the synthesizer's
    // structured output ever truncates, whitelist that one variable here and set it in .env.
    env[k] = v;
  }
  // kimi is a Node binary and this host has AAAA records but no IPv6 egress; Node's default
  // per-family connect attempt (a fraction of a second) gives up before falling back to IPv4 and
  // kimi's OAuth refresh fails with "fetch failed". The interactive shell sets the same option in
  // ~/.bashrc, which is why the failure only shows up under systemd. Appended, never overriding.
  const autoselect = "--network-family-autoselection-attempt-timeout=3000";
  if (!env.NODE_OPTIONS?.includes("network-family-autoselection")) {
    env.NODE_OPTIONS = [env.NODE_OPTIONS, autoselect].filter(Boolean).join(" ");
  }
  return env;
}

/** Yields stdout lines, then exactly one `exit` record. Never throws for non-zero exit. */
export async function* runLines(opts: RunOptions): AsyncGenerator<ProcessLine | ProcessExit> {
  const timeoutMs = opts.timeoutMs ?? config.laneTimeoutMs;
  const child = spawn(opts.cmd, opts.args, {
    cwd: opts.cwd ?? config.sandboxDir,
    env: opts.env ?? childEnv(),
    stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });

  let stderr = "";
  let timedOut = false;
  let aborted = false;
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (d: string) => {
    if (stderr.length < 64_000) stderr += d;
  });

  if (opts.stdin !== undefined) {
    child.stdin!.on("error", () => {});
    child.stdin!.end(opts.stdin);
  }

  const kill = () => {
    if (child.exitCode === null && !child.killed) {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 5_000).unref();
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutMs);
  const onAbort = () => {
    aborted = true;
    kill();
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
    child.on("error", (err) => {
      stderr += `\nspawn error: ${err.message}`;
      resolve({ code: -1, signal: null });
    });
  });

  try {
    const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.length > 0) yield { kind: "line", line };
    }
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
  const { code, signal } = await exitPromise;
  yield { kind: "exit", code, signal, stderr, timedOut, aborted };
}

/** Parse a line as JSON; returns undefined for non-JSON noise (banners etc.). */
export function tryJson(line: string): any | undefined {
  const t = line.trim();
  if (!t.startsWith("{")) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/** Simple counting semaphore for per-provider concurrency caps. */
export class Semaphore {
  private queue: (() => void)[] = [];
  private active = 0;
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    return () => this.release();
  }

  private release() {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }

  get waiting(): number {
    return this.queue.length;
  }

  /** True when acquire() would block right now. */
  get isFull(): boolean {
    return this.active >= this.max;
  }
}
