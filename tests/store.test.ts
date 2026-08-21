import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store/db.ts";

test("store: conversation → turn → lanes → history replay", () => {
  const s = new Store(":memory:");
  const conv = s.createConversation("t");
  assert.equal(s.history(conv.id).length, 0);

  const t1 = s.startTurn(conv.id, "q1", ["claude", "grok"]);
  assert.equal(t1.idx, 0);
  assert.equal(t1.status, "running");
  s.saveLane(t1.id, { provider: "claude", status: "done", answer: "a", ms: 5, error: null, errorKind: null, attempts: 1 });
  s.saveLane(t1.id, { provider: "grok", status: "failed", answer: null, ms: 9, error: "x", errorKind: "rate_limit", attempts: 2 });
  s.finishTurn(t1.id, "fused1", { analysis: { consensus: ["c"], contradictions: [], unique_insights: [], gaps: [] }, answer: "fused1", provider: "claude", ms: 7, letterMap: { A: "claude" } }, 0, null);

  const t2 = s.startTurn(conv.id, "q2", ["claude"]);
  assert.equal(t2.idx, 1);
  // running turn is not part of replayable history
  assert.deepEqual(s.history(conv.id), [{ question: "q1", answer: "fused1" }]);

  const got = s.getTurn(t1.id)!;
  assert.equal(got.status, "done");
  assert.equal(got.analysis?.consensus[0], "c");
  assert.deepEqual(got.letter_map, { A: "claude" });
  assert.equal(got.lanes.length, 2);
  assert.equal(got.lanes.find((l) => l.provider === "grok")?.attempts, 2);
  assert.equal(got.lanes.find((l) => l.provider === "grok")?.errorKind, "rate_limit");
  assert.equal(got.lanes.find((l) => l.provider === "claude")?.errorKind, null);

  s.failStaleTurns();
  assert.equal(s.getTurn(t2.id)!.status, "failed");
  assert.equal(s.listConversations()[0]!.turn_count, 2);

  s.deleteConversation(conv.id);
  assert.equal(s.getTurn(t1.id), null);
  s.close();
});
