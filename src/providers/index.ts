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
/** Agent definition that strips kimi's tool set; see the kimi provider below. */
const KIMI_AGENT_FILE = new URL("./kimi-agent.md", import.meta.url).pathname;

function inlineSystem(opts: CallOptions): string {
  return `${opts.system}\n\n---\n\n${opts.prompt}`;
}

export const claude: Provider = cliProvider({
  id: "claude",
  label: PROVIDER_LABELS.claude,
  streams: true,
  supportsJsonSchema: true,
  // Writable: the OAuth refresh rewrites .credentials.json and the CLI updates .claude.json.
  mounts: { rw: ["~/.claude", "~/.claude.json"] },
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
  mounts: { rw: ["~/.codex"] },
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
  // ~/.kimi-code holds the binary, its bundled rg/fd, credentials and sessions, so it is rw as a
  // whole; the agent file lives in this repo and must be visible too.
  mounts: { rw: ["~/.kimi-code"], ro: [KIMI_AGENT_FILE] },
  build(opts) {
    // Effort lives in ~/.kimi-code/config.toml ([thinking] effort); k3 defaults to high.
    // There is no per-call flag, so opts.effort cannot be honoured here.
    // `-p` has no permission gate and no tool flag: by default the model gets the full tool set
    // (Bash, Edit, WebSearch, …). The only hard switch is an agent definition whose frontmatter
    // says `tools: []` — the request then carries an empty tool list (verified in the CLI's
    // wire log), which puts kimi on the same footing as the other lanes: knowledge only.
    return {
      cmd: "kimi",
      args: ["--agent-file", KIMI_AGENT_FILE, "-m", config.models.kimi, "--output-format", "stream-json", "-p", inlineSystem(opts)],
    };
  },
  parser: () => createKimiParser(),
});

export const grok: Provider = cliProvider({
  id: "grok",
  label: PROVIDER_LABELS.grok,
  streams: true,
  supportsJsonSchema: false,
  mounts: { rw: ["~/.grok"] },
  build(opts) {
    // --deny is the only effective tool block (--disallowed-tools is ignored). This is the full
    // set of valid prefixes (NotebookEdit is not one: the CLI exits 1); the model still *tries*
    // read_file/run_terminal_command and is denied each time. The bwrap jail is the hard layer
    // underneath, for the day a rule stops matching.
    // Do NOT use --system-prompt-override: it defeats the prompt cache and costs 2x.
    const deny = ["Read(**)", "Glob(**)", "Grep(**)", "Bash(**)", "Write(**)", "Edit(**)", "WebFetch(**)", "WebSearch(**)"];
    return {
      cmd: "grok",
      args: [
        "-p",
        inlineSystem(opts),
        "-m",
        config.models.grok,
        "--reasoning-effort",
        opts.effort ?? config.effort,
        ...deny.flatMap((d) => ["--deny", d]),
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
