import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { processResults } from "../scripts/process-results";
import { BROWNFIELD_RUBRIC_ROWS, brownfieldRubricId } from "../scripts/lib/brownfield-rubric";
import { BROWNFIELD_RESULTS_FILE } from "../scripts/lib/brownfield-contract-results";
import type { RunJson } from "../scripts/lib/run-json";

function sampleRunJson(overrides: Partial<RunJson> = {}): RunJson {
  return {
    id: "gemini-38-flash-low",
    model: "gemini-3.8-flash",
    effort: "low",
    agyVersion: "1.1.26",
    image: "agrav:test@sha256:1111",
    startedAt: "2026-10-04T12:00:00.000Z",
    durationMs: 1000,
    exitCode: 0,
    envelope: null,
    stderrTail: "",
    softDenied: false,
    failureKind: null,
    ...overrides,
  };
}

describe("process-results brownfield error messages (Task 7b.6)", () => {
  it("error message mentions agrav-score-brownfield on model failure with non-zero row", () => {
    const tmp = mkdtempSync(join(tmpdir(), "bf-msg-test-"));
    try {
      const resultsDir = join(tmp, "eval-results");
      const attemptDir = join(resultsDir, "gemini-38-flash-low-attempt-1");
      mkdirSync(attemptDir, { recursive: true });

      // run.json model failure
      writeFileSync(
        join(attemptDir, "run.json"),
        JSON.stringify(sampleRunJson({ failureKind: "model" })) + "\n",
      );

      // eval-results.csv with non-zero row
      const csv = [
        "Criterion,Score,Max,Notes",
        "Task completion time,1min 0s,N/A,1min 0s",
        "Test run,04.10.2026 12:00,N/A,04.10.2026 12:00",
        "Local build,1,1,\"some note\"",
        "Regression,0,4,\"zero\"",
        "Change suite,0,3,\"zero\"",
        "Diff locality,0,1,\"zero\"",
        "Code structure,0,1,\"zero\"",
        "Self-verification,0,1,\"zero\"",
        "Visual design,0,1,\"zero\"",
        "Penalty,0,N/A,\"zero\"",
      ].join("\n") + "\n";
      writeFileSync(join(attemptDir, "eval-results.csv"), csv);

      const rubric = brownfieldRubricId(process.cwd());
      assert.throws(
        () =>
          processResults({
            resultsDir,
            resultsJsonPath: join(tmp, "results.json"),
            leaderboardJsonPath: join(tmp, "leaderboard.json"),
            rubric,
            rubricRows: BROWNFIELD_RUBRIC_ROWS,
          }),
        (err: Error) => {
          assert.ok(err.message.includes("agrav-score-brownfield"), `Expected agrav-score-brownfield, got: ${err.message}`);
          assert.ok(!err.message.includes("agrav-score-attempt"), `Should not contain agrav-score-attempt, got: ${err.message}`);
          return true;
        },
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("error message mentions contract-tests-brownfield and agrav-score-brownfield when results file is missing", () => {
    const tmp = mkdtempSync(join(tmpdir(), "bf-msg-test-"));
    try {
      const resultsDir = join(tmp, "eval-results");
      const attemptDir = join(resultsDir, "gemini-38-flash-low-attempt-1");
      mkdirSync(attemptDir, { recursive: true });

      // Valid non-model failure run.json
      writeFileSync(
        join(attemptDir, "run.json"),
        JSON.stringify(sampleRunJson()) + "\n",
      );

      // eval-results.csv present, but contract-results-brownfield.json missing
      const csv = [
        "Criterion,Score,Max,Notes",
        "Task completion time,1min 0s,N/A,1min 0s",
        "Test run,04.10.2026 12:00,N/A,04.10.2026 12:00",
        "Local build,1,1,\"some note\"",
        "Regression,4,4,\"4/4 passed\"",
        "Change suite,3,3,\"4/4 passed\"",
        "Diff locality,1,1,\"0 outside files\"",
        "Code structure,1,1,\"ok\"",
        "Self-verification,1,1,\"ok\"",
        "Visual design,1,1,\"ok\"",
        "Penalty,0,N/A,\"0\"",
      ].join("\n") + "\n";
      writeFileSync(join(attemptDir, "eval-results.csv"), csv);

      const rubric = brownfieldRubricId(process.cwd());
      assert.throws(
        () =>
          processResults({
            resultsDir,
            resultsJsonPath: join(tmp, "results.json"),
            leaderboardJsonPath: join(tmp, "leaderboard.json"),
            rubric,
            rubricRows: BROWNFIELD_RUBRIC_ROWS,
          }),
        (err: Error) => {
          assert.ok(err.message.includes("Run contract-tests-brownfield for this attempt"), `Expected contract-tests-brownfield, got: ${err.message}`);
          assert.ok(err.message.includes("agrav-score-brownfield"), `Expected agrav-score-brownfield, got: ${err.message}`);
          assert.ok(!err.message.includes("agrav-score-attempt"), `Should not contain agrav-score-attempt, got: ${err.message}`);
          return true;
        },
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("error message mentions contract-results-brownfield and agrav-score-brownfield on score mismatch", () => {
    const tmp = mkdtempSync(join(tmpdir(), "bf-msg-test-"));
    try {
      const resultsDir = join(tmp, "eval-results");
      const attemptDir = join(resultsDir, "gemini-38-flash-low-attempt-1");
      mkdirSync(attemptDir, { recursive: true });

      writeFileSync(
        join(attemptDir, "run.json"),
        JSON.stringify(sampleRunJson()) + "\n",
      );

      const rubric = brownfieldRubricId(process.cwd());
      writeFileSync(
        join(attemptDir, BROWNFIELD_RESULTS_FILE),
        JSON.stringify({
          schemaVersion: 1,
          track: "brownfield",
          rubric,
          attempt: "gemini-38-flash-low-attempt-1",
          regression: { passed: 58, total: 58, score: 4 },
          changeSuite: { passed: 4, total: 4, score: 3 },
          diffLocality: { score: 1, outsideFiles: [], totalLines: 50 },
          pytest: { ran: true, timedOut: false, exitCode: 0, passed: 10, failed: 0, errors: 0, durationMs: 100, outputTail: "", notRunReason: null },
        }) + "\n",
      );

      // CSV has Regression 3 instead of 4
      const csv = [
        "Criterion,Score,Max,Notes",
        "Task completion time,1min 0s,N/A,1min 0s",
        "Test run,04.10.2026 12:00,N/A,04.10.2026 12:00",
        "Local build,1,1,\"some note\"",
        "Regression,3,4,\"mismatch\"",
        "Change suite,3,3,\"4/4 passed\"",
        "Diff locality,1,1,\"0 outside files\"",
        "Code structure,1,1,\"ok\"",
        "Self-verification,1,1,\"ok\"",
        "Visual design,1,1,\"ok\"",
        "Penalty,0,N/A,\"0\"",
      ].join("\n") + "\n";
      writeFileSync(join(attemptDir, "eval-results.csv"), csv);

      assert.throws(
        () =>
          processResults({
            resultsDir,
            resultsJsonPath: join(tmp, "results.json"),
            leaderboardJsonPath: join(tmp, "leaderboard.json"),
            rubric,
            rubricRows: BROWNFIELD_RUBRIC_ROWS,
          }),
        (err: Error) => {
          assert.ok(err.message.includes("The contract-test rows are pasted from contract-results-brownfield"), `Expected contract-results-brownfield, got: ${err.message}`);
          assert.ok(err.message.includes("agrav-score-brownfield"), `Expected agrav-score-brownfield, got: ${err.message}`);
          assert.ok(!err.message.includes("agrav-score-attempt"), `Should not contain agrav-score-attempt, got: ${err.message}`);
          return true;
        },
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
