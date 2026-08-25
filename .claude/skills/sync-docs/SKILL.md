---
name: sync-docs
description: >-
  Sync Fusion's living docs + memory after a chunk of work — after a provider/flag/prompt
  change, after a CLI upgrade, after a release, before /compact while the evidence is still in
  context, or whenever drift is suspected. Use when the user asks to sync/audit/tidy docs or
  memory, or says 要 compact 了 / 持久化本 session / 收尾沉淀.
---

# Sync living docs + memory (Fusion)

Fix drift only. One fact, one home; everything else points. Prefer deleting a stale line or
replacing it with a pointer over restating. The ownership table ("Where facts live") in the
root `CLAUDE.md` is the authority for *which file owns what* — read it as it stands, don't
hardcode a copy here. Everything on disk is English; chat is Chinese.

`npm run check-docs` is the mechanical half of this pass (dangling script/path/env references,
version numbers outside their home). It proves a reference *exists*, never that the sentence
around it is still *true* — truth is what this pass checks. Numbers in prose (latencies, counts,
quotas) are the same drift in a form it cannot see: state the property, point at the script or
config that owns the value.

## Scope

**Living (edit in place):** `CLAUDE.md` · `README.md` · `SECURITY.md` · `CONTRIBUTING.md` ·
`.github/` templates · `docs/RUNBOOK.md` · `docs/THREADS.md` · `.env.example` (comments are the config documentation) · `fixtures/README.md` ·
`deploy/fusion.service` header · file-header comments in `src/` and `scripts/` (this repo's
convention: subsystem rules live in the code that implements them) · this skill.

**Append-only:** `docs/DESIGN.md` (dated decision entries; a reversal is a new entry pointing
back) · `CHANGELOG.md` (`Unreleased` accumulates; a release turns it into a version heading).

**Frozen — never edit in a sync:** `fixtures/*.ndjson` (captured CLI output — capture a new
file instead) · `data/` (runtime, gitignored) · `.env` (secrets).

**Memory** (Claude Code's per-project memory directory, outside git): preferences,
workflow lessons and pointers only — nothing derivable from the repo. Update an existing file
before creating one; delete wrong ones; relative → absolute dates; `MEMORY.md` indexes every
file exactly once. No test reaches memory; check its paths by hand.

## Invariants (each has a slug for the pass log)

- `check-docs-green` — `npm run check-docs` passes. If it names a problem, fix the doc (or move
  the fact to its home), never weaken the check to make it pass.
- `code-owns-behaviour` — if `src/providers/`, `src/parsers/`, `src/synth/`, `src/server/jobs.ts`
  or `src/config.ts` changed since the last sync (`git log`), re-read every CLAUDE.md gotcha, every
  RUNBOOK failure-mode row and the newest DESIGN entry that describes that behaviour; a sentence
  that now contradicts the code is deleted or corrected, not annotated. Gotchas stay one-line
  claim + pointer.
- `cli-upgrade-recapture` — if any of the four CLIs was upgraded (`npm run check-updates` lists
  installed-but-unverified CLIs and `--help-diff` shows new flags), `npm run smoke` must pass; a
  changed output format means a new fixture, a new row in `fixtures/README.md`, and parser + test
  updates in the same commit. Premises a CLI upgrade can invalidate are re-tested, not assumed:
  no token deltas from kimi or `codex exec`; the account-language override; grok's
  `--disallowed-tools` not being a block and its `--json-schema` streaming as text deltas;
  codex's app-server schema (regenerated per version); `-p` not yet defaulting to `--bare`
  (THREADS #17).
- `env-comments-true` — `.env.example` names exactly the variables `src/config.ts` reads
  (mechanical) **and** each comment still describes the effect (by eye).
- `events-match-ui` — the `FuseEvent`/`JobEvent` union in `src/synth/fuse.ts` and
  `src/server/jobs.ts` and the handlers in `web/app.js` cover the same event types and
  statuses; a new event with no handler, or a handler for a retired event, is drift.
- `threads-current` — every THREADS row's state matches reality; finished rows move to Archive
  with a one-line outcome (never deleted); `BLOCKED-by` targets exist.
- `design-appended` — if the code now does something DESIGN.md says it doesn't (or vice versa),
  add a dated entry; do not edit old entries.
- `release-triple` — at a release, `package.json` `version`, the git tag and the newest
  `CHANGELOG.md` heading are the same string, `Unreleased` is empty, and the tag and a GitHub
  release with the CHANGELOG section are pushed.
- `no-owner-facts` — the repo is public: nothing in the living set states as project truth what
  is only true of the owner's account, machine or paths ("this host", "this account", a clone
  path); generalize the condition instead. Fixtures keep their captured paths (owner's call).
- `propagate-premises` — when a load-bearing premise moves (a vendor's terms, a CLI gaining
  streaming, the synthesizer changing), grep the old claim across the living set + memory and
  fix every dependent sentence in one pass.

## Method

`git log --oneline` since the last `Sync-rule-hits` commit + `git status` → run
`npm run check-docs` → walk the invariants, judging each doc against the ownership table → fix
only actual drift → one logical commit (don't fragment) under standing authorization → report
one line per file changed, or "no drift".

End the commit message with the rules that actually fired, slugs only, comma-separated; omit
the trailer when nothing changed:

    Sync-rule-hits: code-owns-behaviour, threads-current

Read the accumulated log with `git log --grep='Sync-rule-hits' --format='%h %s%n  %b'`.
A slug that never fires over many passes is a deletion candidate; judge from usage, not from
a static read.

## Pre-/compact persistence mode ("persist first, compress after")

Triggered by "要 compact 了 / persist this session". Goal: zero loss even if the summary is lossy.

1. Write every un-persisted decision, rule or state change from this session into its home per
   the ownership table; commit completed logical groups.
2. Update `docs/THREADS.md`: close finished rows (→ Archive), add new ones with next step and
   files involved; items awaiting the owner's decision get state `DECIDE`. Working-tree state is
   reported in chat only, never written to THREADS.
3. Report where each piece landed, list anything that could not be persisted (e.g. a decision
   that exists only in conversation) and ask about it, then end with an explicit **"可以 compact"**.
