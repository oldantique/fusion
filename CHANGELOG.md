# Changelog

## 0.1.0 — 2026-08-20

Initial release.

- Parallel fan-out to claude (Opus), codex (GPT-5.6 Sol), kimi (K3), grok (4.6) via their
  subscription-authenticated CLIs; per-lane timeout, retry-once, per-provider concurrency caps.
- Synthesis by Claude Opus with `--json-schema`: streamed Markdown answer plus a structured
  analysis (consensus / contradictions / unique insights / gaps); candidates anonymized.
- Multi-turn conversations via stateless replay of fused answers, trimmed by a char budget.
- Web UI: password login, conversation sidebar, streamed answer, collapsible raw lane answers,
  "Where the models disagree" panel, SSE with replay on reconnect, dark mode, mobile layout.
- SQLite persistence, systemd user unit, `doctor` / `smoke` / `fuse` scripts.
