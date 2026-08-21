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
