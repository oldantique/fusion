/** Run one fusion turn from the terminal; prints lane progress to stderr and the result to stdout. */
import { fuse } from "../src/synth/fuse.ts";
import type { ProviderId } from "../src/types.ts";

const question = process.argv[2];
if (!question) {
  console.error("usage: fuse-cli.ts <question> [claude,codex,kimi,grok]");
  process.exit(2);
}
const ids = (process.argv[3]?.split(",") as ProviderId[] | undefined) ?? ["claude", "codex", "kimi", "grok"];
let synthText = "";
const out = await fuse({
  question,
  history: [],
  providerIds: ids,
  onEvent: (ev) => {
    if (ev.type === "lane" && ev.status !== "delta") console.error(`[lane ${ev.provider}] ${ev.status}${"result" in ev ? ` ${ev.result.ms}ms ${ev.result.error ?? ""}` : ""}`);
    if (ev.type === "synth" && ev.status === "delta") synthText += ev.text;
    else if (ev.type === "synth") console.error(`[synth] ${ev.status} ${"provider" in ev ? ev.provider : ""} ${"reason" in ev ? ev.reason : ""}`);
    if (ev.type === "error") console.error(`[error] ${ev.message}`);
  },
});
console.error(`streamed synth chars: ${synthText.length}${out.synthesis ? `; synth ${out.synthesis.provider} ${out.synthesis.ms}ms` : ""}`);
console.log("\n===== ANSWER =====\n" + out.answer);
console.log("\n===== ANALYSIS =====\n" + JSON.stringify(out.synthesis?.analysis, null, 2));
console.log("\n===== LETTERS =====\n" + JSON.stringify(out.synthesis?.letterMap));
for (const l of out.lanes) console.log(`\n----- ${l.provider} (${l.status}, ${l.ms}ms) -----\n${(l.answer ?? l.error ?? "").slice(0, 400)}`);
