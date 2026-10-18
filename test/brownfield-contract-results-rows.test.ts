import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "csv-parse/sync";

import {
  brownfieldHiddenRowLines,
  buildBrownfieldResult,
  type BrownfieldResult,
  BROWNFIELD_RESULTS_FILE,
} from "../scripts/lib/brownfield-contract-results";
import {
  BROWNFIELD_RUBRIC_ROWS,
  getRequiredRowMax,
} from "../scripts/lib/brownfield-rubric";
import { main as cliMain } from "../scripts/contract-results-brownfield";

function sampleBrownfieldResult(overrides: Partial<BrownfieldResult> = {}): BrownfieldResult {
  return {
    schemaVersion: 1,
    track: "brownfield",
    rubric: "maintenance-console-brownfield@123456789012",
    attempt: "gemini-flash-attempt-1",
    image: "agrav-test:tag@sha256:1111",
    runImage: null,
    testsCommit: "0123456789abcdef0123456789abcdef01234567",
    testsDirty: false,
    ungated: false,
    startedAt: "2026-10-04T12:00:00.000Z",
    durationMs: 42000,
    pipFreeze: ["fastapi==0.115.0"],
    warnings: [],
    boot: { ok: true, stage: null, detail: null },
    diagnosis: null,
    regression: {
      passed: 50,
      total: 58,
      score: 3.45,
      groups: [
        {
          file: "api-contract.test.ts",
          row: "API contract",
          max: 2,
          passed: 20,
          total: 24,
          score: 1.67,
          timedOut: false,
          notRun: 0,
          hookFailed: 0,
          detail: null,
          failed: [{ name: "POST /reset resets DB", message: "expected 200 got 500", failureType: "assertion" }],
        },
      ],
    },
    changeSuite: {
      passed: 4,
      total: 4,
      score: 3,
      groups: [
        {
          file: "change-invariants.test.ts",
          row: "Change suite",
          max: 2,
          passed: 3,
          total: 3,
          score: 2,
          timedOut: false,
          notRun: 0,
          hookFailed: 0,
          detail: null,
          failed: [],
        },
        {
          file: "change-tie-break.test.ts",
          row: "Change suite",
          max: 1,
          passed: 1,
          total: 1,
          score: 1,
          timedOut: false,
          notRun: 0,
          hookFailed: 0,
          detail: null,
          failed: [],
        },
      ],
    },
    diffLocality: {
      score: 0.85,
      outsideFiles: ["extra/file.py"],
      totalLines: 75,
    },
    pytest: {
      ran: true,
      timedOut: false,
      exitCode: 0,
      passed: 4,
      failed: 0,
      errors: 0,
      durationMs: 120,
      outputTail: "4 passed in 0.12s",
      notRunReason: null,
    },
    ...overrides,
  };
}

interface CsvRow {
  Criterion: string;
  Score: string;
  Max: string;
  Notes: string;
}

describe("brownfieldHiddenRowLines", () => {
  it("returns exactly 3 valid CSV lines with correct row names, scores, and maxima", () => {
    const res = sampleBrownfieldResult();
    const lines = brownfieldHiddenRowLines(res);
    assert.equal(lines.length, 3);

    const parsed = parse(lines.join("\n") + "\n", {
      columns: ["Criterion", "Score", "Max", "Notes"],
    }) as CsvRow[];
    assert.equal(parsed.length, 3);

    // Row 1: Regression
    assert.equal(parsed[0].Criterion, "Regression");
    assert.equal(parsed[0].Score, "3.45");
    assert.equal(parsed[0].Max, "4");
    assert.ok(parsed[0].Notes.includes("50/58 passed"));
    assert.ok(parsed[0].Notes.includes("failed: POST /reset resets DB"));

    // Row 2: Change suite
    assert.equal(parsed[1].Criterion, "Change suite");
    assert.equal(parsed[1].Score, "3");
    assert.equal(parsed[1].Max, "3");
    assert.ok(parsed[1].Notes.includes("4/4 passed"));

    // Row 3: Diff locality
    assert.equal(parsed[2].Criterion, "Diff locality");
    assert.equal(parsed[2].Score, "0.85");
    assert.equal(parsed[2].Max, "1");
    assert.ok(parsed[2].Notes.includes("1 outside file"));
    assert.ok(parsed[2].Notes.includes("75 lines changed"));
  });

  it("handles backend stop: Regression, Change suite, and Diff locality are 0 with note", () => {
    const res = sampleBrownfieldResult({
      boot: { ok: false, stage: "install", detail: "pip install failed with error 1" },
      regression: {
        passed: 0,
        total: 58,
        score: 0,
        groups: [],
      },
      changeSuite: {
        passed: 0,
        total: 4,
        score: 0,
        groups: [],
      },
      diffLocality: {
        score: 0.75,
        outsideFiles: [],
        totalLines: 125,
      },
    });

    const lines = brownfieldHiddenRowLines(res);
    const parsed = parse(lines.join("\n") + "\n", {
      columns: ["Criterion", "Score", "Max", "Notes"],
    }) as CsvRow[];

    assert.equal(parsed[0].Criterion, "Regression");
    assert.equal(parsed[0].Score, "0");
    assert.equal(parsed[0].Max, "4");
    assert.ok(parsed[0].Notes.includes("backend stop (install)"));

    assert.equal(parsed[1].Criterion, "Change suite");
    assert.equal(parsed[1].Score, "0");
    assert.equal(parsed[1].Max, "3");
    assert.ok(parsed[1].Notes.includes("backend stop (install)"));

    assert.equal(parsed[2].Criterion, "Diff locality");
    assert.equal(parsed[2].Score, "0");
    assert.equal(parsed[2].Max, "1");
    assert.ok(parsed[2].Notes.includes("backend stop"));
  });

  it("buildBrownfieldResult sets diffLocality.score = 0 on backend stop while preserving files and lines", () => {
    const res = buildBrownfieldResult({
      attempt: "gemini-flash-attempt-1",
      image: "test-img",
      runImage: null,
      rubric: "maintenance-console-brownfield@123456789012",
      testsCommit: "1234567",
      testsDirty: false,
      ungated: false,
      startedAt: new Date().toISOString(),
      durationMs: 1000,
      pipFreeze: [],
      warnings: [],
      boot: { ok: false, stage: "install", detail: "pip failed" },
      diagnosis: null,
      regressionGroups: [],
      changeGroups: [],
      diffLocality: {
        score: 0.75,
        outsideFiles: ["foo.py"],
        totalLines: 100,
      },
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
    });
    assert.equal(res.diffLocality.score, 0);
    assert.deepEqual(res.diffLocality.outsideFiles, ["foo.py"]);
    assert.equal(res.diffLocality.totalLines, 100);
  });

  it("getRequiredRowMax returns row max or throws if missing or non-numeric", () => {
    assert.equal(getRequiredRowMax(BROWNFIELD_RUBRIC_ROWS, "Regression"), 4);
    assert.equal(getRequiredRowMax(BROWNFIELD_RUBRIC_ROWS, "Change suite"), 3);
    assert.equal(getRequiredRowMax(BROWNFIELD_RUBRIC_ROWS, "Diff locality"), 1);
    assert.throws(() => getRequiredRowMax(BROWNFIELD_RUBRIC_ROWS, "Non-existent row"), /not found/);
    assert.throws(() => getRequiredRowMax(BROWNFIELD_RUBRIC_ROWS, "Task completion time"), /does not have a numeric max/);
  });

  it("handles reset-broken diagnosis for Regression", () => {
    const res = sampleBrownfieldResult({
      diagnosis: "reset-broken",
    });
    const lines = brownfieldHiddenRowLines(res);
    const parsed = parse(lines.join("\n") + "\n", {
      columns: ["Criterion", "Score", "Max", "Notes"],
    }) as CsvRow[];
    assert.ok(parsed[0].Notes.includes("POST /reset does not answer 200"));
  });
});

describe("contract-results-brownfield CLI", () => {
  it("prints 3 lines for a valid attempt results file", () => {
    const tmp = mkdtempSync(join(tmpdir(), "bf-cli-test-"));
    try {
      const attemptDir = join(tmp, "eval-results", "gemini-flash-attempt-1");
      mkdirSync(attemptDir, { recursive: true });
      const res = sampleBrownfieldResult();
      writeFileSync(join(attemptDir, BROWNFIELD_RESULTS_FILE), JSON.stringify(res, null, 2) + "\n");

      let stdout = "";
      let stderr = "";
      const exitCode = cliMain(
        ["--rows", "gemini-flash-attempt-1", "--root", tmp],
        {
          out: (t) => { stdout += t; },
          err: (t) => { stderr += t; },
        },
      );

      assert.equal(exitCode, 0, `stderr was: ${stderr}`);
      const lines = stdout.trim().split("\n");
      assert.equal(lines.length, 3);
      assert.ok(lines[0].startsWith("Regression,3.45,4,"));
      assert.ok(lines[1].startsWith("Change suite,3,3,"));
      assert.ok(lines[2].startsWith("Diff locality,0.85,1,"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns exit code 1 when result file is missing", () => {
    const tmp = mkdtempSync(join(tmpdir(), "bf-cli-test-"));
    try {
      let stderr = "";
      const exitCode = cliMain(
        ["--rows", "gemini-flash-attempt-1", "--root", tmp],
        {
          out: () => {},
          err: (t) => { stderr += t; },
        },
      );
      assert.equal(exitCode, 1);
      assert.ok(stderr.includes("contract-results-brownfield:"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not fall back to tracks/brownfield/eval-results when --root is passed", () => {
    const tmp = mkdtempSync(join(tmpdir(), "bf-cli-test-"));
    try {
      const nestedDir = join(tmp, "tracks", "brownfield", "eval-results", "gemini-flash-attempt-1");
      mkdirSync(nestedDir, { recursive: true });
      const res = sampleBrownfieldResult();
      writeFileSync(join(nestedDir, BROWNFIELD_RESULTS_FILE), JSON.stringify(res, null, 2) + "\n");

      let stderr = "";
      const exitCode = cliMain(
        ["--rows", "gemini-flash-attempt-1", "--root", tmp],
        {
          out: () => {},
          err: (t) => { stderr += t; },
        },
      );
      assert.equal(exitCode, 1);
      assert.ok(stderr.includes("contract-results-brownfield:"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns exit code 2 on usage errors", () => {
    let stderr = "";
    const exitCode = cliMain([], {
      out: () => {},
      err: (t) => { stderr += t; },
    });
    assert.equal(exitCode, 2);
    assert.ok(stderr.includes("--rows <dir> is required"));
  });
});
