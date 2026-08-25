# Changelog

## Unreleased

- Lanes start a fraction of a second apart instead of all at once, so a four-wide question no
  longer arrives at any vendor as a burst (`LANE_STAGGER_MS`, 0 to disable). The turn is not
  slower: the slowest lane still decides when it ends.
- grok can synthesize: it takes `--json-schema` too, so a turn whose claude synthesizer fails
  now falls back to a *structured* second opinion — same merged answer, same consensus /
  contradictions / unique-insights / gaps analysis — instead of dropping to answer-only text.
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
