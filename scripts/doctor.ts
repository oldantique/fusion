/** Check that the four CLIs are installed and logged in (no model calls). */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const run = promisify(execFile);
const ok = (s: string) => `\x1b[32m${s}\x1b[0m`;
const bad = (s: string) => `\x1b[31m${s}\x1b[0m`;

/**
 * First line of `<cli> --version` (or of a status subcommand), or null when the binary is not on
 * PATH / the call failed. Exported because `scripts/check-updates.ts` needs the same detection.
 */
export async function cliVersion(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout, stderr } = await run(cmd, args, { timeout: 20_000 });
    return (stdout || stderr).trim().split("\n")[0] ?? "";
  } catch {
    return null;
  }
}

const home = os.homedir();
const checks: { name: string; version: () => Promise<string | null>; auth: () => Promise<string> }[] = [
  {
    name: "claude",
    version: () => cliVersion("claude", ["--version"]),
    auth: async () => {
      // `claude auth status` exists in recent versions; fall back to the credentials file.
      const v = await cliVersion("claude", ["auth", "status"]);
      if (v && /logged in|authenticated|oauth/i.test(v)) return v;
      return fs.existsSync(path.join(home, ".claude", ".credentials.json")) ? "credentials file present" : "NOT logged in (run `claude`)";
    },
  },
  {
    name: "codex",
    version: () => cliVersion("codex", ["--version"]),
    auth: async () => {
      const v = await cliVersion("codex", ["login", "status"]);
      if (v) return v;
      return fs.existsSync(path.join(home, ".codex", "auth.json")) ? "auth.json present" : "NOT logged in (run `codex login`)";
    },
  },
  {
    name: "kimi",
    version: () => cliVersion("kimi", ["--version"]),
    auth: async () => {
      const dir = path.join(home, ".kimi-code");
      if (!fs.existsSync(dir)) return "NOT configured (run `kimi`)";
      const files = fs.readdirSync(dir);
      return files.some((f) => /auth|credential|token/i.test(f)) ? "credentials present" : `config dir present (${files.length} files)`;
    },
  },
  {
    name: "grok",
    version: () => cliVersion("grok", ["--version"]),
    auth: async () => {
      const dir = path.join(home, ".grok");
      if (!fs.existsSync(dir)) return "NOT configured (run `grok`)";
      const files = fs.readdirSync(dir);
      return files.some((f) => /auth|credential|token|oauth/i.test(f)) ? "credentials present" : `config dir present (${files.length} files)`;
    },
  },
];

// Script entry point; importing this module (check-updates.ts) must not run the checks.
if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  let failures = 0;
  for (const c of checks) {
    const v = await c.version();
    if (v === null) {
      failures++;
      console.log(`${bad("✗")} ${c.name.padEnd(7)} not found on PATH`);
      continue;
    }
    const a = await c.auth();
    const good = !/NOT/.test(a);
    if (!good) failures++;
    console.log(`${good ? ok("✓") : bad("✗")} ${c.name.padEnd(7)} ${v.padEnd(28)} ${a}`);
  }
  // The jail: bwrap must exist and be allowed to create namespaces on this host (not every
  // kernel/distro permits unprivileged user namespaces).
  const bw = await cliVersion("bwrap", ["--ro-bind", "/", "/", "true"]);
  if (bw === null) {
    failures++;
    console.log(`${bad("✗")} bwrap   missing or cannot create a sandbox here — lanes will refuse to start (FUSION_JAIL=off to bypass)`);
  } else {
    console.log(`${ok("✓")} bwrap   ${(await cliVersion("bwrap", ["--version"]))?.padEnd(28)} sandbox works`);
  }
  const sandbox = path.resolve(import.meta.dirname, "..", "data", "sandbox");
  const leaks = fs.existsSync(sandbox) ? fs.readdirSync(sandbox).filter((f) => /^(CLAUDE|AGENTS)\.md$|^\.claude$/.test(f)) : [];
  if (leaks.length) {
    failures++;
    console.log(`${bad("✗")} sandbox dir contains ${leaks.join(", ")} — it must stay empty`);
  }
  console.log(failures ? bad(`${failures} problem(s)`) : ok("all good"));
  process.exit(failures ? 1 : 0);
}
