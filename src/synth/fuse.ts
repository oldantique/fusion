/** Orchestrates one fusion turn: fan out to the selected lanes, then synthesize. */
import { providers } from "../providers/index.ts";
import { runLane } from "../providers/lane.ts";
import type { Analysis, HistoryTurn, LaneResult, ProviderId, SynthesisResult } from "../types.ts";
import { PANEL_SYSTEM, SYNTH_SCHEMA, SYNTH_SYSTEM, panelPrompt, renderHistory, synthPrompt } from "./prompts.ts";

export type FuseEvent =
  | { type: "lane"; provider: ProviderId; status: "queued" | "running"; attempt: number }
  | { type: "lane"; provider: ProviderId; status: "delta"; text: string }
  | { type: "lane"; provider: ProviderId; status: "done"; result: LaneResult }
  | { type: "lane"; provider: ProviderId; status: "failed"; result: LaneResult }
  | { type: "synth"; status: "start"; provider: ProviderId; fallback: boolean }
  | { type: "synth"; status: "delta"; text: string }
  | { type: "synth"; status: "done"; result: SynthesisResult }
  | { type: "synth"; status: "skipped"; reason: string }
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
  /** Final answer shown to the user (synthesis, or the single lane's answer). */
  answer: string | null;
  historyOmitted: number;
}

/** Synthesizer preference order; only claude supports --json-schema, the rest give answer-only. */
const SYNTH_ORDER: ProviderId[] = ["claude", "codex", "grok", "kimi"];

export async function fuse(input: FuseInput): Promise<FuseOutput> {
  const { question, history, providerIds, signal, onEvent } = input;
  const ids = providerIds.filter((id) => id in providers);
  if (ids.length === 0) throw new Error("no providers selected");

  const { omitted } = renderHistory(history);
  onEvent({ type: "history", omitted });

  const prompt = panelPrompt(question, history);
  const lanes = await Promise.all(
    ids.map((id) =>
      runLane(providers[id], { prompt, system: PANEL_SYSTEM, signal }, (ev) => {
        if (ev.type === "status") onEvent({ type: "lane", provider: id, status: ev.status, attempt: ev.attempt });
        else if (ev.type === "delta") onEvent({ type: "lane", provider: id, status: "delta", text: ev.text });
      }).then((result) => {
        onEvent({ type: "lane", provider: id, status: result.status === "done" ? "done" : "failed", result });
        return result;
      }),
    ),
  );

  const done = lanes.filter((l) => l.status === "done");
  if (done.length === 0) {
    onEvent({ type: "synth", status: "skipped", reason: "all lanes failed" });
    return { lanes, synthesis: null, answer: null, historyOmitted: omitted };
  }
  if (done.length === 1) {
    onEvent({ type: "synth", status: "skipped", reason: "single answer, nothing to fuse" });
    return { lanes, synthesis: null, answer: done[0]!.answer, historyOmitted: omitted };
  }

  const synthesis = await synthesize(question, history, lanes, signal, onEvent);
  return { lanes, synthesis, answer: synthesis?.answer ?? null, historyOmitted: omitted };
}

async function synthesize(
  question: string,
  history: HistoryTurn[],
  lanes: LaneResult[],
  signal: AbortSignal | undefined,
  onEvent: (ev: FuseEvent) => void,
): Promise<SynthesisResult | null> {
  const { prompt, letterMap } = synthPrompt(question, history, lanes);
  let fallback = false;
  for (const id of SYNTH_ORDER) {
    if (signal?.aborted) break;
    const provider = providers[id];
    onEvent({ type: "synth", status: "start", provider: id, fallback });
    const started = Date.now();
    const structured = provider.supportsJsonSchema;
    let lastStructured: unknown;
    const result = await runLane(
      provider,
      structured
        ? { prompt, system: SYNTH_SYSTEM, jsonSchema: SYNTH_SCHEMA, streamField: "answer", signal }
        : { prompt: `${prompt}\n\nWrite only the final merged Markdown answer.`, system: SYNTH_SYSTEM, signal },
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
