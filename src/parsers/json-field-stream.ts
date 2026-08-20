/**
 * Incrementally extract the value of one top-level string field from a JSON document that
 * arrives in fragments (Anthropic `input_json_delta`). Lets the UI stream the synthesizer's
 * `answer` field while the surrounding JSON is still being generated.
 *
 * Handles JSON string escapes across fragment boundaries. Only the first occurrence of the
 * key at nesting depth 1 is tracked.
 */
export function createJsonFieldStreamer(key: string) {
  const needle = JSON.stringify(key); // "\"answer\""
  let buf = "";
  let phase: "seek" | "colon" | "open" | "in" | "done" = "seek";
  let pending = ""; // incomplete escape sequence carried across fragments
  let depth = 0;
  let inString = false;
  let escaped = false;
  let emitted = "";

  /** Feed a fragment; returns newly decoded characters of the field value. */
  function feed(fragment: string): string {
    if (phase === "done") return "";
    let out = "";
    for (let i = 0; i < fragment.length; i++) {
      const ch = fragment[i]!;
      if (phase === "in") {
        const r = consumeValueChar(ch);
        if (r !== null) out += r;
        continue;
      }
      // Structural scan outside the target value: track depth/strings to find the key at depth 1.
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') {
          inString = false;
          buf += ch;
          if (phase === "seek" && depth === 1 && buf.endsWith(needle)) phase = "colon";
          continue;
        }
        buf += ch;
        continue;
      }
      if (ch === '"') {
        inString = true;
        if (phase === "colon" || phase === "open") {
          // opening quote of the value
          phase = "in";
          inString = false;
          continue;
        }
        buf = ch;
        continue;
      }
      if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") depth--;
      else if (ch === ":" && phase === "colon") phase = "open";
      else if (phase === "open" && !/\s/.test(ch)) {
        // value is not a string (null/number/object): give up on streaming this field
        phase = "done";
      }
      buf += ch;
      if (buf.length > 256) buf = buf.slice(-256);
    }
    emitted += out;
    return out;
  }

  function consumeValueChar(ch: string): string | null {
    if (pending.length > 0) {
      pending += ch;
      if (pending[1] === "u") {
        if (pending.length < 6) return null;
        const cp = Number.parseInt(pending.slice(2), 16);
        pending = "";
        return Number.isNaN(cp) ? "" : String.fromCharCode(cp);
      }
      const m: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
      const r = m[pending[1]!] ?? pending[1]!;
      pending = "";
      return r;
    }
    if (ch === "\\") {
      pending = "\\";
      return null;
    }
    if (ch === '"') {
      phase = "done";
      return null;
    }
    return ch;
  }

  return {
    feed,
    get text() {
      return emitted;
    },
    get done() {
      return phase === "done";
    },
  };
}
