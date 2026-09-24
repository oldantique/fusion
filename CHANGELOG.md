# Changelog

## Unreleased

- Long conversations no longer break lanes: a prompt is passed as one command-line argument to
  grok and kimi, which the kernel caps at 128 KiB — a Chinese conversation reached that long before
  the history budget trimmed anything, and grok quietly loses a prompt near that size. History is
  now trimmed in bytes to stay under the ceiling, claude reads its prompt from stdin, and a prompt
  that still cannot fit fails with a message saying so instead of "spawn E2BIG".
- claude synthesizes in plain reply text and puts only the comparison in its structured output.
  With Opus 5.5 it had started writing the answer twice, so the fused answer took longer, showed
  nothing until the second copy began, and once was stored as just "see the full answer above".
  The answer now streams from its first word at about half the output.
- Every lane and synthesizer call leaves a raw trace under `data/traces/<turn-id>/` (the prompt,
  everything the CLI printed, its stderr and the outcome), kept for `FUSION_TRACE_DAYS` (30 by
  default) and deleted with its conversation.
- The comparison under a fused answer is written in the question's language like the answer
  (Claude Opus 5.5 had started writing it in English), and a unique insight names its model even
  when the synthesizer writes "candidate C" instead of the bare letter.
- The UI's files are served with `Cache-Control: no-cache` and an ETag, so a browser or a proxy
  in front revalidates them on every load instead of running an old `app.js` against a newer
  server after an update.
- The claude lane runs Claude Opus 5.5 (`claude-opus-5-5`, pinned rather than the moving `opus`
  alias; needs claude 2.1.280 or newer) and the grok lane Grok 4.7. History keeps the names it
  was saved with.
- A fresh clone no longer fails its first lane call with a misleading "spawn … ENOENT": the
  empty sandbox directory the CLIs run in is created on demand, not only by the server.
- `npm run check-updates -- --tools-diff`: baselines of what each lane advertises to its model —
  tools and MCP servers for claude and grok, error variants for codex — so a CLI upgrade that
  adds one shows up as a diff instead of being found by reading a capture.
- A failure a CLI reports inside its own stream now carries that CLI's stderr: grok can end a
  run with an error flag and no message, and the reason (a refusal, a quota) was being dropped.
  The stderr text also takes part in rate-limit detection, and a lane that timed out or was
  stopped says so whatever the CLI printed on the way down.
- History keeps naming the model that answered: each turn stores the model every provider was
  configured with, and the UI names lanes, the synthesizer and the analysis from that snapshot.
  Existing turns are backfilled once (they all ran on the defaults of the time). Names and
  cutoffs are now looked up by model id, so a model set in `.env` is shown as itself.
- The codex lane's default model is now GPT-6 Astra (`CODEX_MODEL=gpt-6-astra`); its label and
  knowledge cutoff in the UI follow.
- All four CLIs re-verified after a month of silent self-updates, kimi across a major version;
  parsers and fixtures unchanged. The claude lane now passes `--strict-mcp-config` (the account's
  claude.ai connectors were visible to it as pending MCP servers), the grok lane removes the new
  `send_feedback` tool, and codex's new `rateLimitExceeded` error is treated as a quota error
  instead of being retried.
- Git hooks in `hooks/` enforce what was only written down: captured fixtures are frozen, secrets
  stay out, lane code and fixtures change only while every installed CLI is a verified build
  (`npm run check-updates -- --strict --offline`), and a push needs green tests and typecheck.
- UI: the offline / training-cutoff notice moved from the composer to the empty state of a
  conversation, so it is read before the first question and no longer occupies every composer.

## 0.2.0 — 2026-08-25

- Prepared for public release: `SECURITY.md` (threat model, what the jail contains, how to report
  a vulnerability), `CONTRIBUTING.md` (the three checks, the fixture rule, one-fact-one-home),
  a CI workflow running `test` / `typecheck` / `check-docs` on a runner with none of the vendor
  CLIs installed, a bug-report template that asks for `npm run doctor` and
  `npm run check-updates` output, and repository metadata in `package.json`.
- Docs no longer state as project truths things that were only true on the machine this was built
  on: the account-language gotcha, the kimi IPv4 fallback (any host with AAAA records and no IPv6
  egress, not one host), and `deploy/fusion.service`, which shipped the author's clone path as
  `WorkingDirectory` — it is a placeholder to edit now.
- Lanes start a fraction of a second apart instead of all at once, so a four-wide question no
  longer arrives at any vendor as a burst (`LANE_STAGGER_MS`, 0 to disable). The turn is not
  slower: the slowest lane still decides when it ends.
- grok can synthesize: it takes `--json-schema` too, so a turn whose claude synthesizer fails
  now falls back to a *structured* second opinion — same merged answer, same consensus /
  contradictions / unique-insights / gaps analysis — instead of dropping to answer-only text.
- codex lane runs over a long-lived `codex app-server` daemon (JSON-RPC over stdio, generated
  schema) instead of one `codex exec` per call: no cold start per call (the trivial-prompt lane
  time roughly halves, `npm run smoke`), streamed token deltas, Stop interrupts the turn without
  losing the daemon, per-turn token usage, typed quota errors. A fresh ephemeral read-only thread
  per call; nothing is remembered server-side. `CODEX_TRANSPORT=exec` restores the old path.
- Every lane runs inside a bubblewrap jail that exposes only that CLI's own state directory;
  `npm run canary` proves no lane can read a file planted under HOME. `FUSION_JAIL=off` to
  bisect a CLI that stopped working after an upgrade. grok also gets the full `--deny` set.
  bubblewrap is now a prerequisite (`npm run doctor` checks it).
- UI: a line under the model picks says every model answers offline and lists each one's
  vendor-stated knowledge cutoff (home: `PROVIDER_CUTOFFS` in `src/types.ts`).
- kimi runs with an empty tool set (`--agent-file`); it can no longer search the web or touch
  files, matching the other lanes.
- `npm run check-updates`: three columns per CLI (last-verified / installed / latest) so an
  upgrade that silently invalidated the fixtures is visible; `--help-diff` diffs each `--help`
  against a committed baseline, which is the only way a *new* flag shows up.
- Fenced code blocks carry a header with the language and a Copy button.
- Copy any answer as Markdown — the fused header and every lane's summary row.
- ```mermaid fences are drawn as diagrams (lazy-loaded bundle, source one click away, a
  diagram that will not parse keeps showing its code).
- Chemistry notation: KaTeX now loads mhchem, so `\ce{H2O}` and `\pu{…}` render.
- Footnotes (`[^1]`) render as a footnotes section instead of literal text; ids are scoped per
  answer so backlinks stay inside their own turn.
- LaTeX in answers is rendered with KaTeX (bundled, no CDN): `$$…$$` / `\[…\]` display and
  `$…$` / `\(…\)` inline, extracted before markdown so code blocks and prices like $5 are
  untouched and half-streamed math stays literal text.
- Docs restructured around single-home facts: `.env.example` owns configuration,
  `fixtures/README.md` owns verified CLI versions, `docs/DESIGN.md` is a dated decision record,
  `docs/THREADS.md` tracks open work. `npm run check-docs` (part of `npm test`) verifies that
  docs only reference existing scripts/paths/env vars and keep version numbers in their home.
- `sync-docs` skill (`.claude/skills/sync-docs/`) for the judgement half of drift control.
- Stop button; cancelled turns are recorded and shown as "Stopped" instead of failed.
- One running turn per conversation (the server answers 409 otherwise); a conversation with a
  running turn cannot be deleted.
- SSE reconnects resume where they left off instead of replaying the whole turn (no more
  duplicated text after a network hiccup).
- When every synthesizer fails, the best raw answer is shown and marked "Unfused" rather than
  the turn failing.
- Retries only for transient failures; timeouts fail fast. CLI helper processes are killed with
  their parent; graceful shutdown waits for running turns to cancel.
- `.env` is loaded by every entry point (`npm run smoke` / `fuse` previously ran with defaults);
  integer settings are validated; `FUSION_HOST` now defaults to loopback.
- Quota failures are shown as "rate limited" and not retried; the failure kind is stored with
  the lane.
- `FUSION_SYNTH_EFFORT` sets the synthesizer's effort separately from the panel.
- Each synthesizer attempt gets its own timeout (the fallback no longer inherits a sliver);
  the preferred synthesizer is retried once before the chain falls back to another model, and
  the chain is capped at three lane timeouts. The synth badge distinguishes "Retry:" from
  "Fallback:".
- Replayed history is trimmed in blocks so the prompt cache survives more turns.
- `npm run fuse` prints the synthesizer's duration.
- kimi lanes work under systemd (IPv4 fallback option passed to the child).

## 0.1.0 — 2026-08-20

Initial release.

- Parallel fan-out to claude (Opus), codex (GPT-5.6 Sol), kimi (K3), grok (4.6) via their
  subscription-authenticated CLIs; per-lane timeout, retry-once, per-provider concurrency caps.
- Synthesis by Claude Opus with `--json-schema`: streamed Markdown answer plus a structured
  analysis (consensus / contradictions / unique insights / gaps); candidates anonymized.
- Multi-turn conversations via stateless replay of fused answers, trimmed by a char budget.
- Web UI: password login, conversation sidebar, streamed answer, collapsible raw lane answers,
  "Where the models disagree" panel, SSE with replay on reconnect, dark mode, mobile layout.
- SQLite persistence, systemd user unit, `doctor` / `smoke` / `fuse` scripts.
