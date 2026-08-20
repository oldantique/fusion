# Fusion — Design decisions

Dated, append-only record of *why* things are the way they are. Current behaviour is defined by
the code (see the "where facts live" table in `CLAUDE.md`); if this file and the code disagree,
the code is current and this file needs a new dated entry, not a silent edit. Open and deferred
work is tracked in `THREADS.md`, not here.

## 2026-08-20 — Initial design (settled in a design interview with the owner)

**Product.** Self-hosted "OpenRouter Fusion": one question fans out in parallel to the
subscription-authenticated CLIs installed on this machine; a synthesizer merges the answers into
one Markdown response shown in a local web UI, with the raw answers available underneath.
Prior art (karpathy/llm-council and similar) is API-key based; the subscription-CLI + web-UI
combination was an empty niche.

**Sources.** claude (Opus), codex (GPT-5.6 Sol), kimi (K3), grok (4.6), all at effort "high";
DeepSeek deliberately excluded. Every lane is a subprocess of the vendor CLI, using whatever
login the CLI already has — no API keys. Claude uses `claude -p` rather than the Agent SDK:
the SDK spawns the same binary with the same auth path and would only add a second code path.

**Tools off.** Models answer from their own knowledge; no file, shell or web access. Reasons:
safety (kimi has no permission gate), speed, and prompt-cache friendliness. A web-search toggle
is deferred (THREADS).

**Sandbox + env hygiene.** CLIs are spawned from an empty directory with parent-session env
vars scrubbed, because several CLIs read the cwd's agent files into their system prompt and a
parent Claude Code session leaks variables that alter child behaviour.

**Parsers.** Two families: an Anthropic-Messages stream parser (claude and grok, whose streams
are wire-compatible) and a whole-message parser (codex and kimi, which emit no token deltas).
Parsers are tested against captured real output in `fixtures/`.

**Synthesis.** Fixed synthesizer: Claude Opus via `--json-schema`, one call producing both the
final Markdown answer (streamed to the UI via a partial-JSON field streamer) and a structured
analysis — consensus, contradictions, unique insights, gaps — modelled on OpenRouter Fusion's
two-layer design but collapsed into a single call to save a cold start. Candidates are shown to
the synthesizer as anonymized letters in an order derived from the question, to limit
self-preference (the synthesizer is also a panelist); names are revealed only in the UI.
If Claude fails, the next available provider synthesizes answer-only. With a single lane
selected, synthesis is skipped.

**Multi-turn = stateless replay.** No CLI sessions. Each turn replays prior (question, *fused*
answer) pairs as a preamble for every lane and the synthesizer, so all models see identical
context; raw lane answers are never replayed. History is trimmed from the oldest turn beyond a
character budget (config) and the UI says how many turns were omitted. Rejected alternative:
native per-CLI sessions — each model would only remember its own answer, codex's resume drops
model/effort, and four session ids would need managing.

**Failure policy.** Per-lane timeout (config), one retry, then the lane is marked failed and
excluded from synthesis; the turn still completes with the remaining lanes.

**Concurrency.** Per-provider semaphores. Codex defaults to one at a time because OpenAI's
own guidance asks that a single `auth.json` not be shared across concurrent jobs; the owner can
raise it (config) after upgrading the plan.

**Language.** Answers must follow the question's language. Discovered during build: `claude -p`
on this account answers in Chinese by default due to an account-level preference the CLI
injects; only an emphatic system-prompt line overrides it (verified across several languages).

**UI.** Plain ES modules, no framework; libs bundled locally (no CDN). Fused answer streamed on
top, analysis panel, raw lanes collapsed with status and latency (raw lanes are not streamed —
half the complexity for content that is folded away), conversation sidebar, dark mode,
mobile layout. SSE per turn with an in-memory event buffer so a reload mid-turn replays state.

**Access & auth.** Bound to all interfaces for LAN/Tailscale use; shared password → signed
httpOnly cookie. Mandatory because both vendors' terms draw the line at letting *other people*
use your subscription; single-user personal use is documented as intended.

**Persistence.** SQLite via `node:sqlite` (WAL) under `data/`. Conversations, turns, lane
results. Turns left "running" by a crash are marked failed at next start.

**Stack.** Node 22 + TypeScript run directly (type stripping), Hono for HTTP/SSE. Chosen over
Python because the whole system is subprocess + NDJSON + SSE plumbing where Node is native.

**Conventions.** English everywhere on disk; Chinese in conversation with the owner.
