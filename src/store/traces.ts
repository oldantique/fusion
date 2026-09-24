/**
 * Raw output of every CLI call, one NDJSON file per lane and per synthesizer attempt under
 * `data/traces/<turn-id>/`, kept for a number of days. It exists for post-mortems: the turn in
 * SQLite holds what Fusion made of a call, a trace holds what the CLI actually printed — without
 * it, an answer the parser dropped is gone for good.
 *
 * Lines are buffered in memory and written once when the call ends (every call ends: `runLane`
 * never rejects), so tracing costs no I/O per token. A write failure is logged, never thrown: a
 * trace must not be able to fail a turn.
 */
import fs from "node:fs";
import path from "node:path";

/** Per-file cap; a synthesizer's full stream with thinking stays well under it. */
const MAX_BYTES = 8 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface Tracer {
  record(obj: unknown): void;
  /** Appends `{type:"fusion/result", ...result}` and writes the file; never rejects. */
  end(result: unknown): Promise<void>;
}

export type TraceOpener = (name: string) => Tracer | undefined;

export class Traces {
  readonly dir: string;
  readonly days: number;
  private timer: NodeJS.Timeout | undefined;

  constructor(dir: string, days: number) {
    this.dir = dir;
    this.days = days;
  }

  get enabled(): boolean {
    return this.days > 0;
  }

  /** Opener for one turn's traces; `undefined` when tracing is off. */
  forTurn(turnId: string): TraceOpener | undefined {
    if (!this.enabled || !/^[\w-]+$/.test(turnId)) return undefined;
    const turnDir = path.join(this.dir, turnId);
    return (name) => {
      const lines: string[] = [];
      let bytes = 0;
      let truncated = false;
      const push = (obj: unknown) => {
        const line = JSON.stringify(obj) ?? "null";
        if (bytes + line.length > MAX_BYTES) {
          truncated = true;
          return;
        }
        lines.push(line);
        bytes += line.length + 1;
      };
      return {
        record: (obj) => {
          if (!truncated) push(obj);
        },
        end: (result) => {
          if (truncated) lines.push(JSON.stringify({ type: "fusion/truncated", maxBytes: MAX_BYTES }));
          lines.push(JSON.stringify({ type: "fusion/result", ...(result as object) }));
          const file = path.join(turnDir, `${name.replace(/[^\w.-]/g, "_")}.ndjson`);
          return fs.promises
            .mkdir(turnDir, { recursive: true, mode: 0o700 })
            .then(() => fs.promises.writeFile(file, lines.join("\n") + "\n", { mode: 0o600 }))
            .catch((e) => console.error(`trace ${file}:`, e instanceof Error ? e.message : e));
        },
      };
    };
  }

  /** Removes the traces of these turns (their conversation was deleted). */
  remove(turnIds: string[]): void {
    for (const id of turnIds) {
      if (!/^[\w-]+$/.test(id)) continue;
      fs.rmSync(path.join(this.dir, id), { recursive: true, force: true });
    }
  }

  /** Removes turn directories last written more than `days` ago. */
  prune(now = Date.now()): void {
    if (!this.enabled) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.dir, { withFileTypes: true });
    } catch {
      return; // nothing traced yet
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(this.dir, e.name);
      try {
        if (now - fs.statSync(p).mtimeMs > this.days * DAY_MS) fs.rmSync(p, { recursive: true, force: true });
      } catch (err) {
        console.error(`trace prune ${p}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  /** Prunes now and then daily, on a timer that does not keep the process alive. */
  startPruning(): void {
    this.prune();
    this.timer ??= setInterval(() => this.prune(), DAY_MS);
    this.timer.unref();
  }
}
