/**
 * Hard-track guards for process-results: hidden rows agree, model-failure zeros,
 * and the era check via hidden-results-hard.json.
 *
 * Each test builds a minimal hard-track fixture tree under mkdtempSync, calls
 * processResults with HARD_RUBRIC_ROWS, and asserts on the thrown error or the
 * skipped warning.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { processResults, type CriterionResult } from "../scripts/process-results";
import { HARD_RUBRIC_ROWS, hardRubricId } from "../scripts/lib/hard-rubric";
import { HIDDEN_RESULTS_FILE, type HardHiddenResults } from "../scripts/lib/hard-score";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
function tempDir(prefix = "agrav-hard-pr-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
after(() => { for (const d of tempDirs) rmSync(d, { recursive: true, force: true }); });

const HARD_RUBRIC = hardRubricId(".");

/**
 * Build a minimal hard-track CSV with all rows. Scores default to 0 except
 * for overrides passed as a map { "Code structure": 1 }.
 */
function hardCsv(overrides: Record<string, number> = {}): string {
  const lines = ["Criterion,Score,Max,Notes"];
  for (const row of HARD_RUBRIC_ROWS) {
    const score = overrides[row.name] ?? 0;
    const max = row.max ?? "N/A";
    if (row.name === "Task completion time") {
      lines.push(`Task completion time,1min 0s,N/A,1min 0s`);
    } else if (row.name === "Test run") {
      lines.push(`Test run,8.10.2026 09:05,N/A,8.10.2026 09:05`);
    } else {
      lines.push(`${row.name},${score},${max},"score ${score}"`);
    }
  }
  return lines.join("\n") + "\n";
}

/** A run.json for a normal (non-failure) hard attempt. */
function normalRunJson(dirName: string): unknown {
  const id = dirName.replace(/-attempt-\d+$/, "");
  return {
    id,
    model: "gemini-3.8-flash-high",
    effort: "high",
    agyVersion: "1.2.7",
    image: "agrav-bench/harness:2026-10-04@sha256:c17480130daaf9571b25568faa348dbaea58e9bfc094061d7d693044d4579442",
    startedAt: "2026-10-08T07:00:00.000Z",
    durationMs: 60_000,
    exitCode: 0,
    envelope: {
      status: "SUCCESS",
      num_turns: 1,
      duration_seconds: 60.0,
      usage: { input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, thinking_tokens: 0, total_tokens: 1500 },
      conversation_id: "test-conv-id",
      error: "",
      responseTail: null,
    },
    stderrTail: "",
    softDenied: false,
    failureKind: null,
  };
}

/** A run.json for a model failure. */
function modelFailureRunJson(dirName: string): unknown {
  return {
    ...(normalRunJson(dirName) as Record<string, unknown>),
    exitCode: 1,
    failureKind: "model",
    envelope: {
      status: "ERROR",
      num_turns: 1,
      duration_seconds: 60.0,
      usage: { input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, thinking_tokens: 0, total_tokens: 1500 },
      conversation_id: "test-conv-id",
      error: "exceeded the output token limit",
      responseTail: null,
    },
  };
}

/** A hidden-results-hard.json that agrees with the CSV scores. */
function hardHiddenResults(attempt: string, rubric: string, rows?: HardHiddenResults["rows"]): HardHiddenResults {
  const defaultRows = HARD_RUBRIC_ROWS
    .filter((r) => r.scoredBy === "hidden")
    .map((r) => ({ row: r.name, file: "test.ts", passed: 0, total: 10, max: r.max!, score: 0 }));
  return {
    schemaVersion: 1,
    attempt,
    rubric,
    scoredAt: "2026-10-08T07:00:00.000Z",
    backend: "ok",
    frontend: "ok",
    rows: rows ?? defaultRows,
  };
}

/**
 * Build a results directory with one hard attempt: CSV, run.json, and
 * optionally hidden-results-hard.json.
 */
function hardResultsDir(
  dirName: string,
  csv: string,
  runJson?: unknown,
  hidden?: HardHiddenResults | null,
): string {
  const dir = tempDir();
  const attemptDir = join(dir, dirName);
  mkdirSync(attemptDir, { recursive: true });
  writeFileSync(join(attemptDir, "eval-results.csv"), csv, "utf8");
  if (runJson !== undefined) {
    writeFileSync(join(attemptDir, "run.json"), `${JSON.stringify(runJson, null, 2)}\n`, "utf8");
  }
  if (hidden !== undefined && hidden !== null) {
    writeFileSync(join(attemptDir, HIDDEN_RESULTS_FILE), `${JSON.stringify(hidden, null, 2)}\n`, "utf8");
  }
  return dir;
}

/** Run processResults for the hard track. */
function runHard(resultsDir: string): { warnings: string[] } {
  const out = tempDir();
  const warnings: string[] = [];
  processResults({
    resultsDir,
    resultsJsonPath: join(out, "results-hard.json"),
    leaderboardJsonPath: join(out, "leaderboard-hard.json"),
    rubric: HARD_RUBRIC,
    rubricRows: HARD_RUBRIC_ROWS,
    warn: (msg) => warnings.push(msg),
  });
  return { warnings };
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("process-results --track hard guards", () => {
  const ATTEMPT = "gemini-38-flash-high-attempt-9";

  it("a hard attempt with no hidden-results-hard.json stops the run", () => {
    const dir = hardResultsDir(ATTEMPT, hardCsv(), normalRunJson(ATTEMPT), null);
    assert.throws(
      () => runHard(dir),
      /no hidden-results-hard\.json/,
    );
  });

  it("a hidden row that disagrees with the CSV stops the run, naming both scores", () => {
    // CSV has API contract = 0, but hidden file says 1.72
    const hidden = hardHiddenResults(ATTEMPT, HARD_RUBRIC);
    hidden.rows[0] = { row: "API contract", file: "api-contract.test.ts", passed: 25, total: 29, max: 2, score: 1.72 };
    const dir = hardResultsDir(ATTEMPT, hardCsv(), normalRunJson(ATTEMPT), hidden);
    assert.throws(
      () => runHard(dir),
      /is 0 in eval-results\.csv but 1\.72/,
    );
  });

  it("a model failure with Code structure = 1 stops the run", () => {
    const csv = hardCsv({ "Code structure": 1 });
    const dir = hardResultsDir(ATTEMPT, csv, modelFailureRunJson(ATTEMPT), null);
    assert.throws(
      () => runHard(dir),
      /model failure.*"Code structure" is 1/,
    );
  });

  it("hidden results with warnings, empty or not, publish exactly as a file without the field does", () => {
    const published = (hidden: HardHiddenResults): unknown => {
      const dir = hardResultsDir(ATTEMPT, hardCsv(), normalRunJson(ATTEMPT), hidden);
      const out = tempDir();
      processResults({
        resultsDir: dir,
        resultsJsonPath: join(out, "results-hard.json"),
        leaderboardJsonPath: join(out, "leaderboard-hard.json"),
        rubric: HARD_RUBRIC,
        rubricRows: HARD_RUBRIC_ROWS,
        warn: () => {},
      });
      const { generatedAt: _generatedAt, ...rest } = JSON.parse(readFileSync(join(out, "results-hard.json"), "utf8")) as Record<string, unknown>;
      return rest;
    };
    const withoutField = published(hardHiddenResults(ATTEMPT, HARD_RUBRIC));
    assert.deepEqual(published({ ...hardHiddenResults(ATTEMPT, HARD_RUBRIC), warnings: [] }), withoutField);
    const exited = "the backend container exited with code 1 during planner-assignment.test.ts, so the tests after that ran against no backend (the backend crashed, or the host killed it)";
    assert.deepEqual(published({ ...hardHiddenResults(ATTEMPT, HARD_RUBRIC), warnings: [exited] }), withoutField);
  });

  it("a model failure with all zeros publishes without hidden-results-hard.json", () => {
    const csv = hardCsv();  // all zeros
    const dir = hardResultsDir(ATTEMPT, csv, modelFailureRunJson(ATTEMPT), null);
    // Should not throw — model failure with all zeros is fine (no hidden file needed)
    assert.doesNotThrow(() => runHard(dir));
  });

  it("a file with a different rubric id skips the attempt with a warning (era check)", () => {
    const otherRubric = "maintenance-console-hard@000000000000";
    const hidden = hardHiddenResults(ATTEMPT, otherRubric);
    const dir = hardResultsDir(ATTEMPT, hardCsv(), normalRunJson(ATTEMPT), hidden);
    const { warnings } = runHard(dir);
    assert.ok(
      warnings.some((w) => w.includes("scored under rubric") && w.includes(otherRubric)),
      `expected era-check warning in: ${warnings.join("; ")}`,
    );
  });

  it("a hidden-results file missing a hidden row stops the run", () => {
    const hidden = hardHiddenResults(ATTEMPT, HARD_RUBRIC);
    // Remove the last hidden row (e.g. "Frontend E2E: layout & a11y")
    hidden.rows = hidden.rows.slice(0, -1);
    const dir = hardResultsDir(ATTEMPT, hardCsv(), normalRunJson(ATTEMPT), hidden);
    assert.throws(
      () => runHard(dir),
      /missing/i,
    );
  });

  it("a hidden-results file with a duplicate row stops the run", () => {
    const hidden = hardHiddenResults(ATTEMPT, HARD_RUBRIC);
    // Duplicate the first row
    hidden.rows = [...hidden.rows, { ...hidden.rows[0] }];
    const dir = hardResultsDir(ATTEMPT, hardCsv(), normalRunJson(ATTEMPT), hidden);
    assert.throws(
      () => runHard(dir),
      /duplicate|twice/i,
    );
  });

  it("a valid hard attempt with matching hidden results passes", () => {
    const hidden = hardHiddenResults(ATTEMPT, HARD_RUBRIC);
    const dir = hardResultsDir(ATTEMPT, hardCsv(), normalRunJson(ATTEMPT), hidden);
    // Should not throw
    assert.doesNotThrow(() => runHard(dir));
  });
});
