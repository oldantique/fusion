/**
 * Spawn a CLI and yield its stdout line by line (NDJSON). Handles timeout, abort,
 * stderr capture and exit status in one place so providers stay declarative.
 *
 * Lifecycle rules (each learned from a real failure mode):
 *  - the child is its own process group and the whole group is signalled, because the CLIs
 *    spawn helpers that would otherwise outlive a timeout;
 *  - the timeout and abort hooks stay armed until the child has actually exited, not until
 *    stdout ends — a child that closes stdout and keeps running must still be killed;
 *  - a consumer that stops iterating early kills the child; nothing is left running unobserved.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { config } from "../config.ts";

/**
 * What a jailed CLI may see of the real filesystem, besides the common base in `jailArgv`.
 * Paths may start with `~`. Sources that do not exist are skipped (a CLI that is not set up then
 * fails with its own "not logged in" rather than a bwrap mount error).
 */
export interface JailMounts {
  rw?: string[];
  ro?: string[];
}

export interface RunOptions {
  cmd: string;
  args: string[];
  /** Written to stdin then closed; undefined means stdin is /dev/null. */
  stdin?: string;
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  /** When set (and FUSION_JAIL is on) the command runs inside a bubblewrap jail with these mounts. */
  jail?: JailMounts;
}

export type ProcessLine = { kind: "line"; line: string };
export type ProcessExit = {
  kind: "exit";
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  /** The executable could not be started at all (ENOENT, EACCES, ...). */
  spawnFailed: boolean;
};

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

/**
 * Environment variables that cross into the jail. Everything else is dropped (`--clearenv`): the
 * CLIs need a HOME (a tmpfs with only their own state dir bound in), a PATH, locale, proxy and
 * TLS settings — and nothing that points at files outside the jail.
 */
const JAIL_ENV_RE = /^(HOME|PATH|NODE_OPTIONS|TERM|LANG|LANGUAGE|LC_[A-Z]+|TZ|USER|LOGNAME|SHELL|NO_PROXY|no_proxy|[A-Za-z]+_PROXY|[a-z]+_proxy|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS)$/;

/**
 * Host paths every jailed CLI gets read-only: the OS, the CA bundle, DNS and user lookup.
 * `/etc` is deliberately not bound as a whole (it carries ssh and service config); the few files
 * the CLIs resolve hosts and TLS through are listed one by one.
 */
const JAIL_BASE_RO = [
  "/usr",
  "/lib",
  "/lib64",
  "/bin",
  "/sbin",
  "/etc/resolv.conf",
  "/etc/hosts",
  "/etc/nsswitch.conf",
  "/etc/passwd",
  "/etc/localtime",
  "/etc/ssl/certs",
  "/etc/ca-certificates",
];

const expandHome = (p: string, home: string) => (p === "~" || p.startsWith("~/") ? path.join(home, p.slice(1)) : p);

/**
 * Where a CLI's code lives, so the jail can see it: the PATH directory its name resolves in and,
 * following the symlink, the package root (the outermost `node_modules` for an npm install, else
 * the binary's own directory). Only the install is exposed, never the rest of the home directory.
 */
export function cliInstallDirs(cmd: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (!cmd.includes("/")) {
    for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
      const candidate = path.join(dir, cmd);
      if (fs.existsSync(candidate)) {
        cmd = candidate;
        break;
      }
    }
    if (!cmd.includes("/")) return []; // not on PATH; let the spawn fail with ENOENT as before
  }
  const linkDir = path.dirname(cmd);
  let target: string;
  try {
    target = fs.realpathSync(cmd);
  } catch {
    return [linkDir];
  }
  const nm = target.indexOf(`${path.sep}node_modules${path.sep}`);
  const root = nm >= 0 ? target.slice(0, nm + "/node_modules".length) : path.dirname(target);
  return [...new Set([linkDir, root])];
}

/**
 * Wrap a command in a bubblewrap jail. Pure: given the same inputs it returns the same argv, so
 * the test can assert on it. The jail is a fresh mount namespace holding the read-only base, a
 * tmpfs HOME and /tmp with only the provider's mounts bound in, the empty sandbox cwd (writable,
 * so a CLI that insists on a scratch file still works), and nothing else of this machine.
 * `--die-with-parent` + `--unshare-pid` make the CLI and every helper it spawns die with bwrap,
 * which is in the process group `runLines` signals.
 */
export function jailArgv(
  cmd: string,
  args: string[],
  mounts: JailMounts,
  env: NodeJS.ProcessEnv,
  cwd: string,
  opts: { home?: string; exists?: (p: string) => boolean; installDirs?: string[] } = {},
): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
  const home = opts.home ?? os.homedir();
  const exists = opts.exists ?? fs.existsSync;
  const installDirs = opts.installDirs ?? [...cliInstallDirs(cmd, env), path.dirname(fs.realpathSync(process.execPath))];
  const out = ["--clearenv"];
  const jailEnv: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && JAIL_ENV_RE.test(k)) jailEnv[k] = v;
  }
  jailEnv.HOME = home;
  for (const [k, v] of Object.entries(jailEnv)) out.push("--setenv", k, v!);
  for (const p of JAIL_BASE_RO) if (exists(p)) out.push("--ro-bind", p, p);
  out.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", home);
  // Order matters: later binds go over earlier ones, so the provider's rw mounts (which may live
  // under a ro install root, e.g. ~/.kimi-code/bin) come after the ro ones.
  for (const p of [...installDirs, ...(mounts.ro ?? []).map((p) => expandHome(p, home))]) if (exists(p)) out.push("--ro-bind", p, p);
  for (const p of (mounts.rw ?? []).map((p) => expandHome(p, home))) if (exists(p)) out.push("--bind", p, p);
  out.push("--bind", cwd, cwd, "--chdir", cwd, "--unshare-pid", "--die-with-parent", "--", cmd, ...args);
  return { cmd: "bwrap", args: out, env: jailEnv };
}

/** Signal a child's whole process group; falls back to the child alone if the group is gone. */
function signalTree(pid: number, sig: NodeJS.Signals) {
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch {
      /* already gone */
    }
  }
}

/** Yields stdout lines, then exactly one `exit` record. Never throws for non-zero exit. */
export async function* runLines(opts: RunOptions): AsyncGenerator<ProcessLine | ProcessExit> {
  const timeoutMs = opts.timeoutMs ?? config.laneTimeoutMs;
  const cwd = opts.cwd ?? config.sandboxDir;
  let { cmd, args } = opts;
  let env = opts.env ?? childEnv();
  if (opts.jail && config.jail) {
    if (!config.bwrapPath) {
      // Refuse loudly rather than run the CLI with the whole filesystem in view.
      yield {
        kind: "exit",
        code: -1,
        signal: null,
        stderr: "bwrap not found: the lane jail needs bubblewrap (apt install bubblewrap); FUSION_JAIL=off disables it",
        timedOut: false,
        aborted: false,
        spawnFailed: true,
      };
      return;
    }
    ({ cmd, args, env } = jailArgv(cmd, args, opts.jail, env, cwd));
    cmd = config.bwrapPath;
  }
  const child = spawn(cmd, args, {
    cwd,
    env,
    stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    detached: true, // own process group, so helpers the CLI spawns die with it
  });

  let stderr = "";
  let timedOut = false;
  let aborted = false;
  let spawnFailed = false;
  let exited = false;
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (d: string) => {
    if (stderr.length < 64_000) stderr += d;
  });

  if (opts.stdin !== undefined) {
    child.stdin!.on("error", () => {});
    child.stdin!.end(opts.stdin);
  }

  let killTimer: NodeJS.Timeout | undefined;
  const kill = () => {
    if (exited || child.pid === undefined) return;
    signalTree(child.pid, "SIGTERM");
    killTimer ??= setTimeout(() => {
      if (!exited && child.pid !== undefined) signalTree(child.pid, "SIGKILL");
    }, 5_000);
    killTimer.unref();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutMs);
  const onAbort = () => {
    aborted = true;
    kill();
  };
  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener("abort", onAbort, { once: true });

  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("close", (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
    child.on("error", (err) => {
      // Emitted for spawn failures (then no 'close' follows) and for kill() failures.
      stderr += `\nspawn error: ${err.message}`;
      if (!exited && child.pid === undefined) {
        spawnFailed = true;
        exited = true;
        resolve({ code: -1, signal: null });
      }
    });
  });

  try {
    const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.length > 0) yield { kind: "line", line };
    }
    const { code, signal } = await exitPromise;
    yield { kind: "exit", code, signal, stderr, timedOut, aborted, spawnFailed };
  } finally {
    // Reached on normal completion and when the consumer stops iterating early: in the latter
    // case the child is still running and must not be orphaned.
    kill();
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
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

/** Thrown by Semaphore.acquire when the caller's signal fires while queued. */
export class AbortedError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortedError";
  }
}

/** Counting semaphore for per-provider concurrency caps. Queued waiters can be aborted. */
export class Semaphore {
  private queue: { resolve: () => void; reject: (e: Error) => void }[] = [];
  private active = 0;
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }

  /** Resolves to an idempotent release function. Rejects with AbortedError if aborted while waiting. */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new AbortedError();
    if (this.active < this.max) {
      this.active++;
      return this.releaser();
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject };
      this.queue.push(waiter);
      signal?.addEventListener(
        "abort",
        () => {
          const i = this.queue.indexOf(waiter);
          if (i >= 0) {
            this.queue.splice(i, 1);
            reject(new AbortedError());
          }
        },
        { once: true },
      );
    });
    // A permit was handed to us by release(); `active` was already incremented there.
    return this.releaser();
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }

  private release() {
    const next = this.queue.shift();
    if (next) {
      // Hand the permit straight over so the count never dips and re-admits a third party.
      next.resolve();
    } else {
      this.active--;
    }
  }

  get waiting(): number {
    return this.queue.length;
  }

  /** True when acquire() would block right now. */
  get isFull(): boolean {
    return this.active >= this.max;
  }
}
