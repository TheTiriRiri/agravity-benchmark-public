/**
 * `scripts/lib/dev-server.ts`, driven for real.
 *
 * Everything here owns child processes, and the failures that matter are about
 * what is still running — or still on disk — after a function returns. Nothing
 * is mocked: a fake `npm` is put first on `PATH` and the real code spawns it,
 * exactly as it would spawn the real one; the assertions are made against the
 * operating system and the filesystem, not against a recorded call.
 *
 * - `test/fixtures/dev-server/npm` stands in for `npm run dev`, `npm ping` and
 *   `npm install`. Its dev server listens on a RANDOM port and prints that one
 *   in a Vite-format banner, so no test binds or probes 5173 or 5100.
 * - The six `ensureNodeModules` tests moved here from
 *   `test/take-screenshots-processes.test.ts` with the function; they keep
 *   their inline `/bin/sh` fakes.
 *
 * Every process a fake starts is logged as `<pid> <start time>`, and a test
 * signals one only while `/proc/<pid>/stat` still shows that start time: a pid
 * the kernel has since handed to another process is never touched.
 *
 * Linux only: the fakes read `/proc` and the assertions use process groups.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  busyPorts,
  DevServerError,
  ensureNodeModules,
  groupAlive,
  InstallKilledError,
  isSameProcess,
  killAllProcessesSync,
  killAndWait,
  killGroupAndWait,
  parseLocalBanner,
  pidStartTime,
  probeRegistry,
  readProcStat,
  startVite,
  stopAllProcesses,
  stripAnsi,
  survivingGroups,
  trackProcess,
  type ViteServer,
} from "../scripts/lib/dev-server";
import { isStillRunning, killSurvivors, survivors } from "./fixtures/fake-docker-backend-pids";

const POSIX_ONLY = { skip: process.platform !== "linux" ? "Linux /proc and process groups only" : false };
const FAKE_NPM_DIR = fileURLToPath(new URL("./fixtures/dev-server/", import.meta.url));
const FAKE_NPM_KNOBS = ["FAKE_NPM_STATE", "FAKE_NPM_DEV", "FAKE_NPM_PING", "FAKE_NPM_INSTALL"] as const;

const tempDirs: string[] = [];
/** State directories whose `pids.log` names every process a fake or a test group started. */
const stateDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `agrav-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function makeStateDir(): string {
  const dir = makeTempDir("dev-server-state");
  stateDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const knob of FAKE_NPM_KNOBS) delete process.env[knob];
});

// A failing test can leave a fake server or a test group running: reap every
// one recorded — only while its start time still matches the record — then
// remove the directories.
after(() => {
  for (const dir of stateDirs) killSurvivors(dir);
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * Put an executable named `name` on `PATH` ahead of the real one, and hand back
 * a restore function. The script is written with its paths baked in rather than
 * passed through the environment, so nothing about this test leaks into the
 * environment the fake inherits.
 */
function fakeOnPath(name: string, script: string): () => void {
  const binDir = makeTempDir("bin");
  const scriptPath = join(binDir, name);
  writeFileSync(scriptPath, script, "utf8");
  chmodSync(scriptPath, 0o755);

  const previous = process.env.PATH;
  process.env.PATH = `${binDir}:${previous ?? ""}`;
  return () => {
    process.env.PATH = previous;
  };
}

/**
 * `test/fixtures/dev-server/npm` first on PATH, with a fresh state directory
 * and the given knobs; refuses to go on unless `npm` then answers as the fake.
 */
function useFakeNpm(knobs: Partial<Record<(typeof FAKE_NPM_KNOBS)[number], string>> = {}): { state: string; restore: () => void } {
  const state = makeStateDir();
  const previous = process.env.PATH;
  process.env.PATH = `${FAKE_NPM_DIR}${delimiter}${previous ?? ""}`;
  process.env.FAKE_NPM_STATE = state;
  for (const [key, value] of Object.entries(knobs)) process.env[key] = value;
  const identity = spawnSync("npm", ["--fake-identity"], { encoding: "utf8", timeout: 10_000 });
  if (identity.stdout?.trim() !== "fake-npm") {
    process.env.PATH = previous;
    throw new Error(`\`npm\` on PATH is not the fake in ${FAKE_NPM_DIR}; refusing to run a test that would call the real one`);
  }
  return {
    state,
    restore: () => {
      process.env.PATH = previous;
    },
  };
}

/** Whether a pid is still running. A probe, never a signal. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll until every pid is gone, up to `ms`, and return whoever is left.
 *
 * A killed process group does not vanish on one tick — the shell is reaped by
 * node, its orphaned children by init, and those are not synchronised with each
 * other. Polling briefly distinguishes "reaping lag" from "leaked": a leak here
 * survives for the child's full 30s sleep, which no grace period this short can
 * hide.
 */
async function survivorsAfter(pids: number[], ms: number): Promise<number[]> {
  const deadline = Date.now() + ms;
  let left = pids.filter(alive);
  while (left.length > 0 && Date.now() < deadline) {
    await sleep(50);
    left = left.filter(alive);
  }
  return left;
}

/** Read the pids a fake recorded, one per line (a start time after the pid is ignored here). */
function recordedPids(pidFile: string): number[] {
  assert.ok(existsSync(pidFile), `the fake never ran: ${pidFile} was not written`);
  return readFileSync(pidFile, "utf8")
    .split("\n")
    .map((line) => Number.parseInt(line, 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

/** SIGKILL each `<pid> <start>` line of `pidFile` whose process is provably still the one recorded. */
function killProven(pidFile: string): void {
  if (!existsSync(pidFile)) return;
  for (const line of readFileSync(pidFile, "utf8").split("\n")) {
    const [pidText, start] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    if (!Number.isInteger(pid) || pid <= 0 || start === undefined) continue;
    if (!isStillRunning({ pid, start })) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone in the meantime */
    }
  }
}

/** The recorded processes of `state` still running after up to `ms`: start-time checked, zombies excluded. */
async function provenSurvivorsAfter(state: string, ms: number): Promise<string[]> {
  const deadline = Date.now() + ms;
  let left = survivors(state);
  while (left.length > 0 && Date.now() < deadline) {
    await sleep(50);
    left = survivors(state);
  }
  return left.map((r) => `${r.pid} ${r.start}`);
}

/** Lines of the fake npm's `calls.log`. */
function calls(state: string): string[] {
  const log = join(state, "calls.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").split("\n").filter((line) => line !== "");
}

/**
 * A detached `/bin/sh` group running `body`, which records itself and its
 * children in `<state>/pids.log` (`rec <pid>`). Resolves once `expected`
 * processes are recorded.
 */
async function spawnGroup(state: string, body: string, expected: number, cwd?: string): Promise<ChildProcess> {
  const log = join(state, "pids.log");
  const script = `rec() { echo "$1 $(cut -d' ' -f22 /proc/$1/stat)" >> "${log}"; }\nrec $$\n${body}\n`;
  const proc = spawn("/bin/sh", ["-c", script], { detached: true, stdio: "ignore", cwd });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const lines = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l !== "").length : 0;
    if (lines >= expected) return proc;
    await sleep(20);
  }
  throw new Error(`the test group did not record ${expected} processes in time`);
}

/** Tear down a server a test started, so a failing assertion cannot leave it serving. */
async function release(server: ViteServer | undefined): Promise<void> {
  if (server !== undefined) await killAndWait(server.proc);
}

// --- parseLocalBanner and stripAnsi ---------------------------------------------

test("parseLocalBanner reads Vite's plain banner", () => {
  const banner = "\n  VITE v6.4.3  ready in 123 ms\n\n  ➜  Local:   http://localhost:5173/\n  ➜  Network: use --host to expose\n";
  assert.deepEqual(parseLocalBanner(banner), { url: "http://localhost:5173/", port: 5173 });
});

test("parseLocalBanner reads the banner with its port bolded, as Vite colours it", () => {
  const banner = "  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5174\x1b[22m/\x1b[39m\n";
  assert.deepEqual(parseLocalBanner(banner), { url: "http://localhost:5174/", port: 5174 });
});

test("parseLocalBanner takes 127.0.0.1 and [::1], keeps a base path, and adds a missing slash", () => {
  assert.deepEqual(parseLocalBanner("Local: http://127.0.0.1:4000/"), { url: "http://127.0.0.1:4000/", port: 4000 });
  assert.deepEqual(parseLocalBanner("  ➜  Local:   http://[::1]:5173/"), { url: "http://[::1]:5173/", port: 5173 });
  assert.deepEqual(parseLocalBanner("  ➜  Local:   http://localhost:5173/console/"), { url: "http://localhost:5173/console/", port: 5173 });
  assert.deepEqual(parseLocalBanner("  > Local: http://localhost:3000"), { url: "http://localhost:3000/", port: 3000 });
});

test("parseLocalBanner finds nothing without a local Local: URL", () => {
  assert.equal(parseLocalBanner("  VITE v6.4.3  ready in 123 ms\n"), null);
  assert.equal(parseLocalBanner("  ➜  Network: http://192.168.1.5:5173/\n"), null);
  assert.equal(parseLocalBanner("  proxy target http://localhost:5100/api\n"), null);
  assert.equal(parseLocalBanner("  ➜  Local:   http://example.com:5173/\n"), null);
  assert.equal(parseLocalBanner("  ➜  Local:   http://localhost:99999/\n"), null);
});

test("stripAnsi removes colour, cursor and OSC sequences and nothing else", () => {
  assert.equal(stripAnsi("\x1b[1mbold\x1b[22m \x1b[2J\x1b[H\x1b]0;title\x07plain ➜"), "bold plain ➜");
});

// --- busyPorts ----------------------------------------------------------------------

function hold(host?: string): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    const onListening = (): void => resolve({ server, port: (server.address() as { port: number }).port });
    if (host === undefined) server.listen(0, onListening);
    else server.listen(0, host, onListening);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

test("busyPorts names a port held on 127.0.0.1, and not once it is released", async () => {
  const { server, port } = await hold("127.0.0.1");
  try {
    assert.deepEqual(await busyPorts([port]), [port]);
  } finally {
    await close(server);
  }
  assert.deepEqual(await busyPorts([port]), []);
});

test("busyPorts names a port held on the unspecified address", async () => {
  const { server, port } = await hold();
  try {
    assert.deepEqual(await busyPorts([port]), [port]);
  } finally {
    await close(server);
  }
});

test("busyPorts names a port held on [::1] only, which a 127.0.0.1 bind alone would miss", async (t) => {
  let held: { server: Server; port: number };
  try {
    held = await hold("::1");
  } catch {
    t.skip("no IPv6 loopback here");
    return;
  }
  try {
    assert.deepEqual(await busyPorts([held.port]), [held.port]);
  } finally {
    await close(held.server);
  }
});

test("busyPorts returns only the busy ones, in the order given, and refuses a non-port", async () => {
  const a = await hold("127.0.0.1");
  const b = await hold("127.0.0.1");
  const free = await hold("127.0.0.1");
  await close(free.server);
  try {
    assert.deepEqual(await busyPorts([b.port, free.port, a.port]), [b.port, a.port]);
  } finally {
    await close(a.server);
    await close(b.server);
  }
  await assert.rejects(busyPorts([0]), RangeError);
  await assert.rejects(busyPorts([65536]), RangeError);
  await assert.rejects(busyPorts([80.5]), RangeError);
});

// --- /proc identity ------------------------------------------------------------------

test("pidStartTime and isSameProcess name one process, and a dead or impossible pid names none", POSIX_ONLY, async () => {
  const start = pidStartTime(process.pid);
  assert.match(start ?? "", /^\d+$/);
  assert.equal(readProcStat(process.pid)?.start, start);
  assert.equal(isSameProcess(process.pid, start), true);
  assert.equal(isSameProcess(process.pid, String(BigInt(start as string) + 1n)), false);
  assert.equal(isSameProcess(process.pid, null), false);
  assert.equal(pidStartTime(0), null);
  assert.equal(pidStartTime(-1), null);

  const child = spawn("/bin/true", [], { stdio: "ignore" });
  const pid = child.pid as number;
  await new Promise((done) => child.once("close", done));
  assert.equal(pidStartTime(pid), null, "an exited, reaped child has no start time");
});

// --- the process-group helpers -------------------------------------------------------

/**
 * A group whose shell died but whose children did not. "The direct child has
 * exited" is not evidence that its group is dead, and `killAndWait` once
 * treated it as such.
 */
test("killAndWait reaps a process group that outlives its dead leader", POSIX_ONLY, async () => {
  const state = makeStateDir();
  const proc = await spawnGroup(state, "sleep 30 &\nrec $!\nexit 0", 2);
  await new Promise((done) => (proc.exitCode === null ? proc.once("close", done) : done(null)));
  const leftBefore = await provenSurvivorsAfter(state, 0);
  assert.equal(leftBefore.length, 1, "the leader was supposed to be gone and its child alive");

  await killAndWait(proc);
  assert.deepEqual(await provenSurvivorsAfter(state, 2000), [], "the process group outlived killAndWait");
});

test("killAndWait escalates to SIGKILL for a group that ignores SIGTERM", POSIX_ONLY, async () => {
  const state = makeStateDir();
  const proc = await spawnGroup(state, "trap '' TERM\nsleep 30 &\nrec $!\nwait", 2);
  const t0 = Date.now();
  await killAndWait(proc);
  assert.deepEqual(await provenSurvivorsAfter(state, 1000), []);
  assert.ok(Date.now() - t0 >= 2500, "SIGTERM was ignored, so only the SIGKILL after the grace period could have ended it");
});

test("killGroupAndWait kills a group known only by its id, and refuses no-group ids", POSIX_ONLY, async () => {
  const state = makeStateDir();
  const proc = await spawnGroup(state, "sleep 30 &\nrec $!\nwait", 2);
  assert.equal(await killGroupAndWait(proc.pid as number), true);
  assert.equal(groupAlive(proc.pid as number), false);
  assert.deepEqual(await provenSurvivorsAfter(state, 1000), []);
  await assert.rejects(killGroupAndWait(0), RangeError);
  await assert.rejects(killGroupAndWait(1), RangeError);
  await assert.rejects(killGroupAndWait(-5), RangeError);
});

test("stopAllProcesses kills every tracked group; a second caller joins it; it is not a one-shot", POSIX_ONLY, async () => {
  const state = makeStateDir();
  trackProcess(await spawnGroup(state, "sleep 30 &\nrec $!\nwait", 2));
  trackProcess(await spawnGroup(state, "trap '' TERM\nsleep 30 &\nrec $!\nwait", 4));

  const first = stopAllProcesses();
  const second = stopAllProcesses();
  assert.equal(second, first, "a caller during a stop gets the stop in flight, not an early return");
  await second;
  assert.deepEqual(await provenSurvivorsAfter(state, 0), [], "the joined stop resolved before the groups were gone");

  // After a stop has finished, the next one still stops what is tracked by then.
  const later = makeStateDir();
  trackProcess(await spawnGroup(later, "sleep 30 &\nrec $!\nwait", 2));
  await stopAllProcesses();
  assert.deepEqual(await provenSurvivorsAfter(later, 0), []);
});

test("stopAllProcesses with nothing tracked leaves the next call free to stop what is tracked by then", POSIX_ONLY, async () => {
  await stopAllProcesses();
  await stopAllProcesses();
  const state = makeStateDir();
  trackProcess(await spawnGroup(state, "sleep 30 &\nrec $!\nwait", 2));
  await stopAllProcesses();
  assert.deepEqual(await provenSurvivorsAfter(state, 0), [], "an empty stop stuck, and the later one returned without stopping anything");
});

test("killAllProcessesSync SIGKILLs every tracked group without waiting", POSIX_ONLY, async () => {
  const state = makeStateDir();
  trackProcess(await spawnGroup(state, "trap '' TERM\nsleep 30 &\nrec $!\nwait", 2));
  killAllProcessesSync();
  assert.deepEqual(await provenSurvivorsAfter(state, 2000), []);
  await stopAllProcesses(); // untracks what is gone, signalling nothing that lives
  assert.deepEqual(survivingGroups(), []);
});

/** Wait until `test` holds, up to `ms`; fail with `what` otherwise. */
async function until(test: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!test()) {
    if (Date.now() >= deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/**
 * The gap a review found: `killAndWait` used to untrack a process before its
 * group was gone, so a `stopAllProcesses` started during the SIGTERM grace
 * returned at once — and a signal handler then exited with the group alive,
 * before the SIGKILL escalation could run.
 */
test("a killAndWait in flight keeps its group tracked: stopAllProcesses waits for it, a second killAndWait joins it", POSIX_ONLY, async () => {
  const state = makeStateDir();
  const proc = await spawnGroup(state, "trap '' TERM\nsleep 30 &\nrec $!\nwait", 2);
  const t0 = Date.now();
  const kill = killAndWait(proc);
  assert.equal(killAndWait(proc), kill, "a second caller joins the kill in flight");
  await sleep(100);
  assert.deepEqual(survivingGroups(), [proc.pid], "still tracked while its kill is in flight");

  await stopAllProcesses();
  assert.deepEqual(await provenSurvivorsAfter(state, 0), [], "stopAllProcesses returned while the group was alive");
  assert.ok(Date.now() - t0 >= 2500, "SIGTERM was ignored, so only the SIGKILL after the grace could have ended it");
  assert.deepEqual(survivingGroups(), []);
  await kill;
});

test("an aborted startVite try that ignores SIGTERM: stopAllProcesses waits for its SIGKILL", POSIX_ONLY, async () => {
  const npm = useFakeNpm({ FAKE_NPM_DEV: "stubborn" });
  try {
    const controller = new AbortController();
    const spawned: number[] = [];
    const pending = startVite(makeTempDir("frontend"), { timeoutMs: 20_000, signal: controller.signal, onSpawn: (pid) => spawned.push(pid) }).then(
      () => assert.fail("a dev server that printed no URL was believed"),
      (error: unknown) => error,
    );
    await until(() => existsSync(join(npm.state, "stubborn")), 10_000, "the fake to ignore SIGTERM");

    // What `ServeSession.stopFrontend` does: abort, then wait for everything tracked.
    controller.abort();
    await stopAllProcesses();
    assert.deepEqual(await provenSurvivorsAfter(npm.state, 0), [], "stopAllProcesses returned before the aborted try's group was gone");
    assert.equal(groupAlive(spawned[0]), false);

    assert.match(String(await pending), /aborted/);
    assert.deepEqual(calls(npm.state), ["run dev"], "no other try after the abort");
  } finally {
    npm.restore();
  }
});

test("killAllProcessesSync SIGKILLs a group whose killAndWait is still in its SIGTERM grace", POSIX_ONLY, async () => {
  const state = makeStateDir();
  const proc = await spawnGroup(state, "trap '' TERM\nsleep 30 &\nrec $!\nwait", 2);
  const kill = killAndWait(proc);
  await sleep(200);
  const t0 = Date.now();
  // What the exit listener does when a second signal cuts the stop short.
  killAllProcessesSync();
  assert.deepEqual(await provenSurvivorsAfter(state, 1000), [], "the exit listener's SIGKILL skipped a group whose kill was in flight");
  assert.ok(Date.now() - t0 < 2000, "gone well before killAndWait's own escalation");
  await kill;
  assert.deepEqual(survivingGroups(), []);
});

// --- probeRegistry -------------------------------------------------------------------

test("probeRegistry: npm ping exiting 0 is a reachable registry", POSIX_ONLY, async () => {
  const npm = useFakeNpm({ FAKE_NPM_PING: "ok" });
  try {
    assert.equal(await probeRegistry(5000), true);
    assert.deepEqual(calls(npm.state), ["ping"]);
  } finally {
    npm.restore();
  }
});

test("probeRegistry: npm ping failing is an unreachable registry", POSIX_ONLY, async () => {
  const npm = useFakeNpm({ FAKE_NPM_PING: "fail" });
  try {
    assert.equal(await probeRegistry(5000), false);
  } finally {
    npm.restore();
  }
});

test("probeRegistry: an npm ping that hangs is unreachable at the deadline, and leaves nothing running", POSIX_ONLY, async () => {
  const npm = useFakeNpm({ FAKE_NPM_PING: "hang" });
  try {
    const t0 = Date.now();
    assert.equal(await probeRegistry(700), false);
    assert.ok(Date.now() - t0 < 5000, "the probe waited far past its deadline");
    assert.deepEqual(await provenSurvivorsAfter(npm.state, 1000), [], "npm ping or its child outlived the probe");
  } finally {
    npm.restore();
  }
});

test("probeRegistry asks from the repository root, never from the caller's directory, whose .npmrc may be a model's", POSIX_ONLY, async () => {
  const npm = useFakeNpm({ FAKE_NPM_PING: "ok" });
  const elsewhere = makeTempDir("frontend");
  writeFileSync(join(elsewhere, ".npmrc"), "registry=http://127.0.0.1:9/\n");
  const previous = process.cwd();
  process.chdir(elsewhere);
  try {
    assert.equal(await probeRegistry(5000), true);
  } finally {
    process.chdir(previous);
    npm.restore();
  }
  const root = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
  assert.equal(readFileSync(join(npm.state, "ping-cwd"), "utf8"), root);
});

test("probeRegistry: no npm at all is an unreachable registry", POSIX_ONLY, async () => {
  const previous = process.env.PATH;
  process.env.PATH = makeTempDir("empty-path");
  try {
    assert.equal(await probeRegistry(5000), false);
  } finally {
    process.env.PATH = previous;
  }
});

// --- startVite -----------------------------------------------------------------------

function portOf(state: string): number {
  return Number(readFileSync(join(state, "port"), "utf8"));
}

test("startVite reads the port from the plain banner and returns a server that answers", POSIX_ONLY, async () => {
  const npm = useFakeNpm({ FAKE_NPM_DEV: "plain" });
  const spawned: number[] = [];
  let server: ViteServer | undefined;
  try {
    server = await startVite(makeTempDir("frontend"), { timeoutMs: 10_000, onSpawn: (pid) => spawned.push(pid) });
    const port = portOf(npm.state);
    assert.equal(server.port, port, "the port is read from the banner, never assumed");
    assert.equal(server.url, `http://localhost:${port}/`);
    assert.deepEqual(spawned, [server.proc.pid], "onSpawn names the one leader, right after its spawn");
    assert.equal(groupAlive(server.proc.pid as number), true, "the server is returned still running");
    assert.equal((await fetch(server.url)).status, 200);
    assert.deepEqual(calls(npm.state), ["run dev"]);
  } finally {
    await release(server);
    npm.restore();
  }
  assert.deepEqual(await provenSurvivorsAfter(npm.state, 2000), []);
});

test("startVite reads the port from an ANSI-coloured banner with the port bolded", POSIX_ONLY, async () => {
  const npm = useFakeNpm({ FAKE_NPM_DEV: "ansi" });
  let server: ViteServer | undefined;
  try {
    server = await startVite(makeTempDir("frontend"), { timeoutMs: 10_000 });
    assert.equal(server.port, portOf(npm.state));
    assert.equal(server.url, `http://localhost:${server.port}/`);
  } finally {
    await release(server);
    npm.restore();
  }
});

test("startVite takes a 127.0.0.1 URL, and any HTTP status as serving", POSIX_ONLY, async () => {
  const npm = useFakeNpm({ FAKE_NPM_DEV: "ipv4-404" });
  let server: ViteServer | undefined;
  try {
    server = await startVite(makeTempDir("frontend"), { timeoutMs: 10_000 });
    assert.equal(server.url, `http://127.0.0.1:${portOf(npm.state)}/`);
  } finally {
    await release(server);
    npm.restore();
  }
});

test("startVite: no banner is retried once, then a DevServerError, and nothing survives", POSIX_ONLY, async () => {
  const npm = useFakeNpm({ FAKE_NPM_DEV: "silent" });
  const spawned: number[] = [];
  try {
    const error = await startVite(makeTempDir("frontend"), { timeoutMs: 800, onSpawn: (pid) => spawned.push(pid) }).then(
      () => assert.fail("a dev server that prints no URL was believed"),
      (e: unknown) => e,
    );
    assert.ok(error instanceof DevServerError, String(error));
    assert.match(error.message, /did not serve after 2 tries \(try 1: printed no Local: URL within 0\.8s; try 2: printed no Local: URL within 0\.8s\)/);
    assert.deepEqual(calls(npm.state), ["run dev", "run dev"], "exactly one retry");
    assert.equal(spawned.length, 2);
    assert.deepEqual(await provenSurvivorsAfter(npm.state, 1000), [], "a try that did not serve left processes behind");
  } finally {
    npm.restore();
  }
});

test("startVite: a dev server that exits early is retried once, and the error carries its output", POSIX_ONLY, async () => {
  const npm = useFakeNpm({ FAKE_NPM_DEV: "early-exit" });
  try {
    const error = await startVite(makeTempDir("frontend"), { timeoutMs: 10_000 }).then(
      () => assert.fail("a dev server that exited was believed"),
      (e: unknown) => e,
    );
    assert.ok(error instanceof DevServerError);
    assert.match(error.message, /try 1: exited \(code 1\) before it served; try 2: exited \(code 1\) before it served/);
    assert.match(error.outputTail, /Cannot find module 'vite'/);
    assert.deepEqual(calls(npm.state), ["run dev", "run dev"]);
    assert.deepEqual(await provenSurvivorsAfter(npm.state, 1000), []);
  } finally {
    npm.restore();
  }
});

test("startVite: a first try that fails and a retry that serves is a server", POSIX_ONLY, async () => {
  const npm = useFakeNpm({ FAKE_NPM_DEV: "flaky" });
  let server: ViteServer | undefined;
  try {
    server = await startVite(makeTempDir("frontend"), { timeoutMs: 10_000 });
    assert.equal(server.port, portOf(npm.state));
    assert.deepEqual(calls(npm.state), ["run dev", "run dev"]);
    const left = await provenSurvivorsAfter(npm.state, 1000);
    assert.equal(left.length, 2, `only the serving try and its child may run: ${JSON.stringify(left)}`);
    assert.ok(left.some((entry) => entry.startsWith(`${server?.proc.pid} `)));
  } finally {
    await release(server);
    npm.restore();
  }
});

test("startVite: a URL that never answers HTTP is not a server", POSIX_ONLY, async () => {
  const npm = useFakeNpm({ FAKE_NPM_DEV: "banner-no-http" });
  try {
    await assert.rejects(startVite(makeTempDir("frontend"), { timeoutMs: 1000, retries: 0 }), (error: unknown) => {
      assert.ok(error instanceof DevServerError);
      assert.match(error.message, /^npm run dev did not serve \(try 1: printed http:\/\/localhost:\d+\/ but it did not answer HTTP within 1s\)$/);
      return true;
    });
    assert.deepEqual(calls(npm.state), ["run dev"], "retries: 0 is one try");
    assert.deepEqual(await provenSurvivorsAfter(npm.state, 1000), []);
  } finally {
    npm.restore();
  }
});

test("startVite: an abort kills the try in flight and starts no other; it is not a DevServerError", POSIX_ONLY, async () => {
  const npm = useFakeNpm({ FAKE_NPM_DEV: "silent" });
  try {
    const controller = new AbortController();
    const pending = startVite(makeTempDir("frontend"), { timeoutMs: 10_000, signal: controller.signal });
    await sleep(400);
    controller.abort();
    await assert.rejects(pending, (error: unknown) => !(error instanceof DevServerError) && /aborted/.test(String(error)));
    assert.deepEqual(calls(npm.state), ["run dev"]);
    assert.deepEqual(await provenSurvivorsAfter(npm.state, 1000), []);

    await assert.rejects(startVite(makeTempDir("frontend"), { signal: controller.signal }), /aborted/);
    assert.deepEqual(calls(npm.state), ["run dev"], "an already-aborted signal spawns nothing");
  } finally {
    npm.restore();
  }
});

test("startVite: npm that cannot be started, or an onSpawn that throws, is the harness's error", POSIX_ONLY, async () => {
  const previous = process.env.PATH;
  process.env.PATH = makeTempDir("empty-path");
  try {
    await assert.rejects(startVite(makeTempDir("frontend"), { timeoutMs: 2000 }), (error: unknown) => {
      assert.ok(!(error instanceof DevServerError));
      assert.match(String(error), /npm run dev could not be started/);
      return true;
    });
  } finally {
    process.env.PATH = previous;
  }

  const npm = useFakeNpm({ FAKE_NPM_DEV: "plain" });
  try {
    await assert.rejects(
      startVite(makeTempDir("frontend"), {
        timeoutMs: 10_000,
        onSpawn: () => {
          throw new Error("the state file could not be written");
        },
      }),
      (error: unknown) => !(error instanceof DevServerError) && /the state file could not be written/.test(String(error)),
    );
    assert.deepEqual(await provenSurvivorsAfter(npm.state, 2000), []);
  } finally {
    npm.restore();
  }
});

test("importing dev-server installs no process handler and spawns nothing", async () => {
  const events = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "exit", "beforeExit", "uncaughtException"] as const;
  const before = events.map((e) => process.listenerCount(e));
  const fresh = await import(`${new URL("../scripts/lib/dev-server", import.meta.url).href}?listener-probe=${process.hrtime.bigint()}`);
  assert.equal(typeof fresh.startVite, "function");
  assert.deepEqual(events.map((e) => process.listenerCount(e)), before);
});

// --- ensureNodeModules: the timeout must not be worse than no timeout ---------

/**
 * The demonstrated race. `npm` writes `package-lock.json` while it is shutting
 * down, after the SIGTERM; the cleanup that removes an install-created lockfile
 * used to run on the same tick as the kill, so the file landed afterwards and
 * survived — in a directory the invariants say holds model output only, with no
 * `.gitignore` line to hide it.
 */
test("an install killed mid-lockfile-write still leaves no lockfile behind", POSIX_ONLY, async () => {
  const projectRoot = makeTempDir("project");
  writeFileSync(join(projectRoot, "package.json"), "{}\n", "utf8");
  const lockPath = join(projectRoot, "package-lock.json");

  const restorePath = fakeOnPath(
    "npm",
    `#!/bin/sh
trap 'sleep 0.3; echo "{}" > "${lockPath}"; exit 0' TERM
sleep 30 &
wait
`,
  );

  try {
    await assert.rejects(ensureNodeModules(projectRoot, 500), /npm install did not finish within 1s/);
    // Long enough for the dying npm's write to have landed. Asserting on the
    // tick the rejection arrives would pass against the bug: the file does not
    // exist yet at that moment, which is precisely why the cleanup missed it.
    await sleep(800);
    assert.equal(existsSync(lockPath), false, "a lockfile npm wrote while dying survived the cleanup");
  } finally {
    restorePath();
  }
});

/** A lockfile the model shipped is still not this script's to delete. */
test("a model's own lockfile survives an install timeout", POSIX_ONLY, async () => {
  const projectRoot = makeTempDir("project");
  writeFileSync(join(projectRoot, "package.json"), "{}\n", "utf8");
  const lockPath = join(projectRoot, "package-lock.json");
  writeFileSync(lockPath, '{"lockfileVersion":3}\n', "utf8");

  const restorePath = fakeOnPath(
    "npm",
    `#!/bin/sh
sleep 30 &
wait
`,
  );

  try {
    await assert.rejects(ensureNodeModules(projectRoot, 500), /npm install did not finish within 1s/);
    assert.equal(readFileSync(lockPath, "utf8"), '{"lockfileVersion":3}\n');
  } finally {
    restorePath();
  }
});

/** A child that ignores SIGTERM is still not allowed to outlive the call. */
test("an install that ignores SIGTERM is escalated to SIGKILL", POSIX_ONLY, async () => {
  const projectRoot = makeTempDir("project");
  writeFileSync(join(projectRoot, "package.json"), "{}\n", "utf8");
  const pidFile = join(projectRoot, "pids.txt");

  const restorePath = fakeOnPath(
    "npm",
    `#!/bin/sh
trap '' TERM
echo "$$ $(cut -d' ' -f22 /proc/$$/stat)" > "${pidFile}"
sleep 30 &
echo "$! $(cut -d' ' -f22 /proc/$!/stat)" >> "${pidFile}"
wait
`,
  );

  try {
    await assert.rejects(ensureNodeModules(projectRoot, 500), /npm install did not finish within 1s/);
    const survivors = await survivorsAfter(recordedPids(pidFile), 2000);
    assert.deepEqual(survivors, [], `install processes outlived ensureNodeModules: ${JSON.stringify(survivors)}`);
  } finally {
    restorePath();
    // Only a process whose start time is still the one it recorded: never a reused pid.
    killProven(pidFile);
  }
});

/** The happy path is untouched: a clean install resolves and cleans up its lockfile. */
test("a successful install resolves and removes the lockfile it created", POSIX_ONLY, async () => {
  const projectRoot = makeTempDir("project");
  writeFileSync(join(projectRoot, "package.json"), "{}\n", "utf8");
  const lockPath = join(projectRoot, "package-lock.json");

  const restorePath = fakeOnPath(
    "npm",
    `#!/bin/sh
echo "{}" > "${lockPath}"
mkdir -p "${join(projectRoot, "node_modules")}"
exit 0
`,
  );

  try {
    await ensureNodeModules(projectRoot, 10_000);
    assert.equal(existsSync(lockPath), false, "the lockfile this install created was not removed");
    assert.equal(existsSync(join(projectRoot, "node_modules")), true, "node_modules is kept, it is gitignored");
  } finally {
    restorePath();
  }
});

/** A failing install still reports the exit code, and still cleans up. */
test("a failing install rejects with npm's exit code and removes its lockfile", POSIX_ONLY, async () => {
  const projectRoot = makeTempDir("project");
  writeFileSync(join(projectRoot, "package.json"), "{}\n", "utf8");
  const lockPath = join(projectRoot, "package-lock.json");

  const restorePath = fakeOnPath(
    "npm",
    `#!/bin/sh
echo "{}" > "${lockPath}"
echo "npm error code ETARGET" >&2
exit 1
`,
  );

  try {
    await assert.rejects(ensureNodeModules(projectRoot, 10_000), /npm install failed \(exit 1\).*ETARGET/s);
    assert.equal(existsSync(lockPath), false);
  } finally {
    restorePath();
  }
});

/** An attempt that was already installed is never touched. */
test("an attempt that already has node_modules is not installed again", POSIX_ONLY, async () => {
  const projectRoot = makeTempDir("project");
  writeFileSync(join(projectRoot, "package.json"), "{}\n", "utf8");
  mkdirSync(join(projectRoot, "node_modules"));
  const marker = join(projectRoot, "ran.txt");

  const restorePath = fakeOnPath("npm", `#!/bin/sh\ntouch "${marker}"\n`);

  try {
    await ensureNodeModules(projectRoot, 10_000);
    assert.equal(existsSync(marker), false, "npm was run for an attempt that already had node_modules");
  } finally {
    restorePath();
  }
});

// --- ensureNodeModules: whose failure an ended install is -----------------------

/**
 * npm's stdout is not read by anyone. A pipe for it fills at 64 KiB, and a
 * root lifecycle script with more to say then blocks npm until the install
 * timeout — which, with the registry answering, is a frontend stop.
 */
test("an install that writes 2 MB to stdout still finishes: nobody has to read npm's stdout", POSIX_ONLY, async () => {
  const projectRoot = makeTempDir("project");
  writeFileSync(join(projectRoot, "package.json"), "{}\n", "utf8");
  const npm = useFakeNpm({ FAKE_NPM_INSTALL: "chatty" });
  try {
    await ensureNodeModules(projectRoot, 8000);
    assert.equal(existsSync(join(projectRoot, "node_modules")), true);
  } finally {
    npm.restore();
  }
});

test("npm ended by a signal the harness did not send is an InstallKilledError, a harness fault", POSIX_ONLY, async () => {
  const projectRoot = makeTempDir("project");
  writeFileSync(join(projectRoot, "package.json"), "{}\n", "utf8");
  const npm = useFakeNpm({ FAKE_NPM_INSTALL: "killed" });
  try {
    await assert.rejects(ensureNodeModules(projectRoot, 10_000), (error: unknown) => {
      assert.ok(error instanceof InstallKilledError, String(error));
      assert.equal(error.signal, "SIGKILL");
      assert.match(error.message, /npm install was killed by SIGKILL, which the harness did not send/);
      return true;
    });
    assert.deepEqual(calls(npm.state), ["install"]);
  } finally {
    npm.restore();
  }
});

test("npm exiting 137 is an ordinary failure: npm says that for a lifecycle script that crashed", POSIX_ONLY, async () => {
  const projectRoot = makeTempDir("project");
  writeFileSync(join(projectRoot, "package.json"), "{}\n", "utf8");
  const npm = useFakeNpm({ FAKE_NPM_INSTALL: "exit-137" });
  try {
    await assert.rejects(ensureNodeModules(projectRoot, 10_000), (error: unknown) => {
      assert.ok(!(error instanceof InstallKilledError), String(error));
      assert.match((error as Error).message, /npm install failed \(exit 137\).*command failed/s);
      return true;
    });
  } finally {
    npm.restore();
  }
});

test("npm ended by the harness's own teardown is not an InstallKilledError", POSIX_ONLY, async () => {
  const projectRoot = makeTempDir("project");
  writeFileSync(join(projectRoot, "package.json"), "{}\n", "utf8");
  const npm = useFakeNpm({ FAKE_NPM_INSTALL: "hang" });
  try {
    const install = ensureNodeModules(projectRoot, 30_000);
    await until(() => calls(npm.state).includes("install"), 10_000, "npm install to start");
    // What a signal handler's cleanup does.
    await stopAllProcesses();
    await assert.rejects(install, (error: unknown) => {
      assert.ok(!(error instanceof InstallKilledError), String(error));
      assert.match((error as Error).message, /npm install failed \(ended by SIGTERM\)/);
      return true;
    });
    assert.deepEqual(await provenSurvivorsAfter(npm.state, 1000), []);
  } finally {
    npm.restore();
  }
});
