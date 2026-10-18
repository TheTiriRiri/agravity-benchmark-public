/**
 * Tests for the orchestration logic in scripts/score-hard.ts that can be
 * exercised without spawning processes: attempt classification (refuse /
 * model-failure / normal), frontend-stop reasoning, cell assembly.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RunJson } from "../scripts/lib/run-json";
import type { RowCell } from "../scripts/lib/hard-score";
import {
  classifyAttempt,
  frontendStopReason,
  assembleCells,
} from "../scripts/score-hard";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Minimal valid RunJson with overrides. */
function fakeRun(overrides: Partial<RunJson> = {}): RunJson {
  return {
    id: "test-1",
    model: "test",
    effort: null,
    agyVersion: "1.0.0",
    image: "img@sha",
    startedAt: "2026-10-08T07:00:00.000Z",
    durationMs: 60_000,
    exitCode: 0,
    envelope: null,
    stderrTail: "",
    softDenied: false,
    failureKind: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// classifyAttempt
// ---------------------------------------------------------------------------

describe("classifyAttempt", () => {
  it("normal attempt returns 'normal'", () => {
    assert.equal(classifyAttempt(fakeRun()).kind, "normal");
  });
  it("infra failure is refused", () => {
    const c = classifyAttempt(fakeRun({ failureKind: "infra" }));
    assert.equal(c.kind, "refuse");
    assert.match(c.reason, /infra/);
  });
  it("softDenied is refused", () => {
    const c = classifyAttempt(fakeRun({ softDenied: true }));
    assert.equal(c.kind, "refuse");
    assert.match(c.reason, /soft.deny|softDenied|denied/i);
  });
  it("model failure returns 'model-failure' with error from envelope", () => {
    const c = classifyAttempt(fakeRun({ failureKind: "model", envelope: { status: "error", error: "exceeded output token limit", num_turns: 1, duration_seconds: 60, usage: null, conversation_id: null, responseTail: null } }));
    assert.equal(c.kind, "model-failure");
    assert.match(c.reason, /exceeded output token limit/);
  });
  it("model failure falls back to stderrTail when envelope.error is empty", () => {
    const c = classifyAttempt(fakeRun({ failureKind: "model", envelope: { status: "error", error: "", num_turns: 1, duration_seconds: 60, usage: null, conversation_id: null, responseTail: null }, stderrTail: "stream interrupted" }));
    assert.equal(c.kind, "model-failure");
    assert.match(c.reason, /stream interrupted/);
  });
  it("model failure falls back to generic when both are empty", () => {
    const c = classifyAttempt(fakeRun({ failureKind: "model" }));
    assert.equal(c.kind, "model-failure");
    assert.ok(c.reason.length > 0);
  });
});

// ---------------------------------------------------------------------------
// frontendStopReason
// ---------------------------------------------------------------------------

describe("frontendStopReason", () => {
  it("null when frontend ok and url is 5173", () => {
    assert.equal(frontendStopReason("ok", "http://localhost:5173/"), null);
  });
  it("stop when frontend is not ok", () => {
    const r = frontendStopReason("stop: npm install failed", null);
    assert.ok(r !== null);
    assert.match(r, /npm install failed/);
  });
  it("stop when url is not on 5173", () => {
    const r = frontendStopReason("ok", "http://localhost:3000/");
    assert.ok(r !== null);
    assert.match(r, /not on 5173/);
  });
  it("stop when url is null (no dev server)", () => {
    const r = frontendStopReason("ok", null);
    assert.ok(r !== null);
  });
});

// ---------------------------------------------------------------------------
// assembleCells
// ---------------------------------------------------------------------------

describe("assembleCells", () => {
  it("assembles cells from test results and heuristics", () => {
    const testRows = [
      { row: "API contract", file: "api-contract.test.ts", passed: 25, total: 29, max: 2, score: 1.72 },
      { row: "Frontend E2E: flows", file: "flows.spec.ts", passed: 3, total: 10, max: 2, score: 0.6 },
    ];
    const heuristics = {
      codeStructure: { score: 1, notes: "heuristic (not judged): all found" },
      techStack: { score: 1, notes: "heuristic (not judged): all found" },
      selfVerification: { score: 0, notes: "heuristic (not judged): 0 model-written tests found" },
    };
    const cells = assembleCells(testRows, heuristics, { backend: null, frontend: null });
    assert.equal(cells.get("API contract")!.score, 1.72);
    assert.equal(cells.get("API contract")!.notes, "25 of 29 passed");
    assert.equal(cells.get("Frontend E2E: flows")!.score, 0.6);
    assert.equal(cells.get("Local build")!.score, 1);
    assert.equal(cells.get("Code structure")!.score, 1);
    assert.equal(cells.get("Visual design")!.score, 0);
    assert.match(cells.get("Visual design")!.notes, /default|not human/i);
    assert.equal(cells.get("Penalty")!.score, 0);
    assert.match(cells.get("Penalty")!.notes, /no.*judge|not assessed/i);
  });
  it("applies backend stop", () => {
    const cells = assembleCells([], {
      codeStructure: { score: 1, notes: "x" },
      techStack: { score: 1, notes: "x" },
      selfVerification: { score: 0, notes: "x" },
    }, { backend: "stop:boot: exited", frontend: null });
    assert.equal(cells.get("API contract")!.score, 0);
    assert.equal(cells.get("Self-verification")!.score, 0);
    assert.equal(cells.get("Code structure")!.score, 1);
  });
  it("applies frontend stop from build failure", () => {
    const cells = assembleCells([], {
      codeStructure: { score: 1, notes: "x" },
      techStack: { score: 1, notes: "x" },
      selfVerification: { score: 0, notes: "x" },
    }, { backend: null, frontend: "stop: npm run build failed" });
    assert.equal(cells.get("Local build")!.score, 0);
    assert.equal(cells.get("Frontend E2E: flows")!.score, 0);
    assert.equal(cells.get("Visual design")!.score, 0);
    // Contract rows are unaffected by a frontend-only stop
    assert.equal(cells.get("Code structure")!.score, 1);
  });
  it("both stops give all-zero", () => {
    const cells = assembleCells([], {
      codeStructure: { score: 1, notes: "x" },
      techStack: { score: 1, notes: "x" },
      selfVerification: { score: 1, notes: "x" },
    }, { backend: "a", frontend: "b" });
    assert.ok([...cells.values()].every((c) => c.score === 0));
  });
});

import type { ManifestEntry } from "../scripts/lib/hard-score";
import { completeHiddenRows } from "../scripts/score-hard";

// ---------------------------------------------------------------------------
// completeHiddenRows
// ---------------------------------------------------------------------------

describe("completeHiddenRows", () => {
  const contractManifest: ManifestEntry[] = [
    { file: "api-contract.test.ts", row: "API contract", max: 2, tests: 29 },
    { file: "planner-assignment.test.ts", row: "Planner: assignment rules", max: 2, tests: 12 },
    { file: "planner-ordering.test.ts", row: "Planner: ordering & determinism", max: 1, tests: 11 },
    { file: "planner-parts.test.ts", row: "Planner: parts & blocking", max: 2, tests: 11 },
    { file: "planner-crews-travel.test.ts", row: "Planner: crews & travel", max: 2, tests: 10 },
    { file: "planner-split-preempt.test.ts", row: "Planner: splitting & preemption", max: 2, tests: 13 },
  ];
  const e2eManifest: ManifestEntry[] = [
    { file: "flows.spec.ts", row: "Frontend E2E: flows", max: 2, tests: 10 },
    { file: "layout.spec.ts", row: "Frontend E2E: layout & a11y", max: 1, tests: 8 },
  ];

  it("backend stop with frontend ok produces all 8 hidden rows", () => {
    // Only contract rows were skipped (backend stop), E2E also skipped because no backend
    const testRows: { row: string; file: string; passed: number; total: number; max: number; score: number }[] = [];
    const rows = completeHiddenRows(testRows, contractManifest, e2eManifest);
    assert.equal(rows.length, 8);
    assert.ok(rows.every((r) => r.passed === 0 && r.score === 0));
    assert.deepEqual(rows.map((r) => r.row), [
      "API contract", "Planner: assignment rules", "Planner: ordering & determinism",
      "Planner: parts & blocking", "Planner: crews & travel", "Planner: splitting & preemption",
      "Frontend E2E: flows", "Frontend E2E: layout & a11y",
    ]);
  });

  it("frontend stop with backend ok keeps contract results and fills E2E zeros", () => {
    const testRows = [
      { row: "API contract", file: "api-contract.test.ts", passed: 25, total: 29, max: 2, score: 1.72 },
      { row: "Planner: assignment rules", file: "planner-assignment.test.ts", passed: 10, total: 12, max: 2, score: 1.67 },
      { row: "Planner: ordering & determinism", file: "planner-ordering.test.ts", passed: 11, total: 11, max: 1, score: 1 },
      { row: "Planner: parts & blocking", file: "planner-parts.test.ts", passed: 8, total: 11, max: 2, score: 1.45 },
      { row: "Planner: crews & travel", file: "planner-crews-travel.test.ts", passed: 5, total: 10, max: 2, score: 1 },
      { row: "Planner: splitting & preemption", file: "planner-split-preempt.test.ts", passed: 7, total: 13, max: 2, score: 1.08 },
    ];
    const rows = completeHiddenRows(testRows, contractManifest, e2eManifest);
    assert.equal(rows.length, 8);
    // Contract rows preserved from testRows
    assert.equal(rows[0]!.passed, 25);
    assert.equal(rows[0]!.score, 1.72);
    // E2E rows filled with zeros
    assert.equal(rows[6]!.row, "Frontend E2E: flows");
    assert.equal(rows[6]!.passed, 0);
    assert.equal(rows[6]!.score, 0);
    assert.equal(rows[7]!.row, "Frontend E2E: layout & a11y");
    assert.equal(rows[7]!.passed, 0);
  });

  it("all rows present when both contract and E2E ran", () => {
    const testRows = [
      { row: "API contract", file: "api-contract.test.ts", passed: 29, total: 29, max: 2, score: 2 },
      { row: "Planner: assignment rules", file: "planner-assignment.test.ts", passed: 12, total: 12, max: 2, score: 2 },
      { row: "Planner: ordering & determinism", file: "planner-ordering.test.ts", passed: 11, total: 11, max: 1, score: 1 },
      { row: "Planner: parts & blocking", file: "planner-parts.test.ts", passed: 11, total: 11, max: 2, score: 2 },
      { row: "Planner: crews & travel", file: "planner-crews-travel.test.ts", passed: 10, total: 10, max: 2, score: 2 },
      { row: "Planner: splitting & preemption", file: "planner-split-preempt.test.ts", passed: 13, total: 13, max: 2, score: 2 },
      { row: "Frontend E2E: flows", file: "flows.spec.ts", passed: 8, total: 10, max: 2, score: 1.6 },
      { row: "Frontend E2E: layout & a11y", file: "layout.spec.ts", passed: 7, total: 8, max: 1, score: 0.88 },
    ];
    const rows = completeHiddenRows(testRows, contractManifest, e2eManifest);
    assert.equal(rows.length, 8);
    assert.equal(rows[6]!.score, 1.6);
    assert.equal(rows[7]!.score, 0.88);
  });
});
