/**
 * Turns one run of `fuzz.test.ts` into the fuzz row's score.
 *
 * The test names are the data channel (the P2 plan, decision 1): `contract-suite`
 * is a rubric-id input and reports only names, so each of the 200 tests is
 * called `<stratum>/<caseId>` and the per-stratum count is parsed back out of
 * `failed[]`.
 *
 * The score is the stratum mean (spec §6.3):
 *
 *   score = max × (1/S) × Σ_strata (passed in the stratum / cases in it)
 *
 * It stays graded inside a stratum. What bounds a rule's influence at 1/S is
 * the fixed allocation (ten cases per rule, decided before any case is
 * generated) together with isolation — and isolation does not hold
 * everywhere: not for rules 6, 7 and 8, which every scheduled outcome passes
 * through by the nature of the domain, and not for rules 2, 3, 5 and 9
 * either, measured in gate P2-B to reach several strata each. §6.3 has the
 * full account and says why that is the right answer and not a leak.
 */
import { CASES_PER_STRATUM, STRATA, TOTAL_CASES } from "../../tracks/console-fuzz/benchmark/fuzz/strata";
import type { ContractFileResult } from "./contract-suite";
import { roundScore } from "./rubric";

export interface FuzzStratumScore {
  id: string;
  passed: number;
  total: number;
  /** The lowest-numbered failed test of the stratum, by its full name; null when none failed. */
  firstFailure: string | null;
}

export interface FuzzScore {
  score: number;
  passed: number;
  total: number;
  perStratum: FuzzStratumScore[];
  /** For the CSV's Notes cell. */
  note: string;
}

const TEST_NAME = /^([a-z0-9-]+)\/(case-\d{4})$/;
const RESET_FAILURE = /^POST \/reset answered (\d+)\b/;

function stratumOf(testName: string): string {
  const match = TEST_NAME.exec(testName);
  if (match === null || !STRATA.some((s) => s.id === match[1])) {
    // A renamed test must stop the scorer, not be counted as a zero somewhere.
    throw new Error(`unparseable test name from fuzz.test.ts: ${JSON.stringify(testName)}`);
  }
  return match[1];
}

export function scoreFuzz(result: ContractFileResult, max: number): FuzzScore {
  if (result.total !== TOTAL_CASES) {
    throw new Error(`fuzz.test.ts reported ${result.total} tests, not ${TOTAL_CASES}: the manifest and the strata disagree`);
  }

  const failedNames = new Map<string, string[]>();
  for (const failure of result.failed) {
    const stratum = stratumOf(failure.name);
    failedNames.set(stratum, [...(failedNames.get(stratum) ?? []), failure.name]);
  }

  // `notRun` is a tail. A timeout cuts off the LAST tests of the file, and the
  // file runs `STRATA` in order with each stratum's cases together (asserted by
  // test/fuzz-cases.test.ts, "each stratum's cases are contiguous"), so the
  // unrun tests are charged to the strata from the end. Charging them to
  // whichever strata are convenient would be a guess; this only holds while
  // that ordering does.
  const unrun = new Map<string, number>();
  let remaining = result.notRun;
  for (let i = STRATA.length - 1; i >= 0 && remaining > 0; i -= 1) {
    const take = Math.min(remaining, CASES_PER_STRATUM);
    unrun.set(STRATA[i].id, take);
    remaining -= take;
  }
  if (remaining > 0) throw new Error(`inconsistent result: ${result.notRun} tests did not run, of ${TOTAL_CASES}`);

  const perStratum: FuzzStratumScore[] = STRATA.map((stratum) => {
    const names = [...(failedNames.get(stratum.id) ?? [])].sort();
    const passed = CASES_PER_STRATUM - names.length - (unrun.get(stratum.id) ?? 0);
    if (passed < 0) {
      // A test that never ran has no name to fail under; both cannot be true.
      throw new Error(`inconsistent result: ${stratum.id} has ${names.length} failures and ${unrun.get(stratum.id) ?? 0} unrun of ${CASES_PER_STRATUM}`);
    }
    return { id: stratum.id, passed, total: CASES_PER_STRATUM, firstFailure: names[0] ?? null };
  });

  const passed = perStratum.reduce((sum, s) => sum + s.passed, 0);
  if (passed !== result.passed) {
    throw new Error(`inconsistent result: the strata add up to ${passed} passed, the run reported ${result.passed}`);
  }
  return { score: stratumMeanScore(perStratum, max), passed, total: TOTAL_CASES, perStratum, note: noteFor(result, perStratum, passed) };
}

function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

/**
 * `max × mean over the strata of passed/total`, exactly. One formula, for the
 * scorer and for whoever checks a written result against its own per-stratum
 * tally: two copies of it could drift apart unseen.
 *
 * `Σ passed/total` in floating point is not exact: at `max = 3` a result of
 * 0.015 × an odd number lands on a rounding tie, and which way it rounds then
 * depends on the accumulated error of the sum — that is, on *which* strata
 * failed, not on how many passed. Two backends with the same raw result must
 * not score differently, so the mean is computed as one exact integer ratio
 * instead: with `L` the least common multiple of the strata's `total`s,
 *
 *   mean × max = max × (Σ passedₛ × (L / totalₛ)) / (S × L)
 *
 * and both the numerator and `S × L` are integers, so the score is
 * `roundScore(numerator, S × L, max)` — this repository's one rounding path,
 * the same one the frozen group score uses (`scripts/lib/rubric.ts`, a
 * rubric-id input, called here and never edited). With equal strata `L` is 10
 * and this is literally `roundScore(passed, 200, max)`, so `fuzz.score` and
 * the frozen `contract.groups[0].score` agree by construction; with unequal
 * strata (a future track) it stays exact.
 */
export function stratumMeanScore(perStratum: readonly FuzzStratumScore[], max: number): number {
  const l = perStratum.reduce((acc, s) => (acc / gcd(acc, s.total)) * s.total, 1);
  const numerator = perStratum.reduce((sum, s) => sum + s.passed * (l / s.total), 0);
  return roundScore(numerator, perStratum.length * l, max);
}

function noteFor(result: ContractFileResult, perStratum: FuzzStratumScore[], passed: number): string {
  // A backend whose /reset does not work fails every case the same way, before
  // its first step. Twenty strata at 0/10 would read as twenty broken rules.
  const resets = result.failed.map((f) => RESET_FAILURE.exec(f.message));
  if (result.failed.length === TOTAL_CASES && resets.every((m) => m !== null && m[1] === resets[0]?.[1])) {
    return `${passed}/${TOTAL_CASES}: POST /reset answered ${resets[0]![1]} on every case, so nothing was measured`;
  }
  const parts = [`${passed}/${TOTAL_CASES} cases`];
  if (result.notRun > 0) parts.push(`${result.notRun} did not run (timeout)`);
  const below = perStratum.filter((s) => s.passed < s.total);
  if (below.length > 0) {
    parts.push(below.map((s) => `${s.id} ${s.passed}/${s.total}${s.firstFailure ? ` (first: ${s.firstFailure})` : ""}`).join("; "));
  }
  return parts.join("; ");
}
