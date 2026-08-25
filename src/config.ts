/**
 * Runtime configuration, read once from the environment. `.env` is loaded here, first thing, so
 * every entry point (server, scripts, tests) sees the same values without its own bootstrap.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotenv } from "./dotenv.ts";

loadDotenv();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Strict non-negative integer with a range; a typo or an out-of-range value fails startup. */
function int(name: string, dflt: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const v = process.env[name];
  if (v === undefined || v === "") return dflt;
  if (!/^\d+$/.test(v)) throw new Error(`${name} must be an integer, got "${v}"`);
  const n = Number(v);
  if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}, got ${n}`);
  return n;
}

// Intersection of the effort vocabularies of the CLIs that take the flag (each accepts more, e.g.
// claude/codex also take "max"; grok does not). claude treats an unknown value as "use the
// default" with exit 0, so a typo must be caught here rather than discovered in the output.
const EFFORTS = ["low", "medium", "high", "xhigh"];

function effort(name: string, raw: string | undefined, dflt: string): string {
  const v = raw ?? dflt;
  if (!EFFORTS.includes(v)) throw new Error(`${name} must be one of ${EFFORTS.join("|")}, got "${v}"`);
  return v;
}

function onOff(name: string, v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === "") return dflt;
  if (v !== "on" && v !== "off") throw new Error(`${name} must be "on" or "off", got "${v}"`);
  return v === "on";
}

function oneOf<T extends string>(name: string, v: string | undefined, allowed: readonly T[], dflt: T): T {
  if (v === undefined || v === "") return dflt;
  if (!allowed.includes(v as T)) throw new Error(`${name} must be one of ${allowed.join("|")}, got "${v}"`);
  return v as T;
}

/** First `bwrap` on PATH, or null; the lane refuses to start unjailed when it is missing. */
function findOnPath(name: string): string | null {
  const { PATH = "" } = process.env;
  for (const dir of PATH.split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const PANEL_EFFORT = effort("FUSION_EFFORT", process.env.FUSION_EFFORT, "high");

export const config = {
  root: ROOT,
  dataDir: path.join(ROOT, "data"),
  /** Empty directory that every CLI is spawned from, so no CLAUDE.md/AGENTS.md/skills leak in. */
  sandboxDir: path.join(ROOT, "data", "sandbox"),
  dbPath: path.join(ROOT, "data", "fusion.sqlite"),
  webDir: path.join(ROOT, "web"),

  /** Loopback by default; LAN/Tailscale access is an explicit opt-in in .env (no TLS here). */
  host: process.env.FUSION_HOST ?? "127.0.0.1",
  port: int("FUSION_PORT", 7788, 1, 65535),
  password: process.env.FUSION_PASSWORD ?? "",
  cookieSecret: process.env.FUSION_COOKIE_SECRET ?? "",

  /**
   * Run every CLI inside a bubblewrap jail (see `jailArgv` in src/providers/process.ts). Off is
   * only for bisecting a CLI that stopped working after an upgrade.
   */
  jail: onOff("FUSION_JAIL", process.env.FUSION_JAIL, true),
  bwrapPath: findOnPath("bwrap"),
  laneTimeoutMs: int("LANE_TIMEOUT_SEC", 300, 1, 86_400) * 1000,
  /**
   * Delay between consecutive lane starts in a fan-out. A simultaneous four-wide burst is the
   * shape that trips a per-second limiter, and grok's client gives up after two 429 retries;
   * spacing the first request of each lane costs the turn nothing, because the slowest lane still
   * sets its pace. 0 fires them all at once.
   */
  laneStaggerMs: int("LANE_STAGGER_MS", 300, 0, 10_000),
  /**
   * How the codex lane talks to the CLI: a long-lived `codex app-server` daemon (default; see
   * src/providers/codex-app-server.ts) or one `codex exec` process per call (the older path,
   * kept for bisecting a daemon problem after a CLI upgrade).
   */
  codexTransport: oneOf("CODEX_TRANSPORT", process.env.CODEX_TRANSPORT, ["app-server", "exec"] as const, "app-server"),
  /** Max attempts per panel lane (1 initial + retries); only transient failures are retried. */
  laneAttempts: 2,
  /** Pause before a retry, so a momentarily unhappy CLI/API is not hit again instantly. */
  retryDelayMs: 2_000,
  concurrency: {
    claude: int("CLAUDE_MAX_CONCURRENCY", 8, 1, 64),
    codex: int("CODEX_MAX_CONCURRENCY", 1, 1, 64),
    kimi: int("KIMI_MAX_CONCURRENCY", 8, 1, 64),
    grok: int("GROK_MAX_CONCURRENCY", 8, 1, 64),
  },
  /** Replayed history is trimmed from the oldest turn beyond this many characters. */
  historyCharBudget: int("HISTORY_CHAR_BUDGET", 60_000, 1_000),

  models: {
    claude: process.env.CLAUDE_MODEL ?? "opus",
    codex: process.env.CODEX_MODEL ?? "gpt-5.6-sol",
    kimi: process.env.KIMI_MODEL ?? "kimi-code/k3",
    grok: process.env.GROK_MODEL ?? "grok-4.6",
  },
  effort: PANEL_EFFORT,
  /**
   * Effort for the synthesizer call, which does a different job from a panel lane: it merges
   * answers that already exist rather than producing one. Separate knob so that can be tuned (or
   * measured) on its own; equal to the panel effort until a measurement says otherwise.
   */
  synthEffort: effort("FUSION_SYNTH_EFFORT", process.env.FUSION_SYNTH_EFFORT, PANEL_EFFORT),
};

export type Config = typeof config;
