/**
 * The scorer freeze: the files that turn a hard or brownfield attempt into its
 * CSV rows but sit outside that track's rubric id.
 *
 * The classic id hashes its rules (`RUBRIC_ID_INPUTS` in `scripts/lib/rubric.ts`)
 * and leaves only the model-versus-infra plumbing to gate 3a. The hard and
 * brownfield ids hash their specs and suites but not the code that scores
 * them: the stop table, the Local build rule, the test budgets, the judge-row
 * overlay, `roundScore`, the diff-locality formula and its allowed paths. Gate
 * 3a fingerprints only part of that code (`rubric.ts`, `contract-results.ts`,
 * `contract-suite.ts`), and a red gate is re-recorded, not re-scored, so
 * without this an edit to it could change what a row means and turn no test
 * red, or only one that asks for a re-recording. `test/scorer-freeze.test.ts`
 * holds each list to the fingerprint recorded here.
 *
 * Stop classification is not listed: whether a backend or frontend boots is
 * decided in `attempt-backend.ts`, `serve-attempt.ts`, `dev-server.ts` and
 * `pytest-summary.ts`, which gate 3a fingerprints (`GATE_3_INPUTS`). When the
 * gate is red because a stop rule changed, rather than the plumbing around it,
 * that is a new era too, not a re-recording.
 *
 * When that test is red, one of two things happened:
 *
 * (i) A scoring rule changed. That is a new era: fold the changed file into the
 *     track's rubric id inputs (`HARD_RUBRIC_ID_INPUTS`, `BROWNFIELD_RUBRIC_ID_INPUTS`)
 *     (and drop it from the list below) or otherwise give the track a new
 *     rubric id, and re-score its attempts.
 * (ii) A refactor that provably leaves every row as it was. Record the new
 *     fingerprint below and say in the commit message why no row can change.
 *
 * The lists are hashed like the rubric id (`fingerprintOf`), from content, so
 * the check needs no git history.
 *
 * `HARD_E2E_PINS` is Ruling H3 as it actually runs: `score-hard` calls
 * `npx playwright` from the repository root, so the hard E2E verdicts come from
 * the root `package-lock.json`, not from `tracks/console-hard/package.json`.
 * All 20 v2 hard attempts were scored on these versions.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { fingerprintOf } from "./gate-fingerprint";

/** What decides a hard CSV row and is not in `HARD_RUBRIC_ID_INPUTS`, repo-relative. */
export const HARD_SCORER_INPUTS: readonly string[] = Object.freeze([
  join(".claude", "skills", "agrav-score-hard", "SKILL.md"),
  join("scripts", "score-hard.ts"),
  join("scripts", "lib", "hard-score.ts"),
  join("scripts", "lib", "judge-rows-hard.ts"),
  // roundScore and LIMITS. It also holds the classic rows, so a classic rubric
  // change turns this red too: that is case (ii) for this track.
  join("scripts", "lib", "rubric.ts"),
]);

/** What decides a brownfield CSV row and is not in `BROWNFIELD_RUBRIC_ID_INPUTS`, repo-relative. */
export const BROWNFIELD_SCORER_INPUTS: readonly string[] = Object.freeze([
  join("scripts", "contract-tests-brownfield.ts"),
  join("scripts", "lib", "brownfield-contract-results.ts"),
  join("scripts", "lib", "diff-locality.ts"),
  // isIgnoredDiffEntry: which paths diff locality never counts.
  join("scripts", "lib", "base-diff.ts"),
  // stoppedBoot and stoppedGroups: the rows a boot stop zeroes.
  join("scripts", "lib", "contract-results.ts"),
  // runContractFile: what counts as a passed test.
  join("scripts", "lib", "contract-suite.ts"),
  // roundScore and LIMITS (and the classic rows; see the hard list).
  join("scripts", "lib", "rubric.ts"),
]);

/**
 * First 12 hex digits of `fingerprintOf(root, HARD_SCORER_INPUTS)`. Recorded at
 * 5847ec2; re-recorded under (ii) at 3d78448 (the Playwright pin check, which the
 * v2 runs already satisfied); re-recorded under (i) when `score-hard` began
 * starting a fresh backend for each contract file (`criteria.md`'s rule, which
 * the first v2 rescore had not followed) and answering a signal mid-file: the
 * hard track moved to a new rubric id with the next commit and its 4×5 was
 * rescored under it, so no published row comes from the older procedure.
 * Re-recorded under (ii) when `hidden-results-hard.json` began recording the
 * warnings score-hard logs (a backend container that exited during a contract
 * file): a diagnostic field beside the rows, so no row or CSV cell changes.
 */
export const HARD_SCORER_FINGERPRINT = "f5cd88b17766";

/** First 12 hex digits of `fingerprintOf(root, BROWNFIELD_SCORER_INPUTS)`, recorded at 5847ec2. */
export const BROWNFIELD_SCORER_FINGERPRINT = "2c233173413e";

/** The Playwright and axe versions in the root `package-lock.json` that the hard E2E ran on. */
export const HARD_E2E_PINS: Readonly<Record<string, string>> = Object.freeze({
  "@playwright/test": "1.63.0",
  playwright: "1.63.0",
  "playwright-core": "1.63.0",
  "@axe-core/playwright": "4.13.0",
  "axe-core": "4.13.0",
});

export function hardScorerFingerprint(root: string): string {
  return fingerprintOf(root, HARD_SCORER_INPUTS).slice(0, 12);
}

export function brownfieldScorerFingerprint(root: string): string {
  return fingerprintOf(root, BROWNFIELD_SCORER_INPUTS).slice(0, 12);
}

/**
 * The `HARD_E2E_PINS` packages whose installed copy under `<root>/node_modules`
 * is missing or another version, one line each; empty when the install matches.
 * The lockfile test cannot see a stale or hand-edited `node_modules`, and
 * scoring runs locally, so `score-hard` checks this before it scores anything.
 */
export function installedE2EPinMismatches(root: string): string[] {
  const mismatches: string[] = [];
  for (const [name, pinned] of Object.entries(HARD_E2E_PINS)) {
    const manifest = join(root, "node_modules", name, "package.json");
    if (!existsSync(manifest)) {
      mismatches.push(`${name}: not installed (pinned ${pinned})`);
      continue;
    }
    const installed = (JSON.parse(readFileSync(manifest, "utf8")) as { version?: string }).version;
    if (installed !== pinned) mismatches.push(`${name}: installed ${installed ?? "unknown"} (pinned ${pinned})`);
  }
  return mismatches;
}
