import { marked, DOMPurify, hljs } from "/vendor/bundle.js";

// ---------- markdown ----------
marked.setOptions({ gfm: true, breaks: false });
function render(md) {
  const html = marked.parse(md ?? "");
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}
function setMarkdown(el, md) {
  el.innerHTML = render(md);
  el.querySelectorAll("pre code").forEach((b) => {
    try { hljs.highlightElement(b); } catch {}
  });
  el.querySelectorAll("a").forEach((a) => { a.target = "_blank"; a.rel = "noopener"; });
}
/** Throttled markdown re-render for streaming text. */
function streamer(el) {
  let text = "";
  let scheduled = false;
  return {
    append(t) {
      text += t;
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => { scheduled = false; setMarkdown(el, text); });
    },
    set(t) { text = t; setMarkdown(el, text); },
    get text() { return text; },
  };
}

// ---------- api ----------
async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...opts });
  if (res.status === 401) { showLogin(); throw new Error("unauthorized"); }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

// ---------- state ----------
const $ = (s) => document.querySelector(s);
const state = { providers: [], conversations: [], current: null, busy: false };
const PICK_KEY = "fusion.providers";

// ---------- login ----------
function showLogin() { $("#login").classList.remove("hidden"); $("#app").classList.add("hidden"); }
function showApp() { $("#login").classList.add("hidden"); $("#app").classList.remove("hidden"); }
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#login-error").textContent = "";
  try {
    await api("/api/login", { method: "POST", body: JSON.stringify({ password: $("#password").value }) });
    $("#password").value = "";
    await boot();
  } catch (err) { $("#login-error").textContent = err.message; }
});
$("#logout").addEventListener("click", async () => { await api("/api/logout", { method: "POST" }); showLogin(); });

// ---------- sidebar ----------
$("#toggle-sidebar").addEventListener("click", () => setSidebar(false));
$("#show-sidebar").addEventListener("click", () => setSidebar(true));
function setSidebar(open) {
  $("#app").classList.toggle("collapsed", !open);
  $("#show-sidebar").classList.toggle("hidden", open);
}
$("#new-conv").addEventListener("click", async () => {
  const conv = await api("/api/conversations", { method: "POST", body: JSON.stringify({}) });
  await loadConversations();
  await openConversation(conv.id);
  $("#question").focus();
});

async function loadConversations() {
  state.conversations = await api("/api/conversations");
  const ul = $("#conv-list");
  ul.innerHTML = "";
  for (const c of state.conversations) {
    const li = document.createElement("li");
    li.dataset.id = c.id;
    li.classList.toggle("active", state.current?.id === c.id);
    const t = document.createElement("span");
    t.className = "title";
    t.textContent = c.title;
    t.title = c.title;
    const n = document.createElement("span");
    n.className = "meta";
    n.textContent = c.turn_count;
    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "✕";
    del.title = "Delete conversation";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${c.title}"?`)) return;
      await api(`/api/conversations/${c.id}`, { method: "DELETE" });
      if (state.current?.id === c.id) { state.current = null; $("#turns").innerHTML = ""; $("#conv-title").textContent = "Fusion"; }
      await loadConversations();
    });
    li.append(t, n, del);
    li.addEventListener("click", () => openConversation(c.id));
    ul.append(li);
  }
}

async function openConversation(id) {
  const conv = await api(`/api/conversations/${id}`);
  state.current = conv;
  $("#conv-title").textContent = conv.title;
  document.querySelectorAll("#conv-list li").forEach((li) => li.classList.toggle("active", li.dataset.id === id));
  const box = $("#turns");
  box.innerHTML = "";
  for (const t of conv.turns) {
    const view = mountTurn(t.question, t.providers);
    if (t.status === "running") {
      followTurn(t.id, view);
    } else {
      paintFinishedTurn(view, t);
    }
  }
  box.scrollTop = box.scrollHeight;
  if (window.matchMedia("(max-width: 760px)").matches) setSidebar(false);
}

// ---------- provider picker ----------
function renderPicks() {
  const saved = JSON.parse(localStorage.getItem(PICK_KEY) || "null");
  const box = $("#provider-picks");
  box.innerHTML = "";
  for (const p of state.providers) {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = p.id;
    cb.checked = saved ? saved.includes(p.id) : true;
    cb.addEventListener("change", () => localStorage.setItem(PICK_KEY, JSON.stringify(pickedProviders())));
    label.append(cb, document.createTextNode(` ${p.label}`));
    label.title = p.model + (p.streams ? " · streams" : "");
    box.append(label);
  }
}
function pickedProviders() {
  return [...document.querySelectorAll("#provider-picks input:checked")].map((i) => i.value);
}

// ---------- turns ----------
function labelOf(id) { return state.providers.find((p) => p.id === id)?.label ?? id; }

function mountTurn(question, providerIds) {
  const node = $("#turn-tpl").content.firstElementChild.cloneNode(true);
  node.querySelector(".q").textContent = question;
  const lanes = {};
  const lanesBox = node.querySelector(".lanes");
  for (const id of providerIds) {
    const ln = $("#lane-tpl").content.firstElementChild.cloneNode(true);
    ln.querySelector(".lane-name").textContent = labelOf(id);
    lanesBox.append(ln);
    lanes[id] = { el: ln, status: ln.querySelector(".lane-status"), meta: ln.querySelector(".lane-meta"), body: streamer(ln.querySelector(".lane-body")), startedAt: null, timer: null };
  }
  $("#turns").append(node);
  const view = {
    el: node,
    synthBadge: node.querySelector(".synth-badge"),
    synthMeta: node.querySelector(".synth-meta"),
    answer: streamer(node.querySelector(".answer")),
    answerEl: node.querySelector(".answer"),
    analysis: node.querySelector(".analysis"),
    analysisBody: node.querySelector(".analysis-body"),
    lanes,
    letterMap: null,
  };
  return view;
}

function badge(el, text, cls) { el.textContent = text; el.className = el.className.replace(/\b(ok|bad|run)\b/g, "").trim() + (cls ? ` ${cls}` : ""); }
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

function startLaneClock(lane) {
  lane.startedAt = Date.now();
  clearInterval(lane.timer);
  lane.timer = setInterval(() => { lane.meta.textContent = secs(Date.now() - lane.startedAt); }, 250);
}
function stopLaneClock(lane, ms) { clearInterval(lane.timer); lane.meta.textContent = ms != null ? secs(ms) : ""; }

function paintLaneResult(lane, r) {
  stopLaneClock(lane, r.ms);
  if (r.status === "done") {
    badge(lane.status, `done${r.attempts > 1 ? ` (retry)` : ""}`, "ok");
    lane.body.set(r.answer || "");
  } else {
    badge(lane.status, "failed", "bad");
    lane.body.set("");
    const e = document.createElement("div");
    e.className = "error-text";
    e.textContent = r.error || "unknown error";
    lane.el.querySelector(".lane-body").append(e);
  }
}

function paintAnalysis(view, analysis, letterMap) {
  if (!analysis) return;
  const name = (letter) => letterMap?.[letter] ? `${labelOf(letterMap[letter])}` : letter;
  const section = (title, items, fmt = (s) => s) => {
    if (!items?.length) return "";
    return `<h4>${title}</h4><ul>${items.map((i) => `<li>${fmt(i)}</li>`).join("")}</ul>`;
  };
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  // Replace candidate letters ("A", "B"...) in prose with model names where a map exists.
  const deanon = (s) => esc(s).replace(/\b([A-H])\b/g, (m, l) => (letterMap?.[l] ? `<span class="letter" title="Candidate ${l}">${esc(labelOf(letterMap[l]))}</span>` : m));
  view.analysisBody.innerHTML =
    section("Consensus", analysis.consensus, deanon) +
    section("Contradictions", analysis.contradictions, deanon) +
    section("Unique insights", analysis.unique_insights, (u) => `<span class="letter">${esc(name(u.answer))}</span>: ${esc(u.point)}`) +
    section("Gaps in all answers", analysis.gaps, deanon);
  view.analysis.classList.toggle("hidden", view.analysisBody.innerHTML === "");
  if (letterMap) {
    for (const [letter, pid] of Object.entries(letterMap)) {
      const lane = view.lanes[pid];
      if (lane) lane.el.querySelector(".lane-name").textContent = `${labelOf(pid)} · ${letter}`;
    }
  }
}

function paintFinishedTurn(view, t) {
  for (const r of t.lanes) if (view.lanes[r.provider]) paintLaneResult(view.lanes[r.provider], r);
  for (const id of Object.keys(view.lanes)) if (!t.lanes.some((l) => l.provider === id)) { badge(view.lanes[id].status, "skipped", ""); }
  if (t.status === "done") {
    view.answer.set(t.answer || "");
    if (t.synth_provider) { badge(view.synthBadge, `Fused by ${labelOf(t.synth_provider)}`, "ok"); view.synthMeta.textContent = t.synth_ms ? secs(t.synth_ms) : ""; }
    else badge(view.synthBadge, "Single answer", "ok");
    paintAnalysis(view, t.analysis, t.letter_map);
  } else {
    badge(view.synthBadge, "Failed", "bad");
    view.synthMeta.textContent = t.error || "";
  }
  if (t.history_omitted > 0) view.synthMeta.textContent += ` · earliest ${t.history_omitted} turn(s) omitted from context`;
}

function followTurn(turnId, view) {
  return new Promise((resolve) => {
    const es = new EventSource(`/api/turns/${turnId}/events`);
    const box = $("#turns");
    const nearBottom = () => box.scrollHeight - box.scrollTop - box.clientHeight < 160;
    let stick = true;
    box.addEventListener("scroll", () => { stick = nearBottom(); }, { passive: true });
    const keep = () => { if (stick) box.scrollTop = box.scrollHeight; };
    const finish = () => { es.close(); view.answerEl.classList.remove("cursor"); resolve(); };
    badge(view.synthBadge, "Waiting for models…", "run");

    es.addEventListener("lane", (e) => {
      const ev = JSON.parse(e.data);
      const lane = view.lanes[ev.provider];
      if (!lane) return;
      if (ev.status === "queued") badge(lane.status, "queued", "");
      else if (ev.status === "running") { badge(lane.status, ev.attempt > 1 ? `retrying` : "running", "run"); startLaneClock(lane); }
      else if (ev.status === "delta") lane.body.append(ev.text);
      else paintLaneResult(lane, ev.result);
      keep();
    });
    es.addEventListener("synth", (e) => {
      const ev = JSON.parse(e.data);
      if (ev.status === "start") { badge(view.synthBadge, `${ev.fallback ? "Fallback: " : ""}Fusing with ${labelOf(ev.provider)}…`, "run"); view.answerEl.classList.add("cursor"); }
      else if (ev.status === "delta") { view.answer.append(ev.text); }
      else if (ev.status === "done") { view.answer.set(ev.result.answer); badge(view.synthBadge, `Fused by ${labelOf(ev.result.provider)}`, "ok"); view.synthMeta.textContent = secs(ev.result.ms); paintAnalysis(view, ev.result.analysis, ev.result.letterMap); view.answerEl.classList.remove("cursor"); }
      else if (ev.status === "skipped") { badge(view.synthBadge, ev.reason === "all lanes failed" ? "Failed" : "Single answer", ev.reason === "all lanes failed" ? "bad" : "ok"); }
      keep();
    });
    es.addEventListener("history", (e) => {
      const ev = JSON.parse(e.data);
      if (ev.omitted > 0) view.synthMeta.textContent = `earliest ${ev.omitted} turn(s) omitted from context`;
    });
    es.addEventListener("error", (e) => {
      if (e.data) { const ev = JSON.parse(e.data); $("#composer-note").textContent = ev.message; }
    });
    es.addEventListener("finished", (e) => {
      const ev = JSON.parse(e.data);
      if (ev.answer && !view.answer.text) view.answer.set(ev.answer);
      if (ev.persisted) api(`/api/turns/${turnId}`).then((t) => paintFinishedTurn(view, t));
      finish();
    });
    es.addEventListener("fatal", (e) => { const ev = JSON.parse(e.data); badge(view.synthBadge, "Failed", "bad"); view.synthMeta.textContent = ev.message; finish(); });
    es.onerror = () => { /* EventSource auto-reconnects; the server replays buffered events */ };
  });
}

// ---------- composer ----------
async function ask() {
  const q = $("#question").value.trim();
  if (!q || state.busy) return;
  const providers = pickedProviders();
  if (providers.length === 0) { $("#composer-note").textContent = "Select at least one model."; return; }
  if (!state.current) {
    const conv = await api("/api/conversations", { method: "POST", body: JSON.stringify({}) });
    state.current = { ...conv, turns: [] };
  }
  state.busy = true;
  $("#send").disabled = true;
  $("#composer-note").textContent = "";
  $("#question").value = "";
  const view = mountTurn(q, providers);
  $("#turns").scrollTop = $("#turns").scrollHeight;
  try {
    const { turnId } = await api(`/api/conversations/${state.current.id}/ask`, { method: "POST", body: JSON.stringify({ question: q, providers }) });
    await loadConversations();
    await followTurn(turnId, view);
    const conv = state.conversations.find((c) => c.id === state.current.id);
    if (conv) $("#conv-title").textContent = conv.title;
  } catch (err) {
    badge(view.synthBadge, "Failed", "bad");
    view.synthMeta.textContent = err.message;
  } finally {
    state.busy = false;
    $("#send").disabled = false;
    await loadConversations();
    $("#question").focus();
  }
}
$("#send").addEventListener("click", ask);
$("#question").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(); }
});

// ---------- boot ----------
async function boot() {
  const me = await fetch("/api/me").then((r) => r.json());
  if (!me.authenticated) { showLogin(); return; }
  showApp();
  state.providers = await api("/api/providers");
  renderPicks();
  await loadConversations();
  if (state.conversations[0]) await openConversation(state.conversations[0].id);
  $("#question").focus();
}
boot();
