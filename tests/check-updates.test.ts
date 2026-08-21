/** The fixtures/README.md version parser: it decides whether we are running an unverified CLI. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cmpVersion, extractVersion, verifiedVersions } from "../scripts/check-updates.ts";

test("extractVersion pulls the number out of each CLI's --version line", () => {
  assert.equal(extractVersion("2.1.238 (Claude Code)"), "2.1.238");
  assert.equal(extractVersion("codex-cli 0.147.0"), "0.147.0");
  assert.equal(extractVersion("grok 1.0.3 (1a29d5bc12)"), "1.0.3");
  assert.equal(extractVersion("0.38.0"), "0.38.0");
  assert.equal(extractVersion(null), null);
  assert.equal(extractVersion("not a version"), null);
});

test("cmpVersion compares numerically, and a prerelease sorts below its release", () => {
  assert.ok(cmpVersion("0.147.0", "0.9.0") > 0);
  assert.ok(cmpVersion("2.1.237", "2.1.238") < 0);
  assert.equal(cmpVersion("1.0.3", "1.0.3"), 0);
  assert.ok(cmpVersion("0.1.0-rc.6", "0.1.0") < 0);
});

test("verifiedVersions takes the highest version per CLI across all rows", () => {
  const readme = [
    "| 2026-01-01 | claude 2.1.237 · codex-cli 0.147.0 · kimi 0.36.1 · grok 1.0.3 |",
    "| 2026-01-02 | kimi 0.38.0 — same shapes as `kimi.ndjson`; fixture unchanged |",
    "Files: `claude.ndjson`, `codex.ndjson`, `kimi.ndjson`, `grok.ndjson`.",
  ].join("\n");
  const v = verifiedVersions(readme);
  assert.equal(v.get("claude"), "2.1.237");
  assert.equal(v.get("codex"), "0.147.0"); // recorded as "codex-cli", reported under the provider id
  assert.equal(v.get("kimi"), "0.38.0"); // the later row wins because it is higher, not because it is later
  assert.equal(v.get("grok"), "1.0.3");
});

test("every CLI has a verified version in the real fixtures/README.md", () => {
  const readme = fs.readFileSync(path.resolve(import.meta.dirname, "..", "fixtures", "README.md"), "utf8");
  const v = verifiedVersions(readme);
  for (const id of ["claude", "codex", "kimi", "grok"]) assert.ok(v.get(id), `no verified version recorded for ${id}`);
});
