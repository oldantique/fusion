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

## 2026-08-20 — Synthesizer stays stateless (no `claude --resume`)

Considered resuming the Claude CLI session across turns instead of replaying history.
Rejected for v1: a resumed session carries every earlier turn's raw candidates, which breaks
the "only fused answers are replayed" rule; the per-turn letter shuffle makes cross-turn memory
actively misleading; context grows by four candidates plus an analysis per turn instead of one
question/answer pair; a fallback synthesizer would leave the session one turn behind; and the
prompt-cache win is small because turns are minutes apart. Revisit only as an experiment
behind a flag with a per-conversation letter mapping — see `docs/THREADS.md`. The general cure
for long histories is summarization, which helps all lanes.

## 2026-08-20 — Lifecycle hardening after an external review

Two headless reviews (codex, kimi) of the repo plus an in-tree audit produced these corrections;
each supersedes the matching sentence in the initial entry above.

**"Tools off" is prompt + no-write, not containment.** Panel lanes are told they have no tools,
and the spawn sandbox is an empty directory; but codex keeps its default tool set in a read-only
sandbox (disabling tools defeats its prompt cache), grok only denies the write/edit/shell
families, and kimi has no permission gate at all in `-p` mode. So a lane can read; it cannot
write. Accepted for a single-user tool on the owner's machine; the prompts additionally declare
candidate and history text untrusted, and closing tags inside it are neutralised so content
cannot end a block early.

**Anonymisation is ordering blinding.** Shuffled letters remove position bias and stop the
synthesizer from being *told* which answer is whose; they do not stop it recognising its own
style. Excluding the synthesizer's own lane was rejected (loses a candidate); the analysis must
say "candidate X" and only that phrase is de-anonymised in the UI.

**Retry is classified.** Only a non-zero exit or an empty answer gets the single retry, after a
short pause; a timeout (would time out again), an abort, a spawn failure or an internal error
fails immediately. The synthesizer chain runs each candidate once under one shared lane-timeout.
When every synthesizer fails, the best raw lane answer (same preference order) is shown and
marked "Unfused" — consistent with the single-lane case, so history replay is unchanged.
Fallback order prefers grok over codex because it streams and is fast.

**Cancellation is a status.** `cancelled` is recorded and streamed as its own event, never as
"all lanes failed"; the UI has a Stop button; shutdown aborts jobs and waits briefly for them.

**Turns are serialised per conversation** (409 while one runs; unique `(conversation_id, idx)`),
and a conversation with a running turn cannot be deleted. SSE events carry sequence ids and
resume from `Last-Event-ID`; finished lanes' deltas are compacted out of the replay buffer.

**Processes are groups.** Children are their own process group and the group is signalled;
timeout and abort hooks stay armed until the child has actually exited.

**Loopback by default.** `FUSION_HOST` defaults to the loopback address; LAN/Tailscale is an explicit
opt-in documented as running without TLS. The earlier "bound to all interfaces" default is gone.

