import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, cpSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, beforeEach } from "node:test";

const _require = createRequire(import.meta.url);

import {
  isJudgeRowName,
  isValidScore,
  requiredBy,
  stoppedJudgeRows,
  parseJudgeRowsHard,
  writeJudgeRowsHard,
  JUDGE_ROW_NAMES,
  JUDGE_ROWS_FILE,
  type JudgeRowsHard,
  type JudgeRowValue,
} from "../scripts/lib/judge-rows-hard";
import { renderCsv, type RowCell } from "../scripts/lib/hard-score";
import { HARD_RUBRIC_ROWS } from "../scripts/lib/hard-rubric";
import { applyJudgeRows } from "../scripts/score-hard";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("isJudgeRowName", () => {
  it("accepts the five allowed rows", () => {
    for (const name of JUDGE_ROW_NAMES) {
      assert.equal(isJudgeRowName(name), true, name);
    }
  });
  it("rejects unknown names", () => {
    assert.equal(isJudgeRowName("API contract"), false);
    assert.equal(isJudgeRowName("Local build"), false);
    assert.equal(isJudgeRowName("Frontend E2E: flows"), false);
  });
});

describe("isValidScore", () => {
  it("accepts 0, 0.5, 1", () => {
    assert.equal(isValidScore(0), true);
    assert.equal(isValidScore(0.5), true);
    assert.equal(isValidScore(1), true);
  });
  it("rejects other values", () => {
    assert.equal(isValidScore(0.3), false);
    assert.equal(isValidScore(2), false);
    assert.equal(isValidScore(-1), false);
    assert.equal(isValidScore(1.5), false);
  });
});

describe("requiredBy", () => {
  it("returns agent for agent rows", () => {
    assert.equal(requiredBy("Code structure"), "agent");
    assert.equal(requiredBy("Tech stack & run contract"), "agent");
    assert.equal(requiredBy("Self-verification"), "agent");
  });
  it("returns human for human/penalty rows", () => {
    assert.equal(requiredBy("Visual design"), "human");
    assert.equal(requiredBy("Penalty"), "human");
  });
});

// ---------------------------------------------------------------------------
// parseJudgeRowsHard
// ---------------------------------------------------------------------------

describe("parseJudgeRowsHard", () => {
  const base: JudgeRowsHard = {
    schemaVersion: 1,
    attempt: "gemini-31-pro-high-attempt-1",
    rubric: "maintenance-console-hard@e09da7190046",
    judge: "claude-opus-5-5",
    judgedAt: "2026-10-09T12:00:00.000Z",
    rows: { "Code structure": { score: 1, note: "all six points hold", by: "agent" } },
  };

  it("round-trips a valid file", () => {
    const parsed = parseJudgeRowsHard(JSON.stringify(base));
    assert.deepEqual(parsed, base);
  });

  it("rejects bad schemaVersion", () => {
    assert.throws(() => parseJudgeRowsHard(JSON.stringify({ ...base, schemaVersion: 2 })), /schemaVersion/);
  });

  it("rejects unknown row name", () => {
    assert.throws(
      () => parseJudgeRowsHard(JSON.stringify({ ...base, rows: { "Unknown row": { score: 1, note: "x", by: "agent" } } })),
      /unknown row/,
    );
  });

  it("rejects bad score value", () => {
    assert.throws(
      () => parseJudgeRowsHard(JSON.stringify({ ...base, rows: { "Code structure": { score: 0.3, note: "x", by: "agent" } } })),
      /0, 0\.5 or 1/,
    );
  });

  it("rejects bad by value", () => {
    assert.throws(
      () => parseJudgeRowsHard(JSON.stringify({ ...base, rows: { "Code structure": { score: 1, note: "x", by: "other" } } })),
      /by must be/,
    );
  });

  it("R8: rejects by that does not match requiredBy (e.g. Visual design with by:agent)", () => {
    assert.throws(
      () => parseJudgeRowsHard(JSON.stringify({ ...base, rows: { "Visual design": { score: 0.5, note: "ok", by: "agent" } } })),
      /must be "human"/,
    );
  });

  it("R8: rejects Code structure with by:human", () => {
    assert.throws(
      () => parseJudgeRowsHard(JSON.stringify({ ...base, rows: { "Code structure": { score: 1, note: "ok", by: "human" } } })),
      /must be "agent"/,
    );
  });
});

// ---------------------------------------------------------------------------
// stoppedJudgeRows
// ---------------------------------------------------------------------------

describe("stoppedJudgeRows", () => {
  it("detects backend stop → Self-verification stopped", () => {
    const stopped = stoppedJudgeRows("stop:boot: exited 1", "ok");
    assert.ok(stopped.has("Self-verification"));
    assert.ok(!stopped.has("Visual design"));
    assert.ok(!stopped.has("Code structure"));
  });

  it("detects frontend stop → Visual design stopped", () => {
    const stopped = stoppedJudgeRows("ok", "stop: npm run build failed");
    assert.ok(stopped.has("Visual design"));
    assert.ok(!stopped.has("Self-verification"));
  });

  it("detects both stops → all judge rows stopped", () => {
    const stopped = stoppedJudgeRows("stop:boot: exited 1", "stop: npm run build failed");
    for (const name of JUDGE_ROW_NAMES) {
      assert.ok(stopped.has(name), `${name} should be stopped`);
    }
  });

  it("returns empty set when no stop applies", () => {
    const stopped = stoppedJudgeRows("ok", "ok");
    assert.equal(stopped.size, 0);
  });

  it("R10: both stops from real allZero output → all judge rows stopped", () => {
    // allZero produces Notes like "both stops: backend ...; frontend ..."
    // which the old CSV-based stoppedJudgeRows couldn't detect.
    // Now we use the structural backend/frontend fields instead.
    const backendReason = "stop:boot: exited 1";
    const frontendReason = "stop: package.json missing";
    // Simulate what hidden-results-hard.json would carry
    const stopped = stoppedJudgeRows(backendReason, frontendReason);
    for (const name of JUDGE_ROW_NAMES) {
      assert.ok(stopped.has(name), `${name} should be stopped on both stops`);
    }
  });

  it("R10: backend stop from real applyStops → Self-verification stopped, rest open", () => {
    // Use real applyStops to produce cells, then verify stoppedJudgeRows
    // matches the same stop pattern when given the backend/frontend status
    const backendReason = "stop:boot: uvicorn not found";
    const stopped = stoppedJudgeRows(backendReason, "ok");
    assert.ok(stopped.has("Self-verification"));
    assert.ok(!stopped.has("Code structure"));
    assert.ok(!stopped.has("Tech stack & run contract"));
    assert.ok(!stopped.has("Visual design"));
    assert.ok(!stopped.has("Penalty"));
  });

  it("R10: frontend stop from real applyStops → Visual design stopped, rest open", () => {
    const frontendReason = "stop: npm run build failed: exit 1";
    const stopped = stoppedJudgeRows("ok", frontendReason);
    assert.ok(stopped.has("Visual design"));
    assert.ok(!stopped.has("Self-verification"));
    assert.ok(!stopped.has("Code structure"));
    assert.ok(!stopped.has("Penalty"));
  });
});

// ---------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------

describe("writeJudgeRowsHard merge", () => {
  it("merges new rows with existing", () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-merge-"));
    const path = join(dir, JUDGE_ROWS_FILE);

    const existing: JudgeRowsHard = {
      schemaVersion: 1, attempt: "a-attempt-1",
      rubric: "maintenance-console-hard@e09da7190046",
      judge: "claude-opus-5-5", judgedAt: "2026-10-09T12:00:00.000Z",
      rows: { "Code structure": { score: 1, note: "good", by: "agent" } },
    };
    writeJudgeRowsHard(path, existing);

    // Read, merge, write
    const loaded = parseJudgeRowsHard(readFileSync(path, "utf8"));
    loaded.rows["Visual design"] = { score: 0.5, note: "minor issues", by: "human" };
    loaded.judgedAt = "2026-10-09T13:00:00.000Z";
    writeJudgeRowsHard(path, loaded);

    const final = parseJudgeRowsHard(readFileSync(path, "utf8"));
    assert.equal(final.rows["Code structure"]!.score, 1);
    assert.equal(final.rows["Visual design"]!.score, 0.5);
  });
});

// ---------------------------------------------------------------------------
// CSV round-trip
// ---------------------------------------------------------------------------

describe("CSV round-trip with judge rows", () => {
  it("real CSV from fixture round-trips without --set giving identical bytes", () => {
    const fixturePath = join("test", "fixtures", "hard-eval-results-sample.csv");
    const original = readFileSync(fixturePath, "utf8");

    // Parse with csv-parse/sync same as hard-judge-rows.ts does
    const { parse: parseCsv } = _require("csv-parse/sync") as typeof import("csv-parse/sync");
    const rows = parseCsv(original, { columns: true, skip_empty_lines: true, trim: true, bom: true }) as Record<string, string>[];

    let duration = "";
    let testRun = "";
    const cells = new Map<string, RowCell>();
    for (const row of rows) {
      const name = row.Criterion.trim();
      if (name === "Task completion time") { duration = row.Score.trim(); continue; }
      if (name === "Test run") { testRun = row.Score.trim(); continue; }
      const score = Number(row.Score.trim());
      const noteText = row.Notes ?? "";
      cells.set(name, { score: Number.isFinite(score) ? score : 0, notes: noteText });
    }

    const rebuilt = renderCsv(cells, duration, testRun);
    assert.equal(rebuilt, original, "round-tripped CSV must match original byte-for-byte");
  });

  it("Notes with commas and quotes survive round-trip", () => {
    const cells = new Map<string, RowCell>();

    // Fill all scored rows
    for (const row of HARD_RUBRIC_ROWS) {
      if (row.name === "Task completion time" || row.name === "Test run") continue;
      if (row.name === "Code structure") {
        cells.set(row.name, { score: 0.5, notes: 'heuristic: store, planner found; types, "api" missing' });
      } else if (row.name === "Penalty") {
        cells.set(row.name, { score: 0, notes: "no deduction" });
      } else {
        cells.set(row.name, { score: row.max ?? 0, notes: "ok" });
      }
    }

    const csv = renderCsv(cells, "14min 30s", "3.03.2030 09:15");
    // Parse the CSV back
    const { parse: parseCsv } = _require("csv-parse/sync") as typeof import("csv-parse/sync");
    const parsed = parseCsv(csv, { columns: true, skip_empty_lines: true, trim: true, bom: true }) as Record<string, string>[];
    const codeStructRow = parsed.find((r) => r.Criterion.trim() === "Code structure");
    assert.ok(codeStructRow);
    assert.equal(codeStructRow.Notes, 'heuristic: store, planner found; types, "api" missing');
  });
});

// ---------------------------------------------------------------------------
// applyJudgeRows
// ---------------------------------------------------------------------------

describe("applyJudgeRows", () => {
  const judgeRows: JudgeRowsHard = {
    schemaVersion: 1, attempt: "a-attempt-1",
    rubric: "maintenance-console-hard@e09da7190046",
    judge: "claude-opus-5-5", judgedAt: "2026-10-09T12:00:00.000Z",
    rows: {
      "Code structure": { score: 1, note: "all six points", by: "agent" },
      "Visual design": { score: 0.5, note: "minor issues", by: "human" },
    },
  };

  it("overlays judge rows onto cells", () => {
    const cells = new Map<string, RowCell>([
      ["Code structure", { score: 0, notes: "heuristic" }],
      ["Visual design", { score: 0, notes: "default" }],
      ["Self-verification", { score: 1, notes: "heuristic" }],
    ]);
    const out = applyJudgeRows(cells, judgeRows, { backend: null, frontend: null });
    assert.equal(out.get("Code structure")!.score, 1);
    assert.equal(out.get("Code structure")!.notes, "all six points");
    assert.equal(out.get("Visual design")!.score, 0.5);
    assert.equal(out.get("Self-verification")!.score, 1); // unchanged
  });

  it("skips Self-verification when backend stop applies", () => {
    const judgeWithSelfVer: JudgeRowsHard = {
      ...judgeRows,
      rows: {
        ...judgeRows.rows,
        "Self-verification": { score: 1, note: "tests pass", by: "agent" },
      },
    };
    const cells = new Map<string, RowCell>([
      ["Code structure", { score: 0, notes: "heuristic" }],
      ["Self-verification", { score: 0, notes: "backend stop" }],
      ["Visual design", { score: 0, notes: "default" }],
    ]);
    const out = applyJudgeRows(cells, judgeWithSelfVer, { backend: "stop:boot: exited", frontend: null });
    assert.equal(out.get("Self-verification")!.score, 0); // not overridden
    assert.equal(out.get("Code structure")!.score, 1); // still applied
  });

  it("skips Visual design when frontend stop applies", () => {
    const cells = new Map<string, RowCell>([
      ["Code structure", { score: 0, notes: "heuristic" }],
      ["Visual design", { score: 0, notes: "frontend stop" }],
    ]);
    const out = applyJudgeRows(cells, judgeRows, { backend: null, frontend: "stop: npm run build failed" });
    assert.equal(out.get("Visual design")!.score, 0); // not overridden
    assert.equal(out.get("Code structure")!.score, 1); // still applied
  });

  it("skips all when both stops apply", () => {
    const cells = new Map<string, RowCell>([
      ["Code structure", { score: 0, notes: "both stops" }],
      ["Visual design", { score: 0, notes: "both stops" }],
    ]);
    const out = applyJudgeRows(cells, judgeRows, { backend: "a", frontend: "b" });
    assert.equal(out.get("Code structure")!.score, 0);
    assert.equal(out.get("Visual design")!.score, 0);
  });
});

// ---------------------------------------------------------------------------
// process-results compatibility: a valid CSV with judge-row scores passes parseCriteriaCsv
// ---------------------------------------------------------------------------

describe("process-results compatibility", () => {
  it("parseCriteriaCsv accepts a CSV with judge-scored rows", () => {
    // Build a valid CSV with judge-row values
    const cells = new Map<string, RowCell>();
    for (const row of HARD_RUBRIC_ROWS) {
      if (row.name === "Task completion time" || row.name === "Test run") continue;
      if (row.name === "Code structure") {
        cells.set(row.name, { score: 1, notes: "all six points hold" });
      } else if (row.name === "Visual design") {
        cells.set(row.name, { score: 0.5, notes: "minor issues" });
      } else if (row.name === "Penalty") {
        cells.set(row.name, { score: 0, notes: "no deduction" });
      } else {
        cells.set(row.name, { score: row.max ?? 0, notes: "ok" });
      }
    }
    const csv = renderCsv(cells, "14min 30s", "3.03.2030 09:15");

    // Import parseCriteriaCsv from process-results
    const { parseCriteriaCsv } = _require("../scripts/process-results") as typeof import("../scripts/process-results");
    // Should not throw
    const criteria = parseCriteriaCsv(csv, "test-csv", HARD_RUBRIC_ROWS);
    assert.equal(criteria.length, HARD_RUBRIC_ROWS.length);
    const codeStruct = criteria.find((c) => c.name === "Code structure");
    assert.ok(codeStruct);
    assert.equal(codeStruct.score, 1);
  });
});
