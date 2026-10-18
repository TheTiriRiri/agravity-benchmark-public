/**
 * Pure helpers for scripts/score-hard.ts: no process is spawned and nothing is
 * written here, so every rule the CSV depends on is unit-tested.
 */
import { readFileSync } from "node:fs";

import { writeFileAtomic } from "./atomic-write";
import { HARD_RUBRIC_ROWS } from "./hard-rubric";

/** A fault of the harness, not the model's: the attempt is not scored. */
export class HarnessFault extends Error {
  override name = "HarnessFault";
}

export interface ManifestEntry { file: string; row: string; max: number; tests: number }

export function loadManifest(path: string): ManifestEntry[] {
  const raw = JSON.parse(readFileSync(path, "utf8")) as { files?: unknown };
  if (!Array.isArray(raw.files)) throw new Error(`${path}: no files array`);
  return raw.files.map((f, i) => {
    const e = f as Partial<ManifestEntry>;
    if (typeof e.file !== "string" || typeof e.row !== "string" || typeof e.max !== "number" || !Number.isInteger(e.tests) || (e.tests as number) < 1) {
      throw new Error(`${path}: files[${i}] is malformed`);
    }
    return { file: e.file, row: e.row, max: e.max, tests: e.tests as number };
  });
}

export interface ProcOutcome { status: number | null; signal: NodeJS.Signals | null; error?: Error; stdout: string; stderr: string }

/** A test runner that exits non-zero because tests failed is fine; one that was killed or never ran is not. */
export function requireCompleted(what: string, p: ProcOutcome): void {
  if (p.error !== undefined) throw new HarnessFault(`${what}: ${p.error.message}`);
  if (p.signal !== null) throw new HarnessFault(`${what}: killed by ${p.signal}`);
}

/** Playwright's own verdict: `expected` and `flaky` (failed, then passed on retry) both passed. */
export function parsePlaywrightJson(stdout: string, expectedTests: number): { passed: number; total: number } {
  let report: { stats?: Record<string, unknown> };
  try {
    report = JSON.parse(stdout) as { stats?: Record<string, unknown> };
  } catch {
    throw new HarnessFault("Playwright printed no JSON report");
  }
  const s = report.stats;
  const keys = ["expected", "unexpected", "flaky", "skipped"] as const;
  if (s === undefined || keys.some((k) => !Number.isInteger(s[k]))) throw new HarnessFault("Playwright's JSON report has no stats");
  const [expected, unexpected, flaky, skipped] = keys.map((k) => s[k] as number);
  const total = expected! + unexpected! + flaky! + skipped!;
  if (total !== expectedTests) throw new HarnessFault(`Playwright ran ${total} tests; the manifest declares ${expectedTests}`);
  return { passed: expected! + flaky!, total };
}

/** `node --test --test-reporter=tap`'s summary. */
export function parseNodeTap(output: string, expectedTests: number): { passed: number; total: number } {
  const num = (key: string): number | null => {
    const m = output.match(new RegExp(`^# ${key} (\\d+)$`, "m"));
    return m === null ? null : Number(m[1]);
  };
  const tests = num("tests");
  const pass = num("pass");
  if (tests === null || pass === null) throw new HarnessFault("node --test printed no TAP summary");
  if (tests !== expectedTests) throw new HarnessFault(`node --test ran ${tests} tests; the manifest declares ${expectedTests}`);
  return { passed: pass, total: tests };
}

/** A Notes cell: one line, double-quoted, inner quotes doubled. */
export function csvNote(text: string): string {
  return `"${text.replace(/\s*[\r\n]+\s*/g, " ").trim().replace(/"/g, '""')}"`;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** `D.MM.YYYY HH:MM`, local time, day not padded. */
export function formatTestRun(d: Date): string {
  return `${d.getDate()}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `Xmin Ys`: whole seconds rounded, minutes never converted to hours. */
export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}min ${total % 60}s`;
}

export type RowCell = { score: number; notes: string };

const CONTRACT_ROWS = HARD_RUBRIC_ROWS.filter((r) => r.scoredBy === "hidden" && !r.name.startsWith("Frontend E2E")).map((r) => r.name);
const E2E_ROWS = ["Frontend E2E: flows", "Frontend E2E: layout & a11y"];
export const BACKEND_STOP_ZERO: readonly string[] = ["Local build", ...CONTRACT_ROWS, ...E2E_ROWS, "Self-verification"];
export const FRONTEND_STOP_ZERO: readonly string[] = ["Local build", ...E2E_ROWS, "Visual design"];
const SCORED = HARD_RUBRIC_ROWS.filter((r) => r.max !== null || r.scoredBy === "penalty");

export function allZero(note: string): Map<string, RowCell> {
  return new Map(SCORED.map((r) => [r.name, { score: 0, notes: r.scoredBy === "penalty" ? "no deduction" : note }]));
}

export function applyStops(cells: Map<string, RowCell>, stops: { backend: string | null; frontend: string | null }): Map<string, RowCell> {
  if (stops.backend !== null && stops.frontend !== null) return allZero(`both stops: backend ${stops.backend}; frontend ${stops.frontend}`);
  const out = new Map(cells);
  const zero = (rows: readonly string[], why: string): void => { for (const r of rows) out.set(r, { score: 0, notes: why }); };
  if (stops.backend !== null) zero(BACKEND_STOP_ZERO, `backend ${stops.backend}`);
  if (stops.frontend !== null) zero(FRONTEND_STOP_ZERO, `frontend ${stops.frontend}`);
  return out;
}

export function renderCsv(cells: Map<string, RowCell>, duration: string, testRun: string): string {
  const lines = ["Criterion,Score,Max,Notes"];
  for (const row of HARD_RUBRIC_ROWS) {
    if (row.name === "Task completion time") { lines.push(`${row.name},${duration},N/A,${duration}`); continue; }
    if (row.name === "Test run") { lines.push(`${row.name},${testRun},N/A,${testRun}`); continue; }
    const cell = cells.get(row.name);
    if (cell === undefined) throw new Error(`renderCsv: no cell for ${row.name}`);
    lines.push(`${row.name},${cell.score},${row.max ?? "N/A"},${csvNote(cell.notes)}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Decide the E2E outcome from the serve-attempt that `score-hard` starts for
 * the build and the E2E, after the contract files ran on backends of their own.
 *
 * criteria.md Stop rules, row 5: "The backend booted for the hidden tests
 * but does not come up when served for the human and the judge"
 * → `Frontend E2E: flows` = 0 with the served backend's failure in Notes.
 *
 * @param contractBackendOk  true if the backend booted for the contract files (no backend stop)
 * @param servedBackendOk    true if serve-attempt's backend is "ok"
 * @param servedBackendStatus  serve-attempt's backend status string
 * @returns null when the backend came up fine; a failure reason string otherwise
 */
export function classifyReserveStop(
  contractBackendOk: boolean,
  servedBackendOk: boolean,
  servedBackendStatus: string,
): string | null {
  if (!contractBackendOk) return null; // not our case — handled by the regular stop path
  if (servedBackendOk) return null; // backend came up fine
  return `backend booted for hidden tests but not when served: ${servedBackendStatus}`;
}

export const HIDDEN_RESULTS_FILE = "hidden-results-hard.json";

export interface HardHiddenResults {
  schemaVersion: 1; attempt: string; rubric: string; scoredAt: string; backend: string; frontend: string;
  /**
   * What score-hard's log warned of while it scored the rows (a backend
   * container that exited during a contract file), as `contract-results.json`
   * records its own. score-hard always writes it, `[]` when there was none;
   * a file scored before it did has no such field, which means not recorded,
   * not none, and is read as it always was.
   */
  warnings?: string[];
  rows: { row: string; file: string; passed: number; total: number; max: number; score: number; failed?: string[] }[];
}

export function parseHardHiddenResults(text: string): HardHiddenResults {
  const r = JSON.parse(text) as HardHiddenResults;
  if (r.schemaVersion !== 1) throw new Error(`hidden results: schemaVersion must be 1, got ${JSON.stringify(r.schemaVersion)}`);
  for (const k of ["attempt", "rubric", "scoredAt", "backend", "frontend"] as const) {
    if (typeof r[k] !== "string") throw new Error(`hidden results: ${k} must be a string`);
  }
  if (r.warnings !== undefined) {
    if (!Array.isArray(r.warnings)) throw new Error("hidden results: warnings must be a string array if present");
    for (const w of r.warnings) {
      if (typeof w !== "string") throw new Error(`hidden results: warnings elements must be strings, got ${typeof w}`);
    }
  }
  if (!Array.isArray(r.rows)) throw new Error("hidden results: rows must be an array");
  for (const row of r.rows) {
    if (row.failed !== undefined) {
      if (!Array.isArray(row.failed)) throw new Error("hidden results: rows[].failed must be a string array if present");
      for (const f of row.failed) {
        if (typeof f !== "string") throw new Error(`hidden results: rows[].failed elements must be strings, got ${typeof f}`);
      }
    }
  }
  return r;
}

export function writeHardHiddenResults(path: string, r: HardHiddenResults): void {
  writeFileAtomic(path, JSON.stringify(r, null, 2) + "\n");
}

/**
 * Extract names of failed top-level tests from TAP output.
 * Matches `not ok N - <name>` at the top level (no leading whitespace),
 * consistent with how parseNodeTap counts tests.
 */
export function parseNodeTapFailedNames(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split("\n")) {
    const m = /^not ok \d+ - (.+)$/.exec(line);
    if (m) names.push(m[1]!.trim());
  }
  return names;
}

/**
 * Extract titles of failed specs from Playwright JSON report.
 * A spec is considered passed if it has status "expected" or "passed"
 * in at least one of its test results.
 */
export function parsePlaywrightJsonFailedNames(stdout: string): string[] {
  let report: { suites?: unknown[] };
  try {
    report = JSON.parse(stdout) as { suites?: unknown[] };
  } catch {
    return [];
  }
  const failed: string[] = [];
  function walkSpecs(suites: unknown[] | undefined): void {
    if (!Array.isArray(suites)) return;
    for (const suite of suites) {
      const s = suite as Record<string, unknown>;
      if (Array.isArray(s.specs)) {
        for (const spec of s.specs) {
          const sp = spec as Record<string, unknown>;
          const tests = Array.isArray(sp.tests) ? sp.tests : [];
          const anyPassed = tests.some((t) => {
            const results = Array.isArray((t as Record<string, unknown>).results)
              ? ((t as Record<string, unknown>).results as Record<string, unknown>[])
              : [];
            return results.some((r) => r.status === "passed" || r.status === "expected");
          });
          if (!anyPassed && typeof sp.title === "string") {
            failed.push(sp.title as string);
          }
        }
      }
      walkSpecs(s.suites as unknown[] | undefined);
    }
  }
  walkSpecs(report.suites);
  return failed;
}
