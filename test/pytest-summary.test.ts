import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parsePytestSummary } from "../scripts/lib/pytest-summary";

describe("parsePytestSummary", () => {
  it("parses all passed format: '3 passed in 0.12s'", () => {
    const output = "...\n3 passed in 0.12s\n";
    assert.deepEqual(parsePytestSummary(output), { passed: 3, failed: 0, errors: 0 });
  });

  it("parses mixed failed, passed, error format: '1 failed, 2 passed, 1 error in 0.30s'", () => {
    const output = "FAILED tests/test_planner.py::test_fail\n1 failed, 2 passed, 1 error in 0.30s\n";
    assert.deepEqual(parsePytestSummary(output), { passed: 2, failed: 1, errors: 1 });
  });

  it("parses no tests ran format: 'no tests ran in 0.01s'", () => {
    const output = "no tests ran in 0.01s\n";
    assert.deepEqual(parsePytestSummary(output), { passed: 0, failed: 0, errors: 0 });
  });

  it("parses errors only format: '2 errors in 0.05s'", () => {
    const output = "ERROR collecting tests/test_bad.py\n2 errors in 0.05s\n";
    assert.deepEqual(parsePytestSummary(output), { passed: 0, failed: 0, errors: 2 });
  });

  it("parses output with warnings and equal signs: '=== 1 failed, 2 passed, 1 error, 3 warnings in 0.30s ==='", () => {
    const output = "=== 1 failed, 2 passed, 1 error, 3 warnings in 0.30s ===\n";
    assert.deepEqual(parsePytestSummary(output), { passed: 2, failed: 1, errors: 1 });
  });

  it("returns zeros on completely empty or non-summary output", () => {
    assert.deepEqual(parsePytestSummary(""), { passed: 0, failed: 0, errors: 0 });
    assert.deepEqual(parsePytestSummary("some random text\n"), { passed: 0, failed: 0, errors: 0 });
  });
});
