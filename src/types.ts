/** Shared types for the fusion pipeline. */

export type ProviderId = "claude" | "codex" | "kimi" | "grok";

export const ALL_PROVIDERS: readonly ProviderId[] = ["claude", "codex", "kimi", "grok"] as const;

/**
 * What we know about a model id each CLI accepts: the name shown in the UI and the vendor-stated
 * knowledge cutoff (the lanes run offline, so that is the edge of what they know). Keyed by model,
 * not by provider: a lane whose model is changed in `.env` must not inherit the default's name.
 * Home of these facts; cutoffs verified against the vendors' model pages (2026-08-21, codex
 * 2026-09-20, claude and grok 2026-09-23) — add a row when a model in `.env` changes. Key a row by
 * a pinned id, never an alias: the vendor moves an alias (claude's "opus" went from Opus 5 to 5.5)
 * and the row would go on naming the old model:
 *   claude → platform.claude.com/docs/en/about-claude/models/overview
 *   codex  → developers.openai.com/api/docs/models/<id>
 *   grok   → docs.x.ai/developers/grok-4-7
 *   kimi   → K3: no cutoff published (model card, docs and tech report checked) — `null`.
 */
const KNOWN_MODELS: Record<ProviderId, Record<string, { label: string; cutoff: string | null }>> = {
  claude: { "claude-opus-5-5": { label: "Claude Opus 5.5", cutoff: "2026-06" } },
  codex: {
    "gpt-6-astra": { label: "GPT-6 Astra", cutoff: "2026-04" },
    "gpt-5.6-sol": { label: "GPT-5.6 Sol", cutoff: "2026-02" },
  },
  kimi: { "kimi-code/k3": { label: "Kimi K3", cutoff: null } },
  grok: {
    "grok-4.7": { label: "Grok 4.7", cutoff: "2026-05" },
    "grok-4.6": { label: "Grok 4.6", cutoff: "2026-02" },
  },
};

export interface ModelInfo {
  model: string;
  label: string;
  /** Vendor-stated cutoff; `null` = the vendor publishes none, or (when `known` is false) we never looked. */
  cutoff: string | null;
  known: boolean;
}

/** A model we have no row for is shown by its literal id: a true name beats a familiar wrong one. */
export function modelInfo(id: ProviderId, model: string): ModelInfo {
  const hit = KNOWN_MODELS[id][model];
  return hit ? { model, ...hit, known: true } : { model, label: model, cutoff: null, known: false };
}

/**
 * The model each provider was configured with when a turn started, stored with the turn so that
 * history keeps naming what answered it after a lane's model changes. It records the model id we
 * *asked* the CLI for; an alias ("opus") is resolved by the vendor and not reported back.
 */
export type ModelSnapshot = Partial<Record<ProviderId, { model: string; label: string }>>;

/**
 * Why a call failed. Drives the retry decision in `runLane`: only `exit` (non-zero exit, cause
 * unknown) and `empty` (clean exit, no answer) are worth a second attempt; a timeout will most
 * likely time out again, and abort/spawn/internal failures cannot be fixed by retrying.
 * `rate_limit` is deliberately not retryable: the quota is still exhausted a retry later, so a
 * second attempt only burns more of it and delays the fallback.
 */
export type LaneErrorKind = "timeout" | "aborted" | "spawn" | "exit" | "empty" | "internal" | "rate_limit";

/** Events emitted by a provider while a call is running. */
export type LaneEvent =
  | { type: "delta"; text: string }
  | { type: "thinking"; text: string }
  | { type: "done"; text: string; usage?: Usage; structured?: unknown }
  | { type: "error"; message: string; kind: LaneErrorKind };

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  /** Tokens written to the prompt cache (claude, grok); `inputTokens` excludes them. */
  cacheWriteTokens?: number;
  costUsd?: number;
}

export type LaneStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface LaneResult {
  provider: ProviderId;
  status: LaneStatus;
  answer: string | null;
  ms: number;
  error: string | null;
  /** Why it failed, so the UI and the store can tell a quota block from a crash; null when done. */
  errorKind: LaneErrorKind | null;
  attempts: number;
  usage?: Usage;
}

/** One prior (question, fused answer) pair replayed as context. */
export interface HistoryTurn {
  question: string;
  answer: string;
}

export interface CallOptions {
  /** Full user prompt, already including any history preamble. */
  prompt: string;
  /** System prompt; providers that cannot set one prepend it to the prompt. */
  system: string;
  /** Optional JSON schema for structured output (synthesizer only). */
  jsonSchema?: object;
  /** With jsonSchema: name of the string field to stream as deltas (e.g. "answer"). */
  streamField?: string;
  signal?: AbortSignal;
  /** Override the configured reasoning effort (the synthesizer has its own; kimi has no flag). */
  effort?: string;
  /** Override the configured attempt count (the synthesizer chain uses one attempt per provider). */
  attempts?: number;
  /** Sees every raw record a spawned CLI prints, before parsing (`check-updates -- --tools-diff`). */
  onRecord?: (record: unknown) => void;
}

export interface Provider {
  id: ProviderId;
  label: string;
  /** Whether this provider streams token deltas (UI hint). */
  streams: boolean;
  /** Whether the provider supports `jsonSchema` natively. */
  supportsJsonSchema: boolean;
  /**
   * Under `jsonSchema`, the reply text stays separate from the schema's object (claude: the CLI
   * makes the schema a tool call beside the reply) rather than being the object (grok). The
   * synthesizer then answers in the reply and puts only the analysis in the schema.
   */
  proseBesideSchema?: boolean;
  call(opts: CallOptions): AsyncGenerator<LaneEvent, void, void>;
}

export interface Analysis {
  consensus: string[];
  contradictions: string[];
  unique_insights: { answer: string; point: string }[];
  gaps: string[];
}

export interface SynthesisResult {
  analysis: Analysis | null;
  answer: string;
  provider: ProviderId;
  ms: number;
  /** Letter → provider mapping used for anonymization. */
  letterMap: Record<string, ProviderId>;
}
