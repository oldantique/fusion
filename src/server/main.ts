/** HTTP server: static UI, auth, REST for conversations, SSE for live fusion turns. */
import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { streamSSE } from "hono/streaming";
import { config } from "../config.ts"; // loads .env itself, before anything reads process.env
import { Store } from "../store/db.ts";
import { Jobs, ConflictError } from "./jobs.ts";
import { ALL_PROVIDERS, PROVIDER_LABELS, PROVIDER_CUTOFFS, type ProviderId } from "../types.ts";
import { providers } from "../providers/index.ts";
import { clearSession, issueSession, passwordMatches, requireAuth, isAuthenticated } from "./auth.ts";

// Relative paths (static root, anything a library resolves against cwd) must not depend on where
// the process was launched from; children get an explicit cwd of their own.
process.chdir(config.root);

if (!config.password || !config.cookieSecret) {
  console.error("FUSION_PASSWORD and FUSION_COOKIE_SECRET must be set (see .env.example).");
  process.exit(1);
}
fs.mkdirSync(config.sandboxDir, { recursive: true });

const store = new Store();
store.failStaleTurns();
const jobs = new Jobs(store);

const app = new Hono();

// ---- auth ----
app.post("/api/login", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.password !== "string" || !passwordMatches(body.password)) {
    await new Promise((r) => setTimeout(r, 500)); // slow down guessing
    return c.json({ error: "wrong password" }, 401);
  }
  issueSession(c);
  return c.json({ ok: true });
});
app.post("/api/logout", (c) => {
  clearSession(c);
  return c.json({ ok: true });
});
app.get("/api/me", (c) => c.json({ authenticated: isAuthenticated(c) }));

app.use("/api/*", requireAuth);

// ---- meta ----
app.get("/api/providers", (c) =>
  c.json(
    ALL_PROVIDERS.map((id) => ({
      id,
      label: PROVIDER_LABELS[id],
      model: config.models[id],
      streams: providers[id].streams,
      cutoff: PROVIDER_CUTOFFS[id],
    })),
  ),
);
app.get("/api/health", (c) => c.json({ ok: true, effort: config.effort, synthEffort: config.synthEffort, laneTimeoutSec: config.laneTimeoutMs / 1000 }));

// ---- conversations ----
app.get("/api/conversations", (c) => c.json(store.listConversations()));
app.post("/api/conversations", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : "New conversation";
  return c.json(store.createConversation(title), 201);
});
app.get("/api/conversations/:id", (c) => {
  const conv = store.getConversation(c.req.param("id"));
  if (!conv) return c.json({ error: "not found" }, 404);
  return c.json({ ...conv, turns: store.listTurns(conv.id) });
});
app.patch("/api/conversations/:id", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.title !== "string" || !body.title.trim()) return c.json({ error: "title required" }, 400);
  store.renameConversation(c.req.param("id"), body.title.trim());
  return c.json({ ok: true });
});
app.delete("/api/conversations/:id", (c) => {
  const id = c.req.param("id");
  const active = jobs.activeFor(id);
  if (active) return c.json({ error: "turn in progress — stop it first", turnId: active }, 409);
  store.deleteConversation(id);
  return c.json({ ok: true });
});

// ---- ask ----
app.post("/api/conversations/:id/ask", async (c) => {
  const conv = store.getConversation(c.req.param("id"));
  if (!conv) return c.json({ error: "not found" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) return c.json({ error: "question required" }, 400);
  const ids = (Array.isArray(body.providers) ? body.providers : ALL_PROVIDERS).filter((p: unknown): p is ProviderId =>
    (ALL_PROVIDERS as readonly string[]).includes(p as string),
  );
  if (ids.length === 0) return c.json({ error: "select at least one provider" }, 400);
  if (jobs.activeFor(conv.id)) return c.json({ error: "turn in progress", turnId: jobs.activeFor(conv.id) }, 409);
  if (conv.turn_count === 0 && conv.title === "New conversation") store.renameConversation(conv.id, question.slice(0, 80));
  try {
    const turnId = jobs.start(conv.id, question, ids);
    return c.json({ turnId }, 202);
  } catch (e) {
    if (e instanceof ConflictError) return c.json({ error: "turn in progress", turnId: e.turnId }, 409);
    throw e;
  }
});

app.get("/api/turns/:id", (c) => {
  const t = store.getTurn(c.req.param("id"));
  if (!t) return c.json({ error: "not found" }, 404);
  return c.json({ ...t, running: jobs.isRunning(t.id) });
});

app.post("/api/turns/:id/cancel", (c) => c.json({ cancelled: jobs.cancel(c.req.param("id")) }));

app.get("/api/turns/:id/events", (c) => {
  const turnId = c.req.param("id");
  const turn = store.getTurn(turnId);
  if (!turn) return c.json({ error: "not found" }, 404);
  // EventSource sends Last-Event-ID on reconnect; replay resumes after it instead of from scratch.
  const afterSeq = Number.parseInt(c.req.header("last-event-id") ?? "0", 10) || 0;
  return streamSSE(c, async (stream) => {
    let finish!: () => void;
    const finished = new Promise<void>((r) => (finish = r));
    // Writes are serialized and a failed write ends the stream, instead of fire-and-forget.
    let chain = Promise.resolve();
    const write = (msg: { event: string; data: string; id?: string }) => {
      chain = chain.then(() => stream.writeSSE(msg)).catch(() => finish());
    };
    const unsubscribe = jobs.subscribe(
      turnId,
      ({ seq, ev }) => {
        write({ id: String(seq), event: ev.type, data: JSON.stringify(ev) });
        if (ev.type === "finished" || ev.type === "fatal") finish();
      },
      afterSeq,
    );
    if (unsubscribe === null) {
      // Job already evicted from memory: send the persisted final state.
      await stream.writeSSE({ event: "finished", data: JSON.stringify({ type: "finished", answer: turn.answer, persisted: true }) });
      return;
    }
    stream.onAbort(() => {
      unsubscribe();
      finish();
    });
    const ping = setInterval(() => write({ event: "ping", data: "" }), 15_000);
    await finished;
    clearInterval(ping);
    unsubscribe();
    await chain; // flush the terminal event before closing
  });
});

// ---- static UI (web/vendor/bundle.js is produced by `npm run build:vendor`) ----
app.use("/*", serveStatic({ root: path.relative(process.cwd(), config.webDir) }));

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`fusion listening on http://${info.address}:${info.port}`);
});

let shuttingDown = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${sig}: shutting down`);
    server.close();
    jobs.abortAll();
    // Let aborted lanes kill their children and record 'cancelled' before the process goes away;
    // failStaleTurns() on the next start covers anything that did not make it.
    const clean = await jobs.drain(5_000);
    if (!clean) console.warn("shutdown: some turns did not finish within the grace period");
    store.close();
    process.exit(0);
  });
}
