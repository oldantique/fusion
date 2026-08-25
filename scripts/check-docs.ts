/**
 * Mechanical drift check for the documentation layer. Verifies that the docs only point at
 * things that exist, and that facts with a single home are not restated elsewhere:
 *
 *  1. every `npm run <x>` / script name named in docs exists in package.json
 *  2. every repo path named in docs (backticked, under a known top-level dir) exists
 *  3. .env.example and src/config.ts agree on the set of environment variables
 *  4. every env var named in docs is declared in .env.example
 *  5. version-number-looking strings appear only in fixtures/README.md and CHANGELOG.md
 *  6. web/ (outside vendor/) references no remote http(s) resource — every library is bundled locally
 *
 * Exported as a function so tests/docs.test.ts can run it under `npm test`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = ["README.md", "CLAUDE.md", "CHANGELOG.md", "SECURITY.md", "docs/DESIGN.md", "docs/RUNBOOK.md", "docs/THREADS.md", "fixtures/README.md", "deploy/fusion.service", ".claude/skills/sync-docs/SKILL.md"];
const PATH_ROOTS = ["src", "web", "scripts", "tests", "fixtures", "deploy", "docs", "data", ".claude"];
const ROOT_FILES = ["README.md", "CLAUDE.md", "CHANGELOG.md", "SECURITY.md", "LICENSE", "package.json", "tsconfig.json", ".env", ".env.example", ".gitignore"];
const VERSION_HOMES = new Set(["fixtures/README.md", "CHANGELOG.md"]);

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

export function checkDocs(): string[] {
  const problems: string[] = [];
  const pkg = JSON.parse(read("package.json"));
  const scripts = new Set(Object.keys(pkg.scripts ?? {}));

  const envExample = new Set([...read(".env.example").matchAll(/^([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]!));
  const configSrc = read("src/config.ts");
  const envConfig = new Set([...configSrc.matchAll(/(?:process\.env\.|int\(")([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]!));
  for (const k of envConfig) if (!envExample.has(k)) problems.push(`.env.example: missing ${k} (read in src/config.ts)`);
  for (const k of envExample) if (!envConfig.has(k)) problems.push(`src/config.ts: never reads ${k} (declared in .env.example)`);

  for (const doc of DOCS) {
    const text = read(doc);

    for (const m of text.matchAll(/npm run ([a-z:-]+)/g)) {
      if (!scripts.has(m[1]!)) problems.push(`${doc}: npm run ${m[1]} — no such script`);
    }

    for (const m of text.matchAll(/`([^`\s]+)`/g)) {
      const tok = m[1]!.replace(/[.,:;)]+$/, "");
      const isPath = PATH_ROOTS.some((r) => tok === r + "/" || tok.startsWith(r + "/")) || ROOT_FILES.includes(tok);
      if (!isPath || tok.includes("*") || tok.startsWith("data/") || tok === ".env") continue;
      if (!fs.existsSync(path.join(ROOT, tok))) problems.push(`${doc}: path ${tok} does not exist`);
    }

    for (const m of text.matchAll(/\b((?:FUSION|CLAUDE|CODEX|KIMI|GROK|LANE|HISTORY)_[A-Z0-9_]+)\b/g)) {
      if (!envExample.has(m[1]!)) problems.push(`${doc}: env var ${m[1]} not declared in .env.example`);
    }

    if (!VERSION_HOMES.has(doc)) {
      for (const m of text.matchAll(/\b\d+\.\d+\.\d+\b/g)) {
        problems.push(`${doc}: version-like "${m[0]}" — versions belong in fixtures/README.md or CHANGELOG.md`);
      }
    }
  }
  // 6. no CDN, ever: the frontend must work with no network beyond the Fusion server itself.
  for (const f of fs.readdirSync(path.join(ROOT, "web")).filter((f) => /\.(html|js|css)$/.test(f))) {
    for (const m of read(`web/${f}`).matchAll(/https?:\/\/[^\s"'`)<>]+/g)) {
      problems.push(`web/${f}: remote reference ${m[0]} — bundle it via scripts/build-vendor.ts instead`);
    }
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = checkDocs();
  for (const p of problems) console.log(`✗ ${p}`);
  console.log(problems.length ? `${problems.length} problem(s)` : "docs consistent");
  process.exit(problems.length ? 1 : 0);
}
