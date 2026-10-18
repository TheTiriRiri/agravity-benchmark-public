/**
 * The hard-track maintenance console rubric: its 16 rows, maxima, and scoring rules.
 * Specified in spec §8.1, §8.3, §8.4 and docs/superpowers/plans/2026-09-30-p4b-hard-prompt-and-fuzz.md.
 */
import { join } from "node:path";

import { fingerprintOf } from "./gate-fingerprint";
import { type RubricRow, type ScoredBy, roundScore } from "./rubric";

export { roundScore, type RubricRow, type ScoredBy };

function row(name: string, max: number | null, scoredBy: ScoredBy): RubricRow {
  return Object.freeze({ name, max, scoredBy });
}

/** The 16 hard track rows in CSV order. */
export const HARD_RUBRIC_ROWS: readonly RubricRow[] = Object.freeze([
  row("Task completion time", null, "auto"),
  row("Test run", null, "auto"),
  row("Local build", 1, "auto"),
  row("API contract", 2, "hidden"),
  row("Planner: assignment rules", 2, "hidden"),
  row("Planner: ordering & determinism", 1, "hidden"),
  row("Planner: parts & blocking", 2, "hidden"),
  row("Planner: crews & travel", 2, "hidden"),
  row("Planner: splitting & preemption", 2, "hidden"),
  row("Frontend E2E: flows", 2, "hidden"),
  row("Frontend E2E: layout & a11y", 1, "hidden"),
  row("Code structure", 1, "agent"),
  row("Tech stack & run contract", 1, "agent"),
  row("Self-verification", 1, "agent"),
  row("Visual design", 1, "human"),
  row("Penalty", null, "penalty"),
]);

/** The eight rows the hidden tests score (6 contract + 2 E2E). */
export const HARD_HIDDEN_ROWS: readonly RubricRow[] = Object.freeze(
  HARD_RUBRIC_ROWS.filter((r) => r.scoredBy === "hidden"),
);

/** The sum of every numeric `max`: 19. */
export const HARD_RUBRIC_MAX: number = HARD_RUBRIC_ROWS.reduce((sum, r) => sum + (r.max ?? 0), 0);

/** Hard rubric id inputs. */
export const HARD_RUBRIC_ID_INPUTS: readonly string[] = Object.freeze([
  join("tracks", "console-hard", "prompt.md"),
  join("tracks", "console-hard", "benchmark", "criteria.md"),
  join("scripts", "lib", "hard-rubric.ts"),
  join("tracks", "console-hard", "benchmark", "contract-tests"),
  join("tracks", "console-hard", "benchmark", "e2e-tests"),
  join("tracks", "console-hard", "benchmark", "context", "seed.json"),
]);

/** `maintenance-console-hard@` plus the first 12 hex digits of fingerprint. */
export function hardRubricId(repoRoot: string): string {
  return `maintenance-console-hard@${fingerprintOf(repoRoot, HARD_RUBRIC_ID_INPUTS).slice(0, 12)}`;
}
