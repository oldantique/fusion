# Fusion — Design decisions

Dated, append-only record of *why* things are the way they are. Current behaviour is defined by
the code (see the "where facts live" table in `CLAUDE.md`); if this file and the code disagree,
the code is current and this file needs a new dated entry, not a silent edit. Open and deferred
work is tracked in `docs/THREADS.md`, not here.

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
answers in the account's preferred language by default (Chinese, on the account this was built
against) due to a preference the CLI injects; only an emphatic system-prompt line overrides it
(verified across several languages).

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

## 2026-08-21 — Second review round, from the design record alone

codex and kimi were given only this file (no code) and asked for a better architecture. Both
independently rejected debate/critique rounds, pairwise judging, voting and adaptive lane
routing as latency and quota spent on problems a single user does not have; both kept the
stateless fused-only replay, the single synthesis call and the anonymised panel. What changed:

**Rate limits are their own failure kind.** A quota block used to look like any non-zero exit:
retried once (burning more of the exhausted quota) and shown as "failed". It is now
`rate_limit` — from claude's `rate_limit_info` record when present, from the message text for
the other CLIs (`classifyFailure` in `src/providers/base.ts`) — never retried, shown as "rate
limited", and the kind is persisted with the lane so a reloaded turn paints the same badge.
Conservative on purpose: an "overloaded" transient is treated the same way rather than retried.

**The synthesizer has its own effort knob** (`FUSION_SYNTH_EFFORT`). The synthesis call sits
serially after the slowest lane, so its effort is the largest single lever on turn latency.
Measured once on a technical question: medium finished in roughly half the time of high and a
blind comparison rated its answer noticeably but not clearly thinner. The default therefore
stays equal to the panel effort; the owner trades it down per installation.

**Synthesizer attempts get their own timeout, the chain is capped at two.** The previous "one
shared lane-timeout for the whole chain" meant a slow first synthesizer left the fallback a
sliver — the fallback was weakest exactly when needed. Now each attempt has a full lane timeout
and the whole chain at most two, so the worst case after the panel is bounded and the fallback
is real. Codex's wider ask for a total turn deadline was not taken: the per-lane timeout plus
this cap already bounds a turn.

**History trims in blocks.** The replayed history is the prompt-cache prefix for every lane.
Trimming exactly to the budget rewrites that prefix on every later turn; trimming down to a
fraction of the budget (`TRIM_TO` in `src/synth/prompts.ts`) leaves slack so the prefix holds
for several turns — whenever the turns being added are smaller than the ones being dropped,
which is the common case, not a guarantee. Summarisation (thread #4) remains the real cure.

**SSE resume needs no snapshot.** Codex proposed snapshot events for reconnects that predate
compacted deltas. Not needed: compaction removes only deltas, every state-replacing event
(`running` attempt>1, lane `done`/`failed` with full text, `synth start`/`done`, `cancelled`,
`finished`) stays, and an evicted job falls back to the persisted turn. A test pins this.

**Rejected this round:** self-excluding the synthesizer's own candidate (loses a quarter of the
panel for a bias that style recognition defeats anyway); per-turn random letter shuffle (the
question-keyed one keeps retries stable); provider-aware token budgets (characters are enough
for one user); execution "profiles" (lane ticking already is one). Recorded for v2 in
`docs/THREADS.md`: confirming or re-synthesising an "Unfused" answer before it becomes history,
and running the service under a dedicated OS account. Browser QA of this round found that for a
Chinese question the synthesizer translated the `candidate X` token ("候选 A", "候选 B、C、D"),
leaving bare letters in the UI: the prompt now forbids translating the token and the UI also
accepts the translation and letter lists — still never a bare letter. "OpenRouter Fusion" above names the
product that inspired the analysis format; this project does not use OpenRouter.

## 2026-08-21 — Rendering: what may skip the sanitizer

Answers now render LaTeX (KaTeX, with mhchem), mermaid diagrams, footnotes, and carry copy
buttons for code blocks and whole answers — the ChatGPT-web baseline. All of it stays local
(`scripts/build-vendor.ts`; `npm run check-docs` now rejects any remote URL under `web/`), and
mermaid is a separate bundle fetched only when a diagram appears, because it outweighs
everything else combined.

The trust boundary is unchanged in spirit and is now stated: every byte of model output goes
through DOMPurify; the only markup that bypasses it is KaTeX's own output for TeX that was
lifted out *before* markdown (so `_` and `\` survive) and rendered with `throwOnError: false`,
and mermaid SVG rendered at `securityLevel: strict` without HTML labels and then re-sanitised
with the strict SVG profile. Diagrams are drawn only from finished text (a half-arrived fence
cannot parse); a diagram that fails keeps its code visible. The pure extraction step lives in
`web/math.js` so it can be unit-tested without a browser.


## 2026-08-21 — Version drift is tracked against the fixtures, not against a tag

A CLI that self-updates invalidates the parsers and the CLAUDE.md premises without saying so, and
a check that only asks "is an upgrade available?" cannot see it. `npm run check-updates` therefore
compares three numbers — the newest version `fixtures/README.md` records, what is installed, and
what upstream publishes — and treats *installed newer than verified* as the real finding; being
behind upstream is informational. It exits non-zero only under `--strict`, so it is cheap to run.

Rejected: a `verified-versions.txt` baseline file and `verified/<cli>/<version>` git tags (the
shape a sibling project's upgrade sweep uses). Both are a second home for a fact
`fixtures/README.md` already owns, and a second home is a second thing to drift; there is nothing
to "mark" here because adding a fixtures row *is* the marking. Version comparison is also blind to
a capability that appeared, so `--help-diff` keeps a committed per-CLI baseline of each
`--help` under `fixtures/help/` — that diff is the only mechanical way a new flag becomes visible.

### 2026-08-21 — The preferred synthesizer is retried before the chain falls back

A heavy question (a chain-complex construction) timed out two panel lanes at the default lane
timeout and then the Claude synthesis attempt as well; the chain went straight to grok, which
loses the structured analysis. Claude's synthesis failures are mostly transient — a timeout on
a hard prompt, an empty result — and the owner prefers a second Claude attempt over a faster
answer from a different model. `SYNTH_CHAIN` in `src/synth/fuse.ts` therefore tries the
preferred synthesizer twice and each fallback once; the chain cap grows from two lane timeouts to
three (two for the preferred, one for a fallback), superseding the cap in the 2026-08-21 "second
review round" entry. The `synth start` event now carries `retry` next to `fallback` so the UI
can say which is happening.

### 2026-08-21 — Panel lanes are offline by design, and kimi now is too

The panel answers from model knowledge: claude runs with an empty tool list, grok with web search
disabled and its write/shell tools denied, codex without `--search` in a read-only sandbox. Kimi
was the exception — `-p` mode has no tool flag and shipped the full tool set, including web search
and unrestricted file access, with the prompt as the only barrier. An agent definition passed via
`--agent-file` whose frontmatter says `tools: []` turns out to be a hard switch: the request the
CLI sends carries an empty tool list (checked in its wire log), so the model cannot call anything.
`src/providers/kimi-agent.md` is that file. The consequence is uniform: no lane can browse, so a
question that needs today's facts gets four answers from training data; if that is ever wanted, it
should be one switch that opens all four lanes together, not kimi drifting on its own.

### 2026-08-21 — Every lane runs inside a bubblewrap jail

The tool blocks were never containment. claude (`--tools ""`) and kimi (`tools: []`) hold, but
codex's `-s read-only` and grok's deny rules only forbid *writes*; a canary file planted under
HOME came back quoted by both. Three ways to close that: a dedicated OS account (thread #15:
every CLI's OAuth state moved and re-logged-in, a second user to keep patched, and the service
still talking to it across the boundary), more CLI flags (each vendor's, each unverified after
every upgrade, and grok has already shown that not every flag does what it says), or an OS-level
mount namespace around the spawn. bubblewrap is the third: unprivileged, one binary, and the
property does not depend on the CLI cooperating. `jailArgv` in `src/providers/process.ts` builds
it: the OS read-only, the CA bundle and the few `/etc` files needed for DNS and user lookup, the
CLI's install (resolved from PATH, so an npm upgrade that relocates nothing needs no change), a
tmpfs HOME with only the provider's declared `mounts` bound into it, a tmpfs `/tmp`, the empty
sandbox as writable cwd, and a cleared environment with an allowlist. Each provider's mount list
is the allowlist and lives next to its flags. State dirs stay writable because every CLI rewrites
its credentials on token refresh; read-only would work today and break on the first rotation.
`--unshare-pid` + `--die-with-parent` keep the process-group kill semantics: killing bwrap kills
the namespace. Networking is not namespaced — the lanes need the vendors' APIs — so this is
containment of the filesystem, not of the subscription. The canary (`npm run canary`) is the
test of the property itself rather than of the mount list: it plants a secret, asks each lane to
read it through the real `runLane`, and fails on a quote. `FUSION_JAIL=off` exists to bisect a
CLI that stops working after an upgrade; a missing `bwrap` fails the lane rather than running it
unjailed, because silently losing the property is the one outcome the switch must never produce.


## 2026-08-25 — Subscription terms and programmatic-surface review

A researched pass (primary sources, all four vendors, August 2026) on whether "subscription as
API" has a better-sanctioned shape than spawning the official CLI headlessly. Findings that
decide things here: Anthropic, OpenAI and xAI each *document* headless use of their own CLI on
a personal subscription (Anthropic's headless page and `setup-token`; OpenAI's non-interactive
mode page plus a public statement that Sign-in-with-ChatGPT through official or open-source
clients is fine and only re-serving a subscription to many users is fraud-flagged; xAI's launch
post advertising `-p` for scripts, and its AUP now forbidding only *unauthorized* automation).
What all three prohibit is what the third-party bridge gateways do: lift the OAuth token, forge
the client, serve it to others — with real enforcement (Anthropic suspensions and a legal
request to a harness project; xAI risk-scoring the token). So the architecture stays: unmodified
official binaries, official login, one person. Moonshot is the exception: Kimi Code's community
guidelines reserve the subscription for interactive use and name scripted execution as out of
scope, with suspension as the remedy. The owner chose to keep the lane on the subscription
(thread #18); the documented exit is a pay-as-you-go platform key on the same binary.

Interface decisions from the same pass. codex moves to `app-server` (thread #5): it is the
slowest lane, `exec --json` is the only surface with no schema artifact and a history of silent
renames, and app-server ships checked-in JSON schemas, a long-lived process, `turn/interrupt`
and rate-limit introspection; a single serialised daemon also satisfies OpenAI's
one-`auth.json`-per-stream rule better than N processes. grok stays on `-p`: its stream is
wire-compatible with claude's, `--json-schema` does work (the earlier `supportsJsonSchema:
false` was wrong, thread #19), and it is the fastest lane, so a long-lived ACP session
(`grok agent stdio`) would buy little cold-start and cost a protocol layer, a daemon inside the
jail and one more unversioned contract. Lane starts are staggered because grok's client gives up
after two 429 retries and a simultaneous four-wide burst is the shape that trips per-second
limiters. claude stays as is — the Agent SDK works with a subscription but wraps the same binary
and is still alpha; the thing to watch is `--bare` becoming the `-p` default (thread #17).


## 2026-08-25 — grok as a structured-output synthesizer

Implementing thread #19 turned up one thing the review could not: the two CLIs that accept
`--json-schema` do not stream it the same way. claude emits the document as `input_json_delta`
fragments; grok emits it as ordinary `text_delta`s. Without that distinction a grok synthesis
would have streamed raw JSON — braces and all — into the answer pane, so the parser now routes
*both* delta kinds through the partial-field streamer whenever a schema is in play. Both CLIs
still deliver the parsed object on `result.structured_output`, so nothing above the parser had to
learn a second shape.

The second difference is a guarantee, not a wire format. claude constrains the decoder to the
schema; grok enforces it through the prompt, which means "no object" and "the wrong shape" are
both reachable outcomes rather than impossible ones. Rather than fail the lane on them, the
parser degrades: the object the CLI reported, else whatever reparses from the final text, else
the text the field streamer had already decoded — a plain answer with a null analysis, which is
exactly the degraded state `fuse()` already renders for the non-schema fallbacks. That asymmetry
is also why claude keeps the first slot in the synthesizer chain even though grok is faster.

`--help` claims `--json-schema` implies `--output-format json`; an explicit `--output-format`
still wins, so the schema run keeps streaming. Verified against the CLI, not the help text —
`fixtures/grok-json-schema.ndjson` is that run.


## 2026-08-25 — Staggered lane starts

The fan-out fired every lane in the same instant, which is precisely the shape a per-second rate
limiter is built to reject; grok's client makes it worse by giving up after two 429 retries, so a
burst that a patient client would ride out costs the whole lane. Lanes now start a configurable
moment apart (`LANE_STAGGER_MS`, `.env.example`), each measured from one point rather than chained
off the previous start, so a slow spawn does not push the rest of the queue back.

The cost is close to zero, which is why this is a default rather than an option: a turn ends when
its *slowest* lane ends, not when its last lane starts, and the gap is orders of magnitude smaller
than a model call. Rejected alternative: reacting to 429s instead of avoiding them — the retry
budget belongs to the vendor's client, we cannot extend it, and by the time we see the error the
lane has already burned its attempts. 0 disables the spacing for anyone who wants the old
behaviour back while bisecting.
### 2026-08-25 — codex over `app-server` instead of one `exec` per call

`codex exec --json` was the slowest lane and the worst contract: a cold start on every call
(about half of a trivial lane's time, `npm run smoke`), an output shape that is not versioned and
has changed under us once, and cancellation only by killing the process. Three candidates for a
better surface. `@openai/codex-sdk` is the official TypeScript package, but it is a thin wrapper
that spawns `codex exec --experimental-json` per call: same cold start, no interrupt, and the
only way into our jail would be pointing its executable override at a bwrap wrapper script —
rejected as a second copy of `jailArgv`. `codex mcp-server` exposes codex as a tool, the wrong
shape for a lane. `codex app-server` is JSON-RPC over stdio with a generated, checked-in schema
(`codex app-server generate-json-schema`), a long-lived process, `turn/interrupt`, per-turn
token usage and typed error codes; and it runs inside the existing jail unchanged. A spike
measured the warm turn at roughly half of exec's, confirmed the interrupt leaves the daemon
usable, and confirmed a read-only sandbox with network off plus `web_search = "disabled"`
(the sandbox does not cover the server-side search tool) and no session written to disk.

Shape: one daemon per service process, spawned on the first call, stopped after idling, jailed
by the same `jailArgv` and mount list as before (the containment property must not depend on
the transport). Each call is a fresh `ephemeral` thread — the server can keep threads, but
conversation memory is the synthesizer's job and lives in the prompt (history policy in
`src/synth/prompts.ts`); a shared thread would leak between conversations and drift from what the
other lanes see. The system prompt goes in as `developerInstructions` rather than inlined into
the user text, since the protocol has a slot for it. Failure rules: a daemon death mid-turn is
the retryable `exit` kind, so `runLane`'s single retry is also the respawn; an interrupt the
server never acknowledges kills the daemon after a short grace rather than leaving a lane hung
past its timeout; a spawn failure is `spawn`, not retried. The daemon's stdio is unref'd between
turns so `smoke`, `canary` and `fuse` exit without knowing about it. The exec path stays behind
`CODEX_TRANSPORT=exec` because a codex upgrade can break one transport and not the other, and
bisecting needs both. One daemon serializing every codex turn also satisfies OpenAI's
one-`auth.json`-per-stream request more literally than N concurrent exec processes did; the
concurrency cap of one is unchanged. The `Provider` interface did not need to change: `call()`
was already an async generator, which is all a non-spawn-per-call provider needs.
