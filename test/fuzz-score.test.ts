import assert from "node:assert/strict";
import { test } from "node:test";

import type { ContractFileResult } from "../scripts/lib/contract-suite";
import { scoreFuzz, stratumMeanScore, type FuzzStratumScore } from "../scripts/lib/fuzz-score";
import { roundScore } from "../scripts/lib/rubric";
import { Rng } from "../tracks/console-fuzz/benchmark/fuzz/rng";
import { CASES_PER_STRATUM, STRATA, TOTAL_CASES } from "../tracks/console-fuzz/benchmark/fuzz/strata";

const clean: ContractFileResult = {
  file: "fuzz.test.ts", total: 200, passed: 200, failed: [], notRun: 0, hookFailed: 0, timedOut: false,
};

const failing = (names: string[], message = "deepEqual"): ContractFileResult => ({
  ...clean,
  passed: 200 - names.length,
  failed: names.map((name) => ({ name, failureType: "testCodeFailure", message })),
});

const caseName = (stratum: string, n: number): string => `${stratum}/case-${String(n).padStart(4, "0")}`;
const tenIn = (stratum: string): string[] => Array.from({ length: 10 }, (_, i) => caseName(stratum, 150 + i));

test("a perfect run scores the row's maximum", () => {
  const scored = scoreFuzz(clean, 3);
  assert.equal(scored.score, 3);
  assert.equal(scored.passed, 200);
  assert.equal(scored.total, 200);
  assert.equal(scored.perStratum.length, STRATA.length);
});

test("one bug confined to one stratum costs at most that stratum's share", () => {
  // The failure mode of a raw passed/200: ten failures in one stratum would
  // cost 10/200 = 5% of the row there, and the same defect drawn differently
  // could cost 45%. The mean caps it at 1/20 of the row.
  const scored = scoreFuzz(failing(tenIn("daily-cap-480")), 3);
  // 3 * 19/20 = 2.85, written out: 3 * (19 / 20) is 2.8499999999999996 in floating point.
  assert.equal(scored.score, 2.85);
  assert.equal(scored.perStratum.find((s) => s.id === "daily-cap-480")?.passed, 0);
});

test("one rare bug in each of twenty strata is not worse than ten in one", () => {
  // All-or-nothing per stratum was rejected for scoring exactly this pair
  // backwards (spec §6.3).
  const one = scoreFuzz(failing([caseName("daily-cap-480", 150)]), 3);
  const ten = scoreFuzz(failing(tenIn("daily-cap-480")), 3);
  assert.ok(one.score > ten.score, "a graded stratum must reward fewer failures inside it");
});

test("the score has the two decimals every other fractional row has", () => {
  const scored = scoreFuzz(failing([caseName("parts-blocked", 91)]), 3);
  assert.equal(scored.score, Math.round(scored.score * 100) / 100);
});

test("the note carries the raw count, the per-stratum tally and the first failure per stratum", () => {
  const scored = scoreFuzz(failing(["parts-blocked/case-0091", "parts-blocked/case-0093"]), 3);
  assert.match(scored.note, /198\/200/);
  assert.match(scored.note, /parts-blocked 8\/10/);
  assert.match(scored.note, /case-0091/);
  assert.ok(!scored.note.includes("case-0093"), "only the first failure per stratum is named");
});

test("the first failure named is the lowest case id, whatever order the runner reported them in", () => {
  const scored = scoreFuzz(failing(["parts-blocked/case-0093", "parts-blocked/case-0091"]), 3);
  assert.equal(scored.perStratum.find((s) => s.id === "parts-blocked")?.firstFailure, "parts-blocked/case-0091");
});

test("tests the timer cut off count as failures of their own strata, not as passes", () => {
  // contract-suite reports those as notRun, with no names. Crediting them
  // would score a backend that hung halfway higher than one that answered
  // wrongly, which is backwards.
  const cut: ContractFileResult = { ...clean, passed: 120, failed: [], notRun: 80, timedOut: true };
  const scored = scoreFuzz(cut, 3);
  assert.ok(scored.score < 3 * (120 / 200) + 0.001, "unrun tests must not be credited");
  assert.match(scored.note, /80 did not run/);
});

test("notRun is charged to the strata from the end of the file, not spread", () => {
  // The tests a timeout cuts off are the last ones in file order, which is
  // STRATA's order with each stratum's cases together (test/fuzz-cases.test.ts
  // asserts that). Fifteen unrun: all of the last stratum and half of the one before.
  const cut: ContractFileResult = { ...clean, passed: 185, failed: [], notRun: 15, timedOut: true };
  const scored = scoreFuzz(cut, 3);
  const byId = Object.fromEntries(scored.perStratum.map((s) => [s.id, s.passed]));
  assert.equal(byId[STRATA[STRATA.length - 1].id], 0);
  assert.equal(byId[STRATA[STRATA.length - 2].id], CASES_PER_STRATUM - 5);
  for (const stratum of STRATA.slice(0, -2)) assert.equal(byId[stratum.id], CASES_PER_STRATUM, stratum.id);
  assert.equal(scored.score, 2.78); // 3 * (18 + 0.5) / 20 = 2.775
});

test("a named failure inside the unrun tail is a harness fault, not a second charge", () => {
  // A test that never ran has no name to fail under; both cannot be true.
  const last = STRATA[STRATA.length - 1].id;
  const broken: ContractFileResult = { ...failing([caseName(last, 199)]), passed: 184, notRun: 15, timedOut: true };
  assert.throws(() => scoreFuzz(broken, 3), /inconsistent/);
});

test("a result that is not 200 tests long is a harness fault", () => {
  assert.throws(() => scoreFuzz({ ...clean, total: 199, passed: 199 }, 3), /200/);
});

test("a test name that is not <stratum>/<caseId> is a harness fault, not a zero", () => {
  for (const name of ["something-else", "no-such-stratum/case-0001", "daily-cap-480/whatever", "daily-cap-480/"]) {
    assert.throws(
      () => scoreFuzz(failing([name]), 3),
      /unparseable test name/,
      `${name}: a renamed test must stop the scorer rather than silently mis-attribute`,
    );
  }
});

test("a backend whose /reset never worked is said so in one line, not as twenty strata at 0/10", () => {
  // replayCase throws before the first step, so every case fails with the same message.
  const every = STRATA.flatMap((s, i) =>
    Array.from({ length: CASES_PER_STRATUM }, (_, n) => caseName(s.id, i * CASES_PER_STRATUM + n)),
  );
  const scored = scoreFuzz(failing(every, "POST /reset answered 404"), 3);
  assert.equal(scored.score, 0);
  assert.match(scored.note, /POST \/reset answered 404/);
  assert.ok(!scored.note.includes("daily-cap-480"), "the note listed strata instead of naming the one cause");
});

test("two different reset failures are not mistaken for one cause", () => {
  const every = STRATA.flatMap((s, i) =>
    Array.from({ length: CASES_PER_STRATUM }, (_, n) => caseName(s.id, i * CASES_PER_STRATUM + n)),
  );
  const mixed: ContractFileResult = {
    ...failing(every),
    failed: every.map((name, i) => ({ name, failureType: "testCodeFailure", message: `POST /reset answered ${i % 2 ? 404 : 500}` })),
  };
  assert.ok(scoreFuzz(mixed, 3).note.includes("daily-cap-480"));
});

// ---------------------------------------------------------------------------
// stratumMeanScore's exactness (Task 6b): with equal strata the mean must
// equal roundScore(passed, 200, max) for EVERY passed count, not just for the
// distributions Task 5's four hand-picked failure shapes happened to try.
// Floating-point summation landed on a rounding tie for some counts — which
// way it rounded then depended on which strata failed, not on how many
// passed — so this is checked as a theorem (once the mean is an exact integer
// ratio, the equality follows for every count) rather than by sampling.

const stratum = (id: string, passed: number): FuzzStratumScore => ({ id, total: CASES_PER_STRATUM, passed, firstFailure: null });

/** `passed` spread over the strata by `order` (an index permutation), each capped at CASES_PER_STRATUM. */
function distribute(passed: number, order: readonly number[]): FuzzStratumScore[] {
  const perStratum = STRATA.map((s) => stratum(s.id, 0));
  let remaining = passed;
  for (const i of order) {
    const take = Math.min(remaining, CASES_PER_STRATUM);
    perStratum[i] = stratum(STRATA[i].id, take);
    remaining -= take;
  }
  if (remaining > 0) throw new Error(`distribute: ${passed} does not fit in ${STRATA.length} strata of ${CASES_PER_STRATUM}`);
  return perStratum;
}

const LEFT_TO_RIGHT = STRATA.map((_, i) => i);
const RIGHT_TO_LEFT = [...LEFT_TO_RIGHT].reverse();

/** One pass at a time, cycling through every stratum, rather than filling one before moving to the next. */
function roundRobin(passed: number): FuzzStratumScore[] {
  const passedPer = new Array(STRATA.length).fill(0);
  let remaining = passed;
  for (let i = 0; remaining > 0; i = (i + 1) % STRATA.length) {
    if (passedPer[i] < CASES_PER_STRATUM) {
      passedPer[i] += 1;
      remaining -= 1;
    }
  }
  return STRATA.map((s, i) => stratum(s.id, passedPer[i]));
}

test("stratumMeanScore equals roundScore(passed, 200, max) for every possible passed count, filled left, right and round-robin", () => {
  for (let passed = 0; passed <= TOTAL_CASES; passed += 1) {
    const want = roundScore(passed, TOTAL_CASES, 3);
    assert.equal(stratumMeanScore(distribute(passed, LEFT_TO_RIGHT), 3), want, `left to right, passed=${passed}`);
    assert.equal(stratumMeanScore(distribute(passed, RIGHT_TO_LEFT), 3), want, `right to left, passed=${passed}`);
    assert.equal(stratumMeanScore(roundRobin(passed), 3), want, `round-robin, passed=${passed}`);
  }
});

test("stratumMeanScore also matches roundScore across a seeded sample of random distributions", () => {
  // Welcome alongside the exhaustive test above, not a substitute for it.
  const rng = new Rng(20260921);
  for (let trial = 0; trial < 500; trial += 1) {
    const passedPer = new Array(STRATA.length).fill(0);
    let remaining = rng.int(0, TOTAL_CASES);
    while (remaining > 0) {
      const i = rng.int(0, STRATA.length - 1);
      if (passedPer[i] < CASES_PER_STRATUM) {
        passedPer[i] += 1;
        remaining -= 1;
      }
    }
    const perStratum = STRATA.map((s, i) => stratum(s.id, passedPer[i]));
    const passed = passedPer.reduce((sum: number, n: number) => sum + n, 0);
    assert.equal(stratumMeanScore(perStratum, 3), roundScore(passed, TOTAL_CASES, 3), `trial ${trial}, passed=${passed}`);
  }
});

test("two distributions of the same 149 passed, whose floating-point sums used to differ, score identically", () => {
  // Measured on the pre-fix code: 2.24 vs 2.23 for these two layouts.
  const concentrated = distribute(149, LEFT_TO_RIGHT); // 10×14, 9, 0×5
  const spread = [7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 10, 10, 10].map((passed, i) => stratum(STRATA[i].id, passed));
  assert.equal(concentrated.reduce((sum, s) => sum + s.passed, 0), 149);
  assert.equal(spread.reduce((sum, s) => sum + s.passed, 0), 149);
  assert.equal(stratumMeanScore(concentrated, 3), stratumMeanScore(spread, 3));
  assert.equal(stratumMeanScore(concentrated, 3), roundScore(149, 200, 3));
});

test("scoreFuzz's own score is stratumMeanScore of its perStratum, not a separate computation", () => {
  const scored = scoreFuzz(failing([...tenIn("daily-cap-480"), caseName("parts-blocked", 91)]), 3);
  assert.equal(scored.score, stratumMeanScore(scored.perStratum, 3));
});
