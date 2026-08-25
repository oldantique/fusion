# Fusion

Ask four frontier models at once and get one synthesized answer — locally, through the CLIs you
already have logged in. No API keys, no proxy, no token extraction.

Fusion fans a question out in parallel to the locally installed `claude`, `codex`, `kimi` and
`grok` CLIs (each the vendor's own binary, logged in with its normal subscription, running in a
sandbox), then has one of them merge the answers into a single Markdown response and say where
the models disagreed. Every model answers offline — no web search or browsing — so answers
reflect training knowledge, not the live web (why: `docs/DESIGN.md`). It runs as a small local
web app with conversation history; opening it to your LAN or Tailscale network is a one-line
opt-in in `.env`.

```
                 ┌─ claude ─────┐
question ──┬────►├─ codex ──────┼──► synthesizer ──► answer (streamed) + analysis
           │     ├─ kimi  ──────┤
           │     └─ grok  ──────┘
           └─ earlier fused answers replayed as context
```

## How this compares

The idea — a panel answers, a judge fuses — is the one behind OpenRouter's Fusion router and
Karpathy's LLM Council. Fusion differs in where it runs and what it authenticates with.

| | Fusion (this repo) | OpenRouter Fusion | llm-council and most API-based councils |
|---|---|---|---|
| Runs | on your machine | in OpenRouter's cloud | on your machine, calls go to OpenRouter |
| Auth | each vendor's official CLI, already logged in | OpenRouter API key | OpenRouter API key |
| Cost | your existing subscriptions | sum of every panel and judge completion | metered per token |
| Models | whatever your `claude` / `codex` / `kimi` / `grok` are logged into | any OpenRouter slugs | any OpenRouter slugs |
| Synthesis | one schema'd call: fused answer plus a structured disagreement analysis; candidates anonymized | panel → analyst → outer model, tool-gated (may skip deliberation) | answers → anonymous peer ranking → chairman |
| Web access | off by design | on for the panel | whatever the models do |
| Isolation | every CLI in a bubblewrap jail with a scrubbed environment (`npm run canary` proves it) | n/a | none |
| History | SQLite; fused answers replayed as context | stateless API | JSON files |

Not affiliated with OpenRouter or any of the vendors.

## Requirements

- Linux with a Node version that supports `node:sqlite` and type stripping
  (see `engines` in `package.json`), and `bubblewrap` (`bwrap`) — every CLI runs inside a jail
  that hides the rest of your files from it (see `docs/RUNBOOK.md`, Security posture).
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

Fusion stays on the side of the line the vendors draw: it spawns the **unmodified official
CLI**, logged in by you, on your machine, for you. It never reads, stores or forwards an OAuth
token, and it does not turn a subscription into an API for anyone else. Anthropic, OpenAI and
xAI each document headless use of their own CLI by the subscriber; what they prohibit — and
enforce — is lifting the token into another client or re-serving one login to many users.
Hence the mandatory password and the single-user design: **do not expose this UI to other
people on your subscription.**

One exception you should know about: Kimi Code's community guidelines reserve its subscription
for interactive use. Running that lane from Fusion is your call; the same `kimi` binary also
runs on a pay-as-you-go platform key. Details and sources: the 2026-08-25 entry in
[`docs/DESIGN.md`](docs/DESIGN.md).

Threat model, what the jail does and does not contain, and how to report a vulnerability:
[`SECURITY.md`](SECURITY.md).

## Development

`npm test` (parser tests replay captured CLI output from `fixtures/`, orchestration tests run
against stub providers, plus a docs consistency check), `npm run typecheck`, `npm run fuse -- "question"` for a full turn in the terminal,
`npm run dev` for a watching server.

Conventions, the checks a change must pass, and the fixture rule:
[`CONTRIBUTING.md`](CONTRIBUTING.md).
Design rationale: [`docs/DESIGN.md`](docs/DESIGN.md). Open work: [`docs/THREADS.md`](docs/THREADS.md).
Agent guide (for Claude Code and friends): [`CLAUDE.md`](CLAUDE.md).

## License

MIT
