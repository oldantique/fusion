# Fixtures

Real NDJSON output captured from the CLIs, replayed by `tests/parsers.test.ts`.
This file is the single home for *which CLI versions the parsers were verified against*.

| Captured | CLI versions |
|---|---|
| 2026-08-20 | claude 2.1.237 · codex-cli 0.147.0 · kimi 0.36.1 · grok 1.0.3 |

Files: `claude.ndjson` (default system prompt), `cmin.ndjson` (trimmed system prompt),
`claude-json-schema.ndjson` (`--json-schema` run), `codex.ndjson`, `cx2.ndjson`
(`--experimental-json`, no deltas either), `kimi.ndjson`, `grok.ndjson`, `clean/` (grok probes
for `--system-prompt-override` and `--disallowed-tools`).

When a CLI upgrade changes its output, capture a new file with the flags from
`src/providers/index.ts`, add a row above, and adjust the parser + tests. Do not edit old captures.
