/**
 * The four subscription-backed CLI providers. This file is the single home for how each CLI
 * is invoked; the versions these flags were verified against are recorded in fixtures/README.md.
 * Read the gotchas in CLAUDE.md before changing any flag.
 */
import { config } from "../config.ts";
import { createAnthropicStreamParser } from "../parsers/anthropic-stream.ts";
import { createCodexParser, createKimiParser } from "../parsers/whole-message.ts";
import type { CallOptions, Provider, ProviderId } from "../types.ts";
import { modelInfo } from "../types.ts";
import { cliProvider } from "./base.ts";
import { CODEX_MOUNTS, codexAppServer } from "./codex-app-server.ts";

/** Providers without a system-prompt flag get it prepended to the user prompt. */
/** Agent definition that strips kimi's tool set; see the kimi provider below. */
const KIMI_AGENT_FILE = new URL("./kimi-agent.md", import.meta.url).pathname;

function inlineSystem(opts: CallOptions): string {
  return `${opts.system}\n\n---\n\n${opts.prompt}`;
}

export const claude: Provider = cliProvider({
  id: "claude",
  label: modelInfo("claude", config.models.claude).label,
  streams: true,
  supportsJsonSchema: true,
  proseBesideSchema: true,
  // Writable: the OAuth refresh rewrites .credentials.json and the CLI updates .claude.json.
  mounts: { rw: ["~/.claude", "~/.claude.json"] },
  build(opts) {
    // NEVER add --bare: it disables OAuth/keychain and would require an API key.
    // The prompt goes on stdin, not argv: one argument is capped at 128 KiB by the kernel, and
    // claude — the lane and the preferred synthesizer — has no reason to share that ceiling.
    const args = [
      "-p",
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
      // `--tools ""` only governs built-in tools. The account's claude.ai connectors are MCP
      // servers registered in ~/.claude.json (mounted for OAuth); without this flag they connect
      // in the lane and offer the model their tools, writable ones included.
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
    ];
    if (opts.jsonSchema) args.push("--json-schema", JSON.stringify(opts.jsonSchema));
    return { cmd: "claude", args, stdin: opts.prompt };
  },
  parser: (opts) => createAnthropicStreamParser(opts.jsonSchema ? opts.streamField : undefined),
});

/**
 * The per-call `codex exec` path, selected by CODEX_TRANSPORT=exec. The default is the
 * app-server daemon in ./codex-app-server.ts; this stays as the bisecting fallback.
 */
export const codexExec: Provider = cliProvider({
  id: "codex",
  label: modelInfo("codex", config.models.codex).label,
  streams: false,
  supportsJsonSchema: false,
  mounts: CODEX_MOUNTS,
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

export const codex: Provider = config.codexTransport === "exec" ? codexExec : codexAppServer;

export const kimi: Provider = cliProvider({
  id: "kimi",
  label: modelInfo("kimi", config.models.kimi).label,
  streams: false,
  supportsJsonSchema: false,
  // ~/.kimi-code holds the binary, its bundled rg/fd, credentials and sessions, so it is rw as a
  // whole; the agent file lives in this repo and must be visible too.
  mounts: { rw: ["~/.kimi-code"], ro: [KIMI_AGENT_FILE] },
  build(opts) {
    // Effort lives in ~/.kimi-code/config.toml ([thinking] effort); the default is whatever the
    // vendor's model catalog in that file says, and it has moved between releases.
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
  label: modelInfo("grok", config.models.grok).label,
  streams: true,
  supportsJsonSchema: true,
  mounts: { rw: ["~/.grok"] },
  build(opts) {
    // --deny is the only effective tool block (--disallowed-tools leaves the shell tool in place).
    // This is the full set of valid prefixes (NotebookEdit is not one: the CLI exits 1); the model
    // still *tries* read_file/run_terminal_command and is denied each time. The bwrap jail is the
    // hard layer underneath, for the day a rule stops matching.
    // Do NOT use --system-prompt-override: it defeats the prompt cache and costs 2x.
    const deny = ["Read(**)", "Glob(**)", "Grep(**)", "Bash(**)", "Write(**)", "Edit(**)", "WebFetch(**)", "WebSearch(**)"];
    const args = [
      "-p",
      inlineSystem(opts),
      "-m",
      config.models.grok,
      "--reasoning-effort",
      opts.effort ?? config.effort,
      ...deny.flatMap((d) => ["--deny", d]),
      // send_feedback (an outward call to the vendor) has no --deny prefix; --disallowed-tools does
      // remove a non-shell tool from the list the model is given.
      "--disallowed-tools",
      "send_feedback",
      "--disable-web-search",
      "--no-subagents",
      "--output-format",
      "streaming-messages-json",
      "--include-partial-messages",
    ];
    // `--help` says --json-schema implies `--output-format json`; an explicit --output-format
    // still wins, so the schema run keeps streaming (verified — fixtures/grok-json-schema.ndjson).
    // The schema is enforced by prompt here, not by the decoder: the parser degrades rather than
    // trusting the object to arrive.
    if (opts.jsonSchema) args.push("--json-schema", JSON.stringify(opts.jsonSchema));
    return { cmd: "grok", args };
  },
  parser: (opts) => createAnthropicStreamParser(opts.jsonSchema ? opts.streamField : undefined),
});

export const providers: Record<ProviderId, Provider> = { claude, codex, kimi, grok };
