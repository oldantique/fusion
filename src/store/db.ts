/** SQLite persistence (node:sqlite). One writer process; WAL so readers never block. */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config.ts";
import type { Analysis, HistoryTurn, LaneResult, ProviderId, SynthesisResult } from "../types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  question TEXT NOT NULL,
  answer TEXT,
  analysis_json TEXT,
  letter_map_json TEXT,
  synth_provider TEXT,
  synth_ms INTEGER,
  providers_json TEXT NOT NULL,
  history_omitted INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,            -- running | done | failed | cancelled
  error TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS turns_conv ON turns(conversation_id, idx);
CREATE UNIQUE INDEX IF NOT EXISTS turns_conv_unique ON turns(conversation_id, idx);
CREATE TABLE IF NOT EXISTS lane_results (
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  answer TEXT,
  ms INTEGER NOT NULL,
  error TEXT,
  attempts INTEGER NOT NULL,
  usage_json TEXT,
  PRIMARY KEY (turn_id, provider)
);
`;

export interface ConversationRow {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  turn_count: number;
}

export interface TurnRow {
  id: string;
  conversation_id: string;
  idx: number;
  question: string;
  answer: string | null;
  analysis: Analysis | null;
  letter_map: Record<string, ProviderId> | null;
  synth_provider: ProviderId | null;
  synth_ms: number | null;
  /** Set when `answer` is one lane's raw answer (single lane, or synthesis failed) rather than a synthesis. */
  answer_provider: ProviderId | null;
  providers: ProviderId[];
  history_omitted: number;
  status: "running" | "done" | "failed" | "cancelled";
  error: string | null;
  created_at: number;
  finished_at: number | null;
  lanes: LaneResult[];
}

function plainConversation(r: any): ConversationRow {
  return { id: r.id, title: r.title, created_at: r.created_at, updated_at: r.updated_at, turn_count: r.turn_count };
}

export class Store {
  private db: DatabaseSync;

  constructor(file = config.dbPath) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.exec(SCHEMA);
    // Additive columns for databases created before they existed (no migration framework yet;
    // each line is idempotent because SQLite rejects a duplicate column).
    for (const ddl of ["ALTER TABLE turns ADD COLUMN answer_provider TEXT"]) {
      try {
        this.db.exec(ddl);
      } catch (e) {
        if (!/duplicate column/i.test(String(e))) throw e;
      }
    }
  }

  close() {
    this.db.close();
  }

  // ---- conversations ----

  createConversation(title: string): ConversationRow {
    const id = randomUUID();
    const now = Date.now();
    this.db.prepare("INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, title.slice(0, 120), now, now);
    return { id, title, created_at: now, updated_at: now, turn_count: 0 };
  }

  listConversations(limit = 200): ConversationRow[] {
    const rows = this.db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM turns t WHERE t.conversation_id = c.id) AS turn_count
         FROM conversations c ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(limit) as any[];
    return rows.map(plainConversation);
  }

  getConversation(id: string): ConversationRow | null {
    const row = this.db
      .prepare(`SELECT c.*, (SELECT COUNT(*) FROM turns t WHERE t.conversation_id = c.id) AS turn_count FROM conversations c WHERE id = ?`)
      .get(id) as any;
    return row ? plainConversation(row) : null;
  }

  renameConversation(id: string, title: string) {
    this.db.prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?").run(title.slice(0, 120), Date.now(), id);
  }

  deleteConversation(id: string) {
    this.db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
  }

  // ---- turns ----

  /** History for replay: completed turns with a fused answer, in order. */
  history(conversationId: string): HistoryTurn[] {
    const rows = this.db
      .prepare("SELECT question, answer FROM turns WHERE conversation_id = ? AND status = 'done' AND answer IS NOT NULL ORDER BY idx")
      .all(conversationId) as any[];
    return rows.map((r) => ({ question: r.question, answer: r.answer }));
  }

  startTurn(conversationId: string, question: string, providers: ProviderId[]): TurnRow {
    const id = randomUUID();
    const now = Date.now();
    const idx = (this.db.prepare("SELECT COALESCE(MAX(idx), -1) + 1 AS n FROM turns WHERE conversation_id = ?").get(conversationId) as any).n as number;
    this.db
      .prepare(
        `INSERT INTO turns (id, conversation_id, idx, question, providers_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'running', ?)`,
      )
      .run(id, conversationId, idx, question, JSON.stringify(providers), now);
    this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now, conversationId);
    return this.getTurn(id)!;
  }

  saveLane(turnId: string, lane: LaneResult) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO lane_results (turn_id, provider, status, answer, ms, error, attempts, usage_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(turnId, lane.provider, lane.status, lane.answer, lane.ms, lane.error, lane.attempts, lane.usage ? JSON.stringify(lane.usage) : null);
  }

  finishTurn(
    turnId: string,
    answer: string | null,
    synthesis: SynthesisResult | null,
    historyOmitted: number,
    error: string | null,
    answerProvider: ProviderId | null = null,
  ) {
    const status = answer ? "done" : error === "cancelled" ? "cancelled" : "failed";
    this.db
      .prepare(
        `UPDATE turns SET answer = ?, analysis_json = ?, letter_map_json = ?, synth_provider = ?, synth_ms = ?, answer_provider = ?,
           history_omitted = ?, status = ?, error = ?, finished_at = ? WHERE id = ?`,
      )
      .run(
        answer,
        synthesis?.analysis ? JSON.stringify(synthesis.analysis) : null,
        synthesis ? JSON.stringify(synthesis.letterMap) : null,
        synthesis?.provider ?? null,
        synthesis?.ms ?? null,
        answerProvider,
        historyOmitted,
        status,
        error,
        Date.now(),
        turnId,
      );
  }

  /** Mark turns left 'running' by a crashed/restarted server as failed. */
  failStaleTurns() {
    this.db.prepare("UPDATE turns SET status = 'failed', error = 'server restarted', finished_at = ? WHERE status = 'running'").run(Date.now());
  }

  getTurn(id: string): TurnRow | null {
    const row = this.db.prepare("SELECT * FROM turns WHERE id = ?").get(id) as any;
    return row ? this.hydrate(row) : null;
  }

  listTurns(conversationId: string): TurnRow[] {
    const rows = this.db.prepare("SELECT * FROM turns WHERE conversation_id = ? ORDER BY idx").all(conversationId) as any[];
    return rows.map((r) => this.hydrate(r));
  }

  private hydrate(r: any): TurnRow {
    const lanes = (this.db.prepare("SELECT * FROM lane_results WHERE turn_id = ?").all(r.id) as any[]).map(
      (l): LaneResult => ({
        provider: l.provider,
        status: l.status,
        answer: l.answer,
        ms: l.ms,
        error: l.error,
        exitCode: null,
        attempts: l.attempts,
        usage: l.usage_json ? JSON.parse(l.usage_json) : undefined,
      }),
    );
    return {
      id: r.id,
      conversation_id: r.conversation_id,
      idx: r.idx,
      question: r.question,
      answer: r.answer,
      analysis: r.analysis_json ? JSON.parse(r.analysis_json) : null,
      letter_map: r.letter_map_json ? JSON.parse(r.letter_map_json) : null,
      synth_provider: r.synth_provider,
      synth_ms: r.synth_ms,
      answer_provider: r.answer_provider ?? null,
      providers: JSON.parse(r.providers_json),
      history_omitted: r.history_omitted,
      status: r.status,
      error: r.error,
      created_at: r.created_at,
      finished_at: r.finished_at,
      lanes,
    };
  }
}
