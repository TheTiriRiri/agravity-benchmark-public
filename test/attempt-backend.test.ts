/**
 * `scripts/lib/attempt-backend.ts`: the argv of every container it starts, and
 * its whole lifecycle — layout, venv, install, PyPI probe, serve, health,
 * removal — driven through a stateful fake `docker` put first on PATH
 * (`test/fixtures/fake-docker-backend/docker`). No daemon, no Python, no
 * network beyond loopback: the fake's "containers" are local node processes on
 * random 127.0.0.1 ports.
 *
 * After every lifecycle case: no process the fake started is alive, no fake
 * container is left, and no `agrav-backend-*` scratch directory remains under
 * the case's tmpRoot. The hooks are `test/fixtures/fake-docker-backend-hooks.ts`:
 * once the suite is over, `docker` refuses every call, so work a failing case
 * left pending can never reach the machine's own client — the last test here
 * proves it in a child `node --test`.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  AttemptBackend,
  BACKEND_ENV,
  BackendInfraError,
  freezeArgs,
  hasNetworkError,
  installArgs,
  parsePortMapping,
  probeArgs,
  pytestArgs,
  SERVE_COMMAND,
  serveArgs,
  stopAllBackends,
  stopAllBackendsSync,
  venvArgs,
  type ArgvBase,
  type BackendOptions,
  type StartResult,
  type StepResult,
} from "../scripts/lib/attempt-backend";
import { LABEL_ATTEMPT, LABEL_OWNER, LABEL_ROLE, SCRATCH_DIR_RE, scratchDirPrefix, sweepDeadOwners } from "../scripts/lib/docker";
import { FAKE_DOCKER, FAKE_DOCKER_DIR, switchToRefusedDocker, useFakeDockerBackend } from "./fixtures/fake-docker-backend-hooks";
import { recordedPids, survivors } from "./fixtures/fake-docker-backend-pids";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const IMAGE = "agrav-bench/harness:2026-09-18";
/** What the fake's `image inspect` answers: the bare Id a caller passes as `image`. */
const IMAGE_ID = `sha256:${"f".repeat(64)}`;
/** Short enough to keep the suite quick, long enough for a loaded machine. */
const SHORT = { healthMs: 3_000, pipInstallMs: 10_000, pypiProbeMs: 10_000 };
/** A lifecycle case that hangs fails instead of holding `npm test` forever. */
const LIFECYCLE = { timeout: 30_000 };
// Timing, so that a loaded machine cannot fail a case. What the fake can count
// (health probes, the pid a record names) is counted, never raced against a
// pause. A lower bound on elapsed time holds under any load: a timer never
// fires early. An upper bound only has to tell the right behaviour from the
// wrong one, which would hang or wait out a 20 s budget, so it is 10 s, far
// from the right behaviour's own second or two.

// ---------------------------------------------------------------------------
// argv builders

const BASE: ArgvBase = {
  name: "agrav-backend-demo-attempt-1-4242-7",
  image: IMAGE,
  attemptDir: "/srv/eval-attempts/demo-attempt-1",
  attemptName: "demo-attempt-1",
  scratchDir: "/tmp/agrav-backend-4242-AbC123",
  owner: 4242,
  user: "1000:1000",
};

const BUILDERS: Record<string, (b: ArgvBase) => string[]> = {
  venv: venvArgs,
  install: installArgs,
  probe: probeArgs,
  freeze: freezeArgs,
  "serve (ephemeral)": (b) => serveArgs({ ...b, hostPort: "ephemeral" }),
  "serve (5100)": (b) => serveArgs({ ...b, hostPort: 5100 }),
  pytest: pytestArgs,
};

/** Every value that follows `flag` in `argv`. */
function values(argv: string[], flag: string): string[] {
  return argv.flatMap((arg, i) => (arg === flag && i + 1 < argv.length ? [argv[i + 1]] : []));
}

/** The arguments after the image: the entrypoint's own. */
function command(argv: string[]): string[] {
  return argv.slice(argv.indexOf(IMAGE) + 1);
}

/** docker's own options: everything before the image (`pip download -d` is not `docker run -d`). */
function dockerOptions(argv: string[]): string[] {
  return argv.slice(0, argv.indexOf(IMAGE));
}

test("no builder mounts credentials, agy's state or anything under ~/.gemini", () => {
  for (const [label, build] of Object.entries(BUILDERS)) {
    const text = build(BASE).join("\n");
    assert.doesNotMatch(text, /agy-creds/, label);
    assert.doesNotMatch(text, /\.gemini/, label);
    assert.doesNotMatch(text, /antigravity/, label);
  }
});

test("every container is named, labelled, run as the host uid under --init, never pulled and never --rm", () => {
  for (const [label, build] of Object.entries(BUILDERS)) {
    const argv = build(BASE);
    assert.equal(argv[0], "run", label);
    assert.deepEqual(values(argv, "--name"), [BASE.name], label);
    assert.deepEqual(
      values(argv, "--label"),
      [`${LABEL_ROLE}=backend`, `${LABEL_ATTEMPT}=demo-attempt-1`, `${LABEL_OWNER}=4242`],
      label,
    );
    assert.deepEqual(values(argv, "--user"), ["1000:1000"], label);
    assert.ok(dockerOptions(argv).includes("--init"), `${label}: --init`);
    assert.deepEqual(values(argv, "--pull"), ["never"], label);
    assert.equal(values(argv, "--entrypoint").length, 1, `${label}: one --entrypoint`);
    assert.ok(!argv.includes("--rm"), `${label}: no --rm, so a crash keeps its log`);
    assert.ok(!argv.includes("--network"), `${label}: the default bridge, for pip`);
    assert.ok(!argv.some((a) => /^--(memory|env-file|privileged|cap-add|volumes-from|mount)/.test(a)), `${label}: nothing beyond the listed flags`);
  }
});

test("the environment is exactly the five PYTHON/PIP variables and HOME, with no pass-through", () => {
  const expected = [
    "PYTHONDONTWRITEBYTECODE=1",
    "PYTHONUNBUFFERED=1",
    "PIP_NO_CACHE_DIR=1",
    "PIP_DISABLE_PIP_VERSION_CHECK=1",
    "PIP_NO_INPUT=1",
    "HOME=/scoring/home",
  ];
  assert.deepEqual([...BACKEND_ENV], expected);
  for (const [label, build] of Object.entries(BUILDERS)) {
    const argv = build(BASE);
    assert.deepEqual(values(argv, "-e"), expected, label);
    assert.ok(!argv.includes("--env"), label);
    // `-e NAME` without a value would pass the host's through.
    assert.ok(values(argv, "-e").every((v) => v.includes("=")), label);
  }
});

test("install, serve and pytest mount the attempt read-only at /workspace and work in /workspace/backend", () => {
  for (const label of ["install", "serve (ephemeral)", "serve (5100)", "pytest"]) {
    const argv = BUILDERS[label](BASE);
    assert.ok(values(argv, "-v").includes("/srv/eval-attempts/demo-attempt-1:/workspace:ro"), label);
    assert.ok(!values(argv, "-v").includes("/srv/eval-attempts/demo-attempt-1:/workspace"), `${label}: never writable`);
    assert.deepEqual(values(argv, "-w"), ["/workspace/backend"], label);
  }
  // The harness-owned steps never read the attempt, so a defect in it cannot
  // make their failure look like the harness's (or the reverse).
  for (const label of ["venv", "probe", "freeze"]) {
    const argv = BUILDERS[label](BASE);
    assert.deepEqual(values(argv, "-v"), ["/tmp/agrav-backend-4242-AbC123:/scoring"], label);
    assert.deepEqual(values(argv, "-w"), ["/scoring"], label);
  }
  assert.deepEqual(values(installArgs(BASE), "-v"), [
    "/srv/eval-attempts/demo-attempt-1:/workspace:ro",
    "/tmp/agrav-backend-4242-AbC123:/scoring",
  ]);
});

test("each step runs its own command", () => {
  assert.deepEqual(values(venvArgs(BASE), "--entrypoint"), ["python3"]);
  assert.deepEqual(command(venvArgs(BASE)), ["-m", "venv", "/scoring/venv"]);
  assert.deepEqual(values(installArgs(BASE), "--entrypoint"), ["/scoring/venv/bin/pip"]);
  assert.deepEqual(command(installArgs(BASE)), ["install", "-r", "requirements.txt"]);
  assert.deepEqual(values(probeArgs(BASE), "--entrypoint"), ["/scoring/venv/bin/pip"]);
  assert.deepEqual(command(probeArgs(BASE)), ["download", "--no-deps", "--no-cache-dir", "-d", "/tmp/agrav-probe", "fastapi==0.115.14"]);
  assert.deepEqual(values(freezeArgs(BASE), "--entrypoint"), ["/scoring/venv/bin/pip"]);
  assert.deepEqual(command(freezeArgs(BASE)), ["freeze"]);
  assert.deepEqual(command(serveArgs({ ...BASE, hostPort: "ephemeral" })), ["app.main:app", "--host", "0.0.0.0", "--port", "5100"]);
});

test("only the serving container is detached, pids-limited, published, on a tmpfs HOME and a read-only venv", () => {
  for (const label of ["venv", "install", "probe", "freeze"]) {
    const argv = dockerOptions(BUILDERS[label](BASE));
    assert.ok(!argv.includes("-d"), label);
    assert.ok(!argv.includes("--pids-limit"), label);
    assert.ok(!argv.includes("-p"), label);
    assert.ok(!argv.includes("--tmpfs"), label);
  }
  assert.deepEqual(serveArgs({ ...BASE, hostPort: "ephemeral" }), [
    "run", "-d", "--init", "--pull", "never",
    "--name", "agrav-backend-demo-attempt-1-4242-7",
    "--label", "agrav.role=backend", "--label", "agrav.attempt=demo-attempt-1", "--label", "agrav.owner=4242",
    "--user", "1000:1000",
    "-e", "PYTHONDONTWRITEBYTECODE=1", "-e", "PYTHONUNBUFFERED=1", "-e", "PIP_NO_CACHE_DIR=1",
    "-e", "PIP_DISABLE_PIP_VERSION_CHECK=1", "-e", "PIP_NO_INPUT=1", "-e", "HOME=/scoring/home",
    "--pids-limit", "512",
    "--tmpfs", "/scoring/home:mode=1777",
    "-v", "/srv/eval-attempts/demo-attempt-1:/workspace:ro",
    "-v", "/tmp/agrav-backend-4242-AbC123/venv:/scoring/venv:ro",
    "-w", "/workspace/backend",
    "-p", "127.0.0.1::5100",
    "--entrypoint", "/scoring/venv/bin/uvicorn",
    IMAGE, "app.main:app", "--host", "0.0.0.0", "--port", "5100",
  ]);
  // The fixed port differs in exactly one argument.
  const fixed = serveArgs({ ...BASE, hostPort: 5100 });
  assert.deepEqual(values(fixed, "-p"), ["127.0.0.1:5100:5100"]);
  assert.deepEqual(
    fixed.filter((a) => a !== "127.0.0.1:5100:5100"),
    serveArgs({ ...BASE, hostPort: "ephemeral" }).filter((a) => a !== "127.0.0.1::5100"),
  );
  // The scratch directory is never writable from a serving container.
  assert.ok(!values(fixed, "-v").some((v) => v.startsWith("/tmp/agrav-backend-4242-AbC123:")));
});

test("the builders refuse what docker would misread", () => {
  assert.throws(() => installArgs({ ...BASE, attemptDir: "/srv/a:b/demo-attempt-1" }), /without ':'/);
  assert.throws(() => venvArgs({ ...BASE, scratchDir: "relative/dir" }), /absolute host path/);
  assert.throws(() => venvArgs({ ...BASE, name: "--privileged" }), /not a container name/);
  assert.throws(() => venvArgs({ ...BASE, image: "-v" }), /not an image reference/);
  assert.throws(() => venvArgs({ ...BASE, attemptName: "Demo_attempt-1" }), /not an attempt directory name/);
  assert.throws(() => serveArgs({ ...BASE, hostPort: 8080 as unknown as 5100 }), /"ephemeral" or 5100/);
  assert.throws(() => pytestArgs({ ...BASE, attemptDir: "/srv/a:b/demo-attempt-1" }), /without ':'/);
});

test("runPytest returns ran: false, notRunReason: 'no backend/tests' when tests dir is missing", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "agrav-pytest-notests-"));
  try {
    const backend = new AttemptBackend({
      attemptDir: tmp,
      attemptName: "demo-attempt-1",
      image: IMAGE,
      hostPort: "ephemeral",
    });
    const result = await backend.runPytest();
    assert.deepEqual(result, {
      kind: "complete",
      result: {
        ran: false,
        timedOut: false,
        exitCode: null,
        passed: 0,
        failed: 0,
        errors: 0,
        durationMs: 0,
        outputTail: "",
        notRunReason: "no backend/tests",
      },
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("parsePortMapping takes the loopback mapping docker reports, and nothing else", () => {
  assert.equal(parsePortMapping("127.0.0.1:49153\n"), 49153);
  assert.equal(parsePortMapping("127.0.0.1:5100"), 5100);
  assert.equal(parsePortMapping("[::1]:49153\n127.0.0.1:49154\n"), 49154);
  assert.equal(parsePortMapping("0.0.0.0:49153\n"), null);
  assert.equal(parsePortMapping(""), null);
  assert.equal(parsePortMapping("127.0.0.1:0"), null);
  assert.equal(parsePortMapping("127.0.0.1:99999"), null);
  assert.equal(parsePortMapping("Error: No public port '5100/tcp' published for x"), null);
});

test("the constructor refuses a bad attempt name, image, port or limit", () => {
  const ok: BackendOptions = { attemptDir: "/srv/demo-attempt-1", attemptName: "demo-attempt-1", image: IMAGE, hostPort: "ephemeral" };
  assert.doesNotThrow(() => new AttemptBackend(ok));
  assert.throws(() => new AttemptBackend({ ...ok, attemptName: "demo_attempt-1" }), /attemptName/);
  assert.throws(() => new AttemptBackend({ ...ok, image: "" }), /image/);
  assert.throws(() => new AttemptBackend({ ...ok, hostPort: 5173 as unknown as 5100 }), /hostPort/);
  assert.throws(() => new AttemptBackend({ ...ok, limits: { healthMs: -1 } }), /limits\.healthMs/);
});

test("importing the module installs no process handler", async () => {
  const events = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "exit", "beforeExit", "uncaughtException"] as const;
  const before = events.map((e) => process.listenerCount(e));
  // A query string makes this a new module instance, evaluated here although
  // this file already imported it.
  const fresh = await import(`${new URL("../scripts/lib/attempt-backend", import.meta.url).href}?listener-probe=${process.hrtime.bigint()}`);
  assert.equal(typeof fresh.AttemptBackend, "function");
  assert.deepEqual(events.map((e) => process.listenerCount(e)), before);
});

// ---------------------------------------------------------------------------
// lifecycle, through the fake docker

// The fake first on PATH; once the suite is over, a `docker` that refuses
// everything — never the machine's client (see the hooks module).
const hooks = useFakeDockerBackend();

function fakeContainers(stateDir: string): string[] {
  const dir = join(stateDir, "containers");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -".json".length));
}

/** A fake container's record, or `null` once it is removed. */
function fakeRecord(stateDir: string, name: string): { status: string; pid: number | null } | null {
  try {
    return JSON.parse(readFileSync(join(stateDir, "containers", `${name}.json`), "utf8")) as { status: string; pid: number | null };
  } catch {
    return null;
  }
}

/** The fake docker by path, never whatever PATH finds: a sweep told every owner is dead must not reach a real daemon. */
const fakeDockerRun = (args: string[], timeoutMs: number): SpawnSyncReturns<string> =>
  spawnSync(FAKE_DOCKER, args, { encoding: "utf8", timeout: timeoutMs });

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function fakeCalls(stateDir: string): string[][] {
  const log = join(stateDir, "calls.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
}

interface Case {
  root: string;
  stateDir: string;
  tmpRoot: string;
  attemptDir: string;
  attemptName: string;
  backend(options?: Partial<BackendOptions>): AttemptBackend;
  /** No fake process alive, no fake container, no scratch directory. */
  assertClean(): void;
}

/** A synthetic attempt with a complete backend layout, a fresh fake state and tmpRoot, and the knobs set. */
function setup(knobs: Record<string, string> = {}, layout: "full" | "no-main" | "no-backend" | "symlink" = "full"): Case {
  const root = hooks.newRoot();
  const stateDir = join(root, "state");
  const tmpRoot = join(root, "tmp");
  const attemptName = "fake-model-attempt-1";
  const attemptDir = join(root, "eval-attempts", attemptName);
  mkdirSync(stateDir);
  mkdirSync(tmpRoot);
  mkdirSync(attemptDir, { recursive: true });
  if (layout === "symlink") {
    mkdirSync(join(root, "elsewhere", "app"), { recursive: true });
    writeFileSync(join(root, "elsewhere", "requirements.txt"), "fastapi==0.115.14\n");
    writeFileSync(join(root, "elsewhere", "app", "main.py"), "app = None\n");
    symlinkSync(join(root, "elsewhere"), join(attemptDir, "backend"));
  } else if (layout !== "no-backend") {
    mkdirSync(join(attemptDir, "backend", "app"), { recursive: true });
    writeFileSync(join(attemptDir, "backend", "requirements.txt"), "fastapi==0.115.14\nuvicorn==0.30.6\n");
    if (layout === "full") writeFileSync(join(attemptDir, "backend", "app", "main.py"), "app = None\n");
  }
  process.env.FAKE_DOCKER_STATE = stateDir;
  for (const [key, value] of Object.entries(knobs)) process.env[key] = value;
  return {
    root,
    stateDir,
    tmpRoot,
    attemptDir,
    attemptName,
    backend: (options = {}) =>
      new AttemptBackend({ attemptDir, attemptName, image: IMAGE, hostPort: "ephemeral", tmpRoot, limits: SHORT, ...options }),
    assertClean() {
      assert.deepEqual(fakeContainers(stateDir), [], "no fake container left");
      assert.deepEqual(survivors(stateDir), [], "no process the fake started is alive");
      assert.deepEqual(
        readdirSync(tmpRoot).filter((e) => e.startsWith("agrav-backend-")),
        [],
        "no scratch directory left",
      );
    },
  };
}

function scratchDirs(c: Case): string[] {
  return readdirSync(c.tmpRoot).filter((e) => e.startsWith("agrav-backend-"));
}

function assertStop(result: StepResult | StartResult, stage: string, detail: RegExp): void {
  assert.equal(result.kind, "stop", JSON.stringify(result));
  assert.ok(result.kind === "stop");
  assert.equal(result.stage, stage);
  assert.match(result.detail, detail);
}

function assertInfra(result: StepResult | StartResult, detail: RegExp): void {
  assert.equal(result.kind, "infra", JSON.stringify(result));
  assert.ok(result.kind === "infra");
  assert.match(result.detail, detail);
}

/** install() must be ok; returns the backend. */
async function installed(c: Case, options?: Partial<BackendOptions>): Promise<AttemptBackend> {
  const backend = c.backend(options);
  assert.deepEqual(backend.checkLayout(), { kind: "ok" });
  assert.deepEqual(await backend.install(), { kind: "ok" });
  return backend;
}

test("ok: install, freeze, ready on the ephemeral port docker reports, health answers, then nothing is left", LIFECYCLE, async () => {
  const c = setup({ FAKE_INSTALL: "ok", FAKE_BACKEND: "ok" });
  const seen: string[] = [];
  const backend = await installed(c, {
    onContainer: (name, purpose, scratchDir) => {
      assert.deepEqual(scratchDirs(c).map((e) => join(c.tmpRoot, e)), [scratchDir]);
      seen.push(`${purpose} ${name}`);
    },
  });
  assert.equal(scratchDirs(c).length, 1);
  assert.match(scratchDirs(c)[0], new RegExp(`^agrav-backend-${process.pid}-[A-Za-z0-9]{6}$`));
  // The install's containers are already gone; only the venv remains.
  assert.deepEqual(fakeContainers(c.stateDir), []);
  assert.deepEqual(await backend.pipFreeze(), ["fastapi==0.115.14", "uvicorn==0.30.6"]);

  const started = await backend.start();
  assert.equal(started.kind, "ready", JSON.stringify(started));
  assert.ok(started.kind === "ready");
  assert.match(started.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  const health = await fetch(`${started.baseUrl}/api/v1/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });
  assert.deepEqual(fakeContainers(c.stateDir), [started.container]);
  assert.deepEqual(await backend.servingState(), { kind: "running" });

  // Every name was announced before its docker run, and each one is unique.
  const prefix = `agrav-backend-${c.attemptName}-${process.pid}-`;
  assert.deepEqual(seen.map((s) => s.split(" ")[0]), ["venv", "install", "freeze", "serve"]);
  const names = seen.map((s) => s.split(" ")[1]);
  assert.ok(names.every((n) => n.startsWith(prefix)), names.join(", "));
  assert.equal(new Set(names).size, names.length);
  assert.equal(started.container, names[3]);
  const runs = fakeCalls(c.stateDir).filter((a) => a[0] === "run");
  assert.deepEqual(runs.map((a) => a[a.indexOf("--name") + 1]), names);
  assert.ok(runs[3].includes("127.0.0.1::5100"));

  assert.deepEqual(await backend.stop(), { removed: true, detail: `docker rm -f ${started.container} succeeded; the daemon no longer knows container ${started.container}` });
  assert.deepEqual(fakeContainers(c.stateDir), []);
  assert.deepEqual(await backend.dispose(), []);
  c.assertClean();
});

test("a second start replaces the serving container, and a restart gets a new name and port", LIFECYCLE, async () => {
  const c = setup({ FAKE_BACKEND: "ok" });
  const backend = await installed(c);
  const first = await backend.start();
  const second = await backend.start();
  assert.ok(first.kind === "ready" && second.kind === "ready");
  assert.notEqual(first.container, second.container);
  assert.deepEqual(fakeContainers(c.stateDir), [second.container]);
  assert.equal((await fetch(`${second.baseUrl}/api/v1/health`)).status, 200);
  await backend.dispose();
  c.assertClean();
});

test("hostPort 5100 publishes 127.0.0.1:5100:5100 but trusts only the port docker reports", LIFECYCLE, async () => {
  const c = setup({ FAKE_BACKEND: "ok" });
  const backend = await installed(c, { hostPort: 5100 });
  const started = await backend.start();
  assert.ok(started.kind === "ready", JSON.stringify(started));
  const run = fakeCalls(c.stateDir).find((a) => a[0] === "run" && a.includes("-d"));
  assert.ok(run?.includes("127.0.0.1:5100:5100"));
  // The fake never binds 5100; a backend that assumed it would have probed
  // whatever else listens there.
  const reported = readFileSync(join(c.stateDir, "containers", `${started.container}.port`), "utf8").trim();
  assert.equal(started.baseUrl, `http://127.0.0.1:${reported}`);
  assert.notEqual(reported, "5100");
  // `docker port` asks for the container port uvicorn listens on.
  assert.ok(fakeCalls(c.stateDir).some((a) => a[0] === "port" && a[1] === started.container && a[2] === `${SERVE_COMMAND.at(-1)}/tcp`));
  await backend.dispose();
  c.assertClean();
});

test("a slow backend is polled until /api/v1/health answers", LIFECYCLE, async () => {
  // Two 404s before the 200, counted by the fake: however slow the machine,
  // only a third probe can succeed. (More than three, if one timed out.)
  const c = setup({ FAKE_BACKEND: "ok", FAKE_HEALTH_404_FIRST: "2" });
  const backend = await installed(c, { limits: { ...SHORT, healthMs: 20_000 } });
  const started = await backend.start();
  assert.equal(started.kind, "ready", JSON.stringify(started));
  const probes = readFileSync(join(c.stateDir, "containers", `${(started as { container: string }).container}.log`), "utf8").match(/GET \/api\/v1\/health/g) ?? [];
  assert.ok(probes.length >= 3, `polled ${probes.length} times`);
  await backend.dispose();
  c.assertClean();
});

test("crash: the container exits before health → stop boot, with its log tail", LIFECYCLE, async () => {
  const c = setup({ FAKE_BACKEND: "crash" });
  const backend = await installed(c, { limits: { ...SHORT, healthMs: 20_000 } });
  const t0 = performance.now();
  const started = await backend.start();
  // Seen by `docker inspect` in the round it happened, not at the health deadline.
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 10_000, `found after ${elapsed} ms of a 20 s budget`);
  // The detail is the container's log tail, read just before its removal, then the verdict.
  assertStop(
    started,
    "boot",
    /Traceback \(most recent call last\):[\s\S]*ModuleNotFoundError: No module named 'nopkg_fake'\n\(the container exited with code 1 before GET \/api\/v1\/health answered\)$/,
  );
  // A stop leaves no container running.
  assert.deepEqual(fakeContainers(c.stateDir), []);
  assert.deepEqual(await backend.dispose(), []);
  c.assertClean();
});

test("crash-now: exited before docker port could answer → still stop boot, not infra", LIFECYCLE, async () => {
  const c = setup({ FAKE_BACKEND: "crash-now" });
  const backend = await installed(c);
  assertStop(await backend.start(), "boot", /ModuleNotFoundError[\s\S]*exited with code 1/);
  await backend.dispose();
  c.assertClean();
});

test("silent: a backend that never answers → stop health after healthMs, each probe bounded to 1 s", LIFECYCLE, async () => {
  const c = setup({ FAKE_BACKEND: "silent" });
  const backend = await installed(c, { limits: { ...SHORT, healthMs: 1_000 } });
  const t0 = performance.now();
  assertStop(await backend.start(), "health", /^no 2xx from GET \/api\/v1\/health within 1 s; last answer: TimeoutError/);
  // At least the budget; and the probe ended by its own timeout (TimeoutError),
  // where an unbounded one would hang until the case's timeout.
  const elapsed = performance.now() - t0;
  assert.ok(elapsed >= 1_000 && elapsed < 10_000, `took ${elapsed} ms`);
  await backend.dispose();
  c.assertClean();
});

test("no-health: 404 on /api/v1/health → stop health, naming the last answer", LIFECYCLE, async () => {
  const c = setup({ FAKE_BACKEND: "no-health" });
  const backend = await installed(c, { limits: { ...SHORT, healthMs: 800 } });
  assertStop(await backend.start(), "health", /within 0\.8 s; last answer: HTTP 404$/);
  assert.deepEqual(fakeContainers(c.stateDir), []);
  // A health stop's detail is the last answer, not the log: no log is read for it.
  assert.ok(!fakeCalls(c.stateDir).some((a) => a[0] === "logs"), "docker logs was read for nothing");
  await backend.dispose();
  c.assertClean();
});

test("docker inspect failing at the health deadline is infra, as in every round before it, never a health stop", LIFECYCLE, async () => {
  // One round (a 1 s probe outlasts the 0.3 s budget), then the final inspect,
  // the second, fails: counted by the fake, so no timing decides which one.
  const c = setup({ FAKE_BACKEND: "silent", FAKE_INSPECT_FAIL_AFTER: "1" });
  const backend = await installed(c, { limits: { ...SHORT, healthMs: 300, healthProbeMs: 1_000 } });
  const result = await backend.start();
  assertInfra(result, /^docker inspect agrav-backend-\S+ exit 1: Error response from daemon: fake docker: the daemon did not answer/);
  assert.equal(readFileSync(join(c.stateDir, "inspects.count"), "utf8"), "2");
  assert.deepEqual(fakeContainers(c.stateDir), [], "the container is removed all the same");
  await backend.dispose();
  c.assertClean();
});

test("servingState: running while it serves, exited with its code, vanished once the daemon no longer knows it", LIFECYCLE, async () => {
  const none = setup({ FAKE_BACKEND: "ok" });
  const idle = await installed(none);
  assert.deepEqual(await idle.servingState(), { kind: "unknown", detail: "no serving container was running" });
  await idle.dispose();
  none.assertClean();

  // exit-mid: the first request other than health kills the container, which exits 137 — an OOM kill, say.
  const exits = setup({ FAKE_BACKEND: "exit-mid" });
  const exiting = await installed(exits);
  const first = await exiting.start();
  assert.ok(first.kind === "ready", JSON.stringify(first));
  assert.deepEqual(await exiting.servingState(), { kind: "running" });
  await fetch(`${first.baseUrl}/api/v1/reset`, { method: "POST" }).then(
    () => assert.fail("the request that kills the container got an answer"),
    () => {},
  );
  assert.deepEqual(await exiting.servingState(), { kind: "exited", exitCode: 137 });
  assert.deepEqual(await exiting.stop(), { removed: true, detail: `docker rm -f ${first.container} succeeded; the daemon no longer knows container ${first.container}` });
  await exiting.dispose();
  exits.assertClean();

  // vanish-mid: the same request removes the container from the daemon, as a `docker rm -f` from outside would.
  const vanishes = setup({ FAKE_BACKEND: "vanish-mid" });
  const vanishing = await installed(vanishes);
  const second = await vanishing.start();
  assert.ok(second.kind === "ready", JSON.stringify(second));
  await fetch(`${second.baseUrl}/api/v1/reset`, { method: "POST" }).then(
    () => assert.fail("the request that removes the container got an answer"),
    () => {},
  );
  assert.deepEqual(await vanishing.servingState(), { kind: "vanished" });
  // stop() cannot tell: removing what is already gone is a proven removal.
  assert.equal((await vanishing.stop()).removed, true);
  await vanishing.dispose();
  vanishes.assertClean();
});

test("servingState: docker that cannot answer is unknown, never vanished", LIFECYCLE, async () => {
  const c = setup({ FAKE_BACKEND: "ok", FAKE_INSPECT_FAIL_AFTER: "1" });
  const backend = await installed(c);
  const started = await backend.start();
  assert.ok(started.kind === "ready", JSON.stringify(started));
  const state = await backend.servingState();
  assert.equal(state.kind, "unknown", JSON.stringify(state));
  assert.match((state as { detail: string }).detail, new RegExp(`^docker inspect ${started.container} exit 1: Error response from daemon`));
  await backend.dispose();
  c.assertClean();
});

test("install fails and the PyPI probe succeeds → stop install, ending with pip's error and the verdict", LIFECYCLE, async () => {
  const c = setup({ FAKE_INSTALL: "fail" });
  const backend = c.backend();
  const result = await backend.install();
  assertStop(result, "install", /ERROR: No matching distribution found for nopkg-fake==9\.9\n\(pip install -r requirements\.txt exited 1; the PyPI probe then succeeded, so the index was reachable\)$/);
  const runs = fakeCalls(c.stateDir).filter((a) => a[0] === "run");
  assert.deepEqual(runs.map((a) => command(a)[0]), ["-m", "install", "download"]);
  // A failed install cannot be started or frozen.
  assertInfra(await backend.start(), /needs a successful install/);
  await assert.rejects(backend.pipFreeze(), BackendInfraError);
  assert.deepEqual(await backend.dispose(), []);
  c.assertClean();
});

test("install fails and the PyPI probe hangs → the probe is killed at pypiProbeMs, and it is infra", LIFECYCLE, async () => {
  const c = setup({ FAKE_INSTALL: "fail", FAKE_PROBE: "hang" });
  const backend = c.backend({ limits: { ...SHORT, pypiProbeMs: 1_000 } });
  const t0 = performance.now();
  assertInfra(
    await backend.install(),
    /pip install -r requirements\.txt exited 1, and the PyPI probe \(pip download fastapi==0\.115\.14\) did not finish within 1 s too: PyPI looks unreachable/,
  );
  assert.ok(performance.now() - t0 < 10_000);
  // The hung probe's "container" outlived its client until the removal killed it.
  assert.equal(recordedPids(c.stateDir).length, 1);
  assert.deepEqual(survivors(c.stateDir), []);
  await backend.dispose();
  c.assertClean();
});

test("install fails and the PyPI probe fails too → infra, not the model's", LIFECYCLE, async () => {
  // `offline` outputs NewConnectionError — a network-error signature — so the
  // retry fires. Both attempts fail with the same network error, and then the
  // probe runs and fails too (PyPI unreachable), giving infra with the probe message.
  const c = setup({ FAKE_INSTALL: "offline" });
  const backend = c.backend();
  assertInfra(
    await backend.install(),
    /pip install -r requirements\.txt exited 1, and the PyPI probe \(pip download fastapi==0\.115\.14\) exited 1 too: PyPI looks unreachable/,
  );
  const installRuns = fakeCalls(c.stateDir).filter((a) => a[0] === "run" && command(a)[0] === "install");
  assert.equal(installRuns.length, 2, "two install runs (first + retry)");
  assert.ok(fakeCalls(c.stateDir).some((a) => a[0] === "run" && a.includes("download")), "the probe ran");
  await backend.dispose();
  c.assertClean();
});

test("install hangs → killed at pipInstallMs, its container removed, then stop install (probe ok)", LIFECYCLE, async () => {
  const c = setup({ FAKE_INSTALL: "hang" });
  const backend = c.backend({ limits: { ...SHORT, pipInstallMs: 1_000 } });
  const t0 = performance.now();
  assertStop(await backend.install(), "install", /\(pip install -r requirements\.txt did not finish within 1 s; the PyPI probe then succeeded/);
  assert.ok(performance.now() - t0 < 10_000);
  // The hung "container" outlived its client until the removal killed it.
  assert.equal(recordedPids(c.stateDir).length, 1);
  assert.deepEqual(survivors(c.stateDir), []);
  await backend.dispose();
  c.assertClean();
});

test("docker's own failure to run pip install (exit 125) is infra, with no PyPI probe", LIFECYCLE, async () => {
  const c = setup({ FAKE_INSTALL: "docker-error" });
  const backend = c.backend();
  assertInfra(await backend.install(), /^docker could not run pip install \(exit 125\): docker: Error response from daemon/);
  assert.ok(!fakeCalls(c.stateDir).some((a) => a[0] === "run" && a.includes("download")));
  await backend.dispose();
  c.assertClean();
});

test("a full disk under the scratch directory is infra, whatever the PyPI probe would say, and no probe runs", LIFECYCLE, async () => {
  const c = setup({ FAKE_INSTALL: "enospc" });
  const backend = c.backend();
  assertInfra(
    await backend.install(),
    /^pip install -r requirements\.txt exited 1: the disk the venv is written to is full \("ERROR: Could not install packages due to an OSError: \[Errno 28\] No space left on device: [^"]*"\); the scratch directory under \S+ is the host's, so this is not the model's failure$/,
  );
  assert.ok(!fakeCalls(c.stateDir).some((a) => a[0] === "run" && a.includes("download")), "no PyPI probe");
  await backend.dispose();
  c.assertClean();
});

test("hasNetworkError detects every documented signature and rejects ordinary pip errors", () => {
  // Positive: each signature individually.
  assert.ok(hasNetworkError("ReadTimeoutError: HTTPSConnectionPool(host='files.pythonhosted.org', port=443): Read timed out."));
  assert.ok(hasNetworkError("ConnectTimeoutError(timed out)"));
  assert.ok(hasNetworkError("Read timed out."));
  assert.ok(hasNetworkError("ProtocolError('Connection aborted.', RemoteDisconnected)"));
  assert.ok(hasNetworkError("IncompleteRead(0 bytes read)"));
  assert.ok(hasNetworkError("Connection reset by peer"));
  assert.ok(hasNetworkError("Connection aborted"));
  assert.ok(hasNetworkError("Temporary failure in name resolution"));
  assert.ok(hasNetworkError("NewConnectionError('<urllib3.connection.HTTPSConnection object>: Failed to establish a new connection')"));
  // Negative: an ordinary pip error has none.
  assert.ok(!hasNetworkError("ERROR: No matching distribution found for nopkg-fake==9.9"));
  assert.ok(!hasNetworkError("ERROR: Could not find a version that satisfies the requirement nopkg-fake==9.9 (from versions: none)"));
  assert.ok(!hasNetworkError(""));
});

test("a network error on pip install, then a successful retry → ok, no probe", LIFECYCLE, async () => {
  const c = setup({ FAKE_INSTALL: "network-then-ok" });
  const backend = c.backend();
  assert.deepEqual(await backend.install(), { kind: "ok" });
  // Two install containers ran (first failed, retry succeeded), no probe.
  const installRuns = fakeCalls(c.stateDir).filter((a) => a[0] === "run" && command(a)[0] === "install");
  assert.equal(installRuns.length, 2, `expected 2 install runs, got ${installRuns.length}`);
  assert.ok(!fakeCalls(c.stateDir).some((a) => a[0] === "run" && a.includes("download")), "no PyPI probe");
  await backend.dispose();
  c.assertClean();
});

test("a network error on pip install twice, probe ok → stop install (the model's requirement failed, not PyPI)", LIFECYCLE, async () => {
  const c = setup({ FAKE_INSTALL: "network-twice" });
  const backend = c.backend();
  assertStop(
    await backend.install(),
    "install",
    /the PyPI probe then succeeded, so the index was reachable/,
  );
  const installRuns = fakeCalls(c.stateDir).filter((a) => a[0] === "run" && command(a)[0] === "install");
  assert.equal(installRuns.length, 2, `expected 2 install runs, got ${installRuns.length}`);
  assert.ok(fakeCalls(c.stateDir).some((a) => a[0] === "run" && a.includes("download")), "the probe ran");
  await backend.dispose();
  c.assertClean();
});

test("a network error on pip install twice, probe fails → infra (PyPI looks unreachable)", LIFECYCLE, async () => {
  const c = setup({ FAKE_INSTALL: "network-twice", FAKE_PROBE: "fail" });
  const backend = c.backend();
  assertInfra(
    await backend.install(),
    /the PyPI probe \(pip download fastapi==0\.115\.14\) exited 1 too: PyPI looks unreachable/,
  );
  const installRuns = fakeCalls(c.stateDir).filter((a) => a[0] === "run" && command(a)[0] === "install");
  assert.equal(installRuns.length, 2, `expected 2 install runs, got ${installRuns.length}`);
  assert.ok(fakeCalls(c.stateDir).some((a) => a[0] === "run" && a.includes("download")), "the probe ran");
  await backend.dispose();
  c.assertClean();
});

test("a network error on pip install, then disk full on retry → infra without probe", LIFECYCLE, async () => {
  const c = setup({ FAKE_INSTALL: "network-then-enospc" });
  const backend = c.backend();
  assertInfra(
    await backend.install(),
    /the disk the venv is written to is full/,
  );
  const installRuns = fakeCalls(c.stateDir).filter((a) => a[0] === "run" && command(a)[0] === "install");
  assert.equal(installRuns.length, 2, `expected 2 install runs, got ${installRuns.length}`);
  assert.ok(!fakeCalls(c.stateDir).some((a) => a[0] === "run" && a.includes("download")), "no PyPI probe on disk full");
  await backend.dispose();
  c.assertClean();
});

test("'No matching distribution' without a network signature, probe ok → install stop (not retried)", LIFECYCLE, async () => {
  const c = setup({ FAKE_INSTALL: "fail" });
  const backend = c.backend();
  assertStop(
    await backend.install(),
    "install",
    /No matching distribution found for nopkg-fake[\s\S]*the PyPI probe then succeeded/,
  );
  // Only one install container ran (no retry) and one probe.
  const installRuns = fakeCalls(c.stateDir).filter((a) => a[0] === "run" && command(a)[0] === "install");
  assert.equal(installRuns.length, 1, "no retry without a network signature");
  assert.ok(fakeCalls(c.stateDir).some((a) => a[0] === "run" && a.includes("download")), "the probe ran");
  await backend.dispose();
  c.assertClean();
});

test("disk full is infra even when the output also contains a network error", LIFECYCLE, async () => {
  // DISK_FULL_RE is checked before the network error: a full disk is not the model's
  // regardless of whether the network was also flaky.
  const c = setup({ FAKE_INSTALL: "enospc" });
  const backend = c.backend();
  assertInfra(await backend.install(), /No space left on device/);
  assert.ok(!fakeCalls(c.stateDir).some((a) => a[0] === "run" && a.includes("download")), "no PyPI probe");
  await backend.dispose();
  c.assertClean();
});

test("a pip install client killed by a signal the harness did not send is infra, with no PyPI probe", LIFECYCLE, async () => {
  const c = setup({ FAKE_INSTALL: "client-killed" });
  const backend = c.backend();
  assertInfra(await backend.install(), /^pip install: its docker client was killed by SIGKILL, which the harness did not send$/);
  assert.ok(!fakeCalls(c.stateDir).some((a) => a[0] === "run" && a.includes("download")), "no PyPI probe");
  await backend.dispose();
  c.assertClean();
});

test("a pip install container that exits 130 was interrupted: infra, with no PyPI probe", LIFECYCLE, async () => {
  const c = setup({ FAKE_INSTALL: "interrupted" });
  const backend = c.backend();
  assertInfra(await backend.install(), /^pip install was interrupted \(SIGINT\)$/);
  assert.ok(!fakeCalls(c.stateDir).some((a) => a[0] === "run" && a.includes("download")), "no PyPI probe");
  await backend.dispose();
  c.assertClean();
});

test("install succeeds without uvicorn → stop install", LIFECYCLE, async () => {
  const c = setup({ FAKE_INSTALL: "no-uvicorn" });
  const backend = c.backend();
  assertStop(await backend.install(), "install", /no bin\/uvicorn: requirements\.txt does not install uvicorn$/);
  // No probe: pip succeeded, so the index is not in question.
  assert.ok(!fakeCalls(c.stateDir).some((a) => a[0] === "run" && a.includes("download")));
  await backend.dispose();
  c.assertClean();
});

test("layout: a missing app/main.py is a stop before any container or scratch directory", LIFECYCLE, async () => {
  const c = setup({}, "no-main");
  const backend = c.backend();
  const expected = { kind: "stop", stage: "layout", detail: "missing: backend/app/main.py (the run contract needs backend/requirements.txt and backend/app/main.py)" };
  assert.deepEqual(backend.checkLayout(), expected);
  assert.deepEqual(await backend.install(), expected);
  assert.deepEqual(fakeCalls(c.stateDir), [], "docker was never called");
  assert.deepEqual(scratchDirs(c), []);
  assert.deepEqual(await backend.dispose(), []);
  c.assertClean();
});

test("layout: no backend/ at all, or backend/ as a symlink, is a layout stop; a missing attempt is infra", LIFECYCLE, async () => {
  const noBackend = setup({}, "no-backend");
  assertStop(await noBackend.backend().install(), "layout", /^backend\/ is missing/);
  noBackend.assertClean();
  const symlink = setup({}, "symlink");
  assertStop(await symlink.backend().install(), "layout", /symbolic link/);
  symlink.assertClean();
  const missing = setup();
  rmSync(missing.attemptDir, { recursive: true });
  assertInfra(await missing.backend().install(), /does not exist/);
  missing.assertClean();
  for (const c of [noBackend, symlink, missing]) assert.deepEqual(fakeCalls(c.stateDir), []);
});

test("a failing python3 -m venv is infra, and nothing is left", LIFECYCLE, async () => {
  const c = setup({ FAKE_VENV: "fail" });
  const backend = c.backend();
  assertInfra(await backend.install(), /Permission denied[\s\S]*python3 -m venv exited 1; the venv is the harness's/);
  assert.equal(fakeCalls(c.stateDir).filter((a) => a[0] === "run").length, 1, "no pip install after a failed venv");
  await backend.dispose();
  c.assertClean();
});

test("docker run -d failing on a taken port is infra, and the created container is removed", LIFECYCLE, async () => {
  const c = setup({ FAKE_RUN_D: "port-busy" });
  const backend = await installed(c, { hostPort: 5100 });
  assertInfra(await backend.start(), /port is already allocated[\s\S]*host port 5100 is taken/);
  assert.deepEqual(fakeContainers(c.stateDir), []);
  await backend.dispose();
  c.assertClean();
});

test("a removal the daemon will not confirm is reported, kept registered, and retried by dispose", LIFECYCLE, async () => {
  const c = setup({ FAKE_BACKEND: "ok" });
  const backend = await installed(c);
  const started = await backend.start();
  assert.ok(started.kind === "ready");
  process.env.FAKE_RM = "fail";
  const removal = await backend.stop();
  assert.equal(removal.removed, false);
  assert.match(removal.detail, /harness fault, not the model's/);
  const kept = await backend.dispose();
  assert.equal(kept.length, 1);
  assert.equal(kept[0].removed, false);
  assert.equal(scratchDirs(c).length, 1, "the scratch directory stays while a container may mount it");
  delete process.env.FAKE_RM;
  assert.deepEqual((await backend.dispose()).map((r) => r.removed), [true]);
  c.assertClean();
});

test("a removal failing during install is infra", LIFECYCLE, async () => {
  const c = setup({ FAKE_RM: "fail" });
  const backend = c.backend();
  assertInfra(await backend.install(), /python3 -m venv: .*would not confirm/);
  delete process.env.FAKE_RM;
  await backend.dispose();
  c.assertClean();
});

test("stopAllBackendsSync removes a registered running container and its scratch directory", LIFECYCLE, async () => {
  const c = setup({ FAKE_BACKEND: "ok" });
  const backend = await installed(c);
  const started = await backend.start();
  assert.ok(started.kind === "ready");
  assert.equal(survivors(c.stateDir).length, 1);
  stopAllBackendsSync();
  c.assertClean();
  // A backend stopped this way starts nothing again.
  assertInfra(await backend.start(), /shut down/);
  assert.deepEqual(fakeContainers(c.stateDir), []);
});

test("stopAllBackends during a hung install kills the client, removes the container and starts no probe", LIFECYCLE, async () => {
  const c = setup({ FAKE_INSTALL: "hang" });
  const backend = c.backend({ limits: { ...SHORT, pipInstallMs: 60_000 } });
  const pending = backend.install();
  // Until the hung "container" runs: the install container's record names the
  // sleeper the fake recorded, so the removal kills it. A fixed pause could end
  // before that on a loaded machine, and the sleeper would outlive the removal
  // by up to its watch interval, long enough for assertClean to find it.
  const deadline = Date.now() + 10_000;
  for (;;) {
    const run = fakeCalls(c.stateDir).find((a) => a[0] === "run" && command(a)[0] === "install");
    const name = run === undefined ? undefined : run[run.indexOf("--name") + 1];
    const pid = name === undefined ? undefined : fakeRecord(c.stateDir, name)?.pid;
    if (typeof pid === "number" && recordedPids(c.stateDir).some((p) => p.pid === pid)) break;
    assert.ok(Date.now() < deadline, "the hung install container never started");
    await pause(20);
  }
  await stopAllBackends();
  assertInfra(await pending, /shut down while installing/);
  assert.ok(!fakeCalls(c.stateDir).some((a) => a[0] === "run" && a.includes("download")), "no probe after shutdown");
  c.assertClean();
});

test("the dead-owner sweep recognises this module's containers and scratch directories", LIFECYCLE, async () => {
  const c = setup({ FAKE_BACKEND: "ok" });
  const backend = await installed(c);
  const started = await backend.start();
  assert.ok(started.kind === "ready");
  // With the owner reported dead, the sweep finds exactly what a SIGKILL would have left.
  const swept = sweepDeadOwners({ role: "backend", tmpRoot: c.tmpRoot, isAlive: () => false, run: fakeDockerRun });
  assert.deepEqual(swept.failed, []);
  assert.deepEqual(swept.removedContainers, [started.container]);
  assert.equal(swept.removedDirs.length, 1);
  c.assertClean();
  await backend.dispose();
});

test("pipFreeze and start refuse before a successful install", LIFECYCLE, async () => {
  const c = setup();
  const backend = c.backend();
  await assert.rejects(backend.pipFreeze(), /needs a successful install/);
  assertInfra(await backend.start(), /needs a successful install/);
  assert.deepEqual(fakeCalls(c.stateDir), []);
});

test("the sweep removes a scratch directory made by install() itself, once its owner is dead, and not before", LIFECYCLE, async () => {
  const c = setup({ FAKE_INSTALL: "ok" });
  const backend = await installed(c);
  const [dir] = scratchDirs(c);
  // Made through scratchDirPrefix, so it is exactly what SCRATCH_DIR_RE matches.
  assert.ok(dir.startsWith(scratchDirPrefix(process.pid)), dir);
  assert.equal(Number(SCRATCH_DIR_RE.exec(dir)?.[1]), process.pid);
  assert.deepEqual(fakeContainers(c.stateDir), [], "the install's containers are gone; only the directory is left");

  const alive = sweepDeadOwners({ role: "backend", tmpRoot: c.tmpRoot, isAlive: () => true, run: fakeDockerRun });
  assert.deepEqual(alive, { removedContainers: [], removedDirs: [], failed: [] });
  assert.deepEqual(scratchDirs(c), [dir]);

  const dead = sweepDeadOwners({ role: "backend", tmpRoot: c.tmpRoot, isAlive: (pid) => pid !== process.pid, run: fakeDockerRun });
  assert.deepEqual(dead, { removedContainers: [], removedDirs: [join(c.tmpRoot, dir)], failed: [] });
  c.assertClean();
  assert.deepEqual(await backend.dispose(), []);
});

test("a backend stop-all reaches before its install starts nothing: install() and start() are infra 'shut down'", LIFECYCLE, async () => {
  const c = setup();
  const backend = c.backend();
  await stopAllBackends();
  assertInfra(await backend.install(), /shut down while installing/);
  assertInfra(await backend.start(), /shut down/);
  assert.deepEqual(fakeCalls(c.stateDir), [], "no docker call at all");
  c.assertClean();

  // The same through the exit listener's synchronous stop-all.
  const d = setup();
  const other = d.backend();
  stopAllBackendsSync();
  assertInfra(await other.install(), /shut down while installing/);
  assert.deepEqual(fakeCalls(d.stateDir), []);
  d.assertClean();
});

test("a shutdown between the install client's exit and its close is infra 'shut down', never a model stop", LIFECYCLE, async () => {
  // The client exits at once, but a grandchild holds its stdout open until
  // the container is removed (20 s at most): its `close`, which resumes
  // install(), can only come after the shutdown has removed the container and
  // the scratch directory — where a missing bin/uvicorn would read as the
  // model's. No timer decides the order.
  const c = setup({ FAKE_INSTALL: "ok", FAKE_CLIENT_LINGER_MS: "20000" });
  const backend = c.backend();
  let settled = false;
  const pending = backend.install().finally(() => (settled = true));
  const deadline = Date.now() + 10_000;
  for (;;) {
    const run = fakeCalls(c.stateDir).find((a) => a[0] === "run" && command(a)[0] === "install");
    const name = run === undefined ? undefined : run[run.indexOf("--name") + 1];
    if (name !== undefined && fakeRecord(c.stateDir, name)?.status === "exited") break;
    assert.ok(Date.now() < deadline, "the install client never finished");
    await pause(20);
  }
  // The client's exit has reached this process by now; its close cannot have.
  // (Should the exit be late, the shutdown waits for it: the same outcome.)
  await pause(300);
  await stopAllBackends();
  assert.equal(settled, false, "install() resumed before the shutdown; the race was not reproduced");
  assert.deepEqual(scratchDirs(c), [], "the shutdown removed the scratch directory under the pending step");
  assertInfra(await pending, /shut down while installing/);
  c.assertClean();
});

test("dispose during the health wait: start() is infra 'shut down', never a health stop, and nothing is left", LIFECYCLE, async () => {
  const c = setup({ FAKE_BACKEND: "silent" });
  const backend = await installed(c, { limits: { ...SHORT, healthMs: 20_000 } });
  const pending = backend.start();
  const deadline = Date.now() + 10_000;
  for (;;) {
    const run = fakeCalls(c.stateDir).find((a) => a[0] === "run" && a.includes("-d"));
    const name = run === undefined ? undefined : run[run.indexOf("--name") + 1];
    if (name !== undefined && fakeCalls(c.stateDir).some((a) => a[0] === "inspect" && a.at(-1) === name)) break;
    assert.ok(Date.now() < deadline, "the health wait never began");
    await pause(20);
  }
  await pause(300); // inside a probe the silent backend never answers
  const t0 = performance.now();
  const removals = await backend.dispose();
  assert.ok(removals.length === 1 && removals[0].removed, JSON.stringify(removals));
  assertInfra(await pending, /shut down while waiting for \/api\/v1\/health/);
  assert.ok(performance.now() - t0 < 10_000, "the pending probe did not hold start() for its whole 20 s budget");
  c.assertClean();
});

test("healthProbeMs and healthPollMs come from the limits, like every number that decides a stop", LIFECYCLE, async () => {
  // A probe bound longer than the whole health budget: the first probe of a
  // silent backend alone outlasts it.
  const silent = setup({ FAKE_BACKEND: "silent" });
  const slowProbe = await installed(silent, { limits: { ...SHORT, healthMs: 300, healthProbeMs: 2_500 } });
  const t0 = performance.now();
  assertStop(await slowProbe.start(), "health", /within 0\.3 s; last answer: TimeoutError/);
  const elapsed = performance.now() - t0;
  assert.ok(elapsed >= 2_400, `a 2.5 s probe returned after ${elapsed} ms`);
  await slowProbe.dispose();
  silent.assertClean();

  // A 2.5 s poll interval: one 404, then the 200 to a second probe sent no
  // sooner than 2.5 s after the first, where the default 200 ms would have
  // sent it almost at once.
  const polled = setup({ FAKE_BACKEND: "ok", FAKE_HEALTH_404_FIRST: "1" });
  const backend = await installed(polled, { limits: { ...SHORT, healthMs: 20_000, healthPollMs: 2_500 } });
  const t1 = performance.now();
  const started = await backend.start();
  const waited = performance.now() - t1;
  assert.ok(started.kind === "ready", JSON.stringify(started));
  const log = readFileSync(join(polled.stateDir, "containers", `${started.container}.log`), "utf8");
  const probes = log.match(/GET \/api\/v1\/health/g) ?? [];
  assert.ok(probes.length >= 2, `probed ${probes.length} times`);
  assert.ok(waited >= 2_400, `ready after ${waited} ms, with a 2.5 s pause between two probes`);
  await backend.dispose();
  polled.assertClean();
});

test("the backend runs by image Id, as its callers pass it; an image the daemon does not have is infra", LIFECYCLE, async () => {
  const c = setup({ FAKE_BACKEND: "ok" });
  const backend = await installed(c, { image: IMAGE_ID });
  const started = await backend.start();
  assert.equal(started.kind, "ready", JSON.stringify(started));
  const runs = fakeCalls(c.stateDir).filter((a) => a[0] === "run");
  assert.equal(runs.length, 3, "venv, install, serve");
  // The image is the argument right after --entrypoint's value, in every container.
  for (const argv of runs) assert.equal(argv[argv.indexOf("--entrypoint") + 2], IMAGE_ID, argv.join(" "));
  await backend.dispose();
  c.assertClean();

  const missing = setup();
  const absent = missing.backend({ image: `sha256:${"0".repeat(64)}` });
  assertInfra(await absent.install(), /^docker could not run python3 -m venv \(exit 125\): [\s\S]*No such image/);
  assert.deepEqual(await absent.dispose(), []);
  missing.assertClean();
});

// ---------------------------------------------------------------------------
// after the suite: nothing pending reaches a real daemon

const LEAK_FIXTURE = join(ROOT, "test", "fixtures", "fake-docker-backend-leak.fixture.ts");

/** `node <args>` from the repository root; SIGKILLed through its own handle if it outlives `timeoutMs`. */
function runNode(args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number | null; output: string }> {
  const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

test("docker work still pending after the hooks meets a refusal, never the machine's client, and re-creates nothing", { timeout: 60_000 }, async () => {
  // The fixture is a suite with these hooks and one test that leaves a hung
  // install's client polling and two `docker` calls waiting for the hooks to
  // finish — what a failing lifecycle test leaves behind. `sentinel/docker`
  // stands in for the machine's client, first on the PATH the suite starts from.
  const dir = mkdtempSync(join(tmpdir(), "attempt-backend-leak-"));
  try {
    const sentinel = join(dir, "sentinel");
    const sentinelLog = join(dir, "sentinel.log");
    const tmp = join(dir, "tmp");
    const report = join(dir, "report.json");
    mkdirSync(sentinel);
    mkdirSync(tmp);
    writeFileSync(join(sentinel, "docker"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${sentinelLog}'\n`, { mode: 0o755 });
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("FAKE_") || key === "NODE_TEST_CONTEXT") delete env[key];
    Object.assign(env, { PATH: `${sentinel}${delimiter}${hooks.originalPath}`, TMPDIR: tmp, LEAK_REPORT: report });

    const run = await runNode(["--test", "--test-reporter=tap", "--import", "tsx", LEAK_FIXTURE], env, 45_000);
    assert.match(run.output, /^# pass 1$/m, run.output);
    assert.ok(
      !existsSync(sentinelLog),
      `the machine's docker was called after the hooks: ${existsSync(sentinelLog) ? readFileSync(sentinelLog, "utf8") : ""}`,
    );
    assert.ok(existsSync(report), `the pending work never reported:\n${run.output}`);
    const r = JSON.parse(readFileSync(report, "utf8")) as {
      error?: string;
      rootAfterHooks: boolean;
      sync: { code: number | null; stderr: string };
      async: { code: number | null; stderr: string };
      client: number | string | null;
      rootRecreated: boolean;
    };
    assert.equal(r.error, undefined, `the pending work failed: ${r.error}`);
    assert.equal(r.rootAfterHooks, false, "the hooks removed the scratch root before the pending work resumed");
    for (const [label, call] of [["spawnSync", r.sync], ["spawn", r.async]] as const) {
      assert.equal(call.code, 125, `${label}: ${JSON.stringify(call)}`);
      assert.match(call.stderr, /^docker refused: /, label);
    }
    // The hung client saw its record go with the state directory, and left it gone.
    assert.equal(r.client, 137);
    assert.equal(r.rootRecreated, false, "a pending fake client re-created the removed state directory");
    // (tsx keeps its own cache there too.)
    assert.deepEqual(readdirSync(tmp).filter((e) => e.startsWith("attempt-backend-leak-")), [], "the fixture's scratch root is gone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the after hook's switch to the refuser is proven: a refuser that does not answer puts the fake first again", () => {
  const saved = process.env.PATH;
  const dir = mkdtempSync(join(tmpdir(), "attempt-backend-refuser-"));
  try {
    // `sentinel/docker` stands in for the machine's client, after the refuser on PATH.
    const sentinel = join(dir, "sentinel");
    const sentinelLog = join(dir, "sentinel.log");
    mkdirSync(sentinel);
    writeFileSync(join(sentinel, "docker"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${sentinelLog}'\n`, { mode: 0o755 });
    // The fake is `#!/usr/bin/env node`: node stays reachable, after the sentinel.
    const originalPath = `${sentinel}${delimiter}${dirname(process.execPath)}`;

    assert.equal(switchToRefusedDocker(originalPath), null, "the committed refuser answers");
    const refused = spawnSync("docker", ["ps"], { encoding: "utf8", timeout: 10_000 });
    assert.equal(refused.status, 125);
    assert.match(refused.stderr, /^docker refused: /);
    assert.equal(existsSync(sentinelLog), false);

    // A refuser that lost its executable bit: the search falls through to the sentinel.
    const broken = join(dir, "refuser");
    mkdirSync(broken);
    writeFileSync(join(broken, "docker"), readFileSync(join(ROOT, "test", "fixtures", "docker-refused", "docker")), { mode: 0o644 });
    const failure = switchToRefusedDocker(originalPath, broken);
    assert.match(failure ?? "", /did not answer as .*refuser\/docker after the suite.*is first on PATH again/);
    assert.equal(process.env.PATH, `${FAKE_DOCKER_DIR}${delimiter}${originalPath}`);
    assert.equal(spawnSync("docker", ["--fake-identity"], { encoding: "utf8", timeout: 10_000 }).stdout.trim(), "fake-docker-backend");
    assert.deepEqual(readFileSync(sentinelLog, "utf8").split("\n").filter((l) => l !== ""), ["--probe"], "only the probe reached it");
  } finally {
    process.env.PATH = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});
