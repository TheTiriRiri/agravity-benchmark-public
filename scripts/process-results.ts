/**
 * process-results — turn the judge's CSVs and the runner's `run.json` files into
 * the two JSON documents the dashboard reads.
 *
 *   npm run process-results -- [--results-dir <path>] [--root <path>] [--rubric <id>]
 *
 * `eval-results/<id>-attempt-<n>/{eval-results.csv,run.json}`
 *   → `website/src/data/results.json`      (everything, for the dashboard)
 *   → `website/public/api/leaderboard.json` (slim public payload)
 *
 * Seven choices shape it:
 *
 * 1. A real CSV parser. A regex such as `/^"?([^",]+)"?,(.+?),(.+?),(.*)$/`
 *    splits a quoted note at its first comma and leaves the stray quote in the
 *    output.
 * 2. `Task completion time` and the `API cost` row come from `run.json`, not
 *    from the CSV. The judge writes no cost row at all; this script imputes one
 *    from the envelope's token counts and `MODEL_PRICING`.
 * 3. Info rows (`Task completion time`, `Test run`, `API cost`) carry
 *    `score: null` rather than `parseFloat("10min 52s") === 10` and
 *    `parseFloat("16.04.2026 21:25") === 16.04`. The dashboard renders those
 *    rows from `notes`, so the number was never read — only misleading.
 * 4. Aggregation keys on the benchmark id and, additionally, on `MODEL_FAMILY`
 *    (`familyAverages`), so a model's effort levels can be compared both
 *    separately and together. The published matrix runs one configuration per
 *    model, so every family holds a single row today, and re-adding a level to
 *    `runner.yaml` is what makes the family average say more than the row does.
 * 5. An attempt whose `run.json` records `failureKind: "infra"` is skipped with
 *    a warning. The runner leaves those files on disk between a stop and a
 *    rerun; counted, they would be zeros that look like model failures.
 * 6. The rows and their maxima come from `scripts/lib/rubric.ts`, and every
 *    Max cell is checked against it.
 * 7. Every CSV's four hidden-test rows are held to the attempt's
 *    contract-results.json (`requireHiddenRowsAgree`), and only the current
 *    rubric id's attempts are published (`otherRubricOf`): a configuration
 *    with any attempt scored under another rubric id is withheld whole until
 *    it is re-scored. A model failure has no era, so it is withheld with its
 *    configuration; published alone, it would report the configuration by
 *    its failures.
 *
 * The score math is load-bearing: `Task completion
 * time`, `Test run`, `Penalty` and `API cost` are excluded from the denominator,
 * `Penalty` is subtracted from the total, and `percentage = total / max * 100`.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, type Dirent } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseCsv } from "csv-parse/sync";

import {
  AGENT_ENV,
  AGENT_NAMES,
  DISABLED_MODELS,
  FAMILY_NAMES,
  MODEL_FAMILY,
  MODEL_PRICING,
  SUPERSEDED_MODELS,
  isModelId,
  type ModelPricing,
} from "../eval-attempts/metadata";
import { parseAttemptDirName } from "./lib/attempts";
import { CONTRACT_RESULTS_FILE, parseContractResults } from "./lib/contract-results";
import { RUBRIC_ROWS, rubricId, type RubricRow } from "./lib/rubric";
import { readRunJson, type RunJson, type RunUsage } from "./lib/run-json";
import { createRequire } from "node:module";

/** ESM-compatible synchronous require for dynamic imports (hard-rubric, brownfield). */
const _require = createRequire(import.meta.url);

let _brownfieldRubric: typeof import("./lib/brownfield-rubric") | null = null;
function getBrownfieldRubric(): typeof import("./lib/brownfield-rubric") {
  if (!_brownfieldRubric) {
    _brownfieldRubric = _require("./lib/brownfield-rubric") as typeof import("./lib/brownfield-rubric");
  }
  return _brownfieldRubric;
}

let _brownfieldContractResults: typeof import("./lib/brownfield-contract-results") | null = null;
function getBrownfieldContractResults(): typeof import("./lib/brownfield-contract-results") {
  if (!_brownfieldContractResults) {
    _brownfieldContractResults = _require("./lib/brownfield-contract-results") as typeof import("./lib/brownfield-contract-results");
  }
  return _brownfieldContractResults;
}

let _hardScore: typeof import("./lib/hard-score") | null = null;
function getHardScore(): typeof import("./lib/hard-score") {
  if (!_hardScore) {
    _hardScore = _require("./lib/hard-score") as typeof import("./lib/hard-score");
  }
  return _hardScore;
}

/** Where `eval-results/` and `website/` live. */
const DEFAULT_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** A rubric id's form. Accepts classic, hard, and brownfield rubric IDs. */
const RUBRIC_ID_RE = /^maintenance-console(-hard|-brownfield)?@[0-9a-f]{12}$/;

// --- output shapes (including `modelFamily` / `familyAverages`) -------------

export interface CriterionResult {
  name: string;
  /** `null` on an info row whose Score cell is not a number — see change 3. */
  score: number | null;
  max: number;
  notes: string;
}

export interface AttemptResult {
  id: string;
  modelName: string;
  /** The benchmark id — effort suffix included, e.g. `gemini-36-flash-low`. */
  modelBaseId: string;
  /** The family the effort levels aggregate into, e.g. `gemini-36-flash`. */
  modelFamily: string;
  attemptNumber: number;
  totalScore: number;
  maxScore: number;
  percentage: number;
  agentEnvironment: string;
  /** Imputed USD, or `null` when no price or no token counts are available. */
  cost: number | null;
  criteria: CriterionResult[];
}

export interface ModelFamilyAverage {
  modelName: string;
  modelBaseId: string;
  averagePercentage: number;
  attemptCount: number;
  averageScore: number;
  averageMaxScore: number;
  agentEnvironment: string;
  pricing?: ModelPricing;
  averageCost: number | null;
  /**
   * Sum of the imputed costs — of the attempts that *have* one. An attempt with
   * no `run.json`, no token counts or no list price contributes nothing, so this
   * is not necessarily the cost of `attemptCount` attempts. `costCount` says how
   * many it does cover, and the card labels it.
   */
  totalCost: number | null;
  /** How many of `attemptCount` attempts contributed to the two cost figures. */
  costCount: number;
}

export interface ProcessedResults {
  generatedAt: string;
  totalAttempts: number;
  results: AttemptResult[];
  /** One entry per benchmark id — per (model, effort). */
  modelAverages: ModelFamilyAverage[];
  /** One entry per model family — the effort levels of a model, together. */
  familyAverages: ModelFamilyAverage[];
  supersededModels: Record<string, string>;
}

// Slim public payload served at /api/leaderboard.json. Preprocessed for
// display: superseded families are dropped and only the top N remain, so a
// consumer renders it as-is. Additive changes are fine on the same
// schemaVersion; breaking shape changes must bump it.
const LEADERBOARD_SCHEMA_VERSION = 1;
const LEADERBOARD_TOP_N = 10;

export interface LeaderboardPayload {
  schemaVersion: number;
  generatedAt: string;
  totalAttempts: number;
  /** Latest-only count before the top-N cut. */
  totalModels: number;
  leaderboard: ModelFamilyAverage[];
}

// --- the criteria table -----------------------------------------------------

const TIME_ROW = "Task completion time";
const TEST_RUN_ROW = "Test run";
const COST_ROW = "API cost";
const PENALTY_ROW = "Penalty";

/** Rows that carry information rather than a score. */
const INFO_ROWS: readonly string[] = [TIME_ROW, TEST_RUN_ROW, COST_ROW];
/** Rows excluded from the denominator. `Penalty` is subtracted, not averaged. */
const EXCLUDED_FROM_MAX: readonly string[] = [TIME_ROW, TEST_RUN_ROW, PENALTY_ROW, COST_ROW];

const CSV_COLUMNS = ["Criterion", "Score", "Max", "Notes"] as const;

/**
 * The 14 rows every `eval-results.csv` must carry: `RUBRIC_ROWS` in
 * `scripts/lib/rubric.ts`, the one place their names and maxima live, and what
 * `.claude/skills/agrav-score-attempt/SKILL.md` writes.
 *
 * The set is checked, not the order: nothing downstream depends on the order
 * (the dashboard regroups the rows anyway), but the *denominator* depends
 * entirely on which scored rows are present, and with which Max. A truncated
 * file would otherwise score out of a smaller max and publish a
 * plausible-looking percentage.
 */
const REQUIRED_ROWS: readonly string[] = RUBRIC_ROWS.map((row) => row.name);

/** Each rubric row by name: what its `Max` cell must read, and who fills its `Score`. */
const RUBRIC_ROW_BY_NAME: ReadonlyMap<string, RubricRow> = new Map(RUBRIC_ROWS.map((row) => [row.name, row]));

/**
 * Every row a `failureKind: "model"` attempt must set to 0: the scored rows and
 * `Penalty` (`benchmark/criteria.md`'s stop table). Checking only the hidden
 * rows let a model failure whose agent rows read `1` publish as 21.4%.
 */
const MODEL_FAILURE_ZERO_ROWS: readonly string[] = RUBRIC_ROWS.filter(
  (row) => row.max !== null || row.scoredBy === "penalty",
).map((row) => row.name);

/**
 * The one row that may appear beyond `REQUIRED_ROWS`. The judge never writes it
 * (Ruling P2) but a hand-edited CSV might; `dropStrayCostRow` removes it with a
 * warning, so it is tolerated here rather than rejected outright (Ruling R11).
 */
const TOLERATED_ROWS: readonly string[] = [COST_ROW];

/** The environment shown for a family whose attempts ran at several efforts. */
const MIXED_EFFORT_ENVIRONMENT = "Antigravity CLI";

/** What an info row's Score cell has to look like — the dashboard reads these formats literally. */
const INFO_ROW_FORMATS: ReadonlyMap<string, string> = new Map([
  [TIME_ROW, "expected the elapsed time as `Xmin Ys` (`5min 46s`) or `N/A`, not a number"],
  [TEST_RUN_ROW, "expected the run's date as `D.MM.YYYY HH:MM` (`16.04.2026 21:25`), not a number"],
]);

/**
 * Auto-scored rows whose Score is a continuous value in `[0, max]` rounded to
 * at most two decimal places, rather than the default binary `0` or `1`.
 *
 * Diff locality (brownfield track, spec §7.3 and `benchmark/criteria.md`)
 * computes a ratio: "rounded to two decimal places and clamped to [0, 1.0]".
 * Local build stays binary.
 */
const CONTINUOUS_AUTO_ROWS: ReadonlySet<string> = new Set(["Diff locality"]);

/**
 * Why a rubric row's `Score` is not one `benchmark/criteria.md` allows (its
 * "Score" bullet), or `null` when it is.
 *
 * Nothing bounded the Score before the Max check was joined by this one: a CSV
 * with `Local build,10,1` and `Penalty,-3,N/A` parsed to 26/14 and published as
 * 185.71%.
 */
function scoreCellProblem(row: RubricRow, score: number): string | null {
  const twoDecimalsAtMost = Number(score.toFixed(2)) === score;
  const halfStep = Number.isInteger(score * 2);
  switch (row.scoredBy) {
    case "auto": {
      // An info row holds a formatted value, not a score, so a number in its
      // Score cell is a format mistake and not a `Local build` out of range.
      // Only a number reaches here: `5min 46s`, `16.04.2026 21:25` and `N/A` all
      // parse as non-numeric and never get this far.
      const infoFmt = INFO_ROW_FORMATS.get(row.name);
      if (infoFmt !== undefined) return infoFmt;
      if (CONTINUOUS_AUTO_ROWS.has(row.name)) {
        const max = row.max ?? 0;
        if (score < 0 || score > max) return `expected a number from 0 to ${max}`;
        return twoDecimalsAtMost ? null : "expected at most two decimal places";
      }
      return score === 0 || score === 1 ? null : "expected 0 or 1";
    }
    case "hidden": {
      const max = row.max ?? 0;
      if (score < 0 || score > max) return `expected a number from 0 to ${max}`;
      return twoDecimalsAtMost ? null : "expected at most two decimals";
    }
    case "agent":
    case "human": {
      const max = row.max ?? 0;
      if (score < 0 || score > max) return `expected a number from 0 to ${max}`;
      return halfStep ? null : `expected ${max}, ${max / 2} or 0`;
    }
    case "penalty":
      if (score < 0 || score > 1) return "expected a number from 0 to 1";
      return halfStep ? null : "expected 0, 0.5 or 1";
  }
}

/** `null` unless the whole cell is a finite number. `"16.04.2026 21:25"` is not. */
function numericOrNull(cell: string): number | null {
  const text = cell.trim();
  if (text === "") return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/**
 * Parse one `eval-results.csv`.
 *
 * `where` names the file in every error message: a malformed score row is a
 * judging bug worth stopping for, because a silent 0 would look exactly like a
 * model that scored nothing.
 */
export function parseCriteriaCsv(
  csvContent: string,
  where = "eval-results.csv",
  rubricRows: readonly RubricRow[] = RUBRIC_ROWS,
): CriterionResult[] {
  let rows: Record<string, string>[];
  try {
    rows = parseCsv(csvContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
    }) as Record<string, string>[];
  } catch (error) {
    throw new Error(`${where}: could not parse as CSV: ${(error as Error).message}`);
  }

  // `columns: true` gives every row the header's keys, so one check covers all.
  for (const column of CSV_COLUMNS) {
    if (rows.length > 0 && !(column in rows[0])) {
      throw new Error(`${where}: missing the ${column} column (header must be ${CSV_COLUMNS.join(",")})`);
    }
  }

  const requiredRows = rubricRows.map((r) => r.name);
  const rubricRowByName: ReadonlyMap<string, RubricRow> = new Map(rubricRows.map((r) => [r.name, r]));

  const criteria: CriterionResult[] = [];
  for (const [index, row] of rows.entries()) {
    const name = row.Criterion.trim();
    if (name === "") continue;
    const notes = row.Notes ?? "";
    const isInfo = INFO_ROWS.includes(name);

    const score = numericOrNull(row.Score);
    if (score === null && !isInfo) {
      // "N/A" on a scored row means "not evaluated", which the rubric scores 0
      // — the hard-stop CSV is written that way. Anything else is malformed.
      if (row.Score.trim() !== "N/A") {
        throw new Error(
          `${where}: row ${index + 1} (${name}) has a non-numeric Score ${JSON.stringify(row.Score)}; ` +
            "expected a number or N/A",
        );
      }
    }

    let max = numericOrNull(row.Max);
    if (max === null) {
      if (row.Max.trim() !== "N/A" && row.Max.trim() !== "") {
        throw new Error(
          `${where}: row ${index + 1} (${name}) has a non-numeric Max ${JSON.stringify(row.Max)}; ` +
            "expected a number or N/A",
        );
      }
      // By convention an N/A max becomes 1. Every N/A-max row is excluded from
      // the denominator, so the value only ever reaches the dashboard's colour
      // helpers.
      max = 1;
    }

    const rubricRow = rubricRowByName.get(name);
    if (rubricRow !== undefined) {
      const expected = rubricRow.max;
      const cell = row.Max.trim();
      if (expected === null ? cell !== "N/A" : numericOrNull(cell) !== expected) {
        throw new Error(
          `${where}: row ${index + 1} (${name}) has Max ${JSON.stringify(cell)}; rubric.ts gives ` +
            `${expected === null ? "N/A" : expected}. The Max decides the denominator, so it must be the rubric's.`,
        );
      }
      // `N/A` on a scored row is the 0 the branch above already allowed.
      const problem = score === null ? null : scoreCellProblem(rubricRow, score);
      if (problem !== null) {
        throw new Error(
          `${where}: row ${index + 1} (${name}) has Score ${JSON.stringify(row.Score.trim())}; ${problem}. ` +
            "The Score is what the dashboard publishes and what the percentage is computed from, so it must be " +
            "one benchmark/criteria.md allows.",
        );
      }
    }

    criteria.push({
      name,
      score: isInfo ? score : (score ?? 0),
      max,
      // An info row's value lives in both columns; fall back to Score so a
      // note-less row still shows something rather than an empty cell.
      notes: isInfo && notes.trim() === "" ? row.Score.trim() : notes,
    });
  }

  requireContractRows(criteria, where, requiredRows);
  return criteria;
}

/**
 * Refuse a CSV whose row set is not the contract's.
 *
 * The columns being right says nothing about the rows, and a truncated or
 * hand-assembled file is the quietest way to a wrong number on the dashboard: a
 * header-only CSV scores 0 out of 0 and reads as a model that failed, while a
 * three-row one scores 100% on one criterion out of one. Both are the silent
 * zero the non-numeric-Score guard above exists to prevent, arriving by another
 * door — so the file stops the run and says what is wrong with it.
 *
 * Duplicates are refused for the same reason: `scoreAttempt` counts every row,
 * so two `Local build` rows would score the attempt out of 15.
 */
function requireContractRows(
  criteria: CriterionResult[],
  where: string,
  requiredRows: readonly string[] = REQUIRED_ROWS,
): void {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const criterion of criteria) {
    if (seen.has(criterion.name)) duplicates.push(criterion.name);
    seen.add(criterion.name);
  }
  if (duplicates.length > 0) {
    throw new Error(
      `${where}: duplicate row(s) ${duplicates.map((name) => JSON.stringify(name)).join(", ")}; ` +
        "every criterion appears exactly once, and a repeat would be counted twice",
    );
  }

  const missing = requiredRows.filter((name) => !seen.has(name));
  if (missing.length > 0) {
    throw new Error(
      `${where}: missing row(s) ${missing.map((name) => JSON.stringify(name)).join(", ")}. ` +
        `A CSV must carry all ${requiredRows.length} rows of rubric rows; a partial one ` +
        "would score out of a smaller denominator and publish a percentage that looks real. " +
        "Re-run the agrav-score-attempt skill for this attempt.",
    );
  }

  const unknown = [...seen].filter((name) => !requiredRows.includes(name) && !TOLERATED_ROWS.includes(name));
  if (unknown.length > 0) {
    throw new Error(
      `${where}: unrecognised row(s) ${unknown.map((name) => JSON.stringify(name)).join(", ")}. ` +
        "Criterion names are matched exactly, so a renamed or mis-cased row would be scored as an " +
        `extra criterion. Expected: ${requiredRows.join(", ")}.`,
    );
  }
}

/** `346000` → `5min 46s`. Always minutes: a 73-minute run is `73min 4s`. */
export function formatDuration(durationMs: number): string {
  const seconds = Math.round(durationMs / 1000);
  return `${Math.floor(seconds / 60)}min ${seconds % 60}s`;
}

/**
 * What the attempt's tokens would have cost at `pricing`, in USD.
 *
 * Two assumptions about the envelope's `usage` block hold this formula up —
 * that `reasoning_tokens` are a subset of `output_tokens`, and that
 * `input_tokens` are *exclusive* of `cache_read_tokens`. Both are written up on
 * `ModelPricing` in `eval-attempts/metadata.ts` with the one-envelope Phase 0
 * check that settles each; change the formula there and here together.
 */
export function imputedCost(usage: RunUsage, pricing: ModelPricing): number {
  return (
    (usage.input_tokens * pricing.input +
      usage.output_tokens * pricing.output +
      usage.cache_read_tokens * pricing.cacheRead) /
    1_000_000
  );
}

/** The three terms the cost formula charges for. Zero means "no cost to impute". */
function pricedTokens(usage: RunUsage): number {
  return usage.input_tokens + usage.output_tokens + usage.cache_read_tokens;
}

function tokenBreakdown(usage: RunUsage): string {
  return `in ${usage.input_tokens} / out ${usage.output_tokens} / cache read ${usage.cache_read_tokens}`;
}

/** Replace a row by name, or put it first when the CSV had none. */
function upsertRow(criteria: CriterionResult[], row: CriterionResult): void {
  const index = criteria.findIndex((criterion) => criterion.name === row.name);
  if (index === -1) criteria.unshift(row);
  else criteria[index] = row;
}

/**
 * Remove an `API cost` row the CSV should not have had.
 *
 * The judge writes no cost row (Ruling P2) — this script is the only thing that
 * produces one, imputed from `run.json`. A row already present means the CSV came
 * from somewhere else or was hand-edited, and its figure is not the one the
 * aggregates count. A dollar amount on the dashboard that no total includes is
 * worse than no amount, so it goes, loudly. (Ruling R11.)
 */
function dropStrayCostRow(criteria: CriterionResult[], dirName: string, warn: (message: string) => void): void {
  const index = criteria.findIndex((criterion) => criterion.name === COST_ROW);
  if (index === -1) return;
  const [dropped] = criteria.splice(index, 1);
  warn(
    `warning: ${dirName} — dropping the "API cost" row its eval-results.csv carries ` +
      `(${JSON.stringify(dropped.notes)}). The judge writes no cost row; the only cost this script ` +
      "publishes is imputed from run.json, so a hand-written one would show a figure no total counts.",
  );
}

/** Put the cost row just after `Test run`. */
function insertCostRow(criteria: CriterionResult[], row: CriterionResult): void {
  const after = [TEST_RUN_ROW, TIME_ROW]
    .map((name) => criteria.findIndex((criterion) => criterion.name === name))
    .find((index) => index !== -1);
  criteria.splice(after === undefined ? 0 : after + 1, 0, row);
}

/**
 * Overwrite the CSV's `Task completion time` with the harness's measurement and
 * add the imputed `API cost` row. The judge is told to derive the time from
 * `run.json` too, but this is the copy the dashboard shows, so it is taken from
 * the source of truth rather than trusted second-hand.
 */
function applyRunJson(
  criteria: CriterionResult[],
  runJson: RunJson | null,
  modelId: string,
  dirName: string,
  warn: (message: string) => void,
): number | null {
  const duration = runJson !== null && Number.isFinite(runJson.durationMs) ? formatDuration(runJson.durationMs) : "N/A";
  upsertRow(criteria, { name: TIME_ROW, score: null, max: 1, notes: duration });

  // Unconditional: a stray row goes even when there is nothing to impute in its
  // place, which is exactly the case where leaving it would be most misleading.
  dropStrayCostRow(criteria, dirName, warn);

  const usage = runJson?.envelope?.usage ?? null;
  if (usage === null) return null;

  const pricing = isModelId(modelId) ? MODEL_PRICING[modelId] : null;
  if (pricing === null || pricing === undefined) {
    // No defensible list price. The token counts are still worth showing, and
    // the dashboard renders this row as "N/A" because it holds no "$".
    insertCostRow(criteria, {
      name: COST_ROW,
      score: null,
      max: 1,
      notes: `N/A (no public list price for ${modelId}; ${tokenBreakdown(usage)})`,
    });
    return null;
  }

  // An envelope that reports no tokens at all is an anomaly, not a free run —
  // most likely agy reporting nothing for a subscription account. Publishing
  // `$0.00` for it would read as "this configuration was free" beside the three
  // that show nothing because they have no list price, when the truth is that
  // all of them are unknown. So a zero-token usage block is treated exactly like
  // a missing price: no figure, and a note that says which of the two it was.
  if (pricedTokens(usage) === 0) {
    insertCostRow(criteria, {
      name: COST_ROW,
      score: null,
      max: 1,
      notes: `N/A (envelope reported no billable tokens for ${modelId}; ${tokenBreakdown(usage)})`,
    });
    warn(
      `warning: ${dirName} — envelope.usage reports 0 input, 0 output and 0 cache-read tokens, so no cost ` +
        `is imputed for ${modelId}. If every attempt does this, agy is not reporting token counts for this ` +
        "account and the cost column cannot be published at all — check one envelope by hand (the smoke test, " +
        "docs/INSTRUKCJA-UZYTKOWNIKA.md §7.4).",
    );
    return null;
  }

  const cost = imputedCost(usage, pricing);
  insertCostRow(criteria, {
    name: COST_ROW,
    score: null,
    max: 1,
    notes: `$${cost.toFixed(4)} (imputed list-price estimate; ${tokenBreakdown(usage)})`,
  });
  return cost;
}

// --- scoring ----------------------------------------------------------------

export interface AttemptScore {
  totalScore: number;
  maxScore: number;
  percentage: number;
}

/**
 * The benchmark's score math. Four rows are outside the denominator, `Penalty`
 * comes off the total, and the percentage is the plain ratio.
 */
export function scoreAttempt(criteria: CriterionResult[]): AttemptScore {
  let totalScore = 0;
  let maxScore = 0;
  for (const criterion of criteria) {
    if (EXCLUDED_FROM_MAX.includes(criterion.name)) continue;
    totalScore += criterion.score ?? 0;
    maxScore += criterion.max;
  }

  const penalty = criteria.find((criterion) => criterion.name === PENALTY_ROW);
  if (penalty !== undefined) totalScore -= penalty.score ?? 0;

  return {
    totalScore,
    maxScore,
    percentage: maxScore > 0 ? (totalScore / maxScore) * 100 : 0,
  };
}

// --- aggregation ------------------------------------------------------------

interface AggregateGroup {
  modelName: string;
  modelBaseId: string;
  environments: Set<string>;
  pricing?: ModelPricing;
  totalScore: number;
  totalMaxScore: number;
  totalPercentage: number;
  count: number;
  costSum: number;
  costCount: number;
}

/**
 * Average the attempts grouped by `keyOf`. Grouping is always by id — never by
 * display name, which two configurations can share.
 */
function averagesBy(
  results: AttemptResult[],
  keyOf: (result: AttemptResult) => { key: string; modelName: string; modelBaseId: string },
): ModelFamilyAverage[] {
  const groups = new Map<string, AggregateGroup>();

  for (const result of results) {
    const { key, modelName, modelBaseId } = keyOf(result);
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        modelName,
        modelBaseId,
        environments: new Set<string>(),
        pricing: isModelId(result.modelBaseId) ? (MODEL_PRICING[result.modelBaseId] ?? undefined) : undefined,
        totalScore: 0,
        totalMaxScore: 0,
        totalPercentage: 0,
        count: 0,
        costSum: 0,
        costCount: 0,
      };
      groups.set(key, group);
    }
    group.environments.add(result.agentEnvironment);
    group.totalScore += result.totalScore;
    group.totalMaxScore += result.maxScore;
    group.totalPercentage += result.percentage;
    group.count += 1;
    if (result.cost !== null) {
      group.costSum += result.cost;
      group.costCount += 1;
    }
  }

  const averages = Array.from(groups.values()).map((group) => ({
    modelName: group.modelName,
    modelBaseId: group.modelBaseId,
    averageScore: group.totalScore / group.count,
    averageMaxScore: group.totalMaxScore / group.count,
    averagePercentage: group.totalPercentage / group.count,
    attemptCount: group.count,
    // A family spanning several effort levels has no single environment.
    agentEnvironment: group.environments.size === 1 ? [...group.environments][0] : MIXED_EFFORT_ENVIRONMENT,
    // Omitted rather than set to undefined, so the in-memory object and the
    // JSON on disk have the same keys.
    ...(group.pricing !== undefined ? { pricing: group.pricing } : {}),
    averageCost: group.costCount > 0 ? group.costSum / group.costCount : null,
    totalCost: group.costCount > 0 ? group.costSum : null,
    costCount: group.costCount,
  }));

  averages.sort((a, b) => b.averagePercentage - a.averagePercentage || a.modelBaseId.localeCompare(b.modelBaseId));
  return averages;
}

// --- processing -------------------------------------------------------------

export interface ProcessOptions {
  /** Directory holding `<id>-attempt-<n>/` result directories. */
  resultsDir: string;
  /** Where `ProcessedResults` is written. */
  resultsJsonPath: string;
  /** Where `LeaderboardPayload` is written. */
  leaderboardJsonPath: string;
  /** Where warnings go. Defaults to stderr. */
  warn?: (message: string) => void;
  /**
   * The rubric id whose attempts are published; anything without the id's
   * form is refused. An attempt whose own contract-results.json records
   * another well-formed id is skipped with a warning, and its whole
   * configuration, model failures included, is withheld: scores under two ids
   * are not comparable. Default: `rubricId()` of this repository.
   */
  rubric?: string;
  /** Custom rubric rows. Default: RUBRIC_ROWS. */
  rubricRows?: readonly RubricRow[];
}

export interface ProcessOutcome {
  results: ProcessedResults;
  leaderboard: LeaderboardPayload;
}

/**
 * Read every attempt under `resultsDir` and write both output documents.
 *
 * An empty or missing `resultsDir` is not an error: CI has to be able to build
 * the dashboard before the first attempt has ever run.
 */
export function processResults(options: ProcessOptions): ProcessOutcome {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const rubric = options.rubric ?? rubricId(DEFAULT_ROOT);
  const rubricRows = options.rubricRows ?? RUBRIC_ROWS;
  if (!RUBRIC_ID_RE.test(rubric)) {
    throw new Error(`rubric must be a rubric id, maintenance-console@ and 12 hex digits; got ${JSON.stringify(rubric)}`);
  }
  const attempts: AttemptResult[] = [];
  /** Configuration → how many of its attempts were scored under another rubric id. */
  const otherEra = new Map<string, number>();

  for (const dirName of listAttemptDirs(options.resultsDir, warn)) {
    const attempt = readAttempt(options.resultsDir, dirName, warn, rubric, rubricRows);
    if (attempt === OTHER_RUBRIC) {
      const config = parseAttemptDirName(dirName)!.modelId;
      otherEra.set(config, (otherEra.get(config) ?? 0) + 1);
    } else if (attempt !== null) {
      attempts.push(attempt);
    }
  }

  // A configuration with an attempt from another era is withheld whole. Its
  // model failures carry no era and would otherwise be published without their
  // skipped siblings, reporting the configuration by its failures alone.
  for (const [config, count] of otherEra) {
    warn(
      `warning: ${config}: withheld, ${count} attempt(s) scored under another rubric id; ` +
        `re-score them under ${rubric} to publish it.`,
    );
  }
  const results = attempts.filter((attempt) => !otherEra.has(attempt.modelBaseId));

  results.sort((a, b) => b.percentage - a.percentage || a.id.localeCompare(b.id));

  const modelAverages = averagesBy(results, (result) => ({
    key: result.modelBaseId,
    modelName: result.modelName,
    modelBaseId: result.modelBaseId,
  }));
  const familyAverages = averagesBy(results, (result) => ({
    key: result.modelFamily,
    modelName: FAMILY_NAMES[result.modelFamily] ?? result.modelFamily,
    modelBaseId: result.modelFamily,
  }));

  const processed: ProcessedResults = {
    generatedAt: new Date().toISOString(),
    totalAttempts: results.length,
    results,
    modelAverages,
    familyAverages,
    supersededModels: Object.fromEntries(Object.entries(SUPERSEDED_MODELS) as [string, string][]),
  };

  const supersededIds = new Set(Object.keys(SUPERSEDED_MODELS));
  const latestOnly = modelAverages.filter((average) => !supersededIds.has(average.modelBaseId));
  const leaderboard: LeaderboardPayload = {
    schemaVersion: LEADERBOARD_SCHEMA_VERSION,
    generatedAt: processed.generatedAt,
    totalAttempts: processed.totalAttempts,
    totalModels: latestOnly.length,
    leaderboard: latestOnly.slice(0, LEADERBOARD_TOP_N),
  };

  writeJson(options.resultsJsonPath, processed);
  writeJson(options.leaderboardJsonPath, leaderboard);

  return { results: processed, leaderboard };
}

/** Attempt directories, sorted, so a run's output does not depend on readdir order. */
function listAttemptDirs(resultsDir: string, warn: (message: string) => void): string[] {
  if (!existsSync(resultsDir)) {
    warn(`warning: ${resultsDir} does not exist; writing empty results.`);
    return [];
  }
  let entries: Dirent[];
  try {
    entries = readdirSync(resultsDir, { withFileTypes: true });
  } catch (error) {
    // Unreadable is not the same as absent, and neither should end the run: an
    // empty dashboard with a warning beats a stack trace.
    warn(`warning: cannot list ${resultsDir} (${(error as Error).message}); writing empty results.`);
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (parseAttemptDirName(entry.name) === null) {
      warn(
        `warning: ignoring ${join(resultsDir, entry.name)} — not an attempt directory name ` +
          "(expected <id>-attempt-<n>, lowercase, no underscores).",
      );
      continue;
    }
    names.push(entry.name);
  }
  return names.sort();
}

/** What `readAttempt` returns for an attempt scored under another rubric id: it withholds its configuration. */
const OTHER_RUBRIC = "other-rubric";

/** One attempt; `OTHER_RUBRIC` when it was scored under another rubric id; or `null` when it is not a data point. */
function readAttempt(
  resultsDir: string,
  dirName: string,
  warn: (message: string) => void,
  rubric: string,
  rubricRows: readonly RubricRow[] = RUBRIC_ROWS,
): AttemptResult | typeof OTHER_RUBRIC | null {
  const parsed = parseAttemptDirName(dirName)!;
  const modelId = parsed.modelId;
  if (DISABLED_MODELS.has(modelId)) {
    // Every other odd input in this function warns. Dropping a whole family in
    // silence is how somebody ends up asking why the dashboard is missing rows
    // whose CSVs are plainly on disk.
    warn(
      `warning: skipping ${dirName} — "${modelId}" is in DISABLED_MODELS (eval-attempts/metadata.ts). ` +
        "Its results stay on disk and are excluded from the dashboard; remove the id there to publish it again.",
    );
    return null;
  }

  const runJsonPath = join(resultsDir, dirName, "run.json");
  const runJsonExists = existsSync(runJsonPath);
  let runJson = runJsonExists ? readRunJsonOrWarn(runJsonPath, warn) : null;
  // The one thing `readRunJson` cannot check: that this file belongs to this
  // directory. The model id comes from the dirname and `runJson.id` is never
  // read, so a run.json copied into the wrong attempt directory — a plausible
  // hand-edit during a partial re-run — would impute another configuration's
  // duration and cost here with nothing to show for it. Checked before the
  // infra check below, so a foreign file cannot skip this attempt either.
  if (runJson !== null && runJson.id !== modelId) {
    warn(
      `warning: ${runJsonPath} records id "${runJson.id}" but sits in a "${modelId}" attempt directory. ` +
        "Ignoring it: task completion time and cost will be unavailable rather than taken from another " +
        "configuration's run. Move the file to the directory it belongs to, or delete it and re-run the attempt.",
    );
    runJson = null;
  }
  if (runJson?.failureKind === "infra") {
    // The runner leaves these behind between a stop and a rerun. Scoring one
    // would publish a zero for a run that never told us anything about a model.
    warn(`warning: skipping ${dirName} — run.json records an infrastructure failure, not a data point.`);
    return null;
  }
  if (runJson === null) {
    // "Rejected" and "absent" are different problems: a rejected file may
    // record an infra failure this attempt should have been skipped for, and
    // that skip is now unreachable.
    warn(
      runJsonExists
        ? `warning: ${dirName} has a run.json that was rejected as malformed; task completion time and cost ` +
            "will be unavailable, and an infrastructure failure recorded in it cannot be honoured."
        : `warning: ${dirName} has no run.json; task completion time and cost will be unavailable.`,
    );
  }

  if (!isModelId(modelId)) {
    // Every other odd input here warns; publishing an unknown id silently would
    // put a row on the leaderboard with a raw id for a name and a family of one.
    warn(
      `warning: ${dirName} — "${modelId}" is not a known benchmark id. Publishing it with its raw id as ` +
        "the display name, a family of its own and an unknown environment. Add it to " +
        "eval-attempts/metadata.ts and benchmark/runner.yaml, or remove the directory.",
    );
  }

  // Only `eval-results.csv`: this repo's judge writes one name, and a stray
  // variant such as `eval-result.csv` here would mean a bug worth seeing.
  const csvPath = join(resultsDir, dirName, "eval-results.csv");
  if (!existsSync(csvPath)) {
    warn(`warning: no eval-results.csv in ${dirName}; skipping. Score it with the agrav-score-attempt skill.`);
    return null;
  }

  let csvContent: string;
  try {
    csvContent = readFileSync(csvPath, "utf8");
  } catch (error) {
    // Present but unreadable — a permissions problem with one attempt should
    // not take the other eight down with it.
    warn(`warning: cannot read ${csvPath} (${(error as Error).message}); skipping ${dirName}.`);
    return null;
  }

  // Before the CSV is parsed: an older era's CSV may not fit today's rows either.
  const otherRubric = otherRubricOf(join(resultsDir, dirName), dirName, runJson, rubric);
  if (otherRubric !== null) {
    warn(
      `warning: skipping ${dirName} — scored under rubric ${otherRubric}, and this run publishes ${rubric}. ` +
        "Scores under two rubric ids are not comparable; re-score the attempt to publish it.",
    );
    return OTHER_RUBRIC;
  }

  const criteria = parseCriteriaCsv(csvContent, csvPath, rubricRows);
  if (rubric.startsWith("maintenance-console-brownfield")) {
    requireBrownfieldHiddenRowsAgree(join(resultsDir, dirName), dirName, criteria, runJson, rubric);
  } else if (rubric.startsWith("maintenance-console-hard")) {
    requireHardHiddenRowsAgree(join(resultsDir, dirName), dirName, criteria, runJson, rubric);
  } else {
    requireHiddenRowsAgree(join(resultsDir, dirName), dirName, criteria, runJson, rubric);
  }
  const cost = applyRunJson(criteria, runJson, modelId, dirName, warn);
  const { totalScore, maxScore, percentage } = scoreAttempt(criteria);

  return {
    id: dirName,
    modelName: isModelId(modelId) ? AGENT_NAMES[modelId] : modelId,
    // The same value `getModelBaseId(dirName)` returns — taken from the shared
    // attempt-name helper so the grammar lives in exactly one place.
    modelBaseId: modelId,
    modelFamily: isModelId(modelId) ? MODEL_FAMILY[modelId] : modelId,
    attemptNumber: parsed.attempt,
    totalScore,
    maxScore,
    percentage,
    agentEnvironment: isModelId(modelId) ? AGENT_ENV[modelId] : "Unknown",
    cost,
    criteria,
  };
}

/**
 * The era check, run before the CSV is parsed: the rubric id this attempt's
 * own contract-results.json records, when it is a well-formed id other than
 * `rubric`, and `null` otherwise. Such an attempt is skipped (operator
 * decision 4): scores under two ids are not comparable, and an older era's
 * file may fit neither today's manifest nor today's rows. Everything else —
 * no file, a file that is not JSON, a `rubric` that is no rubric id, another
 * attempt's file under any id — is `null`, left to `requireHiddenRowsAgree`,
 * which stops the run. A model failure needs no file and has no era, so it is
 * never skipped here; `processResults` withholds it with its configuration.
 */
function otherRubricOf(attemptDir: string, dirName: string, runJson: RunJson | null, rubric: string): string | null {
  if (runJson?.failureKind === "model") return null;
  const isBrownfield = rubric.startsWith("maintenance-console-brownfield");
  const isHard = rubric.startsWith("maintenance-console-hard");
  const filename = isBrownfield
    ? "contract-results-brownfield.json"
    : isHard
      ? getHardScore().HIDDEN_RESULTS_FILE
      : CONTRACT_RESULTS_FILE;
  const path = join(attemptDir, filename);
  if (!existsSync(path)) return null;
  let recorded: unknown;
  let recordedAttempt: unknown;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { rubric?: unknown; attempt?: unknown };
    recorded = raw.rubric;
    recordedAttempt = raw.attempt;
  } catch {
    return null; // requireHiddenRowsAgree / requireHardHiddenRowsAgree / requireBrownfieldHiddenRowsAgree says what is wrong
  }
  if (typeof recorded === "string" && RUBRIC_ID_RE.test(recorded) && recorded !== rubric && recordedAttempt === dirName) {
    return recorded;
  }
  return null;
}

/**
 * Spec §5: the four hidden-test rows are the ones contract-results.json gives.
 *
 * A model failure (`failureKind: "model"`) never reached the tests, so it
 * needs no file, and the stop table makes every scored row and `Penalty` 0 —
 * checked here, because a model failure with a `1` anywhere would otherwise
 * publish as a real data point. Every other attempt needs its
 * file: this attempt's, valid against the current manifest, recorded under
 * `rubric`, with each hidden row's Score equal to its group's score. A missing
 * or rejected run.json is no excuse. Missing, invalid, another attempt's, or
 * disagreeing: the run stops, as for a malformed CSV. The one soft case, this
 * attempt's own file under another well-formed rubric id, never gets here:
 * `otherRubricOf` skipped it before the CSV was parsed.
 */
function requireHiddenRowsAgree(
  attemptDir: string,
  dirName: string,
  criteria: CriterionResult[],
  runJson: RunJson | null,
  rubric: string,
): void {
  const scoreOf = (name: string): number => criteria.find((entry) => entry.name === name)?.score ?? 0;

  if (runJson?.failureKind === "model") {
    const nonZero = MODEL_FAILURE_ZERO_ROWS.filter((name) => scoreOf(name) !== 0);
    if (nonZero.length > 0) {
      throw new Error(
        `${dirName}: run.json records a model failure, so every scored row and Penalty must be 0: ` +
          `${nonZero.map((name) => `${JSON.stringify(name)} is ${scoreOf(name)}`).join(", ")}. Re-run the agrav-score-attempt skill.`,
      );
    }
    return;
  }

  const path = join(attemptDir, CONTRACT_RESULTS_FILE);
  if (!existsSync(path)) {
    throw new Error(
      `${dirName}: no ${CONTRACT_RESULTS_FILE} beside eval-results.csv. The four hidden-test rows come from it ` +
        "(contract-results --rows), so without it they cannot be checked. Run contract-tests for this attempt, " +
        "then the agrav-score-attempt skill.",
    );
  }
  const text = readFileSync(path, "utf8");
  let results;
  try {
    results = parseContractResults(text);
  } catch (error) {
    throw new Error(`${path}: ${(error as Error).message}`);
  }
  if (results.attempt !== dirName) {
    throw new Error(`${path} records attempt ${JSON.stringify(results.attempt)}, not ${dirName}: it belongs to another attempt.`);
  }
  // Unreachable while RUBRIC_ID_RE and parseContractResults agree on an id's
  // form; if they drift, another era must stop here rather than be published.
  if (results.rubric !== rubric) {
    throw new Error(
      `${path} records rubric ${results.rubric}, not the published ${rubric}, and was not skipped as another era. ` +
        "RUBRIC_ID_RE in scripts/process-results.ts must match the rubric pattern in scripts/lib/contract-results.ts.",
    );
  }
  const disagreements = results.groups
    .filter((group) => scoreOf(group.row) !== group.score)
    .map((group) => `${JSON.stringify(group.row)} is ${scoreOf(group.row)} in eval-results.csv but ${group.score} in ${CONTRACT_RESULTS_FILE}`);
  if (disagreements.length > 0) {
    throw new Error(
      `${dirName}: ${disagreements.join("; ")}. The hidden-test rows are pasted from contract-results --rows, ` +
        "never typed; re-run the agrav-score-attempt skill.",
    );
  }
}

/**
 * Hard track hidden rows check.
 *
 * Every hidden row from eval-results.csv must match hidden-results-hard.json.
 * A model failure needs no file, but all scored hard rows and Penalty must be 0.
 */
function requireHardHiddenRowsAgree(
  attemptDir: string,
  dirName: string,
  criteria: CriterionResult[],
  runJson: RunJson | null,
  rubric: string,
): void {
  const scoreOf = (name: string): number => criteria.find((entry) => entry.name === name)?.score ?? 0;
  const { HARD_RUBRIC_ROWS } = _require("./lib/hard-rubric") as typeof import("./lib/hard-rubric");

  if (runJson?.failureKind === "model") {
    const modelFailureZeroRows = HARD_RUBRIC_ROWS.filter(
      (row) => row.max !== null || row.scoredBy === "penalty",
    ).map((row) => row.name);
    const nonZero = modelFailureZeroRows.filter((name) => scoreOf(name) !== 0);
    if (nonZero.length > 0) {
      throw new Error(
        `${dirName}: run.json records a model failure, so every scored row and Penalty must be 0: ` +
          `${nonZero.map((name) => `${JSON.stringify(name)} is ${scoreOf(name)}`).join(", ")}. Re-score the attempt.`,
      );
    }
    return;
  }

  const { HIDDEN_RESULTS_FILE, parseHardHiddenResults } = getHardScore();
  const path = join(attemptDir, HIDDEN_RESULTS_FILE);
  if (!existsSync(path)) {
    throw new Error(
      `${dirName}: no ${HIDDEN_RESULTS_FILE} beside eval-results.csv. The hidden-test rows come from it, ` +
        "so without it they cannot be checked. Re-score the attempt with score-hard.ts.",
    );
  }
  const text = readFileSync(path, "utf8");
  let results;
  try {
    results = parseHardHiddenResults(text);
  } catch (error) {
    throw new Error(`${path}: ${(error as Error).message}`);
  }
  if (results.attempt !== dirName) {
    throw new Error(`${path} records attempt ${JSON.stringify(results.attempt)}, not ${dirName}: it belongs to another attempt.`);
  }
  // Unreachable while RUBRIC_ID_RE and parseHardHiddenResults agree on an id's
  // form; if they drift, another era must stop here rather than be published.
  if (results.rubric !== rubric) {
    throw new Error(
      `${path} records rubric ${results.rubric}, not the published ${rubric}, and was not skipped as another era. ` +
        "RUBRIC_ID_RE in scripts/process-results.ts must match the rubric pattern in scripts/lib/hard-rubric.ts.",
    );
  }
  // Every hidden row must appear exactly once in the file.
  const HARD_HIDDEN_ROWS = HARD_RUBRIC_ROWS.filter((r) => r.scoredBy === "hidden");
  const rowCounts = new Map<string, number>();
  for (const { row } of results.rows) rowCounts.set(row, (rowCounts.get(row) ?? 0) + 1);
  const missing = HARD_HIDDEN_ROWS.filter((r) => !rowCounts.has(r.name)).map((r) => r.name);
  if (missing.length > 0) {
    throw new Error(
      `${dirName}: ${HIDDEN_RESULTS_FILE} is missing hidden row(s): ${missing.map((n) => JSON.stringify(n)).join(", ")}. ` +
        "Re-score the attempt with score-hard.ts.",
    );
  }
  const duplicated = HARD_HIDDEN_ROWS.filter((r) => (rowCounts.get(r.name) ?? 0) > 1).map((r) => r.name);
  if (duplicated.length > 0) {
    throw new Error(
      `${dirName}: ${HIDDEN_RESULTS_FILE} has duplicate hidden row(s): ${duplicated.map((n) => JSON.stringify(n)).join(", ")}. ` +
        "Re-score the attempt with score-hard.ts.",
    );
  }
  const disagreements = results.rows
    .filter((row) => scoreOf(row.row) !== row.score)
    .map((row) => `${JSON.stringify(row.row)} is ${scoreOf(row.row)} in eval-results.csv but ${row.score} in ${HIDDEN_RESULTS_FILE}`);
  if (disagreements.length > 0) {
    throw new Error(
      `${dirName}: ${disagreements.join("; ")}. The hidden-test rows come from ${HIDDEN_RESULTS_FILE}, ` +
        "never typed; re-score the attempt with score-hard.ts.",
    );
  }
}

/**
 * Brownfield track hidden and automated rows check.
 *
 * Regression, Change suite and Diff locality from eval-results.csv must match
 * values from contract-results-brownfield.json. A model failure needs no file,
 * but all scored brownfield rows and Penalty must be 0.
 */
function requireBrownfieldHiddenRowsAgree(
  attemptDir: string,
  dirName: string,
  criteria: CriterionResult[],
  runJson: RunJson | null,
  rubric: string,
): void {
  const scoreOf = (name: string): number => criteria.find((entry) => entry.name === name)?.score ?? 0;
  const { BROWNFIELD_RUBRIC_ROWS } = getBrownfieldRubric();

  if (runJson?.failureKind === "model") {
    const modelFailureZeroRows = BROWNFIELD_RUBRIC_ROWS.filter(
      (row) => row.max !== null || row.scoredBy === "penalty",
    ).map((row) => row.name);
    const nonZero = modelFailureZeroRows.filter((name) => scoreOf(name) !== 0);
    if (nonZero.length > 0) {
      throw new Error(
        `${dirName}: run.json records a model failure, so every scored row and Penalty must be 0: ` +
          `${nonZero.map((name) => `${JSON.stringify(name)} is ${scoreOf(name)}`).join(", ")}. Re-run the agrav-score-brownfield skill.`,
      );
    }
    return;
  }

  const { parseBrownfieldResult, BROWNFIELD_RESULTS_FILE } = getBrownfieldContractResults();
  const path = join(attemptDir, BROWNFIELD_RESULTS_FILE);
  if (!existsSync(path)) {
    throw new Error(
      `${dirName}: no ${BROWNFIELD_RESULTS_FILE} beside eval-results.csv. The hidden-test and locality rows come from it ` +
        "(contract-results-brownfield), so without it they cannot be checked. Run contract-tests-brownfield for this attempt, " +
        "then the agrav-score-brownfield skill.",
    );
  }
  const text = readFileSync(path, "utf8");
  let results;
  try {
    results = parseBrownfieldResult(text);
  } catch (error) {
    throw new Error(`${path}: ${(error as Error).message}`);
  }
  if (results.attempt !== dirName) {
    throw new Error(`${path} records attempt ${JSON.stringify(results.attempt)}, not ${dirName}: it belongs to another attempt.`);
  }
  if (results.rubric !== rubric) {
    throw new Error(
      `${path} records rubric ${results.rubric}, not the published ${rubric}, and was not skipped as another era. ` +
        "RUBRIC_ID_RE in scripts/process-results.ts must match the rubric pattern in scripts/lib/brownfield-contract-results.ts.",
    );
  }
  const expectedScores: Array<{ row: string; expected: number }> = [
    { row: "Regression", expected: results.regression.score },
    { row: "Change suite", expected: results.changeSuite.score },
    { row: "Diff locality", expected: results.diffLocality.score },
  ];
  const disagreements = expectedScores
    .filter(({ row, expected }) => scoreOf(row) !== expected)
    .map(({ row, expected }) => `${JSON.stringify(row)} is ${scoreOf(row)} in eval-results.csv but ${expected} in ${BROWNFIELD_RESULTS_FILE}`);
  if (disagreements.length > 0) {
    throw new Error(
      `${dirName}: ${disagreements.join("; ")}. The contract-test rows are pasted from contract-results-brownfield, ` +
        "never typed; re-run the agrav-score-brownfield skill.",
    );
  }
}

/** Read an existing `run.json`, or warn and return `null` if it is malformed. */
function readRunJsonOrWarn(path: string, warn: (message: string) => void): RunJson | null {
  try {
    return readRunJson(path);
  } catch (error) {
    warn(`warning: ${(error as Error).message}`);
    return null;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

// --- CLI --------------------------------------------------------------------

const USAGE = `Usage: npm run process-results -- [options]

Options:
  --results-dir <path>  Directory of <id>-attempt-<n>/ result directories.
                        Default: <root>/eval-results.
  --root <path>         Repo root holding eval-results/ and website/.
                        Default: the repo this script lives in.
  --rubric <id>         Publish the attempts scored under this rubric id,
                        provided the hidden tests and their manifest have not
                        changed since; otherwise re-score the attempts.
                        Default: the id of this repository's rubric files.
  --track <classic|hard|brownfield>
                        Which benchmark track to process.
                        classic:    contract-results.json → results.json + api/leaderboard.json
                        hard:       contract-results-hard.json → results-hard.json + api/leaderboard-hard.json
                        brownfield: contract-results-brownfield.json → results-brownfield.json + api/leaderboard-brownfield.json
                        Default: classic.
  --help                Print this message.
`;

interface CliArgs {
  resultsDir?: string;
  root?: string;
  rubric?: string;
  track: "classic" | "hard" | "brownfield";
  help: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { track: "classic", help: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const eq = token.indexOf("=");
    const name = token.startsWith("--") && eq !== -1 ? token.slice(0, eq) : token;
    const inlineValue = token.startsWith("--") && eq !== -1 ? token.slice(eq + 1) : undefined;
    const takeValue = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[++i];
      if (next === undefined) throw new Error(`${name} needs a value`);
      return next;
    };
    switch (name) {
      case "--results-dir":
        args.resultsDir = resolve(takeValue());
        break;
      case "--root":
        args.root = resolve(takeValue());
        break;
      case "--rubric":
        args.rubric = takeValue();
        if (!RUBRIC_ID_RE.test(args.rubric)) {
          throw new Error(`--rubric needs a rubric id, maintenance-console@ and 12 hex digits; got ${JSON.stringify(args.rubric)}`);
        }
        break;
      case "--track": {
        const v = takeValue();
        if (v !== "classic" && v !== "hard" && v !== "brownfield") {
          throw new Error(`--track must be "classic", "hard" or "brownfield"; got ${JSON.stringify(v)}`);
        }
        args.track = v;
        break;
      }
      case "--":
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        throw new Error(`unknown argument ${JSON.stringify(token)}\n\n${USAGE}`);
    }
  }
  return args;
}

export function main(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const root = args.root ?? DEFAULT_ROOT;

  if (args.track === "hard") {
    return mainHard(args, root);
  }
  if (args.track === "brownfield") {
    return mainBrownfield(args, root);
  }

  // Classic track (default) — behavior identical to before
  const resultsJsonPath = join(root, "website", "src", "data", "results.json");
  const leaderboardJsonPath = join(root, "website", "public", "api", "leaderboard.json");
  // DEFAULT_ROOT, not `root`: the rubric files hashed here are this script's
  // own repository's, and so is the manifest `parseContractResults` validates
  // against. A `--root` pointing at a bare results tree has no prompt.md.
  const rubric = args.rubric ?? rubricId(DEFAULT_ROOT);
  const { results } = processResults({
    resultsDir: args.resultsDir ?? join(root, "eval-results"),
    resultsJsonPath,
    leaderboardJsonPath,
    rubric,
  });

  printSummary(resultsJsonPath, leaderboardJsonPath, rubric, results);
  return 0;
}

function mainBrownfield(args: CliArgs, root: string): number {
  const { BROWNFIELD_RUBRIC_ROWS, brownfieldRubricId } = getBrownfieldRubric();

  const resultsJsonPath = join(root, "website", "src", "data", "results-brownfield.json");
  const leaderboardJsonPath = join(root, "website", "public", "api", "leaderboard-brownfield.json");
  const rubric = args.rubric ?? brownfieldRubricId(DEFAULT_ROOT);

  const { results } = processResults({
    resultsDir: args.resultsDir ?? join(root, "tracks", "brownfield", "eval-results"),
    resultsJsonPath,
    leaderboardJsonPath,
    rubric,
    rubricRows: BROWNFIELD_RUBRIC_ROWS,
  });

  printSummary(resultsJsonPath, leaderboardJsonPath, rubric, results);
  return 0;
}

function mainHard(args: CliArgs, root: string): number {
  // Dynamic import of hard-rubric — use createRequire for synchronous loading in ESM
  const { HARD_RUBRIC_ROWS, hardRubricId } = _require("./lib/hard-rubric") as typeof import("./lib/hard-rubric");

  const resultsJsonPath = join(root, "website", "src", "data", "results-hard.json");
  const leaderboardJsonPath = join(root, "website", "public", "api", "leaderboard-hard.json");
  const rubric = args.rubric ?? hardRubricId(DEFAULT_ROOT);

  const { results } = processResults({
    resultsDir: args.resultsDir ?? join(root, "tracks", "console-hard", "eval-results"),
    resultsJsonPath,
    leaderboardJsonPath,
    rubric,
    rubricRows: HARD_RUBRIC_ROWS,
  });

  printSummary(resultsJsonPath, leaderboardJsonPath, rubric, results);
  return 0;
}

function printSummary(resultsJsonPath: string, leaderboardJsonPath: string, rubric: string, results: ProcessedResults): void {
  console.log(`✓ Generated ${resultsJsonPath}`);
  console.log(`✓ Generated ${leaderboardJsonPath}`);

  console.log(`\nRubric: ${rubric}`);

  console.log(`\nPer-config averages (${results.modelAverages.length}):`);
  for (const average of results.modelAverages) {
    console.log(
      `  ${average.modelName}: ${average.averageScore.toFixed(1)}/${average.averageMaxScore.toFixed(1)} ` +
        `(${average.averagePercentage.toFixed(1)}%) [${average.attemptCount} attempt(s)]`,
    );
  }

  console.log(`\nModel family averages (${results.familyAverages.length}):`);
  for (const average of results.familyAverages) {
    console.log(
      `  ${average.modelName}: ${average.averageScore.toFixed(1)}/${average.averageMaxScore.toFixed(1)} ` +
        `(${average.averagePercentage.toFixed(1)}%) [${average.attemptCount} attempt(s)]`,
    );
  }
}

// Guarded so a test can import the parser and the score math without the script
// writing anything.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`process-results: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
