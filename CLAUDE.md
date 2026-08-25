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

- Code, comments, docs, commits, UI copy: **English**, always. (Spoken conversation with this
  repo's owner happens in Chinese; none of it reaches disk.)
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
logged in, bwrap works), `smoke` (one trivial call per provider with timing), `canary` (no lane
can read a planted file), `fuse -- "question"` (a full
turn in the terminal), `check-updates` (installed CLIs vs the versions the fixtures were verified
against, plus `--help-diff` for flags that appeared), `test`, `typecheck`, `check-docs`, `dev`.

## Gotchas (corrected mistakes — do not relearn)

- All CLIs are spawned from an **empty sandbox directory** and with a scrubbed environment; see
  `childEnv()` and the `cwd` default in `src/providers/process.ts`. Grok and kimi read the cwd's
  agent files as system prompt, and a parent Claude Code session leaks env vars that change
  child behaviour.
- **All CLIs run inside a bwrap jail** (`jailArgv` in `src/providers/process.ts`); each provider's
  `mounts` list in `src/providers/index.ts` is the allowlist; `npm run canary` proves no lane can
  read a file outside it. The tool blocks below are the second layer, not the containment.
- **Never pass `--bare` to claude** — it disables OAuth and would demand an API key. Anthropic
  says it will become the `-p` default; see THREADS #17 before every claude upgrade.
- **A CLI can inject an account-level output language** that wins over the question's language:
  claude does it for an account whose preference is set (observed with Chinese) and no flag
  disables it. Only the emphatic language line in `src/synth/prompts.ts` overrides it — verified
  for several languages. Do not soften it.
- **codex** runs over one long-lived `codex app-server` daemon (`src/providers/codex-app-server.ts`,
  JSON-RPC over stdio; fresh ephemeral read-only thread per call; `turn/interrupt` for abort and
  timeout; a daemon that dies fails the turn with a retryable kind so the retry respawns it).
  Its stdio is unref'd between turns — scripts exit on their own; ref'd during a turn. The
  `exec` path (`CODEX_TRANSPORT=exec`) is the bisecting fallback: it blocks on an open stdin, has
  no token deltas, and pays a cold start per call. Disabling codex's tools defeats the prompt
  cache and costs more — keep the default tool set. Concurrency cap defaults to one (OpenAI's CI/CD auth docs: one
  `auth.json` per serialised stream — a token-refresh durability rule, not a licence term; one
  daemon serialising turns is exactly that). `app-server` and `mcp-server` ignore the codex API-key environment variable — subscription auth (`~/.codex/auth.json`) only.
  The first `thread/start` after a daemon spawn is slow inside the jail (its model-list refresh
  times out); every later one is instant.
- **grok**'s `--disallowed-tools` is not a block: it trims some names from the advertised tool
  list but never the shell one, and the model still reads files through it. Only effect-scoped
  `--deny 'Tool(**)'` rules stop a call, and not every tool name is a valid prefix (the CLI exits
  1 on an unknown one; the valid set is the list in its provider definition). Its
  `streaming-messages-json` is wire-compatible with claude's stream, and `--json-schema` keeps
  streaming in that format even though `--help` says it implies `--output-format json`.
  `--system-prompt-override` defeats the prompt cache.
- **kimi** has no permission gate and no tool flag in `-p` mode; the only hard switch is the
  `--agent-file` with `tools: []` (`src/providers/kimi-agent.md`) — without it the model gets
  Bash/Edit/WebSearch and can browse the web and write inside its jail. No effort flag (global
  config only). It is a
  Node binary and needs the IPv4-fallback option that `childEnv()` appends; on a host whose DNS
  answers AAAA but has no working IPv6 egress, every call fails with an OAuth "fetch failed"
  without it (an interactive shell usually gets the same option from `.bashrc`, which is why the
  failure shows up only under the service).
- The two CLIs with `--json-schema` stream it differently: claude sends the document as
  `input_json_delta` fragments, grok as ordinary `text_delta`s. Both end with the parsed object on
  `result.structured_output`, and `src/parsers/json-field-stream.ts` streams one field of it
  either way. grok's schema is enforced by the prompt rather than the decoder, so the object can
  fail to arrive — `structuredOutput()` in `src/parsers/anthropic-stream.ts` degrades instead.
- Only *fused* answers are replayed as conversation history, never raw lane answers — except
  that a turn whose answer *is* one lane's answer (single lane, or every synthesizer failed) is
  replayed like any other turn. Changing that changes the product.
- `runLane` never rejects and `fuse()` takes its providers as an injectable dependency; keep it
  that way, the orchestration tests depend on it.
- The synthesizer sees candidates as anonymized letters; names are mapped back only in the UI.
- All model output is rendered through DOMPurify. The only markup allowed past it is KaTeX's own
  output and re-sanitised mermaid SVG — see `render()` in `web/app.js`; never add a third.
