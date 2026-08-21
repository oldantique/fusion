/**
 * Orchestrates one fusion turn: fan out to the selected lanes, then synthesize.
 * Providers and the lane runner are injectable so the orchestration (fallback chain, degraded
 * answer, abort) is testable without spawning a CLI.
 */
import { config } from "../config.ts";
import { providers as realProviders } from "../providers/index.ts";
import { runLane as realRunLane } from "../providers/lane.ts";
import type { Analysis, HistoryTurn, LaneResult, Provider, ProviderId, SynthesisResult } from "../types.ts";
import { PANEL_SYSTEM, SYNTH_SCHEMA, SYNTH_SYSTEM, panelPrompt, renderHistory, synthPrompt } from "./prompts.ts";

export type FuseEvent =
  | { type: "lane"; provider: ProviderId; status: "queued" | "running"; attempt: number; at: number }
  | { type: "lane"; provider: ProviderId; status: "delta"; text: string }
  | { type: "lane"; provider: ProviderId; status: "done"; result: LaneResult }
  | { type: "lane"; provider: ProviderId; status: "failed"; result: LaneResult }
  | { type: "synth"; status: "start"; provider: ProviderId; fallback: boolean }
  | { type: "synth"; status: "delta"; text: string }
  | { type: "synth"; status: "done"; result: SynthesisResult }
  /** No synthesis: one lane only, every lane failed, or (with `provider`) synthesis failed and that lane's raw answer is shown instead. */
  | { type: "synth"; status: "skipped"; reason: "single answer" | "all lanes failed" | "synthesis failed"; provider?: ProviderId }
  | { type: "history"; omitted: number }
  | { type: "error"; message: string };

export interface FuseInput {
  question: string;
  history: HistoryTurn[];
  providerIds: ProviderId[];
  signal?: AbortSignal;
  onEvent: (ev: FuseEvent) => void;
}

export interface FuseOutput {
  lanes: LaneResult[];
  synthesis: SynthesisResult | null;
  /** Final answer shown to the user: the synthesis, or one lane's answer when there is nothing/no way to fuse. */
  answer: string | null;
  /** Which lane `answer` came from when it is not a synthesis. */
  answerProvider: ProviderId | null;
  historyOmitted: number;
}

export interface FuseDeps {
  providers: Partial<Record<ProviderId, Provider>>;
  runLane: typeof realRunLane;
  /** Test injection only; production reads the configured value. */
  synthEffort?: string;
}

/**
 * Synthesizer preference order: claude first (the only one with --json-schema, hence analysis);
 * then grok because it streams and is the fastest lane, so a fallback is visible quickly; codex
 * last among the capable ones because it is the slowest and emits no deltas. The same order picks
 * the lane whose raw answer is shown when every synthesizer fails.
 */
export const SYNTH_ORDER: ProviderId[] = ["claude", "grok", "codex", "kimi"];

export async function fuse(input: FuseInput, deps: FuseDeps = { providers: realProviders, runLane: realRunLane }): Promise<FuseOutput> {
  const { question, history, signal, onEvent } = input;
  const { providers, runLane } = deps;
  const ids = input.providerIds.filter((id) => id in providers);
  if (ids.length === 0) throw new Error("no providers selected");

  const rendered = renderHistory(history);
  onEvent({ type: "history", omitted: rendered.omitted });

  const prompt = panelPrompt(question, rendered);
  const settled = await Promise.allSettled(
    ids.map((id) =>
      runLane(providers[id]!, { prompt, system: PANEL_SYSTEM, signal }, (ev) => {
        if (ev.type === "status") onEvent({ type: "lane", provider: id, status: ev.status, attempt: ev.attempt, at: ev.at });
        else if (ev.type === "delta") onEvent({ type: "lane", provider: id, status: "delta", text: ev.text });
      }).then((result) => {
        onEvent({ type: "lane", provider: id, status: result.status === "done" ? "done" : "failed", result });
        return result;
      }),
    ),
  );
  // runLane never rejects by contract; this keeps a violated contract from turning into a fatal turn.
  const lanes: LaneResult[] = settled.map((s, i) =>
    s.status === "fulfilled"
      ? s.value
      : { provider: ids[i]!, status: "failed", answer: null, ms: 0, error: `internal: ${String(s.reason)}`, errorKind: "internal", attempts: 0 },
  );

  const done = lanes.filter((l) => l.status === "done" && l.answer);
  const base = { lanes, historyOmitted: rendered.omitted };
  if (done.length === 0) {
    onEvent({ type: "synth", status: "skipped", reason: "all lanes failed" });
    return { ...base, synthesis: null, answer: null, answerProvider: null };
  }
  if (done.length === 1) {
    onEvent({ type: "synth", status: "skipped", reason: "single answer" });
    return { ...base, synthesis: null, answer: done[0]!.answer, answerProvider: done[0]!.provider };
  }

  const synthesis = await synthesize(question, rendered, lanes, signal, onEvent, deps);
  if (synthesis) return { ...base, synthesis, answer: synthesis.answer, answerProvider: null };

  // Every synthesizer failed (or the chain was aborted/deadlined): show the best raw answer rather
  // than nothing, clearly marked. Same shape as the single-lane case, so history replay is unchanged.
  if (signal?.aborted) return { ...base, synthesis: null, answer: null, answerProvider: null };
  const pick = SYNTH_ORDER.map((id) => done.find((l) => l.provider === id)).find(Boolean) ?? done[0]!;
  onEvent({ type: "synth", status: "skipped", reason: "synthesis failed", provider: pick.provider });
  return { ...base, synthesis: null, answer: pick.answer, answerProvider: pick.provider };
}

async function synthesize(
  question: string,
  rendered: ReturnType<typeof renderHistory>,
  lanes: LaneResult[],
  signal: AbortSignal | undefined,
  onEvent: (ev: FuseEvent) => void,
  deps: FuseDeps,
): Promise<SynthesisResult | null> {
  const { prompt, letterMap } = synthPrompt(question, rendered, lanes);
  const effort = deps.synthEffort ?? config.synthEffort;
  // One lane-timeout for the whole chain: the user already waited for the panel; a fallback that
  // itself takes the full timeout is not worth another one on top.
  const deadline = AbortSignal.timeout(config.laneTimeoutMs);
  const chainSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let fallback = false;
  for (const id of SYNTH_ORDER) {
    const provider = deps.providers[id];
    if (!provider) continue;
    if (chainSignal.aborted) break;
    onEvent({ type: "synth", status: "start", provider: id, fallback });
    const started = Date.now();
    const structured = provider.supportsJsonSchema;
    let lastStructured: unknown;
    const result = await deps.runLane(
      provider,
      structured
        ? { prompt, system: SYNTH_SYSTEM, jsonSchema: SYNTH_SCHEMA, streamField: "answer", signal: chainSignal, attempts: 1, effort }
        : { prompt: `${prompt}\n\nWrite only the final merged Markdown answer.`, system: SYNTH_SYSTEM, signal: chainSignal, attempts: 1, effort },
      (ev) => {
        if (ev.type === "delta") onEvent({ type: "synth", status: "delta", text: ev.text });
        if (ev.type === "done" && ev.structured) lastStructured = ev.structured;
      },
    );
    if (result.status === "done" && result.answer) {
      const analysis = structured ? coerceAnalysis((lastStructured as any)?.analysis) : null;
      const out: SynthesisResult = { analysis, answer: result.answer, provider: id, ms: Date.now() - started, letterMap };
      onEvent({ type: "synth", status: "done", result: out });
      return out;
    }
    onEvent({ type: "error", message: `synthesizer ${id} failed: ${result.error}` });
    fallback = true;
  }
  return null;
}

function coerceAnalysis(a: any): Analysis | null {
  if (!a || typeof a !== "object") return null;
  const arr = (x: any) => (Array.isArray(x) ? x.filter((s) => typeof s === "string") : []);
  return {
    consensus: arr(a.consensus),
    contradictions: arr(a.contradictions),
    unique_insights: Array.isArray(a.unique_insights)
      ? a.unique_insights.filter((u: any) => u && typeof u.answer === "string" && typeof u.point === "string")
      : [],
    gaps: arr(a.gaps),
  };
}
