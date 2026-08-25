# Contributing

Fusion is a small, opinionated personal tool. Issues and pull requests are welcome; so is a fork
that takes it somewhere else. What follows is how the repo stays coherent — the same rules the
maintainer and the agents working in it follow.

## Getting set up

```bash
npm install          # postinstall bundles the frontend libs into web/vendor/
cp .env.example .env # set at least the password and the cookie secret
npm run doctor       # which CLIs are installed and logged in, and whether bwrap works
```

You do not need all four CLIs — untick the ones you do not have. You do not need any of them to
run the test suite: tests replay captured CLI output and stub providers, and the one test that
needs `bwrap` skips itself when it is absent.

## The three checks

Every commit must leave these green:

```bash
npm test          # node:test — parsers, orchestration, store, docs consistency
npm run typecheck # tsc --noEmit
npm run check-docs # also runs inside npm test
```

`npm run check-docs` is the mechanical half of documentation review: it verifies that every
`npm run …` script, repo path and environment variable the docs name actually exists, and that
version numbers stay in the one file that owns them. The judgement half — are the sentences still
*true* — is on you.

## Conventions

- **English on disk.** Code, comments, docs, commit messages, UI copy.
- **No transpile step.** TypeScript runs directly under Node's type stripping, so nothing that
  needs code generation: no enums, no parameter properties, no `import x = require`. Node version
  floor is the `engines` field in `package.json`.
- **No new dependencies** unless there is no reasonable alternative, and **no CDN, ever** — the
  frontend is plain ES modules in `web/` and third-party libraries are bundled locally by
  `npm run build:vendor`. `npm run check-docs` fails on a remote URL under `web/`.
- **One commit per coherent change**, with a message that says *why* rather than what. The diff
  already says what.

## Tests

`node:test`, no framework. Parser tests replay real CLI output captured under `fixtures/`;
orchestration tests inject stub providers (`fuse()` takes its providers as a dependency, and
`runLane` never rejects — keep both properties, the tests rest on them).

**The fixture rule:** when a CLI upgrade changes an output format, capture a *new* fixture and
add a row to `fixtures/README.md` recording the version you verified against. Never edit an old
fixture — it is the evidence that a parser handled that build, and rewriting it destroys the only
record of what changed.

`npm run check-updates` is what tells you a CLI moved: it compares the versions
`fixtures/README.md` records against what is installed and what upstream publishes, and treats
*installed newer than verified* as the finding. `npm run check-updates -- --help-diff` diffs each
CLI's `--help` against the committed baselines in `fixtures/help/`, which is the only mechanical
way a newly appeared flag becomes visible.

## Where facts live

Every fact has exactly one home and everything else points at it: CLI flags live in
`src/providers/`, configuration in `.env.example`, verified CLI versions in `fixtures/README.md`,
rationale in `docs/DESIGN.md` (dated, append-only), open work in `docs/THREADS.md`, operations in
`docs/RUNBOOK.md`. The full ownership table is in [`CLAUDE.md`](CLAUDE.md) — read it there rather
than copying rows around, and when you move a fact, leave a pointer, not a duplicate.

Prose should not restate numbers that a script can measure; describe the magnitude and point at
the script (`npm run smoke`).

`CLAUDE.md` is written for coding agents (Claude Code and friends) and is worth reading as a
human too: its "Gotchas" section is a list of mistakes already made and diagnosed — a CLI flag
that does not do what its `--help` says, an auth mode that breaks a lane, a spawn detail that
changes a model's behaviour. Check it before debugging a lane, and add to it when you find the
next one.

## Pull requests

Say what problem the change solves and how you verified it. If it touches a lane, say which CLI
version you ran against; if it touches the jail, run `npm run canary`. Security issues go through
[`SECURITY.md`](SECURITY.md), not a pull request.
