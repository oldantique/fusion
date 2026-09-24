/**
 * Orchestrates one fusion turn: fan out to the selected lanes, then synthesize.
 * Providers and the lane runner are injectable so the orchestration (fallback chain, degraded
 * answer, abort) is testable without spawning a CLI.
 */
import { config } from "../config.ts";
import { providers as realProviders } from "../providers/index.ts";
import { runLane as realRunLane, sleep } from "../providers/lane.ts";
import type { Analysis, HistoryTurn, LaneResult, Provider, ProviderId, SynthesisResult } from "../types.ts";
import type { TraceOpener } from "../store/traces.ts";
import { ANALYSIS_SCHEMA, PANEL_SYSTEM, SYNTH_SCHEMA, historyRoom, panelPrompt, renderHistory, synthPrompt, synthSystem, type SynthStyle } from "./prompts.ts";

export type FuseEvent =
  | { type: "lane"; provider: ProviderId; status: "queued" | "running"; attempt: number; at: number }
  | { type: "lane"; provider: ProviderId; status: "delta"; text: string }
  | { type: "lane"; provider: ProviderId; status: "done"; result: LaneResult }
  | { type: "lane"; provider: ProviderId; status: "failed"; result: LaneResult }
  /** `fallback` — a different synthesizer than the preferred one; `retry` — the same one trying again. */
  | { type: "synth"; status: "start"; provider: ProviderId; fallback: boolean; retry: boolean }
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
  /** Raw-output tracing (`src/store/traces.ts`); absent in tests and scripts. */
  trace?: TraceOpener;
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
  /** Test injection only; production reads the configured values. */
  synthEffort?: string;
  synthTimeoutMs?: number;
  staggerMs?: number;
}

/**
 * Synthesizer preference order: claude first — it and grok both take --json-schema, but claude's
 * schema is enforced by the decoder where grok's is enforced by the prompt, so claude's analysis
 * is the one that always arrives; grok next, now a fully structured fallback rather than a
 * plain-text one, and the fastest streaming lane so a fallback is visible quickly; codex last
 * among the capable ones because it is the slowest and emits no deltas. The same order picks the
 * lane whose raw answer is shown when every synthesizer fails.
 */
export const SYNTH_ORDER: ProviderId[] = ["claude", "grok", "codex", "kimi"];
/**
 * The preferred synthesizer gets a second attempt before the chain moves on: it produces the
 * analysis most dependably, and its failures are mostly transient (a timeout on a heavy question,
 * an empty result). The fallbacks get one attempt each — by then the user has waited long enough
 * that a different model is a better bet than the same one a third time.
 */
export const SYNTH_CHAIN: ProviderId[] = [SYNTH_ORDER[0]!, ...SYNTH_ORDER];

export async function fuse(input: FuseInput, deps: FuseDeps = { providers: realProviders, runLane: realRunLane }): Promise<FuseOutput> {
  const { question, history, signal, onEvent } = input;
  const { providers, runLane } = deps;
  const ids = input.providerIds.filter((id) => id in providers);
  if (ids.length === 0) throw new Error("no providers selected");

  // History yields to the prompt-size ceiling (`PROMPT_MAX_BYTES`) before it is allowed to push
  // a lane's prompt past it.
  const rendered = renderHistory(history, config.historyCharBudget, historyRoom(PANEL_SYSTEM, question));
  onEvent({ type: "history", omitted: rendered.omitted });

  const prompt = panelPrompt(question, rendered);
  // Lanes start spaced out rather than all in the same instant: a simultaneous burst is what
  // trips a per-second rate limiter, and grok's client gives up after two 429 retries. The wait
  // is free in practice — the slowest lane, not the last to start, decides when the turn ends.
  // Measured from one point rather than chained, so a slow spawn does not push the rest back.
  const stagger = deps.staggerMs ?? config.laneStaggerMs;
  const settled = await Promise.allSettled(
    ids.map(async (id, i) => {
      if (i > 0 && stagger > 0) await sleep(i * stagger, signal);
      // An abort during the wait is not special-cased: runLane turns it into a failed lane.
      const tracer = openTrace(input.trace, `lane-${id}`, PANEL_SYSTEM, prompt);
      const result = await runLane(providers[id]!, { prompt, system: PANEL_SYSTEM, signal, onRecord: tracer?.record }, (ev) => {
        if (ev.type === "status") onEvent({ type: "lane", provider: id, status: ev.status, attempt: ev.attempt, at: ev.at });
        else if (ev.type === "delta") onEvent({ type: "lane", provider: id, status: "delta", text: ev.text });
      });
      void tracer?.end(result);
      onEvent({ type: "lane", provider: id, status: result.status === "done" ? "done" : "failed", result });
      return result;
    }),
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

  const synthesis = await synthesize(question, history, lanes, signal, onEvent, deps, input.trace);
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
  history: HistoryTurn[],
  lanes: LaneResult[],
  signal: AbortSignal | undefined,
  onEvent: (ev: FuseEvent) => void,
  deps: FuseDeps,
  trace?: TraceOpener,
): Promise<SynthesisResult | null> {
  // The candidates are part of this prompt too, so history gets what they leave (possibly
  // nothing); sized for the longest system prompt so any synthesizer in the chain fits.
  const systems = (["prose", "json", "plain"] as SynthStyle[]).map(synthSystem).sort((a, b) => b.length - a.length);
  const bare = synthPrompt(question, [], lanes).prompt;
  const { prompt, letterMap } = synthPrompt(question, renderHistory(history, config.historyCharBudget, historyRoom(systems[0]!, bare)), lanes);
  const effort = deps.synthEffort ?? config.synthEffort;
  const timeoutMs = deps.synthTimeoutMs ?? config.laneTimeoutMs;
  // Every attempt gets a full lane timeout of its own, so a fallback started late is not handed
  // the sliver left over by the synthesizer that hung — that sliver would only produce a second
  // timeout. The chain as a whole is capped at three lane timeouts: two for the preferred
  // synthesizer's attempts and one for a fallback. The user has already waited for the panel and
  // an unbounded chain of five could quadruple that wait.
  const cap = AbortSignal.timeout(3 * timeoutMs);
  const chainSignal = signal ? AbortSignal.any([signal, cap]) : cap;
  let previous: ProviderId | null = null;
  let attemptNo = 0;
  for (const id of SYNTH_CHAIN) {
    const provider = deps.providers[id];
    if (!provider) continue;
    if (chainSignal.aborted) break;
    onEvent({ type: "synth", status: "start", provider: id, fallback: previous !== null && previous !== id, retry: previous === id });
    const attemptSignal = AbortSignal.any([chainSignal, AbortSignal.timeout(timeoutMs)]);
    const started = Date.now();
    let lastStructured: unknown;
    // A synthesizer that writes prose beside its schema answers in the prose (the lane's own
    // text, streamed as usual) and puts only the analysis in the schema; an empty reply is an
    // "empty" failure and the chain moves on.
    const style = provider.proseBesideSchema ? "prose" : provider.supportsJsonSchema ? "json" : "plain";
    const system = synthSystem(style);
    const tracer = openTrace(trace, `synth-${++attemptNo}-${id}`, system, prompt);
    const common = { prompt, system, signal: attemptSignal, attempts: 1, effort, onRecord: tracer?.record };
    const result = await deps.runLane(
      provider,
      style === "prose"
        ? { ...common, jsonSchema: ANALYSIS_SCHEMA }
        : style === "json"
          ? { ...common, jsonSchema: SYNTH_SCHEMA, streamField: "answer" }
          : common,
      (ev) => {
        if (ev.type === "delta") onEvent({ type: "synth", status: "delta", text: ev.text });
        if (ev.type === "done" && ev.structured) lastStructured = ev.structured;
      },
    );
    void tracer?.end(result);
    if (result.status === "done" && result.answer) {
      const analysis = style !== "plain" ? coerceAnalysis((lastStructured as any)?.analysis) : null;
      const out: SynthesisResult = { analysis, answer: result.answer, provider: id, ms: Date.now() - started, letterMap };
      onEvent({ type: "synth", status: "done", result: out });
      return out;
    }
    onEvent({ type: "error", message: `synthesizer ${id} failed: ${result.error}` });
    previous = id;
  }
  return null;
}

/** Opens a trace and records what the call was given, so a bad turn can be replayed exactly. */
function openTrace(trace: TraceOpener | undefined, name: string, system: string, prompt: string) {
  const tracer = trace?.(name);
  tracer?.record({ type: "fusion/input", system, prompt });
  return tracer;
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
