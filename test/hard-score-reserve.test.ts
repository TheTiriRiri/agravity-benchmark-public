import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyReserveStop } from "../scripts/lib/hard-score";
import { assembleCells, completeHiddenRows, type TestRowResult } from "../scripts/score-hard";

describe("classifyReserveStop", () => {
  it("returns null when backend came up both times", () => {
    assert.equal(classifyReserveStop(true, true, "ok"), null);
  });

  it("returns failure note when backend ok first, not ok second", () => {
    const result = classifyReserveStop(true, false, "stop:boot: exited 1");
    assert.notEqual(result, null);
    assert.match(result!, /stop:boot: exited 1/);
    assert.match(result!, /not when served/);
  });

  it("returns null when first backend was not ok (not our case)", () => {
    assert.equal(classifyReserveStop(false, false, "stop:boot: exited 1"), null);
  });

  it("returns null when first was not ok but second is ok", () => {
    assert.equal(classifyReserveStop(false, true, "ok"), null);
  });
});

describe("assembleCells with e2eBackendNote", () => {
  const heuristics = {
    codeStructure: { score: 1, notes: "ok" },
    techStack: { score: 1, notes: "ok" },
    selfVerification: { score: 1, notes: "ok" },
  };

  const contractRows: TestRowResult[] = [
    { row: "API contract", file: "api-contract.test.ts", passed: 29, total: 29, max: 2, score: 2 },
    { row: "Planner: assignment rules", file: "planner-assignment.test.ts", passed: 12, total: 12, max: 2, score: 2 },
    { row: "Planner: ordering & determinism", file: "planner-ordering.test.ts", passed: 11, total: 11, max: 1, score: 1 },
    { row: "Planner: parts & blocking", file: "planner-parts.test.ts", passed: 11, total: 11, max: 2, score: 2 },
    { row: "Planner: crews & travel", file: "planner-crews-travel.test.ts", passed: 10, total: 10, max: 2, score: 2 },
    { row: "Planner: splitting & preemption", file: "planner-split-preempt.test.ts", passed: 13, total: 13, max: 2, score: 2 },
  ];

  it("without e2eBackendNote, E2E rows come from test data", () => {
    const testRows: TestRowResult[] = [
      ...contractRows,
      { row: "Frontend E2E: flows", file: "flows.spec.ts", passed: 10, total: 10, max: 2, score: 2 },
      { row: "Frontend E2E: layout & a11y", file: "layout.spec.ts", passed: 8, total: 8, max: 1, score: 1 },
    ];
    const cells = assembleCells(testRows, heuristics, { backend: null, frontend: null });
    assert.equal(cells.get("Frontend E2E: flows")!.score, 2);
    assert.equal(cells.get("Frontend E2E: layout & a11y")!.score, 1);
  });

  it("with e2eBackendNote, Frontend E2E: flows is zeroed but layout keeps its score", () => {
    // When the served backend fails, only flows is zeroed. Layout still runs and is scored.
    const testRows: TestRowResult[] = [
      ...contractRows,
      // layout was run normally (frontend still works)
      { row: "Frontend E2E: layout & a11y", file: "layout.spec.ts", passed: 7, total: 8, max: 1, score: 0.88 },
    ];
    const note = "backend booted for hidden tests but not when served: stop:boot: exited 1";
    const cells = assembleCells(testRows, heuristics, { backend: null, frontend: null }, note);
    // flows zeroed with the note
    assert.equal(cells.get("Frontend E2E: flows")!.score, 0);
    assert.equal(cells.get("Frontend E2E: flows")!.notes, note);
    // layout scored normally, not zeroed
    assert.equal(cells.get("Frontend E2E: layout & a11y")!.score, 0.88);
    // Local build stays 1 (no backend/frontend stop)
    assert.equal(cells.get("Local build")!.score, 1);
    // Contract rows unchanged
    assert.equal(cells.get("API contract")!.score, 2);
    assert.equal(cells.get("Planner: assignment rules")!.score, 2);
  });

  it("with e2eBackendNote null, behaves like no argument", () => {
    const testRows: TestRowResult[] = [
      ...contractRows,
      { row: "Frontend E2E: flows", file: "flows.spec.ts", passed: 8, total: 10, max: 2, score: 1.6 },
      { row: "Frontend E2E: layout & a11y", file: "layout.spec.ts", passed: 8, total: 8, max: 1, score: 1 },
    ];
    const cells = assembleCells(testRows, heuristics, { backend: null, frontend: null }, null);
    assert.equal(cells.get("Frontend E2E: flows")!.score, 1.6);
  });
});

describe("completeHiddenRows with e2eBackendNote", () => {
  const contractManifest = [
    { file: "api-contract.test.ts", row: "API contract", max: 2, tests: 29 },
  ];
  const e2eManifest = [
    { file: "flows.spec.ts", row: "Frontend E2E: flows", max: 2, tests: 10 },
    { file: "layout.spec.ts", row: "Frontend E2E: layout & a11y", max: 1, tests: 8 },
  ];

  it("without e2eBackendNote, missing flows has no failed field", () => {
    const testRows: TestRowResult[] = [
      { row: "API contract", file: "api-contract.test.ts", passed: 29, total: 29, max: 2, score: 2 },
      { row: "Frontend E2E: layout & a11y", file: "layout.spec.ts", passed: 8, total: 8, max: 1, score: 1 },
    ];
    const completed = completeHiddenRows(testRows, contractManifest, e2eManifest);
    const flows = completed.find((r) => r.row === "Frontend E2E: flows")!;
    assert.equal(flows.score, 0);
    assert.equal(flows.failed, undefined);
  });

  it("with e2eBackendNote, missing flows carries 'not run: <note>' in failed", () => {
    const note = "backend booted for hidden tests but not when served: stop:boot: exited 1";
    const testRows: TestRowResult[] = [
      { row: "API contract", file: "api-contract.test.ts", passed: 29, total: 29, max: 2, score: 2 },
      { row: "Frontend E2E: layout & a11y", file: "layout.spec.ts", passed: 7, total: 8, max: 1, score: 0.88 },
    ];
    const completed = completeHiddenRows(testRows, contractManifest, e2eManifest, note);
    const flows = completed.find((r) => r.row === "Frontend E2E: flows")!;
    assert.equal(flows.score, 0);
    assert.deepEqual(flows.failed, [`not run: ${note}`]);
    // layout keeps its actual result
    const layout = completed.find((r) => r.row === "Frontend E2E: layout & a11y")!;
    assert.equal(layout.score, 0.88);
  });
});
