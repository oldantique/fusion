/** runLane retry classification with scripted providers (no CLI is spawned). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runLane } from "../src/providers/lane.ts";
import type { LaneEvent, Provider } from "../src/types.ts";

function stub(script: (attempt: number) => LaneEvent[] | Error): Provider & { calls: number } {
  const p = {
    id: "grok" as const,
    label: "stub",
    streams: true,
    supportsJsonSchema: false,
    calls: 0,
    async *call() {
      p.calls++;
      const out = script(p.calls);
      if (out instanceof Error) throw out;
      for (const ev of out) yield ev;
    },
  };
  return p;
}
const noop = () => {};

test("a timeout is not retried", async () => {
  const p = stub(() => [{ type: "error", message: "timed out after 1s", kind: "timeout" }]);
  const r = await runLane(p, { prompt: "q", system: "s" }, noop);
  assert.equal(r.status, "failed");
  assert.equal(p.calls, 1);
  assert.equal(r.attempts, 1);
});

test("a rate limit is not retried — the quota is still gone a retry later", async () => {
  const p = stub(() => [{ type: "error", message: "You've hit your usage limit", kind: "rate_limit" }]);
  const r = await runLane(p, { prompt: "q", system: "s" }, noop);
  assert.equal(r.status, "failed");
  assert.equal(p.calls, 1);
  assert.equal(r.errorKind, "rate_limit");
});

test("a non-zero exit is retried once and can succeed", async () => {
  const p = stub((n) => (n === 1 ? [{ type: "error", message: "exit 1: boom", kind: "exit" }] : [{ type: "done", text: "OK" }]));
  const r = await runLane(p, { prompt: "q", system: "s" }, noop);
  assert.equal(r.status, "done");
  assert.equal(r.answer, "OK");
  assert.equal(r.attempts, 2);
});

test("an empty answer is retried, and attempts are capped", async () => {
  const p = stub(() => [{ type: "done", text: "   " }]);
  const r = await runLane(p, { prompt: "q", system: "s" }, noop);
  assert.equal(r.status, "failed");
  assert.equal(r.error, "empty answer");
  assert.equal(p.calls, 2);
});

test("attempts: 1 disables the retry", async () => {
  const p = stub(() => [{ type: "error", message: "exit 1", kind: "exit" }]);
  const r = await runLane(p, { prompt: "q", system: "s", attempts: 1 }, noop);
  assert.equal(p.calls, 1);
});

test("the failing kind is carried into the result, so the UI and the store can see it", async () => {
  const p = stub(() => [{ type: "error", message: "timed out after 1s", kind: "timeout" }]);
  const r = await runLane(p, { prompt: "q", system: "s" }, noop);
  assert.equal(r.errorKind, "timeout");
  const ok = await runLane(stub(() => [{ type: "done", text: "OK" }]), { prompt: "q", system: "s" }, noop);
  assert.equal(ok.errorKind, null);
});

test("a provider that throws yields an internal failure instead of rejecting", async () => {
  const p = stub(() => new Error("parser exploded"));
  const r = await runLane(p, { prompt: "q", system: "s" }, noop);
  assert.equal(r.status, "failed");
  assert.match(r.error!, /^internal: parser exploded/);
  assert.equal(p.calls, 1);
});

test("an abort during the retry pause ends the lane as aborted", async () => {
  const ac = new AbortController();
  const p = stub(() => {
    setTimeout(() => ac.abort(), 50);
    return [{ type: "error", message: "exit 1", kind: "exit" }];
  });
  const t0 = Date.now();
  const r = await runLane(p, { prompt: "q", system: "s", signal: ac.signal }, noop);
  assert.equal(r.error, "aborted");
  assert.equal(p.calls, 1);
  assert.ok(Date.now() - t0 < 1_500, "did not wait out the full retry delay");
});
