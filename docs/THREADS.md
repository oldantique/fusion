# Threads — open work

State and links only; rationale lives in `DESIGN.md`, behaviour in code. Update whenever a
thread moves. Finished threads go to Archive with a one-line outcome — never deleted.

| # | Thread | State | Notes |
|---|---|---|---|
| 1 | Selectable synthesizer (UI dropdown) | OPEN | v1 fixed to Claude; needs answer-only fallback UX for non-schema providers |
| 2 | "Allow web search" toggle per question | OPEN | Per-CLI flags differ; kimi has no off switch other than prompt |
| 3 | Per-lane retry button | OPEN | Backend already retries once automatically |
| 4 | History summarization when budget exceeded | OPEN | Currently oldest turns are dropped |
| 5 | codex via `app-server` daemon (token streaming, no cold start) | OPEN | Experimental API; unverified |
| 6 | Raise codex concurrency after plan upgrade | BLOCKED-by-owner | Config only (`CODEX_MAX_CONCURRENCY`) |
| 7 | Install systemd user unit for always-on access | DECIDE | `deploy/fusion.service`; owner's call |
| 8 | Stream raw lane answers (claude/grok can) | ON-HOLD | Deliberately skipped in v1 |

## Archive

- 2026-08-20 — v0.1.0 built, browser-QA'd (two rounds), tagged.
