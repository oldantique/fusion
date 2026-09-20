/**
 * Version-drift tracker for the four CLIs. Read-only: it never upgrades or "marks" anything.
 *
 * Three numbers per CLI, because two are not enough:
 *   last-verified — the newest version `fixtures/README.md` records the parsers as checked against
 *   installed     — what is on this machine right now
 *   latest        — what the upstream package publishes
 *
 * `latest > installed` is the informational one: an upgrade exists, nothing is broken.
 * `installed > last-verified` is the one that matters — the parsers, the fixtures and every CLI
 * premise in CLAUDE.md were checked against a build that is no longer the one running, and the
 * upgrade (self-update, `npm -g`) announced nothing. Only that condition is an error, and only
 * under `--strict`; the default is report-only so it is cheap to run at any time.
 *
 * Comparing versions can only re-test rules we already wrote down; it is blind to a capability
 * that APPEARED. So `--help-diff` diffs each `<cli> --help` against a committed snapshot in
 * `fixtures/help/`. That diff is the only mechanical way to notice codex growing token deltas,
 * kimi growing an effort flag, or grok fixing `--disallowed-tools`.
 *
 * `--help` is itself blind to what a CLI hands the *model*: a tool that appeared, an MCP server the
 * account registered, a new error variant in codex's protocol. `--tools-diff` snapshots those —
 * for claude and grok the `system` init record of the lane exactly as Fusion spawns it (the call
 * is aborted as soon as that record arrives, before any answer is generated), for codex the
 * `CodexErrorInfo` variants of its generated app-server schema. kimi prints no such list. It
 * logs in and spawns jailed CLIs, so it is an on-demand step of an upgrade, never the hook's.
 *
 * Usage: npm run check-updates                          the three-column table
 *        npm run check-updates -- --strict              exit 1 on installed > last-verified
 *        npm run check-updates -- --strict --offline    the same without the registry lookup — what
 *                                                       `hooks/pre-commit` runs
 *        npm run check-updates -- --help-diff           diff `--help` against the snapshots
 *        npm run check-updates -- --help-diff --update  rewrite the snapshots
 *        npm run check-updates -- --tools-diff [--update]  the same for what each lane advertises
 * `--strict` turns either kind of drift into exit 1, so a hook or CI job can fail on it.
 *
 * There is deliberately no `--mark` and no git tag: `fixtures/README.md` is the single home for
 * verified versions, and a second record of the same fact is a second thing to drift.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "../src/config.ts";
import os from "node:os";
import { childEnv } from "../src/providers/process.ts";
import type { Provider } from "../src/types.ts";
import { cliVersion } from "./doctor.ts";

interface CliSpec {
  id: string;
  /**
   * The npm package that publishes it. All four are npm-distributed; kimi installs itself from a
   * CDN into `~/.kimi-code` but publishes the same version numbers to the registry, so one lookup
   * path covers everything and no GitHub releases API is needed.
   */
  pkg: string;
  /** Arguments for `--version`; the number is extracted from whatever line it prints. */
  versionArgs: string[];
  /**
   * The help surfaces that make up the interface we actually use. For codex the headless surface
   * is a subcommand, so the top level (where a new subcommand would first show up) and `exec`'s
   * own flags are both captured.
   */
  help: string[][];
}

const CLIS: CliSpec[] = [
  { id: "claude", pkg: "@anthropic-ai/claude-code", versionArgs: ["--version"], help: [["--help"]] },
  { id: "codex", pkg: "@openai/codex", versionArgs: ["--version"], help: [["--help"], ["exec", "--help"]] },
  { id: "kimi", pkg: "@moonshot-ai/kimi-code", versionArgs: ["--version"], help: [["--help"]] },
  { id: "grok", pkg: "@xai-official/grok", versionArgs: ["--version"], help: [["--help"]] },
];

const ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURES_README = path.join(ROOT, "fixtures", "README.md");
const HELP_DIR = path.join(ROOT, "fixtures", "help");

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const warn = (s: string) => `\x1b[33m${s}\x1b[0m`;
const alert = (s: string) => `\x1b[31m${s}\x1b[0m`;

// --- versions ----------------------------------------------------------------------------

const SEMVER = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/;

/** The version number inside a `--version` line ("codex-cli 0.147.0", "2.1.238 (Claude Code)"). */
export function extractVersion(line: string | null): string | null {
  return line?.match(SEMVER)?.[0] ?? null;
}

function parts(v: string): { nums: number[]; pre: string } {
  const i = v.search(/[-+]/);
  const core = i < 0 ? v : v.slice(0, i);
  return { nums: core.split(".").map((n) => Number(n) || 0), pre: i < 0 ? "" : v.slice(i + 1) };
}

/** semver-ish compare (<0, 0, >0); a prerelease sorts below the release it precedes. */
export function cmpVersion(a: string, b: string): number {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === "") return 1;
  if (y.pre === "") return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** `fixtures/README.md` names codex as "codex-cli"; every other row uses the provider id. */
const ALIASES: Record<string, string> = { claude: "claude", codex: "codex", "codex-cli": "codex", kimi: "kimi", grok: "grok" };

/**
 * Highest version per CLI mentioned anywhere in `fixtures/README.md`. Rows are append-only and a
 * later row may re-verify only one CLI, so "newest row" is the wrong reading — "highest version
 * seen for that CLI" is what the file actually asserts.
 */
export function verifiedVersions(readme: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const m of readme.matchAll(/\b(claude|codex-cli|codex|kimi|grok)[ \t]+v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/gi)) {
    const id = ALIASES[m[1]!.toLowerCase()]!;
    const v = m[2]!;
    const prev = found.get(id);
    if (prev === undefined || cmpVersion(v, prev) > 0) found.set(id, v);
  }
  return found;
}

/** Latest published version, or null on any network/registry trouble — never throws. */
async function latestOnNpm(pkg: string): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    return ((await res.json()) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

// --- help snapshots ----------------------------------------------------------------------

/**
 * `<cli> --help` from the empty sandbox directory with the scrubbed child environment, the same
 * way providers spawn: agent files in the cwd and a parent Claude Code session's variables both
 * change what a CLI does. Not `runLines()` — that is an NDJSON reader and drops the blank lines
 * that make a committed help snapshot readable. stdin stays closed (codex blocks on an open one).
 */
function helpText(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: config.sandboxDir, env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (out += d));
    child.stderr.on("data", (d: string) => (err += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    const done = (text: string | null) => {
      clearTimeout(timer);
      resolve(text);
    };
    child.on("error", () => done(null));
    // Some CLIs print usage on stderr; fall back to it rather than snapshotting an empty file.
    child.on("close", () => done((out.trim() ? out : err).trim() || null));
  });
}

/** All of one CLI's help surfaces in one self-describing text, ANSI stripped so diffs are lines. */
async function helpSnapshot(cli: CliSpec): Promise<string | null> {
  const chunks: string[] = [];
  for (const args of cli.help) {
    const text = await helpText(cli.id, args);
    if (text === null) return null;
    // Colour codes would turn every diff into noise; help output is plain text otherwise.
    chunks.push(`$ ${cli.id} ${args.join(" ")}\n\n${text.replace(/\x1b\[[0-9;]*m/g, "")}`);
  }
  return chunks.join("\n\n") + "\n";
}

/** Minimal LCS line diff: two help texts are a few hundred lines, not worth a dependency. */
function diffLines(a: string[], b: string[]): string[] {
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push(`- ${a[i++]}`);
    } else {
      out.push(`+ ${b[j++]}`);
    }
  }
  while (i < n) out.push(`- ${a[i++]}`);
  while (j < m) out.push(`+ ${b[j++]}`);
  return out;
}

/** Compare live snapshots with the committed ones; returns how many differ. */
async function snapshotDiff(
  items: { id: string; file: string; live: () => Promise<string | null>; unreadable: string }[],
  update: boolean,
  advice: string,
): Promise<number> {
  fs.mkdirSync(HELP_DIR, { recursive: true });
  fs.mkdirSync(config.sandboxDir, { recursive: true });
  let changed = 0;
  for (const item of items) {
    const live = await item.live();
    if (live === null) {
      console.log(`${item.id.padEnd(8)} ${warn(item.unreadable)}`);
      continue;
    }
    if (!fs.existsSync(item.file)) {
      fs.writeFileSync(item.file, live);
      console.log(`${item.id.padEnd(8)} snapshot created (${path.relative(ROOT, item.file)})`);
      continue;
    }
    const d = diffLines(fs.readFileSync(item.file, "utf8").split("\n"), live.split("\n"));
    if (d.length === 0) {
      console.log(`${item.id.padEnd(8)} ${dim("unchanged")}`);
      continue;
    }
    changed++;
    console.log(`${item.id.padEnd(8)} ${warn(`CHANGED (${d.length} lines; + added, - removed)`)}`);
    for (const line of d) console.log(`    ${line}`);
    if (update) {
      fs.writeFileSync(item.file, live);
      console.log(`    ${dim(`snapshot updated: ${path.relative(ROOT, item.file)}`)}`);
    }
  }
  if (changed && !update) console.log(`\n${advice}`);
  return changed;
}

function helpDiff(update: boolean): Promise<number> {
  return snapshotDiff(
    CLIS.map((cli) => ({
      id: cli.id,
      file: path.join(HELP_DIR, `${cli.id}.txt`),
      live: () => helpSnapshot(cli),
      unreadable: "could not read --help (not installed, or it timed out)",
    })),
    update,
    "A new flag can invalidate a CLAUDE.md gotcha. Re-verify what changed, then rerun with --update.",
  );
}

// --- advertised tools --------------------------------------------------------------------

/** One sorted `kind name` line per entry, so a snapshot diff is a list of names. */
export function toolLines(entries: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [kind, list] of Object.entries(entries)) {
    if (!Array.isArray(list)) continue;
    // claude lists MCP servers as {name, status}; the status moves on its own, the name is the fact.
    for (const v of list) lines.push(`${kind} ${typeof v === "string" ? v : String((v as { name?: unknown })?.name)}`);
  }
  return lines.sort().map((l) => `${l}\n`).join("");
}

/** The lane's `system` init record, taken through the provider itself so flags and jail apply. */
async function initRecord(provider: Provider): Promise<string | null> {
  const ac = new AbortController();
  let init: Record<string, unknown> | undefined;
  const timer = setTimeout(() => ac.abort(), 60_000);
  const onRecord = (r: unknown) => {
    const rec = r as Record<string, unknown> | null;
    if (init || rec?.type !== "system" || !Array.isArray(rec.tools)) return;
    init = rec;
    ac.abort(); // the list is all we came for; no answer needs to be paid for
  };
  try {
    for await (const _ of provider.call({ system: "", prompt: "Reply with: ok", signal: ac.signal, onRecord })) void _;
  } finally {
    clearTimeout(timer);
  }
  return init ? toolLines({ tool: init.tools, mcp: init.mcp_servers }) : null;
}

/** Variant names of `CodexErrorInfo` in the schema the installed codex generates (no model call). */
export function codexErrorVariants(schema: any): string[] {
  const out: string[] = [];
  for (const v of schema?.definitions?.CodexErrorInfo?.oneOf ?? []) {
    if (Array.isArray(v.enum)) out.push(...v.enum);
    else if (Array.isArray(v.required)) out.push(...v.required);
  }
  return out;
}

function codexErrors(): Promise<string | null> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-codex-schema-"));
  return new Promise((resolve) => {
    const child = spawn("codex", ["app-server", "generate-json-schema", "--out", dir], { cwd: config.sandboxDir, env: childEnv(), stdio: "ignore" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    const done = (text: string | null) => {
      clearTimeout(timer);
      fs.rmSync(dir, { recursive: true, force: true });
      resolve(text);
    };
    child.on("error", () => done(null));
    child.on("close", () => {
      try {
        const schema = JSON.parse(fs.readFileSync(path.join(dir, "codex_app_server_protocol.v2.schemas.json"), "utf8"));
        const variants = codexErrorVariants(schema);
        done(variants.length ? toolLines({ error: variants }) : null);
      } catch {
        done(null);
      }
    });
  });
}

async function toolsDiff(update: boolean): Promise<number> {
  // Imported here: loading the providers reads the whole configuration, which the table does not need.
  const { claude, grok } = await import("../src/providers/index.ts");
  const file = (id: string) => path.join(HELP_DIR, `${id}.tools.txt`);
  const unreadable = "no init record (not installed, not logged in, or it timed out)";
  // A lane that advertises nothing is the best case; the header keeps that file from being empty.
  const titled = (id: string, live: () => Promise<string | null>) => async () => {
    const text = await live();
    return text === null ? null : `# what the ${id} lane advertises: npm run check-updates -- --tools-diff\n${text}`;
  };
  console.log(`${"kimi".padEnd(8)} ${dim("prints no tool list; its agent file is the control")}`);
  return snapshotDiff(
    [
      { id: "claude", file: file("claude"), live: titled("claude", () => initRecord(claude)), unreadable },
      { id: "codex", file: file("codex"), live: titled("codex", codexErrors), unreadable: "could not generate the app-server schema" },
      { id: "grok", file: file("grok"), live: titled("grok", () => initRecord(grok)), unreadable },
    ],
    update,
    "A lane now advertises something it did not. Decide whether a flag must remove it (src/providers/index.ts), then rerun with --update.",
  );
}

// --- table -------------------------------------------------------------------------------

async function table(offline: boolean): Promise<number> {
  const verified = verifiedVersions(fs.readFileSync(FIXTURES_README, "utf8"));
  const rows = await Promise.all(
    CLIS.map(async (cli) => {
      const [installed, latest] = await Promise.all([
        cliVersion(cli.id, cli.versionArgs).then(extractVersion),
        offline ? null : latestOnNpm(cli.pkg),
      ]);
      return { id: cli.id, verified: verified.get(cli.id) ?? null, installed, latest };
    }),
  );

  const unverified: string[] = [];
  const behind: string[] = [];
  const col = (s: string | null) => (s ?? "?").padEnd(14);
  console.log(`${"CLI".padEnd(8)} ${col("LAST-VERIFIED")} ${col("INSTALLED")} ${col("LATEST")} STATUS`);
  for (const r of rows) {
    const notes: string[] = [];
    if (r.installed === null) {
      notes.push("not installed");
    } else if (r.verified === null) {
      unverified.push(r.id);
      notes.push(alert("fixtures/README.md records no version — RE-VERIFY"));
    } else if (cmpVersion(r.installed, r.verified) > 0) {
      unverified.push(r.id);
      notes.push(alert("installed build was never verified — RE-VERIFY"));
    } else if (cmpVersion(r.installed, r.verified) < 0) {
      notes.push(warn("older than the verified build"));
    }
    if (r.latest === null) notes.push(dim(offline ? "upstream not checked" : "upstream unreachable"));
    else if (r.installed && cmpVersion(r.latest, r.installed) > 0) {
      behind.push(r.id);
      notes.push("upstream is newer");
    }
    console.log(`${r.id.padEnd(8)} ${col(r.verified)} ${col(r.installed)} ${col(r.latest)} ${notes.join("; ") || dim("ok")}`);
  }

  console.log();
  if (unverified.length) {
    console.log(alert(`Running an unverified build: ${unverified.join(", ")}`));
    console.log("  → npm run smoke, then re-test the CLAUDE.md premises for that CLI and add a row to fixtures/README.md.");
    console.log("  → npm run check-updates -- --help-diff shows the flags that appeared since the last snapshot.");
  }
  if (behind.length) console.log(`Upgrade available (nothing is broken): ${behind.join(", ")}`);
  if (!unverified.length && !behind.length) console.log(dim("Nothing to do."));
  return unverified.length;
}

// --- entry point -------------------------------------------------------------------------

// Guarded so tests can import the parsers above without running a network sweep.
if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const args = process.argv.slice(2);
  const strict = args.includes("--strict");
  const update = args.includes("--update");
  const problems = args.includes("--tools-diff") ? await toolsDiff(update) : args.includes("--help-diff") ? await helpDiff(update) : await table(args.includes("--offline"));
  process.exit(strict && problems ? 1 : 0);
}
