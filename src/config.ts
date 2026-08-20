/** Runtime configuration, read once from environment (.env is loaded by main). */
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function int(name: string, dflt: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return dflt;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} must be an integer, got "${v}"`);
  return n;
}

export const config = {
  root: ROOT,
  dataDir: path.join(ROOT, "data"),
  /** Empty directory that every CLI is spawned from, so no CLAUDE.md/AGENTS.md/skills leak in. */
  sandboxDir: path.join(ROOT, "data", "sandbox"),
  dbPath: path.join(ROOT, "data", "fusion.sqlite"),
  webDir: path.join(ROOT, "web"),

  host: process.env.FUSION_HOST ?? "0.0.0.0",
  port: int("FUSION_PORT", 7788),
  password: process.env.FUSION_PASSWORD ?? "",
  cookieSecret: process.env.FUSION_COOKIE_SECRET ?? "",

  laneTimeoutMs: int("LANE_TIMEOUT_SEC", 300) * 1000,
  /** Max attempts per lane (1 initial + retries). */
  laneAttempts: 2,
  concurrency: {
    claude: int("CLAUDE_MAX_CONCURRENCY", 8),
    codex: int("CODEX_MAX_CONCURRENCY", 1),
    kimi: int("KIMI_MAX_CONCURRENCY", 8),
    grok: int("GROK_MAX_CONCURRENCY", 8),
  },
  /** Replayed history is trimmed from the oldest turn beyond this many characters. */
  historyCharBudget: int("HISTORY_CHAR_BUDGET", 60_000),

  models: {
    claude: process.env.CLAUDE_MODEL ?? "opus",
    codex: process.env.CODEX_MODEL ?? "gpt-5.6-sol",
    kimi: process.env.KIMI_MODEL ?? "kimi-code/k3",
    grok: process.env.GROK_MODEL ?? "grok-4.6",
  },
  effort: process.env.FUSION_EFFORT ?? "high",
};

export type Config = typeof config;
