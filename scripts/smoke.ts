/** Smoke test: run every provider once with a trivial prompt and print timing/outcome. */
import { providers } from "../src/providers/index.ts";
import { runLane } from "../src/providers/lane.ts";
import type { ProviderId } from "../src/types.ts";

const ids = (process.argv[2]?.split(",") as ProviderId[] | undefined) ?? (Object.keys(providers) as ProviderId[]);
const prompt = process.argv[3] ?? "In one sentence, what is the capital of France?";
const system = "You are a general assistant. Answer directly in markdown. Do not read, write, or execute anything.";

await Promise.all(
  ids.map(async (id) => {
    let deltas = 0;
    const r = await runLane(providers[id], { prompt, system }, (ev) => {
      if (ev.type === "delta") deltas++;
      if (ev.type === "status") console.error(`[${id}] ${ev.status} attempt=${ev.attempt}`);
      if (ev.type === "error") console.error(`[${id}] error: ${ev.message}`);
    });
    console.log(`${id.padEnd(6)} ${r.status.padEnd(6)} ${String(r.ms).padStart(6)}ms deltas=${deltas} attempts=${r.attempts} cost=${r.usage?.costUsd ?? "-"} :: ${(r.answer ?? r.error ?? "").slice(0, 80).replace(/\n/g, " ")}`);
  }),
);
