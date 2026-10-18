import type {
  AttemptResult,
  CriterionResult,
  ModelFamilyAverage,
} from "../data/types";

export const isTimeRow = (name: string) => name === "Task completion time";
export const isTestRunRow = (name: string) => name === "Test run";
export const isCostRow = (name: string) => name === "API cost";
export const isPenaltyRow = (name: string) => name === "Penalty";
export const isInfoRow = (name: string) =>
  isTimeRow(name) || isTestRunRow(name) || isCostRow(name);

/**
 * The four rows the hidden contract tests score, in CSV order. `HIDDEN_ROWS` in
 * `scripts/lib/rubric.ts` is the source; `test/website-contracts.test.ts` keeps
 * this copy equal to it, since the website package cannot import `scripts/`.
 */
export const HIDDEN_TEST_ROWS: readonly string[] = [
  "API contract",
  "Planner: assignment rules",
  "Planner: ordering & determinism",
  "Planner: parts & blocking",
];

/** The agent row the "Tech stack" filter keys on (`RUBRIC_ROWS`, same test). */
export const TECH_STACK_ROW = "Tech stack & run contract";

/**
 * What a criterion is called on screen.
 *
 * The CSV row is named `API cost` and stays that way in the data — `process-results.ts`
 * adds it from `run.json` (Ruling P2), and the dashboard parses it back. But
 * the account running this benchmark is an Antigravity subscription: no attempt
 * was ever billed the figure in that row, which is imputed from published list
 * prices at the run's token counts. The label says so wherever it is shown.
 */
export function criterionLabel(name: string): string {
  return isCostRow(name) ? COST_LABEL : name;
}

export const COST_LABEL = "Est. cost (list price)";

export const COST_DISCLAIMER =
  "Imputed from published list prices at this run's token counts. " +
  "The account is an Antigravity subscription metered by weekly quota, so no attempt was billed this amount.";

export const NO_PRICE_NOTE =
  "No public list price for this model, so no cost is imputed. The token counts below are measured.";

/**
 * Format a USD cost as a compact "$0.43" string.
 *
 * A cost that rounds to zero renders `<$0.01`, never `$0.00` (Ruling R14). A
 * short crashed run at Gemini rates costs about $0.004, and `$0.00` next to a
 * model whose price is genuinely unknown — which shows nothing at all — would
 * read as "this one was free". `—` still means "no figure", which is a
 * different claim from "almost nothing".
 *
 * An *exact* zero is the same mistake in a worse form, so it renders `—` too. A
 * run that cost exactly nothing at a known list price would have to have used
 * no tokens at all, which is an anomaly — most likely agy reporting no counts
 * for a subscription account — and "unknown" is the honest reading of it, not
 * "free". `applyRunJson` in `scripts/process-results.ts` is where that case is
 * actually caught: it yields `null` and a note saying so. This is the backstop.
 */
export function formatCost(cost: number | null | undefined): string {
  if (cost === null || cost === undefined || cost === 0) return "—";
  const rounded = cost.toFixed(2);
  if (cost > 0 && Number(rounded) === 0) return "<$0.01";
  return `$${rounded}`;
}

// --- token counts, read back out of the `API cost` note ---------------------

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
}

/**
 * `process-results.ts` writes the breakdown into the note as
 * `in 123 / out 456 / cache read 789`. It is the only place the per-attempt
 * token counts reach the dashboard — `results.json` carries the imputed dollar
 * figure, not the envelope — so the cache-read share is parsed back out of it.
 * A note in any other shape simply yields no breakdown.
 */
const TOKEN_NOTE = /\bin\s+(\d+)\s*\/\s*out\s+(\d+)\s*\/\s*cache read\s+(\d+)/i;

export function parseTokenNote(notes: string): TokenTotals | null {
  const match = notes.match(TOKEN_NOTE);
  if (!match) return null;
  return {
    input: Number(match[1]),
    output: Number(match[2]),
    cacheRead: Number(match[3]),
  };
}

export function attemptTokens(attempt: AttemptResult): TokenTotals | null {
  const row = attempt.criteria.find((criterion) => isCostRow(criterion.name));
  return row ? parseTokenNote(row.notes) : null;
}

/** Token totals across a group of attempts, or `null` if none reported any. */
export function sumTokens(attempts: AttemptResult[]): TokenTotals | null {
  let total: TokenTotals | null = null;

  attempts.forEach((attempt) => {
    const tokens = attemptTokens(attempt);
    if (!tokens) return;
    total = total
      ? {
          input: total.input + tokens.input,
          output: total.output + tokens.output,
          cacheRead: total.cacheRead + tokens.cacheRead,
        }
      : tokens;
  });

  return total;
}

/**
 * Cache reads as a share of everything sent in. `cache_read_tokens` are
 * reported separately from `input_tokens` and priced separately, so the
 * denominator is their sum.
 */
export function cacheReadShare(tokens: TokenTotals): number | null {
  const prompt = tokens.input + tokens.cacheRead;
  return prompt > 0 ? tokens.cacheRead / prompt : null;
}

const compact = (value: number) => value.toLocaleString("en-US");

/**
 * The hover text behind every cost figure: what it is, and the cache split.
 *
 * `priced` is false where the model has no list price and the cell shows `N/A`.
 * Nothing was imputed there, so the imputation disclaimer would be describing a
 * figure that does not exist — but the token counts underneath it are measured
 * either way, and are the reason the hover is worth having at all.
 */
export function costTooltip(tokens: TokenTotals | null, priced = true): string {
  const lead = priced ? COST_DISCLAIMER : NO_PRICE_NOTE;
  if (!tokens) return lead;

  const share = cacheReadShare(tokens);
  const breakdown =
    `Tokens: ${compact(tokens.input)} in / ${compact(tokens.output)} out / ` +
    `${compact(tokens.cacheRead)} cache read`;
  const cache =
    share === null
      ? ""
      : ` — ${(share * 100).toFixed(1)}% of the prompt was served from cache`;

  return `${lead}\n${breakdown}${cache}`;
}

// --- aggregation ------------------------------------------------------------

export interface CriterionAggregate {
  name: string;
  max: number;
  averageScore: number | null;
  attemptScores: Array<{attemptNumber: number; score: number; max: number}>;
}

export interface ModelAggregate {
  modelName: string;
  modelBaseId: string;
  attempts: AttemptResult[];
}

/**
 * How attempts are grouped into columns: one column per (model, effort)
 * benchmark id, or one per model family with the effort levels folded together.
 */
export type GroupMode = "config" | "family";

export function groupKeyOf(attempt: AttemptResult, mode: GroupMode): string {
  return mode === "family" ? attempt.modelFamily : attempt.modelBaseId;
}

/**
 * The environment shown for a family whose attempts ran at several efforts.
 * `MIXED_EFFORT_ENVIRONMENT` in `scripts/process-results.ts` — same string,
 * because these two aggregations must produce the same row.
 */
const MIXED_EFFORT_ENVIRONMENT = "Antigravity CLI";

/**
 * Family rows, aggregated from the attempts currently on screen.
 *
 * `results.json` carries a precomputed `familyAverages`, but it is computed
 * over *every* attempt of a family and cannot answer to a filter applied in the
 * browser. With "Only latest models" on and one effort level of a live family
 * superseded, the family card would keep the header numbers of a row it is no
 * longer showing — while the table below it, which aggregates from the same
 * filtered attempts, disagreed with it on the same screen. A card must describe
 * the rows under it, so the numbers come from those rows.
 *
 * Task 5 still owns everything an attempt does not carry: `familyMeta` (the
 * `familyAverages` array) supplies each family's display name and list rate,
 * and grouping keys on `modelFamily`, never on a display name. With nothing
 * filtered this reproduces `familyAverages` exactly — `test/website-contracts.test.ts`
 * pins that against `process-results.ts`'s own output so the two cannot drift.
 */
export function aggregateFamilies(
  attempts: AttemptResult[],
  familyMeta: ModelFamilyAverage[] = [],
): ModelFamilyAverage[] {
  const meta = new Map(familyMeta.map((family) => [family.modelBaseId, family]));

  interface Group {
    environments: Set<string>;
    totalScore: number;
    totalMaxScore: number;
    totalPercentage: number;
    count: number;
    costSum: number;
    costCount: number;
  }
  const groups = new Map<string, Group>();

  attempts.forEach((attempt) => {
    let group = groups.get(attempt.modelFamily);
    if (group === undefined) {
      group = {
        environments: new Set<string>(),
        totalScore: 0,
        totalMaxScore: 0,
        totalPercentage: 0,
        count: 0,
        costSum: 0,
        costCount: 0,
      };
      groups.set(attempt.modelFamily, group);
    }
    if (attempt.agentEnvironment) group.environments.add(attempt.agentEnvironment);
    group.totalScore += attempt.totalScore;
    group.totalMaxScore += attempt.maxScore;
    group.totalPercentage += attempt.percentage;
    group.count += 1;
    if (attempt.cost !== null && attempt.cost !== undefined) {
      group.costSum += attempt.cost;
      group.costCount += 1;
    }
  });

  const averages = Array.from(groups.entries()).map(([key, group]) => {
    const source = meta.get(key);
    return {
      modelName: source?.modelName ?? key,
      modelBaseId: key,
      averageScore: group.totalScore / group.count,
      averageMaxScore: group.totalMaxScore / group.count,
      averagePercentage: group.totalPercentage / group.count,
      attemptCount: group.count,
      agentEnvironment:
        group.environments.size === 1
          ? [...group.environments][0]
          : MIXED_EFFORT_ENVIRONMENT,
      // Omitted rather than set to undefined, matching what the JSON holds.
      ...(source?.pricing !== undefined ? {pricing: source.pricing} : {}),
      averageCost: group.costCount > 0 ? group.costSum / group.costCount : null,
      totalCost: group.costCount > 0 ? group.costSum : null,
      costCount: group.costCount,
    };
  });

  averages.sort(
    (a, b) =>
      b.averagePercentage - a.averagePercentage ||
      a.modelBaseId.localeCompare(b.modelBaseId),
  );
  return averages;
}

export function getOrderedCriteria(
  attempts: AttemptResult[],
  includeInfoRows = true,
): CriterionResult[] {
  const allCriteriaUnsorted = Array.from(
    new Map(
      attempts.flatMap((a) => a.criteria).map((c) => [c.name, c]),
    ).values(),
  );
  const scoringCriteria = allCriteriaUnsorted.filter(
    (c) => !isInfoRow(c.name) && !isPenaltyRow(c.name),
  );
  const penaltyCriteria = allCriteriaUnsorted.filter((c) =>
    isPenaltyRow(c.name),
  );
  const infoCriteria = includeInfoRows
    ? allCriteriaUnsorted.filter((c) => isInfoRow(c.name))
    : [];

  return [...scoringCriteria, ...penaltyCriteria, ...infoCriteria];
}

/**
 * Group attempts into table columns.
 *
 * `displayNames` supplies the label for a group key that no single attempt
 * knows — a family id, whose display name lives in `familyAverages`. Grouping
 * never keys on a display name: the config level keys on `modelBaseId`, and
 * the family level keeps that rule.
 */
export function buildModelAggregates(
  attempts: AttemptResult[],
  mode: GroupMode = "config",
  displayNames: Record<string, string> = {},
): ModelAggregate[] {
  const modelMap = new Map<string, ModelAggregate>();

  attempts.forEach((attempt) => {
    const key = groupKeyOf(attempt, mode);
    const existing = modelMap.get(key);

    if (existing) {
      existing.attempts.push(attempt);
      return;
    }

    modelMap.set(key, {
      modelName:
        displayNames[key] ??
        (mode === "family" ? attempt.modelFamily : attempt.modelName),
      modelBaseId: key,
      attempts: [attempt],
    });
  });

  return Array.from(modelMap.values());
}

/**
 * Average one criterion across a group's attempts.
 *
 * Summing `criterion.score` unguarded is safe only while every score is a
 * number. Info rows carry `score: null` with their value in
 * `notes` (Ruling P13), and a `null` in that sum would render as `NaN`. Info
 * rows are therefore skipped outright rather than coerced to `0`, which would
 * pull every average down instead.
 */
export function aggregateCriterion(
  attempts: AttemptResult[],
  criterionName: string,
): CriterionAggregate {
  if (isInfoRow(criterionName)) {
    return {name: criterionName, max: 1, averageScore: null, attemptScores: []};
  }

  const attemptScores = attempts.flatMap((attempt) => {
    const criterion = attempt.criteria.find((c) => c.name === criterionName);

    // A scored row always has a number; a `null` here means the CSV said "N/A"
    // on a row that should have been scored, and averaging it as 0 would be a
    // guess. It drops out of both the numerator and the count.
    if (!criterion || criterion.score === null) return [];

    return [
      {
        attemptNumber: attempt.attemptNumber,
        score: criterion.score,
        max: criterion.max,
      },
    ];
  });

  const averageScore =
    attemptScores.length > 0
      ? attemptScores.reduce((sum, item) => sum + item.score, 0) /
        attemptScores.length
      : null;

  return {
    name: criterionName,
    max: attemptScores[0]?.max ?? 1,
    averageScore,
    attemptScores,
  };
}

export const getScoreColor = (score: number, max: number): string => {
  if (score === 0) return "bg-red-900 text-red-200";
  if (score === max) return "bg-green-900 text-green-200";
  return "bg-yellow-900 text-yellow-200";
};

export const getPenaltyColor = (score: number): string => {
  if (score === 0) return "bg-green-900 text-green-200";
  if (score >= 1) return "bg-red-900 text-red-200";
  return "bg-yellow-900 text-yellow-200";
};

export function formatScoreNumber(score: number): string {
  return Number.isInteger(score) ? score.toString() : score.toFixed(1);
}

export function formatAverageScore(score: number | null): string {
  if (score === null) return "N/A";

  return Number.isInteger(score) ? score.toString() : score.toFixed(2);
}

/** The cell text for one attempt's criterion. Info rows render from `notes`. */
export function formatAttemptScore(criterion: CriterionResult): string {
  if (isTimeRow(criterion.name)) {
    const timeMatch = criterion.notes.match(/\d+min\s*\d+s/);
    return timeMatch ? timeMatch[0] : "N/A";
  }

  if (isTestRunRow(criterion.name)) {
    return criterion.notes && criterion.notes !== "N/A"
      ? criterion.notes
      : "N/A";
  }

  if (isCostRow(criterion.name)) {
    // The figure goes through `formatCost` rather than straight to the cell:
    // Task 5 writes the note with `toFixed(4)`, so the raw capture would print
    // `$1.5000` here beside the `$1.50` every other cost on the page shows.
    const match = criterion.notes.match(/\$[0-9]+(?:\.[0-9]+)?/);
    return match ? formatCost(Number(match[0].slice(1))) : "N/A";
  }

  return criterion.score === null ? "N/A" : criterion.score.toString();
}
