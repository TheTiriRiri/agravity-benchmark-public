/**
 * The hard track's manifest and result file. It exists because
 * scripts/lib/contract-results.ts is a RUBRIC_ID_INPUT: its `loadManifest`
 * reads one hardcoded path and rejects any manifest whose rows are not
 * HIDDEN_ROWS, and its `writeContractResults` validates against that same
 * default. Both are correct for the published track and neither may be edited,
 * so the hard track brings its own.
 *
 * What is NOT duplicated: `parseContractResults` takes a manifest argument and
 * `groupFromFileResult` is shape-agnostic, so both are imported unchanged.
 *
 * The file is an envelope, `{schemaVersion, track, oracle, contract, fuzz}`:
 * `contract` is a frozen-shape ContractResults, and `fuzz` carries what that
 * shape cannot — it rejects unknown top-level keys and has no field for a
 * per-stratum tally. Its `group.score` is pinned to `roundScore(passed, total,
 * max)`, raw passed/200; with twenty strata of ten cases that is arithmetically
 * the stratum mean too (Σ passed/10 over 20 strata is passed/200), so the two
 * scores agree today and part company only if a stratum is ever resized.
 *
 * `contract.rubric` is the PUBLISHED rubric id, because the frozen parser
 * accepts nothing else, and it is informational: never key on it. What era a
 * fuzz result belongs to is `oracle`, nothing else.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CASES_PER_STRATUM, STRATA } from "../../tracks/console-fuzz/benchmark/fuzz/strata";
import { writeFileAtomic } from "./atomic-write";
import {
  parseContractResults,
  type ContractResults,
  type GroupResult,
  type ManifestEntry,
} from "./contract-results";
import { scoreFuzz, stratumMeanScore, type FuzzScore } from "./fuzz-score";

export interface HardManifestEntry extends ManifestEntry {
  /** Ruling H6: the fuzz needs 300 s where the rest of a suite needs 120. */
  timeoutMs?: number;
}

export const HARD_LIMITS = { fileMs: 120_000, overallMs: 1_800_000 } as const;

/** Never `contract-results.json`: that name belongs to the published track. */
export const HARD_RESULTS_FILE = "contract-results-hard.json";

export const HARD_TRACK = "console-fuzz";

export function entryTimeout(entry: HardManifestEntry, remainingMs: number): number {
  return Math.max(1, Math.floor(Math.min(entry.timeoutMs ?? HARD_LIMITS.fileMs, remainingMs)));
}

// --- manifest ----------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `<trackRoot>/benchmark/fuzz/manifest.json`: every entry a test file's base
 * name, a row, a positive `max`, a positive integer `tests` and, when present,
 * a positive integer `timeoutMs`. Unlike the frozen loader it does not compare
 * the rows with HIDDEN_ROWS: the hard track's rows are its own.
 */
export function loadHardManifest(trackRoot: string): HardManifestEntry[] {
  const path = join(trackRoot, "benchmark", "fuzz", "manifest.json");
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const files = isRecord(raw) ? raw.files : undefined;
  if (!Array.isArray(files) || files.length === 0) throw new Error(`${path}: expected {"files": [...]} with at least one entry`);
  const entries = files.map((entry: unknown, i): HardManifestEntry => {
    const where = `${path}: files[${i}]`;
    if (!isRecord(entry)) throw new Error(`${where} is not an object`);
    const { file, row, max, tests, timeoutMs } = entry;
    if (typeof file !== "string" || !/^[a-z0-9-]+\.test\.ts$/.test(file)) throw new Error(`${where}.file must be a test file's base name, got ${JSON.stringify(file)}`);
    if (typeof row !== "string" || row.trim() === "") throw new Error(`${where}.row must be a non-empty string`);
    if (typeof max !== "number" || !Number.isFinite(max) || max < 0) throw new Error(`${where}.max must be a non-negative number`);
    if (typeof tests !== "number" || !Number.isInteger(tests) || tests < 1) throw new Error(`${where}.tests must be a positive integer`);
    if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1)) {
      throw new Error(`${where}.timeoutMs must be a positive integer when present`);
    }
    return timeoutMs === undefined ? { file, row, max, tests } : { file, row, max, tests, timeoutMs };
  });
  if (new Set(entries.map((e) => e.file)).size !== entries.length) throw new Error(`${path}: a file is listed twice`);
  return entries;
}

// --- the envelope --------------------------------------------------------------

export interface HardResult {
  schemaVersion: 1;
  track: string;
  /** The first 12 hex digits of gate P2-B's fingerprint over the files that ran: this track's era. */
  oracle: string;
  contract: ContractResults;
  fuzz: FuzzScore;
}

/** The lone fuzz group: this track scores one file, and the envelope's `fuzz` is that file's stratum mean. */
function fuzzGroup(contract: ContractResults): GroupResult {
  if (contract.groups.length !== 1) throw new Error(`the hard track scores one file, the result has ${contract.groups.length}`);
  return contract.groups[0];
}

function oneLine(text: string, max = 400): string {
  const flat = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" / ");
  return flat.length <= max ? flat : `…${flat.slice(-max)}`;
}

/**
 * Both halves from the one `ContractResults`, so they cannot come from two
 * runs. A backend stop or a failed restart is not a timeout: the group has
 * `notRun` at the manifest's count either way, and the note is what tells a
 * reader in the spread table which it was.
 */
export function buildHardResult(contract: ContractResults, oracle: string): HardResult {
  const group = fuzzGroup(contract);
  const scored = scoreFuzz(
    { file: group.file, total: group.total, passed: group.passed, failed: group.failed, notRun: group.notRun, hookFailed: group.hookFailed, timedOut: group.timedOut },
    group.max,
  );
  let note = scored.note;
  if (!contract.boot.ok) note = `backend stop (${contract.boot.stage}): ${oneLine(contract.boot.detail ?? "")}`;
  else if (group.detail !== null) note = `restart failed: ${oneLine(group.detail)}`;
  return { schemaVersion: 1, track: HARD_TRACK, oracle, contract, fuzz: { ...scored, note } };
}

// --- validation ----------------------------------------------------------------

const TOP_KEYS = ["schemaVersion", "track", "oracle", "contract", "fuzz"] as const;
const FUZZ_KEYS = ["score", "passed", "total", "perStratum", "note"] as const;
const STRATUM_KEYS = ["id", "passed", "total", "firstFailure"] as const;

class Invalid extends Error {}

function fail(path: string, problem: string): never {
  throw new Invalid(`${path} ${problem}`);
}

function record(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) fail(path, "must be an object");
  for (const key of keys) if (!Object.hasOwn(value, key)) fail(path, `is missing "${key}"`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(path, `has an unexpected field "${key}"`);
  return value;
}

function integer(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) fail(path, `must be a non-negative integer, got ${JSON.stringify(value)}`);
  return value;
}

/**
 * Parses and validates a contract-results-hard.json document: the envelope's
 * keys; `contract` through the frozen `parseContractResults`, with the hard
 * manifest; and `fuzz` against `contract`. Four equalities hold between the two
 * halves, because nothing else keeps them in step once the file is on disk:
 *
 *   fuzz.passed === contract.groups[0].passed
 *   fuzz.total  === contract.groups[0].total
 *   fuzz.perStratum is STRATA, in order, each out of CASES_PER_STRATUM
 *   sum(fuzz.perStratum[].passed) === fuzz.passed
 *
 * and `fuzz.score` is the stratum mean of that tally.
 */
export function parseHardResult(json: string, manifest: readonly HardManifestEntry[]): HardResult {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw new Error(`${HARD_RESULTS_FILE} is not JSON: ${(error as Error).message}`);
  }
  try {
    const top = record(raw, HARD_RESULTS_FILE, TOP_KEYS);
    if (top.schemaVersion !== 1) fail("schemaVersion", `must be 1, got ${JSON.stringify(top.schemaVersion)}`);
    if (typeof top.track !== "string" || !/^[a-z0-9-]+$/.test(top.track)) fail("track", `must be a kebab-case name, got ${JSON.stringify(top.track)}`);
    if (typeof top.oracle !== "string" || !/^[0-9a-f]{12}$/.test(top.oracle)) fail("oracle", `must be 12 hex digits, got ${JSON.stringify(top.oracle)}`);
    const contract = parseContractResults(JSON.stringify(top.contract), manifest);
    const group = fuzzGroup(contract);

    const f = record(top.fuzz, "fuzz", FUZZ_KEYS);
    const passed = integer(f.passed, "fuzz.passed");
    const total = integer(f.total, "fuzz.total");
    if (typeof f.note !== "string" || f.note.trim() === "") fail("fuzz.note", "must be a non-empty string");
    if (typeof f.score !== "number") fail("fuzz.score", `must be a number, got ${JSON.stringify(f.score)}`);
    if (!Array.isArray(f.perStratum)) fail("fuzz.perStratum", "must be an array");
    if (f.perStratum.length !== STRATA.length) fail("fuzz.perStratum", `has ${f.perStratum.length} entries; there are ${STRATA.length} strata`);
    const perStratum = f.perStratum.map((entry, i) => {
      const s = record(entry, `fuzz.perStratum[${i}]`, STRATUM_KEYS);
      if (s.id !== STRATA[i].id) fail(`fuzz.perStratum[${i}].id`, `must be ${STRATA[i].id}, got ${JSON.stringify(s.id)}`);
      const stratumPassed = integer(s.passed, `fuzz.perStratum[${i}].passed`);
      if (integer(s.total, `fuzz.perStratum[${i}].total`) !== CASES_PER_STRATUM) fail(`fuzz.perStratum[${i}].total`, `must be ${CASES_PER_STRATUM}`);
      if (stratumPassed > CASES_PER_STRATUM) fail(`fuzz.perStratum[${i}].passed`, `is ${stratumPassed}, more than ${CASES_PER_STRATUM}`);
      if (s.firstFailure !== null && typeof s.firstFailure !== "string") fail(`fuzz.perStratum[${i}].firstFailure`, "must be a string or null");
      return { id: STRATA[i].id, passed: stratumPassed, total: CASES_PER_STRATUM, firstFailure: s.firstFailure as string | null };
    });

    if (passed !== group.passed) fail("fuzz.passed", `is ${passed} but contract.groups[0].passed is ${group.passed}`);
    if (total !== group.total) fail("fuzz.total", `is ${total} but contract.groups[0].total is ${group.total}`);
    const summed = perStratum.reduce((sum, s) => sum + s.passed, 0);
    if (summed !== passed) fail("fuzz.perStratum", `adds up to ${summed} passed but fuzz.passed is ${passed}`);
    const score = stratumMeanScore(perStratum, group.max);
    if (f.score !== score) fail("fuzz.score", `is ${f.score} but the stratum mean of fuzz.perStratum is ${score}`);

    return { schemaVersion: 1, track: top.track, oracle: top.oracle, contract, fuzz: { score, passed, total, perStratum, note: f.note } };
  } catch (error) {
    if (error instanceof Invalid) throw new Error(`${HARD_RESULTS_FILE} is invalid: ${error.message}`);
    throw error;
  }
}

export function readHardContractResults(path: string, manifest: readonly HardManifestEntry[]): HardResult {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`no ${HARD_RESULTS_FILE} at ${path}`);
    throw error;
  }
  try {
    return parseHardResult(text, manifest);
  } catch (error) {
    throw new Error(`${path}: ${(error as Error).message}`);
  }
}

/**
 * Validates `value`, then writes it with `writeFileAtomic`, so a reader never
 * sees half a file and an invalid result is never written at all.
 */
export function writeHardContractResults(path: string, value: HardResult, manifest: readonly HardManifestEntry[]): void {
  const parsed = parseHardResult(`${JSON.stringify(value, null, 2)}\n`, manifest);
  writeFileAtomic(path, `${JSON.stringify(parsed, null, 2)}\n`);
}
