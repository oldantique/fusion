import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/store/db.ts";
import { modelInfo, type ModelSnapshot } from "../src/types.ts";

const SOL: ModelSnapshot = { codex: { model: "gpt-5.6-sol", label: "GPT-5.6 Sol" } };
const ASTRA: ModelSnapshot = { codex: { model: "gpt-6-astra", label: "GPT-6 Astra" } };

test("store: conversation → turn → lanes → history replay", () => {
  const s = new Store(":memory:");
  const conv = s.createConversation("t");
  assert.equal(s.history(conv.id).length, 0);

  const t1 = s.startTurn(conv.id, "q1", ["claude", "grok"], SOL);
  assert.equal(t1.idx, 0);
  assert.equal(t1.status, "running");
  s.saveLane(t1.id, { provider: "claude", status: "done", answer: "a", ms: 5, error: null, errorKind: null, attempts: 1 });
  s.saveLane(t1.id, { provider: "grok", status: "failed", answer: null, ms: 9, error: "x", errorKind: "rate_limit", attempts: 2 });
  s.finishTurn(t1.id, "fused1", { analysis: { consensus: ["c"], contradictions: [], unique_insights: [], gaps: [] }, answer: "fused1", provider: "claude", ms: 7, letterMap: { A: "claude" } }, 0, null);

  const t2 = s.startTurn(conv.id, "q2", ["claude"], ASTRA);
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

  // each turn keeps naming the model it was started with, through both read paths
  assert.deepEqual(got.models, SOL);
  assert.deepEqual(s.listTurns(conv.id).map((t) => t.models?.codex?.label), ["GPT-5.6 Sol", "GPT-6 Astra"]);

  s.failStaleTurns();
  assert.equal(s.getTurn(t2.id)!.status, "failed");
  assert.equal(s.listConversations()[0]!.turn_count, 2);

  s.deleteConversation(conv.id);
  assert.equal(s.getTurn(t1.id), null);
  s.close();
});

/** A database file as a build from before model snapshots left it: no column, user_version 0. */
function legacyDb(withColumn: boolean): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fusion-store-")), "legacy.sqlite");
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE turns (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, idx INTEGER NOT NULL, question TEXT NOT NULL, answer TEXT,
      analysis_json TEXT, letter_map_json TEXT, synth_provider TEXT, synth_ms INTEGER, providers_json TEXT NOT NULL,
      history_omitted INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL, finished_at INTEGER${withColumn ? ", models_json TEXT" : ""});
    INSERT INTO conversations VALUES ('c', 't', 1, 1);
    INSERT INTO turns (id, conversation_id, idx, question, providers_json, status, created_at) VALUES ('old', 'c', 0, 'q', '["codex"]', 'done', 1);`);
  if (withColumn) db.prepare("INSERT INTO turns (id, conversation_id, idx, question, providers_json, models_json, status, created_at) VALUES ('kept', 'c', 1, 'q', '[]', ?, 'done', 2)").run(JSON.stringify(ASTRA));
  db.close();
  return file;
}

test("store: migration backfills old turns once with the models they ran on, and never again", () => {
  const file = legacyDb(false);
  let s = new Store(file);
  assert.equal(s.getTurn("old")!.models?.codex?.label, "GPT-5.6 Sol");
  assert.equal(s.getTurn("old")!.models?.claude?.model, "opus");
  s.close();

  // a row some older build writes after the migration has no snapshot: unknown, not "legacy"
  const raw = new DatabaseSync(file);
  raw.exec("INSERT INTO turns (id, conversation_id, idx, question, providers_json, status, created_at) VALUES ('late', 'c', 1, 'q', '[]', 'done', 3)");
  raw.close();
  s = new Store(file);
  assert.equal(s.getTurn("late")!.models, null);
  assert.equal(s.getTurn("old")!.models?.codex?.label, "GPT-5.6 Sol");
  s.close();
});

test("store: migration keeps a snapshot that is already there", () => {
  const s = new Store(legacyDb(true));
  assert.deepEqual(s.getTurn("kept")!.models, ASTRA);
  assert.equal(s.getTurn("old")!.models?.codex?.label, "GPT-5.6 Sol");
  s.close();
});

test("modelInfo: names come from the model id, and an unknown id is shown as itself", () => {
  assert.deepEqual(modelInfo("codex", "gpt-5.6-sol"), { model: "gpt-5.6-sol", label: "GPT-5.6 Sol", cutoff: "2026-02", known: true });
  assert.equal(modelInfo("codex", "gpt-6-astra").label, "GPT-6 Astra");
  // kimi publishes no cutoff (known, null); a model we have no row for is a different kind of null
  assert.deepEqual(modelInfo("kimi", "kimi-code/k3"), { model: "kimi-code/k3", label: "Kimi K3", cutoff: null, known: true });
  assert.deepEqual(modelInfo("codex", "gpt-5.6-terra"), { model: "gpt-5.6-terra", label: "gpt-5.6-terra", cutoff: null, known: false });
});
