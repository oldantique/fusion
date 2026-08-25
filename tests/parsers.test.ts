import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createAnthropicStreamParser } from "../src/parsers/anthropic-stream.ts";
import { createCodexParser, createKimiParser } from "../src/parsers/whole-message.ts";
import { createJsonFieldStreamer } from "../src/parsers/json-field-stream.ts";
import { classifyFailure } from "../src/providers/base.ts";
import type { LaneEvent } from "../src/types.ts";

const FIX = path.join(import.meta.dirname, "..", "fixtures");
const lines = (f: string) =>
  fs.readFileSync(path.join(FIX, f), "utf8").split("\n").filter((l) => l.trim().startsWith("{")).map((l) => JSON.parse(l));

function run(parser: { feed(o: any): LaneEvent[] }, f: string) {
  const events: LaneEvent[] = [];
  for (const obj of lines(f)) events.push(...parser.feed(obj));
  return events;
}

test("claude stream-json: deltas then done with result text", () => {
  const ev = run(createAnthropicStreamParser(), "cmin.ndjson");
  const deltas = ev.filter((e) => e.type === "delta").map((e: any) => e.text).join("");
  assert.equal(deltas, "The capital of France is Paris.");
  const done = ev.at(-1) as any;
  assert.equal(done.type, "done");
  assert.equal(done.text, "The capital of France is Paris.");
  assert.ok(done.usage.costUsd > 0);
});

test("claude's rate_limit_event is recorded on the parser state, not emitted", () => {
  const p = createAnthropicStreamParser();
  const ev = run(p, "cmin.ndjson");
  assert.equal(p.state.rateLimit?.status, "allowed");
  assert.ok(!ev.some((e) => e.type === "error"), "a healthy quota record is not an error");
});

test("classifyFailure marks quota messages as rate_limit and leaves the rest alone", () => {
  assert.equal(classifyFailure("You've hit your usage limit · resets at 5pm", "exit"), "rate_limit");
  assert.equal(classifyFailure("HTTP 429 Too Many Requests", "exit"), "rate_limit");
  assert.equal(classifyFailure("exit 1: boom", "exit"), "exit");
  assert.equal(classifyFailure("no output (exit 0): (no diagnostics)", "empty"), "empty");
});

test("grok streaming-messages-json parses with the same parser (thinking + text)", () => {
  const ev = run(createAnthropicStreamParser(), "grok.ndjson");
  assert.ok(ev.some((e) => e.type === "thinking"));
  const done = ev.at(-1) as any;
  assert.equal(done.type, "done");
  assert.equal(done.text, "The capital of France is Paris.");
});

test("claude --json-schema: streams the answer field and returns structured output", () => {
  const ev = run(createAnthropicStreamParser("answer"), "claude-json-schema.ndjson");
  const streamed = ev.filter((e) => e.type === "delta").map((e: any) => e.text).join("");
  const done = ev.at(-1) as any;
  assert.equal(done.type, "done");
  assert.ok(done.structured.facts.length === 2);
  assert.equal(done.text, done.structured.answer);
  assert.equal(streamed, done.structured.answer);
});

test("grok --json-schema: the JSON arrives as text deltas, the answer field still streams", () => {
  const p = createAnthropicStreamParser("answer");
  const ev = run(p, "grok-json-schema.ndjson");
  const streamed = ev.filter((e) => e.type === "delta").map((e: any) => e.text).join("");
  const done = ev.at(-1) as any;
  assert.equal(done.type, "done");
  // The whole point of the field streamer: no braces reach the UI, and what streamed is the answer.
  assert.ok(!streamed.includes('"answer"'), "the raw JSON document must not be streamed");
  assert.equal(streamed, done.structured.answer);
  assert.equal(done.text, done.structured.answer);
  assert.equal(done.structured.analysis.unique_insights.length, 2);
});

test("a schema run with no structured_output degrades to the streamed field, never to raw JSON", () => {
  const doc = JSON.stringify({ answer: "merged answer", analysis: { consensus: [] } });
  const deltas = (text: string) => ({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
  const p = createAnthropicStreamParser("answer");
  for (const ch of doc) p.feed(deltas(ch));
  // Same run, but the CLI reports no object — as a prompt-enforced schema may.
  const done = p.feed({ type: "result", is_error: false, result: doc }).at(-1) as any;
  assert.equal(done.type, "done");
  assert.equal(done.text, "merged answer");
  assert.deepEqual(done.structured, { answer: "merged answer", analysis: { consensus: [] } });
});

test("a schema run whose output is not JSON at all still yields the text it produced", () => {
  const p = createAnthropicStreamParser("answer");
  const done = p.feed({ type: "result", is_error: false, result: "I could not follow the schema." }).at(-1) as any;
  assert.equal(done.type, "done");
  assert.equal(done.text, "I could not follow the schema.");
  assert.equal(done.structured, undefined);
});

test("codex exec --json: whole message at turn.completed", () => {
  const ev = run(createCodexParser(), "codex.ndjson");
  assert.equal(ev.length, 1);
  assert.equal(ev[0]!.type, "done");
  assert.equal((ev[0] as any).text, "The capital of France is Paris.");
});

test("kimi stream-json: assistant content, done at resume_hint", () => {
  const ev = run(createKimiParser(), "kimi.ndjson");
  assert.equal(ev.length, 1);
  assert.equal((ev[0] as any).text, "The capital of France is Paris.");
});

test("json field streamer handles escapes across fragment boundaries and key order", () => {
  const doc = JSON.stringify({ analysis: { consensus: ["a \"quoted\" thing"] }, answer: "line1\nline2 \"q\" é \\ end", gaps: [] });
  for (const chunk of [1, 2, 3, 7, 50]) {
    const s = createJsonFieldStreamer("answer");
    let out = "";
    for (let i = 0; i < doc.length; i += chunk) out += s.feed(doc.slice(i, i + chunk));
    assert.equal(out, "line1\nline2 \"q\" é \\ end", `chunk=${chunk}`);
    assert.ok(s.done);
  }
});

test("json field streamer ignores a nested key with the same name", () => {
  const doc = JSON.stringify({ meta: { answer: "nested" }, answer: "top" });
  const s = createJsonFieldStreamer("answer");
  assert.equal(s.feed(doc), "top");
});
