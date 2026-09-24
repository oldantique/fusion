/** Orchestration: fallback chain, degraded answer, single lane, all failed, abort — with stub providers. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fuse, type FuseEvent } from "../src/synth/fuse.ts";
import { runLane } from "../src/providers/lane.ts";
import type { CallOptions, LaneEvent, Provider, ProviderId } from "../src/types.ts";
import { ANALYSIS_SCHEMA, PROMPT_MAX_BYTES, SYNTH_SCHEMA, utf8Bytes } from "../src/synth/prompts.ts";
import type { Tracer } from "../src/store/traces.ts";

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
  extraDeps: { synthEffort?: string; synthTimeoutMs?: number; staggerMs?: number } = {},
) {
  const events: FuseEvent[] = [];
  // These tests are about the fallback chain, not about pacing; the stagger test opts back in.
  const out = await fuse(
    { question: "q?", history: [], providerIds: ids, signal, onEvent: (e) => events.push(e) },
    { providers, runLane, staggerMs: 0, ...extraDeps },
  );
  return { out, events };
}

/** Records when its panel call starts; answers the synthesis prompt without recording. */
function timestamped(id: ProviderId, starts: { id: ProviderId; at: number }[]): Provider {
  return {
    id,
    label: id,
    streams: true,
    supportsJsonSchema: false,
    async *call(opts) {
      if (!opts.prompt.includes("<candidate")) starts.push({ id, at: Date.now() });
      yield { type: "done", text: `answer from ${id}` };
    },
  };
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

test("a prose-beside-schema synthesizer answers in its reply and gets the analysis-only schema", async () => {
  const seen: CallOptions[] = [];
  const claude: Provider = {
    ...stub("claude", (o) => {
      if (!o.prompt.includes("<candidate")) return [{ type: "done", text: "c" }];
      seen.push(o);
      return [{ type: "delta", text: "prose " }, { type: "done", text: "prose answer", structured: { analysis: { consensus: ["x"], contradictions: [], unique_insights: [], gaps: [] } } }];
    }, true),
    proseBesideSchema: true,
  };
  const { out, events } = await run({ claude, grok: stub("grok", ok("g")) }, ["claude", "grok"]);
  assert.equal(out.answer, "prose answer");
  assert.deepEqual(out.synthesis?.analysis?.consensus, ["x"]);
  assert.equal(seen[0]!.jsonSchema, ANALYSIS_SCHEMA);
  assert.equal(seen[0]!.streamField, undefined);
  assert.match(seen[0]!.system, /reply text/);
  assert.ok(events.some((e) => e.type === "synth" && e.status === "delta" && e.text === "prose "), "the prose streams as the answer");
});

test("an empty reply from a prose synthesizer moves the chain on; grok still gets the full schema", async () => {
  const claude: Provider = {
    ...stub("claude", synthOrPanel("c", [{ type: "done", text: "", structured: { analysis: { consensus: [], contradictions: [], unique_insights: [], gaps: [] } } }]), true),
    proseBesideSchema: true,
  };
  let grokOpts: CallOptions | undefined;
  const grok = stub("grok", (o) => {
    if (!o.prompt.includes("<candidate")) return [{ type: "done", text: "g" }];
    grokOpts = o;
    return [{ type: "done", text: "grok-fused", structured: { answer: "grok-fused", analysis: { consensus: ["y"], contradictions: [], unique_insights: [], gaps: [] } } }];
  }, true);
  const { out } = await run({ claude, grok }, ["claude", "grok"]);
  assert.equal(out.synthesis?.provider, "grok");
  assert.equal(out.answer, "grok-fused");
  assert.equal(grokOpts!.jsonSchema, SYNTH_SCHEMA);
  assert.equal(grokOpts!.streamField, "answer");
});

test("the trace hook sees each call's input and records, and one end per lane and synth attempt", async () => {
  const traced: Record<string, { records: unknown[]; ended: unknown[] }> = {};
  const trace = (name: string): Tracer => {
    const t = (traced[name] = { records: [] as unknown[], ended: [] as unknown[] });
    return { record: (o) => t.records.push(o), end: async (r) => void t.ended.push(r) };
  };
  const recording = (id: ProviderId, text: string): Provider => ({
    ...stub(id, ok(text)),
    async *call(opts) {
      opts.onRecord?.({ type: "raw", id });
      yield { type: "done", text };
    },
  });
  const events: FuseEvent[] = [];
  await fuse(
    { question: "q?", history: [], providerIds: ["claude", "grok"], onEvent: (e) => events.push(e), trace },
    { providers: { claude: recording("claude", "c"), grok: recording("grok", "g") }, runLane, staggerMs: 0 },
  );
  assert.deepEqual(Object.keys(traced).sort(), ["lane-claude", "lane-grok", "synth-1-claude"]);
  for (const t of Object.values(traced)) {
    assert.equal((t.records[0] as any).type, "fusion/input");
    assert.deepEqual(t.records[1], { type: "raw", id: (t.records[1] as any).id });
    assert.equal(t.ended.length, 1);
  }
  assert.match((traced["synth-1-claude"]!.records[0] as any).prompt, /<candidate/);
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
  assert.deepEqual(starts.map((s) => [s.provider, s.fallback, s.retry]), [["claude", false, false], ["claude", false, true], ["grok", true, false]]);
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
  assert.deepEqual(starts.map((s) => [s.provider, s.fallback, s.retry]), [["claude", false, false], ["claude", false, true], ["grok", true, false]]);
  assert.ok(Date.now() - t0 >= 50, "the first synthesizer really ran until its own timeout");
});

test("the whole synthesizer chain is capped at three lane timeouts (retry + fallback)", async () => {
  const claude = hangingSynth("claude", "claude-raw", true);
  const grok = hangingSynth("grok", "grok-raw");
  const t0 = Date.now();
  const { out } = await run({ claude, grok }, ["claude", "grok"], undefined, { synthTimeoutMs: 50 });
  const elapsed = Date.now() - t0;
  assert.equal(out.synthesis, null);
  assert.equal(out.answer, "claude-raw", "the best raw answer is shown instead");
  assert.ok(elapsed >= 140, `claude twice and grok once all ran (${elapsed}ms)`);
  assert.ok(elapsed < 200, `the chain was capped at 3x, not 4x (${elapsed}ms)`);
});

test("lanes start spaced out, in the order they were selected", async () => {
  const starts: { id: ProviderId; at: number }[] = [];
  const ids: ProviderId[] = ["claude", "grok", "kimi"];
  const providers = Object.fromEntries(ids.map((id) => [id, timestamped(id, starts)]));
  const stagger = 60;
  const t0 = Date.now();
  const { out } = await run(providers, ids, undefined, { staggerMs: stagger });

  assert.deepEqual(starts.map((s) => s.id), ids, "lanes start in selection order");
  // A timer can fire late but never early, so each lane's own slot is a safe lower bound.
  starts.forEach((s, i) => assert.ok(s.at - t0 >= i * stagger - 5, `lane ${i} waited its slot (${s.at - t0}ms)`));
  assert.equal(out.lanes.filter((l) => l.status === "done").length, ids.length, "every lane still ran");
});

test("stagger 0 fans out at once", async () => {
  const starts: { id: ProviderId; at: number }[] = [];
  const ids: ProviderId[] = ["claude", "grok", "kimi"];
  const providers = Object.fromEntries(ids.map((id) => [id, timestamped(id, starts)]));
  const t0 = Date.now();
  await run(providers, ids, undefined, { staggerMs: 0 });
  assert.equal(starts.length, ids.length);
  assert.ok(starts.at(-1)!.at - t0 < 100, `no lane waited a stagger slot (${starts.at(-1)!.at - t0}ms)`);
});

test("a long CJK conversation keeps every lane and synthesizer prompt under the byte ceiling", async () => {
  const sizes: number[] = [];
  const measuring = (id: ProviderId): Provider => ({
    ...stub(id, ok("答".repeat(8_000))),
    async *call(opts) {
      sizes.push(utf8Bytes(opts.system) + utf8Bytes(opts.prompt));
      yield { type: "done", text: opts.prompt.includes("<candidate") ? "fused" : "答".repeat(8_000) };
    },
  });
  // Ten turns of 10k-character answers: well inside the char budget, ~300 KB as UTF-8.
  const history = Array.from({ length: 10 }, (_, i) => ({ question: `问题${i}`, answer: "答".repeat(10_000) }));
  const out = await fuse(
    { question: "新问题？", history, providerIds: ["claude", "grok", "kimi"], onEvent: () => {} },
    { providers: { claude: measuring("claude"), grok: measuring("grok"), kimi: measuring("kimi") }, runLane, staggerMs: 0 },
  );
  assert.equal(out.answer, "fused");
  assert.equal(sizes.length, 4, "three lanes and one synthesis");
  for (const n of sizes) assert.ok(n <= PROMPT_MAX_BYTES, `a prompt of ${n} bytes`);
  assert.ok(out.historyOmitted > 0);
});
