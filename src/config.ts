/**
 * Runtime configuration, read once from the environment. `.env` is loaded here, first thing, so
 * every entry point (server, scripts, tests) sees the same values without its own bootstrap.
 */
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

function effort(): string {
  const v = process.env.FUSION_EFFORT ?? "high";
  if (!EFFORTS.includes(v)) throw new Error(`FUSION_EFFORT must be one of ${EFFORTS.join("|")}, got "${v}"`);
  return v;
}

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

  laneTimeoutMs: int("LANE_TIMEOUT_SEC", 300, 1, 86_400) * 1000,
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
  effort: effort(),
};

export type Config = typeof config;
