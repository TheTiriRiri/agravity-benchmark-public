/**
 * The shapes `scripts/process-results.ts` writes into `src/data/results.json`.
 *
 * They live in one place because the dashboard has two aggregation levels (per
 * (model, effort) config and per model family) and both read the same attempt
 * records.
 *
 * Two points worth noting, both from Task 5's output:
 *
 * - `CriterionResult.score` is `number | null`. The three info rows carry their
 *   value in `notes` and `null` in `score` (Ruling P13), so nothing downstream
 *   can sum them into a `NaN` by accident — see `aggregateCriterion` in
 *   `../components/comparisonUtils`.
 * - `AttemptResult.modelFamily` exists, and is what the grouped view keys on.
 *
 * `ModelPricing` is imported from the catalogue rather than restated, so a rate
 * added there shows up here. The import is type-only and erased at build time —
 * nothing under `website/` reads `eval-attempts/` at runtime.
 */
import type {ModelPricing} from "../../../eval-attempts/metadata";

export type {ModelPricing};

export interface CriterionResult {
  name: string;
  /** `null` on an info row (`Task completion time`, `Test run`, `API cost`). */
  score: number | null;
  max: number;
  notes: string;
}

export interface AttemptResult {
  id: string;
  modelName: string;
  /** The benchmark id — effort suffix included, e.g. `gemini-38-flash-low`. */
  modelBaseId: string;
  /** The family the effort levels aggregate into, e.g. `gemini-38-flash`. */
  modelFamily: string;
  attemptNumber: number;
  totalScore: number;
  maxScore: number;
  percentage: number;
  agentEnvironment?: string;
  /** Imputed USD at list prices, or `null` when no price / no token counts. */
  cost?: number | null;
  criteria: CriterionResult[];
}

/**
 * One aggregation row. `modelBaseId` is the group key: a benchmark id in
 * `modelAverages`, a family id in `familyAverages`.
 */
export interface ModelFamilyAverage {
  modelName: string;
  modelBaseId: string;
  averagePercentage: number;
  attemptCount: number;
  averageScore: number;
  averageMaxScore: number;
  agentEnvironment?: string;
  pricing?: ModelPricing;
  averageCost?: number | null;
  /**
   * Sum over the attempts that have an imputed cost, which may be fewer than
   * `attemptCount` — see `costCount`, which is what the card's label reports.
   */
  totalCost?: number | null;
  /** How many of `attemptCount` attempts are behind the two cost figures. */
  costCount?: number;
}

export interface ProcessedResults {
  generatedAt: string;
  totalAttempts: number;
  results: AttemptResult[];
  modelAverages: ModelFamilyAverage[];
  familyAverages: ModelFamilyAverage[];
  supersededModels: Record<string, string>;
}
