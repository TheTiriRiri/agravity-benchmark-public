/**
 * Tests for `process-results --track brownfield` and brownfield contract results validation.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROWNFIELD_RUBRIC_ROWS, brownfieldRubricId } from "../scripts/lib/brownfield-rubric";
import type { BrownfieldResult } from "../scripts/lib/brownfield-contract-results";

const ROOT = join(import.meta.dirname!, "..");

function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), "process-results-brownfield-test-"));
}

function mockGroup(file: string, row: string, max: number, total: number, passed: number, score: number) {
  return { file, row, max, total, passed, score, timedOut: false, hookFailed: 0, notRun: 0, detail: null, failed: [] };
}

function sampleBrownfieldResult(attempt: string, rubric: string): BrownfieldResult {
  return {
    schemaVersion: 1,
    track: "brownfield",
    rubric,
    attempt,
    image: "agrav-bench/harness:2026-09-19",
    runImage: null,
    testsCommit: "828dd7f",
    testsDirty: false,
    ungated: false,
    startedAt: "2026-10-04T12:00:00.000Z",
    durationMs: 120000,
    pipFreeze: ["fastapi==0.115.0"],
    warnings: [],
    boot: { ok: true, stage: null, detail: null },
    diagnosis: null,
    regression: {
      passed: 58,
      total: 58,
      score: 4,
      groups: [
        mockGroup("api-contract.test.ts", "Regression", 4, 58, 58, 4),
      ],
    },
    changeSuite: {
      passed: 4,
      total: 4,
      score: 3,
      groups: [
        mockGroup("change-invariants.test.ts", "Change suite", 2, 3, 3, 2),
        mockGroup("change-tie-break.test.ts", "Change suite", 1, 1, 1, 1),
      ],
    },
    diffLocality: {
      score: 1,
      outsideFiles: [],
      totalLines: 45,
    },
    pytest: {
      ran: true,
      timedOut: false,
      exitCode: 0,
      passed: 4,
      failed: 0,
      errors: 0,
      durationMs: 250,
      outputTail: "4 passed in 0.25s",
      notRunReason: null,
    },
  };
}

function sampleBrownfieldCsv(scores: {
  localBuild?: number;
  regression?: number;
  changeSuite?: number;
  diffLocality?: number;
  codeStructure?: number;
  selfVerification?: number;
  visualDesign?: number;
  penalty?: number;
} = {}): string {
  const lb = scores.localBuild ?? 1;
  const reg = scores.regression ?? 4;
  const cs = scores.changeSuite ?? 3;
  const dl = scores.diffLocality ?? 1;
  const cstruct = scores.codeStructure ?? 1;
  const sv = scores.selfVerification ?? 1;
  const vd = scores.visualDesign ?? 1;
  const pen = scores.penalty ?? 0;

  return [
    `Criterion,Score,Max,Notes`,
    `Task completion time,12min 30s,N/A,From run.json`,
    `Test run,2026-10-04 12:00,N/A,Automated run`,
    `Local build,${lb},1,Docker container built successfully`,
    `Regression,${reg},4,All 58 regression tests passed`,
    `Change suite,${cs},3,All 4 change suite tests passed`,
    `Diff locality,${dl},1,"0 outside files, 45 lines changed"`,
    `Code structure,${cstruct},1,Clean modular changes`,
    `Self-verification,${sv},1,Comprehensive test checks`,
    `Visual design,${vd},1,Clean layout`,
    `Penalty,${pen},N/A,No penalties`,
  ].join("\n");
}

describe("process-results --track brownfield", () => {
  it("RUBRIC_ID_RE accepts brownfield rubric ID format", async () => {
    const mod = await import("../scripts/process-results.js");
    const id = brownfieldRubricId(ROOT);
    assert.doesNotThrow(() => {
      try {
        mod.processResults({
          resultsDir: "/nonexistent-dir-for-testing",
          resultsJsonPath: "/tmp/test-results.json",
          leaderboardJsonPath: "/tmp/test-leaderboard.json",
          rubric: id,
          warn: () => {},
        });
      } catch (e: unknown) {
        const msg = (e as Error).message;
        if (msg.includes("rubric must be a rubric id") || msg.includes("maintenance-console@")) {
          throw e;
        }
      }
    });
  });

  it("parseArgs accepts --track brownfield", async () => {
    const mod = await import("../scripts/process-results.js");
    const exit = mod.main(["--track", "brownfield", "--help"]);
    assert.equal(exit, 0);
  });

  it("--track brownfield routes to results-brownfield.json and leaderboard-brownfield.json", async () => {
    const mod = await import("../scripts/process-results.js");
    const tmpRoot = makeTempRoot();
    try {
      const resultsDir = join(tmpRoot, "tracks", "brownfield", "eval-results");
      mkdirSync(resultsDir, { recursive: true });

      const exit = mod.main(["--track", "brownfield", "--root", tmpRoot]);
      assert.equal(exit, 0);

      assert.ok(
        existsSync(join(tmpRoot, "website", "src", "data", "results-brownfield.json")),
        "results-brownfield.json must be created",
      );
      assert.ok(
        existsSync(join(tmpRoot, "website", "public", "api", "leaderboard-brownfield.json")),
        "leaderboard-brownfield.json must be created",
      );
      assert.ok(
        !existsSync(join(tmpRoot, "website", "src", "data", "results.json")),
        "classic results.json must not be created",
      );
      assert.ok(
        !existsSync(join(tmpRoot, "website", "src", "data", "results-hard.json")),
        "hard results-hard.json must not be created",
      );
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("validates contract-results-brownfield.json matches eval-results.csv", async () => {
    const mod = await import("../scripts/process-results.js");
    const tmpRoot = makeTempRoot();
    try {
      const rubric = brownfieldRubricId(ROOT);
      const attemptDir = join(tmpRoot, "eval-results", "gemini-38-flash-high-attempt-1");
      mkdirSync(attemptDir, { recursive: true });

      // CSV with Regression=4, Change suite=3, Diff locality=1
      writeFileSync(join(attemptDir, "eval-results.csv"), sampleBrownfieldCsv());
      // contract results with matching scores
      const cr = sampleBrownfieldResult("gemini-38-flash-high-attempt-1", rubric);
      writeFileSync(join(attemptDir, "contract-results-brownfield.json"), JSON.stringify(cr, null, 2));

      const outcome = mod.processResults({
        resultsDir: join(tmpRoot, "eval-results"),
        resultsJsonPath: join(tmpRoot, "out-results.json"),
        leaderboardJsonPath: join(tmpRoot, "out-leaderboard.json"),
        rubric,
        rubricRows: BROWNFIELD_RUBRIC_ROWS,
        warn: () => {},
      });

      assert.equal(outcome.results.totalAttempts, 1);
      assert.equal(outcome.results.results[0].totalScore, 12);
      assert.equal(outcome.results.results[0].maxScore, 12);
      assert.equal(outcome.results.results[0].percentage, 100);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("throws when contract-results-brownfield.json is missing", async () => {
    const mod = await import("../scripts/process-results.js");
    const tmpRoot = makeTempRoot();
    try {
      const rubric = brownfieldRubricId(ROOT);
      const attemptDir = join(tmpRoot, "eval-results", "gemini-38-flash-high-attempt-1");
      mkdirSync(attemptDir, { recursive: true });

      writeFileSync(join(attemptDir, "eval-results.csv"), sampleBrownfieldCsv());

      assert.throws(() => {
        mod.processResults({
          resultsDir: join(tmpRoot, "eval-results"),
          resultsJsonPath: join(tmpRoot, "out-results.json"),
          leaderboardJsonPath: join(tmpRoot, "out-leaderboard.json"),
          rubric,
          rubricRows: BROWNFIELD_RUBRIC_ROWS,
          warn: () => {},
        });
      }, /no contract-results-brownfield\.json beside eval-results\.csv/);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("throws when contract-results-brownfield.json belongs to another attempt", async () => {
    const mod = await import("../scripts/process-results.js");
    const tmpRoot = makeTempRoot();
    try {
      const rubric = brownfieldRubricId(ROOT);
      const attemptDir = join(tmpRoot, "eval-results", "gemini-38-flash-high-attempt-1");
      mkdirSync(attemptDir, { recursive: true });

      writeFileSync(join(attemptDir, "eval-results.csv"), sampleBrownfieldCsv());
      // contract results with wrong attempt id
      const cr = sampleBrownfieldResult("gemini-31-pro-high-attempt-1", rubric);
      writeFileSync(join(attemptDir, "contract-results-brownfield.json"), JSON.stringify(cr, null, 2));

      assert.throws(() => {
        mod.processResults({
          resultsDir: join(tmpRoot, "eval-results"),
          resultsJsonPath: join(tmpRoot, "out-results.json"),
          leaderboardJsonPath: join(tmpRoot, "out-leaderboard.json"),
          rubric,
          rubricRows: BROWNFIELD_RUBRIC_ROWS,
          warn: () => {},
        });
      }, /belongs to another attempt/);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("throws when hidden rows or diff locality disagree with contract-results-brownfield.json", async () => {
    const mod = await import("../scripts/process-results.js");
    const tmpRoot = makeTempRoot();
    try {
      const rubric = brownfieldRubricId(ROOT);
      const attemptDir = join(tmpRoot, "eval-results", "gemini-38-flash-high-attempt-1");
      mkdirSync(attemptDir, { recursive: true });

      // CSV claims Change suite=3, but contract-results says score=1
      writeFileSync(join(attemptDir, "eval-results.csv"), sampleBrownfieldCsv({ changeSuite: 3 }));
      const cr = sampleBrownfieldResult("gemini-38-flash-high-attempt-1", rubric);
      cr.changeSuite.score = 1;
      writeFileSync(join(attemptDir, "contract-results-brownfield.json"), JSON.stringify(cr, null, 2));

      assert.throws(() => {
        mod.processResults({
          resultsDir: join(tmpRoot, "eval-results"),
          resultsJsonPath: join(tmpRoot, "out-results.json"),
          leaderboardJsonPath: join(tmpRoot, "out-leaderboard.json"),
          rubric,
          rubricRows: BROWNFIELD_RUBRIC_ROWS,
          warn: () => {},
        });
      }, /"Change suite" is 3 in eval-results\.csv but 1 in contract-results-brownfield\.json/);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("skips attempt as other era when scored under another brownfield rubric id", async () => {
    const mod = await import("../scripts/process-results.js");
    const tmpRoot = makeTempRoot();
    try {
      const rubric = brownfieldRubricId(ROOT);
      const otherRubric = "maintenance-console-brownfield@000000000000";
      const attemptDir = join(tmpRoot, "eval-results", "gemini-38-flash-high-attempt-1");
      mkdirSync(attemptDir, { recursive: true });

      writeFileSync(join(attemptDir, "eval-results.csv"), sampleBrownfieldCsv());
      const cr = sampleBrownfieldResult("gemini-38-flash-high-attempt-1", otherRubric);
      writeFileSync(join(attemptDir, "contract-results-brownfield.json"), JSON.stringify(cr, null, 2));

      const warnings: string[] = [];
      const outcome = mod.processResults({
        resultsDir: join(tmpRoot, "eval-results"),
        resultsJsonPath: join(tmpRoot, "out-results.json"),
        leaderboardJsonPath: join(tmpRoot, "out-leaderboard.json"),
        rubric,
        rubricRows: BROWNFIELD_RUBRIC_ROWS,
        warn: (msg: string) => warnings.push(msg),
      });

      assert.equal(outcome.results.totalAttempts, 0);
      assert.ok(warnings.some((w) => w.includes("scored under rubric maintenance-console-brownfield@000000000000")));
      assert.ok(warnings.some((w) => w.includes("withheld")));
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("handles model failure without contract-results-brownfield.json, requiring zeros on scored rows", async () => {
    const mod = await import("../scripts/process-results.js");
    const tmpRoot = makeTempRoot();
    try {
      const rubric = brownfieldRubricId(ROOT);
      const attemptDir = join(tmpRoot, "eval-results", "gemini-38-flash-high-attempt-1");
      mkdirSync(attemptDir, { recursive: true });

      // Model failure run.json
      writeFileSync(
        join(attemptDir, "run.json"),
        JSON.stringify({
          id: "gemini-38-flash-high",
          model: "gemini-3.8-flash-high",
          effort: "high",
          agyVersion: "1.2.7",
          image: "agrav-bench/harness:2026-09-19@sha256:123",
          startedAt: "2026-10-04T12:00:00Z",
          durationMs: 5000,
          exitCode: 1,
          envelope: null,
          stderrTail: "crash",
          softDenied: false,
          failureKind: "model",
        }, null, 2),
      );

      // Non-zero CSV for model failure should fail
      writeFileSync(join(attemptDir, "eval-results.csv"), sampleBrownfieldCsv({ localBuild: 1 }));

      assert.throws(() => {
        mod.processResults({
          resultsDir: join(tmpRoot, "eval-results"),
          resultsJsonPath: join(tmpRoot, "out-results.json"),
          leaderboardJsonPath: join(tmpRoot, "out-leaderboard.json"),
          rubric,
          rubricRows: BROWNFIELD_RUBRIC_ROWS,
          warn: () => {},
        });
      }, /run\.json records a model failure, so every scored row and Penalty must be 0/);

      // All zero CSV should succeed
      const allZeroCsv = sampleBrownfieldCsv({
        localBuild: 0,
        regression: 0,
        changeSuite: 0,
        diffLocality: 0,
        codeStructure: 0,
        selfVerification: 0,
        visualDesign: 0,
        penalty: 0,
      });
      writeFileSync(join(attemptDir, "eval-results.csv"), allZeroCsv);

      const outcome = mod.processResults({
        resultsDir: join(tmpRoot, "eval-results"),
        resultsJsonPath: join(tmpRoot, "out-results.json"),
        leaderboardJsonPath: join(tmpRoot, "out-leaderboard.json"),
        rubric,
        rubricRows: BROWNFIELD_RUBRIC_ROWS,
        warn: () => {},
      });

      assert.equal(outcome.results.totalAttempts, 1);
      assert.equal(outcome.results.results[0].totalScore, 0);
      assert.equal(outcome.results.results[0].percentage, 0);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("invariance: classic processResults on fixture produces unchanged results", async () => {
    const mod = await import("../scripts/process-results.js");
    const { FIXTURE_RUBRIC } = await import("./fixtures/contract-results-fixture.js");
    const tmpRoot = makeTempRoot();
    try {
      const classicFixtureDir = join(ROOT, "test", "fixtures", "eval-results");
      const outcome = mod.processResults({
        resultsDir: classicFixtureDir,
        resultsJsonPath: join(tmpRoot, "results.json"),
        leaderboardJsonPath: join(tmpRoot, "leaderboard.json"),
        rubric: FIXTURE_RUBRIC,
        warn: () => {},
      });
      assert.equal(outcome.results.totalAttempts, 5);
      assert.equal(outcome.leaderboard.totalAttempts, 5);
      const opus = outcome.results.results.find((r) => r.id === "claude-opus-46-high-attempt-1")!;
      assert.ok(opus, "claude-opus-46-high-attempt-1 must be present");
      assert.equal(opus.totalScore, 13.4);
      assert.equal(opus.maxScore, 14);
      assert.ok(existsSync(join(tmpRoot, "results.json")));
      assert.ok(existsSync(join(tmpRoot, "leaderboard.json")));
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("invariance: hard track outputs remain isolated and correct", async () => {
    const mod = await import("../scripts/process-results.js");
    const tmpRoot = makeTempRoot();
    try {
      const hardResultsDir = join(tmpRoot, "tracks", "console-hard", "eval-results");
      mkdirSync(hardResultsDir, { recursive: true });

      const exit = mod.main(["--track", "hard", "--root", tmpRoot]);
      assert.equal(exit, 0);

      assert.ok(existsSync(join(tmpRoot, "website", "src", "data", "results-hard.json")));
      assert.ok(existsSync(join(tmpRoot, "website", "public", "api", "leaderboard-hard.json")));
      assert.ok(!existsSync(join(tmpRoot, "website", "src", "data", "results.json")));
      assert.ok(!existsSync(join(tmpRoot, "website", "src", "data", "results-brownfield.json")));
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("Task 7 + 7b compatibility: process-results accepts CSV with rows from brownfieldHiddenRowLines", async () => {
    const mod = await import("../scripts/process-results.js");
    const { brownfieldHiddenRowLines } = await import("../scripts/lib/brownfield-contract-results.js");
    const tmpRoot = makeTempRoot();
    try {
      const attemptName = "claude-opus-46-high-attempt-1";
      const attemptDir = join(tmpRoot, "tracks", "brownfield", "eval-results", attemptName);
      mkdirSync(attemptDir, { recursive: true });

      const rubric = brownfieldRubricId(process.cwd());
      const contractResult = sampleBrownfieldResult(attemptName, rubric);
      writeFileSync(join(attemptDir, "contract-results-brownfield.json"), JSON.stringify(contractResult, null, 2) + "\n");

      const runJson = {
        id: "claude-opus-46-high",
        model: "claude-opus-4-6",
        effort: "high",
        agyVersion: "1.1.26",
        image: "agrav:test@sha256:1111",
        startedAt: "2026-10-04T12:00:00.000Z",
        durationMs: 750000,
        exitCode: 0,
        envelope: null,
        stderrTail: "",
        softDenied: false,
        failureKind: null,
      };
      writeFileSync(join(attemptDir, "run.json"), JSON.stringify(runJson, null, 2) + "\n");

      // Generate CSV using brownfieldHiddenRowLines for the 3 tool-provided rows
      const toolRows = brownfieldHiddenRowLines(contractResult);
      const csv = [
        "Criterion,Score,Max,Notes",
        "Task completion time,12min 30s,N/A,12min 30s",
        "Test run,04.10.2026 12:00,N/A,04.10.2026 12:00",
        "Local build,1,1,\"Backend boot and frontend build succeeded\"",
        toolRows[0],
        toolRows[1],
        toolRows[2],
        "Code structure,1,1,\"Clean modular planner implementation\"",
        "Self-verification,1,1,\"Tests added in backend/tests/ exercising balanced strategy\"",
        "Visual design,1,1,\"UI design intact and clean\"",
        "Penalty,0,N/A,\"No penalties\"",
      ].join("\n") + "\n";
      writeFileSync(join(attemptDir, "eval-results.csv"), csv);

      // Verify process-results --track brownfield passes
      const exitCode = mod.main(["--track", "brownfield", "--root", tmpRoot, "--rubric", rubric]);
      assert.equal(exitCode, 0);

      // Now mutate one hidden row score in eval-results.csv and verify it is rejected
      const mutatedCsv = csv.replace(toolRows[0], toolRows[0].replace(",4,", ",3,"));
      writeFileSync(join(attemptDir, "eval-results.csv"), mutatedCsv);

      assert.throws(
        () => mod.main(["--track", "brownfield", "--root", tmpRoot, "--rubric", rubric]),
        (err: Error) => {
          assert.ok(err.message.includes("contract-results-brownfield"));
          assert.ok(err.message.includes("agrav-score-brownfield"));
          return true;
        },
      );
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("accepts backend stop in brownfield track when CSV and JSON both have 0 for Regression, Change suite and Diff locality", async () => {
    const mod = await import("../scripts/process-results.js");
    const tmpRoot = makeTempRoot();
    try {
      const rubric = brownfieldRubricId(ROOT);
      const attemptDir = join(tmpRoot, "eval-results", "gemini-38-flash-high-attempt-1");
      mkdirSync(attemptDir, { recursive: true });

      writeFileSync(
        join(attemptDir, "eval-results.csv"),
        sampleBrownfieldCsv({
          localBuild: 0,
          regression: 0,
          changeSuite: 0,
          diffLocality: 0,
        }),
      );
      const cr = sampleBrownfieldResult("gemini-38-flash-high-attempt-1", rubric);
      cr.boot = { ok: false, stage: "install", detail: "pip install failed" };
      cr.regression.score = 0;
      cr.regression.passed = 0;
      cr.changeSuite.score = 0;
      cr.changeSuite.passed = 0;
      cr.diffLocality.score = 0;
      writeFileSync(join(attemptDir, "contract-results-brownfield.json"), JSON.stringify(cr, null, 2));

      const outcome = mod.processResults({
        resultsDir: join(tmpRoot, "eval-results"),
        resultsJsonPath: join(tmpRoot, "out-results.json"),
        leaderboardJsonPath: join(tmpRoot, "out-leaderboard.json"),
        rubric,
        rubricRows: BROWNFIELD_RUBRIC_ROWS,
        warn: () => {},
      });

      assert.equal(outcome.results.totalAttempts, 1);
      assert.equal(outcome.results.results[0].totalScore, 3);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("throws for backend stop in brownfield track if CSV claims Diff locality > 0 while contract-results has 0", async () => {
    const mod = await import("../scripts/process-results.js");
    const tmpRoot = makeTempRoot();
    try {
      const rubric = brownfieldRubricId(ROOT);
      const attemptDir = join(tmpRoot, "eval-results", "gemini-38-flash-high-attempt-1");
      mkdirSync(attemptDir, { recursive: true });

      writeFileSync(
        join(attemptDir, "eval-results.csv"),
        sampleBrownfieldCsv({
          localBuild: 0,
          regression: 0,
          changeSuite: 0,
          diffLocality: 1,
        }),
      );
      const cr = sampleBrownfieldResult("gemini-38-flash-high-attempt-1", rubric);
      cr.boot = { ok: false, stage: "install", detail: "pip install failed" };
      cr.regression.score = 0;
      cr.changeSuite.score = 0;
      cr.diffLocality.score = 0;
      writeFileSync(join(attemptDir, "contract-results-brownfield.json"), JSON.stringify(cr, null, 2));

      assert.throws(() => {
        mod.processResults({
          resultsDir: join(tmpRoot, "eval-results"),
          resultsJsonPath: join(tmpRoot, "out-results.json"),
          leaderboardJsonPath: join(tmpRoot, "out-leaderboard.json"),
          rubric,
          rubricRows: BROWNFIELD_RUBRIC_ROWS,
          warn: () => {},
        });
      }, /"Diff locality" is 1 in eval-results\.csv but 0 in contract-results-brownfield\.json/);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});


