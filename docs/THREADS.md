# Threads — open work

State and links only; rationale lives in `DESIGN.md`, behaviour in code. Update whenever a
thread moves. Finished threads go to Archive with a one-line outcome — never deleted.

| # | Thread | State | Notes |
|---|---|---|---|
| 1 | Selectable synthesizer (UI dropdown) | OPEN | v1 fixed to Claude; needs answer-only fallback UX for non-schema providers |
| 2 | "Allow web search" toggle per question | OPEN | Since 2026-08-21 every lane is offline by a hard flag (kimi via `--agent-file`, see `docs/DESIGN.md`); the toggle must open all four together |
| 3 | Per-lane retry button | OPEN | Backend retries transient failures once automatically |
| 4 | History summarization when budget exceeded | OPEN | Currently oldest turns are dropped |
| 5 | codex via `app-server` daemon (token streaming, no cold start) | OPEN | Experimental API; unverified |
| 6 | Raise codex concurrency after plan upgrade | BLOCKED-by-owner | Config only (`CODEX_MAX_CONCURRENCY`) |
| 9 | Synthesizer via `claude --resume` (session memory) | ON-HOLD | v2 experiment only, behind a flag, with per-conversation letter mapping; rationale in `docs/DESIGN.md` |
| 10 | Show claude's rate-limit reset time / overage flag in the UI | OPEN | Since 2026-08-21 a non-allowed state is classified as `rate_limit` (badge "rate limited", not retried); `resetsAt` is parsed into parser state but not yet displayed |
| 11 | Provider registry: one `PROVIDER_DEFS` table deriving the id union, labels, models, concurrency, semaphores, synth order | OPEN | v2; adding a 5th provider currently touches many files — do this first |
| 12 | `Synthesizer` strategy + child table for synthesis attempts | OPEN | v2; today synthesis is a side capability of a panel provider (`supportsJsonSchema`) |
| 13 | Versioned SQLite migrations | OPEN | v2; today: `CREATE IF NOT EXISTS` + idempotent `ALTER TABLE` in `src/store/db.ts` |
| 14 | "Unfused" answer: confirm or re-synthesise before it is replayed as history | OPEN | v2; today it enters history like any answer (consistency argument in `docs/DESIGN.md`) — a "Retry synthesis" button is the likely shape |
| 16 | Share with a few friends over the owner's domain | ON-HOLD | Decided 2026-08-21 to defer. Path when resumed: Cloudflare Tunnel to the loopback-bound service + Access email allowlist (TLS and identity outside the app); `src/server/auth.ts` trusts the Access JWT as identity; `conversations.owner` column and per-owner filtering in `src/store/db.ts` + `src/server/main.ts`; per-user daily turn cap; cookie `secure` behind the proxy. File access is already contained by the jail (#15); the subscription-sharing terms risk is the owner's call |

## Archive

- 2026-08-21 — #15 (dedicated OS account) closed: superseded by the bwrap jail — every lane runs in a mount namespace that exposes only its own state dir; `npm run canary` is the proof; rationale in `docs/DESIGN.md`.
- 2026-08-20 — v0.1.0 built, browser-QA'd (two rounds), tagged.
- 2026-08-20 — systemd user unit installed and enabled (linger on); four-lane turn verified from the service environment.
- 2026-08-20 — #8 closed: raw lane answers were in fact streamed since v0.1.0; the row was stale.
- 2026-08-21 — Second codex/kimi review (design record only): rate-limit kind, synthesizer effort knob, per-attempt synth timeout, block trimming; rationale in `docs/DESIGN.md`.
- 2026-08-20 — Lifecycle hardening from the codex/kimi review landed (SSE resume, classified retry, cancellation, process groups, per-conversation serialisation); rationale in `docs/DESIGN.md`.
