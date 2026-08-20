/**
 * In-memory registry of running fusion turns. Every event gets a sequence number and is
 * buffered so an SSE client can (re)connect at any point and receive exactly what it missed
 * (`Last-Event-ID`), then follow live. Finished lanes' deltas are compacted away — their result
 * carries the full text — so the buffer stays small on long turns.
 */
import type { FuseEvent, FuseInput, FuseOutput } from "../synth/fuse.ts";
import { fuse as realFuse } from "../synth/fuse.ts";
import type { Store } from "../store/db.ts";
import type { ProviderId } from "../types.ts";

export type JobEvent =
  | FuseEvent
  | { type: "cancelled" }
  | { type: "finished"; answer: string | null }
  | { type: "fatal"; message: string };

export type SeqEvent = { seq: number; ev: JobEvent };

/** Thrown by start() when the conversation already has a running turn. */
export class ConflictError extends Error {
  readonly turnId: string;
  constructor(turnId: string) {
    super("turn in progress");
    this.name = "ConflictError";
    this.turnId = turnId;
  }
}

interface Job {
  turnId: string;
  conversationId: string;
  events: SeqEvent[];
  nextSeq: number;
  subscribers: Set<(e: SeqEvent) => void>;
  finished: boolean;
  cancelled: boolean;
  abort: AbortController;
  done: Promise<void>;
}

const RETENTION_MS = 5 * 60_000;

export class Jobs {
  private jobs = new Map<string, Job>();
  private activeByConversation = new Map<string, string>();
  private readonly store: Store;
  private readonly fuse: (input: FuseInput) => Promise<FuseOutput>;

  constructor(store: Store, fuseImpl: (input: FuseInput) => Promise<FuseOutput> = realFuse) {
    this.store = store;
    this.fuse = fuseImpl;
  }

  /** Turn currently running in a conversation, if any. */
  activeFor(conversationId: string): string | null {
    return this.activeByConversation.get(conversationId) ?? null;
  }

  start(conversationId: string, question: string, providerIds: ProviderId[]): string {
    const active = this.activeByConversation.get(conversationId);
    if (active) throw new ConflictError(active);

    const history = this.store.history(conversationId);
    const turn = this.store.startTurn(conversationId, question, providerIds);
    let resolveDone!: () => void;
    const job: Job = {
      turnId: turn.id,
      conversationId,
      events: [],
      nextSeq: 1,
      subscribers: new Set(),
      finished: false,
      cancelled: false,
      abort: new AbortController(),
      done: new Promise<void>((r) => (resolveDone = r)),
    };
    this.jobs.set(turn.id, job);
    this.activeByConversation.set(conversationId, turn.id);

    const emit = (ev: JobEvent) => {
      compact(job, ev);
      const se = { seq: job.nextSeq++, ev };
      job.events.push(se);
      for (const s of job.subscribers) {
        try {
          s(se);
        } catch {
          /* a broken subscriber must not break the turn */
        }
      }
    };

    this.fuse({
      question,
      history,
      providerIds,
      signal: job.abort.signal,
      onEvent: (ev) => {
        if (ev.type === "lane" && (ev.status === "done" || ev.status === "failed")) {
          try {
            this.store.saveLane(turn.id, ev.result);
          } catch (e) {
            console.error(`saveLane failed for turn ${turn.id}:`, e);
          }
        }
        emit(ev);
      },
    })
      .then((out) => {
        const err = out.answer
          ? null
          : job.cancelled
            ? "cancelled"
            : out.lanes.every((l) => l.status === "failed")
              ? "all lanes failed"
              : "synthesis failed";
        this.store.finishTurn(turn.id, out.answer, out.synthesis, out.historyOmitted, err, out.answerProvider);
        if (err === "cancelled") emit({ type: "cancelled" });
        emit({ type: "finished", answer: out.answer });
      })
      .catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        try {
          this.store.finishTurn(turn.id, null, null, 0, message);
        } catch (e2) {
          console.error(`finishTurn failed for turn ${turn.id}:`, e2);
        }
        emit({ type: "fatal", message });
      })
      .finally(() => {
        job.finished = true;
        if (this.activeByConversation.get(conversationId) === turn.id) this.activeByConversation.delete(conversationId);
        resolveDone();
        // Keep the buffer briefly for late subscribers, then drop it; the DB has the final state.
        setTimeout(() => this.jobs.delete(turn.id), RETENTION_MS).unref();
      });

    return turn.id;
  }

  /**
   * Subscribe to a job: replays buffered events with seq > afterSeq synchronously, then streams.
   * Returns unsubscribe, or null if the job is unknown (evicted or never existed).
   */
  subscribe(turnId: string, fn: (e: SeqEvent) => void, afterSeq = 0): (() => void) | null {
    const job = this.jobs.get(turnId);
    if (!job) return null;
    for (const se of job.events) if (se.seq > afterSeq) fn(se);
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
    j.cancelled = true;
    j.abort.abort();
    return true;
  }

  abortAll() {
    for (const j of this.jobs.values()) if (!j.finished) this.cancel(j.turnId);
  }

  /** Resolves when every running job has finished, or after the grace period. */
  async drain(graceMs: number): Promise<boolean> {
    const pending = [...this.jobs.values()].filter((j) => !j.finished).map((j) => j.done);
    if (pending.length === 0) return true;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((r) => (timer = setTimeout(() => r(false), graceMs)));
    const all = Promise.all(pending).then(() => true as const);
    const ok = await Promise.race([all, timeout]);
    if (timer) clearTimeout(timer);
    return ok;
  }
}

/** Drop buffered deltas whose full text is now carried by a terminal event. */
function compact(job: Job, ev: JobEvent) {
  if (ev.type === "lane" && (ev.status === "done" || ev.status === "failed")) {
    job.events = job.events.filter((se) => !(se.ev.type === "lane" && se.ev.status === "delta" && se.ev.provider === ev.provider));
  } else if (ev.type === "synth" && (ev.status === "done" || ev.status === "start")) {
    // A new synthesizer attempt (fallback) supersedes the previous one's partial text as well.
    job.events = job.events.filter((se) => !(se.ev.type === "synth" && se.ev.status === "delta"));
  }
}
