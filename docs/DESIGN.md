# Fusion — Design

Self-hosted "OpenRouter Fusion": one question fans out in parallel to four locally installed,
subscription-authenticated AI CLIs; a synthesizer merges the answers into a single markdown
response, shown in a local web UI with the raw answers available underneath.

Decisions below were settled in the 2026-08-20 design interview. Items marked *(v2)* are
explicitly deferred.

## 1. Scope

| Area | v1 | v2 |
|---|---|---|
| Conversation | Multi-turn, stateless replay (§4) | History summarization |
| Panel models | claude opus · gpt-5.6-sol · kimi k3 · grok-4.6, all at effort `high`, per-question checkboxes (≥1) | — |
| Synthesizer | Fixed: Claude Opus, effort high | Selectable synthesizer |
| Tools for models | All disabled | "Allow web search" toggle |
| UI | Final answer (streamed) on top; four raw answers collapsed below with status/latency; history sidebar | Per-lane retry button |
| Access | `0.0.0.0`, shared-password login → httpOnly cookie | — |
| Persistence | SQLite (`node:sqlite`, Node 22.23) in `data/` | — |
| Service | Manual `npm start`; systemd user unit provided | — |

## 2. Stack

Node 22 / TypeScript, single process. Hono for HTTP + SSE. Plain static frontend (no framework):
`marked` + `highlight.js` + DOMPurify for markdown rendering. No external network calls from the
server except spawning the CLIs.

## 3. Providers

Every provider is a subprocess spawned from an **empty sandbox dir** (`data/sandbox/`) so no
CLAUDE.md / AGENTS.md / skills leak into system prompts. Each call is bounded by a 300 s timeout,
retried once on empty output or non-zero exit, then marked `failed` and excluded from synthesis.

Two parser families:

- **Anthropic-Messages stream parser** — claude and grok (grok's `streaming-messages-json` is
  wire-compatible). Emits `text_delta`, completion = `type=="result" && !is_error`.
- **Whole-message parser** — codex (`item.completed` → `agent_message.text`) and kimi
  (`role=="assistant"` line). No deltas; UI shows a spinner until the block lands.

Verified invocations (from the research probe; fixtures in `fixtures/`):

```bash
# claude (panel + synthesizer). NEVER --bare (kills OAuth).
claude -p "$PROMPT" --model opus --effort high --tools "" \
  --system-prompt "$SYS" --setting-sources "" --disable-slash-commands \
  --no-session-persistence --output-format stream-json --include-partial-messages --verbose < /dev/null
# synthesizer adds: --json-schema "$SCHEMA"

# codex — must have < /dev/null. Keep default tool set (disabling breaks prompt cache).
codex exec --json --skip-git-repo-check --ephemeral -s read-only \
  -m gpt-5.6-sol -c model_reasoning_effort="high" "$PROMPT" < /dev/null 2>/dev/null

# kimi — effort is global config (k3 default already high)
kimi -m kimi-code/k3 --output-format stream-json -p "$PROMPT"

# grok — --deny is the only effective tool block; do NOT use --system-prompt-override
grok -p "$PROMPT" -m grok-4.6 --reasoning-effort high \
  --deny 'Write(**)' --deny 'Bash(**)' --deny 'Edit(**)' --disable-web-search --no-subagents \
  --output-format streaming-messages-json --include-partial-messages
```

Concurrency: a per-provider semaphore. `CODEX_MAX_CONCURRENCY=1` by default (OpenAI asks that
one `auth.json` not be shared across concurrent jobs; raise after a Pro upgrade). Others unlimited.

Every panel prompt gets a common preamble: "You are a general assistant. Answer directly in
markdown. Do not read, write, or execute anything."

## 4. Multi-turn context (stateless replay)

No CLI sessions are used. For turn *N* the prompt is:

```
<conversation so far>
Q1 / fused answer 1 / Q2 / fused answer 2 / … / Q(N-1) / fused answer N-1
</conversation so far>
Q_N
```

Only fused answers are replayed (never raw lane answers), so all four models and the synthesizer
see identical context. History is trimmed from the oldest turn once it exceeds ~60 k characters;
the UI shows "earliest N turns omitted". A "New conversation" button starts a fresh thread.

## 5. Synthesis

Single Claude call, `--json-schema`, output:

```json
{
  "analysis": {
    "consensus": ["..."],
    "contradictions": ["..."],
    "unique_insights": [{"answer": "A", "point": "..."}],
    "gaps": ["..."]
  },
  "answer": "final markdown"
}
```

Raw answers are passed **anonymized** as Answer A/B/C/D in shuffled order (the synthesizer is
also a panelist; anonymization limits self-preference). The UI maps letters back to model names
only in the collapsed raw section. `answer` is streamed to the UI; `analysis` is rendered as a
"Where the models disagree" panel. If the synthesizer call fails it falls back to the next
available provider and the UI says so. With exactly one lane selected, synthesis is skipped.

## 6. Data model (SQLite)

```
conversations(id, title, created_at)
turns(id, conversation_id, idx, question, fused_answer, analysis_json, synth_provider,
      synth_ms, created_at)
lane_results(turn_id, provider, status, answer, ms, error, exit_code)
```

## 7. Auth & deployment

`FUSION_PASSWORD` in `.env`; `/login` sets a signed httpOnly cookie; every other route requires
it. Bind `0.0.0.0:7788` (LAN + Tailscale). `deploy/fusion.service` is a systemd *user* unit
(`systemctl --user enable --now fusion`).

Terms of service: personal single-user use of `claude -p` / `codex exec` on a subscription is
documented as intended by both vendors. The hard line is exposing this UI to other people on
your subscription — hence mandatory password auth. Kimi/xAI terms are silent.

## 8. Out of scope for v1

Selectable synthesizer, web-search toggle, per-lane retry button, history summarization,
`codex app-server` daemon (would add token streaming and cut ~10 s cold start — provider
interface is designed so it can be swapped in), streaming raw lane answers.

## 9. Conventions

Code, comments, docs, commits: English. UI copy: English.
