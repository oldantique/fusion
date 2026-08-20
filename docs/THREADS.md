# Threads — open work

State and links only; rationale lives in `DESIGN.md`, behaviour in code. Update whenever a
thread moves. Finished threads go to Archive with a one-line outcome — never deleted.

| # | Thread | State | Notes |
|---|---|---|---|
| 1 | Selectable synthesizer (UI dropdown) | OPEN | v1 fixed to Claude; needs answer-only fallback UX for non-schema providers |
| 2 | "Allow web search" toggle per question | OPEN | Per-CLI flags differ; kimi has no off switch other than prompt |
| 3 | Per-lane retry button | OPEN | Backend retries transient failures once automatically |
| 4 | History summarization when budget exceeded | OPEN | Currently oldest turns are dropped |
| 5 | codex via `app-server` daemon (token streaming, no cold start) | OPEN | Experimental API; unverified |
| 6 | Raise codex concurrency after plan upgrade | BLOCKED-by-owner | Config only (`CODEX_MAX_CONCURRENCY`) |
| 9 | Synthesizer via `claude --resume` (session memory) | ON-HOLD | v2 experiment only, behind a flag, with per-conversation letter mapping; rationale in `docs/DESIGN.md` |
| 10 | Surface claude's `rate_limit_event` (five-hour window reset time, overage flag) in the UI | OPEN | Shape verified 2026-08-20: one event per call, position varies, only says `allowed`/reset time — low value until a non-allowed state is observed |
| 11 | Provider registry: one `PROVIDER_DEFS` table deriving the id union, labels, models, concurrency, semaphores, synth order | OPEN | v2; adding a 5th provider currently touches many files — do this first |
| 12 | `Synthesizer` strategy + child table for synthesis attempts | OPEN | v2; today synthesis is a side capability of a panel provider (`supportsJsonSchema`) |
| 13 | Versioned SQLite migrations | OPEN | v2; today: `CREATE IF NOT EXISTS` + idempotent `ALTER TABLE` in `src/store/db.ts` |

## Archive

- 2026-08-20 — v0.1.0 built, browser-QA'd (two rounds), tagged.
- 2026-08-20 — systemd user unit installed and enabled (linger on); four-lane turn verified from the service environment.
- 2026-08-20 — #8 closed: raw lane answers were in fact streamed since v0.1.0; the row was stale.
- 2026-08-20 — Lifecycle hardening from the codex/kimi review landed (SSE resume, classified retry, cancellation, process groups, per-conversation serialisation); rationale in `docs/DESIGN.md`.
