import { test } from "node:test";
import assert from "node:assert/strict";
import { renderHistory, synthPrompt, panelPrompt } from "../src/synth/prompts.ts";
import type { LaneResult } from "../src/types.ts";

const lane = (provider: LaneResult["provider"], answer: string): LaneResult => ({
  provider, status: "done", answer, ms: 1, error: null, exitCode: 0, attempts: 1,
});

test("renderHistory drops oldest turns beyond the budget and reports the count", () => {
  const history = Array.from({ length: 5 }, (_, i) => ({ question: `q${i}`, answer: "x".repeat(1000) }));
  const r = renderHistory(history, 2500);
  assert.equal(r.omitted, 3);
  assert.match(r.text, /earliest 3 turns omitted/);
  assert.match(r.text, /q3[\s\S]*q4/);
  assert.doesNotMatch(r.text, /q2/);
});

test("renderHistory always keeps at least the latest turn", () => {
  const r = renderHistory([{ question: "q", answer: "y".repeat(10_000) }], 100);
  assert.equal(r.omitted, 0);
  assert.match(r.text, /Answer 1/);
});

test("panelPrompt without history is the bare question", () => {
  assert.equal(panelPrompt("  hello ", []), "hello");
});

test("synthPrompt anonymizes candidates, excludes failed lanes, and is deterministic per question", () => {
  const lanes: LaneResult[] = [
    lane("claude", "answer one"),
    lane("codex", "answer two"),
    { ...lane("kimi", ""), status: "failed", answer: null, error: "boom" },
    lane("grok", "answer three"),
  ];
  const a = synthPrompt("What is X?", [], lanes);
  const b = synthPrompt("What is X?", [], lanes);
  assert.deepEqual(a.letterMap, b.letterMap);
  assert.deepEqual(Object.keys(a.letterMap).sort(), ["A", "B", "C"]);
  assert.deepEqual(Object.values(a.letterMap).sort(), ["claude", "codex", "grok"]);
  assert.doesNotMatch(a.prompt, /claude|codex|kimi|grok/i);
  assert.match(a.prompt, /3 candidate answers/);
  const c = synthPrompt("A different question", [], lanes);
  // Different questions may or may not shuffle differently; just ensure validity.
  assert.equal(Object.keys(c.letterMap).length, 3);
});
