import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Traces } from "../src/store/traces.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fusion-traces-"));
const readLines = (f: string) => fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("a trace is written on end: records, then the result line, private modes", async () => {
  const dir = tmp();
  const t = new Traces(dir, 30).forTurn("turn-1")!("lane-claude")!;
  t.record({ type: "a" });
  t.record({ type: "b" });
  await t.end({ status: "done", answer: "x" });
  const file = path.join(dir, "turn-1", "lane-claude.ndjson");
  assert.deepEqual(readLines(file), [{ type: "a" }, { type: "b" }, { type: "fusion/result", status: "done", answer: "x" }]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, "turn-1")).mode & 0o777, 0o700);
});

test("a trace past the size cap stops recording and says it was truncated", async () => {
  const dir = tmp();
  const t = new Traces(dir, 30).forTurn("t")!("big")!;
  const chunk = "x".repeat(1024 * 1024);
  for (let i = 0; i < 10; i++) t.record({ chunk });
  await t.end({ status: "done" });
  const lines = readLines(path.join(dir, "t", "big.ndjson"));
  assert.ok(lines.length < 10);
  assert.equal(lines.at(-2).type, "fusion/truncated");
  assert.equal(lines.at(-1).type, "fusion/result");
});

test("prune removes turn directories older than the retention, keeps newer ones", () => {
  const dir = tmp();
  for (const id of ["old", "new"]) fs.mkdirSync(path.join(dir, id));
  const day = 24 * 60 * 60;
  const now = Date.now();
  fs.utimesSync(path.join(dir, "old"), now / 1000 - 31 * day, now / 1000 - 31 * day);
  new Traces(dir, 30).prune(now);
  assert.deepEqual(fs.readdirSync(dir), ["new"]);
});

test("remove deletes the named turns' traces and ignores ids that are not plain names", () => {
  const dir = tmp();
  for (const id of ["a", "b"]) fs.mkdirSync(path.join(dir, id));
  new Traces(dir, 30).remove(["a", "../b"]);
  assert.deepEqual(fs.readdirSync(dir), ["b"]);
});

test("0 days turns tracing off", () => {
  const dir = tmp();
  const traces = new Traces(dir, 0);
  assert.equal(traces.forTurn("t"), undefined);
  fs.mkdirSync(path.join(dir, "ancient"));
  fs.utimesSync(path.join(dir, "ancient"), 0, 0);
  traces.prune();
  assert.deepEqual(fs.readdirSync(dir), ["ancient"], "prune is off with tracing");
});
