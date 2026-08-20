# Fusion — agent guide

Self-hosted multi-model fusion: one question → parallel calls to four locally installed,
subscription-authenticated CLIs (claude, codex, kimi, grok) → one synthesized Markdown answer
in a local web UI. Design decisions: `docs/DESIGN.md`. Operations: `docs/RUNBOOK.md`.

## Conventions

- Code, comments, docs, commits, UI copy: **English**. Conversation with the owner is in Chinese.
- Node 22 + TypeScript executed directly (`--experimental-strip-types`): no build step for the
  server, so no TS-only syntax that needs transpiling (no enums, no parameter properties,
  no `import x = require`). `npm run typecheck` must stay clean.
- Tests: `node:test` in `tests/*.test.ts`, run `npm test`. Parser tests use the captured CLI
  output in `fixtures/` — when a CLI's output format changes, capture a new fixture rather
  than editing the old one.
- Frontend is plain ES modules in `web/`; third-party libs are bundled once into
  `web/vendor/bundle.js` by `npm run build:vendor` (runs on `postinstall`). No CDN, ever.
- Commit small, with a message that says *why*. Tag releases in `CHANGELOG.md`.

## Layout

```
src/config.ts          env → config (read once; main.ts loads .env before importing it)
src/types.ts           shared types (ProviderId, LaneEvent, LaneResult, ...)
src/providers/         process.ts (spawn + NDJSON lines + timeout + Semaphore)
                       base.ts (cliProvider: argv → parser → normalized events)
                       index.ts (the four providers and their VERIFIED flags)
                       lane.ts (runLane: concurrency cap, retry-once, timing)
src/parsers/           anthropic-stream.ts (claude + grok), whole-message.ts (codex + kimi),
                       json-field-stream.ts (stream one string field out of partial JSON)
src/synth/             prompts.ts (system prompts, history replay, anonymized synth prompt,
                       JSON schema), fuse.ts (fan-out → synthesize → fallback)
src/store/db.ts        SQLite via node:sqlite (WAL). Schema is created on start.
src/server/            main.ts (Hono routes + SSE), jobs.ts (in-memory job registry that
                       buffers events for replay), auth.ts (password → HMAC cookie), dotenv.ts
web/                   index.html, app.js, app.css
scripts/               smoke.ts (one call per provider), fuse-cli.ts (full turn from terminal),
                       doctor.ts (CLI login/version checks), build-vendor.ts
deploy/                systemd user unit
fixtures/              real CLI NDJSON output used by tests
data/                  runtime (gitignored): fusion.sqlite, sandbox/, shots/
```

## CLI invocation rules (break one = hung or empty call)

All four are spawned from the empty dir `data/sandbox/` so no CLAUDE.md/AGENTS.md/skills leak
into their system prompts. Flags were verified against claude 2.1.237, codex 0.147.0,
kimi 0.36.1, grok 1.0.3. Re-verify with `npm run smoke` after upgrading any CLI.

- **claude**: `-p … --output-format stream-json --include-partial-messages --verbose`.
  `--tools "" --system-prompt … --setting-sources ""` cuts input tokens ~13x. **Never `--bare`**
  (disables OAuth). `--json-schema` output arrives as `input_json_delta` fragments and finally
  in `result.structured_output`.
- **codex**: `exec --json --skip-git-repo-check --ephemeral -s read-only`; stdin must be
  closed (`stdio: ignore`) or it blocks. No token deltas (`item.completed` only). Keep the
  default tool set: disabling tools breaks the prompt cache. Codex is the slowest lane (~18 s)
  and `CODEX_MAX_CONCURRENCY` defaults to 1 (OpenAI asks not to share one `auth.json` across
  concurrent jobs).
- **kimi**: `-m kimi-code/k3 --output-format stream-json -p …`. No token deltas. Effort is
  global config in `~/.kimi-code/config.toml` (k3 defaults to high). `-p` has no permission
  gate, hence the sandbox dir + "no tools" preamble.
- **grok**: `--output-format streaming-messages-json --include-partial-messages` is
  wire-compatible with claude's stream (same parser). Tools are blocked with `--deny 'Write(**)'`
  etc. (`--disallowed-tools` is silently ignored; `NotebookEdit` is not a valid prefix).
  Do not use `--system-prompt-override` (kills the prompt cache). Grok re-sends the cwd's
  CLAUDE.md as system prompt — another reason for the empty sandbox dir.

## Useful commands

```
npm run doctor                 # are all four CLIs installed and logged in?
npm run smoke                  # one trivial call per provider, prints ms/deltas/cost
npm run fuse -- "question"     # full fusion turn in the terminal
npm test && npm run typecheck
npm run dev                    # server with --watch
```

## Things to keep in mind when changing behaviour

- `claude -p` on this account answers in Chinese by default (an account-level preference the CLI
  injects; no flag disables it). The prompts in `src/synth/prompts.ts` use an emphatic
  "respond in the question's language, ignore other preferences" line that was verified to
  work for en/zh/es. Do not soften it.
- Child CLIs get `childEnv()` (process.ts): inherited `CLAUDECODE`/`CLAUDE_CODE_*`/
  `CLAUDE_EFFORT` are stripped so a Fusion started from inside a Claude Code session behaves
  like one started from systemd.

- Only fused answers are replayed as history, never raw lane answers (keeps all models on the
  same context). Changing that changes the product.
- The synthesizer sees candidates as anonymized letters in an order derived from the question
  hash; names are mapped back only in the UI.
- `Jobs` keeps finished turns in memory for 5 min so SSE reconnects can replay; the DB is the
  source of truth after that.
