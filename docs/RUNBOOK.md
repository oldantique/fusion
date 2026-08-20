# Fusion — Runbook

Operational notes for the long-lived deployment on this machine.

## Where things are

| Thing | Location |
|---|---|
| Repo / working dir | `~/others/router` |
| Runtime data (SQLite, sandbox, screenshots) | `~/others/router/data/` (gitignored) |
| Database | `data/fusion.sqlite` (WAL: also `-wal`, `-shm`) |
| Service unit | `deploy/fusion.service` → `~/.config/systemd/user/fusion.service` |
| Logs (service) | `journalctl --user -u fusion -f` |
| Secrets | `.env` (never committed) |
| CLI credentials | `~/.claude/`, `~/.codex/auth.json`, `~/.kimi-code/`, `~/.grok/` |

## Daily operations

```bash
systemctl --user status fusion        # running?
systemctl --user restart fusion       # after git pull / .env change
journalctl --user -u fusion -n 200    # recent log
npm run doctor                        # CLIs present & logged in
npm run smoke                         # end-to-end per-provider call (costs a few cents)
```

Port: `7788`. Health: `curl -s localhost:7788/api/health` (needs the cookie; a `401` still proves
the server is up).

## Upgrading

1. `git pull && npm install` (re-bundles the frontend).
2. `npm test && npm run typecheck`.
3. `systemctl --user restart fusion`.

Schema changes are applied with `CREATE … IF NOT EXISTS` on start; destructive migrations must be
written by hand and noted in `CHANGELOG.md`.

### After upgrading one of the CLIs

`npm run smoke`. If a lane fails, run the CLI by hand from `data/sandbox/` with the flags in
`src/providers/index.ts` and compare its NDJSON to `fixtures/`. If the format changed, capture a new
fixture, adjust the parser, add a test.

## Failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| Lane fails instantly, error mentions `login`, `auth`, `401`, `token` | CLI session expired | Run the CLI interactively once (`claude`, `codex login`, `kimi`, `grok`) |
| Lane fails with `timed out after 300s` | Model slow / rate limited | Check provider status; raise `LANE_TIMEOUT_SEC`; untick the lane |
| `codex` lanes show `queued` for a long time | `CODEX_MAX_CONCURRENCY=1` and several turns in flight | Expected; raise after a Pro upgrade |
| Lane returns "I cannot access files…" text | A CLI thinks it needs tools | Preamble asks for no tools; check `data/sandbox/` is still empty |
| Grok answers using repo context | Something placed `CLAUDE.md` in `data/sandbox/` | Remove it; `npm run doctor` flags this |
| Synth badge "Fallback: Fusing with GPT-5.6 Sol" | Claude synth failed (rate limit) | Answer still produced without analysis; check Claude usage |
| UI blank after deploy | `web/vendor/bundle.js` missing | `npm run build:vendor` |
| Turn stuck "running" after server restart | Process died mid-turn | `failStaleTurns()` marks it failed on next start; just re-ask |
| `FUSION_PASSWORD and FUSION_COOKIE_SECRET must be set` | `.env` missing | Copy `.env.example` |

Rate limits: Claude 5-hour + weekly windows shared with all Claude Code use on this account
(`rate_limit_event` lines appear in claude's stream). Codex: ChatGPT Plus allows only 10–100
GPT-5.6 Sol messages per 5 h — four-lane fan-out drains it fast; Pro is 5–20x.

## Backup

`sqlite3 data/fusion.sqlite ".backup data/backup-$(date +%F).sqlite"` (safe while running thanks to
WAL). Nothing else is state.

## Security posture

- Bound to `0.0.0.0` for LAN/Tailscale; the only protection is the shared password + HMAC cookie
  (30-day expiry). Use a strong password; rotate `FUSION_COOKIE_SECRET` to log everyone out.
- No TLS. Don't port-forward this to the public internet; if remote access is needed, use
  Tailscale (already encrypted).
- Models run without tools from an empty directory; they cannot read or write anything.
