/** Run one provider as a "lane": concurrency cap, retry-once, timing, normalized result. */
import { config } from "../config.ts";
import type { CallOptions, LaneEvent, LaneResult, Provider, ProviderId } from "../types.ts";
import { Semaphore } from "./process.ts";

const semaphores: Record<ProviderId, Semaphore> = {
  claude: new Semaphore(config.concurrency.claude),
  codex: new Semaphore(config.concurrency.codex),
  kimi: new Semaphore(config.concurrency.kimi),
  grok: new Semaphore(config.concurrency.grok),
};

export type LaneSink = (ev: LaneEvent | { type: "status"; status: "queued" | "running"; attempt: number; at: number }) => void;

export async function runLane(provider: Provider, opts: CallOptions, sink: LaneSink): Promise<LaneResult> {
  const started = Date.now();
  const sem = semaphores[provider.id];
  if (sem.isFull) {
    sink({ type: "status", status: "queued", attempt: 0, at: Date.now() });
  }
  const release = await sem.acquire();
  let lastError = "unknown";
  let attempt = 0;
  try {
    for (attempt = 1; attempt <= config.laneAttempts; attempt++) {
      if (opts.signal?.aborted) {
        lastError = "aborted";
        break;
      }
      sink({ type: "status", status: "running", attempt, at: Date.now() });
      let text: string | null = null;
      let usage: LaneResult["usage"];
      let error: string | null = null;
      for await (const ev of provider.call(opts)) {
        if (ev.type === "done") {
          text = ev.text;
          usage = ev.usage;
        } else if (ev.type === "error") {
          error = ev.message;
        }
        sink(ev);
      }
      if (error === null && text !== null && text.trim().length > 0) {
        return { provider: provider.id, status: "done", answer: text, ms: Date.now() - started, error: null, exitCode: 0, attempts: attempt, usage };
      }
      lastError = error ?? "empty answer";
      if (lastError === "aborted") break;
    }
  } finally {
    release();
  }
  return {
    provider: provider.id,
    status: "failed",
    answer: null,
    ms: Date.now() - started,
    error: lastError,
    exitCode: null,
    attempts: Math.min(attempt, config.laneAttempts),
    usage: undefined,
  };
}
