/**
 * The codex app-server daemon against a fake child that replays the captured JSON-RPC exchange
 * in fixtures/codex-app-server.ndjson (server lines, with the client's own lines kept as
 * `# client>` markers so the fake knows where each request's answers start), plus synthetic
 * crash / interrupt / failure exchanges for the lifecycle rules.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { CodexDaemon, classifyTurnError, codexTurn, type DaemonChild } from "../src/providers/codex-app-server.ts";
import type { LaneEvent } from "../src/types.ts";

const FIXTURE = path.join(import.meta.dirname, "..", "fixtures", "codex-app-server.ndjson");

/** Server output grouped by the client request that preceded it, in capture order. */
function fixtureExchange(): string[][] {
  const groups: string[][] = [];
  for (const line of fs.readFileSync(FIXTURE, "utf8").split("\n")) {
    if (line.startsWith("# client>")) groups.push([]);
    else if (line.trim().startsWith("{")) groups.at(-1)!.push(line);
  }
  return groups;
}

interface FakeChild extends DaemonChild {
  requests: any[];
  emit(line: string): void;
  crash(): void;
  closed: boolean;
}

/**
 * A child whose stdout answers each stdin line via `reply`, which returns the raw lines to emit
 * (ids are rewritten to the request's so the fixture's numbering need not match).
 */
function fakeChild(reply: (req: any, n: number) => string[] | "silence"): FakeChild {
  const em = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const requests: any[] = [];
  let n = 0;
  let buf = "";
  const child: FakeChild = {
    pid: undefined,
    stdin,
    stdout,
    stderr: new PassThrough(),
    requests,
    closed: false,
    on: (ev: string, cb: any) => em.on(ev, cb),
    kill() {
      this.crash();
    },
    crash() {
      if (child.closed) return;
      child.closed = true;
      stdout.end();
      em.emit("close", null, "SIGTERM");
    },
    emit(line: string) {
      stdout.write(line + "\n");
    },
  };
  stdin.on("data", (d: Buffer) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const req = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      requests.push(req);
      const out = reply(req, n++);
      if (out === "silence") continue;
      for (const l of out) {
        const msg = JSON.parse(l);
        if (msg.id !== undefined && req.id !== undefined) msg.id = req.id;
        child.emit(JSON.stringify(msg));
      }
    }
  });
  return child;
}

/** Replays the captured exchange: the n-th client line gets the n-th group of server lines. */
function replayChild(): FakeChild {
  const groups = fixtureExchange();
  return fakeChild((_req, n) => groups[n] ?? []);
}

async function collect(gen: AsyncGenerator<LaneEvent>) {
  const events: LaneEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

const opts = { prompt: "In one sentence, what is the capital of France?", system: "You are a general assistant.", effort: "low" };

test("replay: one turn streams deltas, ends with done + usage, and asks for a stateless read-only thread", async () => {
  let child!: FakeChild;
  const daemon = new CodexDaemon({ spawn: () => (child = replayChild()) });
  const events = await collect(codexTurn(daemon, opts));
  const deltas = events.filter((e) => e.type === "delta").map((e: any) => e.text).join("");
  assert.equal(deltas, "The capital of France is Paris.");
  const done = events.at(-1) as any;
  assert.equal(done.type, "done");
  assert.equal(done.text, "The capital of France is Paris.");
  assert.ok(done.usage.inputTokens > 0 && done.usage.outputTokens > 0);

  const methods = child.requests.map((r) => r.method);
  assert.deepEqual(methods, ["initialize", "initialized", "thread/start", "turn/start", "thread/unsubscribe"]);
  const start = child.requests.find((r) => r.method === "thread/start").params;
  assert.equal(start.ephemeral, true);
  assert.equal(start.sandbox, "read-only");
  assert.equal(start.approvalPolicy, "never");
  assert.equal(start.config.web_search, "disabled");
  assert.equal(start.developerInstructions, opts.system);
  const turn = child.requests.find((r) => r.method === "turn/start").params;
  assert.deepEqual(turn.input, [{ type: "text", text: opts.prompt }]);
  assert.equal(turn.effort, "low");
  assert.equal(daemon.spawns, 1);
  assert.equal(daemon.alive, true, "the daemon outlives the turn");
  daemon.shutdown();
});

test("a second call reuses the daemon (one handshake, fresh thread)", async () => {
  const groups = fixtureExchange();
  // Handshake once, then thread/start, turn/start, unsubscribe per call.
  let child!: FakeChild;
  const perCall = groups.slice(2); // thread/start, turn/start, thread/unsubscribe answers
  const daemon = new CodexDaemon({
    spawn: () => (child = fakeChild((req) => {
      if (req.method === "initialize") return groups[0]!;
      if (req.method === "initialized") return [];
      const i = ["thread/start", "turn/start", "thread/unsubscribe"].indexOf(req.method);
      return perCall[i] ?? [];
    })),
  });
  const a = await collect(codexTurn(daemon, opts));
  const b = await collect(codexTurn(daemon, opts));
  assert.equal((a.at(-1) as any).type, "done");
  assert.equal((b.at(-1) as any).type, "done");
  assert.equal(daemon.spawns, 1);
  assert.equal(child.requests.filter((r) => r.method === "initialize").length, 1);
  assert.equal(child.requests.filter((r) => r.method === "thread/start").length, 2);
  daemon.shutdown();
});

const THREAD = "t-1";
const TURN = "u-1";
const handshake = (req: any) => {
  if (req.method === "initialize") return [JSON.stringify({ id: 0, result: {} })];
  if (req.method === "initialized") return [];
  if (req.method === "thread/start") return [JSON.stringify({ id: 0, result: { thread: { id: THREAD } } })];
  if (req.method === "turn/start") return [JSON.stringify({ id: 0, result: { turn: { id: TURN, status: "inProgress" } } })];
  if (req.method === "thread/unsubscribe") return [JSON.stringify({ id: 0, result: { status: "unsubscribed" } })];
  return undefined;
};
const completed = (status: string, error: any = null) => JSON.stringify({ method: "turn/completed", params: { threadId: THREAD, turn: { id: TURN, status, error, items: [] } } });

test("daemon dying mid-turn fails the turn with a retryable kind; the next call respawns", async () => {
  const children: FakeChild[] = [];
  const daemon = new CodexDaemon({
    spawn: () => {
      const c = fakeChild((req) => {
        const h = handshake(req);
        if (h) return h;
        return [];
      });
      children.push(c);
      return c;
    },
  });
  const gen = codexTurn(daemon, opts);
  const first = gen.next(); // runs handshake + thread/start + turn/start, then waits
  await new Promise((r) => setTimeout(r, 50));
  children[0]!.crash();
  const ev = (await first).value as any;
  assert.equal(ev.type, "error");
  assert.equal(ev.kind, "exit");
  assert.match(ev.message, /exited/);
  await gen.return(undefined);
  assert.equal(daemon.alive, false);

  // Second call: a new child is spawned and completes normally.
  const gen2 = codexTurn(daemon, opts);
  const p = collect(gen2);
  await new Promise((r) => setTimeout(r, 50));
  children[1]!.emit(JSON.stringify({ method: "item/completed", params: { threadId: THREAD, turnId: TURN, item: { type: "agentMessage", text: "hello" } } }));
  children[1]!.emit(completed("completed"));
  const events = await p;
  assert.equal((events.at(-1) as any).text, "hello");
  assert.equal(daemon.spawns, 2);
  daemon.shutdown();
});

test("abort sends turn/interrupt and reports aborted once the server confirms; the daemon survives", async () => {
  let child!: FakeChild;
  const daemon = new CodexDaemon({
    spawn: () =>
      (child = fakeChild((req) => {
        const h = handshake(req);
        if (h) return h;
        if (req.method === "turn/interrupt") return [JSON.stringify({ id: 0, result: {} }), completed("interrupted")];
        return [];
      })),
  });
  const ac = new AbortController();
  const p = collect(codexTurn(daemon, { ...opts, signal: ac.signal }));
  await new Promise((r) => setTimeout(r, 50));
  ac.abort();
  const events = await p;
  const last = events.at(-1) as any;
  assert.equal(last.type, "error");
  assert.equal(last.kind, "aborted");
  assert.ok(child.requests.some((r) => r.method === "turn/interrupt" && r.params.turnId === TURN));
  assert.equal(daemon.alive, true);
  daemon.shutdown();
});

test("an interrupt the server never acknowledges kills the daemon (stuck turn) and still reports aborted", async () => {
  let child!: FakeChild;
  const daemon = new CodexDaemon({
    interruptGraceMs: 100,
    spawn: () =>
      (child = fakeChild((req) => {
        const h = handshake(req);
        if (h) return h;
        return "silence";
      })),
  });
  const ac = new AbortController();
  const p = collect(codexTurn(daemon, { ...opts, signal: ac.signal }));
  await new Promise((r) => setTimeout(r, 50));
  ac.abort();
  const events = await p;
  const last = events.at(-1) as any;
  assert.equal(last.kind, "aborted");
  assert.equal(child.closed, true);
  assert.equal(daemon.alive, false);
});

test("classifyTurnError: the typed codexErrorInfo decides before the message regex", () => {
  assert.equal(classifyTurnError({ message: "You have hit your usage limit", codexErrorInfo: "usageLimitExceeded" }).kind, "rate_limit");
  assert.equal(classifyTurnError({ message: "boom", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 502 } } }).kind, "exit");
  assert.equal(classifyTurnError({ message: "HTTP 429 Too Many Requests" }).kind, "rate_limit");
  assert.equal(classifyTurnError(null).message, "codex turn failed");
});

test("a failed turn status surfaces the turn error", async () => {
  let child!: FakeChild;
  const daemon = new CodexDaemon({
    spawn: () =>
      (child = fakeChild((req) => {
        const h = handshake(req);
        if (h) return h;
        return [];
      })),
  });
  const p = collect(codexTurn(daemon, opts));
  await new Promise((r) => setTimeout(r, 50));
  child.emit(completed("failed", { message: "usage limit reached", codexErrorInfo: "usageLimitExceeded" }));
  const events = await p;
  const last = events.at(-1) as any;
  assert.equal(last.type, "error");
  assert.equal(last.kind, "rate_limit");
  assert.equal(last.message, "usage limit reached");
  daemon.shutdown();
});

test("a spawn that throws is a spawn failure, not a rejection", async () => {
  const daemon = new CodexDaemon({
    spawn: () => {
      throw new Error("bwrap not found");
    },
  });
  const events = await collect(codexTurn(daemon, opts));
  assert.equal(events.length, 1);
  assert.equal((events[0] as any).kind, "spawn");
  assert.match((events[0] as any).message, /bwrap not found/);
});
