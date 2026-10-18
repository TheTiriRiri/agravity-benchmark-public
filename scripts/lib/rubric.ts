/**
 * The maintenance-console rubric: its rows, and every number that decides a
 * score. The only list of the rows — `benchmark/criteria.md`'s table and the
 * CSV template in `.claude/skills/agrav-score-attempt/SKILL.md` are tested
 * against it byte for byte, and the hidden-test rows against
 * `benchmark/contract-tests/manifest.json`.
 *
 * Hashed into the rubric id (`rubricId`, below), with the prompt, the bands,
 * the judge procedure, the Notes formatter, the hidden tests and the seed. A
 * change to any of them — a row, a maximum, the rounding, a limit — needs a new
 * `rubric:` in `benchmark/runner.yaml`, or `npm test` turns red: scores from
 * before and after it are not comparable.
 */
import { fingerprintOf } from "./gate-fingerprint";

/** Who fills a row in: the harness, the hidden tests, the judge agent, the human, or the Penalty's agent-proposes-human-confirms. */
export type ScoredBy = "auto" | "hidden" | "agent" | "human" | "penalty";

export interface RubricRow {
  /** The `Criterion` cell, byte for byte. */
  name: string;
  /** The `Max` cell; `null` is written `N/A` and the row is outside the denominator. */
  max: number | null;
  scoredBy: ScoredBy;
}

function row(name: string, max: number | null, scoredBy: ScoredBy): RubricRow {
  return Object.freeze({ name, max, scoredBy });
}

/** The 14 rows in CSV order (spec §4). `Frontend–API integration` carries U+2013, an en dash. */
export const RUBRIC_ROWS: readonly RubricRow[] = Object.freeze([
  row("Task completion time", null, "auto"),
  row("Test run", null, "auto"),
  row("Local build", 1, "auto"),
  row("API contract", 2, "hidden"),
  row("Planner: assignment rules", 2, "hidden"),
  row("Planner: ordering & determinism", 1, "hidden"),
  row("Planner: parts & blocking", 2, "hidden"),
  row("Frontend–API integration", 1, "agent"),
  row("Code structure", 1, "agent"),
  row("Tech stack & run contract", 1, "agent"),
  row("Manual testing", 1, "human"),
  row("Consistent UI", 1, "human"),
  row("Responsive design", 1, "human"),
  row("Penalty", null, "penalty"),
]);

/** The four rows the hidden contract tests score, in CSV order — the manifest's order. */
export const HIDDEN_ROWS: readonly RubricRow[] = Object.freeze(RUBRIC_ROWS.filter((r) => r.scoredBy === "hidden"));

/** The sum of every numeric `max`: 14. */
export const RUBRIC_MAX: number = RUBRIC_ROWS.reduce((sum, r) => sum + (r.max ?? 0), 0);

/**
 * A hidden-test row's score: `passed / total × max`, rounded to two decimals,
 * computed in exactly this order so every caller gets the same double
 * (20 of 24 on a max-2 row is 1.67).
 */
export function roundScore(passed: number, total: number, max: number): number {
  if (!Number.isInteger(total) || total < 1) throw new RangeError(`roundScore: total must be a positive integer, got ${total}`);
  if (!Number.isInteger(passed) || passed < 0 || passed > total) {
    throw new RangeError(`roundScore: passed must be an integer from 0 to ${total}, got ${passed}`);
  }
  if (!Number.isFinite(max) || max < 0) throw new RangeError(`roundScore: max must be a non-negative number, got ${max}`);
  return Math.round((passed / total) * max * 100) / 100;
}

export interface Limits {
  /** `pip install -r requirements.txt` in the install container; past it, the PyPI probe decides model or infra. */
  readonly pipInstallMs: number;
  /** From a serving container's start to a 2xx from `/api/v1/health`; past it, a `health` stop. */
  readonly healthMs: number;
  /**
   * One `GET /api/v1/health` inside that wait. A backend whose health check
   * always takes longer never counts as up, so this decides a `health` stop too.
   */
  readonly healthProbeMs: number;
  /** The pause between two health probes; with `healthProbeMs`, how often `healthMs` gets asked. */
  readonly healthPollMs: number;
  /** One hidden-test file; past it, its unfinished tests score as failed. */
  readonly fileMs: number;
  /** One whole `contract-tests` run; past it, infra and nothing written. A guard, not a limit a slow backend can meet. */
  readonly overallMs: number;
  /** Retries of a serving container that fails after a good first boot; the first start has none. */
  readonly restartRetries: number;
  /** The PyPI probe (`pip download --no-deps` of one pinned wheel) after a failed or timed-out `pip install`. */
  readonly pypiProbeMs: number;
  /** The frontend's `npm install`; `take-screenshots --install-timeout` overrides it for capture only. */
  readonly npmInstallMs: number;
  /** One try of `npm run dev`: from the spawn to an HTTP answer at the URL of Vite's `Local:` banner. */
  readonly devServerStartMs: number;
  /**
   * One readiness request to that URL inside that wait. A dev server that
   * always takes longer to answer never counts as serving, so this decides a
   * frontend stop too.
   */
  readonly devServerProbeMs: number;
  /** The pause between two readiness requests; with `devServerProbeMs`, how often `devServerStartMs` gets asked. */
  readonly devServerPollMs: number;
  /** Retries of a dev server that does not serve; after them, a frontend stop. */
  readonly devServerRetries: number;
  /** `npm ping` after a failed or timed-out `npm install`. */
  readonly registryProbeMs: number;
}

/**
 * Every budget and retry count that can turn into a score. Typed as numbers so
 * tests can pass shorter ones (`Partial<typeof LIMITS>`); production always
 * uses these, and no CLI overrides them except the one noted above.
 */
export const LIMITS: Limits = Object.freeze({
  pipInstallMs: 300_000,
  healthMs: 60_000,
  healthProbeMs: 1_000,
  healthPollMs: 200,
  fileMs: 120_000,
  overallMs: 1_200_000,
  restartRetries: 1,
  pypiProbeMs: 60_000,
  npmInstallMs: 600_000,
  devServerStartMs: 60_000,
  devServerProbeMs: 1_000,
  devServerPollMs: 200,
  devServerRetries: 1,
  registryProbeMs: 60_000,
});

/**
 * What the rubric id covers, repo-relative (spec §5 "Rubric id"). Directories
 * are walked recursively. The model-versus-infra plumbing is not here: gate 3a
 * covers it, so a refactor of the harness does not change the id.
 */
export const RUBRIC_ID_INPUTS: readonly string[] = Object.freeze([
  "prompt.md",
  "benchmark/criteria.md",
  ".claude/skills/agrav-score-attempt/SKILL.md",
  "scripts/lib/rubric.ts",
  "scripts/lib/contract-results.ts",
  "scripts/lib/contract-suite.ts",
  "benchmark/contract-tests",
  "benchmark/context/seed.json",
]);

/** `maintenance-console@` plus the first 12 hex digits of `fingerprintOf(repoRoot, RUBRIC_ID_INPUTS)`. */
export function rubricId(repoRoot: string): string {
  return `maintenance-console@${fingerprintOf(repoRoot, RUBRIC_ID_INPUTS).slice(0, 12)}`;
}
