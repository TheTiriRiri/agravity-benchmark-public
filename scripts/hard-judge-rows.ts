/**
 * hard-judge-rows.ts — Set judge and human scores for hard track attempts.
 *
 * These scores survive a `score-hard --force` rescore: score-hard reads
 * judge-rows-hard.json and uses its rows instead of heuristics/defaults.
 *
 * Usage:
 *   node --import tsx scripts/hard-judge-rows.ts \
 *     --attempt <id> \
 *     --judge <model> \
 *     --set "<Row>=<score>|<note>" [--set ...]
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseCsv } from "csv-parse/sync";
import { load as loadYaml } from "js-yaml";

import { renderCsv, csvNote, parseHardHiddenResults, type RowCell } from "./lib/hard-score";
import { writeFileAtomic } from "./lib/atomic-write";
import { HARD_RUBRIC_ROWS, hardRubricId } from "./lib/hard-rubric";
import {
  JUDGE_ROWS_FILE,
  JUDGE_ROW_NAMES,
  isJudgeRowName,
  isValidScore,
  requiredBy,
  stoppedJudgeRows,
  parseJudgeRowsHard,
  writeJudgeRowsHard,
  type JudgeRowsHard,
  type JudgeRowName,
  type JudgeRowValue,
} from "./lib/judge-rows-hard";
import { readRunJson } from "./lib/run-json";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HARD_ROOT = join(ROOT, "tracks", "console-hard");
const RESULTS_DIR = join(HARD_ROOT, "eval-results");
const RUNNER_YAML = join(ROOT, "benchmark", "runner-hard.yaml");

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  attempt: string;
  judge: string;
  sets: { row: JudgeRowName; score: 0 | 0.5 | 1; note: string }[];
}

function parseArgs(argv: string[]): CliArgs {
  let attempt: string | null = null;
  let judge: string | null = null;
  const sets: CliArgs["sets"] = [];

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--attempt":
        attempt = argv[++i] ?? null;
        break;
      case "--judge":
        judge = argv[++i] ?? null;
        break;
      case "--set": {
        const raw = argv[++i];
        if (!raw) throw new Error("--set requires a value");
        // Format: "Row=score|note"
        const eqIdx = raw.indexOf("=");
        if (eqIdx === -1) throw new Error(`--set: expected "Row=score|note", got ${JSON.stringify(raw)}`);
        const rowName = raw.slice(0, eqIdx);
        const rest = raw.slice(eqIdx + 1);
        const pipeIdx = rest.indexOf("|");
        if (pipeIdx === -1) throw new Error(`--set: expected "Row=score|note", got ${JSON.stringify(raw)}`);
        const scoreStr = rest.slice(0, pipeIdx);
        const note = rest.slice(pipeIdx + 1);
        if (!isJudgeRowName(rowName)) {
          throw new Error(`--set: unknown row ${JSON.stringify(rowName)}; allowed: ${JUDGE_ROW_NAMES.join(", ")}`);
        }
        const score = Number(scoreStr);
        if (!isValidScore(score)) {
          throw new Error(`--set: score for ${JSON.stringify(rowName)} must be 0, 0.5 or 1; got ${JSON.stringify(scoreStr)}`);
        }
        sets.push({ row: rowName, score, note });
        break;
      }
      default:
        throw new Error(`unknown argument: ${argv[i]}`);
    }
  }

  if (!attempt) throw new Error("--attempt is required");
  if (!judge) throw new Error("--judge is required");
  if (sets.length === 0) throw new Error("at least one --set is required");

  return { attempt, judge, sets };
}

// ---------------------------------------------------------------------------
// CSV reading — extract info rows and scored cells
// ---------------------------------------------------------------------------

interface CsvRow { Criterion: string; Score: string; Max: string; Notes: string }

function readCsvCells(csvPath: string): {
  duration: string;
  testRun: string;
  cells: Map<string, RowCell>;
} {
  const content = readFileSync(csvPath, "utf8");
  const rows = parseCsv(content, { columns: true, skip_empty_lines: true, trim: true, bom: true }) as CsvRow[];

  let duration = "";
  let testRun = "";
  const cells = new Map<string, RowCell>();

  for (const row of rows) {
    const name = row.Criterion.trim();
    if (name === "Task completion time") {
      duration = row.Score.trim();
      continue;
    }
    if (name === "Test run") {
      testRun = row.Score.trim();
      continue;
    }
    const score = Number(row.Score.trim());
    // Notes may be double-quoted by csvNote; csv-parse removes the quoting
    const noteText = row.Notes ?? "";
    cells.set(name, { score: Number.isFinite(score) ? score : 0, notes: noteText });
  }

  return { duration, testRun, cells };
}

// ---------------------------------------------------------------------------
// Runner YAML — validate judge
// ---------------------------------------------------------------------------

function readRunnerJudge(): string {
  const raw = loadYaml(readFileSync(RUNNER_YAML, "utf8")) as Record<string, unknown>;
  if (typeof raw.judge !== "string") throw new Error(`${RUNNER_YAML}: no judge field`);
  return raw.judge;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(argv: string[]): void {
  const args = parseArgs(argv);

  const attemptDir = join(RESULTS_DIR, args.attempt);
  if (!existsSync(attemptDir)) {
    console.error(`no such attempt directory: ${attemptDir}`);
    process.exit(2);
  }

  // 1. Check run.json — refuse model failures
  const runJsonPath = join(attemptDir, "run.json");
  if (!existsSync(runJsonPath)) {
    console.error(`no run.json at ${runJsonPath}`);
    process.exit(2);
  }
  const runJson = readRunJson(runJsonPath);
  if (runJson.failureKind === "infra") {
    console.error(`${args.attempt}: run.json records failureKind "infra" — not a data point, nothing to judge`);
    process.exit(1);
  }
  if (runJson.softDenied) {
    console.error(`${args.attempt}: run.json records softDenied — not a data point, nothing to judge`);
    process.exit(1);
  }
  if (runJson.failureKind === "model") {
    console.error(`${args.attempt}: run.json records failureKind "model" — all-zero CSV, nothing to judge`);
    process.exit(1);
  }

  // 2. Check eval-results.csv exists
  const csvPath = join(attemptDir, "eval-results.csv");
  if (!existsSync(csvPath)) {
    console.error(`${args.attempt}: no eval-results.csv — score the attempt first`);
    process.exit(1);
  }

  // 3. Validate rubric
  const rubric = hardRubricId(ROOT);

  // 4. Validate judge against runner-hard.yaml
  const runnerJudge = readRunnerJudge();
  if (args.judge !== runnerJudge) {
    console.error(`--judge ${JSON.stringify(args.judge)} does not match runner-hard.yaml judge: ${JSON.stringify(runnerJudge)}`);
    process.exit(1);
  }

  // 5. Read hidden-results-hard.json to detect stops structurally
  const hiddenResultsPath = join(attemptDir, "hidden-results-hard.json");
  if (!existsSync(hiddenResultsPath)) {
    console.error(`${args.attempt}: no hidden-results-hard.json — score the attempt first`);
    process.exit(1);
  }
  const hiddenResults = parseHardHiddenResults(readFileSync(hiddenResultsPath, "utf8"));
  const stopped = stoppedJudgeRows(hiddenResults.backend, hiddenResults.frontend);

  // 5b. Read existing CSV for rewriting
  const { duration, testRun, cells } = readCsvCells(csvPath);

  // 6. Check for existing judge-rows-hard.json
  const judgeRowsPath = join(attemptDir, JUDGE_ROWS_FILE);
  let existing: JudgeRowsHard | null = null;
  if (existsSync(judgeRowsPath)) {
    existing = parseJudgeRowsHard(readFileSync(judgeRowsPath, "utf8"));
    if (existing.rubric !== rubric) {
      console.error(`existing ${JUDGE_ROWS_FILE} has rubric ${existing.rubric}, current is ${rubric} — refusing`);
      process.exit(1);
    }
  }

  // 7. Validate each --set: refuse stop-zeroed rows
  for (const s of args.sets) {
    if (stopped.has(s.row)) {
      console.error(`${s.row} is zeroed by a stop rule (see Notes in CSV) — cannot set a judge score`);
      process.exit(1);
    }
  }

  // 8. Build the judge rows
  const rows: Partial<Record<JudgeRowName, JudgeRowValue>> = existing ? { ...existing.rows } : {};
  for (const s of args.sets) {
    rows[s.row] = { score: s.score, note: s.note, by: requiredBy(s.row) };
  }

  const data: JudgeRowsHard = {
    schemaVersion: 1,
    attempt: args.attempt,
    rubric,
    judge: args.judge,
    judgedAt: new Date().toISOString(),
    rows,
  };

  // 9. Write judge-rows-hard.json atomically
  writeJudgeRowsHard(judgeRowsPath, data);
  console.log(`✓ Wrote ${judgeRowsPath}`);

  // 10. Rewrite eval-results.csv: only update the judge rows
  for (const [name, value] of Object.entries(rows)) {
    if (stopped.has(name as JudgeRowName)) continue; // respect stops
    cells.set(name, { score: value!.score, notes: value!.note });
  }
  const csv = renderCsv(cells, duration, testRun);
  writeFileAtomic(csvPath, csv);
  console.log(`✓ Rewrote ${csvPath}`);

  // 11. Print total
  const totalPoints = [...cells.entries()]
    .filter(([k]) => k !== "Penalty" && k !== "Task completion time" && k !== "Test run")
    .reduce((sum, [, c]) => sum + c.score, 0) - (cells.get("Penalty")?.score ?? 0);
  const max = HARD_RUBRIC_ROWS.reduce((sum, r) => sum + (r.max ?? 0), 0);
  console.log(`Total: ${totalPoints.toFixed(2)} / ${max} (${((totalPoints / max) * 100).toFixed(1)}%)`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}

export { parseArgs, readCsvCells, main };
