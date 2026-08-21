# Fusion

Ask once, get an answer fused from several frontier models — **using the subscriptions you
already pay for**, no API keys.

Fusion fans a question out in parallel to the locally installed `claude`, `codex`, `kimi` and
`grok` CLIs (each logged in with its normal subscription), then has Claude Opus merge the
answers into one Markdown response and explain where the models disagreed. Every model answers
offline — no web search or browsing — so answers reflect training knowledge, not the live web
(why: `docs/DESIGN.md`). It runs as a small local web app; opening it to your LAN or Tailscale
network is a one-line opt-in in `.env`.

```
                 ┌─ claude ─────┐
question ──┬────►├─ codex ──────┼──► synthesizer ──► answer (streamed) + analysis
           │     ├─ kimi  ──────┤
           │     └─ grok  ──────┘
           └─ earlier fused answers replayed as context
```

## Requirements

- Linux/macOS with a Node version that supports `node:sqlite` and type stripping
  (see `engines` in `package.json`).
- Any subset of the four CLIs installed and logged in — untick the ones you don't have.
  `npm run doctor` checks.

## Quick start

```bash
npm install                       # also bundles the frontend libs
cp .env.example .env              # then set the password and cookie secret
npm run doctor                    # CLIs found and logged in?
npm run smoke                     # one trivial call per model
npm start
```

Open the printed URL, sign in, ask something.

## What you see

- **Fused answer** at the top, streamed as it is written.
- **Where the models disagree** — consensus, contradictions (and which side the synthesizer
  took), insights only one model had, gaps all of them missed.
- **Raw answers** from each model, collapsed, with latency. The synthesizer sees candidates
  anonymously; names are revealed only here.
- Follow-up questions see the earlier *fused* answers as context, so all models stay on the
  same page.

## Configuration

Every setting, with its default and meaning, is documented in [`.env.example`](.env.example).

## Running as a service

`deploy/fusion.service` is a systemd *user* unit; the install commands are in its header
comment. Operations and troubleshooting: [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

## Terms of service

Personal, single-user use of the vendors' CLIs on a subscription is documented by them as
intended. **Do not expose this UI to other people on your subscription** — that is the line both
vendors draw; hence the mandatory password.

## Development

`npm test` (parser tests replay captured CLI output from `fixtures/`, orchestration tests run
against stub providers, plus a docs consistency check), `npm run typecheck`, `npm run fuse -- "question"` for a full turn in the terminal,
`npm run dev` for a watching server.

Design rationale: [`docs/DESIGN.md`](docs/DESIGN.md). Open work: [`docs/THREADS.md`](docs/THREADS.md).
Agent guide (for Claude Code and friends): [`CLAUDE.md`](CLAUDE.md).

## License

MIT
