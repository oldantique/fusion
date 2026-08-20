/** Bundle the three browser libraries into web/vendor/bundle.js (no CDN at runtime). */
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
fs.unlinkSync(path.join(outdir, "entry.js"));
