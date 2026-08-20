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

/** Yields stdout lines, then exactly one `exit` record. Never throws for non-zero exit. */
export async function* runLines(opts: RunOptions): AsyncGenerator<ProcessLine | ProcessExit> {
  const timeoutMs = opts.timeoutMs ?? config.laneTimeoutMs;
  const child = spawn(opts.cmd, opts.args, {
    cwd: opts.cwd ?? config.sandboxDir,
    env: opts.env ?? process.env,
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
