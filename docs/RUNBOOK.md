# Fusion — Runbook

Operational notes for the long-lived deployment on this machine. Settings and their defaults
live in `.env.example`; CLI invocation details live in `src/providers/`.

## Where things are

| Thing | Location |
|---|---|
| Repo / working dir | `~/others/router` |
| Runtime state (SQLite, sandbox dir, screenshots) | `data/` inside the repo (gitignored) |
| Service unit | `deploy/fusion.service` (install steps in its header) |
| Service logs | `journalctl --user -u fusion -f` |
| Secrets | `.env` (never committed) |
| CLI credentials | each CLI's own config dir under `$HOME` (`npm run doctor` lists status) |

## Daily operations

```bash
systemctl --user status fusion        # running?
systemctl --user restart fusion       # after git pull / .env change
npm run doctor                        # CLIs present & logged in
npm run smoke                         # one real call per provider (costs a little quota)
```

Port and bind address come from `.env`. An unauthenticated request to `/api/health` returning
`401` still proves the server is up.

## Upgrading

1. `git pull && npm install` (re-bundles the frontend).
2. `npm test && npm run typecheck`.
3. `systemctl --user restart fusion`.

The schema is created with `IF NOT EXISTS` on start; destructive migrations must be written by
hand and noted in `CHANGELOG.md`.

### After upgrading one of the CLIs

`npm run smoke`. If a lane fails, run the CLI by hand from `data/sandbox/` with the flags in
`src/providers/index.ts` and compare its output to `fixtures/`. If the format changed: capture a
new fixture, record the version in `fixtures/README.md`, adjust the parser, add a test.

## Failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| Lane fails instantly; error mentions login/auth/token | CLI session expired | Run that CLI interactively once to re-login |
| kimi fails with "OAuth … fetch failed" only under the service, works in a shell | IPv6 half-connectivity; Node gives up before falling back to IPv4 | Already handled in `childEnv()` (`src/providers/process.ts`); if it recurs, check `curl -6` egress and the CLI's runtime |
| Ask returns "turn in progress" / delete refused | That conversation already has a running turn | Wait or press Stop; one turn per conversation at a time |
| Synth badge says "Unfused: …" | Every synthesizer failed; one lane's raw answer is shown | Read the lane errors; usually a Claude rate limit |
| Lane fails with a terse or odd error, usually the same lane every time | Subscription quota for that vendor exhausted (shared with your interactive use of the same CLI; some CLIs do not say "quota") | Check the vendor's usage page; wait for the window to reset; untick the lane meanwhile |
| Lane fails with "timed out" | Model slow or rate-limited | Check vendor status; raise the timeout in `.env`; untick the lane |
| codex lanes sit in "queued" | Codex concurrency cap reached by overlapping turns | Expected; raise the cap in `.env` after a plan upgrade |
| Lane answer says it cannot access files/tools | CLI thought it needed tools | The preamble forbids tools; make sure `data/sandbox/` is still empty |
| Grok answers with repo context it shouldn't have | Something put an agent file into `data/sandbox/` | Remove it (`npm run doctor` flags this) |
| Fused answer or analysis ends mid-sentence / JSON invalid | Claude output cap reached (model-dependent default; CLI normally auto-continues) | See the `childEnv()` comment in `src/providers/process.ts` for the one knob |
| Synth badge says "Fallback: …" | Claude synthesis failed (often rate limit) | Answer still produced without analysis; check Claude usage |
| UI blank after deploy | frontend bundle missing | `npm run build:vendor` |
| Turn stuck "running" after a restart | Process died mid-turn | Marked failed automatically on next start; re-ask |
| Server refuses to start naming env vars | `.env` missing or incomplete | Copy `.env.example` and fill it in |

Rate limits are shared with every other use of the same account (Claude Code, Codex, …) and
are published by each vendor; a four-lane question costs one call per lane plus one synthesis.

## Backup

`sqlite3 data/fusion.sqlite ".backup data/backup-$(date +%F).sqlite"` — safe while running
(WAL). Nothing else is state.

## Security posture

- Reachable on the LAN/Tailscale by design; the only protection is the shared password and a
  signed, expiring cookie. Use a strong password; rotate the cookie secret to log everyone out.
- No TLS. Don't port-forward to the public internet; use Tailscale for remote access.
- Lanes are told they have no tools and are spawned from an empty directory, but this is prompt
  + no-write, not containment (see `docs/DESIGN.md`): a lane could read files on this machine.
  Fine for one owner's box; another reason not to expose the UI to anyone else.
