import { marked, markedFootnote, DOMPurify, hljs, katex } from "/vendor/bundle.js";
import { splitMath, restoreMath } from "./math.js";

// ---------- markdown ----------
marked.setOptions({ gfm: true, breaks: false });
marked.use(markedFootnote());
const renderTex = (tex, displayMode) =>
  katex.renderToString(tex, { displayMode, throwOnError: false, output: "html" });
function render(md) {
  // Math is lifted out before marked (which would eat the backslashes and underscores) and put
  // back after DOMPurify — the markup that skips the sanitizer is only ever KaTeX's own output
  // for the extracted TeX, and `throwOnError: false` makes bad TeX render as red text.
  const { text, blocks } = splitMath(md ?? "");
  const html = DOMPurify.sanitize(marked.parse(text), { USE_PROFILES: { html: true } });
  return restoreMath(html, blocks, renderTex);
}
/**
 * The Markdown a rendered `.md` container was built from — what the Copy button hands over.
 * Copying the rendered HTML instead would give the reader KaTeX spans and highlighter markup;
 * what they want back is the source they could paste into another chat.
 */
const mdSource = new WeakMap();

/**
 * @param {Element} el
 * @param {string} md
 * @param {boolean} final whether `md` is the complete text (as opposed to a streaming prefix);
 *   only then is it worth handing diagrams to mermaid, which cannot parse a half-arrived fence.
 */
function setMarkdown(el, md, final = false) {
  mdSource.set(el, md ?? "");
  el.closest(".fused, .lane")?.querySelector(".copy-md")?.classList.toggle("hidden", !md);
  el.innerHTML = render(md);
  el.querySelectorAll("pre code:not(.language-mermaid)").forEach((b) => {
    try { hljs.highlightElement(b); } catch {}
  });
  // Only links that leave the page get a new tab: a footnote's `#footnote-1` must stay here.
  el.querySelectorAll("a[href]").forEach((a) => {
    if (a.getAttribute("href").startsWith("#")) return;
    a.target = "_blank";
    a.rel = "noopener";
  });
  scopeFootnotes(el);
  enhanceCodeBlocks(el);
  if (final) renderDiagrams(el);
}

/**
 * Give every fenced block the header ChatGPT has: the language on the left, a Copy button on the
 * right. Answers are re-rendered from scratch on every delta, so this runs inside setMarkdown
 * rather than once at mount — and the click itself is delegated from `#turns`, so the buttons a
 * re-render throws away never leave a listener behind. The language is read *after* highlighting
 * because hljs is what labels an unfenced block it auto-detected.
 */
function enhanceCodeBlocks(el) {
  el.querySelectorAll("pre > code").forEach((code) => {
    const pre = code.parentElement;
    if (pre.parentElement?.classList.contains("code-block")) return;
    const box = document.createElement("div");
    box.className = "code-block";
    const head = document.createElement("div");
    head.className = "code-head";
    const lang = document.createElement("span");
    lang.className = "code-lang";
    lang.textContent = /\blanguage-([\w+#-]+)/.exec(code.className)?.[1] ?? "";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "code-copy";
    copy.textContent = "Copy";
    copy.title = "Copy code";
    head.append(lang, copy);
    pre.replaceWith(box);
    box.append(head, pre);
  });
}

/**
 * Footnote ids are generated per answer ("footnote-1"), so a page holding a dozen turns would
 * have a dozen of each and every backlink would jump to the oldest one. Suffix them with a
 * number owned by this container so each answer's footnotes point inside itself.
 */
let mdScopeSeq = 0;
function scopeFootnotes(el) {
  if (!el.querySelector(".footnotes")) return;
  const n = (el.dataset.mdScope ||= String(++mdScopeSeq));
  for (const e of el.querySelectorAll("[id^='footnote']")) e.id = `${e.id}-${n}`;
  for (const a of el.querySelectorAll("a[href^='#footnote']")) a.setAttribute("href", `${a.getAttribute("href")}-${n}`);
  for (const e of el.querySelectorAll("[aria-describedby^='footnote']")) e.setAttribute("aria-describedby", `${e.getAttribute("aria-describedby")}-${n}`);
}

/** Copy `text` and say so on the button for a moment. */
const copyTimers = new WeakMap();
async function copyFrom(btn, text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    return; // no clipboard permission (or an insecure origin): leave the button alone
  }
  const label = btn.dataset.label ?? btn.textContent;
  btn.dataset.label = label;
  btn.textContent = "Copied";
  btn.classList.add("done");
  clearTimeout(copyTimers.get(btn));
  copyTimers.set(btn, setTimeout(() => { btn.textContent = label; btn.classList.remove("done"); }, 1500));
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
    set(t) { text = t; setMarkdown(el, text, true); },
    get text() { return text; },
  };
}

// ---------- mermaid ----------
/**
 * Diagrams are drawn only for *finished* text. During streaming every delta re-renders the
 * answer, and a fence that has only half arrived is a parse error, so attempting it per delta
 * would mean a diagram that flickers between an error and a picture for as long as the model is
 * writing. Waiting for the lane (or the synthesizer) to finish costs nothing visually — the code
 * is on screen the whole time — and one pass also covers turns painted from the database on
 * reload, which take the same `set()` path.
 */
let mermaidReady = null;
function loadMermaid() {
  // ~7x the size of everything else in web/vendor put together, and most answers have no
  // diagram: it is a separate bundle, fetched the first time one appears and then cached.
  mermaidReady ??= import("/vendor/mermaid.js").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      // DOMPurify's SVG profile has no <foreignObject>, and widening it would let arbitrary
      // HTML back into an answer we just sanitized. `htmlLabels: false` makes mermaid lay out
      // labels with <text>, which the strict profile keeps — so the profile can stay strict.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      theme: window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default",
    });
    return mermaid;
  });
  return mermaidReady;
}

let diagramSeq = 0;
async function renderDiagrams(root) {
  const blocks = [...root.querySelectorAll("pre > code.language-mermaid")];
  if (blocks.length === 0) return;
  let mermaid;
  try {
    mermaid = await loadMermaid();
  } catch {
    return; // bundle missing: the fence stays a readable code block
  }
  for (const code of blocks) {
    const box = code.closest(".code-block");
    if (!box || !box.isConnected) continue; // a later render already replaced this subtree
    let svg;
    try {
      ({ svg } = await mermaid.render(`mermaid-${++diagramSeq}`, code.textContent));
    } catch {
      // A syntax error must leave the source on screen — never a blank space where a picture was.
      box.querySelector(".code-lang").textContent = "mermaid · could not be drawn";
      continue;
    }
    if (!box.isConnected) continue;
    const fig = document.createElement("div");
    fig.className = "mermaid-svg";
    fig.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "mermaid-toggle";
    toggle.textContent = "Code";
    box.classList.add("mermaid-block");
    box.querySelector(".code-head").insertBefore(toggle, box.querySelector(".code-copy"));
    box.append(fig);
  }
}

// ---------- api ----------
async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...opts });
  if (res.status === 401 && path !== "/api/login") { showLogin(); throw new Error("Session expired — please sign in again"); }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

// ---------- state ----------
const $ = (s) => document.querySelector(s);
const state = { providers: [], conversations: [], current: null, busy: false, followingTurnId: null, cutoffsLine: "" };
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
      try {
        await api(`/api/conversations/${c.id}`, { method: "DELETE" });
      } catch (err) {
        $("#composer-note").textContent = err.message;
        return;
      }
      if (state.current?.id === c.id) { state.current = null; $("#turns").innerHTML = ""; $("#conv-title").textContent = "Fusion"; showEmpty("Conversation deleted. Ask something to start a new one."); }
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
  if (conv.turns.length === 0) showEmpty("Ask a question below — it goes to every selected model at once.");
  for (const t of conv.turns) {
    const view = mountTurn(t.question, t.providers);
    if (t.status === "running") {
      setBusy(true);
      followTurn(t.id, view).finally(() => { setBusy(false); loadConversations(); });
    } else {
      paintFinishedTurn(view, t);
    }
  }
  box.scrollTop = box.scrollHeight;
  if (window.matchMedia("(max-width: 760px)").matches) setSidebar(false);
}

function showEmpty(msg) {
  const d = document.createElement("div");
  d.className = "empty";
  d.textContent = msg;
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = `All models answer offline — no web search or browsing — so nothing from the live web is mixed into the answers. Each one knows the world only up to its training cutoff: ${state.cutoffsLine ?? ""}`;
  d.append(hint);
  $("#turns").append(d);
}
function setBusy(b) {
  state.busy = b;
  $("#send").disabled = b;
  $("#stop").classList.toggle("hidden", !b);
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
    cb.addEventListener("change", () => { localStorage.setItem(PICK_KEY, JSON.stringify(pickedProviders())); $("#composer-note").textContent = ""; });
    label.append(cb, document.createTextNode(` ${p.label}`));
    label.title = p.model + (p.streams ? " · streams" : "") + (p.cutoff ? ` · knowledge up to ${p.cutoff}` : " · knowledge cutoff not published");
    box.append(label);
  }
  state.cutoffsLine = state.providers.map((p) => `${p.label} ${p.cutoff ?? "(not published)"}`).join(" · ") + ".";
}
function pickedProviders() {
  return [...document.querySelectorAll("#provider-picks input:checked")].map((i) => i.value);
}

// ---------- turns ----------
function labelOf(id) { return state.providers.find((p) => p.id === id)?.label ?? id; }

// One delegated handler for every copy button in the transcript: the ones inside answers are
// recreated on every streamed delta, so they must not own their own listeners.
$("#turns").addEventListener("click", (e) => {
  const btn = e.target.closest?.("button");
  if (!btn) return;
  if (btn.classList.contains("code-copy")) {
    copyFrom(btn, btn.closest(".code-block")?.querySelector("code")?.textContent ?? "");
  } else if (btn.classList.contains("mermaid-toggle")) {
    const box = btn.closest(".code-block");
    btn.textContent = box.classList.toggle("show-source") ? "Diagram" : "Code";
  } else if (btn.classList.contains("copy-md")) {
    // A lane's button sits inside its <summary>: without this the copy would also collapse
    // the very answer it just copied.
    e.preventDefault();
    e.stopPropagation();
    copyFrom(btn, mdSource.get(btn.closest(".fused, .lane")?.querySelector(".md")) ?? "");
  }
});

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
  $("#turns").querySelector(".empty")?.remove();
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

function badge(el, text, cls) { el.textContent = text; el.className = el.className.replace(/\b(ok|bad|run|warn)\b/g, "").trim() + (cls ? ` ${cls}` : ""); }
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

function startLaneClock(lane, at) {
  lane.startedAt = at || Date.now();
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
    // Kinds the user can act on get their own wording; everything else is a plain failure.
    const [text, cls] =
      r.errorKind === "aborted" ? ["stopped", ""]
      : r.errorKind === "rate_limit" ? ["rate limited", "warn"]
      : r.errorKind === "timeout" ? ["timed out", "bad"]
      : ["failed", "bad"];
    badge(lane.status, text, cls);
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
  // The synthesizer is told to write "candidate X"; only that phrase (and a letter list after it,
  // "candidates B, C and D") is de-anonymized, so a bare "B" in ordinary prose (vitamin B, plan B)
  // is left alone. "候选" is accepted too: models sometimes translate the token despite the prompt.
  const one = (l) => (letterMap?.[l] ? `<span class="letter" title="Candidate ${l}">${esc(labelOf(letterMap[l]))}</span>` : l);
  const deanon = (s) =>
    esc(s).replace(/(\b[Cc]andidates?|候选)\s*([A-H](?:\s*(?:[、,，/&]|and|和)\s*[A-H])*)(?![A-Za-z])/g, (m, word, letters) =>
      `${word} ${letters.replace(/[A-H]/g, one)}`);
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
    else if (t.answer_provider && t.lanes.filter((l) => l.status === "done").length > 1) badge(view.synthBadge, `Unfused: ${labelOf(t.answer_provider)}`, "warn");
    else badge(view.synthBadge, "Single answer", "ok");
    paintAnalysis(view, t.analysis, t.letter_map);
  } else if (t.status === "cancelled") {
    badge(view.synthBadge, "Stopped", "");
  } else {
    badge(view.synthBadge, "Failed", "bad");
    view.synthMeta.textContent = t.error || "";
  }
  if (t.history_omitted > 0) view.synthMeta.textContent += ` · earliest ${t.history_omitted} turn(s) omitted from context`;
}

function followTurn(turnId, view) {
  return new Promise((resolve) => {
    // On a dropped connection EventSource reconnects with Last-Event-ID and the server resumes
    // after it, so appending deltas here is safe across reconnects.
    const es = new EventSource(`/api/turns/${turnId}/events`);
    const box = $("#turns");
    const nearBottom = () => box.scrollHeight - box.scrollTop - box.clientHeight < 160;
    let stick = true;
    const onScroll = () => { stick = nearBottom(); };
    box.addEventListener("scroll", onScroll, { passive: true });
    const keep = () => { if (stick) box.scrollTop = box.scrollHeight; };
    let lastError = "";
    let terminal = false; // a cancelled/fatal/failed badge was already painted
    state.followingTurnId = turnId;
    const finish = () => {
      es.close();
      box.removeEventListener("scroll", onScroll);
      view.answerEl.classList.remove("cursor");
      for (const lane of Object.values(view.lanes)) clearInterval(lane.timer);
      if (state.followingTurnId === turnId) state.followingTurnId = null;
      resolve();
    };
    badge(view.synthBadge, "Waiting for models…", "run");

    es.addEventListener("lane", (e) => {
      const ev = JSON.parse(e.data);
      const lane = view.lanes[ev.provider];
      if (!lane) return;
      if (ev.status === "queued") badge(lane.status, "queued", "");
      else if (ev.status === "running") { badge(lane.status, ev.attempt > 1 ? `retrying` : "running", "run"); startLaneClock(lane, ev.at); if (ev.attempt > 1) lane.body.set(""); }
      else if (ev.status === "delta") lane.body.append(ev.text);
      else paintLaneResult(lane, ev.result);
      keep();
    });
    es.addEventListener("synth", (e) => {
      const ev = JSON.parse(e.data);
      if (ev.status === "start") { view.answer.set(""); badge(view.synthBadge, `${ev.retry ? "Retry: " : ev.fallback ? "Fallback: " : ""}Fusing with ${labelOf(ev.provider)}…`, "run"); view.answerEl.classList.add("cursor"); }
      else if (ev.status === "delta") { view.answer.append(ev.text); }
      else if (ev.status === "done") { view.answer.set(ev.result.answer); badge(view.synthBadge, `Fused by ${labelOf(ev.result.provider)}`, "ok"); view.synthMeta.textContent = secs(ev.result.ms); paintAnalysis(view, ev.result.analysis, ev.result.letterMap); view.answerEl.classList.remove("cursor"); }
      else if (ev.status === "skipped") {
        view.answerEl.classList.remove("cursor");
        if (ev.reason === "all lanes failed") { badge(view.synthBadge, "Failed", "bad"); terminal = true; }
        else if (ev.reason === "synthesis failed") { view.answer.set(""); badge(view.synthBadge, `Unfused: ${labelOf(ev.provider)}`, "warn"); view.synthMeta.textContent = "every synthesizer failed; showing one model's answer"; }
        else badge(view.synthBadge, "Single answer", "ok");
      }
      keep();
    });
    es.addEventListener("history", (e) => {
      const ev = JSON.parse(e.data);
      if (ev.omitted > 0) view.synthMeta.textContent = `earliest ${ev.omitted} turn(s) omitted from context`;
    });
    es.addEventListener("error", (e) => {
      if (e.data) { const ev = JSON.parse(e.data); lastError = ev.message; $("#composer-note").textContent = ev.message; }
    });
    es.addEventListener("cancelled", () => { terminal = true; badge(view.synthBadge, "Stopped", ""); view.synthMeta.textContent = ""; view.answer.set(""); });
    es.addEventListener("finished", (e) => {
      const ev = JSON.parse(e.data);
      if (ev.answer && !view.answer.text) view.answer.set(ev.answer);
      if (ev.persisted) api(`/api/turns/${turnId}`).then((t) => paintFinishedTurn(view, t));
      else if (!ev.answer && !terminal) { badge(view.synthBadge, "Failed", "bad"); view.synthMeta.textContent = lastError; view.answer.set(""); }
      finish();
    });
    es.addEventListener("fatal", (e) => { const ev = JSON.parse(e.data); terminal = true; badge(view.synthBadge, "Failed", "bad"); view.synthMeta.textContent = ev.message; finish(); });
    es.onerror = () => { /* EventSource auto-reconnects with Last-Event-ID; the server resumes from there */ };
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
  setBusy(true);
  $("#composer-note").textContent = "";
  let turnId;
  try {
    ({ turnId } = await api(`/api/conversations/${state.current.id}/ask`, { method: "POST", body: JSON.stringify({ question: q, providers }) }));
  } catch (err) {
    // Refused (e.g. a turn is still running here): keep the text so nothing is lost.
    $("#composer-note").textContent = err.message;
    setBusy(false);
    return;
  }
  $("#question").value = "";
  const view = mountTurn(q, providers);
  $("#turns").scrollTop = $("#turns").scrollHeight;
  try {
    await loadConversations();
    const conv = state.conversations.find((c) => c.id === state.current.id);
    if (conv) $("#conv-title").textContent = conv.title;
    await followTurn(turnId, view);
  } catch (err) {
    badge(view.synthBadge, "Failed", "bad");
    view.synthMeta.textContent = err.message;
  } finally {
    setBusy(false);
    await loadConversations();
    $("#question").focus();
  }
}
$("#send").addEventListener("click", ask);
$("#stop").addEventListener("click", async () => {
  if (!state.followingTurnId) return;
  $("#stop").disabled = true;
  try { await api(`/api/turns/${state.followingTurnId}/cancel`, { method: "POST" }); } catch (err) { $("#composer-note").textContent = err.message; }
  finally { $("#stop").disabled = false; }
});
$("#question").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(); }
});

// ---------- boot ----------
async function boot() {
  const me = await fetch("/api/me").then((r) => r.json());
  if (!me.authenticated) { showLogin(); return; }
  showApp();
  if (window.matchMedia("(max-width: 760px)").matches) setSidebar(false);
  state.providers = await api("/api/providers");
  renderPicks();
  await loadConversations();
  if (state.conversations[0]) await openConversation(state.conversations[0].id);
  else showEmpty("Ask a question below — it goes to every selected model at once.");
  $("#question").focus();
}
boot();
