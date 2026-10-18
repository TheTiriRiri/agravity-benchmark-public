/**
 * The brownfield-track maintenance console rubric: its 10 rows, maxima, and scoring rules.
 * Specified in spec §7.3 and docs/superpowers/plans/2026-10-02-p3-brownfield.md.
 */
import { join } from "node:path";

import { fingerprintOf } from "./gate-fingerprint";
import { type RubricRow, type ScoredBy, roundScore } from "./rubric";

export { roundScore, type RubricRow, type ScoredBy };

function row(name: string, max: number | null, scoredBy: ScoredBy): RubricRow {
  return Object.freeze({ name, max, scoredBy });
}

/** The 10 brownfield track rows in CSV order. */
export const BROWNFIELD_RUBRIC_ROWS: readonly RubricRow[] = Object.freeze([
  row("Task completion time", null, "auto"),
  row("Test run", null, "auto"),
  row("Local build", 1, "auto"),
  row("Regression", 4, "hidden"),
  row("Change suite", 3, "hidden"),
  row("Diff locality", 1, "auto"),
  row("Code structure", 1, "agent"),
  row("Self-verification", 1, "agent"),
  row("Visual design", 1, "human"),
  row("Penalty", null, "penalty"),
]);

/** The two rows the hidden contract tests score (Regression + Change suite). */
export const BROWNFIELD_HIDDEN_ROWS: readonly RubricRow[] = Object.freeze(
  BROWNFIELD_RUBRIC_ROWS.filter((r) => r.scoredBy === "hidden"),
);

/** Return the numeric `max` for a named rubric row, or throw if the row is missing or non-numeric. */
export function getRequiredRowMax(rows: readonly RubricRow[], name: string): number {
  const r = rows.find((row) => row.name === name);
  if (!r) {
    throw new Error(`Rubric row "${name}" not found`);
  }
  if (typeof r.max !== "number") {
    throw new Error(`Rubric row "${name}" does not have a numeric max (got ${r.max})`);
  }
  return r.max;
}

/** The sum of every numeric `max`: 12. */
export const BROWNFIELD_RUBRIC_MAX: number = BROWNFIELD_RUBRIC_ROWS.reduce((sum, r) => sum + (r.max ?? 0), 0);

/** Brownfield rubric id inputs. */
export const BROWNFIELD_RUBRIC_ID_INPUTS: readonly string[] = Object.freeze([
  join("tracks", "brownfield", "prompt.md"),
  join("tracks", "brownfield", "benchmark", "criteria.md"),
  join(".claude", "skills", "agrav-score-brownfield", "SKILL.md"),
  join("scripts", "lib", "brownfield-rubric.ts"),
  join("tracks", "brownfield", "base"),
  join("benchmark", "contract-tests"),
  join("tracks", "brownfield", "benchmark", "contract-tests"),
  join("benchmark", "context", "seed.json"),
]);

/** `maintenance-console-brownfield@` plus the first 12 hex digits of fingerprint. */
export function brownfieldRubricId(repoRoot: string): string {
  return `maintenance-console-brownfield@${fingerprintOf(repoRoot, BROWNFIELD_RUBRIC_ID_INPUTS).slice(0, 12)}`;
}
