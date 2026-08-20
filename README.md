# Fusion

Ask once, get an answer fused from four frontier models — **using the subscriptions you already
pay for**, no API keys.

Fusion fans a question out in parallel to the locally installed `claude`, `codex`, `kimi` and
`grok` CLIs (all logged in with their normal subscription OAuth), then has Claude Opus merge the
four answers into one Markdown response and explain where the models disagreed. It runs as a
small local web app you can open from any device on your LAN or Tailscale network.

```
                 ┌─ claude  (Opus, high) ──────┐
question ──┬────►├─ codex   (GPT-5.6 Sol, high)┼──► synthesizer (Opus, --json-schema)
           │     ├─ kimi    (K3, high) ────────┤        │
           │     └─ grok    (4.6, high) ───────┘        ▼
           │                                   answer (streamed) + analysis
           └─ previous fused answers replayed as context
```

## Requirements

- Linux/macOS, Node ≥ 22.13
- The four CLIs installed and logged in: `claude`, `codex`, `kimi`, `grok`
  (`npm run doctor` checks). Any subset works — untick models you don't have.

## Quick start

```bash
git clone <this repo> fusion && cd fusion
npm install                       # also bundles the frontend libs
cp .env.example .env              # set FUSION_PASSWORD and FUSION_COOKIE_SECRET
npm run doctor                    # all four CLIs found and logged in?
npm run smoke                     # one trivial call per model (~20 s)
npm start                         # http://0.0.0.0:7788
```

Open `http://<host>:7788`, sign in with the password, ask something.

## What you see

- **Fused answer** at the top, streamed as it is written.
- **Where the models disagree** — consensus, contradictions (and which side the synthesizer took),
  insights only one model had, and gaps all of them missed.
- **Raw answers** from each model, collapsed, with latency. Candidates are shown to the
  synthesizer anonymously (A/B/C/D); names are revealed only here.
- Follow-up questions see the earlier *fused* answers as context, so all models stay on the
  same page.

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `FUSION_PASSWORD` | — | Login password (required) |
| `FUSION_COOKIE_SECRET` | — | Random string for signing the session cookie (required) |
| `FUSION_HOST` / `FUSION_PORT` | `0.0.0.0` / `7788` | Bind address |
| `LANE_TIMEOUT_SEC` | `300` | Per-model timeout |
| `CODEX_MAX_CONCURRENCY` | `1` | Raise after upgrading to ChatGPT Pro |
| `FUSION_EFFORT` | `high` | Reasoning effort passed to claude/codex/grok (kimi: global config) |
| `CLAUDE_MODEL` … `GROK_MODEL` | see `.env.example` | Model overrides |
| `HISTORY_CHAR_BUDGET` | `60000` | Oldest turns are dropped from context beyond this |

## Running as a service

```bash
cp deploy/fusion.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now fusion
loginctl enable-linger $USER
journalctl --user -u fusion -f
```

## Terms of service

Personal, single-user use of `claude -p` / `codex exec` on a subscription is documented by both
vendors as an intended use. **Do not expose this UI to other people on your subscription** — that
is the line both vendors draw. Hence the mandatory password.

## Development

```bash
npm test              # parser tests against captured CLI output in fixtures/
npm run typecheck
npm run fuse -- "your question"      # full fusion turn in the terminal
npm run dev           # server with file watching
```

Design decisions: [`docs/DESIGN.md`](docs/DESIGN.md). Operations: [`docs/RUNBOOK.md`](docs/RUNBOOK.md).
Agent guide (for Claude Code & friends): [`CLAUDE.md`](CLAUDE.md).

## License

MIT
