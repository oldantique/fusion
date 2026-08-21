/** The bwrap jail: argv builder is an allowlist, and a timeout inside the jail leaves no orphans. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cliInstallDirs, jailArgv, runLines } from "../src/providers/process.ts";
import { config } from "../src/config.ts";

const NODE = process.execPath;
const home = "/home/someone";
const env = { PATH: "/usr/bin", HOME: "/real/home", SSH_AUTH_SOCK: "/run/ssh", CLAUDE_CODE_X: "1", NODE_OPTIONS: "--x" };

test("jailArgv: base, provider mounts and an env allowlist; nothing else", () => {
  const { cmd, args, env: jenv } = jailArgv(
    "claude",
    ["-p", "hi"],
    { rw: ["~/.claude", "~/.claude.json"], ro: ["~/agent.md"] },
    env,
    "/srv/sandbox",
    { home, exists: () => true, installDirs: ["/opt/cli"] },
  );
  assert.equal(cmd, "bwrap");
  assert.equal(args[0], "--clearenv");
  const pairs = (flag: string) => args.flatMap((a, i) => (a === flag ? [`${args[i + 1]}=>${args[i + 2]}`] : []));
  assert.deepEqual(pairs("--bind"), ["/home/someone/.claude=>/home/someone/.claude", "/home/someone/.claude.json=>/home/someone/.claude.json", "/srv/sandbox=>/srv/sandbox"]);
  assert.ok(pairs("--ro-bind").includes("/opt/cli=>/opt/cli"));
  assert.ok(pairs("--ro-bind").includes("/home/someone/agent.md=>/home/someone/agent.md"));
  assert.ok(pairs("--ro-bind").includes("/etc/resolv.conf=>/etc/resolv.conf"));
  assert.ok(!pairs("--ro-bind").some((p) => p.startsWith("/etc=>")), "/etc as a whole is never exposed");
  assert.ok(pairs("--tmpfs").includes("/home/someone=>--tmpfs") || args.includes("--tmpfs"), "HOME is a tmpfs");
  assert.ok(args.indexOf("--tmpfs") < args.indexOf("--bind"), "tmpfs HOME comes before the binds into it");
  // env: allowlisted keys only, HOME forced to the jail's home
  assert.deepEqual(jenv, { PATH: "/usr/bin", HOME: home, NODE_OPTIONS: "--x" });
  assert.ok(!args.includes("SSH_AUTH_SOCK"));
  // the command follows the separator unchanged
  const sep = args.indexOf("--");
  assert.deepEqual(args.slice(sep + 1), ["claude", "-p", "hi"]);
  assert.ok(args.includes("--unshare-pid") && args.includes("--die-with-parent"));
});

test("jailArgv: missing mount sources are skipped rather than passed to bwrap", () => {
  const { args } = jailArgv("x", [], { rw: ["~/.nope"] }, env, "/srv/sandbox", { home, exists: (p) => p === "/srv/sandbox", installDirs: [] });
  assert.ok(!args.some((a) => a.includes(".nope")));
});

test("cliInstallDirs: an npm global symlink maps to its bin dir and the node_modules root", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-jail-"));
  const pkg = path.join(tmp, "lib", "node_modules", "@vendor", "tool", "bin");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "tool.js"), "");
  fs.mkdirSync(path.join(tmp, "bin"));
  fs.symlinkSync(path.join(pkg, "tool.js"), path.join(tmp, "bin", "tool"));
  const dirs = cliInstallDirs("tool", { PATH: path.join(tmp, "bin") });
  assert.deepEqual(dirs, [path.join(tmp, "bin"), path.join(fs.realpathSync(tmp), "lib", "node_modules")]);
  assert.deepEqual(cliInstallDirs("definitely-not-installed", { PATH: "/usr/bin" }), []);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("inside the jail: the CLI sees a home with only its mounts, and a timeout kills everything in it", { skip: !config.bwrapPath || !config.jail }, async () => {
  const marker = `fusion-jail-test-${crypto.randomBytes(6).toString("hex")}`;
  const script = `
    const fs = require("node:fs");
    const { spawn } = require("node:child_process");
    console.log(JSON.stringify(fs.readdirSync(process.env.HOME)));
    spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60_000)", "${marker}"], { stdio: "ignore" });
    setTimeout(()=>{}, 60_000);`;
  const lines: string[] = [];
  let exit: any;
  for await (const item of runLines({ cmd: NODE, args: ["-e", script], timeoutMs: 1_500, cwd: process.cwd(), jail: { ro: ["~/.bashrc"] } })) {
    if (item.kind === "line") lines.push(item.line);
    else exit = item;
  }
  assert.equal(exit.timedOut, true, `exit: ${JSON.stringify(exit)}`);
  const seen = JSON.parse(lines[0]) as string[];
  assert.ok(!seen.includes(".ssh") && !seen.includes(".config"), `jail HOME leaked: ${seen.join(",")}`);
  await new Promise((r) => setTimeout(r, 500));
  let survivors = "";
  try {
    survivors = execFileSync("pgrep", ["-f", marker], { encoding: "utf8" });
  } catch {
    /* pgrep exits 1 when nothing matches */
  }
  assert.equal(survivors.trim(), "", "a grandchild survived the jail being killed");
});
