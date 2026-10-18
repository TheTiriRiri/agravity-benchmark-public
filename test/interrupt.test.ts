/**
 * `scripts/lib/interrupt.ts`: what a signal means, and what the handlers do
 * with one.
 *
 * The handlers are exercised in a real child process — a fixture entry script
 * spawned with `node --import tsx` in its own process group, signalled the way a
 * terminal signals a foreground group — because delivering a signal to the test
 * runner itself would end the test run.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  detectInterrupt,
  INTERRUPT_EXIT_CODES,
  INTERRUPT_SIGNALS,
  installInterruptHandlers,
  type InterruptSignal,
} from "../scripts/lib/interrupt";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/interrupt/handlers.ts", import.meta.url));
/** A child-process case whose handler never exits fails instead of holding `npm test` forever. */
const CHILD = { timeout: 30_000 };

const scratchDirs: string[] = [];
const children = new Set<number>();

after(() => {
  for (const pid of children) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

// --- recognising an interruption from a child's result ------------------------

test("detectInterrupt reads both shapes a stopped child can take", () => {
  // The signal reached the child through the process group…
  assert.equal(detectInterrupt({ signal: "SIGINT", status: null }), "SIGINT");
  assert.equal(detectInterrupt({ signal: "SIGTERM", status: null }), "SIGTERM");
  assert.equal(detectInterrupt({ signal: "SIGHUP", status: null }), "SIGHUP");
  assert.equal(detectInterrupt({ signal: "SIGQUIT", status: null }), "SIGQUIT");
  // …or the child forwarded it and exited 128+N itself.
  assert.equal(detectInterrupt({ signal: null, status: 130 }), "SIGINT");
  assert.equal(detectInterrupt({ signal: null, status: 143 }), "SIGTERM");
  assert.equal(detectInterrupt({ signal: null, status: 129 }), "SIGHUP");
  assert.equal(detectInterrupt({ signal: null, status: 131 }), "SIGQUIT");

  // A timeout kills with SIGKILL, and that is the child's failure, not the
  // operator stopping the run.
  assert.equal(detectInterrupt({ signal: "SIGKILL", status: null }), null);
  assert.equal(detectInterrupt({ signal: null, status: 137 }), null);
  assert.equal(detectInterrupt({ signal: null, status: 0 }), null);
  assert.equal(detectInterrupt({ signal: null, status: 1 }), null);
  assert.equal(detectInterrupt({ signal: null, status: null }), null);
});

test("the four signals map to the shell's 128+N exit codes", () => {
  assert.deepEqual([...INTERRUPT_SIGNALS], ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]);
  assert.deepEqual(INTERRUPT_EXIT_CODES, { SIGINT: 130, SIGTERM: 143, SIGHUP: 129, SIGQUIT: 131 });
});

// --- no side effects at import -------------------------------------------------

const WATCHED_EVENTS = [...INTERRUPT_SIGNALS, "exit"] as const;

function listenerCounts(): number[] {
  return WATCHED_EVENTS.map((event) => process.listenerCount(event));
}

test("importing docker.ts and interrupt.ts adds no process listener", async () => {
  // A query string makes each import a new module instance, so the modules are
  // evaluated here even though this file already imported interrupt.ts.
  const fresh = (path: string): string => `${new URL(path, import.meta.url).href}?listener-probe=${process.hrtime.bigint()}`;
  const before = listenerCounts();
  const interrupt = await import(fresh("../scripts/lib/interrupt"));
  const docker = await import(fresh("../scripts/lib/docker"));
  assert.equal(typeof interrupt.installInterruptHandlers, "function");
  assert.equal(typeof docker.ensureContainerRemoved, "function");
  assert.deepEqual(listenerCounts(), before);
});

test("installInterruptHandlers adds one listener per signal plus `exit`, and uninstall removes them", () => {
  const before = listenerCounts();
  const handlers = installInterruptHandlers({ cleanups: [], exitCleanups: [] });
  try {
    assert.deepEqual(
      listenerCounts(),
      before.map((count) => count + 1),
    );
    assert.equal(handlers.interrupted(), null);
  } finally {
    handlers.uninstall();
  }
  assert.deepEqual(listenerCounts(), before);
});

// --- the handlers, in a child process -------------------------------------------

interface Fixture {
  pid: number;
  markerDir: string;
  /** Resolves once the handlers are installed. */
  ready: Promise<void>;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>;
}

function startFixture(mode: string, env: Record<string, string> = {}): Fixture {
  const markerDir = mkdtempSync(join(tmpdir(), "agrav-interrupt-test-"));
  scratchDirs.push(markerDir);
  const child = spawn(process.execPath, ["--import", "tsx", FIXTURE, mode], {
    cwd: REPO_ROOT,
    detached: true,
    env: { ...process.env, MARKER_DIR: markerDir, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pid = child.pid as number;
  children.add(pid);

  let output = "";
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("ready\n")) resolve();
    });
    child.on("close", () => reject(new Error(`fixture exited before it was ready:\n${output}`)));
  });
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>((resolve) => {
    child.on("close", (code, signal) => {
      children.delete(pid);
      resolve({ code, signal, output });
    });
  });
  // `ready` rejects on close too; a test that already got past it must not see
  // that as an unhandled rejection.
  ready.catch(() => {});
  return { pid, markerDir, ready, closed };
}

function events(fixture: Fixture): string[] {
  const path = join(fixture.markerDir, "log");
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((line) => line !== "") : [];
}

async function waitForEvent(fixture: Fixture, event: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!events(fixture).includes(event)) {
    if (Date.now() > deadline) throw new Error(`no ${event} within ${timeoutMs} ms; saw ${events(fixture).join(", ")}`);
    await sleep(20);
  }
}

function signalGroup(fixture: Fixture, signal: InterruptSignal): void {
  process.kill(-fixture.pid, signal);
}

test("SIGTERM runs the async cleanup to completion, then the exit cleanups, and exits 143", CHILD, async () => {
  const fixture = startFixture("slow-cleanup", { CLEANUP_MS: "300" });
  await fixture.ready;
  signalGroup(fixture, "SIGTERM");
  const { code, signal } = await fixture.closed;
  assert.equal(signal, null);
  assert.equal(code, 143);
  assert.deepEqual(events(fixture), ["installed", "cleanup-start", "cleanup-done", "exit-cleanup code=143"]);
});

test("SIGINT, SIGHUP and SIGQUIT each clean up and exit 128+N", CHILD, async () => {
  const signals: InterruptSignal[] = ["SIGINT", "SIGHUP", "SIGQUIT"];
  const runs = signals.map(async (signal) => {
    const fixture = startFixture("slow-cleanup", { CLEANUP_MS: "50" });
    await fixture.ready;
    signalGroup(fixture, signal);
    const outcome = await fixture.closed;
    return { signal, code: outcome.code, events: events(fixture) };
  });
  for (const run of await Promise.all(runs)) {
    assert.equal(run.code, INTERRUPT_EXIT_CODES[run.signal], run.signal);
    assert.deepEqual(
      run.events,
      ["installed", "cleanup-start", "cleanup-done", `exit-cleanup code=${INTERRUPT_EXIT_CODES[run.signal]}`],
      run.signal,
    );
  }
});

test("a second signal exits at once with the first signal's code, running the exit cleanups", CHILD, async () => {
  const fixture = startFixture("slow-cleanup", { CLEANUP_MS: "60000" });
  await fixture.ready;
  signalGroup(fixture, "SIGTERM");
  await waitForEvent(fixture, "cleanup-start");
  const sentAt = Date.now();
  signalGroup(fixture, "SIGINT");
  const { code } = await fixture.closed;
  const elapsed = Date.now() - sentAt;
  assert.equal(code, 143, "the first signal's code, not SIGINT's 130");
  assert.ok(elapsed < 5_000, `took ${elapsed} ms to exit after the second signal`);
  // The exit cleanup logs the code handed to `process.exit`, before the `exit`
  // listener's override: this is what tells "exit with the first signal's code"
  // apart from "exit with the second's and let the override fix it up".
  assert.deepEqual(events(fixture), ["installed", "cleanup-start", "exit-cleanup code=143"]);
});

test("a throwing cleanup, sync or async, does not stop the next one; nor does a throwing exit cleanup", CHILD, async () => {
  const fixture = startFixture("throwing");
  await fixture.ready;
  signalGroup(fixture, "SIGINT");
  const { code, output } = await fixture.closed;
  assert.equal(code, 130);
  assert.deepEqual(events(fixture), ["installed", "cleanup-after-throws", "exit-cleanup-after-throw"]);
  assert.match(output, /sync cleanup failure/);
  assert.match(output, /async cleanup failure/);
  assert.match(output, /exit cleanup failure/);
});

test("once interrupted, the process exits 128+N even when main exits with its own code mid-cleanup", CHILD, async () => {
  const fixture = startFixture("exit-race");
  await fixture.ready;
  signalGroup(fixture, "SIGTERM");
  const { code } = await fixture.closed;
  assert.equal(code, 143);
  // main's `process.exit(1)` is what the exit cleanup sees; the override then
  // turns it into 143.
  assert.deepEqual(events(fixture), ["installed", "cleanup-start", "main-exit-1", "exit-cleanup code=1"]);
});

test("without a signal, the exit cleanups still run on a normal exit and the cleanups do not", CHILD, async () => {
  const fixture = startFixture("normal");
  await fixture.ready;
  const { code } = await fixture.closed;
  assert.equal(code, 0);
  assert.deepEqual(events(fixture), ["installed", "interrupted=null", "exit-cleanup code=undefined"]);
});
