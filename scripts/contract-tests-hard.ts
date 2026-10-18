/**
 * Runs the hard track's hidden suite — the differential fuzz — against one
 * attempt's backend and writes
 * `<root>/eval-results/<dir>/contract-results-hard.json`:
 *
 *   node --import tsx scripts/contract-tests-hard.ts --attempt <dir> [--root <path>]
 *        [--attempts-dir <path>] [--run-json-dir <path>] [--ignore-run-json] [--allow-ungated]
 *
 * `scripts/contract-tests.ts`, changed where the track differs and nowhere
 * else (the P2 plan, Task 6): the tests and their manifest come from
 * `<root>/benchmark/fuzz` (Ruling H2: a track root mirrors the repository
 * root, and `--root` is the only way to name one); the attempts are read from
 * `--attempts-dir` (default `<root>/eval-attempts`) and their `run.json` from
 * `--run-json-dir` (default `<root>/eval-results`), so the published attempts
 * can be scored where they lie; the result is an envelope whose `fuzz` half
 * carries the stratum mean; and the gate that must vouch for the tests is gate
 * P2-B (`npm run gate:fuzz`), not gate 2.
 *
 * It never writes `contract-results.json`, and never under the repository's own
 * `eval-results/`: that name and place belong to the published track.
 *
 * Exit 0: the result was written (a backend stop included). Exit 1: refused,
 * or a harness fault; nothing written. Exit 2: usage. 128+N: interrupted by a
 * signal; nothing written, every container and the scratch directory removed.
 *
 * Signal-sensitive: invoke it as `node --import tsx scripts/contract-tests-hard.ts`,
 * never through the `tsx` bin. Importing this module installs nothing; `main`
 * installs the handlers.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ContractBackend, GateState, TestsProvenance } from "./contract-tests";
import {
  AttemptBackend,
  stopAllBackends,
  stopAllBackendsSync,
  type BackendOptions,
} from "./lib/attempt-backend";
import { tempFileOwner } from "./lib/atomic-write";
import { ATTEMPT_DIR_RE } from "./lib/attempts";
import {
  diagnose,
  groupFromFileResult,
  restartFailedGroup,
  stoppedBoot,
  stoppedGroups,
  type BootStage,
  type ContractResults,
  type GroupResult,
} from "./lib/contract-results";
import { runContractFile, type ContractFileResult, type RunContractFileOptions } from "./lib/contract-suite";
import { pidIsAlive, resolveImageId } from "./lib/docker";
import { FUZZ_GATE_RESULT_PATH, fuzzOracleFingerprint } from "./lib/gate-fingerprint";
import {
  HARD_LIMITS,
  HARD_RESULTS_FILE,
  buildHardResult,
  entryTimeout,
  loadHardManifest,
  writeHardContractResults,
  type HardManifestEntry,
  type HardResult,
} from "./lib/hard-contract-results";
import { installInterruptHandlers, type InterruptSignal } from "./lib/interrupt";
import { LIMITS, rubricId, type Limits } from "./lib/rubric";
import { runJsonRefusal } from "./lib/run-json";
import { readScoringImage } from "./lib/runner-config";

/** This repository: the seed, gate P2-B's record and runner.yaml. */
export const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
/** The one track this repository has a gate P2-B record for. */
export const DEFAULT_TRACK_ROOT = join(REPO_ROOT, "tracks", "console-fuzz");
const SEED_PATH = join(REPO_ROOT, "benchmark", "context", "seed.json");
/** What `testsCommit` and `testsDirty` describe: the files a fuzz verdict is made of (gate P2-B's, less the reference and seed). */
export const HARD_TESTS_PATHS: readonly string[] = Object.freeze([
  "tracks/console-fuzz/benchmark/fuzz/cases.json",
  "tracks/console-fuzz/benchmark/fuzz/expected.json",
  "tracks/console-fuzz/benchmark/fuzz/replay.ts",
  "tracks/console-fuzz/benchmark/fuzz/fuzz.test.ts",
  "tracks/console-fuzz/benchmark/fuzz/manifest.json",
]);
const GIT_TIMEOUT_MS = 30_000;
/** The variables that point git at another repository, work tree, index or object store (see contract-tests.ts). */
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

export interface HardTestsOptions {
  /** The attempt directory's name, `<id>-attempt-<n>`. */
  attempt: string;
  /** The track root: holds `benchmark/fuzz/` and receives `eval-results/<attempt>/contract-results-hard.json`. Absolute. */
  root: string;
  /** Where the attempt directories are. Absolute. */
  attemptsDir: string;
  /** Where each attempt's `run.json` is, under `<attempt>/`. Absolute. */
  runJsonDir: string;
  /** Score without reading `run.json`: synthetic attempts only. `runImage` is then `null`. */
  ignoreRunJson: boolean;
  /** Score even though the tests differ from what gate P2-B vouched for; recorded as `ungated: true`. */
  allowUngated: boolean;
}

export interface HardTestsDeps {
  /** Given the bare image Id (`sha256:…`) as `image`, never the tag. */
  createBackend: (options: BackendOptions) => ContractBackend;
  runFile: (options: RunContractFileOptions) => Promise<ContractFileResult>;
  /** The image tag from runner.yaml, its `<tag>@<Id>` and the bare Id. Throws when it cannot be resolved. */
  image: () => { tag: string; ref: string; id: string };
  isAlive: (pid: number) => boolean;
  /** Gate P2-B's recorded fingerprint (`null` when there is none for this root) and the files' current one. */
  gate: (root: string) => GateState;
  provenance: () => TestsProvenance;
  now: () => number;
  interrupted: () => InterruptSignal | null;
  onBackend: (backend: ContractBackend) => void;
  /** Tests only: shorter budgets. */
  limits: Partial<Limits>;
  out: (line: string) => void;
}

export type HardTestsOutcome =
  | { kind: "written"; path: string; result: HardResult }
  | { kind: "refused"; message: string }
  | { kind: "infra"; message: string }
  | { kind: "interrupted"; signal: InterruptSignal };

// ---------------------------------------------------------------------------
// the defaults: the real repository, docker and git

/** `git log -1` and `git status --porcelain` over `paths`, in `repoRoot` whatever the inherited environment points git at. */
export function hardTestsProvenance(repoRoot: string = REPO_ROOT, paths: readonly string[] = HARD_TESTS_PATHS): TestsProvenance {
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
      throw new Error(`git ${args.join(" ")} failed in ${repoRoot} (${why}); contract-tests-hard records the fuzz's commit and needs the repository's git history`);
    }
    return result.stdout ?? "";
  };
  const testsCommit = git(["log", "-1", "--format=%H"]).trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(testsCommit)) {
    throw new Error(`git log names no commit touching ${paths.join(", ")} (got ${JSON.stringify(testsCommit)})`);
  }
  return { testsCommit, testsDirty: git(["status", "--porcelain", "--untracked-files=all"]).trim() !== "" };
}

/**
 * Gate P2-B's record against the files as they are. A root other than this
 * repository's own track has no record — what would run there is not what the
 * record's fingerprint covers — so it is ungated.
 */
function defaultGate(root: string): GateState {
  const current = fuzzOracleFingerprint(REPO_ROOT);
  let recorded: string | null = null;
  if (resolve(root) === DEFAULT_TRACK_ROOT) {
    try {
      const raw: unknown = JSON.parse(readFileSync(join(REPO_ROOT, FUZZ_GATE_RESULT_PATH), "utf8"));
      const fingerprint = (raw as { fingerprint?: unknown } | null)?.fingerprint;
      if (typeof fingerprint === "string" && fingerprint !== "") recorded = fingerprint;
    } catch {
      // no record, or not one we can read: the tests are ungated
    }
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
 * `tempFileOwner` recognises for THIS file's name, only regular files, and
 * only when the pid in the name is dead. The prefix differs from
 * contract-tests.ts's (`.contract-results.json.` does not match
 * `.contract-results-hard.json.`), so neither CLI cleans up for the other.
 */
function removeStaleTempFiles(dir: string, isAlive: (pid: number) => boolean): string[] {
  const problems: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return problems;
  }
  for (const entry of entries) {
    const owner = tempFileOwner(HARD_RESULTS_FILE, entry.name);
    if (owner === null || !entry.isFile() || owner === process.pid || isAlive(owner)) continue;
    try {
      unlinkSync(join(dir, entry.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") problems.push(`could not remove the stale ${join(dir, entry.name)}: ${message(error)}`);
    }
  }
  return problems;
}

const DEFAULT_DEPS: HardTestsDeps = {
  createBackend: (options) => new AttemptBackend(options),
  runFile: runContractFile,
  image: defaultImage,
  isAlive: pidIsAlive,
  gate: defaultGate,
  provenance: () => hardTestsProvenance(REPO_ROOT),
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

function restartDetail(entry: HardManifestEntry, starts: number, last: { stage: BootStage; detail: string }): string {
  return `${last.detail}\n(the backend booted for the first file but not again for ${entry.file}: ${starts} ${starts === 1 ? "start" : "starts"}, the last a ${last.stage} failure)`;
}

/** The progress lines for the scored file: its stratum mean, not the raw passed/total the frozen group carries. */
export function hardSummaryLines(result: HardResult): string[] {
  const group = result.contract.groups[0];
  return [`  ${group.row}: ${result.fuzz.passed}/${result.fuzz.total} cases, stratum mean ${result.fuzz.score}/${group.max}`, `  ${result.fuzz.note}`];
}

type Scored =
  | { kind: "complete"; boot: ContractResults["boot"]; pipFreeze: string[]; groups: GroupResult[]; warnings: string[] }
  | { kind: "infra"; message: string }
  | { kind: "interrupted"; signal: InterruptSignal };

/**
 * The hard suite against `backend`: layout, install, freeze, then one fresh
 * container per manifest file. Never disposes the backend; the caller does,
 * on every path.
 */
async function scoreBackend(
  backend: ContractBackend,
  manifest: HardManifestEntry[],
  testsDir: string,
  d: HardTestsDeps,
  limits: Limits,
): Promise<Scored> {
  const warnings: string[] = [];
  const stopped = (stage: BootStage, detail: string, pipFreeze: string[]): Scored => {
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
    message: `the overall budget of ${limits.overallMs / 1000} s for the hard-suite files ran out; that guards against a runaway harness and is not the model's`,
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
    // The entry's own timeoutMs (Ruling H6), never more than the overall budget has left.
    const timeoutMs = entryTimeout(entry, budget);
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
    // A timer the overall budget shortened fired: the budget ran out, not the file's own.
    if (result.timedOut && timeoutMs < (entry.timeoutMs ?? HARD_LIMITS.fileMs)) return overBudget();

    const serving = await backend.servingState();
    if (serving.kind === "vanished") {
      return { kind: "infra", message: `the serving container vanished during ${entry.file}: something outside contract-tests-hard removed it, so that file's failures are not the model's` };
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
 * The whole of `contract-tests-hard` except argument parsing and signal
 * handling: refusals, image, provenance, the scored run, and the write. Every
 * dependency on docker, git, the clock and the suite runner is injectable.
 */
export async function runHardContractTests(options: HardTestsOptions, deps: Partial<HardTestsDeps> = {}): Promise<HardTestsOutcome> {
  const d: HardTestsDeps = { ...DEFAULT_DEPS, ...deps };
  const limits: Limits = { ...LIMITS, fileMs: HARD_LIMITS.fileMs, overallMs: HARD_LIMITS.overallMs, ...d.limits };
  const startedAt = new Date().toISOString();
  const t0 = d.now();
  const refused = (text: string): HardTestsOutcome => ({ kind: "refused", message: `${text}\nNothing was written.` });
  const infra = (text: string): HardTestsOutcome => ({
    kind: "infra",
    message: `${text}\nA harness fault, not the model's: nothing was written. Fix it and run contract-tests-hard again.`,
  });

  // --- refusals: nothing is started ---------------------------------------
  if (!ATTEMPT_DIR_RE.test(options.attempt)) return refused(`--attempt takes an attempt directory name like gemini-38-flash-high-attempt-1, got ${JSON.stringify(options.attempt)}`);
  const attemptDir = join(options.attemptsDir, options.attempt);
  const runJsonDir = join(options.runJsonDir, options.attempt);
  const resultsDir = join(options.root, "eval-results", options.attempt);
  if (!isDirectory(attemptDir)) return refused(`no attempt directory at ${attemptDir}`);

  const warnings: string[] = [];
  let runImage: string | null = null;
  if (!options.ignoreRunJson) {
    const admitted = runJsonRefusal(runJsonDir, "contract-tests-hard");
    if ("refusal" in admitted) return refused(admitted.refusal);
    if (admitted.run.image.trim() === "") warnings.push("run.json records no image, so the image the attempt ran in is unknown");
    else runImage = admitted.run.image;
  }
  let ungated: boolean;
  let oracle: string;
  try {
    const gate = d.gate(options.root);
    ungated = gate.recorded === null || gate.recorded !== gate.current;
    // The era is what actually runs: the files' current fingerprint, which is
    // the record's own whenever the run is gated.
    oracle = gate.current.slice(0, 12);
    if (ungated && !options.allowUngated) {
      return refused(
        gate.recorded === null
          ? `gate P2-B has no readable record for ${options.root} (${FUZZ_GATE_RESULT_PATH}), so nothing vouches for the fuzz. Run \`npm run gate:fuzz\`, or pass --allow-ungated to score anyway (recorded as ungated: true).`
          : `the fuzz, its oracle, the seed or the reference differ from what gate P2-B vouched for (recorded ${gate.recorded.slice(0, 12)}, now ${gate.current.slice(0, 12)}). Run \`npm run gate:fuzz\`, or pass --allow-ungated to score anyway (recorded as ungated: true).`,
      );
    }
  } catch (error) {
    return infra(`could not fingerprint the fuzz for gate P2-B: ${message(error)}`);
  }

  // --- what the result records, all before any container ------------------
  let manifest: HardManifestEntry[];
  let rubric: string;
  let provenance: TestsProvenance;
  let image: { tag: string; ref: string; id: string };
  try {
    manifest = loadHardManifest(options.root);
    // The PUBLISHED id: the frozen parser accepts nothing else, and nobody keys on it (see hard-contract-results.ts).
    rubric = rubricId(REPO_ROOT);
    provenance = d.provenance();
    image = d.image();
  } catch (error) {
    return infra(message(error));
  }
  if (runImage !== null && runImage !== image.ref) {
    warnings.push(`the fuzz ran in ${image.ref}, but run.json records that the attempt ran in ${runImage} (a harness note, not the model's)`);
  }
  const early = d.interrupted();
  if (early !== null) return { kind: "interrupted", signal: early };

  // --- the run --------------------------------------------------------------
  d.out(`contract-tests-hard: ${options.attempt} in ${image.ref}`);
  let scored: Scored;
  let backend: ContractBackend | null = null;
  try {
    // By Id: a retag of the tag during the run cannot change what later containers run.
    backend = d.createBackend({ attemptDir, attemptName: options.attempt, image: image.id, hostPort: "ephemeral" });
    d.onBackend(backend);
    scored = await scoreBackend(backend, manifest, join(options.root, "benchmark", "fuzz"), d, limits);
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

  const contract: ContractResults = {
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
  let result: HardResult;
  try {
    result = buildHardResult(contract, oracle);
  } catch (error) {
    // The suite's own counts contradict each other: the test file is at fault, not the model.
    return infra(`the fuzz's result does not add up: ${message(error)}`);
  }

  // Let a signal that is already pending land before the write, so a run the
  // operator stopped at the last moment is not recorded.
  await new Promise<void>((done) => setImmediate(done));
  const late = d.interrupted();
  if (late !== null) return { kind: "interrupted", signal: late };

  const path = join(resultsDir, HARD_RESULTS_FILE);
  for (const problem of removeStaleTempFiles(resultsDir, d.isAlive)) d.out(`warning: ${problem}`);
  try {
    writeHardContractResults(path, result, manifest);
  } catch (error) {
    return infra(`could not write ${path}: ${message(error)}`);
  }
  for (const line of hardSummaryLines(result)) d.out(line);
  for (const warning of result.contract.warnings) d.out(`warning: ${warning}`);
  if (result.contract.ungated) d.out("warning: ungated — the fuzz differs from what gate P2-B vouched for");
  d.out(`wrote ${path}`);
  return { kind: "written", path, result };
}

// ---------------------------------------------------------------------------
// CLI

const USAGE = `Usage: node --import tsx scripts/contract-tests-hard.ts --attempt <dir> [--root <path>]
        [--attempts-dir <path>] [--run-json-dir <path>] [--ignore-run-json] [--allow-ungated]

  --attempt <dir>       Attempt directory name, <id>-attempt-<n>.
  --root <path>         The track root: holds benchmark/fuzz/ and receives
                        eval-results/<dir>/${HARD_RESULTS_FILE}.
                        Default: tracks/console-fuzz of this repository.
  --attempts-dir <path> Where the attempt directories are.
                        Default: <root>/eval-attempts.
  --run-json-dir <path> Where <dir>/run.json is. Default: <root>/eval-results.
  --ignore-run-json     Score without run.json (synthetic attempts only).
  --allow-ungated       Score although the fuzz differs from gate P2-B's
                        record; the result says ungated: true.
  --help                Print this message.

Exit 0: written (a backend stop included). 1: refused or a harness fault,
nothing written. 2: usage. 128+N: interrupted, nothing written.
`;

class UsageError extends Error {}

export function parseArgs(argv: string[]): HardTestsOptions & { help: boolean } {
  const args = { attempt: "", root: DEFAULT_TRACK_ROOT, attemptsDir: "", runJsonDir: "", ignoreRunJson: false, allowUngated: false, help: false };
  let attempt: string | null = null;
  const given = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const eq = token.startsWith("--") ? token.indexOf("=") : -1;
    const name = eq === -1 ? token : token.slice(0, eq);
    const value = (): string => {
      if (given.has(name)) throw new UsageError(`${name} given twice`);
      given.add(name);
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
        attempt = value();
        break;
      case "--root":
        args.root = resolve(value());
        break;
      case "--attempts-dir":
        args.attemptsDir = resolve(value());
        break;
      case "--run-json-dir":
        args.runJsonDir = resolve(value());
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
  if (args.attemptsDir === "") args.attemptsDir = join(args.root, "eval-attempts");
  if (args.runJsonDir === "") args.runJsonDir = join(args.root, "eval-results");
  return args;
}

async function main(argv: string[]): Promise<void> {
  let args: HardTestsOptions & { help: boolean };
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`contract-tests-hard: ${error.message}\n\n${USAGE}`);
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
          if (!removal.removed) console.error(`contract-tests-hard: ${removal.detail}`);
        }
      },
      () => stopAllBackends(),
    ],
    exitCleanups: [stopAllBackendsSync],
  });

  let outcome: HardTestsOutcome;
  try {
    outcome = await runHardContractTests(args, {
      interrupted: handlers.interrupted,
      onBackend: (backend) => {
        current = backend;
      },
    });
  } catch (error) {
    outcome = { kind: "infra", message: `contract-tests-hard failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}` };
  }

  // Synchronous from the write to the exit: no signal handler can run between them.
  if (outcome.kind === "written") process.exit(0);
  if (outcome.kind !== "interrupted") {
    await new Promise((done) => setTimeout(done, SIGNAL_SETTLE_MS));
    if (handlers.interrupted() === null) {
      process.stderr.write(`contract-tests-hard: ${outcome.message}\n`);
      process.exit(1);
    }
  }
  // Interrupted: the handler finishes its cleanups and exits 128+N.
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2));
}
