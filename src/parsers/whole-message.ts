/**
 * Parsers for CLIs that emit whole messages only (no token deltas).
 *
 * codex exec --json:
 *   {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
 *   {"type":"turn.completed", ...}   {"type":"turn.failed","error":{"message":...}}
 *
 * kimi --output-format stream-json:
 *   {"role":"assistant","content":"..."}          (may repeat when tools are used; last wins)
 *   {"role":"meta","type":"session.resume_hint",...}
 */
import type { LaneEvent } from "../types.ts";

export function createCodexParser() {
  const state = { text: "", done: false };
  function feed(obj: any): LaneEvent[] {
    if (!obj || typeof obj !== "object") return [];
    if (obj.type === "item.completed" && obj.item?.type === "agent_message" && typeof obj.item.text === "string") {
      // Codex may emit several agent messages in one turn (e.g. a plan then an answer); keep the last.
      state.text = obj.item.text;
      return [];
    }
    if (obj.type === "turn.completed") {
      state.done = true;
      const u = obj.usage;
      return [
        {
          type: "done",
          text: state.text,
          usage: u ? { inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheReadTokens: u.cached_input_tokens } : undefined,
        },
      ];
    }
    if (obj.type === "turn.failed" || obj.type === "error") {
      state.done = true;
      return [{ type: "error", message: String(obj.error?.message ?? obj.message ?? "codex turn failed") }];
    }
    return [];
  }
  return { feed, state };
}

export function createKimiParser() {
  const state = { text: "", done: false };
  function feed(obj: any): LaneEvent[] {
    if (!obj || typeof obj !== "object") return [];
    if (obj.role === "assistant" && typeof obj.content === "string" && obj.content.length > 0) {
      state.text = obj.content;
      return [];
    }
    if (obj.role === "meta" && obj.type === "session.resume_hint") {
      state.done = true;
      return [{ type: "done", text: state.text }];
    }
    if (obj.role === "error" || obj.type === "error") {
      state.done = true;
      return [{ type: "error", message: String(obj.content ?? obj.message ?? "kimi error") }];
    }
    return [];
  }
  return { feed, state };
}
