/**
 * The server half of `scripts/take-screenshots.ts`: what one capture starts,
 * what it writes, and that it leaves nothing running on any path.
 *
 * In process first: `processAttempt` with a scripted backend, scripted frontend
 * steps and a fake browser, so every branch — a backend stop, a frontend stop,
 * an infra fault, a model failure, a signal — runs without docker, npm, a port
 * or Chromium. The dev server is a real detached `sleep`, so its teardown is a
 * real process-group kill, checked against `/proc`. Then `main` with the same
 * fakes: the pre-flight (dead-owner sweep, serve-attempt's state file, ports
 * 5100 and 5173) and what stops a run.
 *
 * Then across processes: `test/fixtures/take-screenshots-live.fixture.ts` runs
 * the real `main` — its handlers, sweep, image lookup, `AttemptBackend` and
 * `startVite` — through the stateful fake `docker` and the fake `npm`, once to
 * the end and once cut short by SIGTERM.
 *
 * No test binds or probes the real ports 5100 and 5173: `busyPorts` is always
 * injected, and the fakes serve on random ports. No test launches Chromium. No
 * test signals a process it cannot prove it started: a child is signalled only
 * while unreaped, and anything else only while `/proc` shows the start time it
 * was recorded with. The fake `docker` is first on PATH for the whole file, so a
 * dependency a test forgot to inject can never reach a real daemon.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import type { BackendOptions, ContainerRemoval, StartResult, StepResult } from "../scripts/lib/attempt-backend";
import { stopAllBackendsSync } from "../scripts/lib/attempt-backend";
import { parseAttemptDirName } from "../scripts/lib/attempts";
import {
  DevServerError,
  InstallKilledError,
  isSameProcess,
  killAllProcessesSync,
  pidStartTime,
  type StartViteOptions,
  type ViteServer,
} from "../scripts/lib/dev-server";
import type { SweepResult } from "../scripts/lib/docker";
import type { InterruptHooks, InterruptSignal } from "../scripts/lib/interrupt";
import { writeRunJson, type RunJson } from "../scripts/lib/run-json";
import { readScoringImage } from "../scripts/lib/runner-config";
import type { ServeState } from "../scripts/serve-attempt";
import {
  CaptureInterrupted,
  CHROMIUM_LAUNCH_OPTIONS,
  DEFAULT_MAIN_DEPS,
  InfraError,
  launchChromium,
  lazyImage,
  main,
  processAttempt,
  removePartialInstalls,
  stopViteGroup,
  warnPartialInstallsSync,
  type AttemptInfo,
  type BrowserLike,
  type CaptureBackend,
  type CaptureDeps,
  type MainDeps,
  type PageLike,
} from "../scripts/take-screenshots";
import { useFakeDockerBackend } from "./fixtures/fake-docker-backend-hooks";
import { killSurvivors, survivors } from "./fixtures/fake-docker-backend-pids";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/take-screenshots-live.fixture.ts", import.meta.url));
const FAKE_DOCKER_DIR = fileURLToPath(new URL("./fixtures/fake-docker-backend/", import.meta.url));
const FAKE_NPM_DIR = fileURLToPath(new URL("./fixtures/dev-server/", import.meta.url));
const POSIX_ONLY = { skip: process.platform !== "linux" ? "Linux /proc and process groups only" : false };

const ATTEMPT = "gemini-38-flash-high-attempt-1";
const TAG = "agrav-bench/harness:2026-09-18";
const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const REF = `${TAG}@${IMAGE_ID}`;
/** What the fake docker's `image inspect` answers. */
const FAKE_IMAGE_ID = `sha256:${"f".repeat(64)}`;
const OK: StepResult = { kind: "ok" };
const REMOVED: ContainerRemoval = { removed: true, detail: "removed" };
const EMPTY_SWEEP: SweepResult = { removedContainers: [], removedDirs: [], failed: [] };

// The fake docker first on PATH for the whole file; after it, one that refuses everything.
const hooks = useFakeDockerBackend();

const scratch: string[] = [];
/** State directories whose `pids.log` names every process a fake started. */
const stateDirs: string[] = [];
/** Children this file spawned, until reaped: their groups are provably ours while they are unreaped. */
const children = new Set<ChildProcess>();

after(() => {
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
  const dir = tempDir("agrav-shots-state-");
  stateDirs.push(dir);
  return dir;
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** `promise`, or a failure naming `what` after `ms`: a regression fails the test instead of hanging the suite. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// attempts on disk

interface AttemptLayout {
  name?: string;
  /** A `frontend/package.json` (default true). */
  frontend?: boolean;
  /** `run.json` records `failureKind: "model"`. */
  modelFailure?: boolean;
}

/** An attempt directory with a backend layout and, unless told otherwise, a frontend; and its `AttemptInfo`. */
function makeAttempt(root: string, layout: AttemptLayout = {}): AttemptInfo {
  const dirName = layout.name ?? ATTEMPT;
  const attemptDir = join(root, "eval-attempts", dirName);
  mkdirSync(join(attemptDir, "backend", "app"), { recursive: true });
  writeFileSync(join(attemptDir, "backend", "requirements.txt"), "fastapi==0.115.14\nuvicorn==0.30.6\n");
  writeFileSync(join(attemptDir, "backend", "app", "main.py"), "from fastapi import FastAPI\napp = FastAPI()\n");
  const frontend = layout.frontend ?? true;
  if (frontend) {
    mkdirSync(join(attemptDir, "frontend"), { recursive: true });
    writeFileSync(join(attemptDir, "frontend", "package.json"), '{"scripts":{"dev":"vite"}}\n');
  }
  if (layout.modelFailure === true) {
    writeRunJson(join(root, "eval-results", dirName, "run.json"), runJson({ failureKind: "model", exitCode: 1 }));
  }
  const parsed = parseAttemptDirName(dirName);
  assert.ok(parsed !== null);
  return {
    dirName,
    benchmarkId: parsed.modelId,
    attempt: parsed.attempt,
    attemptDir,
    frontendRoot: frontend ? join(attemptDir, "frontend") : null,
    modelFailure: layout.modelFailure ?? false,
  };
}

function runJson(overrides: Partial<RunJson> = {}): RunJson {
  return {
    id: "gemini-38-flash-high",
    model: "gemini-3.8-flash-high",
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

function screenshotsDirOf(root: string): string {
  return join(root, "website", "public", "screenshots");
}

function pngs(root: string): string[] {
  const dir = screenshotsDirOf(root);
  return existsSync(dir) ? readdirSync(dir).filter((file) => file.endsWith(".png")).sort() : [];
}

// ---------------------------------------------------------------------------
// in-process fakes

interface BrowserScript {
  /** What `goto` does after recording itself; default: resolves. */
  goto?: (url: string) => Promise<unknown>;
  /** Called by `newPage` before it opens one; throw to fail it. */
  newPage?: () => void;
}

class FakePage implements PageLike {
  html: string | null = null;
  closed = false;
  constructor(private readonly browser: FakeBrowser) {}
  async goto(url: string, options: { waitUntil: "load"; timeout: number }): Promise<unknown> {
    this.browser.events.push(`goto ${url} ${options.waitUntil} ${options.timeout}`);
    return this.browser.script.goto?.(url);
  }
  async setContent(html: string): Promise<void> {
    this.html = html;
    this.browser.events.push("setContent");
  }
  async screenshot(options: { path: string }): Promise<unknown> {
    if (this.browser.closed) throw new Error("fake browser: screenshot after close");
    this.browser.events.push(`screenshot ${basename(options.path)}`);
    writeFileSync(options.path, this.html === null ? "picture" : `card ${this.html}`);
    return null;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.browser.events.push("page closed");
  }
}

class FakeBrowser implements BrowserLike {
  readonly pages: FakePage[] = [];
  closed = false;
  /** Called once when the browser closes — what ends a page load that never finishes. */
  readonly closeListeners = new Set<() => void>();
  constructor(
    readonly events: string[],
    readonly script: BrowserScript = {},
  ) {}
  async newPage(): Promise<PageLike> {
    if (this.closed) throw new Error("fake browser: newPage after close");
    this.script.newPage?.();
    const page = new FakePage(this);
    this.pages.push(page);
    return page;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.events.push("browser closed");
    for (const listener of this.closeListeners) listener();
    this.closeListeners.clear();
  }
  /** A page load that never finishes until the browser closes, as Playwright's `goto` then fails. */
  hangUntilClosed(): Promise<never> {
    return new Promise<never>((_resolve, reject) => {
      this.closeListeners.add(() => reject(new Error("page.goto: Target page, context or browser has been closed")));
    });
  }
  /** The pages a card was rendered on. */
  cards(): FakePage[] {
    return this.pages.filter((page) => page.html !== null);
  }
}

type BackendCall = "checkLayout" | "install" | "start" | "stop" | "dispose";

interface BackendScript {
  layout?: StepResult;
  install?: StepResult;
  start?: StartResult;
  stop?: ContainerRemoval;
  dispose?: ContainerRemoval[];
  /** Run when the call is made, before it answers — a signal landing mid-step, say. */
  during?: Partial<Record<BackendCall, () => void>>;
  /** Thrown instead of an answer: a backend step that fails by throwing. */
  throws?: Partial<Record<BackendCall, Error>>;
}

class FakeBackend implements CaptureBackend {
  readonly calls: string[] = [];
  constructor(
    readonly options: BackendOptions,
    private readonly script: BackendScript,
    private readonly events: string[],
  ) {}
  private record(call: BackendCall): void {
    this.calls.push(call);
    this.events.push(`backend ${call}`);
    this.script.during?.[call]?.();
    const error = this.script.throws?.[call];
    if (error !== undefined) throw error;
  }
  checkLayout(): StepResult {
    this.record("checkLayout");
    return this.script.layout ?? OK;
  }
  async install(): Promise<StepResult> {
    this.record("install");
    return this.script.install ?? OK;
  }
  async start(): Promise<StartResult> {
    this.record("start");
    return this.script.start ?? { kind: "ready", baseUrl: "http://127.0.0.1:5100", container: "agrav-backend-x-1-2" };
  }
  async stop(): Promise<ContainerRemoval> {
    this.record("stop");
    return this.script.stop ?? REMOVED;
  }
  async dispose(): Promise<ContainerRemoval[]> {
    this.record("dispose");
    return this.script.dispose ?? [];
  }
}

interface FakeVite {
  proc: ChildProcess;
  pid: number;
  start: string | null;
}

interface HarnessOptions {
  backend?: BackendScript;
  browser?: BrowserScript;
  /** What the frontend's install does; default: nothing, successfully. */
  install?: () => Promise<void>;
  registry?: boolean;
  /** Replaces the fake `npm ping` entirely. */
  probe?: () => Promise<boolean>;
  /** Replaces the fake dev server. */
  vite?: (dir: string, options: StartViteOptions) => Promise<ViteServer>;
  vitePort?: number;
  interrupted?: () => InterruptSignal | null;
  image?: () => { ref: string; id: string };
  /** Ports something takes after the attempt's own port check: the capture's checks find them held. */
  busyAfter?: number[];
}

interface Harness {
  root: string;
  events: string[];
  warnings: string[];
  browser: FakeBrowser;
  backends: FakeBackend[];
  vites: FakeVite[];
  deps: Partial<CaptureDeps> & Pick<CaptureDeps, "screenshotsDir">;
}

function harness(o: HarnessOptions = {}): Harness {
  const root = tempDir("agrav-shots-proc-");
  mkdirSync(screenshotsDirOf(root), { recursive: true });
  const events: string[] = [];
  const warnings: string[] = [];
  const backends: FakeBackend[] = [];
  const vites: FakeVite[] = [];
  const browser = new FakeBrowser(events, o.browser);

  // A real detached group, so the teardown's kill is real and can be checked.
  const fakeVite = async (dir: string): Promise<ViteServer> => {
    events.push(`startVite ${dir}`);
    const proc = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    children.add(proc);
    proc.once("close", () => children.delete(proc));
    const pid = proc.pid as number;
    vites.push({ proc, pid, start: pidStartTime(pid) });
    const port = o.vitePort ?? 5173;
    return { proc, port, url: `http://localhost:${port}/` };
  };

  const deps: Harness["deps"] = {
    screenshotsDir: screenshotsDirOf(root),
    installTimeoutMs: 600_000,
    image:
      o.image ??
      (() => {
        events.push("image");
        return { ref: REF, id: IMAGE_ID };
      }),
    createBackend: (options) => {
      events.push("createBackend");
      const backend = new FakeBackend(options, o.backend ?? {}, events);
      backends.push(backend);
      return backend;
    },
    ensureNodeModules: async (dir, timeoutMs) => {
      events.push(`ensureNodeModules ${dir} ${timeoutMs}`);
      if (o.install !== undefined) await o.install();
    },
    probeRegistry: async () => {
      events.push("probeRegistry");
      if (o.probe !== undefined) return o.probe();
      return o.registry ?? true;
    },
    startVite: o.vite ?? fakeVite,
    busyPorts: async (ports) => {
      events.push(`busyPorts ${ports.join(",")}`);
      return ports.filter((port) => (o.busyAfter ?? []).includes(port));
    },
    sleep: async (ms) => {
      events.push(`sleep ${ms}`);
    },
    interrupted: o.interrupted ?? (() => null),
    log: () => {},
    warn: (line) => warnings.push(line),
  };
  return { root, events, warnings, browser, backends, vites, deps };
}

/** Whether every fake dev server is gone: its leader no longer the process it was (reaped, or a zombie). */
function vitesGone(h: Harness): boolean {
  return h.vites.every((vite) => !isSameProcess(vite.pid, vite.start));
}

/** The torn-down backend: `stop` and `dispose` after whatever ran. */
function assertBackendTornDown(h: Harness, before: string[]): void {
  assert.equal(h.backends.length, 1);
  assert.deepEqual(h.backends[0].calls, [...before, "stop", "dispose"]);
}

function indexOf(events: string[], event: string): number {
  const index = events.indexOf(event);
  assert.notEqual(index, -1, `no ${JSON.stringify(event)} in ${JSON.stringify(events)}`);
  return index;
}

// ---------------------------------------------------------------------------
// processAttempt

test("a capture: backend, install, dev server, / at load plus the 2 s settle — then all of it torn down", POSIX_ONLY, async () => {
  const h = harness();
  const attempt = makeAttempt(h.root);
  const result = await processAttempt(attempt, h.browser, h.deps);

  assert.deepEqual(result, { kind: "pictured", warnings: [] });
  assert.deepEqual(pngs(h.root), [`${ATTEMPT}.png`]);
  assert.equal(readFileSync(join(screenshotsDirOf(h.root), `${ATTEMPT}.png`), "utf8"), "picture");

  // The order spec §5 fixes: backend, npm install, dev server.
  assert.deepEqual(h.events.slice(0, 7), [
    "image",
    "createBackend",
    "backend checkLayout",
    "backend install",
    "backend start",
    `ensureNodeModules ${attempt.frontendRoot} 600000`,
    `startVite ${attempt.frontendRoot}`,
  ]);
  // Ruling R19: `load`, 30 s, then the settle, then the picture.
  assert.deepEqual(h.events.slice(7, 11), [
    "goto http://localhost:5173/ load 30000",
    "sleep 2000",
    `screenshot ${ATTEMPT}.png`,
    "page closed",
  ]);

  const backend = h.backends[0];
  assert.equal(backend.options.image, IMAGE_ID, "the backend runs by the bare image Id");
  assert.equal(backend.options.hostPort, 5100);
  assert.equal(backend.options.attemptDir, attempt.attemptDir);
  assert.equal(backend.options.attemptName, ATTEMPT);
  assertBackendTornDown(h, ["checkLayout", "install", "start"]);
  assert.ok(vitesGone(h), "the dev server's group outlived the capture");
  assert.equal(h.browser.cards().length, 0);
  assert.equal(h.browser.closed, false, "the browser is main's to close");
  assert.ok(!h.events.some((event) => event.startsWith("busyPorts")), "both ports are this capture's own: neither is asked again");
});

test("a page that does not load: an error card, written only after the page, the dev server and the backend are gone", POSIX_ONLY, async () => {
  const h = harness({ browser: { goto: async () => Promise.reject(new Error("page.goto: Timeout 30000ms exceeded.")) } });
  const result = await processAttempt(makeAttempt(h.root), h.browser, h.deps);

  assert.equal(result.kind, "card");
  assert.match((result as { error: string }).error, /Timeout 30000ms exceeded/);
  assert.equal(h.browser.pages[0].closed, true, "the page that failed is closed");
  assert.ok(vitesGone(h));
  assertBackendTornDown(h, ["checkLayout", "install", "start"]);
  const cards = h.browser.cards();
  assert.equal(cards.length, 1);
  assert.match(cards[0].html ?? "", /Rendering Issue/);
  assert.ok(indexOf(h.events, "backend dispose") < indexOf(h.events, "setContent"), "the card must come after the teardown, never before it");
  assert.deepEqual(pngs(h.root), [`${ATTEMPT}.png`]);
  assert.ok(!h.events.some((event) => event.startsWith("sleep")), "no settle after a failed load");
});

test("npm run dev that never serves: a frontend-stop card, and the backend torn down", POSIX_ONLY, async () => {
  const h = harness({
    vite: async (dir) => {
      h.events.push(`startVite ${dir}`);
      throw new DevServerError("npm run dev did not serve after 2 tries (try 1: exited (code 1) before it served; try 2: …)", "[vite] error: Cannot find module 'vite'");
    },
  });
  const result = await processAttempt(makeAttempt(h.root), h.browser, h.deps);

  assert.equal(result.kind, "card");
  const error = (result as { error: string }).error;
  assert.match(error, /^frontend stop: npm run dev did not serve after 2 tries/);
  assert.match(error, /Cannot find module 'vite'/, "the dev server's last output is on the card");
  assertBackendTornDown(h, ["checkLayout", "install", "start"]);
  assert.equal(h.browser.cards().length, 1);
  assert.equal(h.browser.pages.length, 1, "no page was opened for the app");
  assert.ok(h.events.includes("busyPorts 5173"), "5173 is asked again: its holder could be why nothing served");
});

test("npm run dev that never serves while something else holds 5173: infra — no card, and the backend torn down", POSIX_ONLY, async () => {
  const h = harness({
    busyAfter: [5173],
    vite: async (dir) => {
      h.events.push(`startVite ${dir}`);
      throw new DevServerError("npm run dev did not serve after 2 tries (try 1: exited (code 1) before it served; try 2: …)", "Error: Port 5173 is already in use");
    },
  });
  await assert.rejects(processAttempt(makeAttempt(h.root), h.browser, h.deps), (error: unknown) => {
    assert.ok(error instanceof InfraError, String(error));
    assert.match(error.message, /npm run dev did not serve, and port 5173 is held by something else.*Port 5173 is already in use/s);
    return true;
  });
  assertBackendTornDown(h, ["checkLayout", "install", "start"]);
  assert.equal(h.browser.pages.length, 0, "no card: the collision is not the model's");
  assert.deepEqual(pngs(h.root), []);
});

test("npm install that times out while the registry answers: a frontend-stop card; no dev server; the backend torn down", POSIX_ONLY, async () => {
  const h = harness({
    install: async () => {
      throw new Error("npm install did not finish within 600s.");
    },
    registry: true,
  });
  const result = await processAttempt(makeAttempt(h.root), h.browser, h.deps);

  assert.equal(result.kind, "card");
  assert.match((result as { error: string }).error, /^frontend stop: npm install failed, and the registry answered npm ping: npm install did not finish within 600s\./);
  assert.ok(indexOf(h.events, "probeRegistry") > indexOf(h.events, `ensureNodeModules ${join(h.root, "eval-attempts", ATTEMPT, "frontend")} 600000`));
  assert.ok(!h.events.some((event) => event.startsWith("startVite")), "no dev server after a failed install");
  assertBackendTornDown(h, ["checkLayout", "install", "start"]);
  assert.equal(h.browser.cards().length, 1);
});

test("npm install that fails while the registry does not answer: infra — no card, and the backend torn down", POSIX_ONLY, async () => {
  const h = harness({
    install: async () => {
      throw new Error("npm install failed (exit 1): npm error code ENOTFOUND");
    },
    registry: false,
  });
  await assert.rejects(processAttempt(makeAttempt(h.root), h.browser, h.deps), (error: unknown) => {
    assert.ok(error instanceof InfraError, String(error));
    assert.match(error.message, /npm install failed .*ENOTFOUND.*npm ping could not reach the registry either/s);
    return true;
  });
  assertBackendTornDown(h, ["checkLayout", "install", "start"]);
  assert.deepEqual(pngs(h.root), [], "no card: a harness fault must not become a sticky tile");
  assert.equal(h.browser.pages.length, 0);
});

test('a failureKind "model" attempt gets its model-failure card and starts nothing', async () => {
  const h = harness();
  const result = await processAttempt(makeAttempt(h.root, { modelFailure: true }), h.browser, h.deps);

  assert.deepEqual(result, { kind: "model-failure" });
  assert.deepEqual(h.events, ["setContent", `screenshot ${ATTEMPT}.png`, "page closed"], "no image, backend, install or dev server");
  assert.match(h.browser.cards()[0].html ?? "", /Model Failure/);
  assert.match(h.browser.cards()[0].html ?? "", /failureKind "model"/);
  assert.deepEqual(pngs(h.root), [`${ATTEMPT}.png`]);
});

test("no frontend/package.json: a frontend-stop card, and no backend is started nor the image resolved", async () => {
  const h = harness();
  const result = await processAttempt(makeAttempt(h.root, { frontend: false }), h.browser, h.deps);

  assert.equal(result.kind, "card");
  assert.match((result as { error: string }).error, /^frontend stop: frontend\/package\.json is missing/);
  assert.deepEqual(h.backends, []);
  assert.ok(!h.events.includes("image"), "the image is resolved only for a backend about to start");
  assert.equal(h.browser.cards().length, 1);
});

test("a backend stop: the frontend is photographed without data, with a warning", POSIX_ONLY, async () => {
  const h = harness({ backend: { start: { kind: "stop", stage: "health", detail: "no 2xx from GET /api/v1/health within 60s; last answer: HTTP 404" } } });
  const result = await processAttempt(makeAttempt(h.root), h.browser, h.deps);
  assert.equal(indexOf(h.events, "busyPorts 5100") + 1, indexOf(h.events, "goto http://localhost:5173/ load 30000"), "5100 is asked again right before the page loads");

  assert.equal(result.kind, "pictured");
  assert.deepEqual((result as { warnings: string[] }).warnings, [
    "backend stop (health): no 2xx from GET /api/v1/health within 60s; last answer: HTTP 404 — photographing the frontend without data",
  ]);
  assert.ok(h.events.some((event) => event.startsWith("startVite")), "the frontend still runs");
  assert.deepEqual(pngs(h.root), [`${ATTEMPT}.png`]);
  assert.equal(h.browser.cards().length, 0, "a backend stop is not a card");
  assertBackendTornDown(h, ["checkLayout", "install", "start"]);
  assert.ok(vitesGone(h));
});

test("a backend stop, with something else on 5100 when the page is about to load: infra — no picture, and all of it torn down", POSIX_ONLY, async () => {
  const h = harness({
    backend: { start: { kind: "stop", stage: "boot", detail: "ImportError: no module named app" } },
    busyAfter: [5100],
  });
  await assert.rejects(processAttempt(makeAttempt(h.root), h.browser, h.deps), (error: unknown) => {
    assert.ok(error instanceof InfraError, String(error));
    assert.match(error.message, /after the backend stop, port 5100 is held by something else.*another backend's data/s);
    return true;
  });
  assert.ok(!h.events.some((event) => event.startsWith("goto")), "the page never loaded another backend's data");
  assert.ok(h.browser.pages.every((page) => page.closed));
  assert.ok(vitesGone(h));
  assertBackendTornDown(h, ["checkLayout", "install", "start"]);
  assert.deepEqual(pngs(h.root), []);
});

test("ports the capture serves itself are not asked again, whoever else wants them", POSIX_ONLY, async () => {
  const h = harness({ busyAfter: [5100, 5173] });
  assert.deepEqual(await processAttempt(makeAttempt(h.root), h.browser, h.deps), { kind: "pictured", warnings: [] });
  assert.ok(!h.events.some((event) => event.startsWith("busyPorts")));
});

test("a layout stop skips the install and still photographs the frontend", POSIX_ONLY, async () => {
  const h = harness({ backend: { layout: { kind: "stop", stage: "layout", detail: "missing: backend/app/main.py" } } });
  const result = await processAttempt(makeAttempt(h.root), h.browser, h.deps);
  assert.equal(result.kind, "pictured");
  assert.match((result as { warnings: string[] }).warnings[0], /^backend stop \(layout\): missing: backend\/app\/main\.py/);
  assertBackendTornDown(h, ["checkLayout"]);
});

test("a backend harness fault: infra — nothing else started, no card, the backend torn down", async () => {
  const h = harness({ backend: { install: { kind: "infra", detail: "python3 -m venv exited 1" } } });
  await assert.rejects(processAttempt(makeAttempt(h.root), h.browser, h.deps), (error: unknown) => {
    assert.ok(error instanceof InfraError);
    assert.match(error.message, /the backend could not be installed: python3 -m venv exited 1/);
    return true;
  });
  assertBackendTornDown(h, ["checkLayout", "install"]);
  assert.ok(!h.events.some((event) => event.startsWith("ensureNodeModules")));
  assert.deepEqual(pngs(h.root), []);
});

test("a container whose removal cannot be verified is infra — even after a good picture — and never a card", POSIX_ONLY, async () => {
  const h = harness({ backend: { dispose: [{ removed: false, detail: "docker rm -f agrav-backend-x timed out after 30s" }] } });
  await assert.rejects(processAttempt(makeAttempt(h.root), h.browser, h.deps), (error: unknown) => {
    assert.ok(error instanceof InfraError);
    assert.match(error.message, /docker rm -f agrav-backend-x timed out/);
    return true;
  });
  assert.ok(vitesGone(h), "the dev server is stopped before the backend's removal is judged");
  assert.equal(h.browser.cards().length, 0);
});

test("a dev server whose group outlives SIGKILL is infra: it may still hold its port", POSIX_ONLY, async () => {
  const h = harness();
  h.deps.stopVite = async () => false;
  await assert.rejects(processAttempt(makeAttempt(h.root), h.browser, h.deps), (error: unknown) => {
    assert.ok(error instanceof InfraError);
    assert.match(error.message, /the dev server's process group \d+ outlived SIGKILL and may still hold port 5173/);
    return true;
  });
  assertBackendTornDown(h, ["checkLayout", "install", "start"]);
  // The fake stopVite killed nothing; this test's group is still ours to end.
  for (const vite of h.vites) if (vite.proc.exitCode === null && vite.proc.signalCode === null) process.kill(-vite.pid, "SIGKILL");
});

test("a teardown fault after a frontend stop is infra too, and the card is not written", POSIX_ONLY, async () => {
  const h = harness({
    install: async () => {
      throw new Error("npm install failed (exit 1): ETARGET");
    },
    backend: { stop: { removed: false, detail: "container still there" } },
  });
  await assert.rejects(processAttempt(makeAttempt(h.root), h.browser, h.deps), InfraError);
  assert.equal(h.browser.cards().length, 0);
  assert.deepEqual(pngs(h.root), []);
});

test("a dev server on a port other than 5173 is photographed, with a warning", POSIX_ONLY, async () => {
  const h = harness({ vitePort: 5174 });
  const result = await processAttempt(makeAttempt(h.root), h.browser, h.deps);
  assert.deepEqual(result, { kind: "pictured", warnings: ["the dev server serves on port 5174, not the run contract's 5173"] });
  assert.ok(h.events.includes("goto http://localhost:5174/ load 30000"), "the port the banner named is the one photographed");
  assert.ok(indexOf(h.events, "busyPorts 5173") < indexOf(h.events, "goto http://localhost:5174/ load 30000"), "5173 is asked again before the shift is the model's");
});

test("a dev server pushed off 5173 while something else holds it: infra, not a warning — no picture", POSIX_ONLY, async () => {
  const h = harness({ vitePort: 5174, busyAfter: [5173] });
  await assert.rejects(processAttempt(makeAttempt(h.root), h.browser, h.deps), (error: unknown) => {
    assert.ok(error instanceof InfraError, String(error));
    assert.match(error.message, /port 5173 is held by something else, and the dev server serves on 5174/);
    return true;
  });
  assert.ok(!h.events.some((event) => event.startsWith("goto")));
  assert.ok(vitesGone(h));
  assertBackendTornDown(h, ["checkLayout", "install", "start"]);
  assert.deepEqual(pngs(h.root), []);
});

test("npm install killed by a signal the harness did not send: infra, with no registry question, and its node_modules removed", async () => {
  let root = "";
  const h = harness({
    install: async () => {
      mkdirSync(join(root, "eval-attempts", ATTEMPT, "frontend", "node_modules", "half"), { recursive: true });
      throw new InstallKilledError("SIGKILL");
    },
  });
  root = h.root;
  const attempt = makeAttempt(h.root);
  await assert.rejects(processAttempt(attempt, h.browser, h.deps), (error: unknown) => {
    assert.ok(error instanceof InfraError, String(error));
    assert.match(error.message, /npm install was killed by SIGKILL, which the harness did not send/);
    return true;
  });
  assert.ok(!h.events.includes("probeRegistry"), "whatever the registry says, it is not the model's");
  assert.equal(existsSync(nodeModulesOf(attempt)), false);
  assertBackendTornDown(h, ["checkLayout", "install", "start"]);
  assert.deepEqual(pngs(h.root), []);
});

test("a dev server npm cannot even start is the harness's fault, not a card", async () => {
  const h = harness({
    vite: async () => {
      throw new Error("npm run dev could not be started in /x: spawn npm ENOENT");
    },
  });
  await assert.rejects(processAttempt(makeAttempt(h.root), h.browser, h.deps), /the dev server could not be started: .*ENOENT/);
  assert.equal(h.browser.cards().length, 0);
  assertBackendTornDown(h, ["checkLayout", "install", "start"]);
});

test("an image that cannot be resolved is infra, and no backend is created", async () => {
  const h = harness({
    image: () => {
      throw new Error("could not resolve image agrav-bench/harness:2026-09-18 to an image Id");
    },
  });
  await assert.rejects(processAttempt(makeAttempt(h.root), h.browser, h.deps), /the harness image could not be resolved: could not resolve image/);
  assert.deepEqual(h.backends, []);
  assert.deepEqual(pngs(h.root), []);
});

test("a signal during the capture: nothing is written, and everything is still torn down", POSIX_ONLY, async () => {
  let signal: InterruptSignal | null = null;
  const h = harness({
    interrupted: () => signal,
    browser: {
      goto: async () => {
        // The signal's cleanup closes the browser, which fails the load.
        signal = "SIGTERM";
        throw new Error("page.goto: Target page, context or browser has been closed");
      },
    },
  });
  await assert.rejects(processAttempt(makeAttempt(h.root), h.browser, h.deps), (error: unknown) => {
    assert.ok(error instanceof CaptureInterrupted);
    assert.equal(error.signal, "SIGTERM");
    return true;
  });
  assert.equal(h.browser.cards().length, 0, "a card written now would blame the model for the operator's Ctrl-C");
  assert.deepEqual(pngs(h.root), []);
  assert.ok(vitesGone(h));
  assertBackendTornDown(h, ["checkLayout", "install", "start"]);
});

test("a model-failure card is not written after a signal either", async () => {
  const h = harness({ interrupted: () => "SIGINT" });
  await assert.rejects(processAttempt(makeAttempt(h.root, { modelFailure: true }), h.browser, h.deps), CaptureInterrupted);
  assert.deepEqual(pngs(h.root), []);
});

test("lazyImage resolves once, on first use, and not at all when never used", () => {
  let calls = 0;
  const seen: string[] = [];
  const image = lazyImage(
    () => {
      calls += 1;
      return { ref: REF, id: IMAGE_ID };
    },
    (ref) => seen.push(ref),
  );
  assert.equal(calls, 0, "nothing is resolved before a backend needs it");
  assert.deepEqual(image(), { ref: REF, id: IMAGE_ID });
  assert.deepEqual(image(), { ref: REF, id: IMAGE_ID });
  assert.equal(calls, 1);
  assert.deepEqual(seen, [REF]);
});

test("a backend step that throws instead of answering is infra, never a card", async () => {
  const h = harness({ backend: { throws: { install: new Error("docker run: argv validation failed") } } });
  await assert.rejects(processAttempt(makeAttempt(h.root), h.browser, h.deps), (error: unknown) => {
    assert.ok(error instanceof InfraError, String(error));
    assert.match(error.message, /the backend failed unexpectedly: docker run: argv validation failed/);
    return true;
  });
  assertBackendTornDown(h, ["checkLayout", "install"]);
  assert.ok(!h.events.some((event) => event.startsWith("ensureNodeModules")));
  assert.equal(h.browser.pages.length, 0, "no card, not even a page for one");
  assert.deepEqual(pngs(h.root), []);
});

test("a layout check that throws is infra too", async () => {
  const h = harness({ backend: { throws: { checkLayout: new Error("EACCES: backend/") } } });
  await assert.rejects(processAttempt(makeAttempt(h.root), h.browser, h.deps), /the backend failed unexpectedly: EACCES/);
  assertBackendTornDown(h, ["checkLayout"]);
  assert.deepEqual(pngs(h.root), []);
});

test("an npm ping that throws instead of answering is infra, not a card", async () => {
  const h = harness({
    install: async () => {
      throw new Error("npm install failed (exit 1): ETIMEDOUT");
    },
    probe: async () => {
      throw new Error("spawn npm EMFILE");
    },
  });
  await assert.rejects(processAttempt(makeAttempt(h.root), h.browser, h.deps), /npm ping could not be asked: spawn npm EMFILE/);
  assert.equal(h.browser.pages.length, 0);
  assertBackendTornDown(h, ["checkLayout", "install", "start"]);
});

test("a browser that cannot open a page is infra: no app code has run, so it is not the model's", POSIX_ONLY, async () => {
  const h = harness({
    browser: {
      newPage: () => {
        throw new Error("browser.newPage: Target page, context or browser has been closed");
      },
    },
  });
  await assert.rejects(processAttempt(makeAttempt(h.root), h.browser, h.deps), /the browser could not open a page: browser\.newPage/);
  assert.ok(vitesGone(h));
  assertBackendTornDown(h, ["checkLayout", "install", "start"]);
  assert.deepEqual(pngs(h.root), []);
});

/** An install that creates `<frontend>/node_modules/left-pad` and then fails with `failure`. */
function halfInstall(root: string, failure: string, before?: () => void): () => Promise<void> {
  return async () => {
    before?.();
    const modules = join(root, "eval-attempts", ATTEMPT, "frontend", "node_modules", "left-pad");
    mkdirSync(modules, { recursive: true });
    writeFileSync(join(modules, "index.js"), "module.exports = 1;\n");
    throw new Error(failure);
  };
}

function nodeModulesOf(attempt: AttemptInfo): string {
  return join(attempt.frontendRoot as string, "node_modules");
}

test("a failed install's half-built node_modules is removed — infra: the fixed network then gets a fresh install, not a sticky card", async () => {
  let root = "";
  const h = harness({ install: () => halfInstall(root, "npm install did not finish within 600s.")(), registry: false });
  root = h.root;
  const attempt = makeAttempt(h.root);
  await assert.rejects(processAttempt(attempt, h.browser, h.deps), InfraError);
  assert.equal(existsSync(nodeModulesOf(attempt)), false, "a partial node_modules would make the next run skip the install");
  assert.deepEqual(pngs(h.root), []);
});

test("a failed install's half-built node_modules is removed on the card path too", async () => {
  let root = "";
  const h = harness({ install: () => halfInstall(root, "npm install failed (exit 1): ETARGET")(), registry: true });
  root = h.root;
  const attempt = makeAttempt(h.root);
  const result = await processAttempt(attempt, h.browser, h.deps);
  assert.equal(result.kind, "card");
  assert.equal(existsSync(nodeModulesOf(attempt)), false);
});

test("a node_modules that was there before the install is never removed, whatever the install did", async () => {
  let root = "";
  const h = harness({ install: () => halfInstall(root, "npm install failed (exit 1): ETARGET")(), registry: false });
  root = h.root;
  const attempt = makeAttempt(h.root);
  mkdirSync(join(nodeModulesOf(attempt), "the-scoring-skills-install"), { recursive: true });
  await assert.rejects(processAttempt(attempt, h.browser, h.deps), InfraError);
  assert.equal(existsSync(join(nodeModulesOf(attempt), "the-scoring-skills-install")), true);
});

test("a finished install's node_modules stays", POSIX_ONLY, async () => {
  let root = "";
  const h = harness({
    install: async () => {
      mkdirSync(join(root, "eval-attempts", ATTEMPT, "frontend", "node_modules", "vite"), { recursive: true });
    },
  });
  root = h.root;
  const attempt = makeAttempt(h.root);
  assert.equal((await processAttempt(attempt, h.browser, h.deps)).kind, "pictured");
  assert.equal(existsSync(join(nodeModulesOf(attempt), "vite")), true);
  await removePartialInstalls();
  assert.equal(existsSync(join(nodeModulesOf(attempt), "vite")), true, "a signal's cleanup leaves a finished install alone");
});

test("a signal's cleanup deletes an unfinished install's node_modules off the event loop, and resolves once it is gone", async () => {
  let signal: InterruptSignal | null = null;
  let root = "";
  let installing!: () => void;
  const started = new Promise<void>((done) => (installing = done));
  let stopInstall!: (error: Error) => void;
  const h = harness({
    interrupted: () => signal,
    install: async () => {
      const modules = join(root, "eval-attempts", ATTEMPT, "frontend", "node_modules");
      for (let i = 0; i < 50; i++) {
        mkdirSync(join(modules, `pkg-${i}`), { recursive: true });
        writeFileSync(join(modules, `pkg-${i}`, "index.js"), "module.exports = 1;\n");
      }
      installing();
      // Still running at the signal; stopAllProcesses ends it below.
      await new Promise<void>((_resolve, reject) => (stopInstall = reject));
    },
  });
  root = h.root;
  const attempt = makeAttempt(h.root);
  const running = processAttempt(attempt, h.browser, h.deps);
  await started;

  signal = "SIGINT";
  const cleanup = removePartialInstalls();
  assert.ok(cleanup instanceof Promise, "the cleanup is awaited by installInterruptHandlers");
  assert.equal(existsSync(nodeModulesOf(attempt)), true, "a synchronous delete would block a second signal until it finished");
  await cleanup;
  assert.equal(existsSync(nodeModulesOf(attempt)), false, "resolved before the tree was gone");

  stopInstall(new Error("npm install failed (exit null): "));
  await assert.rejects(running, CaptureInterrupted);
  assert.equal(existsSync(nodeModulesOf(attempt)), false);
  assert.deepEqual(pngs(h.root), []);
});

test("a second signal's exit cleanup names an unfinished install's node_modules while it is there, and nothing once it is gone", async () => {
  let signal: InterruptSignal | null = null;
  let root = "";
  let installStarted!: () => void;
  const started = new Promise<void>((done) => (installStarted = done));
  let create!: () => void;
  const creating = new Promise<void>((done) => (create = done));
  let created!: () => void;
  const halfBuilt = new Promise<void>((done) => (created = done));
  let stopInstall!: (error: Error) => void;
  const h = harness({
    interrupted: () => signal,
    install: async () => {
      installStarted();
      await creating;
      mkdirSync(join(root, "eval-attempts", ATTEMPT, "frontend", "node_modules", "half"), { recursive: true });
      created();
      // Still running when the second signal exits the process.
      await new Promise<void>((_resolve, reject) => (stopInstall = reject));
    },
  });
  root = h.root;
  const attempt = makeAttempt(h.root);
  const ours = (): string[] => {
    const lines: string[] = [];
    warnPartialInstallsSync((line) => lines.push(line));
    // Other tests' installs share the module's set: only this one's lines count.
    return lines.filter((line) => line.includes(h.root));
  };
  const running = processAttempt(attempt, h.browser, h.deps);

  await started;
  assert.deepEqual(ours(), [], "an install that has not created node_modules yet left nothing to delete");

  create();
  await halfBuilt;
  const expected = `warning: ${nodeModulesOf(attempt)}, left by an npm install that did not finish, may be partly deleted: delete it by hand before the next run`;
  assert.deepEqual(ours(), [expected]);
  // As the exit listener calls it, with no argument: console.warn.
  const warned: string[] = [];
  const consoleWarn = console.warn;
  console.warn = (...args: unknown[]) => void warned.push(args.join(" "));
  try {
    warnPartialInstallsSync();
  } finally {
    console.warn = consoleWarn;
  }
  assert.deepEqual(warned.filter((line) => line.includes(h.root)), [expected]);

  signal = "SIGINT";
  stopInstall(new Error("npm install failed (exit null): "));
  await assert.rejects(running, CaptureInterrupted);
  assert.equal(existsSync(nodeModulesOf(attempt)), false);
  assert.deepEqual(ours(), [], "a removed tree is not warned about");
});

test("an install a signal stopped: its node_modules is removed before the signal is honoured, and nothing is written", async () => {
  let signal: InterruptSignal | null = null;
  let root = "";
  const h = harness({
    interrupted: () => signal,
    install: () =>
      halfInstall(root, "npm install failed (exit null): ", () => {
        signal = "SIGINT";
      })(),
  });
  root = h.root;
  const attempt = makeAttempt(h.root);
  await assert.rejects(processAttempt(attempt, h.browser, h.deps), CaptureInterrupted);
  assert.equal(existsSync(nodeModulesOf(attempt)), false, "an operator's Ctrl-C must not become a sticky card on the next run");
  assert.ok(!h.events.includes("probeRegistry"), "no registry question after a signal");
  assert.deepEqual(pngs(h.root), []);
});

test("a signal during the backend's install: not warned about as a backend stop, and nothing after it starts", async () => {
  let signal: InterruptSignal | null = null;
  const h = harness({
    interrupted: () => signal,
    backend: {
      // The signal's stopAllBackends closes the backend mid-install, which then reports a stop.
      during: { install: () => (signal = "SIGTERM") },
      install: { kind: "stop", stage: "install", detail: "pip install exited 137" },
    },
  });
  await assert.rejects(processAttempt(makeAttempt(h.root), h.browser, h.deps), CaptureInterrupted);
  assert.ok(!h.events.some((event) => event.startsWith("ensureNodeModules")), "no frontend install after a signal");
  assert.deepEqual(h.warnings, [], "a shutdown is not a backend stop");
  assertBackendTornDown(h, ["checkLayout", "install"]);
});

test("a signal while the backend starts: not warned about as a backend stop, and nothing after it starts", async () => {
  let signal: InterruptSignal | null = null;
  const h = harness({
    interrupted: () => signal,
    backend: {
      during: { start: () => (signal = "SIGTERM") },
      start: { kind: "stop", stage: "boot", detail: "the container exited 137" },
    },
  });
  await assert.rejects(processAttempt(makeAttempt(h.root), h.browser, h.deps), CaptureInterrupted);
  assert.ok(!h.events.some((event) => event.startsWith("ensureNodeModules")));
  assert.deepEqual(h.warnings, []);
  assertBackendTornDown(h, ["checkLayout", "install", "start"]);
});

test("a teardown a signal overlapped: CaptureInterrupted, not infra — the signal's own cleanup owns that removal", POSIX_ONLY, async () => {
  let signal: InterruptSignal | null = null;
  const h = harness({
    interrupted: () => signal,
    backend: {
      during: { stop: () => (signal = "SIGTERM") },
      stop: { removed: false, detail: "docker rm -f agrav-backend-x: the daemon is shutting the container down" },
    },
  });
  await assert.rejects(processAttempt(makeAttempt(h.root), h.browser, h.deps), (error: unknown) => {
    assert.ok(error instanceof CaptureInterrupted, String(error));
    return true;
  });
});

test("stopViteGroup: false while the group outlives the kill, true once it is gone or never was", async () => {
  const fake = (pid: number | undefined): ChildProcess => ({ pid }) as ChildProcess;
  const kills: (number | undefined)[] = [];
  const kill = async (proc: ChildProcess): Promise<void> => {
    kills.push(proc.pid);
  };
  assert.equal(await stopViteGroup(fake(4321), kill, () => true), false, "a group that outlived SIGKILL may still hold its port");
  assert.equal(await stopViteGroup(fake(4321), kill, () => false), true);
  assert.equal(
    await stopViteGroup(fake(undefined), kill, () => {
      throw new Error("no group to ask about");
    }),
    true,
    "a dev server that never spawned has no group",
  );
  assert.deepEqual(kills, [4321, 4321, undefined], "the kill always comes first");
});

test("stopViteGroup, by default: a real group is killed, waited for and found gone", POSIX_ONLY, async () => {
  const proc = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  children.add(proc);
  proc.once("close", () => children.delete(proc));
  const pid = proc.pid as number;
  const started = pidStartTime(pid);
  assert.equal(await within(stopViteGroup(proc), 10_000, "stopViteGroup"), true);
  assert.equal(isSameProcess(pid, started), false);
});

test("Chromium is launched without Playwright's own signal handlers, which would exit before the cleanups", async () => {
  const off = { handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false };
  assert.deepEqual({ ...CHROMIUM_LAUNCH_OPTIONS }, off);
  const seen: unknown[] = [];
  const browser = new FakeBrowser([]);
  const launched = await launchChromium({
    launch: async (options) => {
      seen.push(options);
      return browser;
    },
  });
  assert.equal(launched, browser);
  assert.deepEqual(seen, [off]);
});

test("main's default browser is launchChromium itself, never a bare chromium.launch()", () => {
  assert.equal(DEFAULT_MAIN_DEPS.launchBrowser, launchChromium);
});

// ---------------------------------------------------------------------------
// main: the pre-flight, and what stops a run

interface MainHarnessOptions extends HarnessOptions {
  /** The busy ports, or a function asked on every check. */
  busy?: number[] | (() => number[]);
  /** serve-attempt's state, or a function asked on every check. */
  serveState?: ServeState | null | (() => ServeState | null);
  ownerLive?: boolean;
}

interface MainHarness extends Harness {
  out: string[];
  err: string[];
  hooks: () => InterruptHooks;
  setSignal: (signal: InterruptSignal) => void;
  mainDeps: Partial<MainDeps>;
}

function mainHarness(o: MainHarnessOptions = {}): MainHarness {
  const h = harness(o);
  // main makes the screenshots directory itself, and must not when it refuses.
  rmSync(join(h.root, "website"), { recursive: true, force: true });
  const out: string[] = [];
  const err: string[] = [];
  let hooks: InterruptHooks | null = null;
  let signal: InterruptSignal | null = null;
  const { screenshotsDir: _dir, installTimeoutMs: _timeout, interrupted: _interrupted, ...capture } = h.deps;
  const mainDeps: Partial<MainDeps> = {
    sweep: () => {
      h.events.push("sweep");
      return EMPTY_SWEEP;
    },
    serveState: () => {
      h.events.push("serveState");
      return typeof o.serveState === "function" ? o.serveState() : (o.serveState ?? null);
    },
    ownerLive: () => o.ownerLive ?? false,
    busyPorts: async (ports) => {
      h.events.push(`busyPorts ${ports.join(",")}`);
      return typeof o.busy === "function" ? o.busy() : (o.busy ?? []);
    },
    launchBrowser: async () => {
      h.events.push("launchBrowser");
      return h.browser;
    },
    installHandlers: (installed) => {
      hooks = installed;
      return { uninstall: () => {}, interrupted: () => signal };
    },
    capture: { ...capture, log: (line) => out.push(line), warn: (line) => err.push(line) },
    log: (line) => out.push(line),
    warn: (line) => err.push(line),
  };
  return {
    ...h,
    out,
    err,
    mainDeps,
    hooks: () => {
      assert.ok(hooks !== null, "main installed no interrupt handlers");
      return hooks;
    },
    setSignal: (value) => {
      signal = value;
    },
  };
}

function serveStateFor(attempt: string): ServeState {
  return {
    pid: 4242,
    pidStart: "123456",
    attempt,
    status: "ready",
    image: REF,
    container: `agrav-backend-${attempt}-4242-2`,
    viteGroup: 4250,
    viteStart: "123460",
    url: "http://localhost:5173/",
    scratchDirs: [],
    pipFreeze: [],
    warnings: [],
    backend: "ok",
    frontend: "ok",
  };
}

test("a busy port: exit 1 with a clear message — no browser, no backend, no PNG, no card", async () => {
  const h = mainHarness({ busy: [5100] });
  makeAttempt(h.root);
  const code = await main(["--root", h.root], h.mainDeps);

  assert.equal(code, 1);
  assert.deepEqual(h.events, ["sweep", "serveState", "busyPorts 5100,5173"], "the order: sweep, serve-attempt's state, ports — and nothing after");
  assert.match(h.err.join("\n"), /port 5100 is already in use\. .*Nothing was started and no screenshot was written/s);
  assert.deepEqual(pngs(h.root), []);
  assert.equal(existsSync(screenshotsDirOf(h.root)), false, "not even the screenshots directory");
});

test("both ports busy are both named", async () => {
  const h = mainHarness({ busy: [5100, 5173] });
  makeAttempt(h.root);
  assert.equal(await main(["--root", h.root], h.mainDeps), 1);
  assert.match(h.err.join("\n"), /ports 5100 and 5173 are already in use/);
});

test("a live serve-attempt refuses the run before the port check", async () => {
  const h = mainHarness({ serveState: serveStateFor(ATTEMPT), ownerLive: true });
  makeAttempt(h.root);
  const code = await main(["--root", h.root], h.mainDeps);

  assert.equal(code, 1);
  assert.deepEqual(h.events, ["sweep", "serveState"]);
  assert.match(h.err.join("\n"), new RegExp(`serve-attempt is serving ${ATTEMPT} \\(pid 4242, http://localhost:5173/\\).*--stop --root`, "s"));
  assert.deepEqual(pngs(h.root), []);
});

test("a dead serve-attempt's state file is warned about, and the port check decides", POSIX_ONLY, async () => {
  const h = mainHarness({ serveState: serveStateFor(ATTEMPT), ownerLive: false });
  makeAttempt(h.root);
  const code = await main(["--root", h.root], h.mainDeps);

  assert.equal(code, 0, h.err.join("\n"));
  assert.match(h.err.join("\n"), /names pid 4242, serving .*no longer running.*--stop/s);
  assert.deepEqual(h.events.slice(0, 4), ["sweep", "serveState", "busyPorts 5100,5173", "launchBrowser"]);
  assert.deepEqual(pngs(h.root), [`${ATTEMPT}.png`, "gemini-38-flash-high_filmstrip.png"]);
});

test("an infra fault stops the run: exit 1, no card for it, and the attempts after it are not started", POSIX_ONLY, async () => {
  const h = mainHarness({ backend: { install: { kind: "infra", detail: "the PyPI probe failed too" } } });
  makeAttempt(h.root, { name: "gemini-38-flash-high-attempt-1" });
  makeAttempt(h.root, { name: "gemini-38-flash-high-attempt-2" });
  const code = await main(["--root", h.root], h.mainDeps);

  assert.equal(code, 1);
  assert.equal(h.backends.length, 1, "the second attempt started nothing");
  assert.deepEqual(h.backends[0].calls, ["checkLayout", "install", "stop", "dispose"]);
  assert.deepEqual(pngs(h.root), [], "no card, no filmstrip");
  assert.match(h.err.join("\n"), /Stopped by a harness fault, not the model's.*gemini-38-flash-high-attempt-1: the backend could not be installed: the PyPI probe failed too/s);
  assert.equal(h.browser.closed, true);
});

test("a run of model failures and missing frontends needs no pre-flight, no Docker and no image", async () => {
  const h = mainHarness();
  makeAttempt(h.root, { name: "gemini-38-flash-high-attempt-1", modelFailure: true });
  makeAttempt(h.root, { name: "gemini-38-flash-high-attempt-2", frontend: false });
  const code = await main(["--root", h.root], h.mainDeps);

  // One card is an error card for a frontend stop, and nothing was pictured: every capture it tried failed.
  assert.equal(code, 1);
  assert.ok(!h.events.includes("sweep") && !h.events.includes("serveState"), "no pre-flight");
  assert.ok(!h.events.some((event) => event.startsWith("busyPorts")));
  assert.ok(!h.events.includes("image"), "the image is never resolved");
  assert.deepEqual(h.backends, []);
  assert.deepEqual(pngs(h.root), [
    "gemini-38-flash-high-attempt-1.png",
    "gemini-38-flash-high-attempt-2.png",
    "gemini-38-flash-high_filmstrip.png",
  ]);
  assert.match(h.out.join("\n"), /Model failures \(pictured as model-failure cards\): 1/);
  assert.match(h.out.join("\n"), /Failures \(pictured as error cards\): 1/);
});

test("model-failure cards alone are not a failed run", async () => {
  const h = mainHarness();
  makeAttempt(h.root, { modelFailure: true });
  assert.equal(await main(["--root", h.root], h.mainDeps), 0, h.err.join("\n"));
  assert.deepEqual(h.backends, []);
});

test("--install-timeout reaches the frontend's install; main's own image lookup asks Docker once for the whole run", POSIX_ONLY, async () => {
  const h = mainHarness();
  makeAttempt(h.root, { name: "gemini-38-flash-high-attempt-1" });
  makeAttempt(h.root, { name: "gemini-38-flash-high-attempt-2" });
  // No image injected: main's default reads this repository's runner.yaml and
  // asks `docker image inspect` — here the fake, first on PATH for this file.
  const dockerState = stateDir();
  process.env.FAKE_DOCKER_STATE = dockerState;
  const { image: _image, ...capture } = h.mainDeps.capture ?? {};
  const code = await main(["--root", h.root, "--install-timeout", "90s"], { ...h.mainDeps, capture });

  assert.equal(code, 0, h.err.join("\n"));
  const inspects = dockerCalls(dockerState).filter((args) => args[0] === "image" && args[1] === "inspect");
  assert.deepEqual(inspects, [["image", "inspect", "-f", "{{.Id}}", readScoringImage(ROOT)]], "one lookup, of the repository's tag");
  assert.ok(h.out.includes(`  Harness image: ${readScoringImage(ROOT)}@${FAKE_IMAGE_ID}`), h.out.join("\n"));
  assert.equal(h.backends.length, 2);
  for (const backend of h.backends) {
    assert.equal(backend.options.image, FAKE_IMAGE_ID, "every backend of the run by the same bare Id");
    assert.deepEqual(backend.calls, ["checkLayout", "install", "start", "stop", "dispose"]);
  }
  const installs = h.events.filter((event) => event.startsWith("ensureNodeModules"));
  assert.equal(installs.length, 2);
  // The pre-flight's check, then again before the second attempt: not twice for the first.
  assert.deepEqual(
    h.events.filter((event) => event.startsWith("busyPorts") || event === "createBackend"),
    ["busyPorts 5100,5173", "createBackend", "busyPorts 5100,5173", "createBackend"],
  );
  for (const install of installs) assert.match(install, / 90000$/);
  assert.match(h.out.join("\n"), /--install-timeout 90s/);
});

test("a signal mid-capture: the cleanups abort the dev server's start and close the browser; nothing is written or started after", POSIX_ONLY, async () => {
  let viteCalled!: () => void;
  const viteStarted = new Promise<void>((done) => (viteCalled = done));
  let aborted = false;
  const h = mainHarness({
    vite: (_dir, options) =>
      new Promise<ViteServer>((_resolve, reject) => {
        options.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("startVite was aborted"));
          },
          { once: true },
        );
        viteCalled();
      }),
  });
  makeAttempt(h.root, { name: "gemini-38-flash-high-attempt-1" });
  makeAttempt(h.root, { name: "gemini-38-flash-high-attempt-2" });
  // An attempt pictured by an earlier run, whose filmstrip is missing: a run
  // that got to its filmstrips would rebuild it.
  makeAttempt(h.root, { name: "gemini-38-flash-high-attempt-3" });
  mkdirSync(screenshotsDirOf(h.root), { recursive: true });
  writeFileSync(join(screenshotsDirOf(h.root), "gemini-38-flash-high-attempt-3.png"), "an earlier picture");
  const running = main(["--root", h.root], h.mainDeps);
  await viteStarted;

  // What installInterruptHandlers does on a first signal: every cleanup, in order, awaited.
  const hooks = h.hooks();
  h.setSignal("SIGTERM");
  for (const cleanup of hooks.cleanups) await within(Promise.resolve(cleanup()), 10_000, "a signal cleanup");
  const code = await within(running, 10_000, "main after the signal's cleanups");

  assert.equal(code, 143);
  assert.equal(aborted, true, "the dev server's start was aborted, so no retry starts");
  assert.equal(h.browser.closed, true);
  assert.equal(h.backends.length, 1, "the next attempt never started");
  assert.deepEqual(h.backends[0].calls, ["checkLayout", "install", "start", "stop", "dispose"]);
  assert.deepEqual(pngs(h.root), ["gemini-38-flash-high-attempt-3.png"], "no card and no filmstrip after a signal");
  assert.equal(hooks.cleanups.length, 5, "abort, close the browser, stop every process group, stop every backend, remove a half-built node_modules");
  assert.equal(hooks.cleanups[4], removePartialInstalls, "the half-built node_modules goes last, once every process group is gone");
  assert.deepEqual(
    hooks.exitCleanups,
    [killAllProcessesSync, stopAllBackendsSync, warnPartialInstallsSync],
    "a second signal still SIGKILLs every process group and removes every container, then names a node_modules an unfinished install left",
  );
});

test("a signal while the page loads: the cleanups close the browser, which is what ends the load", POSIX_ONLY, async () => {
  let gotoCalled!: () => void;
  const loading = new Promise<void>((done) => (gotoCalled = done));
  const h = mainHarness({
    browser: {
      goto: () => {
        gotoCalled();
        return h.browser.hangUntilClosed();
      },
    },
  });
  makeAttempt(h.root);
  const running = main(["--root", h.root], h.mainDeps);
  await within(loading, 10_000, "the page load");

  const hooks = h.hooks();
  h.setSignal("SIGINT");
  for (const cleanup of hooks.cleanups) await within(Promise.resolve(cleanup()), 10_000, "a signal cleanup");
  assert.equal(await within(running, 10_000, "main after the signal's cleanups"), 130);

  assert.equal(h.browser.closed, true);
  assert.equal(h.browser.pages[0].closed, true, "the page is closed on the way out");
  assert.ok(vitesGone(h), "the dev server's group is gone");
  assert.deepEqual(h.backends[0].calls, ["checkLayout", "install", "start", "stop", "dispose"]);
  assert.deepEqual(pngs(h.root), [], "no card for an interrupted load");
});

test("main hands its interrupt state to the capture: a signal mid-attempt stops it before the next step", POSIX_ONLY, async () => {
  let setSignal: (signal: InterruptSignal) => void = () => assert.fail("too early");
  const h = mainHarness({
    // The install finishes, but a signal has landed meanwhile.
    install: async () => setSignal("SIGTERM"),
  });
  setSignal = h.setSignal;
  makeAttempt(h.root);
  assert.equal(await main(["--root", h.root], h.mainDeps), 143);
  assert.ok(!h.events.some((event) => event.startsWith("startVite")), "no dev server after the signal");
  assert.deepEqual(pngs(h.root), []);
  assert.deepEqual(h.backends[0].calls, ["checkLayout", "install", "start", "stop", "dispose"]);
});

test("a port taken between two captures stops the run as infra: no card, and the first attempt's picture kept", POSIX_ONLY, async () => {
  let checks = 0;
  const h = mainHarness({
    // Taken before the second attempt only: the run must not go on to the third once it is free again.
    busy: () => {
      checks += 1;
      return checks === 2 ? [5173] : [];
    },
  });
  makeAttempt(h.root, { name: "gemini-38-flash-high-attempt-1" });
  makeAttempt(h.root, { name: "gemini-38-flash-high-attempt-2" });
  makeAttempt(h.root, { name: "gemini-38-flash-high-attempt-3" });
  const code = await main(["--root", h.root], h.mainDeps);

  assert.equal(code, 1);
  assert.equal(checks, 2, "the run stopped at the second attempt");
  assert.equal(h.backends.length, 1, "nothing was started for the second attempt, nor the third");
  assert.ok(indexOf(h.events, "backend dispose") < h.events.lastIndexOf("busyPorts 5100,5173"), "checked after the first attempt's teardown");
  assert.deepEqual(pngs(h.root), ["gemini-38-flash-high-attempt-1.png", "gemini-38-flash-high_filmstrip.png"]);
  assert.match(
    h.err.join("\n"),
    /Stopped by a harness fault.*gemini-38-flash-high-attempt-2: port 5173 is already in use\..*between two captures; nothing was started for this attempt/s,
  );
});

test("a serve-attempt started between two captures stops the run the same way", POSIX_ONLY, async () => {
  let checks = 0;
  const h = mainHarness({
    serveState: () => {
      checks += 1;
      return checks === 1 ? null : serveStateFor("gemini-38-flash-high-attempt-1");
    },
    ownerLive: true,
  });
  makeAttempt(h.root, { name: "gemini-38-flash-high-attempt-1" });
  makeAttempt(h.root, { name: "gemini-38-flash-high-attempt-2" });
  const code = await main(["--root", h.root], h.mainDeps);

  assert.equal(code, 1);
  assert.equal(h.backends.length, 1);
  assert.deepEqual(pngs(h.root), ["gemini-38-flash-high-attempt-1.png", "gemini-38-flash-high_filmstrip.png"]);
  assert.match(h.err.join("\n"), /gemini-38-flash-high-attempt-2: serve-attempt is serving gemini-38-flash-high-attempt-1 \(pid 4242/);
});

test("main's own port check reaches the capture: 5173 taken by the time the dev server starts stops the run", POSIX_ONLY, async () => {
  let checks = 0;
  const h = mainHarness({
    vitePort: 5174,
    // Free at the pre-flight; taken by the time the capture asks.
    busy: () => (checks++ === 0 ? [] : [5173]),
  });
  makeAttempt(h.root);
  const { busyPorts: _own, ...capture } = h.mainDeps.capture ?? {};
  const code = await main(["--root", h.root], { ...h.mainDeps, capture });

  assert.equal(code, 1);
  assert.deepEqual(h.events.filter((event) => event.startsWith("busyPorts")), ["busyPorts 5100,5173", "busyPorts 5173"]);
  assert.match(h.err.join("\n"), /Stopped by a harness fault.*port 5173 is held by something else, and the dev server serves on 5174/s);
  assert.deepEqual(pngs(h.root), [], "no card, no filmstrip");
});

test("a dead serve-attempt's state file is warned about once per run, not before every attempt", POSIX_ONLY, async () => {
  const h = mainHarness({ serveState: serveStateFor(ATTEMPT), ownerLive: false });
  makeAttempt(h.root, { name: "gemini-38-flash-high-attempt-1" });
  makeAttempt(h.root, { name: "gemini-38-flash-high-attempt-2" });
  assert.equal(await main(["--root", h.root], h.mainDeps), 0, h.err.join("\n"));
  assert.equal(h.events.filter((event) => event === "serveState").length, 2, "asked again before the second attempt");
  assert.equal(h.err.filter((line) => /no longer running/.test(line)).length, 1);
});

test("an interrupted install's node_modules is removed by the signal's cleanups, even while the install has not answered", POSIX_ONLY, async () => {
  let installing!: () => void;
  const started = new Promise<void>((done) => (installing = done));
  let fail!: (error: Error) => void;
  let root = "";
  const h = mainHarness({
    install: () =>
      new Promise<void>((_resolve, reject) => {
        mkdirSync(join(root, "eval-attempts", ATTEMPT, "frontend", "node_modules", "half"), { recursive: true });
        fail = reject;
        installing();
      }),
  });
  root = h.root;
  const attempt = makeAttempt(h.root);
  const running = main(["--root", h.root], h.mainDeps);
  await within(started, 10_000, "the install");

  h.setSignal("SIGINT");
  for (const cleanup of h.hooks().cleanups) await within(Promise.resolve(cleanup()), 10_000, "a signal cleanup");
  assert.equal(existsSync(nodeModulesOf(attempt)), false, "the cleanups removed it, not the capture, which is still waiting");

  fail(new Error("npm install failed (exit null): "));
  assert.equal(await within(running, 10_000, "main after the signal"), 130);
  assert.deepEqual(pngs(h.root), []);
});

test("the cleanups a signal runs are harmless before the browser exists", async () => {
  const h = mainHarness({ busy: [5100] });
  makeAttempt(h.root);
  await main(["--root", h.root], h.mainDeps);
  // Refused before Chromium: the browser cleanup has nothing to close and must not throw.
  for (const cleanup of h.hooks().cleanups) await cleanup();
  assert.equal(h.browser.closed, false);
});

// ---------------------------------------------------------------------------
// across processes: the real main, through the fake docker and the fake npm

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

/** Fakes first on PATH, fresh state directories and TMPDIR; no inherited knob or test-runner state. */
function liveEnv(dockerState: string, npmState: string, browserState: string, tmp: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("FAKE_") || key === "NODE_TEST_CONTEXT") delete env[key];
  return {
    ...env,
    PATH: `${FAKE_NPM_DIR}${delimiter}${FAKE_DOCKER_DIR}${delimiter}${hooks.originalPath}`,
    FAKE_DOCKER_STATE: dockerState,
    FAKE_NPM_STATE: npmState,
    FAKE_NPM_DEV: "plain",
    FAKE_BROWSER_STATE: browserState,
    TMPDIR: tmp,
  };
}

function fakeContainers(dockerState: string): string[] {
  const dir = join(dockerState, "containers");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
}

function dockerCalls(dockerState: string): string[][] {
  const log = join(dockerState, "calls.log");
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]) : [];
}

async function survivorsAfter(state: string, ms: number): Promise<string[]> {
  const deadline = Date.now() + ms;
  let left = survivors(state);
  while (left.length > 0 && Date.now() < deadline) {
    await sleep(50);
    left = survivors(state);
  }
  return left.map((r) => `${r.pid} ${r.start}`);
}

describe("across processes, through the fake docker and the fake npm", { timeout: 90_000 }, () => {
  test("before: `docker` and `npm` on the children's PATH are the fakes", () => {
    const env = liveEnv("/nonexistent", "/nonexistent", "/nonexistent", tmpdir());
    assert.equal(spawnSync("docker", ["--fake-identity"], { encoding: "utf8", env, timeout: 10_000 }).stdout.trim(), "fake-docker-backend");
    assert.equal(spawnSync("npm", ["--fake-identity"], { encoding: "utf8", env, timeout: 10_000 }).stdout.trim(), "fake-npm");
  });

  test("a real capture: backend by Id on 5100, install, dev server, picture, filmstrip — and nothing left behind", POSIX_ONLY, async () => {
    const root = tempDir("agrav-shots-live-");
    const attempt = makeAttempt(root);
    const dockerState = stateDir();
    const npmState = stateDir();
    const browserState = tempDir("agrav-shots-browser-");
    const tmp = tempDir("agrav-shots-tmp-");
    const live = start([FIXTURE, "--root", root], liveEnv(dockerState, npmState, browserState, tmp));
    const exit = await live.exited;
    assert.deepEqual(exit, { code: 0, signal: null }, live.output());

    // The picture is of the dev server the fake npm started, on the port its banner named.
    const port = Number(readFileSync(join(npmState, "port"), "utf8"));
    assert.equal(readFileSync(join(browserState, "goto"), "utf8").trim(), `http://localhost:${port}/`);
    assert.match(readFileSync(join(screenshotsDirOf(root), `${ATTEMPT}.png`), "utf8"), /^picture 200 <!doctype html><title>fake dev server/);
    assert.ok(existsSync(join(screenshotsDirOf(root), "gemini-38-flash-high_filmstrip.png")));
    const manifest = JSON.parse(readFileSync(join(root, "website", "src", "data", "screenshot-hashes.json"), "utf8")) as Record<string, string>;
    assert.deepEqual(Object.keys(manifest), [`${ATTEMPT}.png`, "gemini-38-flash-high_filmstrip.png"]);
    assert.match(live.output(), new RegExp(`the dev server serves on port ${port}, not the run contract's 5173`));

    // The image from this repository's runner.yaml, run by its Id, published on 127.0.0.1:5100.
    assert.match(live.output(), new RegExp(`Harness image: ${readScoringImage(ROOT).replace(/[.]/g, "\\.")}@${FAKE_IMAGE_ID}`));
    const serve = dockerCalls(dockerState).find((args) => args[0] === "run" && args.includes("-d"));
    assert.ok(serve !== undefined, "a serving container was started");
    assert.equal(serve[serve.indexOf("-p") + 1], "127.0.0.1:5100:5100");
    assert.ok(serve.includes(FAKE_IMAGE_ID), "the serving container runs by the bare image Id");

    // The frontend's install ran through the fake npm, and left no lockfile in model output.
    assert.ok(readFileSync(join(npmState, "calls.log"), "utf8").split("\n").includes("install"));
    assert.equal(existsSync(join(attempt.frontendRoot as string, "package-lock.json")), false);

    assert.deepEqual(fakeContainers(dockerState), [], "no container is left");
    assert.deepEqual(await survivorsAfter(dockerState, 2000), [], "no fake backend process is alive");
    assert.deepEqual(await survivorsAfter(npmState, 2000), [], "no dev server process is alive");
    assert.deepEqual(readdirSync(tmp).filter((d) => d.startsWith("agrav-backend-")), [], "no scratch directory is left");
  });

  test("SIGTERM while the page loads: exit 143, no card, and every container, process and scratch directory gone", POSIX_ONLY, async () => {
    const root = tempDir("agrav-shots-live-");
    makeAttempt(root);
    const dockerState = stateDir();
    const npmState = stateDir();
    const browserState = tempDir("agrav-shots-browser-");
    const tmp = tempDir("agrav-shots-tmp-");
    const live = start([FIXTURE, "--root", root], { ...liveEnv(dockerState, npmState, browserState, tmp), FAKE_BROWSER_GOTO: "hang" });
    const deadline = Date.now() + 60_000;
    while (!existsSync(join(browserState, "goto"))) {
      if (live.child.exitCode !== null || live.child.signalCode !== null) assert.fail(`it exited before loading the page:\n${live.output()}`);
      if (Date.now() >= deadline) assert.fail(`no page load within 60 s:\n${live.output()}`);
      await sleep(50);
    }
    assert.equal(fakeContainers(dockerState).length, 1, "the backend is serving while the page loads");
    assert.equal(survivors(npmState).length > 0, true, "the dev server is running while the page loads");

    // Our own child, still unreaped: its pid cannot have been reused.
    assert.equal(live.child.exitCode, null);
    live.child.kill("SIGTERM");
    assert.deepEqual(await live.exited, { code: 143, signal: null }, live.output());

    assert.deepEqual(pngs(root), [], "no card and no filmstrip: an interruption is not the model's");
    assert.equal(existsSync(join(root, "website", "src", "data", "screenshot-hashes.json")), false);
    assert.deepEqual(fakeContainers(dockerState), [], "the signal's cleanup removed the container");
    assert.deepEqual(await survivorsAfter(dockerState, 2000), []);
    assert.deepEqual(await survivorsAfter(npmState, 0), [], "the dev server's group was gone before the process exited");
    assert.deepEqual(readdirSync(tmp).filter((d) => d.startsWith("agrav-backend-")), []);
  });
});
