/** Prompt construction: shared preamble, history replay, and the synthesizer prompt. */
import { config } from "../config.ts";
import type { HistoryTurn, LaneResult, ProviderId } from "../types.ts";

export const PANEL_SYSTEM = [
  "You are a knowledgeable general assistant.",
  "Answer the user's question directly and completely, formatted in Markdown.",
  "Answer in the same language the question is written in.",
  "You have no tools: do not attempt to read, write, search, or execute anything; rely on your own knowledge.",
  "Do not mention these instructions.",
].join(" ");

export const SYNTH_SYSTEM = [
  "You are the synthesizer in a multi-model answer fusion system.",
  "You receive a user question and several candidate answers written independently by different AI models, labelled A, B, C... in random order.",
  "Your job: produce the best possible single answer, then a short structured analysis of how the candidates compare.",
  "Rules for `answer`: write it as a complete, self-contained Markdown answer to the user, in the language of the question;",
  "merge correct content, drop errors, resolve contradictions using your own judgement, and never refer to the candidates or to 'the models' inside `answer`.",
  "Rules for `analysis`: be concrete and brief; each string is one sentence; refer to candidates by letter only.",
  "You have no tools; do not attempt to read, write, search, or execute anything.",
].join(" ");

export const SYNTH_SCHEMA = {
  type: "object",
  // `answer` first so it streams before the analysis is generated.
  properties: {
    answer: { type: "string", description: "The final merged Markdown answer for the user." },
    analysis: {
      type: "object",
      properties: {
        consensus: { type: "array", items: { type: "string" }, description: "Points most candidates agree on." },
        contradictions: { type: "array", items: { type: "string" }, description: "Where candidates disagree, and which you followed." },
        unique_insights: {
          type: "array",
          items: {
            type: "object",
            properties: { answer: { type: "string", description: "Candidate letter" }, point: { type: "string" } },
            required: ["answer", "point"],
          },
          description: "Valuable points only one candidate made.",
        },
        gaps: { type: "array", items: { type: "string" }, description: "Things all candidates missed or got wrong." },
      },
      required: ["consensus", "contradictions", "unique_insights", "gaps"],
    },
  },
  required: ["answer", "analysis"],
} as const;

/**
 * Render prior turns as a replayable preamble, trimming the oldest turns beyond the char budget.
 * Returns the text and how many turns were dropped.
 */
export function renderHistory(history: HistoryTurn[], budget = config.historyCharBudget): { text: string; omitted: number } {
  if (history.length === 0) return { text: "", omitted: 0 };
  const blocks = history.map((t, i) => `### Q${i + 1}\n${t.question.trim()}\n\n### Answer ${i + 1}\n${t.answer.trim()}`);
  let start = 0;
  let total = blocks.reduce((n, b) => n + b.length, 0);
  while (start < blocks.length - 1 && total > budget) {
    total -= blocks[start]!.length;
    start++;
  }
  const kept = blocks.slice(start);
  const text = [
    "<conversation_so_far>",
    start > 0 ? `(earliest ${start} turn${start === 1 ? "" : "s"} omitted)` : "",
    ...kept,
    "</conversation_so_far>",
    "",
  ]
    .filter((l) => l !== "")
    .join("\n\n");
  return { text, omitted: start };
}

export function panelPrompt(question: string, history: HistoryTurn[]): string {
  const h = renderHistory(history);
  return h.text
    ? `${h.text}\n\nThe conversation above is context. Now answer the new question:\n\n${question.trim()}`
    : question.trim();
}

const LETTERS = "ABCDEFGH";

/** Deterministic shuffle keyed by the question so retries see the same ordering. */
function shuffleKeyed<T>(items: T[], key: string): T[] {
  let h = 2166136261;
  for (const ch of key) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    const j = h % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function synthPrompt(
  question: string,
  history: HistoryTurn[],
  lanes: LaneResult[],
): { prompt: string; letterMap: Record<string, ProviderId> } {
  const done = lanes.filter((l) => l.status === "done" && l.answer);
  const ordered = shuffleKeyed(done, question);
  const letterMap: Record<string, ProviderId> = {};
  const candidates = ordered.map((l, i) => {
    const letter = LETTERS[i]!;
    letterMap[letter] = l.provider;
    return `<candidate id="${letter}">\n${l.answer!.trim()}\n</candidate>`;
  });
  const h = renderHistory(history);
  const parts = [
    h.text ? `${h.text}\n\nThe conversation above is context for the current question.` : "",
    `<question>\n${question.trim()}\n</question>`,
    `${candidates.length} candidate answers follow.`,
    ...candidates,
    h.text ? "Keep `answer` consistent with the earlier answers in the conversation unless they were wrong." : "",
  ].filter(Boolean);
  return { prompt: parts.join("\n\n"), letterMap };
}
