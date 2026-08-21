/** Orchestration: fallback chain, degraded answer, single lane, all failed, abort — with stub providers. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fuse, type FuseEvent } from "../src/synth/fuse.ts";
import { runLane } from "../src/providers/lane.ts";
import type { CallOptions, LaneEvent, Provider, ProviderId } from "../src/types.ts";

type Script = (opts: CallOptions) => LaneEvent[];
function stub(id: ProviderId, script: Script, supportsJsonSchema = false): Provider {
  return {
    id,
    label: id,
    streams: true,
    supportsJsonSchema,
    async *call(opts) {
      for (const ev of script(opts)) yield ev;
    },
  };
}
const ok = (text: string): Script => () => [{ type: "done", text }];
const fail: Script = () => [{ type: "error", message: "exit 1: nope", kind: "exit" }];
const synthOrPanel = (panel: string, synth: LaneEvent[]): Script => (o) => (o.prompt.includes("<candidate") ? synth : [{ type: "done", text: panel }]);

/** Answers the panel immediately, then hangs on the synthesis prompt until its signal aborts. */
function hangingSynth(id: ProviderId, panel: string, supportsJsonSchema = false): Provider {
  return {
    id,
    label: id,
    streams: true,
    supportsJsonSchema,
    async *call(opts) {
      if (!opts.prompt.includes("<candidate")) {
        yield { type: "done", text: panel };
        return;
      }
      // A real provider has a live child process holding the event loop open; AbortSignal.timeout
      // timers are unref'd, so without this stand-in they would never fire under node:test.
      const keepAlive = setInterval(() => {}, 5);
      try {
        await new Promise<void>((r) => {
          if (opts.signal?.aborted) return r();
          opts.signal?.addEventListener("abort", () => r(), { once: true });
        });
      } finally {
        clearInterval(keepAlive);
      }
      yield { type: "error", message: "timed out", kind: "timeout" };
    },
  };
}

async function run(
  providers: Partial<Record<ProviderId, Provider>>,
  ids: ProviderId[],
  signal?: AbortSignal,
  extraDeps: { synthEffort?: string; synthTimeoutMs?: number } = {},
) {
  const events: FuseEvent[] = [];
  const out = await fuse({ question: "q?", history: [], providerIds: ids, signal, onEvent: (e) => events.push(e) }, { providers, runLane, ...extraDeps });
  return { out, events };
}

test("claude synthesizes with structured analysis when it works", async () => {
  const claude = stub("claude", synthOrPanel("c", [{ type: "done", text: "fused", structured: { answer: "fused", analysis: { consensus: ["x"], contradictions: [], unique_insights: [], gaps: [] } } }]), true);
  const grok = stub("grok", ok("g"));
  const { out, events } = await run({ claude, grok }, ["claude", "grok"]);
  assert.equal(out.answer, "fused");
  assert.equal(out.synthesis?.provider, "claude");
  assert.deepEqual(out.synthesis?.analysis?.consensus, ["x"]);
  assert.equal(out.answerProvider, null);
  const starts = events.filter((e) => e.type === "synth" && e.status === "start");
  assert.equal(starts.length, 1);
});

test("falls back to the next synthesizer when claude fails, in the documented order", async () => {
  const claude = stub("claude", synthOrPanel("c", [{ type: "error", message: "exit 1", kind: "exit" }]), true);
  const grok = stub("grok", synthOrPanel("g", [{ type: "done", text: "grok-fused" }]));
  const codex = stub("codex", ok("x"));
  const { out, events } = await run({ claude, grok, codex }, ["claude", "grok", "codex"]);
  assert.equal(out.answer, "grok-fused");
  assert.equal(out.synthesis?.provider, "grok");
  assert.equal(out.synthesis?.analysis, null);
  const starts = events.filter((e): e is Extract<FuseEvent, { status: "start" }> => e.type === "synth" && e.status === "start");
  assert.deepEqual(starts.map((s) => [s.provider, s.fallback]), [["claude", false], ["grok", true]]);
});

test("when every synthesizer fails, the best raw answer is shown and marked as unfused", async () => {
  const claude = stub("claude", synthOrPanel("claude-raw", [{ type: "error", message: "exit 1", kind: "exit" }]), true);
  const grok = stub("grok", synthOrPanel("grok-raw", [{ type: "error", message: "exit 1", kind: "exit" }]));
  const { out, events } = await run({ claude, grok }, ["claude", "grok"]);
  assert.equal(out.synthesis, null);
  assert.equal(out.answer, "claude-raw");
  assert.equal(out.answerProvider, "claude");
  const skipped = events.find((e) => e.type === "synth" && e.status === "skipped") as any;
  assert.equal(skipped.reason, "synthesis failed");
  assert.equal(skipped.provider, "claude");
});

test("a single successful lane is returned without synthesis", async () => {
  const claude = stub("claude", fail, true);
  const grok = stub("grok", ok("only"));
  const { out, events } = await run({ claude, grok }, ["claude", "grok"]);
  assert.equal(out.answer, "only");
  assert.equal(out.answerProvider, "grok");
  assert.ok(!events.some((e) => e.type === "synth" && e.status === "start"), "no synthesizer was started");
});

test("all lanes failed → no answer, no synthesis attempt", async () => {
  const { out, events } = await run({ claude: stub("claude", fail, true), grok: stub("grok", fail) }, ["claude", "grok"]);
  assert.equal(out.answer, null);
  assert.ok(events.some((e) => e.type === "synth" && e.status === "skipped" && e.reason === "all lanes failed"));
});

test("a lane that rejects outright becomes a failed lane, the turn still completes", async () => {
  const broken: Provider = { id: "kimi", label: "kimi", streams: false, supportsJsonSchema: false, call: () => { throw new Error("constructor bug"); } };
  const grok = stub("grok", ok("g"));
  const { out } = await run({ kimi: broken, grok }, ["kimi", "grok"]);
  assert.equal(out.answer, "g");
  assert.match(out.lanes.find((l) => l.provider === "kimi")!.error!, /internal/);
});

test("abort before synthesis yields no answer and no degraded pick", async () => {
  const ac = new AbortController();
  const claude = stub("claude", synthOrPanel("c", [{ type: "done", text: "fused" }]), true);
  const grok: Provider = { ...stub("grok", ok("g")), async *call() { ac.abort(); yield { type: "done", text: "g" }; } };
  const { out } = await run({ claude, grok }, ["claude", "grok"], ac.signal);
  assert.equal(out.answer, null);
});

test("the synthesizer call carries its own effort; panel lanes carry none", async () => {
  const efforts: { panel?: string; synth?: string } = {};
  const record = (key: "panel" | "synth"): Script => (o) => {
    efforts[key] = o.effort;
    return [{ type: "done", text: key }];
  };
  const claude = stub("claude", (o) => (o.prompt.includes("<candidate") ? record("synth")(o) : [{ type: "done", text: "c" }]), true);
  const grok = stub("grok", record("panel"));
  const { out } = await run({ claude, grok }, ["claude", "grok"], undefined, { synthEffort: "medium" });
  assert.equal(out.answer, "synth");
  assert.equal(efforts.panel, undefined, "a panel lane uses the configured default, not an override");
  assert.equal(efforts.synth, "medium");
});

test("a synthesizer that hangs is cut off, and the fallback gets a full timeout of its own", async () => {
  const claude = hangingSynth("claude", "c", true);
  const grok = stub("grok", synthOrPanel("g", [{ type: "done", text: "grok-fused" }]));
  const t0 = Date.now();
  const { out, events } = await run({ claude, grok }, ["claude", "grok"], undefined, { synthTimeoutMs: 50 });
  assert.equal(out.answer, "grok-fused");
  assert.equal(out.synthesis?.provider, "grok");
  const starts = events.filter((e): e is Extract<FuseEvent, { status: "start" }> => e.type === "synth" && e.status === "start");
  assert.deepEqual(starts.map((s) => [s.provider, s.fallback]), [["claude", false], ["grok", true]]);
  assert.ok(Date.now() - t0 >= 50, "the first synthesizer really ran until its own timeout");
});

test("the whole synthesizer chain is capped at twice the lane timeout", async () => {
  const claude = hangingSynth("claude", "claude-raw", true);
  const grok = hangingSynth("grok", "grok-raw");
  const t0 = Date.now();
  const { out } = await run({ claude, grok }, ["claude", "grok"], undefined, { synthTimeoutMs: 50 });
  const elapsed = Date.now() - t0;
  assert.equal(out.synthesis, null);
  assert.equal(out.answer, "claude-raw", "the best raw answer is shown instead");
  assert.ok(elapsed >= 90, `both attempts ran (${elapsed}ms)`);
  assert.ok(elapsed < 150, `the chain was capped at 2x, not 3x (${elapsed}ms)`);
});
