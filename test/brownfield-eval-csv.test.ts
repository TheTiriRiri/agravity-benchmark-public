import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parse } from "csv-parse/sync";

import { BROWNFIELD_RUBRIC_ROWS, type RubricRow } from "../scripts/lib/brownfield-rubric";

interface CsvRow {
  Criterion: string;
  Score: string;
  Max: string;
  Notes: string;
}

/**
 * The verification check used in Phase 4 of agrav-score-brownfield.
 */
export function verifyBrownfieldCsv(csvText: string): {
  ok: boolean;
  problems: string[];
  linesCount: number;
  rowsCount: number;
} {
  let rows: CsvRow[];
  try {
    rows = parse(csvText, { columns: true }) as CsvRow[];
  } catch (error) {
    return {
      ok: false,
      problems: ["WRONG: not a CSV: " + (error as Error).message],
      linesCount: 0,
      rowsCount: 0,
    };
  }

  const scoreOk = (r: RubricRow, { Score: s, Notes: n }: CsvRow): boolean =>
    r.name === "Task completion time"
      ? /^((0|[1-9]\d*)min [1-5]?\ds|N\/A)$/.test(s) && n === s
      : r.name === "Test run"
        ? /^[1-9]\d?\.\d\d\.\d{4} \d\d:\d\d$/.test(s) && n === s
        : r.scoredBy === "hidden"
          ? /^\d+(\.\d+)?$/.test(s) && Number(s) <= (r.max ?? 0)
          : r.scoredBy === "auto" && r.name === "Diff locality"
            ? /^\d+(\.\d+)?$/.test(s) && Number(s) <= (r.max ?? 0)
            : (r.name === "Local build"
                ? ["1", "0"]
                : r.scoredBy === "penalty"
                  ? ["0", "0.5", "1"]
                  : ["1", "0.5", "0"]
              ).includes(s);

  const wrong = BROWNFIELD_RUBRIC_ROWS.filter(
    (r, i) =>
      rows[i]?.Criterion !== r.name ||
      rows[i].Max !== String(r.max ?? "N/A") ||
      !scoreOk(r, rows[i]),
  );

  const problems: string[] = [];
  if (rows.length !== BROWNFIELD_RUBRIC_ROWS.length) {
    problems.push("WRONG ROW COUNT, " + BROWNFIELD_RUBRIC_ROWS.length + " expected");
  }
  if (wrong.length > 0) {
    problems.push("WRONG: " + wrong.map((r) => r.name).join(" | "));
  }
  if (!csvText.endsWith("\n")) {
    problems.push("NO TRAILING NEWLINE");
  }

  const linesCount = csvText.split("\n").length - 1;
  const rowsCount = rows.length;

  return {
    ok: problems.length === 0,
    problems,
    linesCount,
    rowsCount,
  };
}

function sampleValidCsv(): string {
  return [
    "Criterion,Score,Max,Notes",
    "Task completion time,12min 30s,N/A,12min 30s",
    "Test run,4.10.2026 14:00,N/A,4.10.2026 14:00",
    "Local build,1,1,\"Backend boot and frontend build succeeded\"",
    "Regression,3.45,4,\"50/58 passed\"",
    "Change suite,3,3,\"4/4 passed\"",
    "Diff locality,0.85,1,\"1 outside file, 75 lines changed\"",
    "Code structure,1,1,\"Clean modular planner implementation\"",
    "Self-verification,1,1,\"Tests added in backend/tests/ exercising balanced strategy\"",
    "Visual design,1,1,\"UI design intact and clean\"",
    "Penalty,0,N/A,\"No penalties\"",
  ].join("\n") + "\n";
}

describe("brownfield eval-results.csv verification (Subtask 7b.5.1)", () => {
  it("valid brownfield CSV passes verification with exactly 11 lines and 10 rows", () => {
    const csv = sampleValidCsv();
    const result = verifyBrownfieldCsv(csv);
    assert.ok(result.ok, `Expected ok, got problems: ${result.problems.join("; ")}`);
    assert.equal(result.linesCount, 11);
    assert.equal(result.rowsCount, 10);
  });

  it("fails when a row is missing", () => {
    const lines = sampleValidCsv().split("\n");
    // Remove "Change suite"
    lines.splice(5, 1);
    const csv = lines.join("\n");
    const result = verifyBrownfieldCsv(csv);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes("WRONG ROW COUNT")));
  });

  it("fails when Max value is wrong", () => {
    const csv = sampleValidCsv().replace("Regression,3.45,4,", "Regression,3.45,2,");
    const result = verifyBrownfieldCsv(csv);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes("Regression")));
  });

  it("fails when Score is out of bounds", () => {
    const csv = sampleValidCsv().replace("Local build,1,1,", "Local build,2,1,");
    const result = verifyBrownfieldCsv(csv);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes("Local build")));
  });

  it("fails when Task completion time has invalid format", () => {
    const csv = sampleValidCsv().replace("Task completion time,12min 30s,", "Task completion time,12m 30s,");
    const result = verifyBrownfieldCsv(csv);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes("Task completion time")));
  });

  it("fails when Test run has invalid date format", () => {
    const csv = sampleValidCsv().replace("Test run,4.10.2026 14:00,", "Test run,2026-10-04 14:00,");
    const result = verifyBrownfieldCsv(csv);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes("Test run")));
  });

  it("fails when trailing newline is missing", () => {
    const csv = sampleValidCsv().trimEnd();
    const result = verifyBrownfieldCsv(csv);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes("NO TRAILING NEWLINE")));
  });

  it("accepts all-zero CSV format with N/A for completion time", () => {
    const allZero = [
      "Criterion,Score,Max,Notes",
      "Task completion time,N/A,N/A,N/A",
      "Test run,4.10.2026 14:00,N/A,4.10.2026 14:00",
      "Local build,0,1,\"Not scored: run.json failureKind model\"",
      "Regression,0,4,\"Not scored: run.json failureKind model\"",
      "Change suite,0,3,\"Not scored: run.json failureKind model\"",
      "Diff locality,0,1,\"Not scored: run.json failureKind model\"",
      "Code structure,0,1,\"Not scored: run.json failureKind model\"",
      "Self-verification,0,1,\"Not scored: run.json failureKind model\"",
      "Visual design,0,1,\"Not scored: run.json failureKind model\"",
      "Penalty,0,N/A,\"Forced to 0: an all-zero CSV\"",
    ].join("\n") + "\n";
    const result = verifyBrownfieldCsv(allZero);
    assert.ok(result.ok, `Expected ok, got problems: ${result.problems.join("; ")}`);
  });
});
