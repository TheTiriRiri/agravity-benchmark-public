/**
 * `eval-results/<dir>/contract-results.json` — what the hidden contract tests
 * made of one attempt's backend. The only place its shape is defined.
 *
 * `scripts/contract-tests.ts` builds it from `runContractFile` results and
 * writes it; `scripts/contract-results.ts --rows` prints the four hidden-test
 * CSV lines from it, which the scoring skill pastes verbatim. Its `boot` is
 * the only source of a backend stop for `Local build` and the four rows.
 *
 * Hashed into the rubric id: the Notes forms and the validation below decide
 * what a score says, so changing them needs a new `rubric:` in runner.yaml.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { writeFileAtomic } from "./atomic-write";
import { ATTEMPT_DIR_RE } from "./attempts";
import type { ContractFileResult, FailedTest } from "./contract-suite";
import { HIDDEN_ROWS, roundScore } from "./rubric";

export type { FailedTest } from "./contract-suite";

export const CONTRACT_RESULTS_FILE = "contract-results.json";

/** The model-owned stage a backend stop happened in (spec §5, failure taxonomy). */
export type BootStage = "layout" | "install" | "boot" | "health";

export interface GroupResult {
  /** The rubric row, from the manifest. */
  row: string;
  /** The test file's name, from the manifest. */
  file: string;
  max: number;
  /** The manifest's test count, always. */
  total: number;
  passed: number;
  /** `roundScore(passed, total, max)`. */
  score: number;
  /** The per-file timer cut the file short; its `notRun` tests scored as failed. */
  timedOut: boolean;
  /** How many of `failed` failed in `beforeEach(reset)`. */
  hookFailed: number;
  /** Tests that never reported: cut by the timer, or never started (a stop, a failed restart). */
  notRun: number;
  /** Why the file did not run although the backend booted — a restart that failed twice. `null` otherwise. */
  detail: string | null;
  failed: FailedTest[];
}

export interface ContractResults {
  schemaVersion: 1;
  /** The attempt directory's name, `<id>-attempt-<n>`. */
  attempt: string;
  /** The image the tests ran in, `<tag>@<image id>`. */
  image: string;
  /** The image `run.json` recorded; `null` for a synthetic attempt. */
  runImage: string | null;
  /** `rubricId()` of the files at run time. */
  rubric: string;
  /** The last commit touching the hidden tests, the seed or contract-suite.ts. */
  testsCommit: string;
  /** Whether any of those had uncommitted changes. */
  testsDirty: boolean;
  /** Run with `--allow-ungated`: the hidden tests differ from what gate 2 vouched for. */
  ungated: boolean;
  /** When the run started, as `Date.prototype.toISOString()` writes it. */
  startedAt: string;
  /** Whole milliseconds. */
  durationMs: number;
  /** `pip freeze` of the venv the tests ran against; empty when the install never happened. */
  pipFreeze: string[];
  warnings: string[];
  /** `ok: false` is a backend stop, with its stage and detail; `ok: true` has both `null`. */
  boot: { ok: boolean; stage: BootStage | null; detail: string | null };
  diagnosis: "reset-broken" | null;
  /** Exactly the manifest's four files, in its order — present on a backend stop too, all zero. */
  groups: GroupResult[];
}

export interface ManifestEntry {
  file: string;
  row: string;
  max: number;
  tests: number;
}

/** The repository this module lives in: the hidden tests and their manifest always come from here. */
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MANIFEST_PATH = join("benchmark", "contract-tests", "manifest.json");
const BOOT_STAGES: readonly BootStage[] = ["layout", "install", "boot", "health"];
/** A detail quoted in Notes keeps its last this-many characters; the whole of it stays in the JSON. */
const NOTES_DETAIL_LIMIT = 400;
/** Between failed test names in Notes. Names carry commas and colons, never this. */
const NAME_SEPARATOR = " | ";
/** The endpoint a failure message starts with: `POST /work-orders answered 500 …`, `POST /reset: TimeoutError …`. */
const ENDPOINT_PREFIX = /^(GET|POST|PUT|PATCH|DELETE) (\S+?)(?: answered|:)/;

// --- manifest ----------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `benchmark/contract-tests/manifest.json` under `repoRoot`, checked against
 * `HIDDEN_ROWS`: the same four rows with the same maxima, in the same order.
 */
export function loadManifest(repoRoot: string): ManifestEntry[] {
  const path = join(repoRoot, MANIFEST_PATH);
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const files = isRecord(raw) ? raw.files : undefined;
  if (!Array.isArray(files)) throw new Error(`${path}: expected {"files": [...]}`);
  const entries = files.map((entry: unknown, i): ManifestEntry => {
    const where = `${path}: files[${i}]`;
    if (!isRecord(entry)) throw new Error(`${where} is not an object`);
    const { file, row, max, tests } = entry;
    if (typeof file !== "string" || !/^[a-z0-9-]+\.test\.ts$/.test(file)) throw new Error(`${where}.file must be a test file's base name, got ${JSON.stringify(file)}`);
    if (typeof row !== "string") throw new Error(`${where}.row must be a string`);
    if (typeof max !== "number" || !Number.isFinite(max) || max <= 0) throw new Error(`${where}.max must be a positive number`);
    if (typeof tests !== "number" || !Number.isInteger(tests) || tests < 1) throw new Error(`${where}.tests must be a positive integer`);
    return { file, row, max, tests };
  });
  const got = entries.map((e) => `${e.row} (max ${e.max})`);
  const want = HIDDEN_ROWS.map((r) => `${r.name} (max ${r.max})`);
  if (got.join("\n") !== want.join("\n")) {
    throw new Error(`${path} does not match rubric.ts's hidden-test rows.\n  manifest: ${got.join("; ")}\n  rubric.ts: ${want.join("; ")}`);
  }
  if (new Set(entries.map((e) => e.file)).size !== entries.length) throw new Error(`${path}: a file is listed twice`);
  return entries;
}

// --- building groups -----------------------------------------------------------

/** One file's result as scored. Throws if it does not add up — a harness fault, never the model's. */
export function groupFromFileResult(entry: ManifestEntry, r: ContractFileResult): GroupResult {
  if (r.total !== entry.tests) {
    throw new Error(`${entry.file}: the run counted ${r.total} tests but the manifest says ${entry.tests}`);
  }
  if (r.passed + r.failed.length + r.notRun !== r.total) {
    throw new Error(`${entry.file}: passed ${r.passed} + failed ${r.failed.length} + not run ${r.notRun} is not ${r.total}`);
  }
  return {
    row: entry.row,
    file: entry.file,
    max: entry.max,
    total: r.total,
    passed: r.passed,
    score: roundScore(r.passed, r.total, entry.max),
    timedOut: r.timedOut,
    hookFailed: r.hookFailed,
    notRun: r.notRun,
    detail: null,
    failed: r.failed.map((f) => ({ name: f.name, failureType: f.failureType, message: f.message })),
  };
}

function unrunGroup(entry: ManifestEntry, detail: string | null): GroupResult {
  return {
    row: entry.row,
    file: entry.file,
    max: entry.max,
    total: entry.tests,
    passed: 0,
    score: 0,
    timedOut: false,
    hookFailed: 0,
    notRun: entry.tests,
    detail,
    failed: [],
  };
}

/** Every group of a backend stop: nothing ran, everything scores 0 out of the manifest's count. */
export function stoppedGroups(manifest: ManifestEntry[]): GroupResult[] {
  return manifest.map((entry) => unrunGroup(entry, null));
}

/** What an empty or whitespace-only stop detail becomes: a backend stop always says something. */
export const EMPTY_STOP_DETAIL = "(the container printed nothing)";

/**
 * The `boot` of a backend stop — the only way to build one. Validation
 * rejects a stop without a detail, so an empty one (a crashed container whose
 * `docker logs` is empty, say) becomes `EMPTY_STOP_DETAIL` here instead of
 * turning a model stop into a write failure. Any other detail is kept as is.
 */
export function stoppedBoot(stage: BootStage, detail: string): { ok: false; stage: BootStage; detail: string } {
  return { ok: false, stage, detail: detail.trim() === "" ? EMPTY_STOP_DETAIL : detail };
}

/** A file whose serving container failed to restart twice after a good first boot: 0, with the reason. */
export function restartFailedGroup(entry: ManifestEntry, detail: string): GroupResult {
  return unrunGroup(entry, detail.trim() === "" ? "(no detail)" : detail);
}

/**
 * `"reset-broken"` when no test in any file passed, every test that ran failed
 * in `beforeEach(reset)`, and every file ran at least one. Tests a timeout cut
 * short are ignored: a hanging `/reset` costs 10 s a test, so the longer files
 * are cut while the shorter ones finish.
 */
export function diagnose(groups: GroupResult[]): "reset-broken" | null {
  if (groups.length === 0) return null;
  const broken = groups.every(
    (g) => g.passed === 0 && g.failed.length > 0 && g.failed.every((f) => f.failureType === "hookFailed"),
  );
  return broken ? "reset-broken" : null;
}

// --- validation ----------------------------------------------------------------

class Invalid extends Error {}

function fail(path: string, problem: string): never {
  throw new Invalid(`${path} ${problem}`);
}

function describe(value: unknown): string {
  if (value === undefined) return "undefined";
  const text = JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

function record(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) fail(path, `must be an object, got ${describe(value)}`);
  for (const key of keys) if (!Object.hasOwn(value, key)) fail(path, `is missing "${key}"`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(path, `has an unexpected field "${key}"`);
  return value;
}

function string(value: unknown, path: string, options: { nonEmpty?: boolean; pattern?: RegExp } = {}): string {
  if (typeof value !== "string") fail(path, `must be a string, got ${describe(value)}`);
  if (options.nonEmpty && value.trim() === "") fail(path, "must not be empty");
  if (options.pattern && !options.pattern.test(value)) fail(path, `must match ${options.pattern}, got ${describe(value)}`);
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  return value === null ? null : string(value, path, { nonEmpty: true });
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, `must be true or false, got ${describe(value)}`);
  return value;
}

function count(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) fail(path, `must be a non-negative integer, got ${describe(value)}`);
  return value;
}

function strings(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) fail(path, `must be an array of strings, got ${describe(value)}`);
  return value.map((item, i) => string(item, `${path}[${i}]`));
}

const TOP_KEYS = [
  "schemaVersion", "attempt", "image", "runImage", "rubric", "testsCommit", "testsDirty", "ungated",
  "startedAt", "durationMs", "pipFreeze", "warnings", "boot", "diagnosis", "groups",
] as const;
const BOOT_KEYS = ["ok", "stage", "detail"] as const;
const GROUP_KEYS = ["row", "file", "max", "total", "passed", "score", "timedOut", "hookFailed", "notRun", "detail", "failed"] as const;
const FAILED_KEYS = ["name", "failureType", "message"] as const;

function failedTest(value: unknown, path: string): FailedTest {
  const f = record(value, path, FAILED_KEYS);
  return {
    name: string(f.name, `${path}.name`, { nonEmpty: true }),
    failureType: string(f.failureType, `${path}.failureType`, { nonEmpty: true }),
    message: string(f.message, `${path}.message`, { nonEmpty: true }),
  };
}

function group(value: unknown, path: string, entry: ManifestEntry, booted: boolean): GroupResult {
  const g = record(value, path, GROUP_KEYS);
  const row = string(g.row, `${path}.row`);
  const file = string(g.file, `${path}.file`);
  if (row !== entry.row || file !== entry.file) {
    fail(path, `is ${describe(row)} / ${describe(file)} but the manifest's entry ${describe(entry.row)} / ${describe(entry.file)} belongs here`);
  }
  if (g.max !== entry.max) fail(`${path}.max`, `must be the manifest's ${entry.max}, got ${describe(g.max)}`);
  if (g.total !== entry.tests) fail(`${path}.total`, `must be the manifest's ${entry.tests}, got ${describe(g.total)}`);
  const total = entry.tests;
  const passed = count(g.passed, `${path}.passed`);
  if (passed > total) fail(`${path}.passed`, `is ${passed}, more than total ${total}`);
  if (typeof g.score !== "number") fail(`${path}.score`, `must be a number, got ${describe(g.score)}`);
  const expected = roundScore(passed, total, entry.max);
  if (g.score !== expected) fail(`${path}.score`, `is ${g.score} but roundScore(${passed}, ${total}, ${entry.max}) is ${expected}`);
  const timedOut = boolean(g.timedOut, `${path}.timedOut`);
  const hookFailed = count(g.hookFailed, `${path}.hookFailed`);
  const notRun = count(g.notRun, `${path}.notRun`);
  const detail = nullableString(g.detail, `${path}.detail`);
  if (!Array.isArray(g.failed)) fail(`${path}.failed`, `must be an array, got ${describe(g.failed)}`);
  const failed = g.failed.map((f, i) => failedTest(f, `${path}.failed[${i}]`));

  if (passed + failed.length + notRun !== total) {
    fail(path, `does not add up: passed ${passed} + failed ${failed.length} + notRun ${notRun} is not total ${total}`);
  }
  const inHook = failed.filter((f) => f.failureType === "hookFailed").length;
  if (hookFailed !== inHook) fail(`${path}.hookFailed`, `is ${hookFailed} but ${inHook} of failed[] have failureType "hookFailed"`);
  const unrun = detail !== null || !booted;
  if (unrun && (passed !== 0 || failed.length !== 0 || timedOut)) {
    fail(path, `did not run (${!booted ? "a backend stop" : "restart failed"}) yet reports passed, failed or timed-out tests`);
  }
  if (!booted && detail !== null) fail(`${path}.detail`, "must be null on a backend stop; the stop's reason is boot.detail");
  if (notRun > 0 && !timedOut && !unrun) fail(`${path}.notRun`, `is ${notRun}, but the file neither timed out, nor failed to restart, nor was stopped`);
  return { row, file, max: entry.max, total, passed, score: expected, timedOut, hookFailed, notRun, detail, failed };
}

/**
 * Parses and validates a contract-results.json document. Rejects anything the
 * writer could not have produced: a wrong schema version; a missing, extra or
 * mistyped field; an `attempt` that is not an attempt directory's name; an
 * `image`, or a non-null `runImage`, that is not `<tag>@<id>`; groups other
 * than the manifest's four in its order; a boot that says both ok and stopped;
 * a score that is not `roundScore`'s; counts that do not add up; and a
 * diagnosis `diagnose` would not give. A failed test's `failureType` is any
 * non-empty string: the suite runner's types are not enumerated here.
 * `manifest` defaults to the repository's.
 */
export function parseContractResults(json: string, manifest: readonly ManifestEntry[] = loadManifest(REPO_ROOT)): ContractResults {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw new Error(`contract-results.json is not JSON: ${(error as Error).message}`);
  }
  try {
    const top = record(raw, "contract-results.json", TOP_KEYS);
    if (top.schemaVersion !== 1) fail("schemaVersion", `must be 1, got ${describe(top.schemaVersion)}`);

    const bootRaw = record(top.boot, "boot", BOOT_KEYS);
    const ok = boolean(bootRaw.ok, "boot.ok");
    let stage: BootStage | null = null;
    if (bootRaw.stage !== null) {
      if (!BOOT_STAGES.includes(bootRaw.stage as BootStage)) fail("boot.stage", `must be one of ${BOOT_STAGES.join(", ")} or null, got ${describe(bootRaw.stage)}`);
      stage = bootRaw.stage as BootStage;
    }
    const detail = nullableString(bootRaw.detail, "boot.detail");
    if (ok && (stage !== null || detail !== null)) fail("boot", "is ok, so its stage and detail must be null");
    if (!ok && (stage === null || detail === null)) fail("boot", "is a backend stop, so it needs a stage and a detail");

    if (!Array.isArray(top.groups)) fail("groups", `must be an array, got ${describe(top.groups)}`);
    if (top.groups.length !== manifest.length) fail("groups", `has ${top.groups.length} entries; the manifest has ${manifest.length}`);
    const groups = top.groups.map((g, i) => group(g, `groups[${i}]`, manifest[i], ok));

    let diagnosis: "reset-broken" | null = null;
    if (top.diagnosis !== null) {
      if (top.diagnosis !== "reset-broken") fail("diagnosis", `must be "reset-broken" or null, got ${describe(top.diagnosis)}`);
      diagnosis = "reset-broken";
    }
    if (diagnosis !== diagnose(groups)) fail("diagnosis", `is ${describe(diagnosis)} but the groups say ${describe(diagnose(groups))}`);

    const startedAt = string(top.startedAt, "startedAt");
    const date = new Date(startedAt);
    if (Number.isNaN(date.getTime()) || date.toISOString() !== startedAt) fail("startedAt", `must be an ISO timestamp as toISOString() writes it, got ${describe(startedAt)}`);

    return {
      schemaVersion: 1,
      attempt: string(top.attempt, "attempt", { pattern: ATTEMPT_DIR_RE }),
      image: string(top.image, "image", { pattern: /^\S+@\S+$/ }),
      runImage: top.runImage === null ? null : string(top.runImage, "runImage", { nonEmpty: true, pattern: /^\S+@\S+$/ }),
      rubric: string(top.rubric, "rubric", { pattern: /^maintenance-console@[0-9a-f]{12}$/ }),
      testsCommit: string(top.testsCommit, "testsCommit", { pattern: /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/ }),
      testsDirty: boolean(top.testsDirty, "testsDirty"),
      ungated: boolean(top.ungated, "ungated"),
      startedAt,
      durationMs: count(top.durationMs, "durationMs"),
      pipFreeze: strings(top.pipFreeze, "pipFreeze"),
      warnings: strings(top.warnings, "warnings"),
      boot: { ok, stage, detail },
      diagnosis,
      groups,
    };
  } catch (error) {
    if (error instanceof Invalid) throw new Error(`contract-results.json is invalid: ${error.message}`);
    throw error;
  }
}

export function readContractResults(path: string): ContractResults {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`no ${CONTRACT_RESULTS_FILE} at ${path}`);
    throw error;
  }
  try {
    return parseContractResults(text);
  } catch (error) {
    throw new Error(`${path}: ${(error as Error).message}`);
  }
}

/**
 * Validates `value`, then writes it with `writeFileAtomic`, so a reader never
 * sees half a file and an invalid result is never written at all. Keys come
 * out in the documented order.
 */
export function writeContractResults(path: string, value: ContractResults): void {
  const parsed = parseContractResults(`${JSON.stringify(value, null, 2)}\n`);
  writeFileAtomic(path, `${JSON.stringify(parsed, null, 2)}\n`);
}

// --- Notes and CSV lines -------------------------------------------------------

/** One line: each line trimmed, blank lines dropped, the rest joined with " / ". */
function oneLine(text: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" / ");
}

/** A detail for Notes: one line, and only its tail when long — a traceback's or pip's last line is the one that matters. */
function detailForNotes(text: string): string {
  const flat = oneLine(text);
  return flat.length <= NOTES_DETAIL_LIMIT ? flat : `…${flat.slice(-NOTES_DETAIL_LIMIT)}`;
}

/** `<METHOD> <path>` when more than half of the failures' messages start with it. */
function sharedEndpoint(failed: readonly FailedTest[]): string | null {
  const counts = new Map<string, number>();
  for (const f of failed) {
    const match = ENDPOINT_PREFIX.exec(f.message);
    if (match === null) continue;
    const key = `${match[1]} ${match[2]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [key, n] of counts) if (n * 2 > failed.length) return key;
  return null;
}

/**
 * A hidden-test row's Notes (spec §5), one line:
 *   `20/24 passed; failed: <names>` (names joined by " | "; `24/24 passed` when none failed),
 *   `0/24 passed; backend stop (<stage>): <detail>`,
 *   `0/24 passed; POST /reset does not answer 200` under `reset-broken`, which takes precedence,
 *   `0/11 passed; restart failed: <detail>`,
 *   the first form plus `; timed out after <n> tests` for a file cut short;
 * and to any of them `; most failures at <METHOD> <path>` when more than half
 * of the file's failures start with that endpoint.
 */
export function notesFor(group: GroupResult, results: ContractResults): string {
  let notes = `${group.passed}/${group.total} passed`;
  if (results.diagnosis === "reset-broken") {
    notes += "; POST /reset does not answer 200";
  } else if (!results.boot.ok) {
    notes += `; backend stop (${results.boot.stage}): ${detailForNotes(results.boot.detail ?? "")}`;
  } else if (group.detail !== null) {
    notes += `; restart failed: ${detailForNotes(group.detail)}`;
  } else {
    if (group.failed.length > 0) notes += `; failed: ${group.failed.map((f) => oneLine(f.name)).join(NAME_SEPARATOR)}`;
    if (group.timedOut && group.notRun > 0) {
      const ran = group.total - group.notRun;
      notes += `; timed out after ${ran} ${ran === 1 ? "test" : "tests"}`;
    }
  }
  const endpoint = sharedEndpoint(group.failed);
  if (endpoint !== null) notes += `; most failures at ${endpoint}`;
  return notes;
}

/** RFC 4180: quoted, with every `"` doubled. */
function quoted(text: string): string {
  return `"${text.replaceAll('"', '""')}"`;
}

function csvField(text: string): string {
  return /[",\r\n]/.test(text) || text !== text.trim() ? quoted(text) : text;
}

/**
 * The four hidden-test rows of eval-results.csv, in rubric order:
 * `<row>,<score>,<max>,"<notes>"`, the row names from `HIDDEN_ROWS`.
 */
export function hiddenRowLines(results: ContractResults): string[] {
  if (results.groups.length !== HIDDEN_ROWS.length) {
    throw new Error(`expected ${HIDDEN_ROWS.length} groups, got ${results.groups.length}`);
  }
  return HIDDEN_ROWS.map((row, i) => {
    const group = results.groups[i];
    if (group.row !== row.name || group.max !== row.max) {
      throw new Error(`groups[${i}] is ${JSON.stringify(group.row)} (max ${group.max}); rubric.ts expects ${JSON.stringify(row.name)} (max ${row.max})`);
    }
    return `${csvField(row.name)},${String(group.score)},${String(row.max)},${quoted(notesFor(group, results))}`;
  });
}
