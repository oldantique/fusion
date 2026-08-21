/**
 * LaTeX extraction for the markdown pipeline.
 *
 * Math has to be pulled out *before* marked runs: `_`, `\`, `*` and `{}` all mean something to
 * markdown and would be mangled (or eaten as emphasis) on the way through. So `splitMath()`
 * replaces every math span with an inert alphanumeric token, the caller renders + sanitizes the
 * markdown as usual, and `restoreMath()` swaps the tokens for rendered math afterwards.
 *
 * Two constraints shape the scanner:
 *   - Code wins. Anything inside a fenced block or an inline code span is copied verbatim, so a
 *     `$` in a shell snippet is never mistaken for math.
 *   - Answers stream. Every delta is re-rendered, so a half-arrived `$$` must degrade to literal
 *     text rather than swallowing the rest of the answer: an unterminated opener emits its own
 *     characters and the scan continues past it.
 */

const OPEN = "xxMATHxx";
const CLOSE = "xxENDxx";
const TOKEN_RE = /xxMATHxx(\d+)xxENDxx/g;

const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** End index of the fenced code block opening at `i` (which must be at a line start), or -1. */
function fenceEnd(s, i) {
  const ch = s[i];
  let n = 0;
  while (s[i + n] === ch) n++;
  if (n < 3) return -1;
  let j = s.indexOf("\n", i);
  if (j < 0) return s.length; // unterminated fence: the rest of the text is code
  j++;
  while (j < s.length) {
    let k = j;
    while (s[k] === " ") k++;
    let m = 0;
    while (s[k + m] === ch) m++;
    if (m >= n) {
      const nl = s.indexOf("\n", k + m);
      return nl < 0 ? s.length : nl + 1;
    }
    const nl = s.indexOf("\n", j);
    if (nl < 0) return s.length;
    j = nl + 1;
  }
  return s.length;
}

/** End index of the inline code span opening at `i`, or -1 when the run never closes. */
function codeSpanEnd(s, i) {
  let n = 0;
  while (s[i + n] === "`") n++;
  let j = i + n;
  while (j < s.length) {
    if (s[j] === "\n" && /^[ \t]*\n/.test(s.slice(j + 1))) return -1; // blank line ends a code span
    if (s[j] === "`") {
      let m = 0;
      while (s[j + m] === "`") m++;
      if (m === n) return j + m;
      j += m;
      continue;
    }
    j++;
  }
  return -1;
}

/**
 * Split markdown into text with math placeholders plus the extracted TeX.
 * @param {string} md
 * @returns {{ text: string, blocks: { tex: string, display: boolean }[] }}
 */
/** The [start, end) spans of every fenced block and inline code span, in order. */
function codeRanges(s) {
  const ranges = [];
  let i = 0;
  let lineStart = true;
  while (i < s.length) {
    const c = s[i];
    if (lineStart && (c === "`" || c === "~")) {
      const end = fenceEnd(s, i);
      if (end > 0) {
        ranges.push([i, end]);
        i = end;
        lineStart = s[i - 1] === "\n";
        continue;
      }
    }
    if (c === "`") {
      const end = codeSpanEnd(s, i);
      if (end > 0) {
        ranges.push([i, end]);
        i = end;
        lineStart = false;
        continue;
      }
    }
    if (c === "\\" && s[i + 1] !== undefined) { i += 2; lineStart = false; continue; }
    lineStart = c === "\n";
    i++;
  }
  return ranges;
}

export function splitMath(md) {
  const s = String(md ?? "");
  const code = codeRanges(s);
  const blocks = [];
  let out = "";
  let i = 0;
  let next = 0; // index into `code` of the first range that has not been passed yet

  const push = (tex, display) => {
    out += OPEN + blocks.length + CLOSE;
    blocks.push({ tex, display });
  };
  /**
   * Consume `open`…`close`. The closer is only looked for up to the next code region: a stray
   * `$$` must not reach into a later code block and swallow it, which is exactly what a
   * half-streamed opener would otherwise do.
   */
  const span = (open, close, display, sameLine, limit) => {
    const from = i + open.length;
    const end = s.indexOf(close, from);
    if (end < 0 || end + close.length > limit) return false;
    const tex = s.slice(from, end);
    if (sameLine && /\n/.test(tex)) return false;
    push(tex, display);
    i = end + close.length;
    return true;
  };

  while (i < s.length) {
    while (next < code.length && code[next][1] <= i) next++;
    if (next < code.length && code[next][0] <= i) {
      out += s.slice(i, code[next][1]); // code is copied through untouched
      i = code[next][1];
      continue;
    }
    const limit = next < code.length ? code[next][0] : s.length;
    const c = s[i];

    if (c === "\\") {
      const n = s[i + 1];
      if (n === "[" && span("\\[", "\\]", true, false, limit)) continue;
      if (n === "(" && span("\\(", "\\)", false, true, limit)) continue;
      if (n !== undefined) { out += c + n; i += 2; continue; } // markdown escape
    }
    if (c === "$") {
      if (s[i + 1] === "$") {
        if (span("$$", "$$", true, false, limit)) continue;
      } else {
        // Inline `$…$`: no newline, no space hugging either delimiter, and no digit right after
        // the closer — that is what keeps prose like "$5 and $6" out of the math path.
        const m = /^\$(?![\s$])((?:[^$\n\\]|\\.)*?)(?<![\s])\$(?![\d$])/.exec(s.slice(i, limit));
        if (m) {
          push(m[1], false);
          i += m[0].length;
          continue;
        }
      }
    }
    out += c;
    i++;
  }
  return { text: out, blocks };
}

/**
 * Put rendered math back into sanitized HTML.
 * @param {string} html
 * @param {{ tex: string, display: boolean }[]} blocks
 * @param {(tex: string, display: boolean) => string} render trusted renderer (KaTeX)
 */
export function restoreMath(html, blocks, render) {
  if (!blocks.length) return html;
  return String(html).replace(TOKEN_RE, (whole, n) => {
    const b = blocks[Number(n)];
    if (!b) return whole;
    try {
      return render(b.tex, b.display);
    } catch {
      const d = b.display ? "$$" : "$";
      return escapeHtml(d + b.tex + d);
    }
  });
}
