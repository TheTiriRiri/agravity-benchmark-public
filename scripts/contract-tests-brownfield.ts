/**
 * Runs the brownfield track's hidden suite (classic regression + change suite + diff locality)
 * against one attempt's backend and writes:
 *   <root>/eval-results/<dir>/contract-results-brownfield.json
 *
 * Usage:
 *   node --import tsx scripts/contract-tests-brownfield.ts --attempt <dir> [--root <path>]
 *        [--attempts-dir <path>] [--run-json-dir <path>] [--ignore-run-json] [--allow-ungated]
 *
 * Signal-sensitive: invoke it as `node --import tsx scripts/contract-tests-brownfield.ts`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ContractBackend, GateState, TestsProvenance } from "./contract-tests";
import {
  AttemptBackend,
  PYTEST_TIMEOUT_MS,
  stopAllBackends,
  stopAllBackendsSync,
  type BackendOptions,
} from "./lib/attempt-backend";
import { tempFileOwner } from "./lib/atomic-write";
import { ATTEMPT_DIR_RE } from "./lib/attempts";
import {
  BROWNFIELD_RESULTS_FILE,
  BROWNFIELD_TRACK,
  buildBrownfieldResult,
  brownfieldSummaryLines,
  loadBrownfieldManifest,
  writeBrownfieldContractResults,
  type BrownfieldManifestEntry,
  type BrownfieldResult,
  type PytestResult,
} from "./lib/brownfield-contract-results";
import { brownfieldRubricId } from "./lib/brownfield-rubric";
import {
  diagnose,
  groupFromFileResult,
  loadManifest,
  restartFailedGroup,
  stoppedBoot,
  stoppedGroups,
  type BootStage,
  type GroupResult,
  type ManifestEntry,
} from "./lib/contract-results";
import { runContractFile, type ContractFileResult, type RunContractFileOptions } from "./lib/contract-suite";
import { computeDiffLocality, type DiffLocalityResult } from "./lib/diff-locality";
import { pidIsAlive, resolveImageId } from "./lib/docker";
import { GATE_RESULT_PATH, gateFingerprint } from "./lib/gate-fingerprint";
import { installInterruptHandlers, type InterruptSignal } from "./lib/interrupt";
import { LIMITS, type Limits } from "./lib/rubric";
import { runJsonRefusal } from "./lib/run-json";
import { readScoringImage } from "./lib/runner-config";

export const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const DEFAULT_TRACK_ROOT = join(REPO_ROOT, "tracks", "brownfield");
export const SEED_PATH = join(REPO_ROOT, "benchmark", "context", "seed.json");
export const BASE_DIR = join(REPO_ROOT, "tracks", "brownfield", "base");
export const BROWNFIELD_CHANGE_DIR = join(REPO_ROOT, "tracks", "brownfield", "benchmark", "contract-tests");
export const BROWNFIELD_CHANGE_MANIFEST_PATH = join(BROWNFIELD_CHANGE_DIR, "manifest.json");

export const BROWNFIELD_TESTS_PATHS: readonly string[] = Object.freeze([
  "benchmark/contract-tests/api-contract.test.ts",
  "benchmark/contract-tests/planner-assignment.test.ts",
  "benchmark/contract-tests/planner-ordering.test.ts",
  "benchmark/contract-tests/planner-parts.test.ts",
  "benchmark/contract-tests/manifest.json",
  "benchmark/context/seed.json",
  "scripts/lib/contract-suite.ts",
  "tracks/brownfield/benchmark/contract-tests/change-invariants.test.ts",
  "tracks/brownfield/benchmark/contract-tests/change-tie-break.test.ts",
  "tracks/brownfield/benchmark/contract-tests/manifest.json",
  "tracks/brownfield/benchmark/contract-tests/balanced-scenario.json",
  "tracks/brownfield/benchmark/contract-tests/loads.ts",
  "tracks/brownfield/benchmark/contract-tests/schedule.ts",
]);

const GIT_TIMEOUT_MS = 30_000;
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
const SIGNAL_SETTLE_MS = 200;

export interface BrownfieldTestsOptions {
  attempt: string;
  root: string;
  attemptsDir: string;
  runJsonDir: string;
  ignoreRunJson: boolean;
  allowUngated: boolean;
  baseDir?: string;
}

export interface BrownfieldTestsDeps {
  createBackend: (options: BackendOptions) => ContractBackend;
  runFile: (options: RunContractFileOptions) => Promise<ContractFileResult>;
  image: () => { tag: string; ref: string; id: string };
  isAlive: (pid: number) => boolean;
  gate: (root: string) => GateState;
  provenance: () => TestsProvenance;
  diffLocality: (attemptDir: string, baseDir: string) => DiffLocalityResult;
  now: () => number;
  interrupted: () => InterruptSignal | null;
  onBackend: (backend: ContractBackend) => void;
  limits: Partial<Limits>;
  out: (line: string) => void;
  changeManifest?: BrownfieldManifestEntry[];
  changeDir?: string;
}

export type BrownfieldTestsOutcome =
  | { kind: "written"; path: string; result: BrownfieldResult }
  | { kind: "refused"; message: string }
  | { kind: "infra"; message: string }
  | { kind: "interrupted"; signal: InterruptSignal };

export function brownfieldTestsProvenance(
  repoRoot: string = REPO_ROOT,
  paths: readonly string[] = BROWNFIELD_TESTS_PATHS,
): TestsProvenance {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of GIT_REPO_ENV) delete env[key];
  const git = (args: string[]): string => {
    const result = spawnSync("git", ["-C", repoRoot, ...args, "--", ...paths], {
      encoding: "utf8",
      env,
      timeout: GIT_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    if (result.error !== undefined || result.status !== 0) {
      const why = result.error?.message ?? `exit ${result.status}: ${(result.stderr ?? "").trim()}`;
      throw new Error(`git ${args.join(" ")} failed in ${repoRoot} (${why}); contract-tests-brownfield records tests provenance`);
    }
    return result.stdout ?? "";
  };
  const testsCommit = git(["log", "-1", "--format=%H"]).trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(testsCommit)) {
    throw new Error(`git log names no commit touching ${paths.join(", ")} (got ${JSON.stringify(testsCommit)})`);
  }
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
    // ungated
  }
  return { recorded, current };
}

function defaultImage(): { tag: string; ref: string; id: string } {
  const tag = readScoringImage(REPO_ROOT);
  return { tag, ...resolveImageId(tag) };
}

function removeStaleTempFiles(dir: string, isAlive: (pid: number) => boolean): string[] {
  const problems: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return problems;
  }
  for (const entry of entries) {
    const owner = tempFileOwner(BROWNFIELD_RESULTS_FILE, entry.name);
    if (owner === null || !entry.isFile() || owner === process.pid || isAlive(owner)) continue;
    try {
      unlinkSync(join(dir, entry.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        problems.push(`could not remove the stale ${join(dir, entry.name)}: ${message(error)}`);
      }
    }
  }
  return problems;
}

const DEFAULT_DEPS: BrownfieldTestsDeps = {
  createBackend: (options) => new AttemptBackend(options),
  runFile: runContractFile,
  image: defaultImage,
  isAlive: pidIsAlive,
  gate: defaultGate,
  provenance: () => brownfieldTestsProvenance(REPO_ROOT),
  diffLocality: computeDiffLocality,
  now: () => performance.now(),
  interrupted: () => null,
  onBackend: () => {},
  limits: {},
  out: (line) => console.log(line),
};

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

type Scored =
  | {
      kind: "complete";
      boot: BrownfieldResult["boot"];
      pipFreeze: string[];
      regressionGroups: GroupResult[];
      changeGroups: GroupResult[];
      warnings: string[];
      pytest: PytestResult;
    }
  | { kind: "infra"; message: string }
  | { kind: "interrupted"; signal: InterruptSignal };

async function scoreBrownfieldBackend(
  backend: ContractBackend,
  regressionManifest: ManifestEntry[],
  changeManifest: BrownfieldManifestEntry[],
  regressionDir: string,
  changeDir: string,
  d: BrownfieldTestsDeps,
  limits: Limits,
): Promise<Scored> {
  const warnings: string[] = [];
  const stopped = (stage: BootStage, detail: string, pipFreeze: string[]): Scored => {
    const boot = stoppedBoot(stage, detail);
    d.out(`backend stop (${stage}): ${brief(boot.detail)}`);
    return {
      kind: "complete",
      boot,
      pipFreeze,
      regressionGroups: stoppedGroups(regressionManifest),
      changeGroups: stoppedGroups(changeManifest),
      warnings,
      pytest: {
        ran: false,
        timedOut: false,
        exitCode: null,
        passed: 0,
        failed: 0,
        errors: 0,
        durationMs: 0,
        outputTail: "",
        notRunReason: "backend stop",
      },
    };
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
    message: `the overall budget of ${limits.overallMs / 1000} s ran out`,
  });

  const allManifestFiles: Array<{ entry: ManifestEntry; testsDir: string; isRegression: boolean }> = [
    ...regressionManifest.map((entry) => ({ entry, testsDir: regressionDir, isRegression: true })),
    ...changeManifest.map((entry) => ({ entry, testsDir: changeDir, isRegression: false })),
  ];

  const regressionGroups: GroupResult[] = [];
  const changeGroups: GroupResult[] = [];

  for (const [index, { entry, testsDir, isRegression }] of allManifestFiles.entries()) {
    const starts = index === 0 ? 1 : 1 + Math.max(0, limits.restartRetries);
    let ready: { baseUrl: string } | null = null;
    let last: { stage: BootStage; detail: string } | null = null;

    for (let n = 1; n <= starts && ready === null; n++) {
      const stop = interrupted();
      if (stop !== null) return stop;
      if (left() <= 0) return overBudget();
      const started = await backend.start();
      if (started.kind === "infra") {
        return { kind: "infra", message: `starting backend for ${entry.file}: ${started.detail}` };
      }
      if (started.kind === "ready") {
        ready = started;
        break;
      }
      last = { stage: started.stage, detail: started.detail };
      if (index > 0) {
        d.out(`${entry.file}: backend did not come up (${started.stage}: ${brief(started.detail, 200)})${n < starts ? "; retrying" : ""}`);
      }
    }

    const afterStart = interrupted();
    if (afterStart !== null) return afterStart;

    if (ready === null) {
      const failure = last as { stage: BootStage; detail: string };
      if (index === 0) return stopped(failure.stage, failure.detail, pipFreeze);
      const failedGroup = restartFailedGroup(entry, restartDetail(entry, starts, failure));
      if (isRegression) regressionGroups.push(failedGroup);
      else changeGroups.push(failedGroup);
      continue;
    }

    const budget = left();
    if (budget <= 0) return overBudget();
    const timeoutMs = Math.max(1, Math.floor(Math.min(limits.fileMs, budget)));
    d.out(`${entry.file}: running ${entry.tests} tests against ${ready.baseUrl}`);
    const result = await d.runFile({
      file: join(testsDir, entry.file),
      baseUrl: ready.baseUrl,
      seedPath: SEED_PATH,
      timeoutMs,
      expectedTests: entry.tests,
    });

    const afterFile = interrupted();
    if (afterFile !== null) return afterFile;
    if (result.timedOut && timeoutMs < limits.fileMs) return overBudget();

    const serving = await backend.servingState();
    if (serving.kind === "vanished") {
      return { kind: "infra", message: `serving container vanished during ${entry.file}` };
    }
    if (serving.kind === "unknown") return { kind: "infra", message: `after ${entry.file}: ${serving.detail}` };
    if (serving.kind === "exited") {
      warnings.push(`serving container exited with code ${serving.exitCode} during ${entry.file}`);
    }

    const removal = await backend.stop();
    if (!removal.removed) return { kind: "infra", message: `after ${entry.file}: ${removal.detail}` };

    const group = groupFromFileResult(entry, result);
    if (isRegression) regressionGroups.push(group);
    else changeGroups.push(group);
  }

  let pytest: PytestResult = {
    ran: false,
    timedOut: false,
    exitCode: null,
    passed: 0,
    failed: 0,
    errors: 0,
    durationMs: 0,
    outputTail: "",
    notRunReason: null,
  };

  if (backend.runPytest !== undefined) {
    d.out("running the attempt's backend tests (pytest)…");
    const pytestStep = await backend.runPytest(PYTEST_TIMEOUT_MS);
    const afterPytest = interrupted();
    if (afterPytest !== null) return afterPytest;
    if (pytestStep.kind === "infra") return { kind: "infra", message: pytestStep.detail };
    if (pytestStep.kind === "interrupted") return { kind: "interrupted", signal: pytestStep.signal };
    pytest = pytestStep.result;
    if (pytest.ran) {
      d.out(`pytest: ${pytest.passed} passed, ${pytest.failed} failed, ${pytest.errors} errors (exit ${pytest.exitCode})`);
    } else {
      d.out(`pytest: not run (${pytest.notRunReason ?? "unknown reason"})`);
    }
  }

  return {
    kind: "complete",
    boot: { ok: true, stage: null, detail: null },
    pipFreeze,
    regressionGroups,
    changeGroups,
    warnings,
    pytest,
  };
}

export async function runBrownfieldContractTests(
  options: BrownfieldTestsOptions,
  deps: Partial<BrownfieldTestsDeps> = {},
): Promise<BrownfieldTestsOutcome> {
  const d: BrownfieldTestsDeps = { ...DEFAULT_DEPS, ...deps };
  const limits: Limits = { ...LIMITS, ...d.limits };

  if (!ATTEMPT_DIR_RE.test(options.attempt)) {
    return { kind: "refused", message: `attempt directory name must match ${ATTEMPT_DIR_RE}, got ${JSON.stringify(options.attempt)}` };
  }
  const attemptDir = join(options.attemptsDir, options.attempt);
  if (!isDirectory(attemptDir)) {
    return { kind: "refused", message: `attempt directory does not exist: ${attemptDir}` };
  }

  let runImage: string | null = null;
  const warnings: string[] = [];
  if (!options.ignoreRunJson) {
    const runJsonDir = join(options.runJsonDir, options.attempt);
    const admitted = runJsonRefusal(runJsonDir, "contract-tests-brownfield");
    if ("refusal" in admitted) return { kind: "refused", message: admitted.refusal };
    if (admitted.run.image.trim() === "") {
      warnings.push("run.json records no image, so the image the attempt ran in is unknown");
    } else {
      runImage = admitted.run.image;
    }
  }

  const gate = d.gate(options.root);
  const ungated = gate.recorded === null || gate.recorded !== gate.current;
  if (ungated && !options.allowUngated) {
    return { kind: "refused", message: "tests differ from what gate vouched for (pass --allow-ungated to score anyway)" };
  }

  let imageInfo: { tag: string; ref: string; id: string };
  try {
    imageInfo = d.image();
  } catch (error) {
    return { kind: "infra", message: message(error) };
  }

  const resultsDir = join(options.root, "eval-results", options.attempt);
  for (const problem of removeStaleTempFiles(resultsDir, d.isAlive)) d.out(`warning: ${problem}`);

  const baseDir = options.baseDir ?? BASE_DIR;
  const diffLocality = d.diffLocality(attemptDir, baseDir);

  const regressionManifest = loadManifest(REPO_ROOT);
  const changeDir = d.changeDir ?? BROWNFIELD_CHANGE_DIR;
  const changeManifest = d.changeManifest ?? loadBrownfieldManifest(changeDir);
  const regressionDir = join(REPO_ROOT, "benchmark", "contract-tests");

  let provenance: TestsProvenance;
  try {
    provenance = d.provenance();
  } catch (error) {
    return { kind: "infra", message: message(error) };
  }

  const startedAt = new Date().toISOString();
  const startTime = d.now();

  const backend = d.createBackend({
    attemptDir,
    attemptName: options.attempt,
    image: imageInfo.id,
    hostPort: "ephemeral",
    limits,
  });
  d.onBackend(backend);

  let scored: Scored;
  try {
    scored = await scoreBrownfieldBackend(
      backend,
      regressionManifest,
      changeManifest,
      regressionDir,
      changeDir,
      d,
      limits,
    );
  } finally {
    await backend.dispose();
  }

  if (scored.kind === "infra") return { kind: "infra", message: scored.message };
  if (scored.kind === "interrupted") return { kind: "interrupted", signal: scored.signal };

  const durationMs = d.now() - startTime;
  const diagnosis = diagnose(scored.regressionGroups);
  const rubric = brownfieldRubricId(REPO_ROOT);

  const result = buildBrownfieldResult({
    attempt: options.attempt,
    image: imageInfo.ref,
    runImage,
    rubric,
    testsCommit: provenance.testsCommit,
    testsDirty: provenance.testsDirty,
    ungated,
    startedAt,
    durationMs,
    pipFreeze: scored.pipFreeze,
    warnings: scored.warnings,
    boot: scored.boot,
    diagnosis,
    regressionGroups: scored.regressionGroups,
    changeGroups: scored.changeGroups,
    diffLocality,
    pytest: scored.pytest,
  });

  const resultsPath = join(resultsDir, BROWNFIELD_RESULTS_FILE);
  try {
    writeBrownfieldContractResults(resultsPath, result);
  } catch (error) {
    return { kind: "infra", message: `writing results: ${message(error)}` };
  }

  d.out(`wrote ${resultsPath}`);
  for (const line of brownfieldSummaryLines(result)) {
    d.out(line);
  }

  return { kind: "written", path: resultsPath, result };
}

export function parseArgs(args: string[]): BrownfieldTestsOptions {
  let attempt: string | undefined;
  let root = DEFAULT_TRACK_ROOT;
  let attemptsDir: string | undefined;
  let runJsonDir: string | undefined;
  let baseDir: string | undefined;
  let ignoreRunJson = false;
  let allowUngated = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--attempt") {
      attempt = args[++i];
    } else if (arg === "--root") {
      root = resolve(args[++i]);
    } else if (arg === "--attempts-dir") {
      attemptsDir = resolve(args[++i]);
    } else if (arg === "--run-json-dir") {
      runJsonDir = resolve(args[++i]);
    } else if (arg === "--base") {
      baseDir = resolve(args[++i]);
    } else if (arg === "--ignore-run-json") {
      ignoreRunJson = true;
    } else if (arg === "--allow-ungated") {
      allowUngated = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!attempt) {
    throw new Error("missing required argument: --attempt <dir>");
  }

  const effectiveAttemptsDir = attemptsDir ?? (existsSync(join(root, "eval-attempts")) ? join(root, "eval-attempts") : join(REPO_ROOT, "eval-attempts"));
  const effectiveRunJsonDir = runJsonDir ?? (existsSync(join(root, "eval-results")) ? join(root, "eval-results") : join(REPO_ROOT, "eval-results"));

  return {
    attempt,
    root,
    attemptsDir: effectiveAttemptsDir,
    runJsonDir: effectiveRunJsonDir,
    baseDir,
    ignoreRunJson,
    allowUngated,
  };
}

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  let options: BrownfieldTestsOptions;
  try {
    options = parseArgs(args);
  } catch (error) {
    console.error(`usage error: ${message(error)}`);
    process.exit(2);
  }

  let current: ContractBackend | null = null;
  const handlers = installInterruptHandlers({
    cleanups: [
      async () => {
        if (current === null) return;
        for (const removal of await current.dispose()) {
          if (!removal.removed) console.error(`contract-tests-brownfield: ${removal.detail}`);
        }
      },
      () => stopAllBackends(),
    ],
    exitCleanups: [stopAllBackendsSync],
  });

  const outcome = await runBrownfieldContractTests(options, {
    interrupted: handlers.interrupted,
    onBackend: (backend) => {
      current = backend;
    },
  });

  if (outcome.kind === "written") {
    process.exit(0);
  } else if (outcome.kind === "refused") {
    console.error(`refused: ${outcome.message}`);
    process.exit(1);
  } else if (outcome.kind === "infra") {
    console.error(`infra error: ${outcome.message}`);
    process.exit(1);
  } else if (outcome.kind === "interrupted") {
    process.exit(128 + (outcome.signal === "SIGINT" ? 2 : 15));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
