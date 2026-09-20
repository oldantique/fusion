---
name: sync-docs
description: >-
  Sync Fusion's living docs + memory: persist what this session decided (context first — memory
  edits, harness notices and spoken decisions never show in git), then fix drift. Run after a
  chunk of work and before /compact.
disable-model-invocation: true
---

# Sync living docs + memory (Fusion)

Persist what this session decided, then fix drift. One fact, one home; everything else points.
Prefer deleting a stale line or replacing it with a pointer over restating. The ownership table
("Where facts live") in the root `CLAUDE.md` is the authority for *which file owns what* — read
it as it stands, don't hardcode a copy here. Everything on disk is English; chat is Chinese.

`npm run check-docs` is the mechanical half of this pass (dangling script/path/env references,
version numbers outside their home). It proves a reference *exists*, never that the sentence
around it is still *true* — truth is what this pass checks. Numbers in prose (latencies, counts,
quotas) are the same drift in a form it cannot see: state the property, point at the script or
config that owns the value.

## Scope

**Living (edit in place):** `CLAUDE.md` · `README.md` · `SECURITY.md` · `CONTRIBUTING.md` ·
`.github/` · `docs/RUNBOOK.md` · `docs/THREADS.md` · `docs/screenshot.png` · `.env.example`
(comments are the config documentation) · `fixtures/README.md` · `deploy/fusion.service` header ·
`hooks/` (each header says what it refuses) · file-header comments in `src/` and `scripts/` (this
repo's convention: subsystem rules live in the code that implements them) · this skill.

**Append-only:** `docs/DESIGN.md` (dated decision entries; a reversal is a new entry pointing
back) · `CHANGELOG.md` (`Unreleased` accumulates; a release turns it into a version heading).

**Frozen — never edit in a sync:** `fixtures/*.ndjson` (captured CLI output — capture a new
file instead; `fixtures/help/` is the opposite, a baseline rewritten after each verified
upgrade) · `data/` (runtime, gitignored) · `.env` (secrets).

**Memory** (Claude Code's per-project memory directory, outside git): preferences,
workflow lessons and pointers only — nothing derivable from the repo. Update an existing file
before creating one; delete wrong ones; relative → absolute dates; `MEMORY.md` indexes every
file exactly once. No test reaches memory and its edits never appear in `git log`; check its
paths by hand.

## Invariants (each has a slug for the pass log)

- `code-owns-behaviour` — if `src/providers/`, `src/parsers/`, `src/synth/`, `src/server/jobs.ts`
  or `src/config.ts` changed since the last sync (`git log`), re-read every CLAUDE.md gotcha, every
  RUNBOOK failure-mode row and the newest DESIGN entry that describes that behaviour; a sentence
  that now contradicts the code is deleted or corrected, not annotated. Gotchas stay one-line
  claim + pointer. An event type or status added to or retired from the `FuseEvent`/`JobEvent`
  union (`src/synth/fuse.ts`, `src/server/jobs.ts`) has its handler added to or removed from
  `web/app.js`.
- `cli-upgrade-recapture` — `npm run check-updates -- --strict --offline` must be clean
  (`hooks/pre-commit` refuses lane-code commits otherwise; the CLIs update themselves, so expect
  it). Re-verifying a CLI = `--help-diff`, `npm run smoke`, `npm run canary`, a fresh capture
  compared with its fixture, and **every CLAUDE.md gotcha about that CLI re-tested, not assumed**
  (one teammate per CLI works well) — plus what neither a gotcha nor `--help-diff` can show: the
  tool and MCP-server lists in the capture's init line, and new variants in codex's regenerated
  app-server schema. Then a `fixtures/README.md` row naming the version `check-updates` prints
  *after* the runs, and `--help-diff --update`. A changed output format means a new fixture plus
  parser and test updates in the same commit.
- `env-comments-true` — `.env.example` names exactly the variables `src/config.ts` reads
  (mechanical) **and** each comment still describes the effect (by eye).
- `threads-current` — every THREADS row's state matches reality; finished rows move to Archive
  with a one-line outcome (never deleted); `BLOCKED-by` targets exist; an item awaiting the
  owner's decision has state `DECIDE`.
- `design-appended` — if the code now does something DESIGN.md says it doesn't (or vice versa),
  add a dated entry; do not edit old entries.
- `release-triple` — at a release, `package.json` `version`, the git tag and the newest
  `CHANGELOG.md` heading are the same string, `Unreleased` is empty, and the tag and a GitHub
  release with the CHANGELOG section are pushed.
- `screenshot-current` — if `web/` or a lane's model label changed since the last sync, open
  `docs/screenshot.png` and compare it with the UI; anything in it that moved, went away or was
  renamed means a retake: throwaway conversation, light theme, sidebar collapsed (the list is
  the owner's), quantized without dithering — and look at the compressed file before committing.
- `no-owner-facts` — the repo is public: nothing in the living set states as project truth what
  is only true of the owner's account, machine or paths ("this host", "this account", a clone
  path); generalize the condition instead. Fixtures keep their captured paths (owner's call).
- `propagate-premises` — when a load-bearing premise moves (a vendor's terms, a CLI gaining
  streaming, the synthesizer changing), grep the old claim across the living set + memory and
  fix every dependent sentence in one pass. A lane's model changing is the common case: the id
  (`src/config.ts`, `.env.example`) and a `KNOWN_MODELS` row in `src/types.ts` with the label
  and the vendor-stated cutoff.

## Method (every pass — the command is the only trigger)

1. **Context sweep first — what git cannot show.** From the conversation, list this session's
   decisions, new rules, premise changes, renames, CLI upgrades noticed, memory edits and
   anything the harness announced (attribution lines, model names). For each: is it written in
   its home per the ownership table — a decision with its why in DESIGN, deferred work in
   THREADS, a user-visible change in CHANGELOG `Unreleased`, a corrected mistake as a gotcha?
   grep the living set + memory for every sentence that depends on it and fix them together.
2. **Repo sweep**: `git log --oneline` since the last `Sync-rule-hits` commit + `git status` →
   walk the invariants, judging each doc against the ownership table → fix only actual drift.
3. **Verify + commit**: `npm test` (runs `check-docs`) + `npm run typecheck`. If `check-docs`
   names a problem, fix the doc or move the fact to its home — never weaken the check. One
   logical commit (don't fragment) under standing authorization; memory edits need no commit.
   Working-tree state is reported in chat only, never written to THREADS.
4. **Report**: one line per file changed, or "no drift". List anything that could not be
   persisted (a decision that exists only in the conversation) and ask about it; otherwise end
   with an explicit **"可以 compact"** — the goal is zero loss even if the summary is lossy.

End the commit message with the rules that actually fired, slugs only, comma-separated; omit
the trailer when nothing changed:

    Sync-rule-hits: code-owns-behaviour, threads-current

Read the accumulated log with `git log --grep='Sync-rule-hits' --format='%h %s%n  %b'`.
A slug that never fires over many passes is a deletion candidate; judge from usage, not from
a static read. Old trailers may carry retired slugs.
