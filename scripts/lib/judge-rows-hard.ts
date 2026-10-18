/**
 * judge-rows-hard.json — judge and human scores for the hard track that
 * survive a rescore.
 *
 * The file sits at `eval-results/<id>/judge-rows-hard.json` and holds
 * the five non-hidden, non-auto rows: three agent rows, Visual design
 * (human), and Penalty (agent proposes, human confirms).
 */
import { readFileSync } from "node:fs";

import { writeFileAtomic } from "./atomic-write";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export interface JudgeRowValue {
  score: 0 | 0.5 | 1;
  note: string;
  by: "agent" | "human";
}

export interface JudgeRowsHard {
  schemaVersion: 1;
  attempt: string;
  rubric: string;
  judge: string;
  judgedAt: string;
  rows: Partial<Record<JudgeRowName, JudgeRowValue>>;
  /**
   * Set when the rows were carried over from an earlier rubric id whose only
   * difference was the hidden contract tests (`scripts/migrate-judge-rows-hard.ts`).
   */
  migratedFrom?: { rubric: string; rev: string; at: string };
}

/** The five rows that judge-rows-hard.json may contain. */
export const JUDGE_ROW_NAMES = [
  "Code structure",
  "Tech stack & run contract",
  "Self-verification",
  "Visual design",
  "Penalty",
] as const;
export type JudgeRowName = (typeof JUDGE_ROW_NAMES)[number];

/** `by` is determined by the row name: criteria.md scoring roles. */
const REQUIRED_BY: Record<JudgeRowName, "agent" | "human"> = {
  "Code structure": "agent",
  "Tech stack & run contract": "agent",
  "Self-verification": "agent",
  "Visual design": "human",
  "Penalty": "human",
};

export function requiredBy(name: JudgeRowName): "agent" | "human" {
  return REQUIRED_BY[name];
}

export function isJudgeRowName(name: string): name is JudgeRowName {
  return (JUDGE_ROW_NAMES as readonly string[]).includes(name);
}

/** Validate a score value: must be 0, 0.5, or 1 (criteria.md line ~59-60). */
export function isValidScore(score: number): score is 0 | 0.5 | 1 {
  return score === 0 || score === 0.5 || score === 1;
}

/**
 * Detect which judge rows are zeroed by stops, using the structural
 * backend/frontend fields from hidden-results-hard.json.
 *
 * @param backendStatus  `"ok"` or the failure reason from hidden-results
 * @param frontendStatus `"ok"` or the failure reason from hidden-results
 * @returns the set of judge row names that are zeroed by the detected stops.
 */
export function stoppedJudgeRows(
  backendStatus: string,
  frontendStatus: string,
): Set<JudgeRowName> {
  const stopped = new Set<JudgeRowName>();
  const hasBackendStop = backendStatus !== "ok";
  const hasFrontendStop = frontendStatus !== "ok";

  if (hasBackendStop && hasFrontendStop) {
    // Both stops → all rows zeroed
    for (const name of JUDGE_ROW_NAMES) stopped.add(name);
    return stopped;
  }

  if (hasBackendStop) {
    // Backend stop zeroes Self-verification (among judge rows)
    stopped.add("Self-verification");
  }

  if (hasFrontendStop) {
    // Frontend stop zeroes Visual design (among judge rows)
    stopped.add("Visual design");
  }

  return stopped;
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

export const JUDGE_ROWS_FILE = "judge-rows-hard.json";

export function parseJudgeRowsHard(text: string): JudgeRowsHard {
  const r = JSON.parse(text) as JudgeRowsHard;
  if (r.schemaVersion !== 1) throw new Error(`judge-rows-hard: schemaVersion must be 1, got ${JSON.stringify(r.schemaVersion)}`);
  for (const k of ["attempt", "rubric", "judge", "judgedAt"] as const) {
    if (typeof r[k] !== "string") throw new Error(`judge-rows-hard: ${k} must be a string`);
  }
  if (r.migratedFrom !== undefined) {
    const m = r.migratedFrom as Record<string, unknown> | null;
    if (typeof m !== "object" || m === null || ["rubric", "rev", "at"].some((k) => typeof m[k] !== "string")) {
      throw new Error("judge-rows-hard: migratedFrom must hold string rubric, rev and at");
    }
  }
  if (typeof r.rows !== "object" || r.rows === null || Array.isArray(r.rows)) {
    throw new Error("judge-rows-hard: rows must be an object");
  }
  for (const [name, value] of Object.entries(r.rows)) {
    if (!isJudgeRowName(name)) throw new Error(`judge-rows-hard: unknown row ${JSON.stringify(name)}`);
    const v = value as JudgeRowValue;
    if (!isValidScore(v.score)) throw new Error(`judge-rows-hard: ${name} score must be 0, 0.5 or 1; got ${JSON.stringify(v.score)}`);
    if (typeof v.note !== "string") throw new Error(`judge-rows-hard: ${name} note must be a string`);
    if (v.by !== "agent" && v.by !== "human") throw new Error(`judge-rows-hard: ${name} by must be "agent" or "human"`);
    const expected = requiredBy(name);
    if (v.by !== expected) throw new Error(`judge-rows-hard: ${name} by must be "${expected}", got "${v.by}"`);
  }
  return r;
}

export function readJudgeRowsHard(path: string): JudgeRowsHard {
  return parseJudgeRowsHard(readFileSync(path, "utf8"));
}

export function writeJudgeRowsHard(path: string, data: JudgeRowsHard): void {
  writeFileAtomic(path, JSON.stringify(data, null, 2) + "\n");
}
