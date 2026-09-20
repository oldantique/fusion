/** cliProvider's failure reporting, driven by a shell one-liner standing in for a CLI (no jail). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cliProvider } from "../src/providers/base.ts";
import { createAnthropicStreamParser } from "../src/parsers/anthropic-stream.ts";
import type { LaneEvent } from "../src/types.ts";

async function run(script: string): Promise<LaneEvent[]> {
  const provider = cliProvider({
    id: "grok",
    label: "stub",
    streams: true,
    supportsJsonSchema: false,
    mounts: {},
    jail: false,
    build: () => ({ cmd: "sh", args: ["-c", script] }),
    parser: () => createAnthropicStreamParser(),
  });
  const events: LaneEvent[] = [];
  for await (const ev of provider.call({ system: "", prompt: "" })) events.push(ev);
  return events;
}

const BARE = `echo '{"type":"result","is_error":true}'`;

test("an error record with no message is reported with the stderr tail", async () => {
  const events = await run(`${BARE}; echo 'API error (status 403 Forbidden): permission-denied' >&2; exit 1`);
  assert.equal(events.length, 1);
  const [ev] = events;
  assert.ok(ev.type === "error" && ev.kind === "exit");
  assert.match(ev.message, /provider reported is_error \| API error \(status 403/);
});

test("stderr is what classifies a bare error record as a rate limit", async () => {
  const [ev] = await run(`${BARE}; echo 'API error (status 429): too many requests' >&2; exit 1`);
  assert.ok(ev.type === "error" && ev.kind === "rate_limit");
});

test("an error record is reported as is when stderr is empty", async () => {
  const [ev] = await run(`echo '{"type":"result","is_error":true,"result":"boom"}'`);
  assert.ok(ev.type === "error");
  assert.equal(ev.message, "boom");
});
