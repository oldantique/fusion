# Fusion — agent guide

Self-hosted multi-model fusion: one question → parallel calls to locally installed,
subscription-authenticated CLIs → one synthesized Markdown answer in a local web UI.

## Where facts live (one home each; everything else points)

| Fact | Home | Notes |
|---|---|---|
| How each CLI is invoked (flags, env) | `src/providers/index.ts`, `src/providers/process.ts` | Comments there carry the *why*; docs never restate flags |
| CLI versions the parsers were verified against | `fixtures/README.md` | Bump it when recapturing fixtures |
| Configuration keys and defaults | `.env.example` (comments) + `src/config.ts` | README points here; no tables elsewhere |
| Prompts, schema, history-replay policy | `src/synth/prompts.ts` | |
| HTTP routes and SSE event shapes | `src/server/main.ts`, `src/synth/fuse.ts` | |
| Design decisions and their rationale | `docs/DESIGN.md` | Dated decision record; append, don't rewrite |
| Open work / deferred items | `docs/THREADS.md` | State and links only |
| Operations and failure modes | `docs/RUNBOOK.md` | |
| Release history | `CHANGELOG.md` | Append-only |
| Corrected mistakes / gotchas | this file, section below | One-line claim + pointer, never a copy of a number |

Living files (this, README, RUNBOOK, THREADS) are edited in place. DESIGN and CHANGELOG are
append-only: a reversed decision gets a new dated line, the old one stays. Numbers in prose are
a drift source: describe magnitude ("the slowest lane", "an order of magnitude fewer tokens")
and point at the script that measures it (`npm run smoke`) rather than quoting a figure.
`npm run check-docs` mechanically verifies that every command, path and env var the docs name
actually exists; it runs as part of `npm test`. The judgement half — are the sentences still
true — is the `sync-docs` skill (`.claude/skills/sync-docs/SKILL.md`); run it after a chunk of
work and before compacting.

## Conventions

- Code, comments, docs, commits, UI copy: **English**. Conversation with the owner is in Chinese.
- Node + TypeScript executed directly with type stripping: no syntax that needs transpiling
  (no enums, no parameter properties, no `import x = require`). `npm run typecheck` must stay clean.
- Tests use `node:test`; parser tests replay captured CLI output from `fixtures/`. When a CLI's
  output format changes, capture a new fixture (and update `fixtures/README.md`) rather than
  editing the old one.
- Frontend is plain ES modules in `web/`; third-party libs are bundled once by
  `npm run build:vendor` (runs on `postinstall`). No CDN, ever.
- Commit per coherent change with a message that says *why*.

## Layout (directory level — file headers describe individual files)

- `src/providers/` spawn + parse + retry for each CLI · `src/parsers/` NDJSON parsers ·
  `src/synth/` prompts and the fan-out/synthesize orchestration · `src/store/` SQLite ·
  `src/server/` HTTP, SSE, auth, job registry · `web/` UI · `scripts/` ops and dev tools ·
  `tests/` · `fixtures/` · `deploy/` service unit · `docs/` · `data/` runtime state (gitignored).

## Useful commands

See the `scripts` block in `package.json`; the ones you will want: `doctor` (CLIs installed and
logged in), `smoke` (one trivial call per provider with timing), `fuse -- "question"` (a full
turn in the terminal), `test`, `typecheck`, `check-docs`, `dev`.

## Gotchas (corrected mistakes — do not relearn)

- All CLIs are spawned from an **empty sandbox directory** and with a scrubbed environment; see
  `childEnv()` and the `cwd` default in `src/providers/process.ts`. Grok and kimi read the cwd's
  agent files as system prompt, and a parent Claude Code session leaks env vars that change
  child behaviour.
- **Never pass `--bare` to claude** — it disables OAuth and would demand an API key.
- **claude on this account answers in Chinese by default** (account-level preference injected
  by the CLI; no flag disables it). Only the emphatic language line in `src/synth/prompts.ts`
  overrides it — verified for several languages. Do not soften it.
- **codex** blocks on an open stdin; no token deltas; disabling its tools defeats the prompt
  cache and costs more — keep the default tool set. It is the slowest lane and its concurrency
  cap defaults to one (OpenAI asks that one `auth.json` not be shared across concurrent jobs).
- **grok** ignores `--disallowed-tools`; only effect-scoped `--deny 'Tool(**)'` rules work, and
  not every tool name is a valid prefix (the CLI rejects unknown ones at startup). Its
  `streaming-messages-json` is wire-compatible with claude's stream. `--system-prompt-override`
  defeats the prompt cache.
- **kimi** has no permission gate in `-p` mode and no effort flag (global config only).
- `claude --json-schema` output streams as `input_json_delta` fragments; the final object is in
  `result.structured_output`. `src/parsers/json-field-stream.ts` exists to stream one field of it.
- Only *fused* answers are replayed as conversation history, never raw lane answers.
  Changing that changes the product.
- The synthesizer sees candidates as anonymized letters; names are mapped back only in the UI.
