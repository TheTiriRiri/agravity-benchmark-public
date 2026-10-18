/**
 * The brownfield track's manifest and result file.
 * Defined in spec §7.3 and docs/superpowers/plans/2026-10-02-p3-brownfield.md.
 *
 * scripts/lib/contract-results.ts is a classic RUBRIC_ID_INPUT with hardcoded
 * classic rubric regex; the brownfield track brings its own result module
 * following the hard track pattern (scripts/lib/hard-contract-results.ts).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { writeFileAtomic } from "./atomic-write";
import { ATTEMPT_DIR_RE } from "./attempts";
import {
  type BootStage,
  type GroupResult,
  type ManifestEntry,
} from "./contract-results";
import { BROWNFIELD_RUBRIC_ROWS, getRequiredRowMax } from "./brownfield-rubric";
import type { DiffLocalityResult } from "./diff-locality";
import { roundScore } from "./rubric";

export const BROWNFIELD_RESULTS_FILE = "contract-results-brownfield.json";
export const BROWNFIELD_TRACK = "brownfield";

export interface BrownfieldManifestEntry extends ManifestEntry {
  timeoutMs?: number;
}

export interface BrownfieldSuiteResult {
  passed: number;
  total: number;
  score: number;
  groups: GroupResult[];
}

export interface PytestResult {
  ran: boolean;
  timedOut: boolean;
  exitCode: number | null;
  passed: number;
  failed: number;
  errors: number;
  durationMs: number;
  outputTail: string;
  notRunReason: string | null;
}

export interface BrownfieldResult {
  schemaVersion: 1;
  track: "brownfield";
  rubric: string;
  attempt: string;
  image: string;
  runImage: string | null;
  testsCommit: string;
  testsDirty: boolean;
  ungated: boolean;
  startedAt: string;
  durationMs: number;
  pipFreeze: string[];
  warnings: string[];
  boot: { ok: boolean; stage: BootStage | null; detail: string | null };
  diagnosis: "reset-broken" | null;
  regression: BrownfieldSuiteResult;
  changeSuite: BrownfieldSuiteResult;
  diffLocality: DiffLocalityResult;
  pytest: PytestResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveManifestPath(target: string): string {
  if (target.endsWith(".json")) return target;
  const candidates = [
    join(target, "tracks", "brownfield", "benchmark", "contract-tests", "manifest.json"),
    join(target, "manifest.json"),
    join(fileURLToPath(new URL("../..", import.meta.url)), "tracks", "brownfield", "benchmark", "contract-tests", "manifest.json"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return join(target, "manifest.json");
}

export function loadBrownfieldManifest(target: string): BrownfieldManifestEntry[] {
  const path = resolveManifestPath(target);
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const files = isRecord(raw) ? raw.files : undefined;
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error(`${path}: expected {"files": [...]} with at least one entry`);
  }

  const entries = files.map((entry: unknown, i): BrownfieldManifestEntry => {
    const where = `${path}: files[${i}]`;
    if (!isRecord(entry)) throw new Error(`${where} is not an object`);
    const { file, row, max, tests, timeoutMs } = entry;
    if (typeof file !== "string" || !/^[a-z0-9-]+\.test\.ts$/.test(file)) {
      throw new Error(`${where}.file must be a test file's base name, got ${JSON.stringify(file)}`);
    }
    if (typeof row !== "string" || row.trim() === "") {
      throw new Error(`${where}.row must be a non-empty string`);
    }
    if (typeof max !== "number" || !Number.isFinite(max) || max < 0) {
      throw new Error(`${where}.max must be a non-negative number`);
    }
    if (typeof tests !== "number" || !Number.isInteger(tests) || tests < 1) {
      throw new Error(`${where}.tests must be a positive integer`);
    }
    if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1)) {
      throw new Error(`${where}.timeoutMs must be a positive integer when present`);
    }
    return timeoutMs === undefined ? { file, row, max, tests } : { file, row, max, tests, timeoutMs };
  });

  if (new Set(entries.map((e) => e.file)).size !== entries.length) {
    throw new Error(`${path}: a file is listed twice`);
  }
  return entries;
}

export function buildBrownfieldResult(params: {
  attempt: string;
  image: string;
  runImage: string | null;
  rubric: string;
  testsCommit: string;
  testsDirty: boolean;
  ungated: boolean;
  startedAt: string;
  durationMs: number;
  pipFreeze: string[];
  warnings: string[];
  boot: { ok: boolean; stage: BootStage | null; detail: string | null };
  diagnosis: "reset-broken" | null;
  regressionGroups: GroupResult[];
  changeGroups: GroupResult[];
  diffLocality: DiffLocalityResult;
  pytest: PytestResult;
}): BrownfieldResult {
  const regMax = getRequiredRowMax(BROWNFIELD_RUBRIC_ROWS, "Regression");
  const changeMax = getRequiredRowMax(BROWNFIELD_RUBRIC_ROWS, "Change suite");

  const regPassed = params.regressionGroups.reduce((sum, g) => sum + g.passed, 0);
  const regTotal = params.regressionGroups.reduce((sum, g) => sum + g.total, 0);
  const regScore = regTotal > 0 ? roundScore(regPassed, regTotal, regMax) : 0;

  const changePassed = params.changeGroups.reduce((sum, g) => sum + g.passed, 0);
  const changeTotal = params.changeGroups.reduce((sum, g) => sum + g.total, 0);
  const changeScore = Math.min(changeMax, Math.round(params.changeGroups.reduce((sum, g) => sum + g.score, 0) * 100) / 100);

  const diffLocality: DiffLocalityResult = params.boot.ok
    ? params.diffLocality
    : { ...params.diffLocality, score: 0 };

  return {
    schemaVersion: 1,
    track: "brownfield",
    rubric: params.rubric,
    attempt: params.attempt,
    image: params.image,
    runImage: params.runImage,
    testsCommit: params.testsCommit,
    testsDirty: params.testsDirty,
    ungated: params.ungated,
    startedAt: params.startedAt,
    durationMs: Math.max(0, Math.round(params.durationMs)),
    pipFreeze: [...params.pipFreeze],
    warnings: [...params.warnings],
    boot: params.boot,
    diagnosis: params.diagnosis,
    regression: {
      passed: regPassed,
      total: regTotal,
      score: regScore,
      groups: params.regressionGroups,
    },
    changeSuite: {
      passed: changePassed,
      total: changeTotal,
      score: changeScore,
      groups: params.changeGroups,
    },
    diffLocality,
    pytest: params.pytest,
  };
}

const RUBRIC_PATTERN = /^maintenance-console-brownfield@[0-9a-f]{12}$/;

export function validateBrownfieldResult(result: unknown): asserts result is BrownfieldResult {
  if (!isRecord(result)) throw new Error("BrownfieldResult must be an object");
  if (result.schemaVersion !== 1) throw new Error(`schemaVersion must be 1, got ${result.schemaVersion}`);
  if (result.track !== "brownfield") throw new Error(`track must be "brownfield", got ${result.track}`);
  if (typeof result.rubric !== "string" || !RUBRIC_PATTERN.test(result.rubric)) {
    throw new Error(`rubric must match ${RUBRIC_PATTERN}, got ${JSON.stringify(result.rubric)}`);
  }
  if (typeof result.attempt !== "string" || !ATTEMPT_DIR_RE.test(result.attempt)) {
    throw new Error(`attempt must match ${ATTEMPT_DIR_RE}, got ${JSON.stringify(result.attempt)}`);
  }
  if (!isRecord(result.regression)) throw new Error("missing regression suite result");
  if (!isRecord(result.changeSuite)) throw new Error("missing change suite result");
  if (!isRecord(result.diffLocality)) throw new Error("missing diff locality result");

  if (typeof result.diffLocality.score !== "number" || result.diffLocality.score < 0 || result.diffLocality.score > 1) {
    throw new Error(`diffLocality.score must be between 0 and 1, got ${result.diffLocality.score}`);
  }
  if (!Array.isArray(result.diffLocality.outsideFiles)) {
    throw new Error("diffLocality.outsideFiles must be an array");
  }
  if (typeof result.diffLocality.totalLines !== "number" || result.diffLocality.totalLines < 0) {
    throw new Error("diffLocality.totalLines must be a non-negative number");
  }

  if (!isRecord(result.pytest)) throw new Error("missing pytest result");
  if (typeof result.pytest.ran !== "boolean") throw new Error("pytest.ran must be a boolean");
  if (typeof result.pytest.timedOut !== "boolean") throw new Error("pytest.timedOut must be a boolean");
  const exitCode = result.pytest.exitCode;
  if (exitCode !== null && (typeof exitCode !== "number" || !Number.isInteger(exitCode) || exitCode < 0)) {
    throw new Error(`pytest.exitCode must be null or a non-negative integer, got ${exitCode}`);
  }
  if (typeof result.pytest.passed !== "number" || !Number.isInteger(result.pytest.passed) || result.pytest.passed < 0) {
    throw new Error("pytest.passed must be a non-negative integer");
  }
  if (typeof result.pytest.failed !== "number" || !Number.isInteger(result.pytest.failed) || result.pytest.failed < 0) {
    throw new Error("pytest.failed must be a non-negative integer");
  }
  if (typeof result.pytest.errors !== "number" || !Number.isInteger(result.pytest.errors) || result.pytest.errors < 0) {
    throw new Error("pytest.errors must be a non-negative integer");
  }
  if (typeof result.pytest.durationMs !== "number" || !Number.isInteger(result.pytest.durationMs) || result.pytest.durationMs < 0) {
    throw new Error("pytest.durationMs must be a non-negative integer");
  }
  if (typeof result.pytest.outputTail !== "string") {
    throw new Error("pytest.outputTail must be a string");
  }
  if (result.pytest.notRunReason !== null && typeof result.pytest.notRunReason !== "string") {
    throw new Error("pytest.notRunReason must be null or a string");
  }
}

export function parseBrownfieldResult(json: string): BrownfieldResult {
  const parsed: unknown = JSON.parse(json);
  validateBrownfieldResult(parsed);
  return parsed;
}

export function writeBrownfieldContractResults(path: string, result: BrownfieldResult): void {
  validateBrownfieldResult(result);
  writeFileAtomic(path, JSON.stringify(result, null, 2) + "\n");
}

export function readBrownfieldContractResults(path: string): BrownfieldResult {
  return parseBrownfieldResult(readFileSync(path, "utf8"));
}

export function brownfieldSummaryLines(result: BrownfieldResult): string[] {
  const regMax = getRequiredRowMax(BROWNFIELD_RUBRIC_ROWS, "Regression");
  const changeMax = getRequiredRowMax(BROWNFIELD_RUBRIC_ROWS, "Change suite");
  const diffMax = getRequiredRowMax(BROWNFIELD_RUBRIC_ROWS, "Diff locality");
  const lines: string[] = [];
  lines.push(`  Regression: ${result.regression.passed}/${result.regression.total} passed, score ${result.regression.score}/${regMax}`);
  lines.push(`  Change suite: ${result.changeSuite.passed}/${result.changeSuite.total} passed, score ${result.changeSuite.score}/${changeMax}`);
  lines.push(
    `  Diff locality: score ${result.diffLocality.score}/${diffMax} (${result.diffLocality.outsideFiles.length} outside files, ${result.diffLocality.totalLines} lines changed)`,
  );
  return lines;
}

const NOTES_DETAIL_LIMIT = 400;

function oneLine(text: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" / ");
}

function detailForNotes(text: string): string {
  const flat = oneLine(text);
  return flat.length <= NOTES_DETAIL_LIMIT ? flat : `…${flat.slice(-NOTES_DETAIL_LIMIT)}`;
}

function quoted(text: string): string {
  return `"${text.replaceAll('"', '""')}"`;
}

/**
 * The three tool-provided rows of brownfield eval-results.csv, in rubric order:
 * Regression, Change suite, Diff locality.
 * Each is `<row>,<score>,<max>,"<notes>"`.
 */
export function brownfieldHiddenRowLines(result: BrownfieldResult): string[] {
  const regMax = getRequiredRowMax(BROWNFIELD_RUBRIC_ROWS, "Regression");
  const changeMax = getRequiredRowMax(BROWNFIELD_RUBRIC_ROWS, "Change suite");
  const diffMax = getRequiredRowMax(BROWNFIELD_RUBRIC_ROWS, "Diff locality");

  // 1. Regression
  let regNotes = `${result.regression.passed}/${result.regression.total} passed`;
  if (result.diagnosis === "reset-broken") {
    regNotes += "; POST /reset does not answer 200";
  } else if (!result.boot.ok) {
    regNotes += `; backend stop (${result.boot.stage}): ${detailForNotes(result.boot.detail ?? "")}`;
  } else {
    const failed = (result.regression.groups ?? []).flatMap((g) => g.failed ?? []);
    if (failed.length > 0) {
      regNotes += `; failed: ${failed.map((f) => oneLine(f.name)).join(" | ")}`;
    }
  }
  const regScore = result.boot.ok ? result.regression.score : 0;
  const regLine = `Regression,${regScore},${regMax},${quoted(regNotes)}`;

  // 2. Change suite
  let changeNotes = `${result.changeSuite.passed}/${result.changeSuite.total} passed`;
  if (!result.boot.ok) {
    changeNotes += `; backend stop (${result.boot.stage}): ${detailForNotes(result.boot.detail ?? "")}`;
  } else {
    const failed = (result.changeSuite.groups ?? []).flatMap((g) => g.failed ?? []);
    if (failed.length > 0) {
      changeNotes += `; failed: ${failed.map((f) => oneLine(f.name)).join(" | ")}`;
    }
  }
  const changeScore = result.boot.ok ? result.changeSuite.score : 0;
  const changeLine = `Change suite,${changeScore},${changeMax},${quoted(changeNotes)}`;

  // 3. Diff locality
  const outsideCount = result.diffLocality.outsideFiles.length;
  const linesCount = result.diffLocality.totalLines;
  const outsideDesc = outsideCount === 1 ? "1 outside file" : `${outsideCount} outside files`;
  const linesDesc = `${linesCount} lines changed`;
  let diffNotes = `${outsideDesc}, ${linesDesc}`;
  if (outsideCount > 0) {
    diffNotes += ` (${result.diffLocality.outsideFiles.join(", ")})`;
  }
  if (!result.boot.ok) {
    diffNotes = `backend stop (${result.boot.stage}): ${diffNotes}`;
  }
  const diffScore = result.boot.ok ? result.diffLocality.score : 0;
  const diffLine = `Diff locality,${diffScore},${diffMax},${quoted(detailForNotes(diffNotes))}`;

  return [regLine, changeLine, diffLine];
}

