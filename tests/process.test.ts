/** Process lifecycle: timeouts survive stdout closing, process groups die together, semaphore aborts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AbortedError, Semaphore, runLines } from "../src/providers/process.ts";

const NODE = process.execPath;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function collect(gen: AsyncGenerator<any>) {
  const lines: string[] = [];
  let exit: any;
  for await (const item of gen) {
    if (item.kind === "line") lines.push(item.line);
    else exit = item;
  }
  return { lines, exit };
}

test("a child that closes stdout but keeps running is still killed by the timeout", async () => {
  const t0 = Date.now();
  const { lines, exit } = await collect(
    runLines({ cmd: NODE, args: ["-e", "console.log(process.pid); process.stdout.end(); setTimeout(()=>{}, 60_000)"], timeoutMs: 500, cwd: process.cwd() }),
  );
  assert.equal(exit.timedOut, true);
  assert.ok(Date.now() - t0 < 10_000, "did not hang until the child's own timer");
  assert.equal(alive(Number(lines[0])), false);
});

test("killing a lane kills the grandchild too", async () => {
  const script = `
    const { spawn } = require("node:child_process");
    const gc = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60_000)"], { stdio: "ignore" });
    console.log(gc.pid);
    setTimeout(()=>{}, 60_000);`;
  const { lines, exit } = await collect(runLines({ cmd: NODE, args: ["-e", script], timeoutMs: 500, cwd: process.cwd() }));
  assert.equal(exit.timedOut, true);
  const gcPid = Number(lines[0]);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(alive(gcPid), false, "grandchild survived the kill");
});

test("breaking out of the iterator early kills the child", async () => {
  const gen = runLines({ cmd: NODE, args: ["-e", "console.log(process.pid); setInterval(()=>console.log('x'), 50)"], timeoutMs: 30_000, cwd: process.cwd() });
  const first = await gen.next();
  const pid = Number((first.value as any).line);
  await gen.return(undefined);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(alive(pid), false);
});

test("spawn failure is reported as spawnFailed, not a hang", async () => {
  const { exit } = await collect(runLines({ cmd: "/nonexistent/definitely-not-a-cli", args: [], timeoutMs: 5_000, cwd: process.cwd() }));
  assert.equal(exit.spawnFailed, true);
  assert.equal(exit.code, -1);
});

test("semaphore: abort while queued rejects promptly and does not leak a permit", async () => {
  const sem = new Semaphore(1);
  const release = await sem.acquire();
  const ac = new AbortController();
  const waiting = sem.acquire(ac.signal);
  assert.equal(sem.waiting, 1);
  ac.abort();
  await assert.rejects(waiting, AbortedError);
  assert.equal(sem.waiting, 0);
  release();
  release(); // idempotent: a double release must not over-admit
  assert.equal(sem.isFull, false);
  const r2 = await sem.acquire();
  assert.equal(sem.isFull, true);
  r2();
});

test("semaphore: a released permit is handed to the next waiter without a gap", async () => {
  const sem = new Semaphore(1);
  const r1 = await sem.acquire();
  const p2 = sem.acquire();
  r1();
  const r2 = await p2;
  assert.equal(sem.isFull, true);
  r2();
  assert.equal(sem.isFull, false);
});
