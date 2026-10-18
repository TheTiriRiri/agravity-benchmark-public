/**
 * Runs the hidden contract tests against one attempt's backend and writes
 * `eval-results/<dir>/contract-results.json` (spec §5, "scripts/contract-tests.ts"):
 *
 *   node --import tsx scripts/contract-tests.ts --attempt <dir> [--root <path>]
 *                                               [--ignore-run-json] [--allow-ungated]
 *
 * The hidden tests, their manifest, the seed, gate 2's record and
 * `benchmark/runner.yaml` always come from this repository; `eval-attempts/`
 * and `eval-results/` come from `--root`, the repository by default.
 *
 * 1. Refuses an attempt whose `run.json` is missing or records `infra`,
 *    `softDenied` or `model` (`--ignore-run-json` for a synthetic attempt),
 *    and hidden tests whose gate-2 fingerprint differs from the recorded one
 *    (`--allow-ungated`, recorded as `ungated: true`).
 * 2. Resolves the image from `runner.yaml` to `<tag>@<Id>` and runs every
 *    container by that bare Id, so a retag during the run cannot change what
 *    later containers run; the result records `<tag>@<Id>`. A difference from
 *    `run.json`'s image is a warning, not a refusal.
 * 3. Checks the layout, installs once, records `pip freeze`, then for each
 *    manifest file starts a fresh serving container on an ephemeral port,
 *    runs the file, asks the daemon what became of the container, and proves
 *    it gone. The first start has no retry — failing it is the backend stop;
 *    a later start that fails is retried `LIMITS.restartRetries` times, then
 *    that file scores 0. A container that vanished during a file — removed
 *    from outside — is infra; one that exited is a warning, since its crash
 *    may be the model's or the host's OOM killer's.
 * 4. Writes the file atomically, only after a complete run, first removing
 *    any `.contract-results.json.<pid>.<hex>.tmp` in that one directory that
 *    a writer killed mid-write left behind (its pid dead).
 *
 * Budgets come from `rubric.ts`'s `LIMITS`. The overall budget covers the
 * files — starts, health waits, test runs and removals — from the first
 * start on; the install has budgets of its own (spec: "install 300 s, on its
 * own"), which is how the worst legitimate run, 180 + 3 × (60 + 60 + 120) =
 * 900 s, stays inside it.
 *
 * Exit 0: the result was written (a backend stop included). Exit 1: refused,
 * or a harness fault; nothing written. Exit 2: usage. 128+N: interrupted by a
 * signal; nothing written, every container and the scratch directory removed.
 *
 * Signal-sensitive: invoke it as `node --import tsx scripts/contract-tests.ts`,
 * never through the `tsx` bin. `npm run contract-tests` is fine for an
 * interactive Ctrl-C, which reaches the whole group, but a signal sent to npm's
 * pid may never reach node, whose cleanups then do not run. Importing this
 * module installs nothing; `main` installs the handlers.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AttemptBackend,
  stopAllBackends,
  stopAllBackendsSync,
  type BackendOptions,
  type ContainerRemoval,
  type ServingState,
  type StartResult,
  type StepResult,
  type PytestStepResult,
} from "./lib/attempt-backend";
import { tempFileOwner } from "./lib/atomic-write";
import { ATTEMPT_DIR_RE } from "./lib/attempts";
import {
  CONTRACT_RESULTS_FILE,
  diagnose,
  groupFromFileResult,
  loadManifest,
  restartFailedGroup,
  stoppedBoot,
  stoppedGroups,
  writeContractResults,
  type BootStage,
  type ContractResults,
  type GroupResult,
  type ManifestEntry,
} from "./lib/contract-results";
import { runContractFile, type ContractFileResult, type RunContractFileOptions } from "./lib/contract-suite";
import { pidIsAlive, resolveImageId } from "./lib/docker";
import { GATE_RESULT_PATH, gateFingerprint } from "./lib/gate-fingerprint";
import { installInterruptHandlers, type InterruptSignal } from "./lib/interrupt";
import { LIMITS, rubricId, type Limits } from "./lib/rubric";
import { runJsonRefusal } from "./lib/run-json";
import { readScoringImage } from "./lib/runner-config";

/** This repository: the hidden tests, the manifest, the seed, gate 2's record and runner.yaml. */
export const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TESTS_DIR = join(REPO_ROOT, "benchmark", "contract-tests");
const SEED_PATH = join(REPO_ROOT, "benchmark", "context", "seed.json");
/** What `testsCommit` and `testsDirty` describe (spec §5, `contract-results.json`). */
export const TESTS_PATHS: readonly string[] = Object.freeze([
  "benchmark/contract-tests",
  "benchmark/context/seed.json",
  "scripts/lib/contract-suite.ts",
]);
const GIT_TIMEOUT_MS = 30_000;
/**
 * The variables that point git at another repository, work tree, index or
 * object store, each of which would win over `-C`: what
 * `git rev-parse --local-env-vars` lists, less GIT_CONFIG_PARAMETERS and
 * GIT_CONFIG_COUNT (`-c` settings) — the set git itself clears on entering
 * another repository. A git hook or a wrapper script sets some of them
 * (GIT_DIR, GIT_INDEX_FILE), and `testsProvenance` always means `repoRoot`.
 */
const GIT_REPO_ENV = Object.freeze([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
]);
/**
 * How long the CLI waits before exiting 1, so a signal that arrived while a
 * `spawnSync` blocked — and made that call fail — is seen as the interruption
 * it is, not reported as a harness fault.
 */
const SIGNAL_SETTLE_MS = 200;

// ---------------------------------------------------------------------------
// types

export interface ContractTestsOptions {
  /** The attempt directory's name, `<id>-attempt-<n>`. */
  attempt: string;
  /** Holds `eval-attempts/` and `eval-results/`. Absolute. */
  root: string;
  /** Score without reading `run.json`: synthetic attempts only. `runImage` is then `null`. */
  ignoreRunJson: boolean;
  /** Score even though the hidden tests differ from what gate 2 vouched for; recorded as `ungated: true`. */
  allowUngated: boolean;
}

/** What `runContractTests` needs of a backend; `AttemptBackend` is one. */
export interface ContractBackend {
  checkLayout(): StepResult;
  install(): Promise<StepResult>;
  pipFreeze(): Promise<string[]>;
  start(): Promise<StartResult>;
  /** Asked after each file, before `stop()`: what became of the serving container. */
  servingState(): Promise<ServingState>;
  stop(): Promise<ContainerRemoval>;
  dispose(): Promise<ContainerRemoval[]>;
  runPytest?(timeoutMs?: number): Promise<PytestStepResult>;
}

/** Gate 2's recorded fingerprint (`null` when there is no readable record) and the files' current one. */
export interface GateState {
  recorded: string | null;
  current: string;
}

export interface TestsProvenance {
  testsCommit: string;
  testsDirty: boolean;
}

export interface ContractTestsDeps {
  /** Given the bare image Id (`sha256:…`) as `image`, never the tag. */
  createBackend: (options: BackendOptions) => ContractBackend;
  runFile: (options: RunContractFileOptions) => Promise<ContractFileResult>;
  /**
   * The image tag from runner.yaml, its `<tag>@<Id>` and the bare Id
   * (`resolveImageId`). Throws when it cannot be resolved to a `sha256:<64 hex>` Id.
   */
  image: () => { tag: string; ref: string; id: string };
  /** Whether a pid is alive: a stale temp file is removed only when its writer's is not. */
  isAlive: (pid: number) => boolean;
  gate: () => GateState;
  provenance: () => TestsProvenance;
  /** A monotonic clock in ms, for the overall budget and `durationMs`. */
  now: () => number;
  /** The signal that interrupted the run, or `null`. Checked before every step and before the write. */
  interrupted: () => InterruptSignal | null;
  /** Called with the backend as soon as it exists, so a signal cleanup can dispose it. */
  onBackend: (backend: ContractBackend) => void;
  /** Tests only: shorter budgets. The CLI never passes this; production uses `LIMITS`. */
  limits: Partial<Limits>;
  /** Progress and the summary, one line at a time. */
  out: (line: string) => void;
}

export type ContractTestsOutcome =
  | { kind: "written"; path: string; results: ContractResults }
  /** A policy refusal: nothing was started and nothing written. */
  | { kind: "refused"; message: string }
  /** A harness fault: nothing written. */
  | { kind: "infra"; message: string }
  /** A signal: nothing written. */
  | { kind: "interrupted"; signal: InterruptSignal };

// ---------------------------------------------------------------------------
// the defaults: the real repository, docker and git

/**
 * `git log -1` and `git status --porcelain` over `TESTS_PATHS`, in `repoRoot`
 * whatever the inherited environment points git at. Throws when git cannot answer.
 */
export function testsProvenance(repoRoot: string = REPO_ROOT): TestsProvenance {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of GIT_REPO_ENV) delete env[key];
  const git = (args: string[]): string => {
    const result = spawnSync("git", ["-C", repoRoot, ...args, "--", ...TESTS_PATHS], {
      encoding: "utf8",
      env,
      timeout: GIT_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    if (result.error !== undefined || result.status !== 0) {
      const why = result.error?.message ?? `exit ${result.status}: ${(result.stderr ?? "").trim()}`;
      throw new Error(`git ${args.join(" ")} failed in ${repoRoot} (${why}); contract-tests records the hidden tests' commit and needs the repository's git history`);
    }
    return result.stdout ?? "";
  };
  const testsCommit = git(["log", "-1", "--format=%H"]).trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(testsCommit)) {
    throw new Error(`git log names no commit touching ${TESTS_PATHS.join(", ")} (got ${JSON.stringify(testsCommit)})`);
  }
  // Untracked files count whatever `status.showUntrackedFiles` says: a new,
  // uncommitted hidden test changes what ran as surely as an edit does.
  return { testsCommit, testsDirty: git(["status", "--porcelain", "--untracked-files=all"]).trim() !== "" };
}

function defaultGate(): GateState {
  const current = gateFingerprint(REPO_ROOT);
  let recorded: string | null = null;
  try {
    const raw: unknown = JSON.parse(readFileSync(join(REPO_ROOT, GATE_RESULT_PATH), "utf8"));
    const fingerprint = (raw as { fingerprint?: unknown } | null)?.fingerprint;
    if (typeof fingerprint === "string" && fingerprint !== "") recorded = fingerprint;
  } catch {
    // no record, or not one we can read: the tests are ungated
  }
  return { recorded, current };
}

function defaultImage(): { tag: string; ref: string; id: string } {
  const tag = readScoringImage(REPO_ROOT);
  return { tag, ...resolveImageId(tag) };
}

/**
 * Remove the temporary files a writer of this one result file left when it
 * was killed between its write and its rename: only in `dir`, only names
 * `tempFileOwner` recognises, only regular files, and only when the pid in
 * the name is dead — a live writer's file is its own business. Returns one
 * line per file it could not remove; nothing it does is fatal.
 */
function removeStaleTempFiles(dir: string, isAlive: (pid: number) => boolean): string[] {
  const problems: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return problems; // no directory yet: nothing stale in it
  }
  for (const entry of entries) {
    const owner = tempFileOwner(CONTRACT_RESULTS_FILE, entry.name);
    if (owner === null || !entry.isFile() || owner === process.pid || isAlive(owner)) continue;
    try {
      unlinkSync(join(dir, entry.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") problems.push(`could not remove the stale ${join(dir, entry.name)}: ${message(error)}`);
    }
  }
  return problems;
}

const DEFAULT_DEPS: ContractTestsDeps = {
  createBackend: (options) => new AttemptBackend(options),
  runFile: runContractFile,
  image: defaultImage,
  isAlive: pidIsAlive,
  gate: defaultGate,
  provenance: () => testsProvenance(REPO_ROOT),
  now: () => performance.now(),
  interrupted: () => null,
  onBackend: () => {},
  limits: {},
  out: (line) => console.log(line),
};

// ---------------------------------------------------------------------------
// the run

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** One line, at most `max` characters from the end — for progress output, never for results. */
function brief(text: string, max = 300): string {
  const flat = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" / ");
  return flat.length <= max ? flat : `…${flat.slice(-max)}`;
}

function restartDetail(entry: ManifestEntry, starts: number, last: { stage: BootStage; detail: string }): string {
  return `${last.detail}\n(the backend booted for the first file but not again for ${entry.file}: ${starts} ${starts === 1 ? "start" : "starts"}, the last a ${last.stage} failure)`;
}

/** The progress and summary line for one scored group. */
export function summaryLine(group: GroupResult, results: ContractResults): string {
  const notes: string[] = [];
  if (!results.boot.ok) notes.push(`backend stop (${results.boot.stage})`);
  else if (group.detail !== null) notes.push("restart failed");
  if (group.timedOut && group.notRun > 0) notes.push(`timed out after ${group.total - group.notRun} tests`);
  if (group.hookFailed > 0) notes.push(`${group.hookFailed} failed in beforeEach`);
  return `  ${group.row}: ${group.passed}/${group.total} passed, ${group.score}/${group.max}${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`;
}

type Scored =
  /** `warnings`: what the run noticed about the serving containers, for `contract-results.json`'s `warnings`. */
  | { kind: "complete"; boot: ContractResults["boot"]; pipFreeze: string[]; groups: GroupResult[]; warnings: string[] }
  | { kind: "infra"; message: string }
  | { kind: "interrupted"; signal: InterruptSignal };

/**
 * The hidden tests against `backend`: layout, install, freeze, then one fresh
 * container per manifest file. Never disposes the backend; the caller does,
 * on every path.
 */
async function scoreBackend(
  backend: ContractBackend,
  manifest: ManifestEntry[],
  d: ContractTestsDeps,
  limits: Limits,
): Promise<Scored> {
  const warnings: string[] = [];
  const stopped = (stage: BootStage, detail: string, pipFreeze: string[]): Scored => {
    // `stoppedBoot`, so an empty detail — a crash that printed nothing — is still written as the model's stop.
    const boot = stoppedBoot(stage, detail);
    d.out(`backend stop (${stage}): ${brief(boot.detail)}`);
    return { kind: "complete", boot, pipFreeze, groups: stoppedGroups(manifest), warnings };
  };
  const interrupted = (): Scored | null => {
    const signal = d.interrupted();
    return signal === null ? null : { kind: "interrupted", signal };
  };

  const layout = backend.checkLayout();
  if (layout.kind === "infra") return { kind: "infra", message: layout.detail };
  if (layout.kind === "stop") return stopped(layout.stage, layout.detail, []);

  d.out("installing the backend (a fresh venv, pip install -r requirements.txt)…");
  const install = await backend.install();
  const afterInstall = interrupted();
  if (afterInstall !== null) return afterInstall;
  if (install.kind === "infra") return { kind: "infra", message: install.detail };
  if (install.kind === "stop") return stopped(install.stage, install.detail, []);

  const pipFreeze = await backend.pipFreeze();
  const afterFreeze = interrupted();
  if (afterFreeze !== null) return afterFreeze;

  const loopStart = d.now();
  const left = (): number => limits.overallMs - (d.now() - loopStart);
  const overBudget = (): Scored => ({
    kind: "infra",
    message: `the overall budget of ${limits.overallMs / 1000} s for the hidden-test files ran out; that guards against a runaway harness and is not the model's`,
  });

  const groups: GroupResult[] = [];
  for (const [index, entry] of manifest.entries()) {
    // The first start proves the backend boots, so it has no retry; a later
    // failure, after that proof, gets `restartRetries` more.
    const starts = index === 0 ? 1 : 1 + Math.max(0, limits.restartRetries);
    let ready: { baseUrl: string } | null = null;
    let last: { stage: BootStage; detail: string } | null = null;
    for (let n = 1; n <= starts && ready === null; n++) {
      const stop = interrupted();
      if (stop !== null) return stop;
      if (left() <= 0) return overBudget();
      const started = await backend.start();
      if (started.kind === "infra") return { kind: "infra", message: `starting the backend for ${entry.file}: ${started.detail}` };
      if (started.kind === "ready") {
        ready = started;
        break;
      }
      last = { stage: started.stage, detail: started.detail };
      if (index > 0) {
        d.out(`${entry.file}: the backend did not come up (${started.stage}: ${brief(started.detail, 200)})${n < starts ? "; retrying" : ""}`);
      }
    }
    const afterStart = interrupted();
    if (afterStart !== null) return afterStart;

    if (ready === null) {
      const failure = last as { stage: BootStage; detail: string };
      if (index === 0) return stopped(failure.stage, failure.detail, pipFreeze);
      groups.push(restartFailedGroup(entry, restartDetail(entry, starts, failure)));
      continue;
    }

    const budget = left();
    if (budget <= 0) return overBudget();
    const timeoutMs = Math.max(1, Math.floor(Math.min(limits.fileMs, budget)));
    d.out(`${entry.file}: running ${entry.tests} tests against ${ready.baseUrl}`);
    const result = await d.runFile({
      file: join(TESTS_DIR, entry.file),
      baseUrl: ready.baseUrl,
      seedPath: SEED_PATH,
      timeoutMs,
      expectedTests: entry.tests,
    });
    const afterFile = interrupted();
    if (afterFile !== null) return afterFile;
    // A timer the overall budget shortened fired: the budget ran out, not the file's own 120 s.
    if (result.timedOut && timeoutMs < limits.fileMs) return overBudget();

    // What the file ran against, before `stop()` removes it — which cannot tell
    // a container it removed from one already gone. Gone from the daemon: only
    // something outside the harness removes a container (`docker rm -f`, a
    // daemon restart that lost it), so the file's failures are not the model's.
    // Exited: its own crash, or the host's OOM killer — said, not decided.
    const serving = await backend.servingState();
    if (serving.kind === "vanished") {
      return { kind: "infra", message: `the serving container vanished during ${entry.file}: something outside contract-tests removed it, so that file's failures are not the model's` };
    }
    if (serving.kind === "unknown") return { kind: "infra", message: `after ${entry.file}: ${serving.detail}` };
    if (serving.kind === "exited") {
      warnings.push(`the serving container exited with code ${serving.exitCode} during ${entry.file}, so the tests after that ran against no backend (the backend crashed, or the host killed it)`);
    }

    const removal = await backend.stop();
    if (!removal.removed) return { kind: "infra", message: `after ${entry.file}: ${removal.detail}` };
    groups.push(groupFromFileResult(entry, result));
  }
  return { kind: "complete", boot: { ok: true, stage: null, detail: null }, pipFreeze, groups, warnings };
}

/**
 * The whole of `contract-tests` except argument parsing and signal handling:
 * refusals, image, provenance, the scored run, and the write. Every
 * dependency on docker, git, the clock and the hidden-test runner is
 * injectable; see `ContractTestsDeps`.
 */
export async function runContractTests(options: ContractTestsOptions, deps: Partial<ContractTestsDeps> = {}): Promise<ContractTestsOutcome> {
  const d: ContractTestsDeps = { ...DEFAULT_DEPS, ...deps };
  const limits: Limits = { ...LIMITS, ...d.limits };
  const startedAt = new Date().toISOString();
  const t0 = d.now();
  const refused = (text: string): ContractTestsOutcome => ({ kind: "refused", message: `${text}\nNothing was written.` });
  const infra = (text: string): ContractTestsOutcome => ({
    kind: "infra",
    message: `${text}\nA harness fault, not the model's: nothing was written. Fix it and run contract-tests again.`,
  });

  // --- refusals: nothing is started ---------------------------------------
  if (!ATTEMPT_DIR_RE.test(options.attempt)) return refused(`--attempt takes an attempt directory name like gemini-38-flash-high-attempt-1, got ${JSON.stringify(options.attempt)}`);
  const attemptDir = join(options.root, "eval-attempts", options.attempt);
  const resultsDir = join(options.root, "eval-results", options.attempt);
  if (!isDirectory(attemptDir)) return refused(`no attempt directory at ${attemptDir}`);

  const warnings: string[] = [];
  let runImage: string | null = null;
  if (!options.ignoreRunJson) {
    const admitted = runJsonRefusal(resultsDir, "contract-tests");
    if ("refusal" in admitted) return refused(admitted.refusal);
    if (admitted.run.image.trim() === "") warnings.push("run.json records no image, so the image the attempt ran in is unknown");
    else runImage = admitted.run.image;
  }

  let ungated: boolean;
  try {
    const gate = d.gate();
    ungated = gate.recorded === null || gate.recorded !== gate.current;
    if (ungated && !options.allowUngated) {
      return refused(
        gate.recorded === null
          ? `gate 2 has no readable record (${GATE_RESULT_PATH}), so nothing vouches for the hidden tests. Run \`npm run gate:reference\`, or pass --allow-ungated to score anyway (recorded as ungated: true).`
          : `the hidden tests, the seed or the reference differ from what gate 2 vouched for (recorded ${gate.recorded.slice(0, 12)}, now ${gate.current.slice(0, 12)}). Run \`npm run gate:reference\`, or pass --allow-ungated to score anyway (recorded as ungated: true).`,
      );
    }
  } catch (error) {
    return infra(`could not fingerprint the hidden tests for gate 2: ${message(error)}`);
  }

  // --- what the result records, all before any container ------------------
  let manifest: ManifestEntry[];
  let rubric: string;
  let provenance: TestsProvenance;
  let image: { tag: string; ref: string; id: string };
  try {
    manifest = loadManifest(REPO_ROOT);
    rubric = rubricId(REPO_ROOT);
    provenance = d.provenance();
    image = d.image();
  } catch (error) {
    return infra(message(error));
  }
  if (runImage !== null && runImage !== image.ref) {
    warnings.push(`the hidden tests ran in ${image.ref}, but run.json records that the attempt ran in ${runImage} (a harness note, not the model's)`);
  }
  const early = d.interrupted();
  if (early !== null) return { kind: "interrupted", signal: early };

  // --- the run --------------------------------------------------------------
  d.out(`contract-tests: ${options.attempt} in ${image.ref}`);
  let scored: Scored;
  let backend: ContractBackend | null = null;
  try {
    // By Id: a retag of the tag during the run cannot change what later containers run.
    backend = d.createBackend({ attemptDir, attemptName: options.attempt, image: image.id, hostPort: "ephemeral" });
    d.onBackend(backend);
    scored = await scoreBackend(backend, manifest, d, limits);
  } catch (error) {
    scored = { kind: "infra", message: message(error) };
  }

  // Every container gone, then the scratch directory, on every path.
  let leftovers: string[] = [];
  if (backend !== null) {
    try {
      leftovers = (await backend.dispose()).filter((r) => !r.removed).map((r) => r.detail);
    } catch (error) {
      leftovers = [`disposing the backend threw: ${message(error)}`];
    }
  }

  const signal = d.interrupted();
  if (signal !== null) return { kind: "interrupted", signal };
  if (scored.kind === "interrupted") return scored;
  if (scored.kind === "infra") return infra([scored.message, ...leftovers].join("\n"));
  if (leftovers.length > 0) return infra(leftovers.join("\n"));

  const results: ContractResults = {
    schemaVersion: 1,
    attempt: options.attempt,
    image: image.ref,
    runImage,
    rubric,
    testsCommit: provenance.testsCommit,
    testsDirty: provenance.testsDirty,
    ungated,
    startedAt,
    durationMs: Math.max(0, Math.round(d.now() - t0)),
    pipFreeze: scored.pipFreeze,
    warnings: [...warnings, ...scored.warnings],
    boot: scored.boot,
    diagnosis: diagnose(scored.groups),
    groups: scored.groups,
  };

  // Let a signal that is already pending land before the write, so a run the
  // operator stopped at the last moment is not recorded.
  await new Promise<void>((done) => setImmediate(done));
  const late = d.interrupted();
  if (late !== null) return { kind: "interrupted", signal: late };

  const path = join(resultsDir, CONTRACT_RESULTS_FILE);
  for (const problem of removeStaleTempFiles(resultsDir, d.isAlive)) d.out(`warning: ${problem}`);
  try {
    writeContractResults(path, results);
  } catch (error) {
    return infra(`could not write ${path}: ${message(error)}`);
  }
  if (results.diagnosis === "reset-broken") d.out("diagnosis: reset-broken (POST /reset does not answer 200, so every test failed in beforeEach)");
  for (const group of results.groups) d.out(summaryLine(group, results));
  for (const warning of results.warnings) d.out(`warning: ${warning}`);
  if (results.ungated) d.out("warning: ungated — the hidden tests differ from what gate 2 vouched for");
  d.out(`wrote ${path}`);
  return { kind: "written", path, results };
}

// ---------------------------------------------------------------------------
// CLI

const USAGE = `Usage: node --import tsx scripts/contract-tests.ts --attempt <dir> [--root <path>]
                                                    [--ignore-run-json] [--allow-ungated]

  --attempt <dir>     Attempt directory name, <id>-attempt-<n>: scores
                      <root>/eval-attempts/<dir> and writes
                      <root>/eval-results/<dir>/${CONTRACT_RESULTS_FILE}.
  --root <path>       Holds eval-attempts/ and eval-results/. Default: this
                      repository. The hidden tests always come from here.
  --ignore-run-json   Score without run.json (synthetic attempts only).
  --allow-ungated     Score although the hidden tests differ from gate 2's
                      record; the result says ungated: true.
  --help              Print this message.

Exit 0: written (a backend stop included). 1: refused or a harness fault,
nothing written. 2: usage. 128+N: interrupted, nothing written.
`;

class UsageError extends Error {}

export interface ParsedArgs extends ContractTestsOptions {
  help: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { attempt: "", root: REPO_ROOT, ignoreRunJson: false, allowUngated: false, help: false };
  let attempt: string | null = null;
  let rootGiven = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const eq = token.startsWith("--") ? token.indexOf("=") : -1;
    const name = eq === -1 ? token : token.slice(0, eq);
    const value = (): string => {
      const next = eq === -1 ? argv[++i] : token.slice(eq + 1);
      if (next === undefined || next === "" || next.startsWith("--")) throw new UsageError(`${name} needs a value`);
      return next;
    };
    const flag = (): true => {
      if (eq !== -1) throw new UsageError(`${name} takes no value`);
      return true;
    };
    switch (name) {
      case "--attempt":
        if (attempt !== null) throw new UsageError("--attempt given twice");
        attempt = value();
        break;
      case "--root":
        if (rootGiven) throw new UsageError("--root given twice");
        rootGiven = true;
        args.root = resolve(value());
        break;
      case "--ignore-run-json":
        args.ignoreRunJson = flag();
        break;
      case "--allow-ungated":
        args.allowUngated = flag();
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        throw new UsageError(`unknown argument ${JSON.stringify(token)}`);
    }
  }
  if (args.help) return args;
  if (attempt === null) throw new UsageError("--attempt <dir> is required");
  if (!ATTEMPT_DIR_RE.test(attempt)) {
    throw new UsageError(`--attempt takes an attempt directory name like gemini-38-flash-high-attempt-1, not a path; got ${JSON.stringify(attempt)}`);
  }
  args.attempt = attempt;
  return args;
}

async function main(argv: string[]): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`contract-tests: ${error.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  let current: ContractBackend | null = null;
  const handlers = installInterruptHandlers({
    cleanups: [
      async () => {
        if (current === null) return;
        for (const removal of await current.dispose()) {
          if (!removal.removed) console.error(`contract-tests: ${removal.detail}`);
        }
      },
      () => stopAllBackends(),
    ],
    exitCleanups: [stopAllBackendsSync],
  });

  let outcome: ContractTestsOutcome;
  try {
    outcome = await runContractTests(args, {
      interrupted: handlers.interrupted,
      onBackend: (backend) => {
        current = backend;
      },
    });
  } catch (error) {
    outcome = { kind: "infra", message: `contract-tests failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}` };
  }

  // Synchronous from the write to the exit: no signal handler can run between them.
  if (outcome.kind === "written") process.exit(0);
  if (outcome.kind !== "interrupted") {
    await new Promise((done) => setTimeout(done, SIGNAL_SETTLE_MS));
    if (handlers.interrupted() === null) {
      process.stderr.write(`contract-tests: ${outcome.message}\n`);
      process.exit(1);
    }
  }
  // Interrupted: the handler finishes its cleanups and exits 128+N.
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2));
}
