import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  BROWNFIELD_HIDDEN_ROWS,
  BROWNFIELD_RUBRIC_ID_INPUTS,
  BROWNFIELD_RUBRIC_MAX,
  BROWNFIELD_RUBRIC_ROWS,
  brownfieldRubricId,
} from "../scripts/lib/brownfield-rubric";
import { HARD_RUBRIC_ID_INPUTS, hardRubricId } from "../scripts/lib/hard-rubric";
import { RUBRIC_ID_INPUTS, rubricId } from "../scripts/lib/rubric";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const criteriaPath = join(ROOT, "tracks", "brownfield", "benchmark", "criteria.md");
const scenarioPath = join(ROOT, "tracks", "brownfield", "benchmark", "contract-tests", "balanced-scenario.json");

test("BROWNFIELD_RUBRIC_ROWS defines the 10 brownfield track rows with maxima and scorers", () => {
  assert.deepEqual(
    BROWNFIELD_RUBRIC_ROWS.map((r) => [r.name, r.max, r.scoredBy]),
    [
      ["Task completion time", null, "auto"],
      ["Test run", null, "auto"],
      ["Local build", 1, "auto"],
      ["Regression", 4, "hidden"],
      ["Change suite", 3, "hidden"],
      ["Diff locality", 1, "auto"],
      ["Code structure", 1, "agent"],
      ["Self-verification", 1, "agent"],
      ["Visual design", 1, "human"],
      ["Penalty", null, "penalty"],
    ],
  );
  assert.equal(BROWNFIELD_RUBRIC_ROWS.length, 10);
  assert.equal(new Set(BROWNFIELD_RUBRIC_ROWS.map((r) => r.name)).size, 10, "row names are unique");
});

test("the brownfield maxima sum to BROWNFIELD_RUBRIC_MAX = 12", () => {
  assert.equal(BROWNFIELD_RUBRIC_MAX, 12);
  assert.equal(BROWNFIELD_RUBRIC_ROWS.reduce((sum, r) => sum + (r.max ?? 0), 0), BROWNFIELD_RUBRIC_MAX);
});

test("BROWNFIELD_HIDDEN_ROWS matches the 2 hidden rows with max 7", () => {
  assert.deepEqual(BROWNFIELD_HIDDEN_ROWS, BROWNFIELD_RUBRIC_ROWS.filter((r) => r.scoredBy === "hidden"));
  assert.equal(BROWNFIELD_HIDDEN_ROWS.length, 2);
  assert.equal(BROWNFIELD_HIDDEN_ROWS.reduce((sum, r) => sum + (r.max ?? 0), 0), 7);
});

test("brownfield criteria.md table matches BROWNFIELD_RUBRIC_ROWS byte for byte", () => {
  const criteria = readFileSync(criteriaPath, "utf8");
  const match = criteria.match(/\| Criterion \| Max \| Scored by \|\n\|---\|---\|---\|\n([\s\S]*?)\n\n/);
  assert.ok(match, "criteria.md must carry the rows table");
  const rows = match[1].split("\n").map((line) => {
    const parts = line.split("|").slice(1, -1).map((s) => s.trim());
    return [parts[0], parts[1] === "N/A" ? null : Number(parts[1]), parts[2]];
  });
  assert.deepEqual(rows, BROWNFIELD_RUBRIC_ROWS.map((r) => [r.name, r.max, r.scoredBy]));
});

test("BROWNFIELD_RUBRIC_ID_INPUTS matches the 8 expected inputs, using classic contract tests and seed by reference", () => {
  assert.deepEqual(BROWNFIELD_RUBRIC_ID_INPUTS, [
    join("tracks", "brownfield", "prompt.md"),
    join("tracks", "brownfield", "benchmark", "criteria.md"),
    join(".claude", "skills", "agrav-score-brownfield", "SKILL.md"),
    join("scripts", "lib", "brownfield-rubric.ts"),
    join("tracks", "brownfield", "base"),
    join("benchmark", "contract-tests"),
    join("tracks", "brownfield", "benchmark", "contract-tests"),
    join("benchmark", "context", "seed.json"),
  ]);
});

test("classic and hard rubric IDs remain unchanged", () => {
  assert.equal(rubricId(ROOT), "maintenance-console@0f3acd25cedc");
  assert.equal(hardRubricId(ROOT), "maintenance-console-hard@a0d3c3d39eb1");
});

test("brownfieldRubricId produces expected format and is deterministic", () => {
  const id = brownfieldRubricId(ROOT);
  assert.equal(id, "maintenance-console-brownfield@a02c2e3f98e2");
  assert.match(id, /^maintenance-console-brownfield@[0-9a-f]{12}$/);
  assert.equal(brownfieldRubricId(ROOT), id);
});

test("brownfieldRubricId changes when any byte of key inputs changes", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agrav-brownfield-rubric-test-"));
  try {
    for (const input of BROWNFIELD_RUBRIC_ID_INPUTS) {
      const src = join(ROOT, input);
      const dst = join(tempDir, input);
      cpSync(src, dst, { recursive: true });
    }

    const baseId = brownfieldRubricId(tempDir);
    assert.match(baseId, /^maintenance-console-brownfield@[0-9a-f]{12}$/);

    // 1. Modifying base changes id
    const baseFile = join(tempDir, "tracks", "brownfield", "base", "backend", "app", "main.py");
    const origBase = readFileSync(baseFile, "utf8");
    writeFileSync(baseFile, `${origBase}\n# comment`);
    assert.notEqual(brownfieldRubricId(tempDir), baseId, "modifying base file changes id");
    writeFileSync(baseFile, origBase);

    // 2. Modifying prompt changes id
    const promptFile = join(tempDir, "tracks", "brownfield", "prompt.md");
    const origPrompt = readFileSync(promptFile, "utf8");
    writeFileSync(promptFile, `${origPrompt}\n<!-- comment -->`);
    assert.notEqual(brownfieldRubricId(tempDir), baseId, "modifying prompt changes id");
    writeFileSync(promptFile, origPrompt);

    // 3. Modifying criteria changes id
    const criteriaFile = join(tempDir, "tracks", "brownfield", "benchmark", "criteria.md");
    const origCriteria = readFileSync(criteriaFile, "utf8");
    writeFileSync(criteriaFile, `${origCriteria}\n<!-- comment -->`);
    assert.notEqual(brownfieldRubricId(tempDir), baseId, "modifying criteria changes id");
    writeFileSync(criteriaFile, origCriteria);

    // 4. Modifying classic contract-tests changes id
    const contractTestFile = join(tempDir, "benchmark", "contract-tests", "api.ts");
    const origContract = readFileSync(contractTestFile, "utf8");
    writeFileSync(contractTestFile, `${origContract}\n// comment`);
    assert.notEqual(brownfieldRubricId(tempDir), baseId, "modifying classic contract tests changes id");
    writeFileSync(contractTestFile, origContract);

    // 5. Modifying balanced-scenario fixture inside contract-tests changes id
    const scenarioFile = join(tempDir, "tracks", "brownfield", "benchmark", "contract-tests", "balanced-scenario.json");
    const origScenario = readFileSync(scenarioFile, "utf8");
    const parsedScenario = JSON.parse(origScenario);
    parsedScenario.week_start = "2026-10-19";
    writeFileSync(scenarioFile, JSON.stringify(parsedScenario, null, 2));
    assert.notEqual(brownfieldRubricId(tempDir), baseId, "modifying balanced-scenario changes id");
    writeFileSync(scenarioFile, origScenario);

    assert.equal(brownfieldRubricId(tempDir), baseId, "restoring inputs restores id");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("balanced-scenario.json adheres to schema and Decision D11 specifications", () => {
  const scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));

  assert.equal(scenario.week_start, "2026-10-12");
  assert.equal(scenario.orders.length, 4);

  const expectedStarts = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"];
  for (let i = 0; i < 4; i++) {
    const o = scenario.orders[i];
    assert.equal(o.asset_id, "A-001");
    assert.equal(o.required_skill, "electrical");
    assert.equal(o.duration_minutes, 240);
    assert.equal(o.earliest_start, expectedStarts[i]);
    assert.equal(o.due_date, "2026-10-16");
    assert.equal(o.priority, "medium");
    assert.deepEqual(o.parts, []);
  }

  assert.deepEqual(scenario.expected_earliest, {
    technician_load: {
      "T-001": 960,
      "T-002": 0,
      "T-003": 0,
      "T-004": 0,
    },
  });

  assert.deepEqual(scenario.expected_balanced, {
    technician_load: {
      "T-001": 480,
      "T-002": 480,
      "T-003": 0,
      "T-004": 0,
    },
  });
});

test("the brownfield rows and hidden rows are frozen", () => {
  assert.ok(Object.isFrozen(BROWNFIELD_RUBRIC_ROWS) && BROWNFIELD_RUBRIC_ROWS.every((r) => Object.isFrozen(r)));
  assert.ok(Object.isFrozen(BROWNFIELD_HIDDEN_ROWS));
});
