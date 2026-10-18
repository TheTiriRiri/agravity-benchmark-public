/**
 * Tests for scoreHiddenRows in scripts/score-hard.ts: the six contract files,
 * each against a freshly started backend (criteria.md: "Each file runs against
 * a freshly started backend"), then one serve-attempt for the build and the
 * E2E; and for what a signal meanwhile leaves (scoreNormalAttempt). Every
 * container and process is a fake; nothing is spawned.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { parse as parseCsv } from "csv-parse/sync";

import type { BackendOptions, ServingState, StartResult, StepResult } from "../scripts/lib/attempt-backend";
import { stopAllBackends, stopAllBackendsSync } from "../scripts/lib/attempt-backend";
import { killAllProcessesSync, stopAllProcesses } from "../scripts/lib/dev-server";
import type { ContainerRemoval } from "../scripts/lib/docker";
import { HarnessFault, loadManifest, parseHardHiddenResults, renderCsv, type ManifestEntry, type ProcOutcome } from "../scripts/lib/hard-score";
import { HARD_RUBRIC_ROWS } from "../scripts/lib/hard-rubric";
import type { InterruptSignal } from "../scripts/lib/interrupt";
import type { RunJson } from "../scripts/lib/run-json";
import {
  assembleCells,
  interruptHooks,
  removePlaywrightOutputsSync,
  scoreHiddenRows,
  scoreNormalAttempt,
  stopServing,
  type HardContractBackend,
  type ScoreHardDeps,
  type ServedState,
} from "../scripts/score-hard";

const ROOT = join(import.meta.dirname, "..");
const CONTRACT = loadManifest(join(ROOT, "tracks", "console-hard", "benchmark", "contract-tests", "manifest.json"));
const E2E = loadManifest(join(ROOT, "tracks", "console-hard", "benchmark", "e2e-tests", "manifest.json"));
const ATTEMPT = "fake-model-high-attempt-1";
const ATTEMPT_DIR = "/nonexistent/fake-model-high-attempt-1";
/** The warning a container that exited with 137 during the second contract file leaves. */
const EXITED_137 = "the backend container exited with code 137 during planner-assignment.test.ts, so the tests after that ran against no backend (the backend crashed, or the host killed it)";

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

/** TAP as `node --test --test-reporter=tap` prints it: `failed` first, the rest passing. */
function tap(entry: ManifestEntry, failed: readonly string[] = []): ProcOutcome {
  const lines: string[] = [];
  let n = 0;
  for (const name of failed) lines.push(`not ok ${++n} - ${name}`);
  while (n < entry.tests) lines.push(`ok ${++n} - test ${n}`);
  lines.push(`# tests ${entry.tests}`, `# pass ${entry.tests - failed.length}`);
  return { status: failed.length === 0 ? 0 : 1, signal: null, stdout: `${lines.join("\n")}\n`, stderr: "" };
}

/** A Playwright JSON report with every test passing. */
function playwright(entry: ManifestEntry): ProcOutcome {
  const stats = { expected: entry.tests, unexpected: 0, flaky: 0, skipped: 0 };
  return { status: 0, signal: null, stdout: JSON.stringify({ stats, suites: [] }), stderr: "" };
}

/**
 * A child that runs until `signal` aborts, then ends as `runProcess` reports
 * one its SIGTERM killed. `ran` hears when it started.
 */
function untilAborted(signal: AbortSignal, ran: () => void): Promise<ProcOutcome> {
  ran();
  return new Promise((done) => {
    const end = (): void => done({ status: null, signal: "SIGTERM", stdout: "", stderr: "" });
    if (signal.aborted) end();
    else signal.addEventListener("abort", end, { once: true });
  });
}

/**
 * What main's handlers do on a signal: `interrupted()` answers it from then
 * on, and the first cleanup aborts the running child.
 */
function operator(): { interrupted: () => InterruptSignal | null; abortSignal: AbortSignal; send: (signal: InterruptSignal) => void } {
  const abort = new AbortController();
  let received: InterruptSignal | null = null;
  return {
    interrupted: () => received,
    abortSignal: abort.signal,
    send: (signal) => {
      received ??= signal;
      interruptHooks(() => abort.abort()).cleanups[0]!();
    },
  };
}

/** A backend that records every call into the shared `events`; each start is a new instance with its own port. */
class FakeBackend implements HardContractBackend {
  layout: StepResult = { kind: "ok" };
  installed: StepResult = { kind: "ok" };
  /** Consumed one per start(); once empty, every start is ready. */
  startResults: StartResult[] = [];
  /** Consumed one per servingState(); once empty, the container is running. */
  servingStates: ServingState[] = [];
  removal: ContainerRemoval = { removed: true, detail: "removed" };
  leftovers: ContainerRemoval[] = [];
  starts = 0;
  /** The instance the last ready start() brought up, or null while none serves. */
  instance: number | null = null;
  disposals = 0;

  constructor(readonly events: string[]) {}

  checkLayout(): StepResult {
    this.events.push("checkLayout");
    return this.layout;
  }

  async install(): Promise<StepResult> {
    this.events.push("install");
    return this.installed;
  }

  async start(): Promise<StartResult> {
    this.starts++;
    this.events.push("start");
    const result = this.startResults.shift() ?? { kind: "ready", baseUrl: `http://127.0.0.1:${40000 + this.starts}`, container: `serve-${this.starts}` };
    this.instance = result.kind === "ready" ? this.starts : null;
    return result;
  }

  async servingState(): Promise<ServingState> {
    this.events.push("servingState");
    return this.servingStates.shift() ?? { kind: "running" };
  }

  async stop(): Promise<ContainerRemoval> {
    this.events.push("stop");
    this.instance = null;
    return this.removal;
  }

  async dispose(): Promise<ContainerRemoval[]> {
    this.disposals++;
    this.events.push("dispose");
    return this.leftovers;
  }
}

interface Harness {
  backend: FakeBackend;
  events: string[];
  log: string[];
  created: BackendOptions[];
  deps: Partial<ScoreHardDeps>;
}

function harness(over: Partial<ScoreHardDeps> = {}, served: ServedState = { backend: "ok", frontend: "ok", url: "http://localhost:5173/" }): Harness {
  const events: string[] = [];
  const log: string[] = [];
  const created: BackendOptions[] = [];
  const backend = new FakeBackend(events);
  const deps: Partial<ScoreHardDeps> = {
    createBackend: (options) => {
      created.push(options);
      events.push("createBackend");
      return backend;
    },
    imageId: () => `sha256:${"a".repeat(64)}`,
    runContractFile: async (entry, baseUrl) => {
      events.push(`file:${entry.file}@${baseUrl}`);
      return tap(entry);
    },
    serve: async () => {
      events.push("serve");
      return served;
    },
    stopServing: () => {
      events.push("stopServing");
    },
    build: async () => {
      events.push("build");
      return { status: 0, signal: null, stdout: "", stderr: "" };
    },
    runE2EFile: async (entry) => {
      events.push(`e2e:${entry.file}`);
      return playwright(entry);
    },
    out: (line) => {
      log.push(line);
    },
    ...over,
  };
  return { backend, events, log, created, deps };
}

const contractEvents = (events: readonly string[]): string[] =>
  events.filter((e) => e === "start" || e === "stop" || e === "install" || e.startsWith("file:"));

// ---------------------------------------------------------------------------
// (a) install once, one start and one stop per file, in manifest order
// ---------------------------------------------------------------------------

describe("scoreHiddenRows: one fresh backend per contract file", () => {
  it("installs once, then starts a container before each file and stops it after, in manifest order", async () => {
    const h = harness();
    const result = await scoreHiddenRows(ATTEMPT, ATTEMPT_DIR, h.deps);

    const expected = ["install"];
    for (const [i, entry] of CONTRACT.entries()) expected.push("start", `file:${entry.file}@http://127.0.0.1:${40001 + i}`, "stop");
    assert.deepEqual(contractEvents(h.events), expected);
    assert.equal(h.backend.starts, CONTRACT.length);
    assert.equal(h.backend.disposals, 1);
    assert.equal(result.backendStop, null);
    assert.deepEqual(
      result.testRows.slice(0, CONTRACT.length).map((r) => [r.file, r.passed, r.total, r.score]),
      CONTRACT.map((e) => [e.file, e.tests, e.tests, e.max]),
    );
    assert.deepEqual(result.warnings, []);
  });

  it("creates one backend for the attempt, by the bare image Id, on an ephemeral port", async () => {
    const h = harness();
    await scoreHiddenRows(ATTEMPT, ATTEMPT_DIR, h.deps);
    assert.equal(h.created.length, 1);
    assert.deepEqual(h.created[0], { attemptDir: ATTEMPT_DIR, attemptName: ATTEMPT, image: `sha256:${"a".repeat(64)}`, hostPort: "ephemeral" });
  });

  // -------------------------------------------------------------------------
  // (b) each file talks to its own container
  // -------------------------------------------------------------------------

  it("runs each file right after the start of its own container, on that container's base URL", async () => {
    const h = harness();
    await scoreHiddenRows(ATTEMPT, ATTEMPT_DIR, h.deps);
    for (const [i, entry] of CONTRACT.entries()) {
      const file = h.events.indexOf(`file:${entry.file}@http://127.0.0.1:${40001 + i}`);
      assert.ok(file !== -1, `${entry.file} ran on its own container's URL`);
      assert.equal(h.events.slice(0, file).filter((e) => e === "start").length, i + 1);
      assert.equal(h.events[file - 1], "start", `${entry.file}: nothing between the start and the file`);
    }
  });

  // start() returned ready only after a 2xx from /api/v1/health; a crash after
  // that is the model's, and shows as the file's failures and an exited container.
  it("a backend that dies right after its health check is the model's: the file's failures score, with a warning", async () => {
    const h = harness();
    const second = CONTRACT[1]!;
    h.deps.runContractFile = async (entry, baseUrl) => {
      h.events.push(`file:${entry.file}@${baseUrl}`);
      if (entry.file !== second.file) return tap(entry);
      return tap(entry, Array.from({ length: entry.tests }, (_, i) => `connection refused ${i}`));
    };
    h.backend.servingStates = [{ kind: "running" }, { kind: "exited", exitCode: 1 }];
    const result = await scoreHiddenRows(ATTEMPT, ATTEMPT_DIR, h.deps);
    const row = result.testRows.find((r) => r.file === second.file)!;
    assert.equal(row.passed, 0);
    assert.equal(row.total, second.tests);
    assert.equal(row.note, undefined);
    assert.ok(h.log.some((line) => line.includes(`warning: the backend container exited with code 1 during ${second.file}`)));
    assert.equal(result.backendStop, null);
    assert.equal(result.testRows[2]!.passed, CONTRACT[2]!.tests, "the next file meets a fresh backend");
  });

  // -------------------------------------------------------------------------
  // (c) a backend left busy by one file does not reach the next
  // -------------------------------------------------------------------------

  it("a backend a file left blocked (an abandoned slow request) is not the one the next file meets", async () => {
    const blocked = new Set<number>();
    const h = harness();
    h.deps.runContractFile = async (entry, baseUrl) => {
      h.events.push(`file:${entry.file}@${baseUrl}`);
      const instance = h.backend.instance!;
      // A blocked backend answers nothing: every test times out.
      if (blocked.has(instance)) return tap(entry, Array.from({ length: entry.tests }, (_, i) => `timed out ${i}`));
      if (entry.file === CONTRACT[0]!.file) {
        blocked.add(instance); // its last test abandoned a request the planner keeps computing
        return tap(entry, ["a slow request the client gave up on"]);
      }
      return tap(entry);
    };
    const result = await scoreHiddenRows(ATTEMPT, ATTEMPT_DIR, h.deps);
    assert.equal(result.testRows[0]!.passed, CONTRACT[0]!.tests - 1);
    for (const [i, entry] of CONTRACT.entries()) {
      if (i === 0) continue;
      assert.equal(result.testRows[i]!.passed, entry.tests, `${entry.file} ran against a fresh backend`);
    }
  });

  // -------------------------------------------------------------------------
  // (d) the first start failing is a backend stop
  // -------------------------------------------------------------------------

  it("a first start that fails is a backend stop: no file runs, no retry, no E2E, and the frontend is still served", async () => {
    const h = harness({}, { backend: "stop:boot: exited 1", frontend: "ok", url: "http://localhost:5173/" });
    h.backend.startResults = [{ kind: "stop", stage: "boot", detail: "the server exited with code 1 before /api/v1/health answered" }];
    const result = await scoreHiddenRows(ATTEMPT, ATTEMPT_DIR, h.deps);
    assert.equal(result.backendStop, "stop:boot: the server exited with code 1 before /api/v1/health answered");
    assert.equal(h.backend.starts, 1);
    assert.equal(h.events.filter((e) => e.startsWith("file:") || e.startsWith("e2e:")).length, 0);
    assert.deepEqual(result.testRows, []);
    assert.ok(h.events.includes("serve"), "serve-attempt still decides the frontend stop");
    assert.ok(h.events.includes("build"), "the build still runs, so a failing one makes both stops");
    assert.equal(result.frontendStop, null);
    assert.equal(result.e2eBackendNote, null);
    assert.deepEqual(result.warnings, []);
    assert.equal(h.backend.disposals, 1);
  });

  it("a layout or install stop is a backend stop before any container starts", async () => {
    for (const step of ["layout", "install"] as const) {
      const h = harness();
      const stop: StepResult = { kind: "stop", stage: step, detail: `${step} failed` };
      if (step === "layout") h.backend.layout = stop;
      else h.backend.installed = stop;
      const result = await scoreHiddenRows(ATTEMPT, ATTEMPT_DIR, h.deps);
      assert.equal(result.backendStop, `stop:${step}: ${step} failed`);
      assert.equal(h.backend.starts, 0);
      assert.equal(h.backend.disposals, 1);
    }
  });

  // -------------------------------------------------------------------------
  // (e) a later start failing zeroes only that file's row
  // -------------------------------------------------------------------------

  it("a later start that fails after its retry zeroes only that row, with the reason, and the next file still runs", async () => {
    const h = harness();
    // Starts 1 and 2 serve files 1 and 2; starts 3 and 4 (file 3 and its retry) fail.
    h.backend.startResults = [
      { kind: "ready", baseUrl: "http://127.0.0.1:40001", container: "serve-1" },
      { kind: "ready", baseUrl: "http://127.0.0.1:40002", container: "serve-2" },
      { kind: "stop", stage: "boot", detail: "exited 1" },
      { kind: "stop", stage: "health", detail: "no 2xx from GET /api/v1/health within 60 s" },
    ];
    const result = await scoreHiddenRows(ATTEMPT, ATTEMPT_DIR, h.deps);
    const third = CONTRACT[2]!;
    assert.equal(result.backendStop, null);
    assert.equal(h.backend.starts, CONTRACT.length + 1);
    const row = result.testRows.find((r) => r.file === third.file)!;
    assert.equal(row.passed, 0);
    assert.equal(row.score, 0);
    assert.equal(row.total, third.tests);
    assert.match(row.note!, new RegExp(`not again for ${third.file.replace(".", "\\.")}: 2 starts, the last a health failure`));
    assert.match(row.failed![0]!, /^not run: /);
    assert.ok(!h.events.some((e) => e.startsWith(`file:${third.file}`)));
    for (const entry of CONTRACT.filter((e) => e !== third)) {
      assert.equal(result.testRows.find((r) => r.file === entry.file)!.passed, entry.tests);
    }
    assert.ok(h.log.some((line) => /did not come up .*; retrying/.test(line)));
  });

  it("a restart failure's note reaches the CSV as one line that a CSV parser reads back whole", async () => {
    const h = harness();
    const detail = 'Traceback (most recent call last):\n  File "app/main.py", line 3, in <module>\n    raise RuntimeError("seed, broken")\nRuntimeError: seed, broken';
    h.backend.startResults = [
      { kind: "ready", baseUrl: "http://127.0.0.1:40001", container: "serve-1" },
      { kind: "stop", stage: "boot", detail },
      { kind: "stop", stage: "boot", detail },
    ];
    const result = await scoreHiddenRows(ATTEMPT, ATTEMPT_DIR, h.deps);
    const heuristics = { codeStructure: { score: 1, notes: "x" }, techStack: { score: 1, notes: "x" }, selfVerification: { score: 1, notes: "x" } };
    const cells = assembleCells(result.testRows, heuristics, { backend: result.backendStop, frontend: result.frontendStop }, result.e2eBackendNote);
    const csv = renderCsv(cells, "1min 0s", "16.10.2026 10:00");
    const records = parseCsv(csv, { columns: true, skip_empty_lines: true }) as { Criterion: string; Score: string; Max: string; Notes: string }[];
    assert.equal(records.length, HARD_RUBRIC_ROWS.length);
    const row = records.find((r) => r.Criterion === CONTRACT[1]!.row)!;
    assert.equal(row.Score, "0");
    assert.ok(!/[\r\n]/.test(row.Notes), "one line");
    assert.match(row.Notes, /^not run: the backend booted for the first contract file but not again for planner-assignment\.test\.ts: 2 starts, the last a boot failure: Traceback/);
    assert.match(row.Notes, /raise RuntimeError\("seed, broken"\) RuntimeError: seed, broken$/);
    assert.equal(csv.trimEnd().split("\n").length, HARD_RUBRIC_ROWS.length + 1, "no note breaks a CSV line");
  });

  it("a later start that succeeds on its retry scores the file", async () => {
    const h = harness();
    h.backend.startResults = [
      { kind: "ready", baseUrl: "http://127.0.0.1:40001", container: "serve-1" },
      { kind: "stop", stage: "boot", detail: "exited 1" },
    ];
    const result = await scoreHiddenRows(ATTEMPT, ATTEMPT_DIR, h.deps);
    assert.equal(result.testRows[1]!.passed, CONTRACT[1]!.tests);
    assert.equal(h.backend.starts, CONTRACT.length + 1);
  });

  it("restartRetries 0 gives a later start no retry", async () => {
    const h = harness({ limits: { restartRetries: 0 } });
    h.backend.startResults = [
      { kind: "ready", baseUrl: "http://127.0.0.1:40001", container: "serve-1" },
      { kind: "stop", stage: "boot", detail: "exited 1" },
    ];
    const result = await scoreHiddenRows(ATTEMPT, ATTEMPT_DIR, h.deps);
    assert.equal(h.backend.starts, CONTRACT.length);
    assert.equal(result.testRows[1]!.score, 0);
    assert.match(result.testRows[1]!.note!, /1 start, the last a boot failure/);
  });

  // -------------------------------------------------------------------------
  // (f) infra is a HarnessFault
  // -------------------------------------------------------------------------

  it("an infra start is a HarnessFault: nothing served, the backend disposed", async () => {
    const h = harness();
    h.backend.startResults = [
      { kind: "ready", baseUrl: "http://127.0.0.1:40001", container: "serve-1" },
      { kind: "infra", detail: "docker run -d exited 125" },
    ];
    await assert.rejects(scoreHiddenRows(ATTEMPT, ATTEMPT_DIR, h.deps), (e: Error) => e instanceof HarnessFault && /starting the backend for planner-assignment\.test\.ts: docker run -d exited 125/.test(e.message));
    assert.ok(!h.events.includes("serve"));
    assert.equal(h.backend.disposals, 1);
  });

  it("an infra layout or install is a HarnessFault", async () => {
    for (const step of ["layout", "install"] as const) {
      const h = harness();
      const infra: StepResult = { kind: "infra", detail: `${step} infra` };
      if (step === "layout") h.backend.layout = infra;
      else h.backend.installed = infra;
      await assert.rejects(scoreHiddenRows(ATTEMPT, ATTEMPT_DIR, h.deps), (e: Error) => e instanceof HarnessFault && e.message.includes(`${step} infra`));
      assert.equal(h.backend.disposals, 1);
    }
  });

  it("an image that cannot be resolved is a HarnessFault before any backend exists", async () => {
    const h = harness({
      imageId: () => {
        throw new Error("no such image");
      },
    });
    await assert.rejects(scoreHiddenRows(ATTEMPT, ATTEMPT_DIR, h.deps), (e: Error) => e instanceof HarnessFault && /no such image/.test(e.message));
    assert.equal(h.created.length, 0);
  });

  // -------------------------------------------------------------------------
  // (g) what became of the container during a file
  // -------------------------------------------------------------------------

  it("a container that exited during a file is a warning, logged and returned for the hidden results, and the file's TAP still scores the row", async () => {
    const h = harness();
    h.backend.servingStates = [{ kind: "running" }, { kind: "exited", exitCode: 137 }];
    const result = await scoreHiddenRows(ATTEMPT, ATTEMPT_DIR, h.deps);
    assert.ok(h.log.some((line) => /warning: the backend container exited with code 137 during planner-assignment\.test\.ts/.test(line)));
    assert.deepEqual(result.warnings, [EXITED_137]);
    assert.equal(result.testRows[1]!.passed, CONTRACT[1]!.tests);
  });

  it("a container that vanished during a file, or a daemon that cannot say, is a HarnessFault", async () => {
    for (const state of [{ kind: "vanished" }, { kind: "unknown", detail: "docker inspect timed out" }] as ServingState[]) {
      const h = harness();
      h.backend.servingStates = [state];
      await assert.rejects(scoreHiddenRows(ATTEMPT, ATTEMPT_DIR, h.deps), HarnessFault);
      assert.equal(h.backend.disposals, 1);
    }
  });

  // -------------------------------------------------------------------------
  // (h) the backend is disposed on every path
  // -------------------------------------------------------------------------

  it("a container stop that cannot be proven is a HarnessFault", async () => {
    const h = harness();
    h.backend.removal = { removed: false, detail: "docker rm -f timed out" };
    await assert.rejects(scoreHiddenRows(ATTEMPT, ATTEMPT_DIR, h.deps), (e: Error) => e instanceof HarnessFault && /after api-contract\.test\.ts: docker rm -f timed out/.test(e.message));
    assert.equal(h.backend.disposals, 1);
  });

  it("containers the disposal cannot prove gone are a HarnessFault, and nothing is served", async () => {
    const h = harness();
    h.backend.leftovers = [{ removed: false, detail: "agrav-backend-1 is still there" }];
    await assert.rejects(scoreHiddenRows(ATTEMPT, ATTEMPT_DIR, h.deps), (e: Error) => e instanceof HarnessFault && /agrav-backend-1 is still there/.test(e.message));
    assert.ok(!h.events.includes("serve"));
  });

  it("a test runner that was killed or a summary that does not add up still disposes the backend", async () => {
    const killed = harness({ runContractFile: async () => ({ status: null, signal: "SIGTERM", stdout: "", stderr: "" }) });
    await assert.rejects(scoreHiddenRows(ATTEMPT, ATTEMPT_DIR, killed.deps), (e: Error) => e instanceof HarnessFault && /killed by SIGTERM/.test(e.message));
    assert.equal(killed.backend.disposals, 1);

    const short = harness({ runContractFile: async (entry) => tap({ ...entry, tests: entry.tests - 1 }) });
    await assert.rejects(scoreHiddenRows(ATTEMPT, ATTEMPT_DIR, short.deps), (e: Error) => e instanceof HarnessFault && /the manifest declares/.test(e.message));
    assert.equal(short.backend.disposals, 1);
  });

  it("an unexpected throw still disposes the backend and is not swallowed", async () => {
    const h = harness({
      runContractFile: async () => {
        throw new TypeError("boom");
      },
    });
    await assert.rejects(scoreHiddenRows(ATTEMPT, ATTEMPT_DIR, h.deps), TypeError);
    assert.equal(h.backend.disposals, 1);
  });

  it("a signal aborts the running child and waits for its group, removes the contract containers, then stops serving; every exit kills what still runs, removes the containers again and a Playwright output", () => {
    const abort = (): void => {};
    const hooks = interruptHooks(abort);
    assert.deepEqual(hooks.cleanups, [abort, stopAllProcesses, stopAllBackends, stopServing]);
    assert.deepEqual(hooks.exitCleanups, [killAllProcessesSync, stopAllBackendsSync, removePlaywrightOutputsSync]);
  });

  it("a signal during a contract file ends it at once: a HarnessFault, nothing served, the backend disposed", { timeout: 5_000 }, async () => {
    const op = operator();
    const h = harness({ interrupted: op.interrupted, abortSignal: op.abortSignal });
    let files = 0;
    h.deps.runContractFile = (entry, baseUrl, signal) =>
      untilAborted(signal, () => {
        h.events.push(`file:${entry.file}@${baseUrl}`);
        files++;
        setTimeout(() => op.send("SIGTERM"), 20); // the file would otherwise never end
      });
    await assert.rejects(scoreHiddenRows(ATTEMPT, ATTEMPT_DIR, h.deps), (e: Error) => e instanceof HarnessFault && /^interrupted by SIGTERM before finishing api-contract\.test\.ts$/.test(e.message));
    assert.equal(files, 1);
    assert.equal(h.backend.starts, 1);
    assert.ok(!h.events.includes("servingState"), "the killed file's container is not judged");
    assert.ok(!h.events.includes("serve"));
    assert.equal(h.backend.disposals, 1);
  });

  it("a signal during the build or an E2E file ends it at once, and nothing runs after it", { timeout: 5_000 }, async () => {
    for (const during of ["build", "e2e"] as const) {
      const op = operator();
      const h = harness({ interrupted: op.interrupted, abortSignal: op.abortSignal });
      const stuck = (signal: AbortSignal, event: string): Promise<ProcOutcome> =>
        untilAborted(signal, () => {
          h.events.push(event);
          setTimeout(() => op.send("SIGINT"), 20);
        });
      if (during === "build") h.deps.build = (_dir, signal) => stuck(signal, "build");
      else h.deps.runE2EFile = (entry, signal) => stuck(signal, `e2e:${entry.file}`);
      const expected = during === "build" ? /^interrupted by SIGINT before finishing npm run build$/ : new RegExp(`^interrupted by SIGINT before finishing ${E2E[0]!.file.replace(".", "\\.")}$`);
      await assert.rejects(scoreHiddenRows(ATTEMPT, ATTEMPT_DIR, h.deps), (e: Error) => e instanceof HarnessFault && expected.test(e.message));
      assert.equal(h.events.filter((e) => e.startsWith("e2e:")).length, during === "build" ? 0 : 1, during);
    }
  });

  it("after a signal no further container is started, nothing is served, and the backend is disposed", async () => {
    let signal: "SIGINT" | null = null;
    const h = harness({ interrupted: () => signal });
    const stop = h.backend.stop.bind(h.backend);
    h.backend.stop = async () => {
      signal = "SIGINT"; // arrives once the first file has finished
      return stop();
    };
    await assert.rejects(scoreHiddenRows(ATTEMPT, ATTEMPT_DIR, h.deps), (e: Error) => e instanceof HarnessFault && /interrupted by SIGINT before starting the backend for planner-assignment\.test\.ts/.test(e.message));
    assert.equal(h.backend.starts, 1);
    assert.ok(!h.events.includes("serve"));
    assert.equal(h.backend.disposals, 1);
  });

  it("a signal after the contract files' last one starts no serve-attempt", async () => {
    let signal: "SIGTERM" | null = null;
    const h = harness({ interrupted: () => signal });
    const stop = h.backend.stop.bind(h.backend);
    h.backend.stop = async () => {
      if (h.backend.starts === CONTRACT.length) signal = "SIGTERM"; // the last file's container
      return stop();
    };
    await assert.rejects(scoreHiddenRows(ATTEMPT, ATTEMPT_DIR, h.deps), /interrupted by SIGTERM before serving the attempt/);
    assert.ok(!h.events.includes("serve"));
  });

  // -------------------------------------------------------------------------
  // (i) the E2E still meets a backend of its own
  // -------------------------------------------------------------------------

  it("serves once, after the last contract container is gone, then builds and runs the E2E", async () => {
    const h = harness();
    const result = await scoreHiddenRows(ATTEMPT, ATTEMPT_DIR, h.deps);
    const at = (e: string): number => h.events.indexOf(e);
    assert.equal(h.events.filter((e) => e === "serve").length, 1);
    assert.ok(at("dispose") < at("serve"), "the contract backend is disposed before serve-attempt starts its own");
    assert.ok(h.events.lastIndexOf("stop") < at("serve"));
    assert.ok(at("serve") < at("build") && at("build") < at(`e2e:${E2E[0]!.file}`));
    assert.deepEqual(result.testRows.slice(CONTRACT.length).map((r) => [r.file, r.passed]), E2E.map((e) => [e.file, e.tests]));
    assert.equal(result.e2eBackendNote, null);
    assert.equal(h.events.at(-1), "stopServing");
  });

  it("a served backend that does not come up after the contract booted zeroes flows only, with the reason", async () => {
    const h = harness({}, { backend: "stop:boot: exited 1", frontend: "ok", url: "http://localhost:5173/" });
    const result = await scoreHiddenRows(ATTEMPT, ATTEMPT_DIR, h.deps);
    assert.equal(result.backendStop, null);
    assert.equal(result.e2eBackendNote, "backend booted for hidden tests but not when served: stop:boot: exited 1");
    assert.ok(!h.events.includes("e2e:flows.spec.ts"));
    assert.ok(h.events.includes("e2e:layout.spec.ts"));
  });

  it("a frontend stop skips the build failure path and the E2E but keeps the contract rows", async () => {
    const h = harness({}, { backend: "ok", frontend: "stop: frontend/package.json is missing", url: null });
    const result = await scoreHiddenRows(ATTEMPT, ATTEMPT_DIR, h.deps);
    assert.equal(result.frontendStop, "stop: frontend/package.json is missing");
    assert.ok(!h.events.includes("build"));
    assert.equal(h.events.filter((e) => e.startsWith("e2e:")).length, 0);
    assert.equal(result.testRows.length, CONTRACT.length);
  });

  it("a failed build is a frontend stop, and no E2E runs", async () => {
    const h = harness({ build: async () => ({ status: 1, signal: null, stdout: "", stderr: "error TS2304: Cannot find name 'x'" }) });
    const result = await scoreHiddenRows(ATTEMPT, ATTEMPT_DIR, h.deps);
    assert.match(result.frontendStop!, /^stop: npm run build failed: .*TS2304/);
    assert.equal(h.events.filter((e) => e.startsWith("e2e:")).length, 0);
  });
});

// ---------------------------------------------------------------------------
// (j) a signal while an attempt is scored writes nothing
// ---------------------------------------------------------------------------

describe("scoreNormalAttempt: a signal writes nothing", () => {
  const RUN = { id: "fake-model-high", model: "fake-model", effort: "high", attempt: 1, durationMs: 60_000 } as unknown as RunJson;

  function resultsDir(): string {
    return mkdtempSync(join(tmpdir(), "score-hard-signal-"));
  }

  it("a signal during a contract file: the attempt fails at once, its backend disposed, and no file is written", { timeout: 10_000 }, async () => {
    const dir = resultsDir();
    try {
      const op = operator();
      const h = harness({ interrupted: op.interrupted, abortSignal: op.abortSignal });
      h.deps.runContractFile = (_entry, _baseUrl, signal) => untilAborted(signal, () => setTimeout(() => op.send("SIGTERM"), 20));
      await assert.rejects(scoreNormalAttempt(ATTEMPT, RUN, dir, h.deps), (e: Error) => e instanceof HarnessFault && /interrupted by SIGTERM/.test(e.message));
      assert.equal(h.backend.disposals, 1);
      assert.deepEqual(readdirSync(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a signal after the hidden rows were scored writes no CSV and no hidden-results-hard.json", { timeout: 10_000 }, async () => {
    const dir = resultsDir();
    try {
      const op = operator();
      const h = harness({ interrupted: op.interrupted, abortSignal: op.abortSignal });
      let stops = 0;
      // The second stopServing is scoreHiddenRows' last step: the rows are in.
      h.deps.stopServing = () => {
        if (++stops === 2) op.send("SIGHUP");
      };
      await scoreNormalAttempt(ATTEMPT, RUN, dir, h.deps);
      assert.equal(stops, 2);
      assert.equal(h.events.filter((e) => e.startsWith("e2e:")).length, E2E.length, "every row was scored");
      assert.deepEqual(readdirSync(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("with no signal the same attempt writes both files (the two tests above are not vacuous), and records no warning as []", { timeout: 10_000 }, async () => {
    const dir = resultsDir();
    try {
      const h = harness();
      await scoreNormalAttempt(ATTEMPT, RUN, dir, h.deps);
      assert.ok(existsSync(join(dir, ATTEMPT, "eval-results.csv")));
      const hidden = parseHardHiddenResults(readFileSync(join(dir, ATTEMPT, "hidden-results-hard.json"), "utf8"));
      assert.deepEqual(hidden.warnings, [], "written even when empty, so it reads as none rather than not recorded");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a container that exited during a file is recorded in hidden-results-hard.json, and no row or CSV cell changes", { timeout: 15_000 }, async () => {
    const written = async (states: ServingState[]): Promise<{ hidden: ReturnType<typeof parseHardHiddenResults>; csv: string }> => {
      const dir = resultsDir();
      try {
        const h = harness();
        h.backend.servingStates = states;
        await scoreNormalAttempt(ATTEMPT, RUN, dir, h.deps);
        const csv = readFileSync(join(dir, ATTEMPT, "eval-results.csv"), "utf8");
        return {
          hidden: parseHardHiddenResults(readFileSync(join(dir, ATTEMPT, "hidden-results-hard.json"), "utf8")),
          // The Test run row is the clock's
          csv: csv.split("\n").filter((line) => !line.startsWith("Test run,")).join("\n"),
        };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    const exited = await written([{ kind: "running" }, { kind: "exited", exitCode: 137 }]);
    const clean = await written([]);
    assert.deepEqual(exited.hidden.warnings, [EXITED_137]);
    assert.deepEqual(exited.hidden.rows, clean.hidden.rows);
    assert.equal(exited.csv, clean.csv);
  });
});
