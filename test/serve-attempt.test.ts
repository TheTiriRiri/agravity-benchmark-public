/**
 * `scripts/serve-attempt.ts`.
 *
 * Serving first, in process: `serveAttempt` with a scripted backend and fake
 * frontend steps, so every branch — the lock, the ports, a backend or frontend
 * stop, a harness fault, an interruption — runs without docker, npm or a port.
 * The Vite group is a real detached `sleep`, so the teardown's kill is real.
 *
 * Then `--stop` in process: a dead owner's containers through an injected
 * `docker`, and its Vite group — a real process group this test started —
 * killed only once proven. Then the whole thing across processes: the fixture
 * `test/fixtures/serve-attempt-live.fixture.ts` runs `runServe` with its real
 * handlers, the real `AttemptBackend` through the stateful fake `docker`, and
 * the real `startVite` through the fake `npm`; `stopServe` stops it.
 *
 * No test binds or probes the real ports 5100 and 5173: `busyPorts` is always
 * injected, and the fakes serve on random ports. No test signals a process it
 * cannot prove it started: every pid is logged with its start time.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import type { BackendOptions, ContainerRemoval, StartResult, StepResult } from "../scripts/lib/attempt-backend";
import {
  DevServerError,
  groupAlive,
  InstallKilledError,
  KILL_WAIT_MS,
  killAllProcessesSync,
  pidStartTime,
  startVite,
  trackProcess,
  type StartViteOptions,
  type ViteServer,
} from "../scripts/lib/dev-server";
import { DOCKER_CLI_TIMEOUT_MS, scratchDirPrefix, type DockerRun, type SweepResult } from "../scripts/lib/docker";
import { writeRunJson, type RunJson } from "../scripts/lib/run-json";
import { readScoringImage } from "../scripts/lib/runner-config";
import {
  isServeOwnerLive,
  parseArgs,
  parseServeState,
  readServeState,
  REPO_ROOT,
  SERVE_STATE_FILE,
  serveAttempt,
  statePath,
  STOP_WAIT_MS,
  stopCommand,
  stopServe,
  type ServeBackend,
  type ServeDeps,
  type ServeOptions,
  type ServeOutcome,
  type ServeSession,
  type ServeState,
  type StopDeps,
} from "../scripts/serve-attempt";
import { killSurvivors, survivors } from "./fixtures/fake-docker-backend-pids";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "scripts", "serve-attempt.ts");
const FIXTURE = fileURLToPath(new URL("./fixtures/serve-attempt-live.fixture.ts", import.meta.url));
const FAKE_DOCKER_DIR = fileURLToPath(new URL("./fixtures/fake-docker-backend/", import.meta.url));
const FAKE_NPM_DIR = fileURLToPath(new URL("./fixtures/dev-server/", import.meta.url));
const ATTEMPT = "demo-attempt-1";
const TAG = "agrav-bench/harness:2026-09-18";
const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const REF = `${TAG}@${IMAGE_ID}`;
/** What the fake docker's `image inspect` answers. */
const FAKE_IMAGE_ID = `sha256:${"f".repeat(64)}`;
const FREEZE = ["fastapi==0.115.14", "uvicorn==0.30.6"];
const OK: StepResult = { kind: "ok" };
const REMOVED: ContainerRemoval = { removed: true, detail: "removed" };
const SERVE_NAME = `agrav-backend-${ATTEMPT}-${process.pid}-2`;
const INSTALL_NAME = `agrav-backend-${ATTEMPT}-${process.pid}-1`;
const EMPTY_SWEEP: SweepResult = { removedContainers: [], removedDirs: [], failed: [] };
const POSIX_ONLY = { skip: process.platform !== "linux" ? "Linux /proc and process groups only" : false };

const scratch: string[] = [];
/** State directories whose `pids.log` names every process a fake or a test group started. */
const stateDirs: string[] = [];
/** Children this file spawned, until reaped: their groups are provably ours while they are unreaped. */
const children = new Set<ChildProcess>();

after(async () => {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) continue;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // gone in the meantime
    }
  }
  for (const dir of stateDirs) killSurvivors(dir);
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function stateDir(): string {
  const dir = tempDir("agrav-serve-state-");
  stateDirs.push(dir);
  return dir;
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** A --root with the attempt: a backend layout, and a frontend with package.json unless told otherwise. */
function serveRoot(options: { frontend?: boolean; attempt?: string } = {}): string {
  const root = tempDir("agrav-serve-root-");
  const attemptDir = join(root, "eval-attempts", options.attempt ?? ATTEMPT);
  mkdirSync(join(attemptDir, "backend", "app"), { recursive: true });
  writeFileSync(join(attemptDir, "backend", "requirements.txt"), "fastapi==0.115.14\nuvicorn==0.30.6\n");
  writeFileSync(join(attemptDir, "backend", "app", "main.py"), "from fastapi import FastAPI\napp = FastAPI()\n");
  if (options.frontend ?? true) {
    mkdirSync(join(attemptDir, "frontend", "node_modules"), { recursive: true });
    writeFileSync(join(attemptDir, "frontend", "package.json"), '{"scripts":{"dev":"vite"}}\n');
  }
  return root;
}

function frontendDir(root: string, attempt = ATTEMPT): string {
  return join(root, "eval-attempts", attempt, "frontend");
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
  children.add(proc);
  proc.once("close", () => children.delete(proc));
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const lines = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l !== "").length : 0;
    if (lines >= expected) return proc;
    await sleep(20);
  }
  throw new Error(`the test group did not record ${expected} processes in time`);
}

/** The recorded processes of `state` still running after up to `ms`: start-time checked, zombies excluded. */
async function survivorsAfter(state: string, ms: number): Promise<string[]> {
  const deadline = Date.now() + ms;
  let left = survivors(state);
  while (left.length > 0 && Date.now() < deadline) {
    await sleep(50);
    left = survivors(state);
  }
  return left.map((r) => `${r.pid} ${r.start}`);
}

/** Wait until `check` holds, up to `ms`; fail naming `what` otherwise. */
async function until(check: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() >= deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** The fake npm's invocations, one line each. */
function npmCalls(state: string): string[] {
  const log = join(state, "calls.log");
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((line) => line !== "") : [];
}

// ---------------------------------------------------------------------------
// in-process fakes

interface BackendScript {
  layout?: StepResult;
  install?: StepResult;
  freeze?: string[] | Error;
  start?: StartResult;
  dispose?: ContainerRemoval[];
  onInstall?: () => void;
}

class FakeBackend implements ServeBackend {
  readonly calls: string[] = [];
  /** Made as `AttemptBackend` makes its own: through `scratchDirPrefix`, before the first container. */
  scratchDir: string | null = null;
  constructor(
    readonly options: BackendOptions,
    private readonly script: BackendScript,
    private readonly observe: (what: string, value: unknown) => void,
  ) {}
  checkLayout(): StepResult {
    this.calls.push("checkLayout");
    return this.script.layout ?? OK;
  }
  async install(): Promise<StepResult> {
    this.calls.push("install");
    this.scratchDir = mkdtempSync(join(this.options.tmpRoot as string, scratchDirPrefix(process.pid)));
    this.options.onContainer?.(INSTALL_NAME, "install", this.scratchDir as string);
    this.observe("container at install's docker run", readServeState(this.options.attemptDir.replace(/\/eval-attempts\/[^/]+$/, ""))?.container);
    this.script.onInstall?.();
    return this.script.install ?? OK;
  }
  async pipFreeze(): Promise<string[]> {
    this.calls.push("pipFreeze");
    const freeze = this.script.freeze ?? FREEZE;
    if (freeze instanceof Error) throw freeze;
    return freeze;
  }
  async start(): Promise<StartResult> {
    this.calls.push("start");
    this.options.onContainer?.(SERVE_NAME, "serve", this.scratchDir as string);
    return this.script.start ?? { kind: "ready", baseUrl: "http://127.0.0.1:5100", container: SERVE_NAME };
  }
  async stop(): Promise<ContainerRemoval> {
    this.calls.push("stop");
    return REMOVED;
  }
  async dispose(): Promise<ContainerRemoval[]> {
    this.calls.push("dispose");
    if (this.scratchDir !== null) rmSync(this.scratchDir, { recursive: true, force: true });
    return this.script.dispose ?? [];
  }
}

interface Harness {
  root: string;
  deps: Partial<ServeDeps>;
  out: string[];
  backends: FakeBackend[];
  /** Every call a fake dependency saw, in order. */
  seen: string[];
  observed: Map<string, unknown>;
  /** The Vite groups the fake startVite spawned (real, detached `sleep`s). */
  vites: ChildProcess[];
  viteState: string;
  /** The backend's temp directory, where its scratch directories go. */
  tmpRoot: string;
  session: () => ServeSession | null;
  /** Resolves once serving has reached `untilStopped`. */
  ready: Promise<void>;
  /** Ends serving: `untilStopped` resolves. */
  stop: () => void;
}

interface HarnessOptions {
  root?: string;
  backend?: BackendScript;
  /** What the port check at the start finds held. */
  busy?: number[];
  /** Ports something takes after that check: every later check finds them held. */
  busyAfter?: number[];
  image?: () => { tag: string; ref: string; id: string };
  install?: () => Promise<void>;
  registry?: boolean;
  vite?: (dir: string, options: StartViteOptions) => Promise<ViteServer>;
  vitePort?: number;
  interrupted?: ServeDeps["interrupted"];
  /** Replaces dev-server.ts's check for a tracked group still alive; the default is the real one. */
  survivingGroups?: () => number[];
}

function harness(o: HarnessOptions = {}): Harness {
  const root = o.root ?? serveRoot();
  const out: string[] = [];
  const backends: FakeBackend[] = [];
  const seen: string[] = [];
  const observed = new Map<string, unknown>();
  const vites: ChildProcess[] = [];
  const viteState = stateDir();
  const tmpRoot = tempDir("agrav-serve-tmp-");
  let session: ServeSession | null = null;
  let markReady!: () => void;
  const ready = new Promise<void>((done) => (markReady = done));
  let release!: () => void;
  const stopped = new Promise<void>((done) => (release = done));
  const observe = (what: string, value: unknown): void => {
    observed.set(what, value);
  };
  let portChecks = 0;

  const fakeVite = async (dir: string, options: StartViteOptions): Promise<ViteServer> => {
    seen.push(`startVite ${dir}`);
    const proc = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    children.add(proc);
    proc.once("close", () => children.delete(proc));
    const pid = proc.pid as number;
    writeFileSync(join(viteState, "pids.log"), `${pid} ${pidStartTime(pid)}\n`, { flag: "a" });
    vites.push(proc);
    options.onSpawn?.(pid);
    observe("viteGroup right after the spawn", readServeState(root)?.viteGroup);
    const port = o.vitePort ?? 5173;
    return { proc, port, url: `http://localhost:${port}/` };
  };

  const deps: Partial<ServeDeps> = {
    sweep: () => {
      seen.push(`sweep (state file ${existsSync(statePath(root)) ? "present" : "absent"})`);
      return EMPTY_SWEEP;
    },
    busyPorts: async (ports) => {
      seen.push(`busyPorts ${ports.join(",")} (state file ${existsSync(statePath(root)) ? "present" : "absent"})`);
      portChecks += 1;
      if (portChecks === 1) return o.busy ?? [];
      return ports.filter((port) => (o.busyAfter ?? []).includes(port));
    },
    image: o.image ?? (() => ({ tag: TAG, ref: REF, id: IMAGE_ID })),
    tmpRoot: () => tmpRoot,
    createBackend: (options) => {
      seen.push("createBackend");
      const backend = new FakeBackend(options, o.backend ?? {}, observe);
      backends.push(backend);
      return backend;
    },
    ensureNodeModules: async (dir, timeoutMs) => {
      seen.push(`ensureNodeModules ${dir} ${timeoutMs}`);
      if (o.install !== undefined) await o.install();
    },
    probeRegistry: async () => {
      seen.push("probeRegistry");
      return o.registry ?? true;
    },
    startVite: o.vite ?? fakeVite,
    interrupted: o.interrupted ?? (() => null),
    ...(o.survivingGroups === undefined ? {} : { survivingGroups: o.survivingGroups }),
    onSession: (s) => {
      session = s;
    },
    untilStopped: () => {
      markReady();
      return stopped;
    },
    out: (line) => out.push(line),
  };
  return { root, deps, out, backends, seen, observed, vites, viteState, tmpRoot, session: () => session, ready, stop: () => release() };
}

/** Run `serveAttempt` until it serves, return the state it serves with, then stop it. */
async function serveThenStop(h: Harness): Promise<{ state: ServeState; outcome: ServeOutcome }> {
  const running = serveAttempt({ attempt: ATTEMPT, root: h.root, ignoreRunJson: true }, h.deps);
  const first = await Promise.race([h.ready.then(() => null), running]);
  if (first !== null) assert.fail(`serveAttempt ended before serving: ${JSON.stringify(first)}`);
  const state = readServeState(h.root);
  assert.ok(state !== null, "a serving run has a state file");
  h.stop();
  return { state, outcome: await running };
}

/**
 * `serveAttempt`'s outcome for a run that must not reach serving. One that
 * does is stopped and fails the test, rather than waiting forever for a stop.
 */
async function outcomeOf(h: Harness, options: Partial<ServeOptions> = {}): Promise<ServeOutcome> {
  const running = serveAttempt({ attempt: ATTEMPT, root: h.root, ignoreRunJson: true, ...options }, h.deps);
  const first = await Promise.race([h.ready.then(() => "serving" as const), running]);
  if (first !== "serving") return first;
  h.stop();
  await running;
  return assert.fail("it went on to serve");
}

function runJson(overrides: Partial<RunJson> = {}): RunJson {
  return {
    id: "demo",
    model: "demo-model",
    effort: "high",
    agyVersion: "1.1.26",
    image: REF,
    startedAt: "2026-09-18T09:00:00.000Z",
    durationMs: 600_000,
    exitCode: 0,
    envelope: null,
    stderrTail: "",
    softDenied: false,
    failureKind: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// serving, in process

test("serves: every part recorded as it comes up, then a teardown that leaves nothing", POSIX_ONLY, async () => {
  const h = harness();
  const { state, outcome } = await serveThenStop(h);

  const self = { pid: process.pid, pidStart: pidStartTime(process.pid) };
  assert.equal(state.pid, self.pid);
  assert.equal(state.pidStart, self.pidStart);
  assert.equal(state.attempt, ATTEMPT);
  assert.equal(state.status, "ready");
  assert.equal(state.image, REF);
  assert.equal(state.container, SERVE_NAME);
  assert.equal(state.viteGroup, h.vites[0].pid);
  assert.equal(state.viteStart, readFileSync(join(h.viteState, "pids.log"), "utf8").split(" ")[1].trim(), "the start time read right after the spawn");
  assert.equal(state.url, "http://localhost:5173/");
  assert.deepEqual(state.scratchDirs, [h.backends[0].scratchDir], "the scratch directory, recorded with the first container");
  assert.ok((state.scratchDirs[0] ?? "").startsWith(join(h.tmpRoot, scratchDirPrefix(process.pid))));
  assert.deepEqual(state.pipFreeze, FREEZE);
  assert.deepEqual(state.warnings, []);
  assert.equal(state.backend, "ok");
  assert.equal(state.frontend, "ok");

  // The order the spec requires: the sweep before the lock, the port check after it.
  assert.deepEqual(h.seen.slice(0, 3), ["sweep (state file absent)", "busyPorts 5100,5173 (state file present)", "createBackend"]);
  assert.equal(h.seen.filter((s) => s.startsWith("busyPorts")).length, 1, "both ports served by this run: neither is asked again");
  assert.equal(h.seen[3], `ensureNodeModules ${frontendDir(h.root)} 600000`);
  assert.equal(h.seen[4], `startVite ${frontendDir(h.root)}`);
  // Recorded before the thing exists: the container name before its `docker run`, the group right after its spawn.
  assert.equal(h.observed.get("container at install's docker run"), INSTALL_NAME);
  assert.equal(h.observed.get("viteGroup right after the spawn"), h.vites[0].pid);

  const backend = h.backends[0];
  assert.equal(backend.options.image, IMAGE_ID, "the backend runs by the bare image Id");
  assert.equal(backend.options.hostPort, 5100);
  assert.equal(backend.options.tmpRoot, h.tmpRoot, "scratch directories are made where they are looked for");
  assert.equal(backend.options.attemptName, ATTEMPT);
  assert.ok(h.out.some((line) => line === "ready: http://localhost:5173/ (backend ok; frontend ok) — stop it with SIGTERM or --stop"), h.out.join("\n"));

  assert.deepEqual(outcome, { kind: "stopped", state, problems: [] });
  assert.deepEqual(backend.calls, ["checkLayout", "install", "pipFreeze", "start", "stop", "dispose"]);
  assert.equal(existsSync(statePath(h.root)), false, "the state file is gone after the teardown");
  assert.equal(groupAlive(h.vites[0].pid as number), false, "the Vite group is gone after the teardown");
});

test("a second serve-attempt is refused while the first lives, and the first is left alone", POSIX_ONLY, async () => {
  const first = harness();
  const running = serveAttempt({ attempt: ATTEMPT, root: first.root, ignoreRunJson: true }, first.deps);
  await first.ready;
  const before = readFileSync(statePath(first.root), "utf8");

  const second = harness({ root: first.root });
  const outcome = await outcomeOf(second);
  assert.equal(outcome.kind, "refused");
  assert.match((outcome as { message: string }).message, new RegExp(`already serving ${ATTEMPT} \\(pid ${process.pid}, http://localhost:5173/\\)\\. Stop it first with .*--stop`));
  assert.deepEqual(second.seen, ["sweep (state file present)"], "the second ran its sweep and started nothing");
  assert.equal(readFileSync(statePath(first.root), "utf8"), before, "the first's state file is untouched");
  assert.equal(groupAlive(first.vites[0].pid as number), true, "the first's Vite group is untouched");

  first.stop();
  assert.equal((await running).kind, "stopped");
  assert.equal(existsSync(statePath(first.root)), false);
});

test("a dead owner's state file is refused with --stop named, and nothing it recorded is touched", POSIX_ONLY, async () => {
  const root = serveRoot();
  const groupState = stateDir();
  const group = await spawnGroup(groupState, "sleep 30 &\nrec $!\nwait", 2, frontendDir(root));
  const start = pidStartTime(process.pid) as string;
  const dead: ServeState = {
    pid: process.pid,
    pidStart: String(BigInt(start) + 1n), // this pid, but not this process: its owner is gone
    attempt: ATTEMPT,
    status: "ready",
    image: REF,
    container: SERVE_NAME,
    viteGroup: group.pid as number,
    viteStart: pidStartTime(group.pid as number),
    url: "http://localhost:5173/",
    scratchDirs: [],
    pipFreeze: FREEZE,
    warnings: [],
    backend: "ok",
    frontend: "ok",
  };
  mkdirSync(join(root, ".cache"), { recursive: true });
  writeFileSync(statePath(root), JSON.stringify(dead));
  const before = readFileSync(statePath(root), "utf8");

  const h = harness({ root });
  const outcome = await outcomeOf(h);
  assert.equal(outcome.kind, "refused");
  assert.match((outcome as { message: string }).message, /names pid \d+, serving demo-attempt-1, which is no longer running.*run `node --import tsx scripts\/serve-attempt\.ts --stop --root .*` to remove what it left/s);
  assert.equal(readFileSync(statePath(root), "utf8"), before);
  assert.equal(groupAlive(group.pid as number), true, "a recorded process group is never killed at start");
  assert.deepEqual(h.seen, ["sweep (state file present)"]);
});

test("an unreadable state file is refused and left alone", async () => {
  const root = serveRoot();
  mkdirSync(join(root, ".cache"), { recursive: true });
  writeFileSync(statePath(root), "{");
  const h = harness({ root });
  const outcome = await outcomeOf(h);
  assert.equal(outcome.kind, "refused");
  assert.match((outcome as { message: string }).message, /exists but cannot be read .*left alone/s);
  assert.equal(readFileSync(statePath(root), "utf8"), "{");
});

for (const [busy, words] of [
  [[5100], "port 5100 is already in use"],
  [[5100, 5173], "ports 5100 and 5173 are already in use"],
] as const) {
  test(`${words}: refused, nothing started, and no state file left`, async () => {
    const h = harness({ busy: [...busy] });
    const outcome = await outcomeOf(h);
    assert.equal(outcome.kind, "refused");
    assert.match((outcome as { message: string }).message, new RegExp(`${words}.*Nothing was started`, "s"));
    assert.deepEqual(h.seen, ["sweep (state file absent)", "busyPorts 5100,5173 (state file present)"]);
    assert.equal(existsSync(statePath(h.root)), false);
  });
}

for (const [label, script, status, stage] of [
  ["layout", { layout: { kind: "stop", stage: "layout", detail: "backend/ is missing" } }, "stop:layout: backend/ is missing", "layout"],
  ["install", { install: { kind: "stop", stage: "install", detail: "ERROR: No matching distribution for fastapi==99" } }, "stop:install: ERROR: No matching distribution for fastapi==99", "install"],
  ["boot", { start: { kind: "stop", stage: "boot", detail: "ImportError: no module named app\n(the container exited with code 1)" } }, "stop:boot: ImportError: no module named app\n(the container exited with code 1)", "boot"],
] as const) {
  test(`a backend stop (${label}) still serves the frontend, and records the stop`, POSIX_ONLY, async () => {
    const h = harness({ backend: script as BackendScript });
    const { state, outcome } = await serveThenStop(h);
    assert.equal(state.backend, status);
    assert.equal(state.container, null);
    assert.deepEqual(state.pipFreeze, stage === "boot" ? FREEZE : []);
    assert.equal(state.frontend, "ok");
    assert.equal(state.status, "ready");
    assert.ok(h.out.some((line) => line.startsWith(`backend stop (${stage}): `) && line.endsWith("serving the frontend without data")), h.out.join("\n"));
    assert.ok(h.out.some((line) => line.startsWith(`ready: http://localhost:5173/ (backend stop (${stage}); frontend ok)`)));
    assert.equal(h.seen.at(-1), "busyPorts 5100 (state file present)", "5100 is asked again once the dev server serves, and last");
    assert.equal(outcome.kind, "stopped");
    assert.ok(h.backends[0].calls.includes("dispose"));
    assert.equal(existsSync(statePath(h.root)), false);
  });
}

test("a backend harness fault ends the run: torn down, nothing left, no frontend started", async () => {
  const h = harness({ backend: { start: { kind: "infra", detail: "docker run -d exit 125: port is already allocated" } } });
  const outcome = await outcomeOf(h);
  assert.equal(outcome.kind, "infra");
  assert.match((outcome as { message: string }).message, /harness fault, not the model's.*port is already allocated/s);
  assert.deepEqual(h.backends[0].calls, ["checkLayout", "install", "pipFreeze", "start", "stop", "dispose"]);
  assert.ok(!h.seen.some((s) => s.startsWith("ensureNodeModules") || s.startsWith("startVite")));
  assert.equal(existsSync(statePath(h.root)), false);
});

test("a pip freeze that fails is a harness fault", async () => {
  const h = harness({ backend: { freeze: new Error("pip freeze exited 1") } });
  const outcome = await outcomeOf(h);
  assert.equal(outcome.kind, "infra");
  assert.match((outcome as { message: string }).message, /pip freeze exited 1/);
  assert.equal(existsSync(statePath(h.root)), false);
});

test("an image that cannot be resolved is a harness fault before any backend exists", async () => {
  const h = harness({
    image: () => {
      throw new Error("could not resolve image agrav-bench/harness:2026-09-18 to an image Id");
    },
  });
  const outcome = await outcomeOf(h);
  assert.equal(outcome.kind, "infra");
  assert.match((outcome as { message: string }).message, /could not resolve image/);
  assert.ok(!h.seen.includes("createBackend"));
  assert.equal(existsSync(statePath(h.root)), false);
});

test("npm install failing while the registry answers is a frontend stop, and serving goes on", async () => {
  const h = harness({
    install: async () => {
      throw new Error("npm install failed (exit 1): npm error code ETARGET");
    },
    registry: true,
  });
  const { state, outcome } = await serveThenStop(h);
  assert.equal(state.frontend, "stop: npm install failed, and the registry answered npm ping: npm install failed (exit 1): npm error code ETARGET");
  assert.equal(state.url, null);
  assert.equal(state.viteGroup, null);
  assert.equal(state.backend, "ok");
  assert.ok(h.seen.includes("probeRegistry"));
  assert.ok(!h.seen.some((s) => s.startsWith("startVite")));
  assert.ok(h.out.some((line) => line.startsWith("ready: no dev server (backend ok; frontend stop)")));
  assert.equal(outcome.kind, "stopped");
});

test("npm install failing while the registry does not answer is a harness fault: torn down", async () => {
  const h = harness({
    install: async () => {
      throw new Error("npm install did not finish within 600s");
    },
    registry: false,
  });
  const outcome = await outcomeOf(h);
  assert.equal(outcome.kind, "infra");
  assert.match((outcome as { message: string }).message, /npm install failed \(npm install did not finish within 600s\), and npm ping could not reach the registry either/);
  assert.ok(h.backends[0].calls.includes("dispose"), "the backend that was already serving is torn down");
  assert.ok(!h.seen.some((s) => s.startsWith("startVite")));
  assert.equal(existsSync(statePath(h.root)), false);
});

test("a dev server that never serves is a frontend stop, with its reason and output", async () => {
  const h = harness({
    vite: async (_dir, options) => {
      options.onSpawn?.(4_200_000);
      throw new DevServerError("npm run dev did not serve after 2 tries (try 1: exited (code 1) before it served; try 2: exited (code 1) before it served)", "[vite] error: boom");
    },
  });
  const { state } = await serveThenStop(h);
  assert.equal(state.frontend, "stop: npm run dev did not serve after 2 tries (try 1: exited (code 1) before it served; try 2: exited (code 1) before it served)\n[vite] error: boom");
  assert.equal(state.viteGroup, null, "a group that was killed is no longer recorded");
  assert.equal(state.url, null);
  assert.equal(h.seen.at(-1), "busyPorts 5173 (state file present)", "5173 is asked again: its holder could be why nothing served");
});

test("a dev server that never serves while something else holds 5173 is a harness fault, not a frontend stop", async () => {
  const h = harness({
    busyAfter: [5173],
    vite: async () => {
      throw new DevServerError("npm run dev did not serve after 2 tries (try 1: exited (code 1) before it served; try 2: exited (code 1) before it served)", "Error: Port 5173 is already in use");
    },
  });
  const outcome = await outcomeOf(h);
  assert.equal(outcome.kind, "infra");
  assert.match((outcome as { message: string }).message, /npm run dev did not serve, and port 5173 is held by something else.*free at serve-attempt's port check.*A harness fault/s);
  assert.match((outcome as { message: string }).message, /Port 5173 is already in use/, "the dev server's own account is quoted");
  assert.ok(h.backends[0].calls.includes("dispose"), "torn down");
  assert.equal(existsSync(statePath(h.root)), false, "no frontend stop was recorded for --stop or the judge to find");
});

test("a dev-server stop whose recorded group still lives keeps it recorded, for --stop", POSIX_ONLY, async () => {
  const groupState = stateDir();
  let pid = 0;
  const h = harness({
    vite: async (_dir, options) => {
      // A try that outlived its kill: still tracked, as startVite leaves one.
      const proc = await spawnGroup(groupState, "sleep 30 &\nrec $!\nwait", 2);
      trackProcess(proc);
      pid = proc.pid as number;
      options.onSpawn?.(pid);
      throw new DevServerError("npm run dev did not serve (try 1: printed no Local: URL within 60s)", "");
    },
  });
  const { state, outcome } = await serveThenStop(h);
  assert.equal(state.frontend, "stop: npm run dev did not serve (try 1: printed no Local: URL within 60s)");
  assert.equal(state.viteGroup, pid, "a group still alive was dropped from the record");
  assert.equal(outcome.kind, "stopped");
  assert.equal(groupAlive(pid), false, "the teardown stops every tracked group");
  assert.equal(existsSync(statePath(h.root)), false);
});

test("a dev server that cannot even be started is a harness fault", async () => {
  const h = harness({
    vite: async () => {
      throw new Error("npm run dev could not be started in /x: spawn npm ENOENT");
    },
  });
  const outcome = await outcomeOf(h);
  assert.equal(outcome.kind, "infra");
  assert.match((outcome as { message: string }).message, /spawn npm ENOENT/);
  assert.equal(existsSync(statePath(h.root)), false);
});

test("no frontend/package.json is a frontend stop, and nothing is installed", async () => {
  const h = harness({ root: serveRoot({ frontend: false }) });
  const { state } = await serveThenStop(h);
  assert.equal(state.frontend, "stop: frontend/package.json is missing");
  assert.ok(!h.seen.some((s) => s.startsWith("ensureNodeModules") || s.startsWith("startVite")));
});

test("a dev server on a port other than 5173 serves, with a warning recorded", POSIX_ONLY, async () => {
  const h = harness({ vitePort: 5174 });
  const { state } = await serveThenStop(h);
  assert.deepEqual(state.warnings, ["the dev server serves on port 5174, not the run contract's 5173"]);
  assert.equal(state.url, "http://localhost:5174/");
  assert.ok(h.out.includes("warning: the dev server serves on port 5174, not the run contract's 5173"));
  assert.ok(h.seen.includes("busyPorts 5173 (state file present)"), "5173 is asked again before the shift is the model's");
});

test("a dev server pushed off 5173 while something else holds it is a harness fault, not a warning", POSIX_ONLY, async () => {
  const h = harness({ vitePort: 5174, busyAfter: [5173] });
  const outcome = await outcomeOf(h);
  assert.equal(outcome.kind, "infra");
  assert.match((outcome as { message: string }).message, /port 5173 is held by something else, and the dev server serves on 5174.*free at serve-attempt's port check.*A harness fault/s);
  assert.equal(groupAlive(h.vites[0].pid as number), false, "the dev server is torn down");
  assert.ok(h.backends[0].calls.includes("dispose"));
  assert.equal(existsSync(statePath(h.root)), false);
});

test("after a backend stop, 5100 held by something else once the dev server serves is a harness fault", POSIX_ONLY, async () => {
  const h = harness({ backend: { start: { kind: "stop", stage: "boot", detail: "ImportError: no module named app" } }, busyAfter: [5100] });
  const outcome = await outcomeOf(h);
  assert.equal(outcome.kind, "infra");
  assert.match((outcome as { message: string }).message, /after the backend stop, port 5100 is held by something else.*another backend's data.*A harness fault/s);
  assert.ok(h.seen.indexOf("busyPorts 5100 (state file present)") > h.seen.indexOf(`startVite ${frontendDir(h.root)}`), "asked once the dev server serves");
  assert.equal(groupAlive(h.vites[0].pid as number), false);
  assert.equal(existsSync(statePath(h.root)), false);
});

test("ports this run serves itself are not asked again, whoever else wants them", POSIX_ONLY, async () => {
  const h = harness({ busyAfter: [5100, 5173] });
  const { state, outcome } = await serveThenStop(h);
  assert.equal(state.backend, "ok");
  assert.equal(state.frontend, "ok");
  assert.equal(outcome.kind, "stopped");
  assert.deepEqual(h.seen.filter((s) => s.startsWith("busyPorts")), ["busyPorts 5100,5173 (state file present)"]);
});

test("npm install killed by a signal the harness did not send is a harness fault, with no registry question", async () => {
  const h = harness({
    install: async () => {
      throw new InstallKilledError("SIGKILL");
    },
  });
  const outcome = await outcomeOf(h);
  assert.equal(outcome.kind, "infra");
  assert.match((outcome as { message: string }).message, /npm install was killed by SIGKILL, which the harness did not send.*A harness fault/s);
  assert.ok(!h.seen.includes("probeRegistry"), "whatever the registry says, it is not the model's");
  assert.ok(!h.seen.some((s) => s.startsWith("startVite")));
  assert.ok(h.backends[0].calls.includes("dispose"));
  assert.equal(existsSync(statePath(h.root)), false);
});

test("a dev server that exits after it was ready is a warning, never a stop", POSIX_ONLY, async () => {
  const h = harness({
    vite: async (_dir, options) => {
      const proc = spawn("/bin/sh", ["-c", "sleep 0.3"], { detached: true, stdio: "ignore" });
      children.add(proc);
      proc.once("close", () => children.delete(proc));
      options.onSpawn?.(proc.pid as number);
      return { proc, port: 5173, url: "http://localhost:5173/" };
    },
  });
  const running = serveAttempt({ attempt: ATTEMPT, root: h.root, ignoreRunJson: true }, h.deps);
  await h.ready;
  const deadline = Date.now() + 5000;
  while ((readServeState(h.root)?.warnings.length ?? 0) === 0 && Date.now() < deadline) await sleep(50);
  const state = readServeState(h.root);
  // criteria.md has no stop for it (operator decision S2): the judge asks the user.
  assert.equal(state?.frontend, "ok", "a frontend stop would zero five rows the rubric does not zero");
  assert.deepEqual(state?.warnings, ["the dev server exited after it was ready (code 0)"]);
  // SKILL.md greps serve.log for exactly this line.
  assert.ok(h.out.includes("warning: the dev server exited after it was ready (code 0)"), h.out.join("\n"));
  h.stop();
  assert.equal((await running).kind, "stopped");
});

test("a teardown that cannot prove a container gone keeps the state file, for --stop", async () => {
  const h = harness({ backend: { dispose: [{ removed: false, detail: "docker rm -f x timed out" }] } });
  const { outcome } = await serveThenStop(h);
  assert.equal(outcome.kind, "stopped");
  assert.deepEqual((outcome as { problems: string[] }).problems, ["docker rm -f x timed out"]);
  assert.equal(existsSync(statePath(h.root)), true, "the file is the record --stop needs");
  assert.ok(h.out.some((line) => line.includes("is kept, because not everything could be proven gone")));
  h.session()?.releaseStateSync();
  assert.equal(existsSync(statePath(h.root)), true, "an exit listener does not delete a kept file either");
});

test("both kept-state-file messages name --stop with the run's --root", async (t) => {
  const errors: string[] = [];
  t.mock.method(console, "error", (line: string) => {
    errors.push(line);
  });
  const h = harness({ backend: { dispose: [{ removed: false, detail: "docker rm -f x timed out" }] } });
  const running = serveAttempt({ attempt: ATTEMPT, root: h.root, ignoreRunJson: true }, h.deps);
  await h.ready;
  // What an `exit` listener says before the teardown has decided: the file is kept.
  (h.session() as ServeSession).releaseStateSync();
  h.stop();
  assert.equal((await running).kind, "stopped");

  const hint = `\`node --import tsx scripts/serve-attempt.ts --stop --root ${h.root}\``;
  assert.equal(errors.length, 1, errors.join("\n"));
  assert.ok(errors[0].includes(`is kept: the teardown did not finish`) && errors[0].includes(`Run ${hint} to finish it.`), errors[0]);
  const kept = h.out.find((line) => line.includes("is kept, because not everything could be proven gone"));
  assert.ok(kept?.includes(`Run ${hint} once the cause is fixed.`), kept ?? "no kept-file message");
  assert.equal(existsSync(statePath(h.root)), true);
});

test("stopCommand adds --root only for a root that is not this repository", () => {
  assert.equal(stopCommand(REPO_ROOT), "`node --import tsx scripts/serve-attempt.ts --stop`");
  assert.equal(stopCommand(`${REPO_ROOT}/`), "`node --import tsx scripts/serve-attempt.ts --stop`");
  assert.equal(stopCommand("/tmp/elsewhere"), "`node --import tsx scripts/serve-attempt.ts --stop --root /tmp/elsewhere`");
});

test("a tracked group still alive after the frontend's stop is a problem: the state file is kept, for --stop", async () => {
  let calls = 0;
  let viteAliveAtCheck: boolean | null = null;
  const h = harness({
    survivingGroups: () => {
      calls += 1;
      const vite = h.vites[0];
      viteAliveAtCheck = vite.exitCode === null && vite.signalCode === null;
      return [4_200_003];
    },
  });
  const { outcome } = await serveThenStop(h);
  assert.equal(calls, 1, "checked once, by the frontend's stop");
  assert.equal(viteAliveAtCheck, false, "checked only after the Vite group was killed and waited for");
  assert.equal(outcome.kind, "stopped");
  assert.deepEqual((outcome as { problems: string[] }).problems, [
    "the dev server's (or its install's) process group 4200003 is still alive after SIGKILL",
  ]);
  assert.equal(existsSync(statePath(h.root)), true, "a group not proven gone keeps the record --stop needs");
  assert.ok(h.out.some((line) => line.includes("is kept, because not everything could be proven gone")));
});

test("a signal during the install stops before the next step; the handler's teardown removes everything", async () => {
  let signal: "SIGTERM" | null = null;
  const h = harness({ backend: { onInstall: () => (signal = "SIGTERM") }, interrupted: () => signal });
  const outcome = await outcomeOf(h);
  assert.deepEqual(outcome, { kind: "interrupted", signal: "SIGTERM" });
  assert.deepEqual(h.backends[0].calls, ["checkLayout", "install"]);
  assert.ok(!h.seen.some((s) => s.startsWith("ensureNodeModules")));
  assert.equal(existsSync(statePath(h.root)), true, "until the handler's cleanups run");

  const session = h.session() as ServeSession;
  assert.deepEqual(await session.teardown(), []);
  assert.deepEqual(h.backends[0].calls, ["checkLayout", "install", "stop", "dispose"]);
  assert.equal(existsSync(statePath(h.root)), false);
});

test("a state file replaced by one naming another process is left in place by the teardown", POSIX_ONLY, async () => {
  const h = harness();
  const running = serveAttempt({ attempt: ATTEMPT, root: h.root, ignoreRunJson: true }, h.deps);
  await h.ready;
  const other = writeState(h.root, { pid: 4_200_002, pidStart: "7" });
  h.stop();
  assert.equal((await running).kind, "stopped");
  assert.deepEqual(readServeState(h.root), other, "the teardown deleted a state file that no longer named it");
  h.session()?.releaseStateSync();
  assert.deepEqual(readServeState(h.root), other, "and so did the exit listener");
});

/**
 * The real `startVite`, through the fake npm, with a dev server that ignores
 * SIGTERM and never serves: a signal must abort the try in flight (no retry
 * after it), and the handler's frontend cleanup must not return before that
 * try's group is gone — the SIGKILL escalation included.
 */
test("a signal while startVite waits aborts the try in flight: no other try, and no survivor", POSIX_ONLY, async () => {
  const npmState = stateDir();
  const saved = { PATH: process.env.PATH, FAKE_NPM_STATE: process.env.FAKE_NPM_STATE, FAKE_NPM_DEV: process.env.FAKE_NPM_DEV };
  process.env.PATH = `${FAKE_NPM_DIR}${delimiter}${saved.PATH ?? ""}`;
  process.env.FAKE_NPM_STATE = npmState;
  process.env.FAKE_NPM_DEV = "stubborn";
  try {
    assert.equal(spawnSync("npm", ["--fake-identity"], { encoding: "utf8", timeout: 10_000 }).stdout.trim(), "fake-npm");
    let signal: "SIGTERM" | null = null;
    const h = harness({ interrupted: () => signal, vite: (dir, options) => startVite(dir, { ...options, timeoutMs: 8000 }) });
    const running = outcomeOf(h);
    await until(() => existsSync(join(npmState, "stubborn")), 15_000, "the dev server to start ignoring SIGTERM");
    const starting = readServeState(h.root);
    assert.equal(starting?.status, "starting");
    assert.equal(typeof starting?.viteGroup, "number", "the group is recorded right after its spawn");

    // What the signal handler's first cleanup does.
    signal = "SIGTERM";
    await (h.session() as ServeSession).stopFrontend();
    assert.deepEqual(await survivorsAfter(npmState, 0), [], "stopFrontend returned while the aborted try's group was alive");
    assert.deepEqual(await running, { kind: "interrupted", signal: "SIGTERM" });
    assert.deepEqual(npmCalls(npmState), ["run dev"], "a try was started after the signal");
    assert.deepEqual(await (h.session() as ServeSession).teardown(), []);
    assert.equal(existsSync(statePath(h.root)), false);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("a second signal during the teardown: the exit cleanups SIGKILL a Vite group still in its grace, and keep the state file", POSIX_ONLY, async () => {
  const groupState = stateDir();
  const h = harness({
    vite: async (_dir, options) => {
      const proc = await spawnGroup(groupState, "trap '' TERM\nsleep 30 &\nrec $!\nwait", 2);
      options.onSpawn?.(proc.pid as number);
      return { proc, port: 5173, url: "http://localhost:5173/" };
    },
  });
  const running = serveAttempt({ attempt: ATTEMPT, root: h.root, ignoreRunJson: true }, h.deps);
  await h.ready;
  h.stop(); // the teardown starts: SIGTERM to a group that ignores it
  await sleep(300);

  // What the `exit` listener runs when a second signal cuts the teardown short.
  const t0 = Date.now();
  killAllProcessesSync();
  (h.session() as ServeSession).releaseStateSync();
  assert.equal(existsSync(statePath(h.root)), true, "a teardown cut short proves nothing gone: the file is --stop's");
  assert.deepEqual(await survivorsAfter(groupState, 1000), [], "the exit listener's SIGKILL skipped the group whose kill was in flight");
  assert.ok(Date.now() - t0 < 2000, "gone well before the teardown's own escalation");

  // In process the teardown goes on and, with everything now proven gone, deletes the file.
  const outcome = await running;
  assert.equal(outcome.kind, "stopped");
  assert.deepEqual((outcome as { problems: string[] }).problems, []);
  assert.equal(existsSync(statePath(h.root)), false);
});

const RUN_JSON_REFUSALS: Array<[string, Partial<RunJson> | null, RegExp]> = [
  ["no run.json", null, /no run\.json at .*--ignore-run-json/s],
  ["an infra failure", { failureKind: "infra" }, /records an infra failure/],
  ["a soft-deny", { softDenied: true }, /records a soft-deny/],
  ["a model failure", { failureKind: "model" }, /records failureKind "model".*all zero without serving it/s],
];
for (const [label, overrides, pattern] of RUN_JSON_REFUSALS) {
  test(`refuses an attempt with ${label} before anything runs; --ignore-run-json serves it`, POSIX_ONLY, async () => {
    const root = serveRoot();
    if (overrides !== null) writeRunJson(join(root, "eval-results", ATTEMPT, "run.json"), runJson(overrides));
    const h = harness({ root });
    const outcome = await outcomeOf(h, { ignoreRunJson: false });
    assert.equal(outcome.kind, "refused");
    assert.match((outcome as { message: string }).message, pattern);
    assert.deepEqual(h.seen, [], "not even the sweep runs");

    const served = harness({ root });
    assert.equal((await serveThenStop(served)).outcome.kind, "stopped");
  });
}

test("a clean run.json is served", POSIX_ONLY, async () => {
  const root = serveRoot();
  writeRunJson(join(root, "eval-results", ATTEMPT, "run.json"), runJson());
  const h = harness({ root });
  const running = serveAttempt({ attempt: ATTEMPT, root, ignoreRunJson: false }, h.deps);
  await h.ready;
  h.stop();
  assert.equal((await running).kind, "stopped");
});

test("refuses a name that is not an attempt directory, and a missing attempt directory", async () => {
  const h = harness();
  const bad = await outcomeOf(h, { attempt: "../etc" });
  assert.match((bad as { message: string }).message, /attempt directory name/);
  const missing = await outcomeOf(h, { attempt: "other-attempt-1" });
  assert.match((missing as { message: string }).message, /no attempt directory at/);
  assert.deepEqual(h.seen, []);
});

// ---------------------------------------------------------------------------
// the state file

test("parseServeState validates every field; readServeState reads none that is absent or unreadable", () => {
  const good: ServeState = {
    pid: 42,
    pidStart: "123",
    attempt: ATTEMPT,
    status: "starting",
    image: null,
    container: null,
    viteGroup: null,
    viteStart: null,
    url: null,
    scratchDirs: [],
    pipFreeze: [],
    warnings: [],
    backend: "pending",
    frontend: "pending",
  };
  assert.deepEqual(parseServeState(JSON.stringify(good)), good);
  const withScratch = { ...good, viteStart: "456", scratchDirs: ["/tmp/agrav-backend-42-Ab3xYz"] };
  assert.deepEqual(parseServeState(JSON.stringify(withScratch)), withScratch);
  for (const [key, value] of [
    ["pid", 0],
    ["pidStart", "12a"],
    ["attempt", "../x"],
    ["status", "done"],
    ["viteGroup", -1],
    // `--stop` turns it into a BigInt; anything but digits is refused here, not thrown there.
    ["viteStart", "12a"],
    ["scratchDirs", null],
    ["scratchDirs", ["agrav-backend-42-Ab3xYz"]],
    ["scratchDirs", ["/tmp/agrav-backend-43-Ab3xYz"]],
    ["scratchDirs", ["/tmp/x/../agrav-backend-42-Ab3xYz"]],
    ["scratchDirs", ["/tmp/agrav-backend-42-Ab3xYz/.."]],
    ["pipFreeze", [1]],
    ["backend", null],
  ] as const) {
    assert.throws(() => parseServeState(JSON.stringify({ ...good, [key]: value })), new RegExp(`${key} is missing or malformed`));
  }
  assert.throws(() => parseServeState("[]"), /not a JSON object/);
  assert.throws(() => parseServeState("{"), /not JSON/);

  const root = tempDir("agrav-serve-state-file-");
  assert.equal(readServeState(root), null);
  mkdirSync(join(root, ".cache"));
  writeFileSync(join(root, SERVE_STATE_FILE), "{");
  assert.equal(readServeState(root), null);
  writeFileSync(join(root, SERVE_STATE_FILE), JSON.stringify(good));
  assert.deepEqual(readServeState(root), good);
});

test("isServeOwnerLive: this process with its start time, and nothing else", POSIX_ONLY, () => {
  const start = pidStartTime(process.pid) as string;
  assert.equal(isServeOwnerLive({ pid: process.pid, pidStart: start }), true);
  assert.equal(isServeOwnerLive({ pid: process.pid, pidStart: String(BigInt(start) + 1n) }), false);
});

// ---------------------------------------------------------------------------
// --stop, in process

type DockerCall = string[];

function fakeDocker(respond: (args: string[]) => Partial<SpawnSyncReturns<string>>): { run: DockerRun; calls: DockerCall[] } {
  const calls: DockerCall[] = [];
  const run: DockerRun = (args) => {
    calls.push(args);
    return { pid: 1, output: [], stdout: "", stderr: "", status: 0, signal: null, ...respond(args) } as SpawnSyncReturns<string>;
  };
  return { run, calls };
}

/** A daemon that lists `names` for the owner and forgets each once it is `rm -f`ed. */
function daemonWith(names: string[]): { run: DockerRun; calls: DockerCall[] } {
  const live = new Set(names);
  return fakeDocker((args) => {
    if (args[0] === "ps") return { stdout: names.map((n) => `${n}\n`).join("") };
    if (args[0] === "rm") {
      live.delete(args[2]);
      return {};
    }
    if (args[0] === "inspect") {
      const name = args[args.length - 1];
      return live.has(name) ? { stdout: "true\n" } : { status: 1, stderr: `Error: No such object: ${name}\n` };
    }
    return { status: 1, stderr: `unexpected docker ${args.join(" ")}` };
  });
}

/** A docker that fails every call: for paths that must not reach one. */
const NO_DOCKER: DockerRun = fakeDocker(() => ({ status: 1, stderr: "this test calls no docker" })).run;

/** --stop's dependencies: a counted sweep, collected output, no docker unless given one. */
function stopDeps(over: Partial<StopDeps> = {}, record: { out?: string[]; sweeps?: { n: number } } = {}): Partial<StopDeps> {
  const out = record.out ?? [];
  const sweeps = record.sweeps ?? { n: 0 };
  return {
    sweep: () => {
      sweeps.n += 1;
      return EMPTY_SWEEP;
    },
    dockerRun: NO_DOCKER,
    out: (line) => out.push(line),
    ...over,
  };
}

function writeState(root: string, state: Partial<ServeState>): ServeState {
  const full: ServeState = {
    pid: 4_200_001,
    pidStart: "1",
    attempt: ATTEMPT,
    status: "ready",
    image: REF,
    container: null,
    viteGroup: null,
    viteStart: null,
    url: null,
    scratchDirs: [],
    pipFreeze: [],
    warnings: [],
    backend: "ok",
    frontend: "ok",
    ...state,
  };
  mkdirSync(join(root, ".cache"), { recursive: true });
  writeFileSync(statePath(root), JSON.stringify(full));
  return full;
}

test("--stop with no state file sweeps, says nothing is running, exits clean — every time", async () => {
  const root = tempDir("agrav-serve-stop-");
  const out: string[] = [];
  const sweeps = { n: 0 };
  assert.deepEqual(await stopServe(root, stopDeps({}, { out, sweeps })), { kind: "nothing" });
  assert.deepEqual(await stopServe(root, stopDeps({}, { out, sweeps })), { kind: "nothing" });
  assert.equal(sweeps.n, 2);
  assert.deepEqual(out, ["nothing is running", "nothing is running"]);
});

test("--stop for a dead owner removes its containers by label, kills its proven Vite group, deletes its state file", POSIX_ONLY, async () => {
  const root = serveRoot();
  const groupState = stateDir();
  const group = await spawnGroup(groupState, "sleep 30 &\nrec $!\nwait", 2, frontendDir(root));
  const names = [`agrav-backend-${ATTEMPT}-4200001-3`, `agrav-backend-${ATTEMPT}-4200001-5`];
  const docker = daemonWith(names);
  writeState(root, { container: names[1], viteGroup: group.pid as number, viteStart: pidStartTime(group.pid as number) });
  const out: string[] = [];
  const sweeps = { n: 0 };

  const outcome = await stopServe(root, stopDeps({ dockerRun: docker.run, ownerLive: () => false }, { out, sweeps }));
  assert.deepEqual(outcome, { kind: "cleaned", pid: 4_200_001 });
  assert.deepEqual(docker.calls[0], [
    "ps",
    "-a",
    "--filter",
    "label=agrav.role=backend",
    "--filter",
    `label=agrav.attempt=${ATTEMPT}`,
    "--filter",
    "label=agrav.owner=4200001",
    "--format",
    "{{.Names}}",
  ]);
  assert.deepEqual(
    docker.calls.filter((c) => c[0] === "rm").map((c) => c.join(" ")),
    names.map((n) => `rm -f ${n}`),
  );
  assert.equal(groupAlive(group.pid as number), false, "the recorded Vite group is killed");
  assert.deepEqual(await survivorsAfter(groupState, 1000), []);
  assert.equal(existsSync(statePath(root)), false);
  assert.equal(sweeps.n, 1, "and the sweep removes its scratch directories");
  assert.ok(out.includes(`killed the dev server's process group ${group.pid}`), out.join("\n"));

  assert.deepEqual(await stopServe(root, stopDeps({ dockerRun: docker.run, ownerLive: () => false })), { kind: "nothing" }, "idempotent");
});

test("--stop leaves a recorded group it cannot prove is the dev server's, and keeps the state file", POSIX_ONLY, async () => {
  const root = serveRoot();
  const groupState = stateDir();
  const group = await spawnGroup(groupState, "sleep 30 &\nrec $!\nwait", 2, frontendDir(root));
  const start = pidStartTime(group.pid as number) as string;
  writeState(root, { viteGroup: group.pid as number, viteStart: String(BigInt(start) + 1n) });

  const outcome = await stopServe(root, stopDeps({ dockerRun: daemonWith([]).run, ownerLive: () => false }));
  assert.equal(outcome.kind, "failed");
  assert.match((outcome as { message: string }).message, /the pid was reused; it was not signalled/);
  assert.equal(groupAlive(group.pid as number), true, "never signalled");
  assert.equal(existsSync(statePath(root)), true);
});

test("--stop kills a group whose leader is gone only when every member is provably the dev server's", POSIX_ONLY, async () => {
  const root = serveRoot();
  const groupState = stateDir();
  // The leader records itself and its child, then exits; the child keeps the group alive.
  const leader = await spawnGroup(groupState, "sleep 30 &\nrec $!\nexit 0", 2, frontendDir(root));
  const leaderStart = readFileSync(join(groupState, "pids.log"), "utf8").split("\n")[0].split(" ")[1];
  await new Promise((done) => (leader.exitCode === null ? leader.once("close", done) : done(null)));
  assert.equal(groupAlive(leader.pid as number), true);

  // Run somewhere else, the same members are not provably the dev server's.
  const elsewhere = serveRoot({ attempt: "other-attempt-1" });
  writeState(elsewhere, { attempt: "other-attempt-1", viteGroup: leader.pid as number, viteStart: leaderStart });
  const refused = await stopServe(elsewhere, stopDeps({ dockerRun: daemonWith([]).run, ownerLive: () => false }));
  assert.equal(refused.kind, "failed");
  assert.match((refused as { message: string }).message, /lives on without its leader, and member \d+ .* cannot be proven/);
  assert.equal(groupAlive(leader.pid as number), true);

  writeState(root, { viteGroup: leader.pid as number, viteStart: leaderStart });
  const outcome = await stopServe(root, stopDeps({ dockerRun: daemonWith([]).run, ownerLive: () => false }));
  assert.equal(outcome.kind, "cleaned");
  assert.equal(groupAlive(leader.pid as number), false);
  assert.deepEqual(await survivorsAfter(groupState, 1000), []);
});

test("--stop keeps the state file, and the scratch directory, when docker cannot list the dead owner's containers", async () => {
  const root = serveRoot();
  const scratchDir = mkdtempSync(join(tempDir("agrav-serve-tmp-"), scratchDirPrefix(4_200_001)));
  writeState(root, { scratchDirs: [scratchDir] });
  const docker = fakeDocker(() => ({ status: 1, stderr: "Cannot connect to the Docker daemon" }));
  const outcome = await stopServe(root, stopDeps({ dockerRun: docker.run, ownerLive: () => false }));
  assert.equal(outcome.kind, "failed");
  assert.match((outcome as { message: string }).message, /could not list pid 4200001's backend containers .*Cannot connect.*is kept/s);
  assert.equal(existsSync(statePath(root)), true);
  assert.equal(existsSync(scratchDir), true, "a container that may still run may still mount it");
});

test("--stop for a dead owner does not delete a state file that names another run by then", async () => {
  const root = serveRoot();
  writeState(root, {});
  let replacement: ServeState | null = null;
  const outcome = await stopServe(
    root,
    stopDeps({
      dockerRun: daemonWith([]).run,
      ownerLive: () => false,
      // A new serve-attempt takes the lock while this --stop is still at work.
      sweep: () => {
        replacement = writeState(root, { pid: 4_200_002, pidStart: "9", status: "starting" });
        return EMPTY_SWEEP;
      },
    }),
  );
  assert.deepEqual(outcome, { kind: "cleaned", pid: 4_200_001 });
  assert.ok(replacement !== null);
  assert.deepEqual(readServeState(root), replacement, "--stop deleted the new run's lock");
});

test("--stop removes a dead owner's recorded scratch directory though its pid is alive again, and no other", POSIX_ONLY, async () => {
  const root = serveRoot();
  const tmp = tempDir("agrav-serve-tmp-");
  // The owner is this pid with another start time: dead, its pid since reused
  // (by this test runner). The sweep keeps every directory of a live pid, so
  // only the recorded path can find the dead owner's.
  const recorded = mkdtempSync(join(tmp, scratchDirPrefix(process.pid)));
  mkdirSync(join(recorded, "venv", "bin"), { recursive: true });
  const notRecorded = mkdtempSync(join(tmp, scratchDirPrefix(process.pid)));
  writeState(root, { pid: process.pid, pidStart: String(BigInt(pidStartTime(process.pid) as string) + 1n), scratchDirs: [recorded] });

  const out: string[] = [];
  const outcome = await stopServe(root, stopDeps({ dockerRun: daemonWith([]).run }, { out }));
  assert.deepEqual(outcome, { kind: "cleaned", pid: process.pid });
  assert.equal(existsSync(recorded), false, "the dead owner's venv was left behind");
  assert.equal(existsSync(notRecorded), true, "a directory it did not record may be the new holder's");
  assert.ok(out.includes(`removed ${recorded}`), out.join("\n"));
  assert.equal(existsSync(statePath(root)), false);
});

test("--stop leaves a recorded scratch path that is no longer a directory, and keeps the state file", POSIX_ONLY, async () => {
  const root = serveRoot();
  const tmp = tempDir("agrav-serve-tmp-");
  const target = tempDir("agrav-serve-target-");
  const link = join(tmp, `${scratchDirPrefix(4_200_001)}AbCdEf`);
  symlinkSync(target, link);
  writeState(root, { scratchDirs: [link] });
  const outcome = await stopServe(root, stopDeps({ dockerRun: daemonWith([]).run, ownerLive: () => false }));
  assert.equal(outcome.kind, "failed");
  assert.match((outcome as { message: string }).message, /no longer a directory this user owns; it was left alone/);
  assert.equal(existsSync(target), true);
  assert.equal(existsSync(statePath(root)), true);
});

test("--stop leaves an unreadable state file alone", async () => {
  const root = tempDir("agrav-serve-stop-");
  mkdirSync(join(root, ".cache"));
  writeFileSync(statePath(root), "not json");
  const outcome = await stopServe(root, stopDeps());
  assert.equal(outcome.kind, "failed");
  assert.match((outcome as { message: string }).message, /cannot be read .*left alone/s);
  assert.equal(readFileSync(statePath(root), "utf8"), "not json");
});

test("--stop after a live owner exits leaving its state file cleans up from the file as the owner left it", POSIX_ONLY, async () => {
  const root = serveRoot();
  const groupState = stateDir();
  // The group the owner recorded after --stop had read its file: a Vite try
  // spawned while the SIGTERM was on its way, which the teardown then could
  // not prove gone.
  const group = await spawnGroup(groupState, "sleep 30 &\nrec $!\nwait", 2, frontendDir(root));
  const read = writeState(root, { status: "starting", viteGroup: null, viteStart: null });
  let live = true;
  const out: string[] = [];
  const outcome = await stopServe(
    root,
    stopDeps(
      {
        dockerRun: daemonWith([]).run,
        ownerLive: () => live,
        sendSignal: () => {
          writeState(root, { ...read, viteGroup: group.pid as number, viteStart: pidStartTime(group.pid as number) });
          live = false;
        },
      },
      { out },
    ),
  );
  assert.deepEqual(outcome, { kind: "cleaned", pid: read.pid });
  assert.ok(out.includes(`pid ${read.pid} exited but left ${statePath(root)}: removing what it recorded`), out.join("\n"));
  assert.equal(groupAlive(group.pid as number), false, "the group recorded after --stop's first read outlived --stop");
  assert.deepEqual(await survivorsAfter(groupState, 1000), []);
  assert.equal(existsSync(statePath(root)), false);
});

test("--stop gives a live owner time for its worst correct teardown", () => {
  // A Vite group and one more tracked group, each killed and waited for in
  // turn, and the one container, removed and proven gone (rm -f, inspect).
  assert.ok(STOP_WAIT_MS >= 2 * KILL_WAIT_MS + 2 * DOCKER_CLI_TIMEOUT_MS, `STOP_WAIT_MS ${STOP_WAIT_MS}`);
});

test("--stop against a live owner that outlasts the wait fails and says to run it again", POSIX_ONLY, async () => {
  const root = serveRoot();
  // A process of this test's own that ignores SIGTERM, standing in for a teardown stuck on docker.
  const stubborn = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log('up')"], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  children.add(stubborn);
  stubborn.once("close", () => children.delete(stubborn));
  await new Promise((done) => stubborn.stdout?.once("data", done));
  const pid = stubborn.pid as number;
  writeState(root, { pid, pidStart: pidStartTime(pid) as string });

  const outcome = await stopServe(root, stopDeps({ waitMs: 500 }));
  assert.equal(outcome.kind, "failed");
  assert.match((outcome as { message: string }).message, new RegExp(`pid ${pid} is still running 1 s after SIGTERM.*Run --stop again`, "s"));
  assert.equal(stubborn.exitCode, null, "it got SIGTERM and ignored it");
  assert.equal(existsSync(statePath(root)), true);
  // Unreaped, so the pid cannot have been reused: provably ours.
  stubborn.kill("SIGKILL");
});

// ---------------------------------------------------------------------------
// across processes: the fixture runs `runServe` for real; --stop stops it

interface Proc {
  child: ChildProcess;
  output: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function start(args: string[], env: NodeJS.ProcessEnv): Proc {
  const child = spawn(process.execPath, ["--import", "tsx", ...args], { cwd: ROOT, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let output = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("close", (code, signal) => {
      children.delete(child);
      resolve({ code, signal });
    }),
  );
  return { child, output: () => output, exited };
}

async function waitFor(proc: Proc, pattern: RegExp, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pattern.test(proc.output())) {
    if (proc.child.exitCode !== null || proc.child.signalCode !== null) assert.fail(`it exited before ${pattern}:\n${proc.output()}`);
    if (Date.now() >= deadline) assert.fail(`no ${pattern} within ${ms} ms:\n${proc.output()}`);
    await sleep(50);
  }
}

/** Fakes first on PATH, their state directories and TMPDIR fresh; no inherited knob or test-runner state. */
function liveEnv(dockerState: string, npmState: string, tmp: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("FAKE_") || key === "NODE_TEST_CONTEXT") delete env[key];
  return {
    ...env,
    PATH: `${FAKE_NPM_DIR}${delimiter}${FAKE_DOCKER_DIR}${delimiter}${process.env.PATH ?? ""}`,
    FAKE_DOCKER_STATE: dockerState,
    FAKE_NPM_STATE: npmState,
    FAKE_NPM_DEV: "plain",
    TMPDIR: tmp,
  };
}

function fakeContainers(dockerState: string): string[] {
  const dir = join(dockerState, "containers");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json"));
}

describe("across processes, through the fake docker and the fake npm", { timeout: 90_000 }, () => {
  test("before: `docker` and `npm` on the children's PATH are the fakes", () => {
    const env = liveEnv("/nonexistent", "/nonexistent", tmpdir());
    assert.equal(spawnSync("docker", ["--fake-identity"], { encoding: "utf8", env, timeout: 10_000 }).stdout.trim(), "fake-docker-backend");
    assert.equal(spawnSync("npm", ["--fake-identity"], { encoding: "utf8", env, timeout: 10_000 }).stdout.trim(), "fake-npm");
  });

  test("serves for real, refuses a second instance, and --stop tears it all down: exit 143, nothing left", POSIX_ONLY, async () => {
    const attempt = "synthetic-attempt-1";
    const root = serveRoot({ attempt });
    const dockerState = stateDir();
    const npmState = stateDir();
    const tmp = tempDir("agrav-serve-tmp-");
    const live = start([FIXTURE, root, attempt], liveEnv(dockerState, npmState, tmp));
    await waitFor(live, /^ready: /m, 60_000);

    const state = readServeState(root);
    assert.ok(state !== null, live.output());
    const pid = live.child.pid as number;
    assert.equal(state.pid, pid);
    assert.equal(state.status, "ready");
    assert.equal(state.image, `${readScoringImage(REPO_ROOT)}@${FAKE_IMAGE_ID}`);
    assert.equal(state.backend, "ok", live.output());
    assert.match(state.container ?? "", new RegExp(`^agrav-backend-${attempt}-${pid}-\\d+$`));
    assert.ok(state.pipFreeze.length > 0);
    const port = Number(readFileSync(join(npmState, "port"), "utf8"));
    assert.equal(state.url, `http://localhost:${port}/`);
    assert.equal(state.frontend, "ok");
    assert.deepEqual(state.warnings, [`the dev server serves on port ${port}, not the run contract's 5173`]);
    assert.equal(state.viteStart, pidStartTime(state.viteGroup as number));
    assert.equal(state.scratchDirs.length, 1, "the backend's scratch directory is recorded");
    assert.ok(state.scratchDirs[0].startsWith(join(tmp, `agrav-backend-${pid}-`)), state.scratchDirs[0]);
    assert.equal(fakeContainers(dockerState).length, 1, "one serving container");
    assert.equal((await fetch(state.url as string)).status, 200);

    // The lock holds across processes.
    const second = await serveAttempt(
      { attempt, root, ignoreRunJson: true },
      {
        sweep: () => EMPTY_SWEEP,
        busyPorts: async () => assert.fail("the lock should have refused before the port check"),
        createBackend: () => assert.fail("the lock should have refused before any backend"),
        out: () => {},
      },
    );
    assert.equal(second.kind, "refused");
    assert.match((second as { message: string }).message, new RegExp(`already serving ${attempt} \\(pid ${pid}`));

    const out: string[] = [];
    const outcome = await stopServe(root, { sweep: () => EMPTY_SWEEP, dockerRun: NO_DOCKER, out: (line) => out.push(line) });
    assert.deepEqual(outcome, { kind: "stopped", pid }, out.join("\n"));
    assert.deepEqual(await live.exited, { code: 143, signal: null });
    assert.equal(existsSync(statePath(root)), false, "it removed its own state file");
    assert.deepEqual(fakeContainers(dockerState), [], "no container is left");
    assert.deepEqual(await survivorsAfter(dockerState, 2000), [], "no fake backend process is alive");
    assert.deepEqual(await survivorsAfter(npmState, 2000), [], "no dev server process is alive");
    assert.deepEqual(readdirSync(tmp).filter((d) => d.startsWith("agrav-backend-")), [], "no scratch directory is left");

    assert.deepEqual(await stopServe(root, { sweep: () => EMPTY_SWEEP, dockerRun: NO_DOCKER, out: () => {} }), { kind: "nothing" }, "idempotent");
  });

  test("--stop while the dev server ignores SIGTERM and has not served yet: exit 143, and nothing survives", POSIX_ONLY, async () => {
    const attempt = "synthetic-attempt-1";
    const root = serveRoot({ attempt });
    const dockerState = stateDir();
    const npmState = stateDir();
    const tmp = tempDir("agrav-serve-tmp-");
    const live = start([FIXTURE, root, attempt], { ...liveEnv(dockerState, npmState, tmp), FAKE_NPM_DEV: "stubborn" });
    const deadline = Date.now() + 60_000;
    while (!existsSync(join(npmState, "stubborn"))) {
      if (live.child.exitCode !== null || live.child.signalCode !== null) assert.fail(`it exited before starting the dev server:\n${live.output()}`);
      if (Date.now() >= deadline) assert.fail(`no dev server within 60 s:\n${live.output()}`);
      await sleep(50);
    }
    const pid = live.child.pid as number;
    const state = readServeState(root);
    assert.equal(state?.status, "starting", live.output());
    assert.equal(state?.frontend, "pending");
    assert.equal(typeof state?.viteGroup, "number");

    const outcome = await stopServe(root, { sweep: () => EMPTY_SWEEP, dockerRun: NO_DOCKER, out: () => {} });
    assert.deepEqual(outcome, { kind: "stopped", pid }, live.output());
    assert.deepEqual(await live.exited, { code: 143, signal: null });
    assert.deepEqual(await survivorsAfter(npmState, 0), [], "the aborted dev server outlived serve-attempt");
    assert.deepEqual(npmCalls(npmState), ["run dev"], "no try after the signal");
    assert.equal(existsSync(statePath(root)), false);
    assert.deepEqual(fakeContainers(dockerState), []);
    assert.deepEqual(await survivorsAfter(dockerState, 2000), []);
    assert.deepEqual(readdirSync(tmp).filter((d) => d.startsWith("agrav-backend-")), []);
  });

  test("the CLI: usage is exit 2, a refusal exit 1 with no docker call, --stop with nothing running exit 0", async () => {
    const root = serveRoot();
    const dockerState = stateDir();
    const env = liveEnv(dockerState, stateDir(), tempDir("agrav-serve-tmp-"));

    const usage = start([CLI, "--attempt", "not a dir"], env);
    assert.equal((await usage.exited).code, 2, usage.output());
    assert.match(usage.output(), /Usage: node --import tsx scripts\/serve-attempt\.ts/);
    const mixed = start([CLI, "--stop", "--attempt", ATTEMPT], env);
    assert.equal((await mixed.exited).code, 2, mixed.output());
    assert.match(mixed.output(), /--stop takes only --root/);

    const refused = start([CLI, "--attempt", ATTEMPT, "--root", root], env);
    assert.equal((await refused.exited).code, 1, refused.output());
    assert.match(refused.output(), /no run\.json at .*--ignore-run-json/s);
    assert.ok(!existsSync(join(dockerState, "calls.log")), "a refusal calls no docker");
    assert.equal(existsSync(statePath(root)), false);

    // A start time that is not digits: refused as unreadable, not thrown from --stop's proof.
    writeState(root, { viteGroup: 4_200_005, viteStart: "not-a-number" });
    const malformed = start([CLI, "--stop", "--root", root], env);
    assert.equal((await malformed.exited).code, 1, malformed.output());
    assert.match(malformed.output(), /cannot be read \(viteStart is missing or malformed\)/);
    rmSync(statePath(root));

    for (let n = 0; n < 2; n++) {
      const stop = start([CLI, "--stop", "--root", root], env);
      assert.equal((await stop.exited).code, 0, stop.output());
      assert.match(stop.output(), /nothing is running/);
    }
  });
});

// ---------------------------------------------------------------------------

test("parseArgs: serve, stop and help, and the usage errors", () => {
  assert.deepEqual(parseArgs(["--attempt", ATTEMPT]), { mode: "serve", options: { attempt: ATTEMPT, root: REPO_ROOT, ignoreRunJson: false } });
  assert.deepEqual(parseArgs([`--attempt=${ATTEMPT}`, "--root", "/tmp/x", "--ignore-run-json"]), {
    mode: "serve",
    options: { attempt: ATTEMPT, root: "/tmp/x", ignoreRunJson: true },
  });
  assert.deepEqual(parseArgs(["--stop"]), { mode: "stop", root: REPO_ROOT });
  assert.ok(!REPO_ROOT.endsWith("/"), "REPO_ROOT is resolved: an explicit --root naming the repository compares equal");
  assert.deepEqual(parseArgs(["--stop", "--root", `${REPO_ROOT}/`]), { mode: "stop", root: REPO_ROOT });
  assert.deepEqual(parseArgs(["--stop", "--root=/tmp/y"]), { mode: "stop", root: "/tmp/y" });
  assert.deepEqual(parseArgs(["--help"]), { mode: "help" });
  for (const [argv, pattern] of [
    [[], /--attempt <dir> \(or --stop\) is required/],
    [["--attempt"], /--attempt needs a value/],
    [["--attempt", "eval-attempts/demo-attempt-1"], /not a path/],
    [["--attempt", ATTEMPT, "--attempt", ATTEMPT], /given twice/],
    [["--stop", "--ignore-run-json"], /--stop takes only --root/],
    [["--stop=yes"], /--stop takes no value/],
    [["--port", "5100"], /unknown argument/],
  ] as const) {
    assert.throws(() => parseArgs([...argv]), pattern, argv.join(" "));
  }
});

test("importing the module installs no process handler and runs nothing", async () => {
  const events = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "exit", "beforeExit", "uncaughtException"] as const;
  const before = events.map((e) => process.listenerCount(e));
  const fresh = await import(`${new URL("../scripts/serve-attempt", import.meta.url).href}?listener-probe=${process.hrtime.bigint()}`);
  assert.equal(typeof fresh.serveAttempt, "function");
  assert.deepEqual(events.map((e) => process.listenerCount(e)), before);
});
