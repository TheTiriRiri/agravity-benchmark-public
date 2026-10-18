/**
 * The two places the dashboard reads `process-results.ts`'s output by parsing a
 * string it wrote, rather than by reading a field.
 *
 * Both are contracts between packages that no compiler checks: `scripts/` writes
 * a `notes` string, `website/` matches a regular expression against it. Nothing
 * fails loudly when they drift — the dashboard just quietly loses a tooltip or a
 * figure. These tests are the only thing holding the two halves together, so
 * they run against the real producer: `processResults` over the real fixture
 * tree, and the notes it actually emits.
 *
 * `test/process-results.test.ts` pins the producing side's exact strings. This
 * file pins that the consuming side can read them back. Change the note format
 * and both files fail, which is the point.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { imputedCost, processResults, type AttemptResult, type ProcessedResults } from "../scripts/process-results";
import type { RunUsage } from "../scripts/lib/run-json";
import { MODEL_PRICING, isModelId } from "../eval-attempts/metadata";
import {
  aggregateFamilies,
  attemptTokens,
  formatAttemptScore,
  formatCost,
  getScoreColor,
  parseTokenNote,
  HIDDEN_TEST_ROWS,
  TECH_STACK_ROW,
} from "../website/src/components/comparisonUtils";
import { HIDDEN_ROWS, RUBRIC_ROWS } from "../scripts/lib/rubric";
import { FIXTURE_RUBRIC } from "./fixtures/contract-results-fixture";

const FIXTURES = fileURLToPath(new URL("fixtures/eval-results", import.meta.url));

const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** The real pipeline over the real fixtures, writing into a throwaway directory. */
function run(): ProcessedResults {
  const out = mkdtempSync(join(tmpdir(), "agrav-website-contract-"));
  tempDirs.push(out);
  return processResults({
    resultsDir: FIXTURES,
    resultsJsonPath: join(out, "results.json"),
    leaderboardJsonPath: join(out, "leaderboard.json"),
    warn: () => {},
    rubric: FIXTURE_RUBRIC,
  }).results;
}

function costNote(attempt: AttemptResult): string {
  const row = attempt.criteria.find((criterion) => criterion.name === "API cost");
  assert.ok(row !== undefined, `expected an API cost row in ${attempt.id}`);
  return row.notes;
}

/** The `envelope.usage` the fixture's `run.json` carries, which the note describes. */
function fixtureUsage(id: string): RunUsage {
  const runJson = JSON.parse(readFileSync(join(FIXTURES, id, "run.json"), "utf8"));
  return runJson.envelope.usage;
}

// --- the cost note (Ruling R15) ---------------------------------------------

test("the token breakdown process-results writes is the one the dashboard parses back", () => {
  const results = run();

  // Every attempt with a cost row, priced or not: the breakdown is appended to
  // both note shapes, so both have to survive the round trip.
  const withCostRow = results.results.filter((attempt) =>
    attempt.criteria.some((criterion) => criterion.name === "API cost"),
  );
  assert.ok(withCostRow.length >= 2, "fixtures must cover a priced and an unpriced attempt");

  let priced = 0;
  let unpriced = 0;

  for (const attempt of withCostRow) {
    const usage = fixtureUsage(attempt.id);
    const tokens = parseTokenNote(costNote(attempt));

    assert.deepEqual(
      tokens,
      { input: usage.input_tokens, output: usage.output_tokens, cacheRead: usage.cache_read_tokens },
      `the dashboard could not read the token counts back out of ${attempt.id}'s note: ${costNote(attempt)}`,
    );
    // `attemptTokens` is what the components actually call; same note, via the row lookup.
    assert.deepEqual(attemptTokens(attempt), tokens);

    if (attempt.cost === null) unpriced += 1;
    else priced += 1;
  }

  assert.ok(priced > 0 && unpriced > 0, `expected both note shapes; saw ${priced} priced, ${unpriced} unpriced`);
});

test("the dollar figure in the note is the cost results.json carries, formatted", () => {
  const results = run();
  const attempt = results.results.find((result) => result.cost !== null);
  assert.ok(attempt !== undefined, "fixtures must include one priced attempt");

  const pricing = isModelId(attempt.modelBaseId) ? MODEL_PRICING[attempt.modelBaseId] : null;
  assert.ok(pricing !== null && pricing !== undefined, `${attempt.modelBaseId} must be priced for this test`);

  // The table cell parses the "$" out of the note rather than reading
  // `attempt.cost`, because it renders from the criteria rows. The two must not
  // disagree — a cell showing a figure no total counts is the failure mode.
  const row = attempt.criteria.find((criterion) => criterion.name === "API cost")!;
  assert.equal(formatAttemptScore(row), formatCost(attempt.cost));
  assert.equal(formatAttemptScore(row), formatCost(imputedCost(fixtureUsage(attempt.id), pricing)));
});

test('an unpriced attempt\'s cost cell reads "N/A", not a dollar figure', () => {
  const results = run();
  const attempt = results.results.find((result) => result.cost === null && attemptTokens(result) !== null);
  assert.ok(attempt !== undefined, "fixtures must include one unpriced attempt with tokens");

  const row = attempt.criteria.find((criterion) => criterion.name === "API cost")!;
  assert.equal(formatAttemptScore(row), "N/A");
  assert.doesNotMatch(row.notes, /\$/);
});

test("no cost surface can render $0", () => {
  // Ruling R14 covers a positive cost under one cent. An exact zero is the same
  // mistake in a worse form: with a known list price it would publish "$0.00"
  // beside models showing nothing because their price is unknown, and read as
  // "this one was free" when the truth is that its token counts were zero.
  assert.equal(formatCost(0), "—");
  assert.equal(formatCost(null), "—");
  assert.equal(formatCost(0.004), "<$0.01");
  assert.equal(formatCost(0.01), "$0.01");
  assert.equal(formatCost(1234.5), "$1234.50");
});

// --- family aggregation ------------------------------------------------------

test("the dashboard's client-side family aggregation reproduces familyAverages exactly", () => {
  const results = run();
  assert.ok(results.familyAverages.length > 0, "fixtures must produce at least one family");

  // The dashboard re-aggregates families in the browser so a family card
  // describes the rows currently under it (`aggregateFamilies` in
  // `comparisonUtils.ts`). With nothing filtered out it must land on exactly
  // what `process-results.ts` computed, or the page contradicts its own JSON.
  assert.deepEqual(aggregateFamilies(results.results, results.familyAverages), results.familyAverages);
});

test("filtering attempts out changes the family numbers rather than keeping stale ones", () => {
  const results = run();
  const multi = results.familyAverages.find((family) => family.attemptCount > 1);
  assert.ok(multi !== undefined, "fixtures must produce one family with several attempts");

  const kept = results.results.filter((result) => result.modelFamily === multi.modelBaseId).slice(0, 1);
  const [recomputed] = aggregateFamilies(kept, results.familyAverages);

  assert.equal(recomputed.attemptCount, 1);
  assert.equal(recomputed.averagePercentage, kept[0].percentage);
  // Task 5 still owns everything an attempt does not carry.
  assert.equal(recomputed.modelName, multi.modelName);
  assert.deepEqual(recomputed.pricing, multi.pricing);
});

// --- the filters and the fractional rows (spec §4) ------------------------------

test("the dashboard's filters name rubric.ts's rows, so none can silently hide every attempt", () => {
  assert.deepEqual([...HIDDEN_TEST_ROWS], HIDDEN_ROWS.map((row) => row.name));
  assert.ok(RUBRIC_ROWS.some((row) => row.name === TECH_STACK_ROW && row.scoredBy === "agent"), TECH_STACK_ROW);
  const component = readFileSync(fileURLToPath(new URL("../website/src/components/DetailedComparison.tsx", import.meta.url)), "utf8");
  assert.ok(
    component.includes("HIDDEN_TEST_ROWS.every(") && component.includes("hasMaxScore(attempt, TECH_STACK_ROW)"),
    "DetailedComparison filters on the shared names",
  );
  assert.equal(/"Tech stack"|DATA_QUALITY_CRITERIA/.test(component), false, "no filter on an old row name");

  // Every bare string literal handed to hasMaxScore must also be a rubric.ts row
  // name, so a typo or a stale label cannot silently exclude every attempt.
  const rubricNames = new Set(RUBRIC_ROWS.map((row) => row.name));
  const literalFilters = [...component.matchAll(/hasMaxScore\(\s*\w+\s*,\s*"([^"]+)"\s*\)/g)].map((match) => match[1]);
  assert.ok(literalFilters.length > 0, "expected at least one literal filter name in DetailedComparison.tsx");
  for (const name of literalFilters) {
    assert.ok(rubricNames.has(name), `"${name}" is not a rubric.ts row name`);
  }
});

test("a fractional hidden-test score shows its two decimals, in the partial colour", () => {
  const opus = run().results.find((result) => result.id === "claude-opus-46-high-attempt-1");
  assert.ok(opus !== undefined);
  const row = opus.criteria.find((criterion) => criterion.name === "API contract");
  assert.ok(row !== undefined && row.score !== null);
  assert.equal(formatAttemptScore(row), "1.67");
  assert.equal(getScoreColor(row.score, row.max), "bg-yellow-900 text-yellow-200");
});
