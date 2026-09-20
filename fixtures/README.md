# Fixtures

Real NDJSON output captured from the CLIs, replayed by `tests/parsers.test.ts`.
This file is the single home for *which CLI versions the parsers were verified against*.

| Captured | CLI versions |
|---|---|
| 2026-08-20 | claude 2.1.237 · codex-cli 0.147.0 · kimi 0.36.1 · grok 1.0.3 |
| 2026-08-20 | kimi 0.38.0 — same shapes as `kimi.ndjson`, verified by `npm run smoke` and a fresh capture; fixture unchanged |
| 2026-08-21 | claude 2.1.238 — same event shapes as `claude.ndjson`, `--help` unchanged, Chinese default still holds; verified by `npm run smoke` and a fresh capture; fixture unchanged |
| 2026-08-25 | grok 1.0.5 — same event shapes as `grok.ndjson`; `--help` only dropped the two cross-session-memory flags; `--disallowed-tools` is still not a block and the `--deny` prefix set is unchanged; verified by `npm run smoke` and a fresh capture; fixture unchanged |
| 2026-08-25 | claude 2.1.245 — same event shapes as `claude.ndjson`, `--help` unchanged, the account-language override still yields to the prompt's language line; verified by `npm run smoke`, `npm run canary` and full fused turns; fixture unchanged |
| 2026-08-25 | codex-cli 0.147.0 `app-server` — `codex-app-server.ndjson` captured over stdio JSON-RPC (v2 schema from `codex app-server generate-json-schema`), the default codex transport since then; `codex.ndjson` still covers the `exec` fallback |
| 2026-09-20 | claude 2.1.278 — same event shapes as `claude.ndjson` (`result` and `rate_limit_info` only gained fields the parser does not read); `--json-schema` still streams `input_json_delta` and ends on `result.structured_output`; `-p` still authenticates by OAuth without `--bare`; the account-language override still yields to the prompt's language line; `--strict-mcp-config` added to the lane after the account's connector showed up as a pending MCP server; verified by `npm run smoke`, `npm run canary` and fresh captures; fixture unchanged |
| 2026-09-20 | codex-cli 0.155.1 — same `app-server` event shapes as `codex-app-server.ndjson` (the committed test suite passes when replayed against a fresh capture) and same `exec --json` shapes as `codex.ndjson`; the v2 protocol schema is additive only, apart from a new `rateLimitExceeded` error variant now mapped like the other quota errors; `web_search` is a typed key and `"disabled"` a valid value; `mcp-server` left the CLI and a shared daemon arrived that the stdio lane does not use; `--experimental-json` (behind `cx2.ndjson`) still works but left `--help`; verified by `npm run smoke` on both transports, `npm run canary` and fresh captures; fixtures unchanged |
| 2026-09-20 | kimi 2.0.2 — same event shapes as `kimi.ndjson`, still whole messages only; the agent file with no tools is still the only tool switch (a full tool set that runs unprompted without it) and the permission-mode flags still refuse to combine with `-p`; now a single-file executable with Node embedded that still honours `NODE_OPTIONS`; state still only under `~/.kimi-code`; verified by `npm run smoke`, `npm run canary` and a fresh capture; fixture unchanged |
| 2026-09-20 | grok 1.0.34 — same event shapes as `grok.ndjson` and `grok-json-schema.ndjson` (the schema document still arrives as `text_delta`s in the streaming format); the `--deny` prefix set is unchanged and still blocks a read and a shell call; `--disallowed-tools` still cannot remove the shell tool; the wire tool list gained `send_feedback`, which no `--deny` prefix covers and the lane now removes with `--disallowed-tools`; verified by `npm run smoke`, `npm run canary` and fresh captures; fixtures unchanged |

Files: `claude.ndjson` (default system prompt), `cmin.ndjson` (trimmed system prompt),
`claude-json-schema.ndjson` and `grok-json-schema.ndjson` (`--json-schema` runs, the second
with the real synthesizer schema), `codex.ndjson`, `cx2.ndjson`
(`--experimental-json`, no deltas either), `codex-app-server.ndjson` (one turn over
`codex app-server`: server lines verbatim, the client's own requests kept as `# client>` lines so
`tests/codex-app-server.test.ts` can replay the exchange request by request), `kimi.ndjson`,
`grok.ndjson`, `clean/` (grok probes for `--system-prompt-override` and `--disallowed-tools`).

When a CLI upgrade changes its output, capture a new file with the flags from
`src/providers/index.ts`, add a row above, and adjust the parser + tests. Do not edit old captures.

`npm run check-updates` reads the versions above and tells you when an installed CLI is newer than
anything this table records; `--help-diff` diffs each CLI's `--help` against the committed
baselines in `fixtures/help/`, which is how a *new* flag becomes visible.
