import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  BROWNFIELD_RESULTS_FILE,
  BROWNFIELD_TRACK,
  buildBrownfieldResult,
  loadBrownfieldManifest,
  parseBrownfieldResult,
  validateBrownfieldResult,
  writeBrownfieldContractResults,
  type BrownfieldResult,
} from "../scripts/lib/brownfield-contract-results";
import { brownfieldRubricId } from "../scripts/lib/brownfield-rubric";
import type { BootStage, FailedTest } from "../scripts/lib/contract-results";
import type { ContractFileResult } from "../scripts/lib/contract-suite";
import { ALLOWED_PATTERNS, computeDiffLocality, isAllowedPath, numstatLines } from "../scripts/lib/diff-locality";
import {
  BASE_DIR,
  DEFAULT_TRACK_ROOT,
  REPO_ROOT,
  runBrownfieldContractTests,
  type BrownfieldTestsDeps,
  type BrownfieldTestsOptions,
} from "../scripts/contract-tests-brownfield";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const baseDir = join(ROOT, "tracks", "brownfield", "base");
const manifestPath = join(ROOT, "tracks", "brownfield", "benchmark", "contract-tests", "manifest.json");
const solutionPatch = join(ROOT, "tracks", "brownfield", "benchmark", "solution", "balanced.patch");

// ---------------------------------------------------------------------------
// 1. Diff Locality unit tests
// ---------------------------------------------------------------------------

test("ALLOWED_PATTERNS correctly matches the 7 brownfield architectural seams", () => {
  assert.equal(ALLOWED_PATTERNS.length, 7);

  // Allowed paths
  assert.ok(isAllowedPath("backend/app/planner.py"));
  assert.ok(isAllowedPath("backend/app/routes.py"));
  assert.ok(isAllowedPath("backend/app/schemas.py"));
  assert.ok(isAllowedPath("backend/tests/test_planner.py"));
  assert.ok(isAllowedPath("frontend/src/services/api.ts"));
  assert.ok(isAllowedPath("frontend/src/types/plan.ts"));
  assert.ok(isAllowedPath("frontend/src/views/ScheduleView.tsx"));

  // Outside paths
  assert.equal(isAllowedPath("backend/app/main.py"), false);
  assert.equal(isAllowedPath("backend/app/store.py"), false);
  assert.equal(isAllowedPath("frontend/src/App.tsx"), false);
  assert.equal(isAllowedPath("frontend/package.json"), false);
  assert.equal(isAllowedPath("README.md"), false);
});

test("computeDiffLocality gives 1.0 for untouched base", () => {
  const result = computeDiffLocality(baseDir, baseDir);
  assert.equal(result.score, 1.0);
  assert.deepEqual(result.outsideFiles, []);
  assert.equal(result.totalLines, 0);
});

test("computeDiffLocality penalizes files modified outside allowed patterns", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agrav-locality-test-"));
  try {
    cpSync(baseDir, tempDir, { recursive: true });

    // Modify 1 outside file: backend/app/store.py
    const storeFile = join(tempDir, "backend", "app", "store.py");
    writeFileSync(storeFile, readFileSync(storeFile, "utf8") + "# outside edit\n");

    const result = computeDiffLocality(tempDir, baseDir);
    assert.deepEqual(result.outsideFiles, ["backend/app/store.py"]);
    assert.equal(result.totalLines, 1);
    // score: (1.0 - 0.25 * 1) * (1.0 - 1/500) = 0.75 * 0.998 = 0.7485 -> 0.75
    assert.equal(result.score, 0.75);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("computeDiffLocality ignores package-lock.json and BASE_EXCLUDES", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agrav-locality-test-"));
  try {
    cpSync(baseDir, tempDir, { recursive: true });

    // Add build/install artifacts that should be ignored
    writeFileSync(join(tempDir, "package-lock.json"), '{"lockfileVersion": 3}\n');
    writeFileSync(join(tempDir, "frontend", "package-lock.json"), '{"lockfileVersion": 3}\n');
    const pycache = join(tempDir, "backend", "app", "__pycache__");
    mkdtempSync(join(tmpdir(), "dummy-")); // ensure temp dir works
    cpSync(join(baseDir, "backend"), join(tempDir, "backend"), { recursive: true });

    const result = computeDiffLocality(tempDir, baseDir);
    assert.equal(result.score, 1.0);
    assert.deepEqual(result.outsideFiles, []);
    assert.equal(result.totalLines, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("computeDiffLocality ignores Python tool caches (.pytest_cache, .mypy_cache, .ruff_cache)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agrav-locality-cache-"));
  try {
    cpSync(baseDir, tempDir, { recursive: true });

    // Modify an allowed file so we know the diff is real
    const plannerFile = join(tempDir, "backend", "app", "planner.py");
    writeFileSync(plannerFile, readFileSync(plannerFile, "utf8") + "# balanced\n");

    // Add Python tool cache artifacts that should be ignored
    const pytestCache = join(tempDir, "backend", ".pytest_cache");
    mkdirSync(join(pytestCache, "v", "cache"), { recursive: true });
    writeFileSync(join(pytestCache, "CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55");
    writeFileSync(join(pytestCache, ".gitignore"), "# pytest cache\n*\n");
    writeFileSync(join(pytestCache, "README.md"), "pytest cache dir");
    writeFileSync(join(pytestCache, "v", "cache", "nodeids"), "backend/tests/test_planner.py::test_plan");

    const mypyCache = join(tempDir, "backend", ".mypy_cache");
    mkdirSync(join(mypyCache, "3.11"), { recursive: true });
    writeFileSync(join(mypyCache, "3.11", "app.data.json"), "{}");
    writeFileSync(join(mypyCache, "CACHEDIR.TAG"), "mypy cache");

    const resultWith = computeDiffLocality(tempDir, baseDir);

    // Now remove caches and compare
    rmSync(pytestCache, { recursive: true, force: true });
    rmSync(mypyCache, { recursive: true, force: true });
    const resultWithout = computeDiffLocality(tempDir, baseDir);

    assert.equal(resultWith.score, resultWithout.score, "score must be the same with or without tool caches");
    assert.deepEqual(resultWith.outsideFiles, resultWithout.outsideFiles, "outsideFiles must be the same");
    assert.equal(resultWith.totalLines, resultWithout.totalLines, "totalLines must be the same");
    assert.deepEqual(resultWith.outsideFiles, [], "tool caches must not count as outside files");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("numstatLines throws when git diff exits with status other than 0 or 1", () => {
  assert.throws(
    () => numstatLines("--unknown-flag-xyz", "/dev/null"),
    /git diff --no-index failed with exit code 129/,
  );
});

test("numstatLines throws when git diff fails to run (res.error)", () => {
  const origPath = process.env.PATH;
  try {
    process.env.PATH = "";
    assert.throws(
      () => numstatLines("/dev/null", "/dev/null"),
      /git diff --no-index failed to run:/,
    );
  } finally {
    process.env.PATH = origPath;
  }
});

// ---------------------------------------------------------------------------
// 2. Brownfield Manifest unit tests
// ---------------------------------------------------------------------------

test("loadBrownfieldManifest loads manifest and validates entries", () => {
  const entries = loadBrownfieldManifest(manifestPath);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].file, "change-invariants.test.ts");
  assert.equal(entries[0].row, "Change suite");
  assert.equal(entries[0].max, 2);
  assert.equal(entries[0].tests, 3);

  assert.equal(entries[1].file, "change-tie-break.test.ts");
  assert.equal(entries[1].row, "Change suite");
  assert.equal(entries[1].max, 1);
  assert.equal(entries[1].tests, 1);

  const totalMax = entries.reduce((s, e) => s + e.max, 0);
  const totalTests = entries.reduce((s, e) => s + e.tests, 0);
  assert.equal(totalMax, 3);
  assert.equal(totalTests, 4);
});

test("loadBrownfieldManifest with root = repo root loads brownfield manifest, never classic", () => {
  const entries = loadBrownfieldManifest(ROOT);
  assert.equal(entries.length, 2);
  const files = entries.map((e) => e.file);
  assert.deepEqual(files, ["change-invariants.test.ts", "change-tie-break.test.ts"]);
  assert.ok(!files.includes("api-contract.test.ts"), "must never fall back to classic manifest");
});

// ---------------------------------------------------------------------------
// 3. Envelope validation and serialization
// ---------------------------------------------------------------------------

test("validateBrownfieldResult enforces brownfield schema and rubric format", () => {
  const validRubric = brownfieldRubricId(ROOT);
  const sampleResult: BrownfieldResult = {
    schemaVersion: 1,
    track: "brownfield",
    rubric: validRubric,
    attempt: "gemini-38-flash-high-attempt-1",
    image: "agrav-harness:latest@sha256:0123456789abcdef",
    runImage: "agrav-harness:latest@sha256:0123456789abcdef",
    testsCommit: "0123456789abcdef0123456789abcdef01234567",
    testsDirty: false,
    ungated: false,
    startedAt: new Date().toISOString(),
    durationMs: 12000,
    pipFreeze: ["fastapi==0.115.0"],
    warnings: [],
    boot: { ok: true, stage: null, detail: null },
    diagnosis: null,
    regression: { passed: 58, total: 58, score: 4.0, groups: [] },
    changeSuite: { passed: 4, total: 4, score: 3.0, groups: [] },
    diffLocality: { score: 1.0, outsideFiles: [], totalLines: 0 },
    pytest: {
      ran: true,
      timedOut: false,
      exitCode: 0,
      passed: 2,
      failed: 0,
      errors: 0,
      durationMs: 120,
      outputTail: "2 passed in 0.12s",
      notRunReason: null,
    },
  };

  validateBrownfieldResult(sampleResult);

  // Rejects missing pytest
  assert.throws(
    () => {
      const copy: any = { ...sampleResult };
      delete copy.pytest;
      validateBrownfieldResult(copy);
    },
    /missing pytest result/,
  );

  // Rejects missing timedOut
  assert.throws(
    () => {
      const copy: any = { ...sampleResult, pytest: { ...sampleResult.pytest } };
      delete copy.pytest.timedOut;
      validateBrownfieldResult(copy);
    },
    /pytest\.timedOut must be a boolean/,
  );

  // Rejects non-string notRunReason
  assert.throws(
    () => {
      const copy: any = { ...sampleResult, pytest: { ...sampleResult.pytest, notRunReason: 123 } };
      validateBrownfieldResult(copy);
    },
    /pytest\.notRunReason must be null or a string/,
  );

  // Rejects classic rubric
  assert.throws(
    () => validateBrownfieldResult({ ...sampleResult, rubric: "maintenance-console@e4feb1ee979a" }),
    /rubric must match/,
  );

  // Rejects wrong track
  assert.throws(() => validateBrownfieldResult({ ...sampleResult, track: "console-fuzz" }), /track must be "brownfield"/);
});

// ---------------------------------------------------------------------------
// 4. Scoring runner unit tests with fake dependencies
// ---------------------------------------------------------------------------

test("runBrownfieldContractTests handles backend stop at layout gracefully", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agrav-brownfield-runner-test-"));
  try {
    const attemptName = "test-model-attempt-1";
    const attemptDir = join(tempDir, "eval-attempts", attemptName);
    const resultsDir = join(tempDir, "eval-results", attemptName);
    cpSync(baseDir, attemptDir, { recursive: true });

    const fakeBackend = {
      checkLayout: () => ({ kind: "stop" as const, stage: "layout" as BootStage, detail: "missing backend/app/main.py" }),
      install: async () => ({ kind: "ready" as const }),
      pipFreeze: async () => [],
      start: async () => ({ kind: "ready" as const, baseUrl: "http://127.0.0.1:8000" }),
      servingState: async () => ({ kind: "running" as const }),
      stop: async () => ({ removed: true }),
      dispose: async () => {},
    };

    const outcome = await runBrownfieldContractTests(
      {
        attempt: attemptName,
        root: tempDir,
        attemptsDir: join(tempDir, "eval-attempts"),
        runJsonDir: join(tempDir, "eval-results"),
        ignoreRunJson: true,
        allowUngated: true,
        baseDir,
      },
      {
        createBackend: () => fakeBackend as any,
        image: () => ({ tag: "test:latest", ref: "test@sha256:abc", id: "sha256:abc" }),
        gate: () => ({ recorded: "abc", current: "abc" }),
        provenance: () => ({ testsCommit: "1234567890123456789012345678901234567890", testsDirty: false }),
        out: () => {},
      },
    );

    assert.equal(outcome.kind, "written");
    if (outcome.kind === "written") {
      assert.equal(outcome.result.boot.ok, false);
      assert.equal(outcome.result.boot.stage, "layout");
      assert.equal(outcome.result.regression.score, 0);
      assert.equal(outcome.result.changeSuite.score, 0);
      assert.equal(outcome.result.diffLocality.score, 0);
      assert.deepEqual(outcome.result.diffLocality.outsideFiles, []);
      assert.equal(outcome.result.diffLocality.totalLines, 0);
      assert.equal(outcome.result.pytest.ran, false);
      assert.equal(outcome.result.pytest.timedOut, false);
      assert.equal(outcome.result.pytest.exitCode, null);
      assert.equal(outcome.result.pytest.notRunReason, "backend stop");
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("mock responses of untouched base yield 0/3 on change suite", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agrav-brownfield-untouched-test-"));
  try {
    const attemptName = "untouched-base-attempt-1";
    const attemptDir = join(tempDir, "eval-attempts", attemptName);
    cpSync(baseDir, attemptDir, { recursive: true });

    const fakeBackend = {
      checkLayout: () => ({ kind: "ready" as const }),
      install: async () => ({ kind: "ready" as const }),
      pipFreeze: async () => ["fastapi==0.115.0"],
      start: async () => ({ kind: "ready" as const, baseUrl: "http://127.0.0.1:8000" }),
      servingState: async () => ({ kind: "running" as const }),
      stop: async () => ({ removed: true }),
      dispose: async () => {},
    };

    // Fake runFile simulating:
    // - Regression suite passing 58/58
    // - Change suite failing 0/3 on change-invariants and 0/1 on change-tie-break (untouched base lacks strategy)
    const runFileFake = async (opts: { file: string }): Promise<ContractFileResult> => {
      if (opts.file.endsWith("change-invariants.test.ts")) {
        return {
          file: opts.file,
          total: 3,
          passed: 0,
          failed: [
            { name: "test 1", failureType: "testCodeFailure", message: "technician_load missing" },
            { name: "test 2", failureType: "testCodeFailure", message: "technician_load missing" },
            { name: "test 3", failureType: "testCodeFailure", message: "technician_load missing" },
          ],
          hookFailed: 0,
          timedOut: false,
          notRun: 0,
        };
      }
      if (opts.file.endsWith("change-tie-break.test.ts")) {
        return {
          file: opts.file,
          total: 1,
          passed: 0,
          failed: [{ name: "tie-break", failureType: "testCodeFailure", message: "technician_load missing" }],
          hookFailed: 0,
          timedOut: false,
          notRun: 0,
        };
      }
      // Regression files pass
      const testCounts: Record<string, number> = {
        "api-contract.test.ts": 24,
        "planner-assignment.test.ts": 12,
        "planner-ordering.test.ts": 11,
        "planner-parts.test.ts": 11,
      };
      const baseName = opts.file.split("/").pop()!;
      const count = testCounts[baseName] ?? 1;
      return {
        file: opts.file,
        total: count,
        passed: count,
        failed: [],
        hookFailed: 0,
        timedOut: false,
        notRun: 0,
      };
    };

    const outcome = await runBrownfieldContractTests(
      {
        attempt: attemptName,
        root: tempDir,
        attemptsDir: join(tempDir, "eval-attempts"),
        runJsonDir: join(tempDir, "eval-results"),
        ignoreRunJson: true,
        allowUngated: true,
        baseDir,
      },
      {
        createBackend: () => fakeBackend as any,
        runFile: runFileFake,
        image: () => ({ tag: "test:latest", ref: "test@sha256:abc", id: "sha256:abc" }),
        gate: () => ({ recorded: "abc", current: "abc" }),
        provenance: () => ({ testsCommit: "1234567890123456789012345678901234567890", testsDirty: false }),
        out: () => {},
      },
    );

    assert.equal(outcome.kind, "written");
    if (outcome.kind === "written") {
      assert.equal(outcome.result.boot.ok, true);
      assert.equal(outcome.result.regression.passed, 58);
      assert.equal(outcome.result.regression.score, 4.0);
      assert.equal(outcome.result.changeSuite.passed, 0);
      assert.equal(outcome.result.changeSuite.total, 4);
      assert.equal(outcome.result.changeSuite.score, 0);
      assert.equal(outcome.result.diffLocality.score, 1.0);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("change suite invariant detects disconnected technician_load dictionary without actual order reassignment", () => {
  // Model returned balanced dictionary 480/480 but left all orders assigned to T-001 (cheating)
  const fakeBalancedRes = {
    technician_load: { "T-001": 480, "T-002": 480, "T-003": 0, "T-004": 0 },
    orders: [
      { id: "WO-001", status: "scheduled", technician_id: "T-001", duration_minutes: 240 },
      { id: "WO-002", status: "scheduled", technician_id: "T-001", duration_minutes: 240 },
      { id: "WO-003", status: "scheduled", technician_id: "T-001", duration_minutes: 240 },
      { id: "WO-004", status: "scheduled", technician_id: "T-001", duration_minutes: 240 },
    ],
  };

  const checkConsistency = (res: typeof fakeBalancedRes) => {
    for (const [techId, load] of Object.entries(res.technician_load)) {
      const orderMinutes = res.orders
        .filter((o) => o.status === "scheduled" && o.technician_id === techId)
        .reduce((sum, o) => sum + o.duration_minutes, 0);
      assert.equal(
        orderMinutes,
        load,
        `technician_load[${techId}] (${load}) must match sum of scheduled order duration_minutes (${orderMinutes})`,
      );
    }
  };

  assert.throws(
    () => checkConsistency(fakeBalancedRes),
    /technician_load\[T-001\] \(480\) must match sum of scheduled order duration_minutes \(960\)/,
  );
});

// ---------------------------------------------------------------------------
// 5. Positive control reference patch test
// ---------------------------------------------------------------------------

test("positive control balanced.patch applies cleanly to base and has locality > 0", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agrav-patch-test-"));
  try {
    cpSync(baseDir, tempDir, { recursive: true });

    // Test git apply
    const applyRes = spawnSync("git", ["apply", "--check", solutionPatch], {
      cwd: tempDir,
      encoding: "utf8",
    });
    assert.equal(
      applyRes.status,
      0,
      `balanced.patch must apply cleanly with git apply --check: ${applyRes.stderr}`,
    );

    // Actually apply the patch to tempDir
    const applyReal = spawnSync("git", ["apply", solutionPatch], {
      cwd: tempDir,
      encoding: "utf8",
    });
    assert.equal(applyReal.status, 0, `applying balanced.patch failed: ${applyReal.stderr}`);

    // Diff locality of patched base against original base
    const locality = computeDiffLocality(tempDir, baseDir);
    assert.equal(locality.outsideFiles.length, 0, "positive control modifies only allowed files");
    assert.ok(locality.score > 0, `diff locality score must be > 0, got ${locality.score}`);
    assert.ok(locality.totalLines < 500, `total lines changed (${locality.totalLines}) must be < 500`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("positive control balanced.patch parses as Python 3.11 and imports app.planner with system python3", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agrav-patch-import-test-"));
  try {
    cpSync(baseDir, tempDir, { recursive: true });

    // Apply the reference patch
    const applyReal = spawnSync("git", ["apply", solutionPatch], {
      cwd: tempDir,
      encoding: "utf8",
    });
    assert.equal(applyReal.status, 0, `applying balanced.patch failed: ${applyReal.stderr}`);

    // 1. Verify AST parsing of all 3 modified files as Python 3.11 (the harness's version)
    for (const file of ["app/planner.py", "app/routes.py", "app/schemas.py"]) {
      const parseResult = spawnSync(
        "python3",
        ["-c", "import ast, sys; ast.parse(open(sys.argv[1]).read(), feature_version=(3, 11))", file],
        {
          cwd: join(tempDir, "backend"),
          encoding: "utf8",
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
        },
      );
      assert.equal(parseResult.status, 0, `ast.parse failed for ${file}: ${parseResult.stderr}`);
    }

    // 2. Import app.planner (depends only on stdlib and app.store, catches NameError in plan_week signature)
    const importResult = spawnSync(
      "python3",
      ["-c", "import app.planner; print('PLANNER_OK')"],
      {
        cwd: join(tempDir, "backend"),
        encoding: "utf8",
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      },
    );
    assert.equal(importResult.status, 0, `importing app.planner failed: ${importResult.stderr}`);
    assert.match(importResult.stdout, /PLANNER_OK/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("runBrownfieldContractTests runs pytest after hidden tests and records result", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agrav-bf-pytest-test-"));
  try {
    const attemptName = "pytest-model-attempt-1";
    const attemptDir = join(tempDir, "eval-attempts", attemptName);
    cpSync(baseDir, attemptDir, { recursive: true });

    let pytestCalled = false;
    const fakeBackend = {
      checkLayout: () => ({ kind: "ready" as const }),
      install: async () => ({ kind: "ready" as const }),
      pipFreeze: async () => ["fastapi==0.115.0", "pytest==8.3.3"],
      start: async () => ({ kind: "ready" as const, baseUrl: "http://127.0.0.1:8000" }),
      servingState: async () => ({ kind: "running" as const }),
      stop: async () => ({ removed: true }),
      dispose: async () => {},
      runPytest: async () => {
        pytestCalled = true;
        return {
          kind: "complete" as const,
          result: {
            ran: true,
            timedOut: false,
            exitCode: 0,
            passed: 4,
            failed: 0,
            errors: 0,
            durationMs: 450,
            outputTail: "4 passed in 0.45s",
            notRunReason: null,
          },
        };
      },
    };

    const outcome = await runBrownfieldContractTests(
      {
        attempt: attemptName,
        root: tempDir,
        attemptsDir: join(tempDir, "eval-attempts"),
        runJsonDir: join(tempDir, "eval-results"),
        ignoreRunJson: true,
        allowUngated: true,
        baseDir,
      },
      {
        createBackend: () => fakeBackend as any,
        runFile: async (opts) => ({ file: opts.file, total: opts.expectedTests, passed: opts.expectedTests, failed: [], notRun: 0, hookFailed: 0, timedOut: false }),
        image: () => ({ tag: "test:latest", ref: "test@sha256:abc", id: "sha256:abc" }),
        gate: () => ({ recorded: "abc", current: "abc" }),
        provenance: () => ({ testsCommit: "1234567890123456789012345678901234567890", testsDirty: false }),
        out: () => {},
      },
    );

    assert.equal(outcome.kind, "written");
    assert.equal(pytestCalled, true);
    if (outcome.kind === "written") {
      assert.deepEqual(outcome.result.pytest, {
        ran: true,
        timedOut: false,
        exitCode: 0,
        passed: 4,
        failed: 0,
        errors: 0,
        durationMs: 450,
        outputTail: "4 passed in 0.45s",
        notRunReason: null,
      });
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("classic and hard contract tests never call runPytest", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agrav-classic-hard-no-pytest-"));
  try {
    const attemptName = "check-attempt-1";
    const attemptDir = join(tempDir, "eval-attempts", attemptName);
    mkdirSync(attemptDir, { recursive: true });

    let classicPytestCalled = false;
    let hardPytestCalled = false;

    const fakeBackendClassic = {
      checkLayout: () => ({ kind: "stop" as const, stage: "layout" as BootStage, detail: "stop" }),
      install: async () => ({ kind: "ready" as const }),
      pipFreeze: async () => [],
      start: async () => ({ kind: "ready" as const, baseUrl: "http://127.0.0.1:8000" }),
      servingState: async () => ({ kind: "running" as const }),
      stop: async () => ({ removed: true }),
      dispose: async () => {},
      runPytest: async () => { classicPytestCalled = true; },
    };

    const fakeBackendHard = {
      checkLayout: () => ({ kind: "stop" as const, stage: "layout" as BootStage, detail: "stop" }),
      install: async () => ({ kind: "ready" as const }),
      pipFreeze: async () => [],
      start: async () => ({ kind: "ready" as const, baseUrl: "http://127.0.0.1:8000" }),
      servingState: async () => ({ kind: "running" as const }),
      stop: async () => ({ removed: true }),
      dispose: async () => {},
      runPytest: async () => { hardPytestCalled = true; },
    };

    const { runContractTests } = await import("../scripts/contract-tests.js");
    const { runHardContractTests } = await import("../scripts/contract-tests-hard.js");

    await runContractTests(
      {
        attempt: attemptName,
        root: tempDir,
        ignoreRunJson: true,
        allowUngated: true,
      },
      {
        createBackend: () => fakeBackendClassic as any,
        image: () => ({ tag: "t", ref: "r", id: "i" }),
        gate: () => ({ recorded: "a", current: "a" }),
        provenance: () => ({ testsCommit: "a", testsDirty: false }),
        out: () => {},
      },
    );

    await runHardContractTests(
      {
        attempt: attemptName,
        root: tempDir,
        attemptsDir: join(tempDir, "eval-attempts"),
        runJsonDir: join(tempDir, "eval-results"),
        ignoreRunJson: true,
        allowUngated: true,
      },
      {
        createBackend: () => fakeBackendHard as any,
        image: () => ({ tag: "t", ref: "r", id: "i" }),
        gate: () => ({ recorded: "a", current: "a" }),
        provenance: () => ({ testsCommit: "a", testsDirty: false }),
        out: () => {},
      },
    );

    assert.equal(classicPytestCalled, false, "classic contract-tests must never call runPytest");
    assert.equal(hardPytestCalled, false, "hard contract-tests must never call runPytest");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});


