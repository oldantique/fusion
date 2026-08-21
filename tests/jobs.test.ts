/** Jobs registry: sequenced replay, compaction, per-conversation serialization, cancellation. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store/db.ts";
import { ConflictError, Jobs, type JobEvent } from "../src/server/jobs.ts";
import type { FuseInput, FuseOutput } from "../src/synth/fuse.ts";

const lane = (provider: "grok" | "kimi", answer: string | null) => ({
  provider, status: answer ? "done" : "failed", answer, ms: 1, error: answer ? null : "aborted", errorKind: answer ? null : "aborted", attempts: 1,
} as const);

/** A scripted fuse: streams two deltas per lane, finishes lanes, then synthesizes — or waits for abort. */
function fakeFuse(opts: { hang?: boolean } = {}) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const impl = async (input: FuseInput): Promise<FuseOutput> => {
    const { onEvent, signal } = input;
    onEvent({ type: "history", omitted: 0 });
    for (const p of ["grok", "kimi"] as const) {
      onEvent({ type: "lane", provider: p, status: "running", attempt: 1, at: 0 });
      onEvent({ type: "lane", provider: p, status: "delta", text: `${p}-1` });
      onEvent({ type: "lane", provider: p, status: "delta", text: `${p}-2` });
    }
    onEvent({ type: "lane", provider: "grok", status: "done", result: lane("grok", "G") });
    if (opts.hang) {
      await new Promise<void>((r) => { signal?.addEventListener("abort", () => r(), { once: true }); gate.then(r); });
      if (signal?.aborted) {
        onEvent({ type: "lane", provider: "kimi", status: "failed", result: lane("kimi", null) });
        return { lanes: [lane("grok", "G"), lane("kimi", null)], synthesis: null, answer: null, answerProvider: null, historyOmitted: 0 };
      }
    }
    onEvent({ type: "lane", provider: "kimi", status: "done", result: lane("kimi", "K") });
    onEvent({ type: "synth", status: "start", provider: "grok", fallback: false });
    onEvent({ type: "synth", status: "delta", text: "fu" });
    onEvent({ type: "synth", status: "delta", text: "sed" });
    const result = { analysis: null, answer: "fused", provider: "grok" as const, ms: 1, letterMap: { A: "grok" as const, B: "kimi" as const } };
    onEvent({ type: "synth", status: "done", result });
    return { lanes: [lane("grok", "G"), lane("kimi", "K")], synthesis: result, answer: "fused", answerProvider: null, historyOmitted: 0 };
  };
  return { impl, release: () => release() };
}

const types = (evs: JobEvent[]) => evs.map((e) => ("status" in e ? `${e.type}:${e.status}` : e.type));

test("replay after seq N returns only later events; finished deltas are compacted", async () => {
  const store = new Store(":memory:");
  const conv = store.createConversation("t");
  const jobs = new Jobs(store, fakeFuse().impl);
  const turnId = jobs.start(conv.id, "q", ["grok", "kimi"]);
  await new Promise((r) => setTimeout(r, 20));

  const all: { seq: number; ev: JobEvent }[] = [];
  jobs.subscribe(turnId, (e) => all.push(e));
  assert.ok(!types(all.map((e) => e.ev)).includes("lane:delta"), "lane deltas gone once both lanes are done");
  assert.ok(!types(all.map((e) => e.ev)).includes("synth:delta"), "synth deltas gone once synthesis is done");
  assert.equal(all.at(-1)!.ev.type, "finished");
  const seqs = all.map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "monotonic");

  const mid = all[Math.floor(all.length / 2)]!.seq;
  const later: JobEvent[] = [];
  jobs.subscribe(turnId, (e) => later.push(e.ev), mid);
  assert.equal(later.length, all.filter((e) => e.seq > mid).length);

  assert.equal(store.getTurn(turnId)!.status, "done");
  assert.equal(store.getTurn(turnId)!.answer, "fused");
});

test("live deltas are delivered before compaction, and a mid-stream subscriber gets the remainder only", async () => {
  const store = new Store(":memory:");
  const conv = store.createConversation("t");
  const f = fakeFuse({ hang: true });
  const jobs = new Jobs(store, f.impl);
  const turnId = jobs.start(conv.id, "q", ["grok", "kimi"]);
  await new Promise((r) => setTimeout(r, 20));

  const snapshot: JobEvent[] = [];
  jobs.subscribe(turnId, (e) => snapshot.push(e.ev));
  const deltaProviders = snapshot.filter((e) => e.type === "lane" && e.status === "delta").map((e: any) => e.provider);
  assert.ok(deltaProviders.includes("kimi"), "kimi is still running, its deltas are kept");
  assert.ok(!deltaProviders.includes("grok"), "grok is done, its deltas are compacted");
  f.release();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(snapshot.at(-1)!.type, "finished");
});

test("a second ask on the same conversation is refused while one runs, allowed afterwards", async () => {
  const store = new Store(":memory:");
  const conv = store.createConversation("t");
  const f = fakeFuse({ hang: true });
  const jobs = new Jobs(store, f.impl);
  const first = jobs.start(conv.id, "q1", ["grok"]);
  assert.equal(jobs.activeFor(conv.id), first);
  assert.throws(() => jobs.start(conv.id, "q2", ["grok"]), ConflictError);
  f.release();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(jobs.activeFor(conv.id), null);
  const second = jobs.start(conv.id, "q2", ["grok"]);
  assert.notEqual(second, first);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(store.listTurns(conv.id).map((t) => t.idx), [0, 1]);
});

test("cancel records a cancelled turn and emits cancelled before finished", async () => {
  const store = new Store(":memory:");
  const conv = store.createConversation("t");
  const jobs = new Jobs(store, fakeFuse({ hang: true }).impl);
  const turnId = jobs.start(conv.id, "q", ["grok", "kimi"]);
  await new Promise((r) => setTimeout(r, 20));
  const got: JobEvent[] = [];
  jobs.subscribe(turnId, (e) => got.push(e.ev));
  assert.equal(jobs.cancel(turnId), true);
  await jobs.drain(1_000);
  assert.deepEqual(types(got).slice(-2), ["cancelled", "finished"]);
  const turn = store.getTurn(turnId)!;
  assert.equal(turn.status, "cancelled");
  assert.equal(turn.error, "cancelled");
  assert.equal(store.history(conv.id).length, 0, "a cancelled turn is not replayed");
  assert.equal(jobs.cancel(turnId), false, "cancel after finish is a no-op");
});

test("a degraded (unfused) answer persists its source lane", async () => {
  const store = new Store(":memory:");
  const conv = store.createConversation("t");
  const jobs = new Jobs(store, async ({ onEvent }) => {
    onEvent({ type: "synth", status: "skipped", reason: "synthesis failed", provider: "kimi" });
    return { lanes: [lane("grok", "G"), lane("kimi", "K")], synthesis: null, answer: "K", answerProvider: "kimi", historyOmitted: 0 };
  });
  const turnId = jobs.start(conv.id, "q", ["grok", "kimi"]);
  await jobs.drain(1_000);
  const t = store.getTurn(turnId)!;
  assert.equal(t.status, "done");
  assert.equal(t.answer_provider, "kimi");
  assert.equal(t.synth_provider, null);
});

/**
 * Compaction drops deltas but never a state-replacing event, which is what makes SSE resume safe:
 * a client whose Last-Event-ID predates the compacted deltas still converges on the same state.
 */
test("a reconnect with a Last-Event-ID older than the compacted deltas still converges", async () => {
  const store = new Store(":memory:");
  const conv = store.createConversation("t");
  const f = fakeFuse({ hang: true });
  const jobs = new Jobs(store, f.impl);
  const turnId = jobs.start(conv.id, "q", ["grok", "kimi"]);
  await new Promise((r) => setTimeout(r, 20));

  // The id a client would hold if its connection dropped mid-stream, while kimi was still typing.
  const live: { seq: number; ev: JobEvent }[] = [];
  jobs.subscribe(turnId, (e) => live.push(e));
  const dropped = live.find((e) => e.ev.type === "lane" && e.ev.status === "delta" && e.ev.provider === "kimi")!;
  f.release();
  await jobs.drain(1_000);

  const replay: JobEvent[] = [];
  jobs.subscribe(turnId, (e) => replay.push(e.ev), dropped.seq);
  assert.ok(!replay.some((e) => e.type === "lane" && e.status === "delta"), "the deltas it missed are gone");
  const done = replay.find((e) => e.type === "lane" && e.status === "done" && e.provider === "kimi") as any;
  assert.equal(done.result.answer, "K", "but the result carrying the same text is replayed in full");
  assert.equal(replay.at(-1)!.type, "finished");
});

test("a reconnect during a synthesizer fallback replays the winning attempt, not the abandoned one", async () => {
  const store = new Store(":memory:");
  const conv = store.createConversation("t");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const result = { analysis: null, answer: "fused", provider: "grok" as const, ms: 1, letterMap: { A: "grok" as const, B: "kimi" as const } };
  const jobs = new Jobs(store, async ({ onEvent }) => {
    onEvent({ type: "lane", provider: "grok", status: "done", result: lane("grok", "G") });
    onEvent({ type: "lane", provider: "kimi", status: "done", result: lane("kimi", "K") });
    onEvent({ type: "synth", status: "start", provider: "claude", fallback: false });
    onEvent({ type: "synth", status: "delta", text: "half an ans" });
    await gate;
    onEvent({ type: "synth", status: "start", provider: "grok", fallback: true });
    onEvent({ type: "synth", status: "delta", text: "fused" });
    onEvent({ type: "synth", status: "done", result });
    return { lanes: [lane("grok", "G"), lane("kimi", "K")], synthesis: result, answer: "fused", answerProvider: null, historyOmitted: 0 };
  });
  const turnId = jobs.start(conv.id, "q", ["grok", "kimi"]);
  await new Promise((r) => setTimeout(r, 20));

  const live: { seq: number; ev: JobEvent }[] = [];
  jobs.subscribe(turnId, (e) => live.push(e));
  const abandoned = live.find((e) => e.ev.type === "synth" && e.ev.status === "delta")!;
  release();
  await jobs.drain(1_000);

  const replay: JobEvent[] = [];
  jobs.subscribe(turnId, (e) => replay.push(e.ev), abandoned.seq);
  assert.ok(!replay.some((e) => e.type === "synth" && e.status === "delta"), "both attempts' deltas are compacted");
  const start = replay.find((e) => e.type === "synth" && e.status === "start") as any;
  assert.equal(start.fallback, true, "the fallback start is replayed, so the UI resets the pane");
  const done = replay.find((e) => e.type === "synth" && e.status === "done") as any;
  assert.equal(done.result.answer, "fused");
});
