/** Bundle the browser libraries into web/vendor/bundle.js (no CDN at runtime). */
import { build } from "esbuild";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = path.join(root, "web", "vendor");
fs.mkdirSync(outdir, { recursive: true });
fs.writeFileSync(
  path.join(outdir, "entry.js"),
  `export { marked } from "marked";
export { default as DOMPurify } from "dompurify";
export { default as hljs } from "highlight.js/lib/common";
export { default as katex } from "katex";
// mhchem registers \\ce and \\pu on the katex singleton as a side effect; chemistry questions
// are common enough that it is worth ~40kb in the always-loaded bundle.
import "katex/contrib/mhchem";
`,
);
await build({
  entryPoints: [path.join(outdir, "entry.js")],
  bundle: true,
  format: "esm",
  minify: true,
  outfile: path.join(outdir, "bundle.js"),
  logLevel: "info",
});
// mermaid is an order of magnitude larger than everything else here put together, and most
// answers contain no diagram at all — so it gets its own ESM file that app.js import()s the
// first time a `mermaid` fence shows up, instead of riding along in the main bundle.
fs.writeFileSync(path.join(outdir, "mermaid-entry.js"), `export { default } from "mermaid";\n`);
await build({
  entryPoints: [path.join(outdir, "mermaid-entry.js")],
  bundle: true,
  format: "esm",
  minify: true,
  // mermaid dynamically import()s each diagram type; without splitting esbuild inlines those
  // into the one file, which is what we want (a lazy chunk of a lazy chunk buys nothing).
  splitting: false,
  define: { "process.env.NODE_ENV": '"production"' },
  outfile: path.join(outdir, "mermaid.js"),
  logLevel: "info",
});
fs.unlinkSync(path.join(outdir, "mermaid-entry.js"));

for (const f of ["github.min.css", "github-dark.min.css"]) {
  fs.copyFileSync(path.join(root, "node_modules", "highlight.js", "styles", f), path.join(outdir, f));
}
// KaTeX ships its stylesheet separately; the CSS resolves its faces against a relative fonts/
// directory, so it has to keep that name next to the copied file. Only the woff2 faces are
// copied: they are first in every src list and universally supported, while the woff/ttf
// fallbacks would triple the size of the vendor directory for browsers we do not target.
const katexDist = path.join(root, "node_modules", "katex", "dist");
fs.copyFileSync(path.join(katexDist, "katex.min.css"), path.join(outdir, "katex.min.css"));
const fontsOut = path.join(outdir, "fonts");
fs.rmSync(fontsOut, { recursive: true, force: true });
fs.mkdirSync(fontsOut, { recursive: true });
for (const f of fs.readdirSync(path.join(katexDist, "fonts"))) {
  if (f.endsWith(".woff2")) fs.copyFileSync(path.join(katexDist, "fonts", f), path.join(fontsOut, f));
}
fs.unlinkSync(path.join(outdir, "entry.js"));
