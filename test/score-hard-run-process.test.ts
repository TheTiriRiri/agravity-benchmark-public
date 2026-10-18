/**
 * Tests for runProcess in scripts/score-hard.ts, the asynchronous spawn the
 * contract files, the build and the Playwright runs go through, on real node
 * children: what it returns; that an abort, a timeout or too much output
 * kills the child's whole process group; that the outcome waits for that
 * group to be gone; and that the interrupt cleanup gives a child the grace
 * to shut down before any SIGKILL.
 *
 * Every child announces itself over a TCP connection to the test before the
 * test acts on it (no file, so a run cut short leaves none), and ends by
 * itself after 30 s whatever happens, so a test run cut short (Ctrl-C on
 * `npm test`) leaves no process behind for long; `after` kills what is still
 * tracked.
 */
import assert from "node:assert/strict";
import { createServer, type AddressInfo, type Server } from "node:net";
import { after, before, describe, it } from "node:test";

import { KILL_WAIT_MS, killAllProcessesSync } from "../scripts/lib/dev-server";
import { HarnessFault, requireCompleted } from "../scripts/lib/hard-score";
import { interruptHooks, runProcess } from "../scripts/score-hard";

const CWD = import.meta.dirname;
/** A child that runs until it is killed, or for 30 s. */
const FOREVER = "setInterval(() => {}, 1000); setTimeout(() => process.exit(), 30_000);";
/** dev-server.ts's SIGTERM grace, before its SIGKILL: half of `KILL_WAIT_MS`. */
const GRACE_MS = KILL_WAIT_MS / 2;

function never(): AbortSignal {
  return new AbortController().signal;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** An orphan is reaped a moment after it dies; until then `kill(pid, 0)` still finds it. */
async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (alive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((done) => setTimeout(done, 50));
  }
  return true;
}

/** What each child announced, by key, and who is waiting for a key not yet announced. */
const messages = new Map<string, string>();
const waiting = new Map<string, (value: string) => void>();
let server: Server;
let port = 0;
let keys = 0;

/** A fresh key for one announcement. */
function key(): string {
  return `k${++keys}`;
}

/**
 * Child-side code that sends `value` (a JS expression) under `name` over one
 * connection to the test, then runs `then` once it is flushed.
 */
function announce(name: string, value: string, then = ""): string {
  return `{ const s = require("node:net").connect(${port}, "127.0.0.1", () => s.end(${JSON.stringify(`${name}=`)} + String(${value}), () => { ${then} })); }`;
}

/** What a child announced under `name`, once it has. */
function announced(name: string, ms = 5_000): Promise<string> {
  const known = messages.get(name);
  if (known !== undefined) return Promise.resolve(known);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(name);
      reject(new Error(`nothing announced under ${name} within ${ms} ms`));
    }, ms);
    waiting.set(name, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

describe("runProcess", () => {
  before(async () => {
    server = createServer((socket) => {
      let text = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        text += chunk;
      });
      socket.on("end", () => {
        const at = text.indexOf("=");
        const [name, value] = [text.slice(0, at), text.slice(at + 1)];
        messages.set(name, value);
        waiting.get(name)?.(value);
        waiting.delete(name);
      });
    });
    await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
    port = (server.address() as AddressInfo).port;
  });
  after(() => {
    killAllProcessesSync();
    server.close();
  });

  it("returns a finished child's exit code and output in spawnSync's shape", async () => {
    const proc = await runProcess("node", ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"], { cwd: CWD, timeoutMs: 10_000, signal: never() });
    assert.deepEqual(proc, { status: 3, signal: null, error: undefined, stdout: "out", stderr: "err" });
    assert.doesNotThrow(() => requireCompleted("node", proc), "a non-zero exit is the tests' verdict, not a fault");
  });

  it("passes env to the child", async () => {
    const proc = await runProcess("node", ["-e", "process.stdout.write(process.env.CONTRACT_BASE_URL)"], { cwd: CWD, env: { ...process.env, CONTRACT_BASE_URL: "http://127.0.0.1:40001" }, timeoutMs: 10_000, signal: never() });
    assert.equal(proc.stdout, "http://127.0.0.1:40001");
  });

  it("an abort kills the child at once, and what it started with it", { timeout: 10_000 }, async () => {
    const abort = new AbortController();
    const ready = key();
    // The grandchild keeps the pipes open: only a kill of the group ends the run.
    const script = `const c = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(FOREVER)}], { stdio: "inherit" }); ${announce(ready, "c.pid")} ${FOREVER}`;
    const running = runProcess("node", ["-e", script], { cwd: CWD, timeoutMs: 60_000, signal: abort.signal });
    const grandchild = Number(await announced(ready));
    assert.ok(Number.isInteger(grandchild) && grandchild > 1, `the grandchild's pid: ${grandchild}`);
    const aborted = Date.now();
    abort.abort();
    const proc = await running;
    assert.ok(Date.now() - aborted < GRACE_MS, "answered at once, within SIGTERM, not at the timeout or a SIGKILL");
    assert.equal(proc.signal, "SIGTERM");
    assert.equal(proc.error, undefined);
    assert.ok(await goneWithin(grandchild, 2_000), "the grandchild was killed with its parent");
    assert.throws(() => requireCompleted("api-contract.test.ts", proc), (e: Error) => e instanceof HarnessFault && /killed by SIGTERM/.test(e.message));
  });

  it("a signal already aborted kills the child as it starts", { timeout: 10_000 }, async () => {
    const abort = new AbortController();
    abort.abort();
    const proc = await runProcess("node", ["-e", FOREVER], { cwd: CWD, timeoutMs: 60_000, signal: abort.signal });
    assert.equal(proc.signal, "SIGTERM");
  });

  it("a timeout kills the child and sets error, so requireCompleted makes it a HarnessFault", { timeout: 10_000 }, async () => {
    const proc = await runProcess("node", ["-e", FOREVER], { cwd: CWD, timeoutMs: 300, signal: never() });
    assert.equal(proc.signal, "SIGTERM");
    assert.match(proc.error!.message, /^node timed out after 0 s$/);
    assert.throws(() => requireCompleted("api-contract.test.ts", proc), (e: Error) => e instanceof HarnessFault && /api-contract\.test\.ts: node timed out/.test(e.message));
  });

  it("output over maxBuffer kills the child, keeps no more than maxBuffer, and sets error", { timeout: 10_000 }, async () => {
    const proc = await runProcess("node", ["-e", `process.stdout.write("x".repeat(100_000)); ${FOREVER}`], { cwd: CWD, timeoutMs: 60_000, maxBuffer: 1_000, signal: never() });
    assert.match(proc.error!.message, /stdout over 1000 bytes \(ENOBUFS\)/);
    assert.ok(proc.stdout.length <= 1_000);
    assert.equal(proc.signal, "SIGTERM");
  });

  it("a member the child left in its group, off the pipes, is killed and gone before the outcome", { timeout: 10_000 }, async () => {
    const ready = key();
    // The leader exits at once and its pipes close; the grandchild holds none of them.
    const script = `const c = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(FOREVER)}], { stdio: "ignore" }); ${announce(ready, "c.pid", "process.exit(0)")}`;
    const proc = await runProcess("node", ["-e", script], { cwd: CWD, timeoutMs: 60_000, signal: never() });
    assert.deepEqual([proc.status, proc.signal, proc.error], [0, null, undefined], "the leader's own outcome");
    const grandchild = Number(await announced(ready));
    assert.ok(await goneWithin(grandchild, 500), "the grandchild was gone (or only awaiting its reaper) when the outcome came");
  });

  it("a process outside the group that holds the pipes cannot keep the outcome past a timeout or an abort", { timeout: 20_000 }, async () => {
    const cases = [
      { leader: "exits at once", by: "timeout" },
      { leader: "runs on", by: "timeout" },
      { leader: "runs on", by: "abort" },
    ] as const;
    for (const { leader, by } of cases) {
      const what = `leader ${leader}, ${by}`;
      const abort = new AbortController();
      const ready = key();
      // A detached daemon an attempt's build might start: a group of its own, the run's pipes inherited.
      const daemon = `const c = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(FOREVER)}], { stdio: "inherit", detached: true }); c.unref();`;
      const script = `${daemon} process.stdout.write("leader output"); ${announce(ready, "c.pid", leader === "exits at once" ? "process.exit(0)" : "")} ${leader === "runs on" ? FOREVER : ""}`;
      const started = Date.now();
      const running = runProcess("node", ["-e", script], { cwd: CWD, timeoutMs: by === "timeout" ? 1_000 : 60_000, signal: abort.signal });
      const outside = Number(await announced(ready));
      try {
        if (by === "abort") abort.abort();
        const proc = await running;
        const after = Date.now() - started;
        // At once after the kill: well inside runProcess's own CLOSE_AFTER_KILL_MS fallback, so the pipes were closed from this end.
        assert.ok(after < (by === "timeout" ? 1_000 : 0) + 800, `${what}: back ${after} ms after the start, not with the outside process`);
        assert.ok(alive(outside), `${what}: the outside process still runs, so nothing waited for it`);
        assert.equal(proc.stdout, "leader output", `${what}: what was read before the kill is kept`);
        if (by === "timeout") assert.match(proc.error!.message, /timed out/, what);
        assert.deepEqual([proc.status, proc.signal], leader === "exits at once" ? [0, null] : [null, "SIGTERM"], what);
        assert.throws(() => requireCompleted("npm run build", proc), HarnessFault, what);
      } finally {
        process.kill(outside, "SIGKILL");
      }
    }
  });

  it("on a signal, the cleanup waits for a child to shut down on SIGTERM, and sends no SIGKILL within the grace", { timeout: 15_000 }, async () => {
    const abort = new AbortController();
    const ready = key();
    const finished = key();
    // A build or a Playwright run: SIGTERM starts a shutdown that takes a while.
    const script = `process.on("SIGTERM", () => setTimeout(() => { ${announce(finished, '"clean"', "process.exit(0)")} }, 500)); ${announce(ready, '"ready"')} ${FOREVER}`;
    const running = runProcess("node", ["-e", script], { cwd: CWD, timeoutMs: 60_000, signal: abort.signal });
    await announced(ready);
    const [abortCleanup, waitCleanup] = interruptHooks(() => abort.abort()).cleanups;
    const signalled = Date.now();
    await abortCleanup!();
    await waitCleanup!();
    assert.ok(Date.now() - signalled >= 400, "the cleanup waited for the shutdown");
    assert.equal(await announced(finished, 1_000), "clean", "the child finished its shutdown");
    const proc = await running;
    assert.deepEqual([proc.status, proc.signal], [0, null], "it exited by itself, not by SIGKILL");
  });

  it("on a signal, a child that ignores SIGTERM gets SIGKILL after the grace, and the cleanup waits for that too", { timeout: 20_000 }, async () => {
    const abort = new AbortController();
    const ready = key();
    const script = `process.on("SIGTERM", () => {}); ${announce(ready, '"ready"')} ${FOREVER}`;
    const running = runProcess("node", ["-e", script], { cwd: CWD, timeoutMs: 60_000, signal: abort.signal });
    await announced(ready);
    const [abortCleanup, waitCleanup] = interruptHooks(() => abort.abort()).cleanups;
    const signalled = Date.now();
    await abortCleanup!();
    await waitCleanup!();
    const waited = Date.now() - signalled;
    assert.ok(waited >= GRACE_MS - 100 && waited < KILL_WAIT_MS + 2_000, `SIGKILL after the grace: ${waited} ms`);
    assert.equal((await running).signal, "SIGKILL");
  });

  it("a command that does not exist resolves with the spawn error", async () => {
    const proc = await runProcess("score-hard-no-such-command", [], { cwd: CWD, timeoutMs: 10_000, signal: never() });
    assert.equal(proc.status, null);
    assert.match(proc.error!.message, /ENOENT/);
    assert.throws(() => requireCompleted("npm run build", proc), HarnessFault);
  });

  it("killAllProcessesSync, the exit cleanup, kills a group still running", { timeout: 10_000 }, async () => {
    const ready = key();
    const running = runProcess("node", ["-e", `${announce(ready, '"ready"')} ${FOREVER}`], { cwd: CWD, timeoutMs: 60_000, signal: never() });
    await announced(ready);
    killAllProcessesSync();
    assert.equal((await running).signal, "SIGKILL");
  });
});
