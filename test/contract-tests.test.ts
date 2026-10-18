/**
 * `scripts/contract-tests.ts`.
 *
 * Orchestration first, in process: `runContractTests` with a scripted fake
 * backend and a fake `runFile`, so every branch — restarts, stops, refusals,
 * budgets, harness faults, interruption — is exercised without docker, git or
 * the hidden tests. Then the CLI end to end: the real `AttemptBackend` and the
 * real hidden tests, driven through the stateful fake docker
 * (`test/fixtures/fake-docker-backend/docker`) put first on the child's PATH;
 * the fake's "backend" answers only `/api/v1/health`, so every hidden test
 * fails, which is all these tests need. After every end-to-end case no fake
 * container, fake server process or `agrav-backend-*` scratch directory is left.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  parseArgs,
  REPO_ROOT,
  runContractTests,
  testsProvenance,
  type ContractBackend,
  type ContractTestsDeps,
  type ContractTestsOptions,
  type ContractTestsOutcome,
} from "../scripts/contract-tests";
import type { BackendOptions, ContainerRemoval, ServingState, StartResult, StepResult } from "../scripts/lib/attempt-backend";
import { BackendInfraError } from "../scripts/lib/attempt-backend";
import {
  CONTRACT_RESULTS_FILE,
  EMPTY_STOP_DETAIL,
  loadManifest,
  readContractResults,
  stoppedGroups,
  type ContractResults,
  type ManifestEntry,
} from "../scripts/lib/contract-results";
import { ContractHarnessError, type ContractFileResult, type RunContractFileOptions } from "../scripts/lib/contract-suite";
import { resolveImageId } from "../scripts/lib/docker";
import { LIMITS, rubricId } from "../scripts/lib/rubric";
import { writeRunJson, type RunJson } from "../scripts/lib/run-json";
import { readScoringImage } from "../scripts/lib/runner-config";
import { killSurvivors, survivors } from "./fixtures/fake-docker-backend-pids";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "scripts", "contract-tests.ts");
const FAKE_DIR = fileURLToPath(new URL("./fixtures/fake-docker-backend/", import.meta.url));
/** The fake's path as a client's argv names it (PATH lookup may double a slash). */
const FAKE_DOCKER = join(FAKE_DIR, "docker");
const MANIFEST = loadManifest(ROOT);
const ATTEMPT = "demo-attempt-1";
const TAG = "agrav-bench/harness:2026-09-18";
const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const REF = `${TAG}@${IMAGE_ID}`;
/** What the fake docker's `image inspect` answers, end to end. */
const FAKE_IMAGE_ID = `sha256:${"f".repeat(64)}`;
const TESTS_DIR = join(ROOT, "benchmark", "contract-tests");
const PROVENANCE = { testsCommit: "c".repeat(40), testsDirty: false };
const FREEZE = ["fastapi==0.115.14", "uvicorn==0.30.6"];
const OK: StepResult = { kind: "ok" };
const REMOVED: ContainerRemoval = { removed: true, detail: "removed" };
const NOT_REMOVED: ContainerRemoval = { removed: false, detail: "agrav-backend-demo could not be proven removed; a harness fault" };

const scratch: string[] = [];
/** The fake docker's state directories, whose `pids.log` names every process a fake container ran as. */
const fakeStates: string[] = [];
/** Every CLI whose `close` has not arrived: its pid, which is also its process group's id → its start time, `null` if unread. */
const openClis = new Map<number, bigint | null>();
after(async () => {
  // A CLI that hung past its test's timeout must not outlive the suite. Only
  // what provably is its group's is killed (ourGroupMembers) — never the group
  // id as such, which a reused pid could by now lead — until none is left.
  for (const [pid, start] of openClis) {
    if (start === null) continue; // never proven ours
    for (let round = 0; round < 20; round++) {
      const members = ourGroupMembers(pid, start);
      if (members.length === 0) break;
      for (const member of members) {
        try {
          process.kill(member, "SIGKILL");
        } catch {
          // gone in the meantime
        }
      }
      await new Promise((done) => setTimeout(done, 50));
    }
  }
  // A failing end-to-end case can leave a fake server running: reap every one
  // the fake recorded — only while its start time still matches the record,
  // so a reused pid is never touched.
  for (const stateDir of fakeStates) killSurvivors(stateDir);
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// in-process fakes

interface Script {
  layout?: StepResult;
  install?: StepResult;
  freeze?: string[] | Error;
  /** Consumed in order; once empty, every start is ready. */
  starts?: StartResult[];
  /** Consumed in order; once empty, every removal is proven. */
  stops?: ContainerRemoval[];
  /** What `servingState` answers after each file, consumed in order; once empty, `running`. */
  serving?: ServingState[];
  dispose?: ContainerRemoval[] | Error;
  onInstall?: () => void;
}

const ready = (n: number): StartResult => ({ kind: "ready", baseUrl: `http://127.0.0.1:${41000 + n}`, container: `agrav-backend-${ATTEMPT}-1-${n}` });

class FakeBackend implements ContractBackend {
  readonly calls: string[] = [];
  /** The call before each `servingState`: kept apart from `calls`, whose sequences the tests pin. */
  readonly servingAsked: Array<string | undefined> = [];
  private started = 0;
  constructor(
    readonly options: BackendOptions,
    private readonly script: Script,
  ) {}
  checkLayout(): StepResult {
    this.calls.push("checkLayout");
    return this.script.layout ?? OK;
  }
  async install(): Promise<StepResult> {
    this.calls.push("install");
    this.script.onInstall?.();
    return this.script.install ?? OK;
  }
  async pipFreeze(): Promise<string[]> {
    this.calls.push("pipFreeze");
    const freeze = this.script.freeze ?? FREEZE;
    if (freeze instanceof Error) throw freeze;
    return [...freeze];
  }
  async start(): Promise<StartResult> {
    this.calls.push("start");
    this.started += 1;
    return this.script.starts?.shift() ?? ready(this.started);
  }
  async servingState(): Promise<ServingState> {
    this.servingAsked.push(this.calls.at(-1));
    return this.script.serving?.shift() ?? { kind: "running" };
  }
  async stop(): Promise<ContainerRemoval> {
    this.calls.push("stop");
    return this.script.stops?.shift() ?? REMOVED;
  }
  async dispose(): Promise<ContainerRemoval[]> {
    this.calls.push("dispose");
    const dispose = this.script.dispose ?? [];
    if (dispose instanceof Error) throw dispose;
    return dispose;
  }
}

function entryOf(file: string): ManifestEntry {
  const entry = MANIFEST.find((e) => file === join(ROOT, "benchmark", "contract-tests", e.file));
  assert.ok(entry, `runFile got a file outside the manifest: ${file}`);
  return entry;
}

type FileOutcome = (entry: ManifestEntry, options: RunContractFileOptions) => ContractFileResult;

const passesAll: FileOutcome = (entry, options) => ({
  file: options.file,
  total: entry.tests,
  passed: entry.tests,
  failed: [],
  notRun: 0,
  hookFailed: 0,
  timedOut: false,
});

/** 20 of 24 on the API file, every other file clean. */
const typical: FileOutcome = (entry, options) => {
  if (entry.file !== "api-contract.test.ts") return passesAll(entry, options);
  const failed = [1, 2, 3, 4].map((i) => ({ name: `api test ${i}`, failureType: "testCodeFailure", message: `GET /parts answered 500: ${i}` }));
  return { ...passesAll(entry, options), passed: 20, failed };
};

interface Harness {
  deps: Partial<ContractTestsDeps>;
  backends: FakeBackend[];
  files: RunContractFileOptions[];
  out: string[];
}

function harness(script: Script = {}, outcome: FileOutcome = passesAll, extra: Partial<ContractTestsDeps> = {}): Harness {
  const h: Harness = { deps: {}, backends: [], files: [], out: [] };
  h.deps = {
    createBackend: (options) => {
      const backend = new FakeBackend(options, script);
      h.backends.push(backend);
      return backend;
    },
    runFile: async (options) => {
      h.files.push(options);
      return outcome(entryOf(options.file), options);
    },
    image: () => ({ tag: TAG, ref: REF, id: IMAGE_ID }),
    gate: () => ({ recorded: "f".repeat(64), current: "f".repeat(64) }),
    provenance: () => PROVENANCE,
    out: (line) => h.out.push(line),
    ...extra,
  };
  return h;
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

/** A --root with the attempt directory and, unless `null`, its run.json. */
function scoringRoot(run: RunJson | null = runJson()): string {
  const root = tempDir("agrav-contract-tests-root-");
  mkdirSync(join(root, "eval-attempts", ATTEMPT), { recursive: true });
  if (run !== null) writeRunJson(join(root, "eval-results", ATTEMPT, "run.json"), run);
  return root;
}

function options(root: string, overrides: Partial<ContractTestsOptions> = {}): ContractTestsOptions {
  return { attempt: ATTEMPT, root, ignoreRunJson: false, allowUngated: false, ...overrides };
}

const resultPath = (root: string): string => join(root, "eval-results", ATTEMPT, CONTRACT_RESULTS_FILE);

function written(outcome: ContractTestsOutcome, root: string): ContractResults {
  assert.equal(outcome.kind, "written", `expected a written result, got ${JSON.stringify(outcome)}`);
  const onDisk = readContractResults(resultPath(root));
  assert.deepEqual(onDisk, (outcome as { results: ContractResults }).results);
  return onDisk;
}

/** `kind`, and no contract-results.json — or, with `previous`, the earlier one byte for byte. */
function notWritten(outcome: ContractTestsOutcome, root: string, kind: "refused" | "infra" | "interrupted", previous?: string): string {
  assert.equal(outcome.kind, kind, `expected ${kind}, got ${JSON.stringify(outcome)}`);
  if (previous === undefined) assert.ok(!existsSync(resultPath(root)), "nothing may be written");
  else assert.equal(readFileSync(resultPath(root), "utf8"), previous, "the earlier result must be left as it was");
  return outcome.kind === "refused" || outcome.kind === "infra" ? outcome.message : "";
}

// ---------------------------------------------------------------------------
// the clean run

test("a clean run installs once, starts a fresh container per file, and writes a valid result", async () => {
  const root = scoringRoot();
  const h = harness({}, typical);
  const results = written(await runContractTests(options(root), h.deps), root);

  assert.equal(h.backends.length, 1);
  const [backend] = h.backends;
  assert.deepEqual(backend.calls, ["checkLayout", "install", "pipFreeze", "start", "stop", "start", "stop", "start", "stop", "start", "stop", "dispose"]);
  // Run by the bare Id, never the tag; recorded as <tag>@<Id>.
  assert.deepEqual(backend.options, { attemptDir: join(root, "eval-attempts", ATTEMPT), attemptName: ATTEMPT, image: IMAGE_ID, hostPort: "ephemeral" });

  // Each file runs once, from the repository, against the container started for it.
  assert.deepEqual(
    h.files.map((f) => [f.file, f.baseUrl, f.seedPath, f.timeoutMs, f.expectedTests]),
    MANIFEST.map((entry, i) => [
      join(ROOT, "benchmark", "contract-tests", entry.file),
      `http://127.0.0.1:${41001 + i}`,
      join(ROOT, "benchmark", "context", "seed.json"),
      LIMITS.fileMs,
      entry.tests,
    ]),
  );

  assert.equal(results.attempt, ATTEMPT);
  assert.equal(results.image, REF);
  assert.equal(results.runImage, REF);
  assert.deepEqual(results.warnings, []);
  assert.equal(results.rubric, rubricId(ROOT));
  assert.equal(results.testsCommit, PROVENANCE.testsCommit);
  assert.equal(results.testsDirty, false);
  assert.equal(results.ungated, false);
  assert.deepEqual(results.pipFreeze, FREEZE);
  assert.deepEqual(results.boot, { ok: true, stage: null, detail: null });
  assert.equal(results.diagnosis, null);
  assert.deepEqual(results.groups.map((g) => [g.row, g.passed, g.total, g.score]), [
    ["API contract", 20, 24, 1.67],
    ["Planner: assignment rules", 12, 12, 2],
    ["Planner: ordering & determinism", 11, 11, 1],
    ["Planner: parts & blocking", 11, 11, 2],
  ]);
  assert.ok(Number.isInteger(results.durationMs) && results.durationMs >= 0);
  assert.ok(Date.now() - Date.parse(results.startedAt) < 60_000);

  // One summary line per group, then where it went.
  for (const row of ["API contract: 20/24 passed, 1.67/2", "Planner: assignment rules: 12/12 passed, 2/2"]) {
    assert.ok(h.out.some((line) => line.includes(row)), `no summary line with ${row}:\n${h.out.join("\n")}`);
  }
  assert.equal(h.out.at(-1), `wrote ${resultPath(root)}`);
});

test("a failed run leaves an earlier result exactly as it was", async () => {
  const root = scoringRoot();
  written(await runContractTests(options(root), harness({}, typical).deps), root);
  const previous = readFileSync(resultPath(root), "utf8");
  const h = harness({ starts: [ready(1), { kind: "infra", detail: "docker run -d exit 125" }] });
  notWritten(await runContractTests(options(root), h.deps), root, "infra", previous);
});

// ---------------------------------------------------------------------------
// restarts and backend stops

test("a restart that fails is retried once, then that file alone scores 0 and boot stays ok", async () => {
  const root = scoringRoot();
  const h = harness({
    starts: [
      ready(1),
      { kind: "stop", stage: "health", detail: "no 2xx from GET /api/v1/health within 60 s; last answer: HTTP 503" },
      { kind: "stop", stage: "boot", detail: "Traceback (most recent call last):\nMemoryError\n(the container exited with code 1 before GET /api/v1/health answered)" },
    ],
  });
  const results = written(await runContractTests(options(root), h.deps), root);

  const [backend] = h.backends;
  assert.deepEqual(backend.calls, ["checkLayout", "install", "pipFreeze", "start", "stop", "start", "start", "start", "stop", "start", "stop", "dispose"]);
  assert.deepEqual(h.files.map((f) => entryOf(f.file).file), ["api-contract.test.ts", "planner-ordering.test.ts", "planner-parts.test.ts"]);
  assert.deepEqual(results.boot, { ok: true, stage: null, detail: null });
  const restarted = results.groups[1];
  assert.equal(restarted.row, "Planner: assignment rules");
  assert.deepEqual([restarted.passed, restarted.notRun, restarted.score, restarted.failed.length], [0, 12, 0, 0]);
  assert.match(restarted.detail ?? "", /MemoryError/, "the last failure's own output");
  assert.match(restarted.detail ?? "", /planner-assignment\.test\.ts: 2 starts, the last a boot failure\)$/);
  assert.deepEqual(results.groups.map((g) => g.score), [2, 0, 1, 2]);
});

test("a restart that fails once and then comes up runs its file", async () => {
  const root = scoringRoot();
  const h = harness({ starts: [ready(1), { kind: "stop", stage: "boot", detail: "exited 1" }, ready(3)] });
  const results = written(await runContractTests(options(root), h.deps), root);
  assert.equal(h.backends[0].calls.filter((c) => c === "start").length, 5);
  assert.equal(h.files.length, 4);
  assert.deepEqual(h.files.map((f) => f.baseUrl).slice(0, 2), ["http://127.0.0.1:41001", "http://127.0.0.1:41003"]);
  assert.deepEqual(results.groups.map((g) => [g.score, g.detail]), MANIFEST.map((e) => [e.max, null]));
});

for (const stage of ["boot", "health"] as const) {
  test(`a first start that fails (${stage}) is the backend stop: no retry, all four groups zero, the result written`, async () => {
    const root = scoringRoot();
    const detail = `${stage} failed here`;
    const h = harness({ starts: [{ kind: "stop", stage, detail }] });
    const results = written(await runContractTests(options(root), h.deps), root);
    assert.deepEqual(h.backends[0].calls, ["checkLayout", "install", "pipFreeze", "start", "dispose"]);
    assert.equal(h.files.length, 0);
    assert.deepEqual(results.boot, { ok: false, stage, detail });
    assert.deepEqual(results.groups, stoppedGroups(MANIFEST));
    assert.deepEqual(results.pipFreeze, FREEZE, "the install happened, so its freeze is recorded");
    assert.equal(results.diagnosis, null);
  });
}

for (const [label, empty] of [["empty", ""], ["whitespace-only", " \n\t "]]) {
  test(`a boot stop whose logs are ${label} is written as the model's stop, never infra`, async () => {
    const root = scoringRoot();
    const h = harness({ starts: [{ kind: "stop", stage: "boot", detail: empty }] });
    const results = written(await runContractTests(options(root), h.deps), root);
    assert.deepEqual(results.boot, { ok: false, stage: "boot", detail: EMPTY_STOP_DETAIL });
    assert.deepEqual(results.groups, stoppedGroups(MANIFEST));
    assert.ok(h.out.includes(`backend stop (boot): ${EMPTY_STOP_DETAIL}`), h.out.join("\n"));
  });
}

test("a layout stop writes the result without installing anything", async () => {
  const root = scoringRoot();
  const detail = "missing: backend/app/main.py (the run contract needs backend/requirements.txt and backend/app/main.py)";
  const h = harness({ layout: { kind: "stop", stage: "layout", detail } });
  const results = written(await runContractTests(options(root), h.deps), root);
  assert.deepEqual(h.backends[0].calls, ["checkLayout", "dispose"]);
  assert.deepEqual(results.boot, { ok: false, stage: "layout", detail });
  assert.deepEqual(results.pipFreeze, []);
  assert.deepEqual(results.groups, stoppedGroups(MANIFEST));
});

test("an install stop writes the result with no pip freeze", async () => {
  const root = scoringRoot();
  const detail = "ERROR: No matching distribution found for nopkg==9.9\n(pip install -r requirements.txt exited 1; the PyPI probe then succeeded, so the index was reachable)";
  const h = harness({ install: { kind: "stop", stage: "install", detail } });
  const results = written(await runContractTests(options(root), h.deps), root);
  assert.deepEqual(h.backends[0].calls, ["checkLayout", "install", "dispose"]);
  assert.deepEqual(results.boot, { ok: false, stage: "install", detail });
  assert.deepEqual(results.pipFreeze, []);
});

test("a file cut short by its own per-file timer scores its unfinished tests as failed, not as infra", async () => {
  const root = scoringRoot();
  const h = harness({}, (entry, o) =>
    entry.file === "planner-ordering.test.ts" ? { ...passesAll(entry, o), passed: 3, notRun: 8, timedOut: true } : passesAll(entry, o),
  );
  const results = written(await runContractTests(options(root), h.deps), root);
  const ordering = results.groups[2];
  assert.deepEqual([ordering.passed, ordering.notRun, ordering.timedOut, ordering.score], [3, 8, true, 0.27]);
  assert.ok(h.out.some((line) => line.includes("timed out after 3 tests")));
});

// ---------------------------------------------------------------------------
// harness faults: nothing written, the backend disposed

const INFRA_CASES: Array<[string, Script, FileOutcome?, RegExp?]> = [
  ["the layout check cannot see the attempt", { layout: { kind: "infra", detail: "attempt directory /x does not exist" } }, undefined, /does not exist/],
  ["the venv or PyPI fails", { install: { kind: "infra", detail: "the PyPI probe failed too: PyPI looks unreachable" } }, undefined, /PyPI looks unreachable/],
  ["pip freeze fails", { freeze: new BackendInfraError("pip freeze exited 2") }, undefined, /pip freeze exited 2/],
  ["the first start is a docker error", { starts: [{ kind: "infra", detail: "docker run -d exit 125: port is already allocated" }] }, undefined, /api-contract\.test\.ts: docker run -d exit 125/],
  ["a restart is a docker error", { starts: [ready(1), { kind: "infra", detail: "docker port answered nothing" }] }, undefined, /planner-assignment\.test\.ts: docker port/],
  ["a serving container cannot be proven removed", { stops: [REMOVED, NOT_REMOVED] }, undefined, /after planner-assignment\.test\.ts: .*could not be proven removed/],
  ["dispose cannot prove a container removed", { dispose: [REMOVED, NOT_REMOVED] }, undefined, /could not be proven removed/],
  ["dispose throws", { dispose: new Error("rmSync exploded") }, undefined, /disposing the backend threw: rmSync exploded/],
  [
    "a test file fails as a file (ContractHarnessError)",
    {},
    (entry, o) => {
      if (entry.file === "planner-parts.test.ts") throw new ContractHarnessError(o.file, "the test file itself failed (testCodeFailure, exit code 1)", "SyntaxError: bad");
      return passesAll(entry, o);
    },
    /the test file itself failed.*a harness fault, not the model's[\s\S]*SyntaxError: bad/,
  ],
  [
    "a file result that does not add up",
    {},
    (entry, o) => ({ ...passesAll(entry, o), total: entry.tests + 1 }),
    /the run counted 25 tests but the manifest says 24/,
  ],
];

for (const [label, script, outcome, pattern] of INFRA_CASES) {
  test(`infra, nothing written: ${label}`, async () => {
    const root = scoringRoot();
    const h = harness(script, outcome);
    const message = notWritten(await runContractTests(options(root), h.deps), root, "infra");
    if (pattern) assert.match(message, pattern);
    assert.match(message, /nothing was written/);
    assert.equal(h.backends[0].calls.at(-1), "dispose", "the backend is disposed on every path");
    assert.equal(h.backends[0].calls.filter((c) => c === "dispose").length, 1);
  });
}

test("the serving container is asked after each file, while it still runs, and before its removal", async () => {
  const root = scoringRoot();
  const h = harness();
  written(await runContractTests(options(root), h.deps), root);
  assert.deepEqual(h.backends[0].servingAsked, ["start", "start", "start", "start"]);
});

test("a serving container that vanished during a file is infra: that file's failures are not the model's", async () => {
  const root = scoringRoot();
  const h = harness({ serving: [{ kind: "running" }, { kind: "vanished" }] });
  const message = notWritten(await runContractTests(options(root), h.deps), root, "infra");
  assert.match(message, /^the serving container vanished during planner-assignment\.test\.ts: something outside contract-tests removed it/);
  assert.match(message, /nothing was written/);
  assert.equal(h.files.length, 2, "no file after it runs");
  assert.deepEqual(h.backends[0].calls.slice(-2), ["start", "dispose"], "no stop() for a container already gone; the backend is disposed");
});

test("a serving container docker cannot answer for after a file is infra", async () => {
  const root = scoringRoot();
  const h = harness({ serving: [{ kind: "unknown", detail: "docker inspect x exit 1: Cannot connect to the Docker daemon" }] });
  assert.match(notWritten(await runContractTests(options(root), h.deps), root, "infra"), /^after api-contract\.test\.ts: docker inspect x exit 1: Cannot connect/);
});

test("a serving container that exited during a file is a warning in the result, and the run goes on", async () => {
  const root = scoringRoot(runJson({ image: "" }));
  const h = harness({ serving: [{ kind: "running" }, { kind: "exited", exitCode: 137 }] }, typical);
  const results = written(await runContractTests(options(root), h.deps), root);
  assert.deepEqual(results.warnings, [
    "run.json records no image, so the image the attempt ran in is unknown",
    "the serving container exited with code 137 during planner-assignment.test.ts, so the tests after that ran against no backend (the backend crashed, or the host killed it)",
  ]);
  // The groups are scored as they came out: the warning changes no score or Notes.
  assert.deepEqual(results.groups.map((g) => g.score), [1.67, 2, 1, 2]);
  assert.equal(h.files.length, 4);
  assert.ok(h.out.includes(`warning: ${results.warnings[1]}`), h.out.join("\n"));
});

test("infra, nothing written: the backend cannot even be created", async () => {
  const root = scoringRoot();
  const h = harness({}, passesAll, {
    createBackend: () => {
      throw new Error("attemptDir must be an absolute host path without ':'");
    },
  });
  assert.match(notWritten(await runContractTests(options(root), h.deps), root, "infra"), /without ':'/);
});

// ---------------------------------------------------------------------------
// the overall budget

function clock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

test("the overall budget running out between files is infra, and nothing is written", async () => {
  const root = scoringRoot();
  const c = clock();
  const h = harness({}, (entry, o) => {
    c.advance(700_000);
    return passesAll(entry, o);
  }, { now: c.now });
  const message = notWritten(await runContractTests(options(root), h.deps), root, "infra");
  assert.match(message, /overall budget of 1200 s/);
  assert.deepEqual(h.files.map((f) => f.timeoutMs), [LIMITS.fileMs, LIMITS.fileMs], "a third file never starts");
  assert.equal(h.backends[0].calls.at(-1), "dispose");
});

test("the last file, its timer shortened by the overall budget, timing out is infra", async () => {
  const root = scoringRoot();
  const c = clock();
  const h = harness({}, (entry, o) => {
    if (entry.file !== "planner-parts.test.ts") {
      c.advance((LIMITS.overallMs - 50_000) / 3);
      return passesAll(entry, o);
    }
    c.advance(o.timeoutMs);
    return { ...passesAll(entry, o), passed: 2, notRun: entry.tests - 2, timedOut: true };
  }, { now: c.now });
  const message = notWritten(await runContractTests(options(root), h.deps), root, "infra");
  assert.match(message, /overall budget/);
  assert.deepEqual(h.files.map((f) => f.timeoutMs), [LIMITS.fileMs, LIMITS.fileMs, LIMITS.fileMs, 50_000]);
});

test("the overall budget starts after the install, which has budgets of its own", async () => {
  const root = scoringRoot();
  const c = clock();
  const h = harness({ onInstall: () => c.advance(LIMITS.overallMs) }, (entry, o) => {
    c.advance(200_000);
    return passesAll(entry, o);
  }, { now: c.now });
  const results = written(await runContractTests(options(root), h.deps), root);
  assert.equal(h.files.length, 4);
  assert.deepEqual(h.files.map((f) => f.timeoutMs), [120_000, 120_000, 120_000, 120_000]);
  assert.equal(results.durationMs, LIMITS.overallMs + 4 * 200_000, "durationMs covers the whole run");
});

test("shorter limits are honoured, for tests: restartRetries 0 means a failed restart is not retried", async () => {
  const root = scoringRoot();
  const h = harness({ starts: [ready(1), { kind: "stop", stage: "boot", detail: "exited 1" }] }, passesAll, { limits: { restartRetries: 0 } });
  const results = written(await runContractTests(options(root), h.deps), root);
  assert.equal(h.backends[0].calls.filter((c) => c === "start").length, 4);
  assert.match(results.groups[1].detail ?? "", /1 start, the last a boot failure/);
});

// ---------------------------------------------------------------------------
// refusals

const RUN_JSON_REFUSALS: Array<[string, Partial<RunJson>, RegExp]> = [
  ["failureKind infra", { failureKind: "infra" }, /records an infra failure/],
  ["failureKind model", { failureKind: "model" }, /records failureKind "model"/],
  ["softDenied", { softDenied: true, failureKind: null }, /records a soft-deny/],
];

for (const [label, change, pattern] of RUN_JSON_REFUSALS) {
  test(`refuses an attempt whose run.json records ${label}; --ignore-run-json scores it with runImage null`, async () => {
    const root = scoringRoot(runJson(change));
    const h = harness();
    assert.match(notWritten(await runContractTests(options(root), h.deps), root, "refused"), pattern);
    assert.equal(h.backends.length, 0, "nothing is started");

    const results = written(await runContractTests(options(root, { ignoreRunJson: true }), h.deps), root);
    assert.equal(results.runImage, null);
    assert.deepEqual(results.warnings, []);
  });
}

test("refuses an attempt with no run.json, naming --ignore-run-json, which then scores it", async () => {
  const root = scoringRoot(null);
  const h = harness();
  assert.match(notWritten(await runContractTests(options(root), h.deps), root, "refused"), /no run\.json at .*--ignore-run-json/s);
  assert.equal(h.backends.length, 0);
  assert.equal(written(await runContractTests(options(root, { ignoreRunJson: true }), h.deps), root).runImage, null);
});

test("refuses a run.json it cannot read", async () => {
  const root = scoringRoot(null);
  mkdirSync(join(root, "eval-results", ATTEMPT), { recursive: true });
  writeFileSync(join(root, "eval-results", ATTEMPT, "run.json"), "{not json");
  assert.match(notWritten(await runContractTests(options(root), harness().deps), root, "refused"), /cannot use .*not valid JSON/);
});

test("refuses a missing attempt directory and a name that is not an attempt directory", async () => {
  const root = scoringRoot();
  const h = harness();
  assert.match(notWritten(await runContractTests(options(root, { attempt: "other-attempt-2" }), h.deps), root, "refused"), /no attempt directory at/);
  assert.match(notWritten(await runContractTests(options(root, { attempt: "../x" }), h.deps), root, "refused"), /attempt directory name/);
  assert.equal(h.backends.length, 0);
});

test("refuses ungated hidden tests; --allow-ungated scores them as ungated: true", async () => {
  const root = scoringRoot();
  const mismatch = harness({}, passesAll, { gate: () => ({ recorded: "1".repeat(64), current: "2".repeat(64) }) });
  const message = notWritten(await runContractTests(options(root), mismatch.deps), root, "refused");
  assert.match(message, /differ from what gate 2 vouched for \(recorded 111111111111, now 222222222222\)/);
  assert.match(message, /npm run gate:reference.*--allow-ungated/s);
  assert.equal(mismatch.backends.length, 0);
  assert.equal(written(await runContractTests(options(root, { allowUngated: true }), mismatch.deps), root).ungated, true);

  const unrecorded = harness({}, passesAll, { gate: () => ({ recorded: null, current: "2".repeat(64) }) });
  const noRecord = scoringRoot();
  assert.match(notWritten(await runContractTests(options(noRecord), unrecorded.deps), noRecord, "refused"), /no readable record/);
  assert.equal(written(await runContractTests(options(noRecord, { allowUngated: true }), unrecorded.deps), noRecord).ungated, true);

  // The flag permits an ungated run; it does not make a gated one ungated.
  const gated = scoringRoot();
  assert.equal(written(await runContractTests(options(gated, { allowUngated: true }), harness().deps), gated).ungated, false);
});

test("a run.json that records no image: runImage null, one warning, and the result still written", async () => {
  const root = scoringRoot(runJson({ image: "" }));
  const results = written(await runContractTests(options(root), harness().deps), root);
  assert.equal(results.image, REF);
  assert.equal(results.runImage, null);
  assert.equal(results.warnings.length, 1);
  assert.match(results.warnings[0], /run\.json records no image/);
});

test("a run.json image other than the one the tests ran in is a warning, not a refusal", async () => {
  const other = `agrav-bench/harness:2026-09-05@sha256:${"9".repeat(64)}`;
  const root = scoringRoot(runJson({ image: other }));
  const results = written(await runContractTests(options(root), harness().deps), root);
  assert.equal(results.image, REF);
  assert.equal(results.runImage, other);
  assert.equal(results.warnings.length, 1);
  assert.ok(results.warnings[0].includes(REF) && results.warnings[0].includes(other), results.warnings[0]);
});

test("an image that cannot be resolved, or git that cannot answer, is infra before any container starts", async () => {
  const root = scoringRoot();
  const noImage = harness({}, passesAll, {
    image: () => {
      throw new Error("could not resolve image agrav-bench/harness:2026-09-18 to an image Id");
    },
  });
  assert.match(notWritten(await runContractTests(options(root), noImage.deps), root, "infra"), /could not resolve image/);
  assert.equal(noImage.backends.length, 0);
  const noGit = harness({}, passesAll, {
    provenance: () => {
      throw new Error("git log -1 --format=%H failed");
    },
  });
  assert.match(notWritten(await runContractTests(options(root), noGit.deps), root, "infra"), /git log/);
  assert.equal(noGit.backends.length, 0);
  // A resolved reference that does not end in an Id cannot be run by Id.
  const answersLatest = (): SpawnSyncReturns<string> => ({ pid: 0, output: [], stdout: "latest\n", stderr: "", status: 0, signal: null });
  const noId = harness({}, passesAll, { image: () => ({ tag: TAG, ...resolveImageId(TAG, answersLatest) }) });
  assert.match(notWritten(await runContractTests(options(root), noId.deps), root, "infra"), /does not end in @sha256:<64 hex>/);
  assert.equal(noId.backends.length, 0);
});

// ---------------------------------------------------------------------------
// the write

test("before writing, stale temp files of this result left by dead writers are removed, and nothing else", async () => {
  const root = scoringRoot();
  const dir = join(root, "eval-results", ATTEMPT);
  const DEAD = 4101;
  const LIVE = 4202;
  const stale = [`.contract-results.json.${DEAD}.0123abcd.tmp`, `.contract-results.json.${DEAD + 1}.ffffffff.tmp`];
  const kept = [
    `.contract-results.json.${LIVE}.0123abcd.tmp`, // a live writer's
    ".contract-results.json.tmp", // not the writer's pattern
    `.contract-results.json.${DEAD}.0123abcd.tmp.bak`,
    `contract-results.json.${DEAD}.0123abcd.tmp`,
    `.run.json.${DEAD}.0123abcd.tmp`, // another file's
  ];
  for (const name of [...stale, ...kept]) writeFileSync(join(dir, name), "{");
  const looksStale = `.contract-results.json.${DEAD}.abcdabcd.tmp`;
  mkdirSync(join(dir, looksStale)); // a directory, not a writer's file
  const other = join(root, "eval-results", "other-attempt-1");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, stale[0]), "{"); // another attempt's: not this run's to touch

  const asked: number[] = [];
  const h = harness({}, passesAll, {
    isAlive: (pid) => {
      asked.push(pid);
      return pid === LIVE;
    },
  });
  written(await runContractTests(options(root), h.deps), root);
  assert.deepEqual(readdirSync(dir).sort(), ["run.json", CONTRACT_RESULTS_FILE, looksStale, ...kept].sort());
  assert.ok(existsSync(join(other, stale[0])));
  // Liveness is asked only of the writers' own files, never of a directory or another name.
  assert.deepEqual([...asked].sort((a, b) => a - b), [DEAD, DEAD + 1, LIVE]);
});

// ---------------------------------------------------------------------------
// interruption

test("a signal during the run stops it before the next step; nothing is written and the backend is disposed", async () => {
  const root = scoringRoot();
  let signal: "SIGTERM" | null = null;
  const h = harness({}, (entry, o) => {
    if (entry.file === "planner-assignment.test.ts") signal = "SIGTERM";
    return passesAll(entry, o);
  }, { interrupted: () => signal });
  const outcome = await runContractTests(options(root), h.deps);
  notWritten(outcome, root, "interrupted");
  assert.deepEqual(outcome, { kind: "interrupted", signal: "SIGTERM" });
  assert.equal(h.files.length, 2);
  assert.deepEqual(h.backends[0].calls.slice(-2), ["start", "dispose"]);
});

test("a signal that makes a step fail is reported as the interruption, not as infra", async () => {
  const root = scoringRoot();
  let signal: "SIGINT" | null = null;
  const h = harness({}, (entry, o) => {
    // What a group signal does to the hidden-test child: the file dies, which looks like a harness fault.
    signal = "SIGINT";
    throw new ContractHarnessError(o.file, "the test file itself failed (testCodeFailure, signal SIGINT)", "");
  }, { interrupted: () => signal });
  assert.deepEqual(await runContractTests(options(root), h.deps), { kind: "interrupted", signal: "SIGINT" });
  notWritten({ kind: "interrupted", signal: "SIGINT" }, root, "interrupted");
  assert.equal(h.backends[0].calls.at(-1), "dispose");
});

test("a signal still pending when the run completes writes nothing", async () => {
  const root = scoringRoot();
  let signal: "SIGQUIT" | null = null;
  const h = harness({}, passesAll, { interrupted: () => signal });
  h.deps.onBackend = (backend) => {
    const dispose = backend.dispose.bind(backend);
    backend.dispose = async () => {
      // Delivered on the next turn of the event loop, as a signal that
      // arrived while a spawnSync blocked is.
      setImmediate(() => (signal = "SIGQUIT"));
      return dispose();
    };
  };
  assert.deepEqual(await runContractTests(options(root), h.deps), { kind: "interrupted", signal: "SIGQUIT" });
  assert.ok(!existsSync(resultPath(root)));
});

test("a signal before anything starts creates no backend", async () => {
  const root = scoringRoot();
  const h = harness({}, passesAll, { interrupted: () => "SIGHUP" });
  assert.deepEqual(await runContractTests(options(root), h.deps), { kind: "interrupted", signal: "SIGHUP" });
  assert.equal(h.backends.length, 0);
});

// ---------------------------------------------------------------------------
// arguments, provenance, import

test("parseArgs takes an attempt directory name and three options", () => {
  assert.deepEqual(parseArgs(["--attempt", "x-attempt-1"]), { attempt: "x-attempt-1", root: REPO_ROOT, ignoreRunJson: false, allowUngated: false, help: false });
  assert.deepEqual(parseArgs(["--attempt=x-attempt-1", "--root=/tmp/r", "--ignore-run-json", "--allow-ungated"]), {
    attempt: "x-attempt-1",
    root: "/tmp/r",
    ignoreRunJson: true,
    allowUngated: true,
    help: false,
  });
  assert.equal(parseArgs(["--help"]).help, true);
  for (const bad of [
    [],
    ["--attempt"],
    ["--attempt", "--root", "/r"],
    ["--attempt", "x-attempt-1", "--attempt", "y-attempt-1"],
    ["--attempt", "eval-attempts/x-attempt-1"],
    ["--attempt", "X_attempt-1"],
    ["--attempt", "x-attempt-1", "--ignore-run-json=yes"],
    ["--attempt", "x-attempt-1", "--root"],
    ["--attempt", "x-attempt-1", "--root", "/a", "--root", "/b"],
    ["--attempt", "x-attempt-1", "--root=/a", "--root", "/a"],
    ["--attempt", "x-attempt-1", "--rows", "x"],
  ]) {
    assert.throws(() => parseArgs(bad), (error: Error) => error.constructor.name === "UsageError", JSON.stringify(bad));
  }
});

/** A throwaway git repository, isolated from the user's and the system's git config and from any inherited GIT_* variable. */
function gitRepo(): { root: string; git: (...args: string[]) => string; commit: (path: string, content: string) => string } {
  const root = tempDir("agrav-contract-tests-git-");
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  Object.assign(env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
  const git = (...args: string[]): string => {
    const result = spawnSync(
      "git",
      ["-C", root, "-c", "user.name=agrav test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
      { encoding: "utf8", env, timeout: 30_000 },
    );
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.error?.message ?? result.stderr}`);
    return result.stdout.trim();
  };
  git("init", "-q");
  const commit = (path: string, content: string): string => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
    git("add", "--", path);
    git("commit", "-q", "-m", `change ${path}`);
    return git("rev-parse", "HEAD");
  };
  return { root, git, commit };
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

test("testsProvenance names the last commit touching the tests' paths, not HEAD", () => {
  const repo = gitRepo();
  const tests = repo.commit("benchmark/contract-tests/x.test.ts", "one\n");
  const head = repo.commit("README.md", "unrelated\n");
  assert.notEqual(tests, head);
  assert.deepEqual(testsProvenance(repo.root), { testsCommit: tests, testsDirty: false });
  // Each of the three paths moves it; a neighbour of one does not.
  const seed = repo.commit("benchmark/context/seed.json", "{}\n");
  repo.commit("benchmark/contract-tests-old/y.test.ts", "near miss\n");
  assert.equal(testsProvenance(repo.root).testsCommit, seed);
  const suite = repo.commit("scripts/lib/contract-suite.ts", "export {};\n");
  repo.commit("benchmark/context/other.json", "{}\n");
  assert.equal(testsProvenance(repo.root).testsCommit, suite);
});

test("testsProvenance: dirty only for a modified or untracked file under the tests' paths", () => {
  const repo = gitRepo();
  const tests = repo.commit("benchmark/contract-tests/x.test.ts", "one\n");
  repo.commit("README.md", "unrelated\n");
  // A repository that hides untracked files from `git status` must not hide
  // an uncommitted hidden test from testsDirty.
  repo.git("config", "status.showUntrackedFiles", "no");

  // Changes anywhere else, tracked or not, leave it clean.
  write(repo.root, "README.md", "changed\n");
  write(repo.root, "notes.txt", "untracked\n");
  write(repo.root, "benchmark/context/other.json", "{}\n");
  write(repo.root, "benchmark/contract-tests-old/y.test.ts", "near miss\n");
  write(repo.root, "scripts/lib/other.ts", "export {};\n");
  assert.deepEqual(testsProvenance(repo.root), { testsCommit: tests, testsDirty: false });

  // A modified tracked file under them.
  write(repo.root, "benchmark/contract-tests/x.test.ts", "two\n");
  assert.equal(testsProvenance(repo.root).testsDirty, true);
  repo.git("checkout", "--", "benchmark/contract-tests/x.test.ts");
  assert.equal(testsProvenance(repo.root).testsDirty, false);

  // An untracked file under each of them, a new directory's included.
  for (const path of ["benchmark/contract-tests/new/y.test.ts", "benchmark/context/seed.json", "scripts/lib/contract-suite.ts"]) {
    write(repo.root, path, "new\n");
    assert.equal(testsProvenance(repo.root).testsDirty, true, path);
    rmSync(join(repo.root, path));
    assert.equal(testsProvenance(repo.root).testsDirty, false, `${path} removed`);
  }
});

test("testsProvenance answers for repoRoot whatever GIT_DIR, GIT_WORK_TREE or GIT_INDEX_FILE a hook or wrapper left set", () => {
  const repo = gitRepo();
  const tests = repo.commit("benchmark/contract-tests/x.test.ts", "one\n");
  // Another repository: a later commit under the tests' paths, and a dirty test file.
  const other = gitRepo();
  other.commit("benchmark/contract-tests/x.test.ts", "other\n");
  other.commit("benchmark/contract-tests/y.test.ts", "other\n");
  write(other.root, "benchmark/contract-tests/x.test.ts", "dirty\n");
  const bogusIndex = join(tempDir("agrav-contract-tests-index-"), "index");
  const expected = { testsCommit: tests, testsDirty: false };
  for (const vars of [
    { GIT_INDEX_FILE: bogusIndex },
    { GIT_DIR: join(other.root, ".git") },
    { GIT_WORK_TREE: other.root },
    { GIT_DIR: join(other.root, ".git"), GIT_WORK_TREE: other.root, GIT_INDEX_FILE: bogusIndex },
  ]) {
    const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
    Object.assign(process.env, vars);
    try {
      assert.deepEqual(testsProvenance(repo.root), expected, JSON.stringify(vars));
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }
});

test("testsProvenance refuses a repository with no commit touching the tests' paths", () => {
  const repo = gitRepo();
  // No commit at all: git log itself fails.
  assert.throws(() => testsProvenance(repo.root), /git log/);
  // Commits, none of them touching the paths: git log answers nothing.
  repo.commit("README.md", "unrelated\n");
  write(repo.root, "benchmark/contract-tests/x.test.ts", "untracked\n");
  assert.throws(() => testsProvenance(repo.root), /git log names no commit touching benchmark\/contract-tests/);
});

test("importing the module installs no process handler and runs nothing", async () => {
  const events = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "exit", "beforeExit", "uncaughtException"] as const;
  const before = events.map((e) => process.listenerCount(e));
  const fresh = await import(`${new URL("../scripts/contract-tests", import.meta.url).href}?listener-probe=${process.hrtime.bigint()}`);
  assert.equal(typeof fresh.runContractTests, "function");
  assert.deepEqual(events.map((e) => process.listenerCount(e)), before);
});

// ---------------------------------------------------------------------------
// the CLI, end to end through the fake docker

/** The child's environment: the fake docker first on PATH, no knob or test-runner state inherited. */
function cliEnv(stateDir: string, tmp: string, knobs: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("FAKE_") || key === "NODE_TEST_CONTEXT") delete env[key];
  return { ...env, PATH: `${FAKE_DIR}${delimiter}${process.env.PATH ?? ""}`, FAKE_DOCKER_STATE: stateDir, TMPDIR: tmp, ...knobs };
}

interface Cli {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
}

interface RunningCli {
  pid: number;
  /** Field 22 of its /proc stat, read right after the spawn; `null` if unread. */
  start: bigint | null;
  /**
   * Signal the CLI, or its whole process group, only while this process has
   * not yet reaped it: until then its pid, and so the group's id, cannot have
   * been reused. `false` when it was not sent.
   */
  signal(signal: NodeJS.Signals, target: "process" | "group"): boolean;
}

/** Spawn the CLI in its own process group; `whileRunning` may signal it. */
function cli(args: string[], env: NodeJS.ProcessEnv, whileRunning?: (run: RunningCli) => void): Promise<Cli> {
  const child = spawn(process.execPath, ["--import", "tsx", CLI, ...args], { cwd: ROOT, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const pid = child.pid as number;
  // Read at once: the CLI exists (unreaped) until this process sees it exit.
  const start = procStat(pid)?.start ?? null;
  openClis.set(pid, start);
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
  whileRunning?.({
    pid,
    start,
    signal(signal, target) {
      // Set when node reaps the child, in the same step as the reaping.
      if (child.exitCode !== null || child.signalCode !== null) return false;
      try {
        process.kill(target === "group" ? -pid : pid, signal);
        return true;
      } catch {
        return false;
      }
    },
  });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      openClis.delete(pid);
      resolve({ code, signal, output });
    });
  });
}

interface E2eCase {
  root: string;
  stateDir: string;
  tmp: string;
  attempt: string;
  result: string;
  env(knobs?: Record<string, string>): NodeJS.ProcessEnv;
  assertClean(): void;
}

/** Process group, state and start time (fields 5, 3 and 22 of /proc/<pid>/stat), or `null` when gone. */
function procStat(pid: number): { pgrp: number; state: string; start: bigint } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { state: fields[0], pgrp: Number(fields[2]), start: BigInt(fields[19]) };
  } catch {
    return null;
  }
}

/**
 * The live processes of process group `pgid` that provably are this test's:
 * started no earlier than the CLI that leads the group, and running that CLI,
 * a hidden-test file, the esbuild service tsx starts for either, or a client
 * of the fake docker. If the group id now names another process — the CLI's
 * pid reused by a new group leader — nothing is listed.
 */
function ourGroupMembers(pgid: number, cliStart: bigint): number[] {
  const leader = procStat(pgid);
  if (leader !== null && leader.start !== cliStart) return [];
  const members: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    const stat = procStat(pid);
    if (stat === null || stat.pgrp !== pgid || stat.state === "Z" || stat.start < cliStart) continue;
    let cmdline: string;
    try {
      cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    } catch {
      continue;
    }
    const fakeClient = cmdline.split("\0").some((arg) => arg.replace(/\/+/g, "/") === FAKE_DOCKER);
    if (cmdline.includes(CLI) || cmdline.includes(TESTS_DIR) || /\/@esbuild\/[^/\0]+\/bin\/esbuild\0/.test(cmdline) || fakeClient) members.push(pid);
  }
  return members;
}

/** Whether the CLI's group now holds a hidden-test child: one of its members running a file under TESTS_DIR. */
function runsHiddenTestFile(pgid: number, cliStart: bigint): boolean {
  return ourGroupMembers(pgid, cliStart).some((pid) => {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(TESTS_DIR);
    } catch {
      return false; // gone in the meantime
    }
  });
}

function fakeContainers(stateDir: string): Array<{ name: string; detached: boolean; status: string }> {
  const dir = join(stateDir, "containers");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => {
      try {
        return [JSON.parse(readFileSync(join(dir, f), "utf8"))];
      } catch {
        return []; // removed between the listing and the read
      }
    });
}

/** A synthetic attempt with the run contract's backend layout, under a fresh --root, state dir and TMPDIR. */
function e2eCase(): E2eCase {
  const base = tempDir("agrav-contract-tests-e2e-");
  const root = join(base, "root");
  const stateDir = join(base, "state");
  const tmp = join(base, "tmp");
  const attempt = "synthetic-attempt-1";
  const backend = join(root, "eval-attempts", attempt, "backend");
  mkdirSync(join(backend, "app"), { recursive: true });
  mkdirSync(stateDir);
  fakeStates.push(stateDir);
  mkdirSync(tmp);
  writeFileSync(join(backend, "requirements.txt"), "fastapi==0.115.14\nuvicorn==0.30.6\n");
  writeFileSync(join(backend, "app", "main.py"), "from fastapi import FastAPI\napp = FastAPI()\n");
  return {
    root,
    stateDir,
    tmp,
    attempt,
    result: join(root, "eval-results", attempt, CONTRACT_RESULTS_FILE),
    env: (knobs = {}) => cliEnv(stateDir, tmp, knobs),
    assertClean() {
      assert.deepEqual(fakeContainers(stateDir).map((c) => c.name), [], "no fake container is left");
      assert.deepEqual(survivors(stateDir), [], "no fake server or sleeper is alive");
      assert.deepEqual(readdirSync(tmp).filter((d) => d.startsWith("agrav-backend-")), [], "no scratch directory is left");
    },
  };
}

before(() => {
  // Fail closed: if `docker` on the children's PATH were a real client, these
  // tests would start real containers.
  const identity = spawnSync("docker", ["--fake-identity"], { encoding: "utf8", timeout: 10_000, env: cliEnv("/nonexistent", tmpdir()) });
  if (identity.stdout?.trim() !== "fake-docker-backend") {
    throw new Error(`\`docker\` on the children's PATH is not the fake in ${FAKE_DIR}; refusing to run the CLI tests`);
  }
});

test("the CLI exits 2 on a usage error and 1 on a refusal, writing nothing", async () => {
  const c = e2eCase();
  const usage = await cli(["--attempt", "not a dir"], c.env());
  assert.equal(usage.code, 2, usage.output);
  assert.match(usage.output, /Usage: node --import tsx scripts\/contract-tests\.ts/);
  const refused = await cli(["--attempt", c.attempt, "--root", c.root], c.env());
  assert.equal(refused.code, 1, refused.output);
  assert.match(refused.output, /no run\.json at .*--ignore-run-json/s);
  assert.ok(!existsSync(c.result));
  assert.ok(!existsSync(join(c.stateDir, "calls.log")), "a refusal calls no docker");
});

describe("the CLI through the fake docker", { concurrency: true, timeout: 90_000 }, () => {
  test("a complete run writes a valid result and leaves no container, server or scratch directory", async () => {
    const c = e2eCase();
    const run = await cli(["--attempt", c.attempt, "--root", c.root, "--ignore-run-json"], c.env());
    assert.equal(run.code, 0, run.output);
    const results = readContractResults(c.result);
    assert.equal(results.attempt, c.attempt);
    assert.equal(results.image, `${readScoringImage(ROOT)}@sha256:${"f".repeat(64)}`);
    assert.equal(results.runImage, null);
    assert.equal(results.rubric, rubricId(ROOT));
    assert.deepEqual(results.pipFreeze, ["fastapi==0.115.14", "uvicorn==0.30.6"]);
    assert.deepEqual(results.boot, { ok: true, stage: null, detail: null });
    // The fake answers /reset 404, so every real hidden test fails in beforeEach.
    assert.deepEqual(results.groups.map((g) => [g.file, g.total, g.passed]), MANIFEST.map((e) => [e.file, e.tests, 0]));
    assert.equal(results.diagnosis, "reset-broken");
    // Four serving containers, one per file, each on its own name.
    const calls = readFileSync(join(c.stateDir, "calls.log"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
    const serving = calls.filter((argv) => argv[0] === "run" && argv[1] === "-d");
    assert.equal(serving.length, 4);
    // Every container ran by the image Id the tag resolved to, never by the tag: the image is the
    // argument right after --entrypoint's value.
    const runs = calls.filter((argv) => argv[0] === "run");
    assert.equal(runs.length, 3 + 4, "venv, install, freeze, then one serving container per file");
    for (const argv of runs) assert.equal(argv[argv.indexOf("--entrypoint") + 2], FAKE_IMAGE_ID, argv.join(" "));
    assert.equal(results.image, `${readScoringImage(ROOT)}@${FAKE_IMAGE_ID}`);
    assert.equal(new Set(serving.map((argv) => argv[argv.indexOf("--name") + 1])).size, 4);
    assert.ok(serving.every((argv) => argv[argv.indexOf("-p") + 1] === "127.0.0.1::5100"), "an ephemeral port, never 5100");
    for (const row of ["API contract: 0/24 passed", "Planner: parts & blocking: 0/11 passed"]) assert.ok(run.output.includes(row), run.output);
    c.assertClean();
  });

  test("a backend that crashes on its first start is a backend stop: exit 0, the result written", async () => {
    const c = e2eCase();
    const run = await cli(["--attempt", c.attempt, "--root", c.root, "--ignore-run-json"], c.env({ FAKE_BACKEND: "crash-now" }));
    assert.equal(run.code, 0, run.output);
    const results = readContractResults(c.result);
    assert.equal(results.boot.stage, "boot");
    assert.match(results.boot.detail ?? "", /ModuleNotFoundError/);
    assert.deepEqual(results.groups.map((g) => g.score), [0, 0, 0, 0]);
    c.assertClean();
  });

  test("a serving container that exits during each file is a warning: exit 0, the result written with one warning per file", async () => {
    const c = e2eCase();
    const run = await cli(["--attempt", c.attempt, "--root", c.root, "--ignore-run-json"], c.env({ FAKE_BACKEND: "exit-mid" }));
    assert.equal(run.code, 0, run.output);
    const results = readContractResults(c.result);
    assert.deepEqual(results.boot, { ok: true, stage: null, detail: null });
    assert.deepEqual(
      results.warnings,
      MANIFEST.map((e) => `the serving container exited with code 137 during ${e.file}, so the tests after that ran against no backend (the backend crashed, or the host killed it)`),
    );
    c.assertClean();
  });

  test("a serving container removed from outside during a file is infra: exit 1, nothing written", async () => {
    const c = e2eCase();
    const run = await cli(["--attempt", c.attempt, "--root", c.root, "--ignore-run-json"], c.env({ FAKE_BACKEND: "vanish-mid" }));
    assert.equal(run.code, 1, run.output);
    assert.match(run.output, /the serving container vanished during api-contract\.test\.ts: something outside contract-tests removed it[\s\S]*nothing was written/);
    assert.ok(!existsSync(c.result));
    c.assertClean();
  });

  test("an install that fails while PyPI is unreachable is infra: exit 1, nothing written", async () => {
    // `offline` output includes NewConnectionError — a network-error signature —
    // so the retry fires. Both attempts fail, and then the PyPI probe fails too,
    // giving infra with the probe message.
    const c = e2eCase();
    const run = await cli(["--attempt", c.attempt, "--root", c.root, "--ignore-run-json"], c.env({ FAKE_INSTALL: "offline" }));
    assert.equal(run.code, 1, run.output);
    assert.match(run.output, /PyPI looks unreachable[\s\S]*nothing was written/);
    assert.ok(!existsSync(c.result));
    c.assertClean();
  });

  test("SIGTERM while a backend serves: exit 143, nothing written, no container or scratch directory left", async () => {
    const c = e2eCase();
    let signalled = false;
    let poll: NodeJS.Timeout | undefined;
    const run = await cli(["--attempt", c.attempt, "--root", c.root, "--ignore-run-json"], c.env({ FAKE_BACKEND: "ok" }), (running) => {
      poll = setInterval(() => {
        // Serving, and its `docker run -d` client already returned — the CLI
        // has asked for its port — so the signal cannot kill the fake's
        // client halfway through spawning the "container".
        const serving = fakeContainers(c.stateDir).filter((container) => container.detached && container.status === "running");
        const log = join(c.stateDir, "calls.log");
        const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) : [];
        if (!calls.some((argv) => argv[0] === "port" && serving.some((container) => container.name === argv[1]))) return;
        clearInterval(poll);
        signalled = running.signal("SIGTERM", "group");
      }, 20);
    });
    clearInterval(poll);
    assert.ok(signalled, `the CLI finished before it was signalled while serving:\n${run.output}`);
    assert.equal(run.code, 143, run.output);
    assert.match(run.output, /SIGTERM — cleaning up/);
    assert.ok(!existsSync(c.result), "an interrupted run writes nothing");
    c.assertClean();
  });

  test("SIGINT to the CLI alone while a hidden-test file runs: its handler removes the container, exit 130", async () => {
    // Signalled alone — as a tool that kills a pid does — nothing else in the
    // group dies with it, so no failing child hands the main flow a reason to
    // clean up: only the signal handler removes the serving container.
    const c = e2eCase();
    let signalled = false;
    let poll: NodeJS.Timeout | undefined;
    let pid = 0;
    let cliStart: bigint | null = null;
    let output = "";
    const run = await cli(["--attempt", c.attempt, "--root", c.root, "--ignore-run-json"], c.env({ FAKE_BACKEND: "ok" }), (running) => {
      pid = running.pid;
      cliStart = running.start;
      poll = setInterval(() => {
        // Inside a hidden-test file: its child is in the CLI's group. Counted,
        // never timed, so a loaded machine cannot land the signal elsewhere.
        if (running.start === null || !runsHiddenTestFile(running.pid, running.start)) return;
        clearInterval(poll);
        signalled = running.signal("SIGINT", "process");
      }, 20);
    });
    clearInterval(poll);
    output = run.output;
    // The orphaned hidden-test child, if any, is still in the CLI's group: give
    // it 5 s to go, then SIGKILL only what provably is ours (ourGroupMembers) —
    // never the group id as such, which a reused pid could by now lead.
    assert.ok(cliStart !== null, "the CLI's start time was read");
    for (let i = 0; i < 100 && ourGroupMembers(pid, cliStart).length > 0; i++) {
      await new Promise((done) => setTimeout(done, 50));
    }
    for (const member of ourGroupMembers(pid, cliStart)) {
      try {
        process.kill(member, "SIGKILL");
      } catch {
        // gone in the meantime
      }
    }
    assert.ok(signalled, `the CLI finished before it was signalled inside a hidden-test file:\n${output}`);
    assert.equal(run.code, 130, output);
    assert.match(output, /running \d+ tests against/, "the signal landed inside a hidden-test file");
    assert.ok(!existsSync(c.result), "an interrupted run writes nothing");
    c.assertClean();
  });
});
