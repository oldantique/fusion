# Fixtures

Real NDJSON output captured from the CLIs, replayed by `tests/parsers.test.ts`.
This file is the single home for *which CLI versions the parsers were verified against*.

| Captured | CLI versions |
|---|---|
| 2026-08-20 | claude 2.1.237 · codex-cli 0.147.0 · kimi 0.36.1 · grok 1.0.3 |
| 2026-08-20 | kimi 0.38.0 — same shapes as `kimi.ndjson`, verified by `npm run smoke` and a fresh capture; fixture unchanged |
| 2026-08-21 | claude 2.1.238 — same event shapes as `claude.ndjson`, `--help` unchanged, Chinese default still holds; verified by `npm run smoke` and a fresh capture; fixture unchanged |
| 2026-08-25 | codex-cli 0.147.0 `app-server` — `codex-app-server.ndjson` captured over stdio JSON-RPC (v2 schema from `codex app-server generate-json-schema`), the default codex transport since then; `codex.ndjson` still covers the `exec` fallback |

Files: `claude.ndjson` (default system prompt), `cmin.ndjson` (trimmed system prompt),
`claude-json-schema.ndjson` (`--json-schema` run), `codex.ndjson`, `cx2.ndjson`
(`--experimental-json`, no deltas either), `codex-app-server.ndjson` (one turn over
`codex app-server`: server lines verbatim, the client's own requests kept as `# client>` lines so
`tests/codex-app-server.test.ts` can replay the exchange request by request), `kimi.ndjson`,
`grok.ndjson`, `clean/` (grok probes for `--system-prompt-override` and `--disallowed-tools`).

When a CLI upgrade changes its output, capture a new file with the flags from
`src/providers/index.ts`, add a row above, and adjust the parser + tests. Do not edit old captures.

`npm run check-updates` reads the versions above and tells you when an installed CLI is newer than
anything this table records; `--help-diff` diffs each CLI's `--help` against the committed
baselines in `fixtures/help/`, which is how a *new* flag becomes visible.
