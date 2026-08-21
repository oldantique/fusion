/**
 * Run one provider as a "lane": concurrency cap, classified retry, timing, normalized result.
 * A lane never rejects — every failure (including a provider bug) becomes a failed LaneResult,
 * so one broken lane cannot take the turn down with it.
 */
import { config } from "../config.ts";
import type { CallOptions, LaneErrorKind, LaneEvent, LaneResult, Provider, ProviderId } from "../types.ts";
import { AbortedError, Semaphore } from "./process.ts";

const semaphores: Record<ProviderId, Semaphore> = {
  claude: new Semaphore(config.concurrency.claude),
  codex: new Semaphore(config.concurrency.codex),
  kimi: new Semaphore(config.concurrency.kimi),
  grok: new Semaphore(config.concurrency.grok),
};

export type LaneSink = (ev: LaneEvent | { type: "status"; status: "queued" | "running"; attempt: number; at: number }) => void;

const RETRYABLE: ReadonlySet<LaneErrorKind> = new Set(["exit", "empty"]);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

export async function runLane(provider: Provider, opts: CallOptions, sink: LaneSink): Promise<LaneResult> {
  const maxAttempts = Math.max(1, opts.attempts ?? config.laneAttempts);
  const sem = semaphores[provider.id];
  const failed = (error: string, errorKind: LaneErrorKind, attempts: number, ms: number): LaneResult => ({
    provider: provider.id,
    status: "failed",
    answer: null,
    ms,
    error,
    errorKind,
    attempts,
    usage: undefined,
  });

  if (sem.isFull) sink({ type: "status", status: "queued", attempt: 0, at: Date.now() });
  let release: () => void;
  try {
    release = await sem.acquire(opts.signal);
  } catch (e) {
    return e instanceof AbortedError ? failed("aborted", "aborted", 0, 0) : failed(`internal: ${(e as Error).message}`, "internal", 0, 0);
  }

  // Measured from the first real attempt, not from queue entry, so a queued lane's time is its own.
  const started = Date.now();
  let lastError = "unknown";
  let lastKind: LaneErrorKind = "internal";
  let attempt = 0;
  try {
    for (attempt = 1; attempt <= maxAttempts; attempt++) {
      if (opts.signal?.aborted) return failed("aborted", "aborted", attempt - 1, Date.now() - started);
      sink({ type: "status", status: "running", attempt, at: Date.now() });
      let text: string | null = null;
      let usage: LaneResult["usage"];
      let error: string | null = null;
      let kind: LaneErrorKind = "internal";
      try {
        for await (const ev of provider.call(opts)) {
          if (ev.type === "done") {
            text = ev.text;
            usage = ev.usage;
          } else if (ev.type === "error") {
            error = ev.message;
            kind = ev.kind;
          }
          sink(ev);
        }
      } catch (e) {
        // A throw here is a bug in a provider/parser, not a CLI failure; report, don't retry.
        return failed(`internal: ${e instanceof Error ? e.message : String(e)}`, "internal", attempt, Date.now() - started);
      }
      if (error === null && text !== null && text.trim().length > 0) {
        return { provider: provider.id, status: "done", answer: text, ms: Date.now() - started, error: null, errorKind: null, attempts: attempt, usage };
      }
      lastError = error ?? "empty answer";
      lastKind = error === null ? "empty" : kind;
      if (!RETRYABLE.has(lastKind) || attempt >= maxAttempts) break;
      await sleep(config.retryDelayMs, opts.signal);
    }
  } finally {
    release();
  }
  return failed(lastError, lastKind, Math.min(attempt, maxAttempts), Date.now() - started);
}
