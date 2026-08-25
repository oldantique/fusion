/**
 * Parser for the Anthropic-Messages-shaped NDJSON that both `claude -p --output-format stream-json`
 * and `grok --output-format streaming-messages-json` emit.
 *
 * Relevant lines:
 *   {"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}}
 *   {"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"..."}}}
 *   {"type":"rate_limit_event","rate_limit_info":{"status":"allowed",...}}   (claude only)
 *   {"type":"result","is_error":false,"result":"full text","structured_output":{...},"usage":{...},"total_cost_usd":n}
 *
 * The two CLIs differ in one place: under `--json-schema` claude streams the JSON document as
 * `input_json_delta` fragments while grok streams it as ordinary `text_delta`s. Both end with the
 * parsed object on `result.structured_output`.
 */
import type { LaneEvent, Usage } from "../types.ts";
import { createJsonFieldStreamer } from "./json-field-stream.ts";

export interface AnthropicStreamState {
  text: string;
  done: boolean;
  result?: any;
  /** claude's `rate_limit_info`: `status` is "allowed" until the account is throttled. */
  rateLimit?: { status?: string; resetsAt?: number; rateLimitType?: string };
}

/**
 * @param streamJsonField when the call uses --json-schema, the name of the string field whose
 *   value should be streamed as `delta` events (the rest of the JSON is only available at `done`).
 */
export function createAnthropicStreamParser(streamJsonField?: string) {
  const state: AnthropicStreamState = { text: "", done: false };
  const fieldStreamer = streamJsonField ? createJsonFieldStreamer(streamJsonField) : null;

  /** Decode a fragment of the schema JSON, emitting only the newly revealed field characters. */
  function streamField(fragment: string): LaneEvent[] {
    const piece = fieldStreamer!.feed(fragment);
    if (piece.length === 0) return [];
    state.text += piece;
    return [{ type: "delta", text: piece }];
  }

  /** Feed one parsed JSON object; returns zero or more lane events. */
  function feed(obj: any): LaneEvent[] {
    if (!obj || typeof obj !== "object") return [];
    if (obj.type === "stream_event") {
      const ev = obj.event;
      if (ev?.type === "content_block_delta") {
        const d = ev.delta;
        if (d?.type === "text_delta" && typeof d.text === "string") {
          // Under a schema these carry the JSON document itself (grok), not the answer: the UI
          // must see the streamed field, never the braces around it.
          if (fieldStreamer) return streamField(d.text);
          state.text += d.text;
          return [{ type: "delta", text: d.text }];
        }
        if (d?.type === "thinking_delta" && typeof d.thinking === "string") {
          return [{ type: "thinking", text: d.thinking }];
        }
        if (d?.type === "input_json_delta" && fieldStreamer && typeof d.partial_json === "string") {
          return streamField(d.partial_json);
        }
      }
      return [];
    }
    if (obj.type === "rate_limit_event") {
      // Recorded, not emitted: base.ts uses it to tell a quota failure from an ordinary one.
      if (obj.rate_limit_info && typeof obj.rate_limit_info === "object") state.rateLimit = obj.rate_limit_info;
      return [];
    }
    if (obj.type === "result") {
      state.done = true;
      state.result = obj;
      if (obj.is_error) {
        const msg = typeof obj.result === "string" ? obj.result : obj.error ?? "provider reported is_error";
        return [{ type: "error", message: String(msg), kind: "exit" }];
      }
      // Prefer the authoritative final text; fall back to accumulated deltas.
      const raw = typeof obj.result === "string" && obj.result.length > 0 ? obj.result : state.text;
      const so = structuredOutput(obj, streamJsonField ? raw : undefined);
      if (so !== undefined) {
        const field = streamJsonField && typeof so[streamJsonField] === "string" ? (so[streamJsonField] as string) : state.text;
        state.text = field;
        return [{ type: "done", text: field, usage: usageOf(obj), structured: so }];
      }
      // A schema run that produced no usable object: the field streamer's partial decode is a
      // better answer than a JSON document, and the caller copes with a missing `structured`.
      const final = streamJsonField && state.text.length > 0 ? state.text : raw;
      state.text = final;
      return [{ type: "done", text: final, usage: usageOf(obj) }];
    }
    return [];
  }

  return { feed, state };
}

/**
 * The structured object the CLI reported, or — for a schema run that reported none — whatever
 * reparses from the final text. grok enforces the schema through the prompt rather than the
 * decoder, so "no object" and "not the shape we asked for" are both reachable; `undefined` lets
 * the caller degrade to plain text instead of failing the lane.
 */
function structuredOutput(result: any, rawJson?: string): Record<string, unknown> | undefined {
  const so = result?.structured_output;
  if (so !== undefined && so !== null) return so as Record<string, unknown>;
  if (rawJson === undefined) return undefined;
  try {
    const parsed = JSON.parse(rawJson);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function usageOf(result: any): Usage | undefined {
  const u = result?.usage;
  if (!u) return undefined;
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens,
    costUsd: result.total_cost_usd,
  };
}
