/** Generic CLI-backed provider: build argv, run, feed NDJSON into a parser, normalize errors. */
import type { CallOptions, LaneErrorKind, LaneEvent, Provider, ProviderId } from "../types.ts";
import { runLines, tryJson, type ProcessExit } from "./process.ts";
import { config } from "../config.ts";

export interface Invocation {
  cmd: string;
  args: string[];
  stdin?: string;
}

export interface Parser {
  feed(obj: any): LaneEvent[];
  /** `rateLimit` is claude's `rate_limit_info` record when its stream carried one. */
  state: { text: string; done: boolean; rateLimit?: { status?: string } };
}

export interface CliProviderSpec {
  id: ProviderId;
  label: string;
  streams: boolean;
  supportsJsonSchema: boolean;
  build(opts: CallOptions): Invocation;
  parser(opts: CallOptions): Parser;
  /** Optional hook to pull text out of a non-JSON stdout line (e.g. kimi text mode). */
  plainLine?(line: string, parser: Parser): LaneEvent[];
}

export function cliProvider(spec: CliProviderSpec): Provider {
  return {
    id: spec.id,
    label: spec.label,
    streams: spec.streams,
    supportsJsonSchema: spec.supportsJsonSchema,
    async *call(opts: CallOptions): AsyncGenerator<LaneEvent, void, void> {
      const inv = spec.build(opts);
      const parser = spec.parser(opts);
      // Only claude reports quota state as a record; for the others the message text is the signal.
      const classify = (message: string, fallback: LaneErrorKind): LaneErrorKind => {
        const status = parser.state.rateLimit?.status;
        if (status !== undefined && status !== "allowed") return "rate_limit";
        return classifyFailure(message, fallback);
      };
      let exit: ProcessExit | undefined;
      let sawDone = false;
      let sawError = false;
      // claude prints some failures (empty prompt, auth, quota) as plain text on *stdout* with an
      // empty stderr, so non-JSON stdout lines are kept for the error message.
      const plain: string[] = [];

      for await (const item of runLines({ cmd: inv.cmd, args: inv.args, stdin: inv.stdin, signal: opts.signal })) {
        if (item.kind === "exit") {
          exit = item;
          break;
        }
        const obj = tryJson(item.line);
        if (obj === undefined && item.line.trim()) plain.push(item.line);
        const events = obj !== undefined ? parser.feed(obj) : (spec.plainLine?.(item.line, parser) ?? []);
        for (const ev of events) {
          if (ev.type === "done") sawDone = true;
          if (ev.type === "error") {
            sawError = true;
            // Parsers cannot tell a quota block from any other reported failure, so they all say
            // "exit"; re-classify on the way out, where the rate-limit record is also visible.
            yield { ...ev, kind: ev.kind === "exit" ? classify(ev.message, "exit") : ev.kind };
            continue;
          }
          yield ev;
        }
      }

      if (sawError) return;
      if (!exit) {
        yield { type: "error", message: "process ended without exit record", kind: "internal" };
        return;
      }
      if (exit.timedOut) {
        yield { type: "error", message: `timed out after ${config.laneTimeoutMs / 1000}s`, kind: "timeout" };
        return;
      }
      if (exit.aborted) {
        yield { type: "error", message: "aborted", kind: "aborted" };
        return;
      }
      if (exit.code !== 0) {
        const message = `exit ${exit.code}${exit.signal ? ` (${exit.signal})` : ""}: ${diagnostics(exit.stderr, plain)}`;
        yield { type: "error", message, kind: exit.spawnFailed ? "spawn" : classify(message, "exit") };
        return;
      }
      if (!sawDone) {
        // Clean exit but the parser never saw a terminal record — treat accumulated text as the answer
        // if there is any, otherwise fail so the lane runner retries.
        if (parser.state.text.trim().length > 0) {
          yield { type: "done", text: parser.state.text };
        } else {
          const message = `no output (exit 0): ${diagnostics(exit.stderr, plain)}`;
          yield { type: "error", message, kind: classify(message, "empty") };
        }
      }
    },
  };
}

/**
 * A quota block is reported by every CLI as an ordinary failure, but retrying one is worse than
 * useless: the limit still holds a moment later and the retry burns more of it. Match it on the
 * message so `runLane` can skip the retry and the UI can say "rate limited" rather than "failed".
 */
const RATE_LIMIT_RE = /rate.?limit|usage limit|quota|too many requests|\b429\b|overloaded/i;

export function classifyFailure(message: string, fallback: LaneErrorKind): LaneErrorKind {
  return RATE_LIMIT_RE.test(message) ? "rate_limit" : fallback;
}

/** stderr first, then whatever non-JSON text the CLI put on stdout; "(no diagnostics)" if both are empty. */
function diagnostics(stderr: string, plain: string[]): string {
  const parts = [tail(stderr), tail(plain.slice(-5).join("\n"))].filter(Boolean);
  return parts.length ? parts.join(" | ") : "(no diagnostics)";
}

function tail(s: string, n = 600): string {
  const t = s.trim();
  return t.length > n ? "…" + t.slice(-n) : t;
}
