import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseHardHiddenResults,
  parseNodeTapFailedNames,
  parsePlaywrightJsonFailedNames,
} from "../scripts/lib/hard-score";

// ---------------------------------------------------------------------------
// parseNodeTapFailedNames
// ---------------------------------------------------------------------------

describe("parseNodeTapFailedNames", () => {
  it("extracts failed top-level test names from TAP output", () => {
    const tap = [
      "TAP version 13",
      "ok 1 - GET /api/v1/orders returns 200",
      "not ok 2 - POST /api/v1/orders validates body",
      "ok 3 - PATCH /api/v1/orders/:id transitions status",
      "not ok 4 - POST /api/v1/plan rejects empty orders",
      "ok 5 - POST /reset clears state",
      "# tests 5",
      "# pass 3",
      "# fail 2",
    ].join("\n");
    assert.deepEqual(parseNodeTapFailedNames(tap), [
      "POST /api/v1/orders validates body",
      "POST /api/v1/plan rejects empty orders",
    ]);
  });

  it("ignores indented (sub-test) not-ok lines", () => {
    const tap = [
      "TAP version 13",
      "not ok 1 - top level failing test",
      "    not ok 1 - nested sub-test should be ignored",
      "    ok 2 - nested passing sub-test",
      "ok 2 - top level passing test",
      "# tests 2",
      "# pass 1",
      "# fail 1",
    ].join("\n");
    assert.deepEqual(parseNodeTapFailedNames(tap), [
      "top level failing test",
    ]);
  });

  it("returns empty array when all tests pass", () => {
    const tap = [
      "TAP version 13",
      "ok 1 - test A",
      "ok 2 - test B",
      "# tests 2",
      "# pass 2",
      "# fail 0",
    ].join("\n");
    assert.deepEqual(parseNodeTapFailedNames(tap), []);
  });

  it("returns empty array for empty output", () => {
    assert.deepEqual(parseNodeTapFailedNames(""), []);
  });
});

// ---------------------------------------------------------------------------
// parsePlaywrightJsonFailedNames
// ---------------------------------------------------------------------------

describe("parsePlaywrightJsonFailedNames", () => {
  it("extracts failed spec titles from Playwright JSON report", () => {
    const report = {
      stats: { expected: 2, unexpected: 1, flaky: 0, skipped: 0 },
      suites: [{
        title: "flows",
        specs: [
          { title: "navigates to orders", tests: [{ results: [{ status: "expected" }] }] },
          { title: "creates an order", tests: [{ results: [{ status: "expected" }] }] },
          { title: "shows validation errors", tests: [{ results: [{ status: "unexpected" }] }] },
        ],
        suites: [],
      }],
    };
    assert.deepEqual(parsePlaywrightJsonFailedNames(JSON.stringify(report)), [
      "shows validation errors",
    ]);
  });

  it("handles nested suites", () => {
    const report = {
      stats: { expected: 1, unexpected: 1, flaky: 0, skipped: 0 },
      suites: [{
        title: "outer",
        specs: [],
        suites: [{
          title: "inner",
          specs: [
            { title: "passes", tests: [{ results: [{ status: "passed" }] }] },
            { title: "fails", tests: [{ results: [{ status: "unexpected" }] }] },
          ],
        }],
      }],
    };
    assert.deepEqual(parsePlaywrightJsonFailedNames(JSON.stringify(report)), [
      "fails",
    ]);
  });

  it("considers 'passed' as passing too", () => {
    const report = {
      suites: [{
        title: "test",
        specs: [
          { title: "spec1", tests: [{ results: [{ status: "passed" }] }] },
        ],
      }],
    };
    assert.deepEqual(parsePlaywrightJsonFailedNames(JSON.stringify(report)), []);
  });

  it("returns empty array for invalid JSON", () => {
    assert.deepEqual(parsePlaywrightJsonFailedNames("not json"), []);
  });

  it("returns empty array when all pass", () => {
    const report = {
      suites: [{
        title: "suite",
        specs: [
          { title: "a", tests: [{ results: [{ status: "expected" }] }] },
          { title: "b", tests: [{ results: [{ status: "expected" }] }] },
        ],
      }],
    };
    assert.deepEqual(parsePlaywrightJsonFailedNames(JSON.stringify(report)), []);
  });
});

// ---------------------------------------------------------------------------
// parseHardHiddenResults — backwards compatibility
// ---------------------------------------------------------------------------

describe("parseHardHiddenResults with failed field", () => {
  const base = {
    schemaVersion: 1,
    attempt: "a-attempt-1",
    rubric: "maintenance-console-hard@0123456789ab",
    scoredAt: "2026-10-08T07:00:00.000Z",
    backend: "ok",
    frontend: "ok",
  };

  it("accepts rows without failed (old files)", () => {
    const r = { ...base, rows: [{ row: "API contract", file: "api-contract.test.ts", passed: 29, total: 29, max: 2, score: 2 }] };
    const parsed = parseHardHiddenResults(JSON.stringify(r));
    assert.equal(parsed.rows[0].failed, undefined);
  });

  it("accepts rows with failed present", () => {
    const r = {
      ...base,
      rows: [{
        row: "API contract", file: "api-contract.test.ts",
        passed: 28, total: 29, max: 2, score: 1.93,
        failed: ["POST /api/v1/orders validates body"],
      }],
    };
    const parsed = parseHardHiddenResults(JSON.stringify(r));
    assert.deepEqual(parsed.rows[0].failed, ["POST /api/v1/orders validates body"]);
  });

  it("rejects rows with failed as non-array", () => {
    const r = {
      ...base,
      rows: [{
        row: "API contract", file: "api-contract.test.ts",
        passed: 28, total: 29, max: 2, score: 1.93,
        failed: "not an array",
      }],
    };
    assert.throws(() => parseHardHiddenResults(JSON.stringify(r)), /string array/);
  });

  it("rejects rows with non-string elements in failed", () => {
    const r = {
      ...base,
      rows: [{
        row: "API contract", file: "api-contract.test.ts",
        passed: 28, total: 29, max: 2, score: 1.93,
        failed: ["valid string", 42],
      }],
    };
    assert.throws(() => parseHardHiddenResults(JSON.stringify(r)), /must be strings/);
  });
});

describe("parseHardHiddenResults with warnings field", () => {
  const base = {
    schemaVersion: 1,
    attempt: "a-attempt-1",
    rubric: "maintenance-console-hard@0123456789ab",
    scoredAt: "2026-10-08T07:00:00.000Z",
    backend: "ok",
    frontend: "ok",
    rows: [{ row: "API contract", file: "api-contract.test.ts", passed: 29, total: 29, max: 2, score: 2 }],
  };

  it("accepts a file without warnings (scored before they were recorded)", () => {
    const parsed = parseHardHiddenResults(JSON.stringify(base));
    assert.equal(parsed.warnings, undefined);
    assert.deepEqual(parsed, base);
  });

  it("accepts warnings empty or present", () => {
    assert.deepEqual(parseHardHiddenResults(JSON.stringify({ ...base, warnings: [] })).warnings, []);
    const warning = "the backend container exited with code 137 during planner-assignment.test.ts, so the tests after that ran against no backend (the backend crashed, or the host killed it)";
    assert.deepEqual(parseHardHiddenResults(JSON.stringify({ ...base, warnings: [warning] })).warnings, [warning]);
  });

  it("rejects warnings as non-array", () => {
    assert.throws(() => parseHardHiddenResults(JSON.stringify({ ...base, warnings: "exited" })), /warnings must be a string array/);
  });

  it("rejects non-string elements in warnings", () => {
    assert.throws(() => parseHardHiddenResults(JSON.stringify({ ...base, warnings: ["exited", 137] })), /warnings elements must be strings/);
  });
});
