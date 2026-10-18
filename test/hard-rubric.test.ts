import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  HARD_HIDDEN_ROWS,
  HARD_RUBRIC_MAX,
  HARD_RUBRIC_ROWS,
  hardRubricId,
} from "../scripts/lib/hard-rubric";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const criteriaPath = join(ROOT, "tracks", "console-hard", "benchmark", "criteria.md");
const manifestPath = join(ROOT, "tracks", "console-hard", "benchmark", "contract-tests", "manifest.json");

test("HARD_RUBRIC_ROWS defines the 16 hard track rows with maxima and scorers", () => {
  assert.deepEqual(
    HARD_RUBRIC_ROWS.map((r) => [r.name, r.max, r.scoredBy]),
    [
      ["Task completion time", null, "auto"],
      ["Test run", null, "auto"],
      ["Local build", 1, "auto"],
      ["API contract", 2, "hidden"],
      ["Planner: assignment rules", 2, "hidden"],
      ["Planner: ordering & determinism", 1, "hidden"],
      ["Planner: parts & blocking", 2, "hidden"],
      ["Planner: crews & travel", 2, "hidden"],
      ["Planner: splitting & preemption", 2, "hidden"],
      ["Frontend E2E: flows", 2, "hidden"],
      ["Frontend E2E: layout & a11y", 1, "hidden"],
      ["Code structure", 1, "agent"],
      ["Tech stack & run contract", 1, "agent"],
      ["Self-verification", 1, "agent"],
      ["Visual design", 1, "human"],
      ["Penalty", null, "penalty"],
    ],
  );
  assert.equal(HARD_RUBRIC_ROWS.length, 16);
  assert.equal(new Set(HARD_RUBRIC_ROWS.map((r) => r.name)).size, 16, "row names are unique");
});

test("the hard maxima sum to HARD_RUBRIC_MAX = 19", () => {
  assert.equal(HARD_RUBRIC_MAX, 19);
  assert.equal(HARD_RUBRIC_ROWS.reduce((sum, r) => sum + (r.max ?? 0), 0), HARD_RUBRIC_MAX);
});

test("HARD_HIDDEN_ROWS matches the 8 hidden rows with max 14", () => {
  assert.deepEqual(HARD_HIDDEN_ROWS, HARD_RUBRIC_ROWS.filter((r) => r.scoredBy === "hidden"));
  assert.equal(HARD_HIDDEN_ROWS.length, 8);
  assert.equal(HARD_HIDDEN_ROWS.reduce((sum, r) => sum + (r.max ?? 0), 0), 14);
});

test("hard criteria.md table matches HARD_RUBRIC_ROWS byte for byte", () => {
  const criteria = readFileSync(criteriaPath, "utf8");
  const match = criteria.match(/\| Criterion \| Max \| Scored by \|\n\|---\|---\|---\|\n([\s\S]*?)\n\n/);
  assert.ok(match, "criteria.md must carry the rows table");
  const rows = match[1].split("\n").map((line) => {
    const parts = line.split("|").slice(1, -1).map((s) => s.trim());
    return [parts[0], parts[1] === "N/A" ? null : Number(parts[1]), parts[2]];
  });
  assert.deepEqual(rows, HARD_RUBRIC_ROWS.map((r) => [r.name, r.max, r.scoredBy]));
});

test("hard manifest.json matches the 6 contract hidden rows, summing to 11 points and 86 tests", () => {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.files.length, 6);
  const contractHidden = HARD_HIDDEN_ROWS.slice(0, 6);
  assert.deepEqual(
    contractHidden.map((r) => [r.name, r.max]),
    manifest.files.map((f: { row: string; max: number }) => [f.row, f.max]),
  );
  const totalMax = manifest.files.reduce((sum: number, f: { max: number }) => sum + f.max, 0);
  const totalTests = manifest.files.reduce((sum: number, f: { tests: number }) => sum + f.tests, 0);
  assert.equal(totalMax, 11);
  assert.equal(totalTests, 86);
});

test("hardRubricId produces expected format and is deterministic", () => {
  const id = hardRubricId(ROOT);
  assert.match(id, /^maintenance-console-hard@[0-9a-f]{12}$/);
  assert.equal(hardRubricId(ROOT), id);
});

test("the rows and hidden rows are frozen", () => {
  assert.ok(Object.isFrozen(HARD_RUBRIC_ROWS) && HARD_RUBRIC_ROWS.every((r) => Object.isFrozen(r)));
  assert.ok(Object.isFrozen(HARD_HIDDEN_ROWS));
});
