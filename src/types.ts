/** Shared types for the fusion pipeline. */

export type ProviderId = "claude" | "codex" | "kimi" | "grok";

export const ALL_PROVIDERS: readonly ProviderId[] = ["claude", "codex", "kimi", "grok"] as const;

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  claude: "Claude Opus",
  codex: "GPT-5.6 Sol",
  kimi: "Kimi K3",
  grok: "Grok 4.6",
};

/**
 * Why a call failed. Drives the retry decision in `runLane`: only `exit` (non-zero exit, cause
 * unknown) and `empty` (clean exit, no answer) are worth a second attempt; a timeout will most
 * likely time out again, and abort/spawn/internal failures cannot be fixed by retrying.
 */
export type LaneErrorKind = "timeout" | "aborted" | "spawn" | "exit" | "empty" | "internal";

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
  costUsd?: number;
}

export type LaneStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface LaneResult {
  provider: ProviderId;
  status: LaneStatus;
  answer: string | null;
  ms: number;
  error: string | null;
  exitCode: number | null;
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
  /** Override the configured attempt count (the synthesizer chain uses one attempt per provider). */
  attempts?: number;
}

export interface Provider {
  id: ProviderId;
  label: string;
  /** Whether this provider streams token deltas (UI hint). */
  streams: boolean;
  /** Whether the provider supports `jsonSchema` natively. */
  supportsJsonSchema: boolean;
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
