/** Math extraction: what the browser pipeline does to LaTeX before and after marked runs. */
import test from "node:test";
import assert from "node:assert/strict";
import { marked } from "marked";
import katex from "katex";
import "katex/contrib/mhchem"; // side effect: teaches the bundled KaTeX \ce and \pu
// @ts-expect-error - plain browser ES module, no types
import { splitMath, restoreMath } from "../web/math.js";

type Block = { tex: string; display: boolean };
const split = (md: string) => splitMath(md) as { text: string; blocks: Block[] };
/** Stand-in for katex.renderToString, so the assertions read as "what got handed to KaTeX". */
const fake = (tex: string, display: boolean) => `<${display ? "DISPLAY" : "INLINE"}:${tex}>`;
const pipeline = (md: string) => {
  const { text, blocks } = split(md);
  return restoreMath(marked.parse(text) as string, blocks, fake);
};

test("display math: $$…$$ and \\[…\\]", () => {
  const { text, blocks } = split("before $$a+b$$ after\n\n\\[c+d\\]\n");
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], { tex: "a+b", display: true });
  assert.deepEqual(blocks[1], { tex: "c+d", display: true });
  assert.match(text, /^before xxMATHxx0xxENDxx after/);
});

test("inline math: $…$ and \\(…\\)", () => {
  const { blocks } = split("mass $E=mc^2$ and \\(x_1\\) done");
  assert.deepEqual(blocks, [
    { tex: "E=mc^2", display: false },
    { tex: "x_1", display: false },
  ]);
});

test("math inside fenced code and inline code is left alone", () => {
  const md = "```sh\necho $$x$$ $PATH\n```\n\nand `$a+b$` too\n";
  const { text, blocks } = split(md);
  assert.deepEqual(blocks, []);
  assert.equal(text, md);
});

test("currency is not math", () => {
  for (const md of ["it costs $5 and $6 total", "$5 and $6", "from $10 to $20."]) {
    assert.deepEqual(split(md).blocks, [], md);
  }
});

test("an unterminated $$ streams through as literal text", () => {
  const md = "here it comes $$\\sum_{x}\\alpha";
  const { text, blocks } = split(md);
  assert.deepEqual(blocks, []);
  assert.equal(text, md);
  assert.doesNotThrow(() => pipeline(md));
});

test("an unterminated $$ never borrows a closer from a later code block", () => {
  // Regression: a half-streamed opener used to reach into the fence and eat the code with it.
  const md = "half arrived $$\\frac{a}{b\n\n```tex\n$$not math$$\n```\n";
  const { text, blocks } = split(md);
  assert.deepEqual(blocks, []);
  assert.equal(text, md);
  assert.ok((pipeline(md).match(/<code/) ?? []).length === 1);
});

test("a later complete span still renders after an unterminated one", () => {
  const { blocks } = split("stray $ then $E=mc^2$ ok");
  assert.deepEqual(blocks, [{ tex: "E=mc^2", display: false }]);
});

test("underscores, backslashes and braces survive marked", () => {
  const tex = "|\\psi\\rangle=\\sum_{x\\in\\{0,1\\}^n}\\alpha_x|x\\rangle";
  const html = pipeline(`answer:\n\n$$${tex}$$\n`);
  assert.ok(html.includes(`<DISPLAY:${tex}>`), html);
  assert.ok(!html.includes("<em>"), "markdown ate an underscore pair");
});

test("restoreMath falls back to escaped source when the renderer throws", () => {
  const { text, blocks } = split("$a<b$");
  const html = restoreMath(text, blocks, () => {
    throw new Error("boom");
  });
  assert.equal(html, "$a&lt;b$");
});

test("no math means the html is returned untouched", () => {
  const md = "plain **text** only";
  const { text, blocks } = split(md);
  assert.equal(text, md);
  assert.equal(restoreMath("<p>x</p>", blocks, fake), "<p>x</p>");
});

test("the vendored KaTeX understands mhchem's \\ce", () => {
  // \ce only exists because the vendor entry imports katex/contrib/mhchem for its side effect;
  // drop that import and this renders as a red \ce error instead of a formula.
  const html = katex.renderToString("\\ce{H2O}", { throwOnError: false, output: "html" });
  assert.doesNotMatch(html, /katex-error/, html);
  assert.match(html, /<span class="mord mathrm">H<\/span>/);
  assert.match(html, /msupsub/); // the 2 is set as a subscript, not literal text
});
