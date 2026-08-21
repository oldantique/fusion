/**
 * The browser's markdown pipeline minus the sanitizer (DOMPurify needs a DOM): marked with the
 * footnote extension, fed text that has already been through the math extraction. What is pinned
 * here is that the two features do not eat each other — the sanitizer's own behaviour towards
 * footnote ids is checked in the browser instead.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { marked } from "marked";
import markedFootnote from "marked-footnote";
// @ts-expect-error - plain browser ES module, no types
import { splitMath, restoreMath } from "../web/math.js";

marked.setOptions({ gfm: true, breaks: false });
marked.use(markedFootnote());

const fake = (tex: string, display: boolean) => `<${display ? "DISPLAY" : "INLINE"}:${tex}>`;
function render(md: string) {
  const { text, blocks } = splitMath(md) as { text: string; blocks: { tex: string; display: boolean }[] };
  return restoreMath(marked.parse(text) as string, blocks, fake) as string;
}

test("a footnote reference and its definition end up linked", () => {
  const html = render("Water is wet[^1].\n\n[^1]: See the paper.\n");
  assert.match(html, /<sup><a id="footnote-ref-1" href="#footnote-1"/);
  assert.match(html, /<section class="footnotes"/);
  assert.match(html, /<li id="footnote-1">/);
  assert.ok(!html.includes("[^1]"), "the raw reference leaked into the output");
});

test("math inside a footnote definition still renders", () => {
  const html = render("claim[^a]\n\n[^a]: because $E=mc^2$.\n");
  assert.match(html, /<li id="footnote-a">[\s\S]*<INLINE:E=mc\^2>/);
});

test("a footnote marker in code is left alone", () => {
  const html = render("use `arr[^1]` here\n");
  assert.match(html, /<code>arr\[\^1\]<\/code>/);
  assert.ok(!html.includes("footnotes"), "a code span was turned into a footnote");
});
