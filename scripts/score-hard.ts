/**
 * score-hard.ts — Score hard track attempts according to tracks/console-hard/benchmark/criteria.md.
 *
 * Runs contract tests (6 files from the manifest, each against a freshly
 * started backend), Playwright E2E tests (2 files from the manifest, against
 * one serve-attempt started after the contract files), and evaluates agent
 * criteria via heuristics. Generates eval-results.csv and
 * hidden-results-hard.json for each attempt.
 *
 * The pure scoring rules (parsers, CSV cells, stop table, hidden-results file)
 * live in scripts/lib/hard-score.ts and are unit-tested there. This file is
 * orchestration: spawn processes, apply the rules, write the outputs.
 *
 * Signal-sensitive: invoke it as `node --import tsx scripts/score-hard.ts`,
 * never through the tsx bin. The contract test files, the build and the
 * Playwright runs are spawned detached (`runProcess`), so an operator's
 * Ctrl-C reaches score-hard (and a serve-attempt or docker command it
 * started), not the test file, build or Playwright run. Its first signal ends
 * the one running: SIGTERM to its group, SIGKILL only if a member is left
 * after the grace, waited for; then the contract containers and any
 * serve-attempt go, nothing is written for the attempt, and it exits 128+N.
 * Ctrl-Z, likewise, stops score-hard (and a serve-attempt or docker command
 * it started, which share its group), not the running test file, build or
 * Playwright run. A SIGKILLed score-hard leaves that child running. It ends
 * by itself at its next write to the pipe that closed with score-hard
 * (EPIPE): a `node --test` file within its next test; an `npm run build` at
 * the next line Vite prints, which it does between its build phases (cut
 * mid-transform, a build died at the end of that phase, before writing
 * dist/); while Playwright's JSON reporter writes only at the end, so it runs
 * its file through first. The contract containers and their scratch
 * directory stay until the next `serve-attempt` or `serve-attempt --stop` —
 * which score-hard runs before each attempt — removes them with
 * `sweepDeadOwners`; a serve-attempt score-hard started, if it is still
 * serving, is stopped by that `--stop`.
 *
 * Usage:
 *   node --import tsx scripts/score-hard.ts [--attempt <id>] [--force]
 *       [--results-dir <path>]
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { ContractBackend } from "./contract-tests";
import { AttemptBackend, stopAllBackends, stopAllBackendsSync, type BackendOptions } from "./lib/attempt-backend";
import { groupAlive, killAllProcessesSync, killAndWait, stopAllProcesses, trackProcess } from "./lib/dev-server";
import { resolveImageId } from "./lib/docker";
import {
  BACKEND_STOP_ZERO,
  FRONTEND_STOP_ZERO,
  HarnessFault,
  type HardHiddenResults,
  type ManifestEntry,
  type ProcOutcome,
  type RowCell,
  allZero,
  applyStops,
  classifyReserveStop,
  csvNote,
  formatDuration,
  formatTestRun,
  loadManifest,
  parseNodeTap,
  parseNodeTapFailedNames,
  parsePlaywrightJson,
  parsePlaywrightJsonFailedNames,
  renderCsv,
  requireCompleted,
  writeHardHiddenResults,
} from "./lib/hard-score";
import { hardRubricId } from "./lib/hard-rubric";
import { installInterruptHandlers, type InterruptHooks, type InterruptSignal } from "./lib/interrupt";
import {
  JUDGE_ROWS_FILE,
  readJudgeRowsHard,
  type JudgeRowsHard,
} from "./lib/judge-rows-hard";
import { roundScore } from "./lib/rubric";
import { installedE2EPinMismatches } from "./lib/scorer-freeze";
import { LIMITS, type Limits } from "./lib/rubric";
import type { RunJson } from "./lib/run-json";
import { readRunJson } from "./lib/run-json";
import { readScoringImage } from "./lib/runner-config";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HARD_ROOT = join(ROOT, "tracks", "console-hard");
const ATTEMPTS_DIR = join(HARD_ROOT, "eval-attempts");
const DEFAULT_RESULTS_DIR = join(HARD_ROOT, "eval-results");
const TESTS_DIR = join(HARD_ROOT, "benchmark", "contract-tests");
const E2E_TESTS_DIR = join(HARD_ROOT, "benchmark", "e2e-tests");
const E2E_CONFIG = join(E2E_TESTS_DIR, "playwright.config.ts");

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export type AttemptClassification =
  | { kind: "refuse"; reason: string }
  | { kind: "model-failure"; reason: string }
  | { kind: "normal" };

/** Decide what to do with an attempt based on its run.json, without spawning anything. */
export function classifyAttempt(run: RunJson): AttemptClassification {
  if (run.failureKind === "infra") {
    return { kind: "refuse", reason: `run.json records an infra failure: not a data point` };
  }
  if (run.softDenied) {
    return { kind: "refuse", reason: `run.json records softDenied: a tool was blocked, not a data point` };
  }
  if (run.failureKind === "model") {
    const error = (run.envelope?.error || run.stderrTail || "no error recorded").slice(0, 200);
    return { kind: "model-failure", reason: `model failure: ${error}` };
  }
  return { kind: "normal" };
}

/** Determine whether a frontend stop applies, based on serve-attempt state. */
export function frontendStopReason(frontendStatus: string, url: string | null): string | null {
  if (frontendStatus !== "ok") return frontendStatus;
  if (url === null) return "stop: dev server did not start";
  if (!url.includes(":5173")) return `stop: dev server not on 5173 (${url})`;
  return null;
}

/** Row data from a test run (contract or E2E), carried to assembleCells and hidden results. */
export interface TestRowResult {
  row: string;
  file: string;
  passed: number;
  total: number;
  max: number;
  score: number;
  failed?: string[];
  /** The CSV note when it is not "N of M passed": a contract file whose backend did not come up again. */
  note?: string;
}

/** Visual design score and note while no human review is available. */
export const VISUAL_DESIGN_DEFAULT: Readonly<RowCell> = Object.freeze({ score: 0, notes: "default 0, not human-reviewed (criteria require a human score)" });

/**
 * Ensure hidden-results rows contain all 8 manifest entries (6 contract + 2 E2E).
 * Rows present in `testRows` keep their data; missing rows get `passed: 0, score: 0`.
 *
 * When `e2eBackendNote` is provided and the `Frontend E2E: flows` row is missing
 * (criteria.md stop rules row 5), the completed entry carries the reason in
 * `failed: ["not run: <note>"]`.
 */
export function completeHiddenRows(
  testRows: TestRowResult[],
  contractManifest: ManifestEntry[],
  e2eManifest: ManifestEntry[],
  e2eBackendNote?: string | null,
): TestRowResult[] {
  const all = [...contractManifest, ...e2eManifest];
  return all.map((entry) => {
    const existing = testRows.find((tr) => tr.file === entry.file);
    if (existing) return existing;
    const base: TestRowResult = { row: entry.row, file: entry.file, passed: 0, total: entry.tests, max: entry.max, score: 0 };
    // criteria.md row 5: record reason when flows was not run because the served backend did not come up
    if (e2eBackendNote && entry.row === "Frontend E2E: flows") {
      base.failed = [`not run: ${e2eBackendNote}`];
    }
    return base;
  });
}

/**
 * Build the Map<string, RowCell> from test results, heuristics, and stops.
 * Does no I/O — pure data assembly.
 *
 * `e2eBackendNote`: when the backend booted for the hidden tests but did not
 * come up on a fresh serve for the E2E (criteria.md stop rules, row 5),
 * `Frontend E2E: flows` is zeroed with this note.
 */
export function assembleCells(
  testRows: TestRowResult[],
  heuristics: { codeStructure: { score: number; notes: string }; techStack: { score: number; notes: string }; selfVerification: { score: number; notes: string } },
  stops: { backend: string | null; frontend: string | null },
  e2eBackendNote?: string | null,
): Map<string, RowCell> {
  const cells = new Map<string, RowCell>();

  // Test rows from actual results
  for (const tr of testRows) {
    cells.set(tr.row, { score: tr.score, notes: tr.note ?? `${tr.passed} of ${tr.total} passed` });
  }

  // criteria.md row 5: backend booted for hidden tests but not when served
  if (e2eBackendNote) {
    cells.set("Frontend E2E: flows", { score: 0, notes: e2eBackendNote });
  }

  // Local build: 1 only if neither stop applies
  const localBuild = stops.backend === null && stops.frontend === null ? 1 : 0;
  const localBuildNotes = localBuild === 1
    ? "backend booted; frontend built and dev server served on 5173"
    : stops.backend !== null ? `backend ${stops.backend}` : `frontend ${stops.frontend}`;
  cells.set("Local build", { score: localBuild, notes: localBuildNotes });

  // Agent heuristics
  cells.set("Code structure", { score: heuristics.codeStructure.score, notes: heuristics.codeStructure.notes });
  cells.set("Tech stack & run contract", { score: heuristics.techStack.score, notes: heuristics.techStack.notes });
  cells.set("Self-verification", { score: heuristics.selfVerification.score, notes: heuristics.selfVerification.notes });

  // Visual design: default 0, not human-reviewed
  cells.set("Visual design", { score: VISUAL_DESIGN_DEFAULT.score, notes: VISUAL_DESIGN_DEFAULT.notes });

  // Penalty: not assessed
  cells.set("Penalty", { score: 0, notes: "not assessed (no judge)" });

  // Apply stop rules — they override the cells above
  return applyStops(cells, stops);
}

/**
 * Overlay judge/human rows from `judge-rows-hard.json` onto the cells,
 * respecting stop zeroing. A row zeroed by a stop keeps its zero.
 */
export function applyJudgeRows(
  cells: Map<string, RowCell>,
  judgeRows: JudgeRowsHard,
  stops: { backend: string | null; frontend: string | null },
): Map<string, RowCell> {
  const out = new Map(cells);
  const bothStopped = stops.backend !== null && stops.frontend !== null;
  for (const [name, value] of Object.entries(judgeRows.rows)) {
    if (bothStopped) continue; // all-zero CSV
    if (stops.backend !== null && BACKEND_STOP_ZERO.includes(name)) continue;
    if (stops.frontend !== null && FRONTEND_STOP_ZERO.includes(name)) continue;
    out.set(name, { score: value!.score, notes: value!.note });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function stopServing(): void {
  spawnSync("node", ["--import", "tsx", "scripts/serve-attempt.ts", "--stop", "--root", "tracks/console-hard"], {
    cwd: ROOT,
    stdio: "pipe",
    timeout: 30000,
  });
}

/**
 * For `installInterruptHandlers`: on the first signal, `abort` (the running
 * test file, build or Playwright run gets SIGTERM at once, see `runProcess`),
 * then `stopAllProcesses`, which waits for its group to go — SIGKILL only if
 * a member is left after dev-server.ts's grace, so a build or a Playwright
 * run can finish shutting down — then the contract backend's containers, then
 * any serve-attempt. On every exit, synchronously: a SIGKILL for any group
 * still tracked, the contract containers once more, and a killed Playwright
 * run's output directory, for a second signal or an exit that skipped the
 * cleanups. Each runs on its own, try/caught.
 */
export function interruptHooks(abort: () => void): InterruptHooks {
  return {
    cleanups: [abort, stopAllProcesses, stopAllBackends, stopServing],
    exitCleanups: [killAllProcessesSync, stopAllBackendsSync, removePlaywrightOutputsSync],
  };
}

/**
 * How long a HarnessFault waits before exiting 1, so a signal that killed a
 * child, and made its call fail first, is seen as the interruption it is.
 */
const SIGNAL_SETTLE_MS = 200;

async function waitForServerReady(timeoutMs: number, serveProc: ChildProcess): Promise<{ isReady: boolean; state: any }> {
  const statePath = join(HARD_ROOT, ".cache", "serve-attempt.json");
  const deadline = Date.now() + timeoutMs;

  // Track whether serveProc has exited
  let procExited = false;
  let procExitCode: number | null = null;
  serveProc.on("exit", (code) => { procExited = true; procExitCode = code; });

  while (Date.now() < deadline) {
    if (existsSync(statePath)) {
      try {
        const state = JSON.parse(readFileSync(statePath, "utf8"));
        if (state.status === "ready") {
          return { isReady: true, state };
        }
      } catch {
        // ignore parse errors while writing
      }
    }
    // If serve-attempt exited before reaching ready, no point waiting
    if (procExited) {
      return { isReady: false, state: null };
    }
    await sleep(1000);
  }
  return { isReady: false, state: null };
}

// ---------------------------------------------------------------------------
// The hidden rows: contract files, build, E2E
// ---------------------------------------------------------------------------

/** What the contract files need of a backend; `AttemptBackend` is one. */
export type HardContractBackend = Pick<ContractBackend, "checkLayout" | "install" | "start" | "servingState" | "stop" | "dispose">;

/** serve-attempt's state file once it is ready: each half's status and the dev server's URL. */
export interface ServedState {
  backend: string;
  frontend: string;
  url: string | null;
}

/** Everything `scoreHiddenRows` does to the world, so a test can stand in for each. */
export interface ScoreHardDeps {
  /** Given the bare image Id (`sha256:…`) as `image`, never the tag. */
  createBackend: (options: BackendOptions) => HardContractBackend;
  /** runner.yaml's scoring image, the one serve-attempt serves with, as its bare Id. Throws when it cannot be resolved. */
  imageId: () => string;
  /** One contract file under `node --test`, against `baseUrl`; `signal` ends it at once. */
  runContractFile: (entry: ManifestEntry, baseUrl: string, signal: AbortSignal) => Promise<ProcOutcome>;
  /** serve-attempt, for the build and the E2E, once ready. A HarnessFault when it does not get there. */
  serve: (attempt: string) => Promise<ServedState>;
  stopServing: () => void;
  /** `npm run build` in `frontendDir`; `signal` ends it at once. */
  build: (frontendDir: string, signal: AbortSignal) => Promise<ProcOutcome>;
  /** One Playwright file against the served attempt; `signal` ends it at once. */
  runE2EFile: (entry: ManifestEntry, signal: AbortSignal) => Promise<ProcOutcome>;
  /** The first signal received, or `null`: nothing new is started after one. */
  interrupted: () => InterruptSignal | null;
  /** Aborted on the first signal (`interruptHooks`), so the child running then gets SIGTERM at once. */
  abortSignal: AbortSignal;
  /** Tests only: shorter limits. */
  limits: Partial<Limits>;
  out: (line: string) => void;
}

/** What the hidden-test phases decided, for `assembleCells` and the hidden-results file. */
export interface HiddenRows {
  testRows: TestRowResult[];
  backendStop: string | null;
  frontendStop: string | null;
  /** criteria.md stop rules, last row: the backend booted for the contract files but not when served. */
  e2eBackendNote: string | null;
  /** What the log warned of while the rows were scored, for hidden-results-hard.json. */
  warnings: string[];
}

/** The contract phase: a backend stop, or the six rows; and the warnings it logged. */
interface ContractPhase {
  backendStop: string | null;
  rows: TestRowResult[];
  warnings: string[];
}

/** How long `runProcess` waits for `close` once a killed run's group is gone and its pipes destroyed. */
const CLOSE_AFTER_KILL_MS = 1_000;

export interface RunProcessOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Bytes of stdout, and of stderr, kept before the child is killed; spawnSync's default. */
  maxBuffer?: number;
  signal: AbortSignal;
}

/**
 * A child, asynchronously, so a signal is answered at once rather than after
 * the child ends (spawnSync runs no JS meanwhile: a `kill -TERM` of this
 * process waited up to a file's whole budget). It leads a process group of
 * its own (`detached`), and the group, not the leader, is what is killed and
 * waited for, through dev-server.ts's plumbing rather than a registry of this
 * file's own (Ruling R26 there):
 *
 * - `signal`, `timeoutMs` and output over `maxBuffer` each start
 *   `killAndWait`: SIGTERM to the group, SIGKILL if a member is left after
 *   its grace;
 * - the child is tracked (`trackProcess`) until its group is proven gone
 *   (`groupAlive`), not merely until `close`, so the interrupt cleanup
 *   `stopAllProcesses` waits for a kill in flight and the exit cleanup
 *   `killAllProcessesSync` still reaches it;
 * - the outcome waits for that too: a member left behind once the leader
 *   closed is killed, and waited for, before this resolves;
 * - a killed run's pipes are then destroyed from this end, so a process
 *   outside the group that inherited them cannot hold the outcome past the
 *   kill. On the path with no kill nothing changes: `close` still waits for
 *   every writer, so a run whose pipes such a process keeps open ends at its
 *   timeout, a HarnessFault, as under spawnSync.
 *
 * The outcome has spawnSync's shape, so `requireCompleted` judges it as
 * before: a timeout or output over `maxBuffer` sets `error`, a kill sets
 * `signal`, and either is a HarnessFault.
 */
export function runProcess(command: string, args: string[], options: RunProcessOptions): Promise<ProcOutcome> {
  return new Promise((resolve) => {
    const maxBuffer = options.maxBuffer ?? 1024 * 1024;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let error: Error | undefined;
    let settled = false;

    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    if (child.pid !== undefined) trackProcess(child);
    let killing = false;
    let afterKill: NodeJS.Timeout | undefined;
    // Once per run: a second reason to kill joins the first.
    const kill = (): void => {
      if (settled || killing) return;
      killing = true;
      void killAndWait(child).then(() => {
        // `close` waits for every holder of the pipes, and a process outside
        // the group may hold them too (a detached daemon an attempt's build
        // started with inherited stdio): closed from this end once the group
        // is gone, they cannot keep the outcome past the kill. What was read
        // stays; what such a process writes later is not the run's.
        child.stdout.destroy();
        child.stderr.destroy();
        // `close` follows at once for a leader that exited; one that outlived
        // SIGKILL ends the run here instead, as a fault.
        afterKill = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) error ??= new Error(`${command} outlived SIGKILL`);
          finish(child.exitCode, child.signalCode);
        }, CLOSE_AFTER_KILL_MS);
      });
    };
    const finish = (status: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(afterKill);
      options.signal.removeEventListener("abort", kill);
      const outcome: ProcOutcome = { status, signal, error, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") };
      const done = (): void => resolve(outcome);
      // `close` means the pipes closed, not that the group is gone: what the
      // child started without them can outlive it.
      if (child.pid !== undefined && groupAlive(child.pid)) killAndWait(child).then(done, done);
      else done();
    };

    child.stdout.on("data", (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > maxBuffer) {
        error ??= new Error(`${command}: stdout over ${maxBuffer} bytes (ENOBUFS)`);
        kill();
      } else out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errBytes += chunk.length;
      if (errBytes > maxBuffer) {
        error ??= new Error(`${command}: stderr over ${maxBuffer} bytes (ENOBUFS)`);
        kill();
      } else err.push(chunk);
    });
    const timer = setTimeout(() => {
      error ??= new Error(`${command} timed out after ${Math.round(options.timeoutMs / 1000)} s`);
      kill();
    }, options.timeoutMs);
    if (options.signal.aborted) kill();
    else options.signal.addEventListener("abort", kill, { once: true });

    child.on("error", (spawnError) => {
      error ??= spawnError;
      // A child that never started emits no `close` to wait for.
      if (child.pid === undefined) finish(null, null);
    });
    child.on("close", (status, signal) => finish(status, signal));
  });
}

function runContractFileProcess(entry: ManifestEntry, baseUrl: string, signal: AbortSignal): Promise<ProcOutcome> {
  return runProcess("node", ["--test", "--test-reporter=tap", "--import", "tsx", join(TESTS_DIR, entry.file)], {
    cwd: ROOT,
    env: { ...process.env, CONTRACT_BASE_URL: baseUrl },
    timeoutMs: entry.tests * 30_000,
    maxBuffer: 32 * 1024 * 1024,
    signal,
  });
}

async function serveForE2E(attempt: string): Promise<ServedState> {
  // Not detached: shares the process group for signal cleanup
  console.log(`[${attempt}] Starting serve-attempt for the build and the E2E...`);
  const serveProc = spawn("node", ["--import", "tsx", "scripts/serve-attempt.ts", "--attempt", attempt, "--root", "tracks/console-hard"], {
    cwd: ROOT,
    stdio: "pipe",
  });
  const readyTimeout = LIMITS.pipInstallMs + LIMITS.npmInstallMs + 120_000;
  const { isReady, state } = await waitForServerReady(readyTimeout, serveProc);
  if (!isReady || !state) {
    stopServing();
    throw new HarnessFault(`serve-attempt for ${attempt} did not reach ready within ${Math.round(readyTimeout / 1000)}s`);
  }
  return { backend: state.backend, frontend: state.frontend, url: state.url };
}

function runBuild(frontendDir: string, signal: AbortSignal): Promise<ProcOutcome> {
  return runProcess("npm", ["run", "build"], { cwd: frontendDir, timeoutMs: 600_000, signal });
}

/** Playwright `--output` directories not yet removed. */
const playwrightOutputs = new Set<string>();

/**
 * For `exitCleanups`: remove the Playwright output directory of a run still
 * going, since a signal's exit comes before that run's own `finally`.
 */
export function removePlaywrightOutputsSync(): void {
  for (const dir of playwrightOutputs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // each individually
    }
  }
  playwrightOutputs.clear();
}

async function runE2EFileProcess(entry: ManifestEntry, signal: AbortSignal): Promise<ProcOutcome> {
  const pwOut = mkdtempSync(join(tmpdir(), "score-hard-pw-"));
  playwrightOutputs.add(pwOut);
  const budgetMs = entry.tests * 2 /* retries: 1 */ * 60_000 + 120_000;
  try {
    // --no-install: never fetch a Playwright from the registry; the pinned one is checked at startup.
    return await runProcess("npx", ["--no-install", "playwright", "test", "--config", E2E_CONFIG, entry.file, "--reporter=json", "--trace", "off", "--output", pwOut], {
      cwd: ROOT,
      timeoutMs: budgetMs,
      maxBuffer: 64 * 1024 * 1024,
      signal,
    });
  } finally {
    rmSync(pwOut, { recursive: true, force: true });
    playwrightOutputs.delete(pwOut);
  }
}

const DEFAULT_DEPS: ScoreHardDeps = {
  createBackend: (options) => new AttemptBackend(options),
  imageId: () => resolveImageId(readScoringImage(ROOT)).id,
  runContractFile: runContractFileProcess,
  serve: serveForE2E,
  stopServing,
  build: runBuild,
  runE2EFile: runE2EFileProcess,
  interrupted: () => null,
  abortSignal: new AbortController().signal,
  limits: {},
  out: (line) => console.log(line),
};

/** After a signal, nothing new is started; `main` sees `interrupted()` and writes nothing for the attempt. */
function requireNotInterrupted(d: ScoreHardDeps, before: string): void {
  const signal = d.interrupted();
  if (signal !== null) throw new HarnessFault(`interrupted by ${signal} before ${before}`);
}

function oneLine(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Each contract file against a container of its own. The first start proves
 * the backend boots, so it has no retry and failing it is a backend stop; a
 * later one gets `restartRetries` more, and failing those zeroes only its own
 * row, with the reason. Infra is a HarnessFault. Never disposes the backend;
 * the caller does.
 *
 * No health probe of its own before a file: `start()` returns `ready` only
 * after `GET /api/v1/health` answered 2xx, and a second probe could only turn
 * a backend that crashed in between, the model's failure, into a HarnessFault.
 * Such a crash shows in the file's own failures and in `servingState()`
 * afterwards (`exited`: a warning, and the row scored from the TAP).
 *
 * The loop is shaped like contract-tests-hard.ts's `scoreBackend`, with one
 * difference kept from the earlier score-hard: a file runner killed by its
 * timeout (`entry.tests` × 30 s) is a HarnessFault here (`requireCompleted`),
 * where `scoreBackend` scores a timed-out file as the model's result.
 */
async function testEachFile(
  attempt: string,
  backend: HardContractBackend,
  manifest: ManifestEntry[],
  d: ScoreHardDeps,
  limits: Limits,
): Promise<ContractPhase> {
  // serve-attempt's format for a backend stop, so the Local build note reads as it did
  const stopped = (stage: string, detail: string): ContractPhase => ({ backendStop: `stop:${stage}: ${detail}`, rows: [], warnings: [] });

  const layout = backend.checkLayout();
  if (layout.kind === "infra") throw new HarnessFault(layout.detail);
  if (layout.kind === "stop") return stopped(layout.stage, layout.detail);

  d.out(`[${attempt}] Installing the backend for the contract tests (a fresh venv, pip install -r requirements.txt)...`);
  const install = await backend.install();
  if (install.kind === "infra") throw new HarnessFault(install.detail);
  if (install.kind === "stop") return stopped(install.stage, install.detail);

  d.out(`[${attempt}] Running contract tests (${manifest.length} files, each against a freshly started backend)...`);
  const rows: TestRowResult[] = [];
  const warnings: string[] = [];
  for (const [index, entry] of manifest.entries()) {
    const starts = index === 0 ? 1 : 1 + Math.max(0, limits.restartRetries);
    let baseUrl: string | null = null;
    let last: { stage: string; detail: string } | null = null;
    for (let n = 1; n <= starts && baseUrl === null; n++) {
      requireNotInterrupted(d, `starting the backend for ${entry.file}`);
      const started = await backend.start();
      if (started.kind === "infra") throw new HarnessFault(`starting the backend for ${entry.file}: ${started.detail}`);
      if (started.kind === "ready") {
        baseUrl = started.baseUrl;
        break;
      }
      last = { stage: started.stage, detail: started.detail };
      if (index > 0) {
        d.out(`[${attempt}] ${entry.file}: the backend did not come up (${started.stage}: ${oneLine(started.detail, 200)})${n < starts ? "; retrying" : ""}`);
      }
    }

    if (baseUrl === null) {
      const failure = last as { stage: string; detail: string };
      if (index === 0) return stopped(failure.stage, failure.detail);
      const note = `not run: the backend booted for the first contract file but not again for ${entry.file}: ${starts} ${starts === 1 ? "start" : "starts"}, the last a ${failure.stage} failure: ${oneLine(failure.detail)}`;
      rows.push({ row: entry.row, file: entry.file, passed: 0, total: entry.tests, max: entry.max, score: 0, failed: [note], note });
      d.out(`  - ${entry.row}: 0/${entry.max} (${note})`);
      continue;
    }

    const proc = await d.runContractFile(entry, baseUrl, d.abortSignal);
    requireNotInterrupted(d, `finishing ${entry.file}`);
    requireCompleted(entry.file, proc);

    const serving = await backend.servingState();
    if (serving.kind === "vanished") {
      throw new HarnessFault(`the backend container vanished during ${entry.file}: something outside score-hard removed it, so that file's failures are not the model's`);
    }
    if (serving.kind === "unknown") throw new HarnessFault(`after ${entry.file}: ${serving.detail}`);
    if (serving.kind === "exited") {
      const warning = `the backend container exited with code ${serving.exitCode} during ${entry.file}, so the tests after that ran against no backend (the backend crashed, or the host killed it)`;
      warnings.push(warning);
      d.out(`[${attempt}] warning: ${warning}`);
    }
    const removal = await backend.stop();
    if (!removal.removed) throw new HarnessFault(`after ${entry.file}: ${removal.detail}`);

    const { passed, total } = parseNodeTap(proc.stdout, entry.tests);
    const score = roundScore(passed, total, entry.max);
    const failed = parseNodeTapFailedNames(proc.stdout);
    rows.push({ row: entry.row, file: entry.file, passed, total, max: entry.max, score, ...(failed.length > 0 ? { failed } : {}) });
    d.out(`  - ${entry.row}: ${score}/${entry.max} (${passed} of ${total} passed)`);
  }
  return { backendStop: null, rows, warnings };
}

/**
 * The contract files, each against a freshly started backend (criteria.md:
 * "Each file runs against a freshly started backend"): the layout check and
 * `pip install` once, then per file one container, started, checked healthy,
 * tested, asked what became of it, and removed. A request one file abandoned
 * (a planner that keeps computing after the client gave up, an `async`
 * handler that blocks the event loop meanwhile) cannot reach the next file.
 * The backend is disposed on every path; a container it cannot prove gone is
 * a HarnessFault.
 */
async function scoreContractFiles(attempt: string, attemptDir: string, manifest: ManifestEntry[], d: ScoreHardDeps, limits: Limits): Promise<ContractPhase> {
  let backend: HardContractBackend;
  try {
    // By Id: a retag during the run cannot change what later containers run.
    backend = d.createBackend({ attemptDir, attemptName: attempt, image: d.imageId(), hostPort: "ephemeral" });
  } catch (error) {
    throw new HarnessFault(`could not set up the contract backend: ${(error as Error).message}`);
  }

  let result: ContractPhase | null = null;
  let failure: { error: unknown } | null = null;
  try {
    result = await testEachFile(attempt, backend, manifest, d, limits);
  } catch (error) {
    failure = { error };
  }

  let leftovers: string[];
  try {
    leftovers = (await backend.dispose()).filter((r) => !r.removed).map((r) => r.detail);
  } catch (error) {
    leftovers = [`disposing the backend threw: ${(error as Error).message}`];
  }
  if (failure !== null) {
    for (const leftover of leftovers) d.out(`[${attempt}] warning: ${leftover}`);
    throw failure.error;
  }
  if (leftovers.length > 0) throw new HarnessFault(`the contract backend left containers it could not prove removed: ${leftovers.join("; ")}`);
  return result as ContractPhase;
}

/**
 * The hidden rows of one attempt: the contract files, each against a freshly
 * started backend; then one serve-attempt, whose backend is the E2E's own
 * fresh one and whose frontend half decides the frontend stop; the build; the
 * E2E. The caller stops serving first and applies the stops.
 */
export async function scoreHiddenRows(attempt: string, attemptDir: string, deps: Partial<ScoreHardDeps> = {}): Promise<HiddenRows> {
  const d: ScoreHardDeps = { ...DEFAULT_DEPS, ...deps };
  const limits: Limits = { ...LIMITS, ...d.limits };

  // 1. Contract tests from the manifest (before serving: they need only the backend)
  const contractManifest = loadManifest(join(TESTS_DIR, "manifest.json"));
  const contract = await scoreContractFiles(attempt, attemptDir, contractManifest, d, limits);
  const testRows: TestRowResult[] = [...contract.rows];
  const backendStop = contract.backendStop;

  // 2. serve-attempt, after the last contract container is gone: the frontend
  //    half decides the frontend stop, and the backend half is the E2E's own.
  requireNotInterrupted(d, "serving the attempt");
  const state = await d.serve(attempt);
  let frontendStop = frontendStopReason(state.frontend, state.url);
  d.out(`[${attempt}] Serve-attempt ready: backend=${state.backend}, frontend=${state.frontend}`);

  // 3. npm run build — after ready, before the E2E runs (node_modules ensured by serve-attempt)
  if (frontendStop === null) {
    d.out(`[${attempt}] Running npm run build in frontend/...`);
    const build = await d.build(join(attemptDir, "frontend"), d.abortSignal);
    requireNotInterrupted(d, "finishing npm run build");
    requireCompleted("npm run build", build);
    if (build.status !== 0) {
      frontendStop = `stop: npm run build failed: ${build.stderr.slice(-300)}`;
      d.out(`[${attempt}] npm run build failed (exit ${build.status}), frontend stop.`);
    } else {
      d.out(`[${attempt}] npm run build succeeded.`);
    }
  }

  // 4. criteria.md stop rules, last row: the backend booted for the contract
  //    files but does not come up when served → Frontend E2E: flows = 0.
  let e2eBackendNote: string | null = null;
  if (backendStop === null && frontendStop === null) {
    e2eBackendNote = classifyReserveStop(true, state.backend === "ok", state.backend);
    if (e2eBackendNote !== null) d.out(`[${attempt}] Backend did not come up when served: ${e2eBackendNote}`);
  }

  // 5. E2E tests with JSON reporter, no truncation
  //    When e2eBackendNote is set, flows is zeroed but layout & a11y still
  //    runs — criteria.md: "every other row is judged".
  if (backendStop === null && frontendStop === null) {
    const e2eManifest = loadManifest(join(E2E_TESTS_DIR, "manifest.json"));
    const entriesToRun = e2eBackendNote !== null
      ? e2eManifest.filter((e) => e.row !== "Frontend E2E: flows")
      : e2eManifest;
    d.out(`[${attempt}] Running Playwright E2E tests (${entriesToRun.length} of ${e2eManifest.length} files)...`);
    for (const entry of entriesToRun) {
      requireNotInterrupted(d, entry.file);
      const proc = await d.runE2EFile(entry, d.abortSignal);
      requireNotInterrupted(d, `finishing ${entry.file}`);
      requireCompleted(entry.file, proc);
      const { passed, total } = parsePlaywrightJson(proc.stdout, entry.tests);
      const score = roundScore(passed, total, entry.max);
      const failed = parsePlaywrightJsonFailedNames(proc.stdout);
      testRows.push({ row: entry.row, file: entry.file, passed, total, max: entry.max, score, ...(failed.length > 0 ? { failed } : {}) });
      d.out(`  - ${entry.row}: ${score}/${entry.max} (${passed} of ${total} passed)`);
    }
  }

  d.out(`[${attempt}] Stopping server...`);
  d.stopServing();
  return { testRows, backendStop, frontendStop, e2eBackendNote, warnings: contract.warnings };
}

// ---------------------------------------------------------------------------
// Recursive walk for heuristic evaluators
// ---------------------------------------------------------------------------

/** Walk `dir` recursively, yielding relative paths, skipping node_modules. */
function walkSync(dir: string, base: string = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...walkSync(join(dir, entry.name), rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

export function evaluateCodeStructure(attemptDir: string): { score: number; notes: string } {
  const backendApp = join(attemptDir, "backend", "app");
  if (!existsSync(backendApp)) {
    return { score: 0, notes: "heuristic (not judged): missing backend/app directory" };
  }

  const files = readdirSync(backendApp);
  const hasStore = files.some((f) => f.includes("store"));
  const hasPlanner = files.some((f) => f.includes("planner"));
  const hasRoutes = files.some((f) => f.includes("route") || f.includes("api") || f.includes("main"));
  const hasSchemas = files.some((f) => f.includes("schema") || f.includes("model"));

  // Check planner isolation
  let plannerIsolated = true;
  for (const f of files) {
    if (f.includes("planner") && f.endsWith(".py")) {
      const content = readFileSync(join(backendApp, f), "utf8");
      if (content.includes("from fastapi") || content.includes("import fastapi")) {
        plannerIsolated = false;
        break;
      }
    }
  }

  // Frontend structure — recursive walk under frontend/src, skipping node_modules.
  // Accepts: types.ts, types/, api/types.ts, *.types.ts for types;
  //          api.ts, api/, client.ts, services/*api*.ts for the API module.
  const frontendSrc = join(attemptDir, "frontend", "src");
  let hasTypes = false;
  let hasApi = false;
  if (existsSync(frontendSrc)) {
    const srcFiles = walkSync(frontendSrc);
    hasTypes = srcFiles.some((f) => {
      const base = f.split("/").pop() ?? "";
      return base === "types.ts" || base === "types.tsx" || base.endsWith(".types.ts") || f.includes("types/");
    });
    hasApi = srcFiles.some((f) => {
      const base = f.split("/").pop() ?? "";
      return base === "api.ts" || base === "api.tsx" || base === "client.ts" || base === "client.tsx"
        || f.includes("api/") || (f.includes("services/") && base.toLowerCase().includes("api"));
    });
  }

  const checks = { store: hasStore, planner: hasPlanner, routes: hasRoutes, schemas: hasSchemas, plannerIsolated, types: hasTypes, api: hasApi };
  const held = Object.entries(checks).filter(([, v]) => v).map(([k]) => k);
  const missing = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  const pointsHeld = held.length;

  const detail = (items: string[], verb: string): string => items.length > 0 ? `${items.join(", ")} ${verb}` : "";
  const foundStr = detail(held, "found");
  const missingStr = detail(missing, "missing");
  const parts = [foundStr, missingStr].filter(Boolean).join("; ");

  if (!plannerIsolated || pointsHeld < 4) {
    return { score: 0, notes: `heuristic (not judged): ${parts}` };
  }
  if (pointsHeld < 7) {
    return { score: 0.5, notes: `heuristic (not judged): ${parts}` };
  }
  return { score: 1, notes: `heuristic (not judged): ${parts}` };
}

export function evaluateTechStack(attemptDir: string): { score: number; notes: string } {
  const hasBackend = existsSync(join(attemptDir, "backend"));
  const hasFrontend = existsSync(join(attemptDir, "frontend"));
  const hasReadme = existsSync(join(attemptDir, "README.md"));

  const hasReqs = existsSync(join(attemptDir, "backend", "requirements.txt"));
  const hasPackageJson = existsSync(join(attemptDir, "frontend", "package.json"));

  let viteProxies = false;
  const vitePath = join(attemptDir, "frontend", "vite.config.ts");
  if (existsSync(vitePath)) {
    const content = readFileSync(vitePath, "utf8");
    if (content.includes("5100") || content.includes("proxy")) {
      viteProxies = true;
    }
  }

  const checks = { backend: hasBackend, frontend: hasFrontend, readme: hasReadme, requirements: hasReqs, packageJson: hasPackageJson, viteProxy: viteProxies };
  const held = Object.entries(checks).filter(([, v]) => v).map(([k]) => k);
  const missing = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  const passed = held.length;

  const detail = (items: string[], verb: string): string => items.length > 0 ? `${items.join(", ")} ${verb}` : "";
  const foundStr = detail(held, "found");
  const missingStr = detail(missing, "missing");
  const parts = [foundStr, missingStr].filter(Boolean).join("; ");

  if (passed === 6) {
    return { score: 1, notes: `heuristic (not judged): ${parts}` };
  }
  if (passed >= 4) {
    return { score: 0.5, notes: `heuristic (not judged): ${parts}` };
  }
  return { score: 0, notes: `heuristic (not judged): ${parts}` };
}

export function evaluateSelfVerification(attemptDir: string): { score: number; notes: string } {
  const testDirs = [
    join(attemptDir, "backend", "tests"),
    join(attemptDir, "backend", "test"),
    join(attemptDir, "tests"),
  ];

  for (const tDir of testDirs) {
    if (existsSync(tDir)) {
      const files = readdirSync(tDir).filter((f) => f.endsWith(".py"));
      if (files.length > 0) {
        for (const f of files) {
          const content = readFileSync(join(tDir, f), "utf8");
          if (content.includes("def test_") && (content.includes("plan") || content.includes("order"))) {
            return { score: 1, notes: `heuristic (not judged): model-written tests in ${f} exercising planner/API (not run)` };
          }
        }
      }
    }
  }

  // Also check backend/ directly
  const backendDir = join(attemptDir, "backend");
  if (existsSync(backendDir)) {
    const files = readdirSync(backendDir).filter((f) => f.startsWith("test_") && f.endsWith(".py"));
    if (files.length > 0) {
      return { score: 1, notes: `heuristic (not judged): model-written test file ${files[0]} found in backend (not run)` };
    }
  }

  return { score: 0, notes: "heuristic (not judged): 0 model-written tests found" };
}

// ---------------------------------------------------------------------------
// Scoring: normal attempt
// ---------------------------------------------------------------------------

/**
 * One attempt that ran: the hidden rows, the heuristics, the judge rows, and
 * the write, which a signal received meanwhile skips. `deps` are
 * `scoreHiddenRows`'s; a test passes fakes.
 */
export async function scoreNormalAttempt(attempt: string, runJson: RunJson, resultsDir: string, deps: Partial<ScoreHardDeps> = {}): Promise<void> {
  const d: ScoreHardDeps = { ...DEFAULT_DEPS, ...deps };
  const attemptDir = join(ATTEMPTS_DIR, attempt);
  const durationStr = formatDuration(runJson.durationMs ?? 0);
  const testRunStr = formatTestRun(new Date());

  console.log(`\n========================================`);
  console.log(`[${attempt}] Scoring attempt (${durationStr})...`);

  // 0. Early-validate judge-rows-hard.json BEFORE spending ~20 min on tests.
  //    An invalid file is a hard error (R6); a rubric mismatch is a warning.
  const judgeRowsPath = join(resultsDir, attempt, JUDGE_ROWS_FILE);
  let preloadedJudgeRows: JudgeRowsHard | null = null;
  if (existsSync(judgeRowsPath)) {
    try {
      preloadedJudgeRows = readJudgeRowsHard(judgeRowsPath);
    } catch (err) {
      console.error(`[${attempt}] ERROR: ${JUDGE_ROWS_FILE} is invalid: ${(err as Error).message}`);
      console.error(`[${attempt}] Fix or remove the file and re-score. Nothing written.`);
      process.exit(1);
    }
    console.log(`[${attempt}] Pre-validated ${JUDGE_ROWS_FILE} (${Object.keys(preloadedJudgeRows.rows).length} row(s))`);
  }

  // Stop any previous serving processes
  d.stopServing();
  await sleep(1000);

  // The hidden rows: the contract files, each against a freshly started
  // backend, then one serve-attempt for the build and the E2E
  const { testRows, backendStop, frontendStop, e2eBackendNote, warnings } = await scoreHiddenRows(attempt, attemptDir, d);
  await sleep(1000);

  // 4. Agent criteria (heuristics)
  const heuristics = {
    codeStructure: evaluateCodeStructure(attemptDir),
    techStack: evaluateTechStack(attemptDir),
    selfVerification: evaluateSelfVerification(attemptDir),
  };

  let cells = assembleCells(testRows, heuristics, { backend: backendStop, frontend: frontendStop }, e2eBackendNote);

  // 6. Apply judge/human rows from pre-validated judge-rows-hard.json
  if (preloadedJudgeRows !== null) {
    const rubric = hardRubricId(ROOT);
    if (preloadedJudgeRows.rubric === rubric) {
      cells = applyJudgeRows(cells, preloadedJudgeRows, { backend: backendStop, frontend: frontendStop });
      console.log(`[${attempt}] Applied ${Object.keys(preloadedJudgeRows.rows).length} row(s) from ${JUDGE_ROWS_FILE}`);
    } else {
      console.warn(`[${attempt}] warning: ${JUDGE_ROWS_FILE} has rubric ${preloadedJudgeRows.rubric}, current is ${rubric} — ignoring`);
    }
  }

  // A signal while the rows were scored: its handler exits; nothing is written.
  if (d.interrupted() !== null) return;
  writeOutput(attempt, cells, testRows, durationStr, testRunStr, backendStop, frontendStop, resultsDir, e2eBackendNote, warnings);
}

/** Write hidden-results-hard.json then eval-results.csv — JSON first, never a partial CSV. */
function writeOutput(
  attempt: string,
  cells: Map<string, RowCell>,
  testRows: TestRowResult[],
  durationStr: string,
  testRunStr: string,
  backendStop: string | null,
  frontendStop: string | null,
  resultsDir: string,
  e2eBackendNote: string | null,
  warnings: string[],
): void {
  const targetDir = join(resultsDir, attempt);
  mkdirSync(targetDir, { recursive: true });

  // Ensure all 8 manifest rows are present (missing ones get zeros)
  const allRows = completeHiddenRows(
    testRows,
    loadManifest(join(TESTS_DIR, "manifest.json")),
    loadManifest(join(E2E_TESTS_DIR, "manifest.json")),
    e2eBackendNote,
  );

  // Write hidden-results-hard.json first (JSON before CSV)
  const hiddenResults: HardHiddenResults = {
    schemaVersion: 1,
    attempt,
    rubric: hardRubricId(ROOT),
    scoredAt: new Date().toISOString(),
    backend: backendStop ?? "ok",
    frontend: frontendStop ?? "ok",
    // Always written, `[]` included, as contract-tests-hard and
    // contract-tests-brownfield write theirs: a file without the field
    // predates it, so "none" and "not recorded" stay apart.
    warnings,
    rows: allRows.map((tr) => ({
      row: tr.row, file: tr.file, passed: tr.passed, total: tr.total, max: tr.max, score: tr.score,
      ...(tr.failed && tr.failed.length > 0 ? { failed: tr.failed } : {}),
    })),
  };
  writeHardHiddenResults(join(targetDir, "hidden-results-hard.json"), hiddenResults);

  // Write eval-results.csv
  const csv = renderCsv(cells, durationStr, testRunStr);
  writeFileSync(join(targetDir, "eval-results.csv"), csv, "utf8");

  const totalPoints = [...cells.entries()]
    .filter(([k]) => k !== "Penalty" && k !== "Task completion time" && k !== "Test run")
    .reduce((sum, [, c]) => sum + c.score, 0) - (cells.get("Penalty")?.score ?? 0);
  console.log(`[${attempt}] ✓ Finished! Total score: ${totalPoints.toFixed(2)} / 19.0 (${((totalPoints / 19) * 100).toFixed(1)}%)`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes("--force");

  let targetAttempt: string | null = null;
  const attemptIdx = args.indexOf("--attempt");
  if (attemptIdx !== -1 && attemptIdx + 1 < args.length) {
    targetAttempt = args[attemptIdx + 1]!;
  }

  let resultsDir = DEFAULT_RESULTS_DIR;
  const resultsDirIdx = args.indexOf("--results-dir");
  if (resultsDirIdx !== -1 && resultsDirIdx + 1 < args.length) {
    resultsDir = resolve(args[resultsDirIdx + 1]!);
  }

  const dirs = readdirSync(resultsDir).filter((d) => existsSync(join(resultsDir, d, "run.json"))).sort();

  if (targetAttempt && !dirs.includes(targetAttempt)) {
    console.error(`no such attempt: ${targetAttempt}`);
    process.exit(2);
  }

  console.log(`Found ${dirs.length} attempts in ${resultsDir}`);

  // SIGINT, SIGTERM, SIGHUP, SIGQUIT: abort the test file, build or Playwright
  // run going then (killed at once, not waited for), remove the contract
  // containers, stop serving, exit 128+N. Scoring runs on meanwhile and
  // writes nothing.
  const abort = new AbortController();
  const handlers = installInterruptHandlers(interruptHooks(() => abort.abort()));

  // The hard E2E verdicts depend on the Playwright that runs them: refuse to
  // score on another one than the 20 v2 attempts were scored on.
  const pinMismatches = installedE2EPinMismatches(ROOT);
  if (pinMismatches.length > 0) {
    console.error(
      `the installed Playwright/axe differ from HARD_E2E_PINS (scripts/lib/scorer-freeze.ts): ${pinMismatches.join("; ")}. ` +
        "Run `npm ci` at the repository root; nothing scored.",
    );
    process.exit(1);
  }

  for (const dir of dirs) {
    if (handlers.interrupted() !== null) return;
    if (targetAttempt && dir !== targetAttempt) continue;

    const csvPath = join(resultsDir, dir, "eval-results.csv");
    if (existsSync(csvPath) && !force) {
      console.log(`[${dir}] eval-results.csv already exists; skipping (use --force to overwrite)`);
      continue;
    }

    const runJsonPath = join(resultsDir, dir, "run.json");
    const runJson = readRunJson(runJsonPath);

    const classification = classifyAttempt(runJson);

    if (classification.kind === "refuse") {
      console.log(`[${dir}] refused: ${classification.reason}`);
      if (targetAttempt) process.exit(1);
      continue;
    }

    if (classification.kind === "model-failure") {
      const durationStr = formatDuration(runJson.durationMs ?? 0);
      const testRunStr = formatTestRun(new Date());
      const cells = allZero(classification.reason);
      const targetDir = join(resultsDir, dir);
      mkdirSync(targetDir, { recursive: true });
      const csv = renderCsv(cells, durationStr, testRunStr);
      writeFileSync(join(targetDir, "eval-results.csv"), csv, "utf8");
      // No hidden-results-hard.json for model failures
      console.log(`[${dir}] ✓ Model failure: wrote all-zero CSV`);
      continue;
    }

    try {
      await scoreNormalAttempt(dir, runJson, resultsDir, { interrupted: handlers.interrupted, abortSignal: abort.signal });
    } catch (error) {
      // A signal that killed a child fails its call first, as a HarnessFault or
      // anything else: let it land, then leave the exit to its handler.
      await sleep(SIGNAL_SETTLE_MS);
      if (handlers.interrupted() !== null) return;
      if (error instanceof HarnessFault) {
        console.error(`[${dir}] HarnessFault: ${error.message} — nothing written`);
        stopServing();
        process.exit(1);
      }
      throw error;
    } finally {
      stopServing();
    }
  }

  console.log("\nAll scoring completed!");
}

// Guarded so a test can import the heuristic evaluators without the script
// spawning anything.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Scoring failed:", err);
    stopServing();
    process.exit(1);
  });
}
