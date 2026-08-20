/**
 * Parser for the Anthropic-Messages-shaped NDJSON that both `claude -p --output-format stream-json`
 * and `grok --output-format streaming-messages-json` emit.
 *
 * Relevant lines:
 *   {"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}}
 *   {"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"..."}}}
 *   {"type":"result","is_error":false,"result":"full text","structured_output":{...},"usage":{...},"total_cost_usd":n}
 */
import type { LaneEvent, Usage } from "../types.ts";
import { createJsonFieldStreamer } from "./json-field-stream.ts";

export interface AnthropicStreamState {
  text: string;
  done: boolean;
  result?: any;
}

/**
 * @param streamJsonField when the call uses --json-schema, the name of the string field whose
 *   value should be streamed as `delta` events (the rest of the JSON is only available at `done`).
 */
export function createAnthropicStreamParser(streamJsonField?: string) {
  const state: AnthropicStreamState = { text: "", done: false };
  const fieldStreamer = streamJsonField ? createJsonFieldStreamer(streamJsonField) : null;

  /** Feed one parsed JSON object; returns zero or more lane events. */
  function feed(obj: any): LaneEvent[] {
    if (!obj || typeof obj !== "object") return [];
    if (obj.type === "stream_event") {
      const ev = obj.event;
      if (ev?.type === "content_block_delta") {
        const d = ev.delta;
        if (d?.type === "text_delta" && typeof d.text === "string") {
          state.text += d.text;
          return [{ type: "delta", text: d.text }];
        }
        if (d?.type === "thinking_delta" && typeof d.thinking === "string") {
          return [{ type: "thinking", text: d.thinking }];
        }
        if (d?.type === "input_json_delta" && fieldStreamer && typeof d.partial_json === "string") {
          const piece = fieldStreamer.feed(d.partial_json);
          if (piece.length > 0) {
            state.text += piece;
            return [{ type: "delta", text: piece }];
          }
        }
      }
      return [];
    }
    if (obj.type === "result") {
      state.done = true;
      state.result = obj;
      if (obj.is_error) {
        const msg = typeof obj.result === "string" ? obj.result : obj.error ?? "provider reported is_error";
        return [{ type: "error", message: String(msg) }];
      }
      if (obj.structured_output !== undefined && obj.structured_output !== null) {
        const so = obj.structured_output;
        const field = streamJsonField && typeof so?.[streamJsonField] === "string" ? so[streamJsonField] : state.text;
        state.text = field;
        return [{ type: "done", text: field, usage: usageOf(obj), structured: so }];
      }
      // Prefer the authoritative final text; fall back to accumulated deltas.
      const final = typeof obj.result === "string" && obj.result.length > 0 ? obj.result : state.text;
      state.text = final;
      return [{ type: "done", text: final, usage: usageOf(obj) }];
    }
    return [];
  }

  return { feed, state };
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
