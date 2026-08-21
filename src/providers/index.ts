/**
 * The four subscription-backed CLI providers. This file is the single home for how each CLI
 * is invoked; the versions these flags were verified against are recorded in fixtures/README.md.
 * Read the gotchas in CLAUDE.md before changing any flag.
 */
import { config } from "../config.ts";
import { createAnthropicStreamParser } from "../parsers/anthropic-stream.ts";
import { createCodexParser, createKimiParser } from "../parsers/whole-message.ts";
import type { CallOptions, Provider, ProviderId } from "../types.ts";
import { PROVIDER_LABELS } from "../types.ts";
import { cliProvider } from "./base.ts";

/** Providers without a system-prompt flag get it prepended to the user prompt. */
function inlineSystem(opts: CallOptions): string {
  return `${opts.system}\n\n---\n\n${opts.prompt}`;
}

export const claude: Provider = cliProvider({
  id: "claude",
  label: PROVIDER_LABELS.claude,
  streams: true,
  supportsJsonSchema: true,
  build(opts) {
    // NEVER add --bare: it disables OAuth/keychain and would require an API key.
    const args = [
      "-p",
      opts.prompt,
      "--model",
      config.models.claude,
      "--effort",
      opts.effort ?? config.effort,
      "--tools",
      "",
      "--system-prompt",
      opts.system,
      "--setting-sources",
      "",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
    ];
    if (opts.jsonSchema) args.push("--json-schema", JSON.stringify(opts.jsonSchema));
    return { cmd: "claude", args };
  },
  parser: (opts) => createAnthropicStreamParser(opts.jsonSchema ? opts.streamField : undefined),
});

export const codex: Provider = cliProvider({
  id: "codex",
  label: PROVIDER_LABELS.codex,
  streams: false,
  supportsJsonSchema: false,
  build(opts) {
    // stdin is "ignore" (== < /dev/null); without that codex blocks waiting on stdin.
    // Keep the default tool set: disabling tools via -c breaks the prompt cache and costs more.
    return {
      cmd: "codex",
      args: [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--ephemeral",
        "-s",
        "read-only",
        "-m",
        config.models.codex,
        "-c",
        `model_reasoning_effort="${opts.effort ?? config.effort}"`,
        inlineSystem(opts),
      ],
    };
  },
  parser: () => createCodexParser(),
});

export const kimi: Provider = cliProvider({
  id: "kimi",
  label: PROVIDER_LABELS.kimi,
  streams: false,
  supportsJsonSchema: false,
  build(opts) {
    // Effort lives in ~/.kimi-code/config.toml ([thinking] effort); k3 defaults to high.
    // There is no per-call flag, so opts.effort cannot be honoured here.
    return {
      cmd: "kimi",
      args: ["-m", config.models.kimi, "--output-format", "stream-json", "-p", inlineSystem(opts)],
    };
  },
  parser: () => createKimiParser(),
});

export const grok: Provider = cliProvider({
  id: "grok",
  label: PROVIDER_LABELS.grok,
  streams: true,
  supportsJsonSchema: false,
  build(opts) {
    // --deny is the only effective tool block (--disallowed-tools is ignored).
    // Do NOT use --system-prompt-override: it defeats the prompt cache and costs 2x.
    return {
      cmd: "grok",
      args: [
        "-p",
        inlineSystem(opts),
        "-m",
        config.models.grok,
        "--reasoning-effort",
        opts.effort ?? config.effort,
        "--deny",
        "Write(**)",
        "--deny",
        "Edit(**)",
        "--deny",
        "Bash(**)",
        "--disable-web-search",
        "--no-subagents",
        "--output-format",
        "streaming-messages-json",
        "--include-partial-messages",
      ],
    };
  },
  parser: () => createAnthropicStreamParser(),
});

export const providers: Record<ProviderId, Provider> = { claude, codex, kimi, grok };
