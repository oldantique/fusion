/**
 * In-memory registry of running fusion turns. Buffers every event so an SSE client that
 * connects late (page reload, mobile tab resume) can replay the full state, then follow live.
 */
import type { FuseEvent } from "../synth/fuse.ts";
import { fuse } from "../synth/fuse.ts";
import type { Store } from "../store/db.ts";
import type { ProviderId } from "../types.ts";

export type JobEvent = FuseEvent | { type: "finished"; answer: string | null } | { type: "fatal"; message: string };

interface Job {
  turnId: string;
  events: JobEvent[];
  subscribers: Set<(ev: JobEvent) => void>;
  finished: boolean;
  abort: AbortController;
}

export class Jobs {
  private jobs = new Map<string, Job>();
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  start(conversationId: string, question: string, providerIds: ProviderId[]): string {
    const history = this.store.history(conversationId);
    const turn = this.store.startTurn(conversationId, question, providerIds);
    const job: Job = { turnId: turn.id, events: [], subscribers: new Set(), finished: false, abort: new AbortController() };
    this.jobs.set(turn.id, job);

    const emit = (ev: JobEvent) => {
      job.events.push(ev);
      for (const s of job.subscribers) s(ev);
    };

    fuse({
      question,
      history,
      providerIds,
      signal: job.abort.signal,
      onEvent: (ev) => {
        if (ev.type === "lane" && (ev.status === "done" || ev.status === "failed")) this.store.saveLane(turn.id, ev.result);
        emit(ev);
      },
    })
      .then((out) => {
        const err = out.answer ? null : out.lanes.every((l) => l.status === "failed") ? "all lanes failed" : "synthesis failed";
        this.store.finishTurn(turn.id, out.answer, out.synthesis, out.historyOmitted, err);
        emit({ type: "finished", answer: out.answer });
      })
      .catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        this.store.finishTurn(turn.id, null, null, 0, message);
        emit({ type: "fatal", message });
      })
      .finally(() => {
        job.finished = true;
        // Keep the buffer briefly for late subscribers, then drop it; the DB has the final state.
        setTimeout(() => this.jobs.delete(turn.id), 5 * 60_000).unref();
      });

    return turn.id;
  }

  /** Subscribe to a job: replays buffered events synchronously, then streams. Returns unsubscribe, or null if unknown. */
  subscribe(turnId: string, fn: (ev: JobEvent) => void): (() => void) | null {
    const job = this.jobs.get(turnId);
    if (!job) return null;
    for (const ev of job.events) fn(ev);
    if (job.finished) return () => {};
    job.subscribers.add(fn);
    return () => job.subscribers.delete(fn);
  }

  isRunning(turnId: string): boolean {
    const j = this.jobs.get(turnId);
    return !!j && !j.finished;
  }

  cancel(turnId: string): boolean {
    const j = this.jobs.get(turnId);
    if (!j || j.finished) return false;
    j.abort.abort();
    return true;
  }

  abortAll() {
    for (const j of this.jobs.values()) if (!j.finished) j.abort.abort();
  }
}
