/**
 * `scripts/process-results.ts` — CSVs plus `run.json` into the dashboard's JSON.
 *
 * Everything runs against the real fixture tree in `test/fixtures/eval-results/`
 * and writes into a fresh temp directory, so the checkout's own `eval-results/`
 * and `website/` are never read or written. The fixture tree deliberately holds
 * one of every case the pipeline has to survive: a clean attempt, a penalised
 * one, a hard-stop all-zero one, an infrastructure failure, an attempt with no
 * `run.json`, and a directory whose name is not an attempt name at all.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import {
  formatDuration,
  imputedCost,
  parseCriteriaCsv,
  processResults,
  scoreAttempt,
  type AttemptResult,
  type CriterionResult,
  type LeaderboardPayload,
  type ProcessedResults,
} from "../scripts/process-results";
import { DISABLED_MODELS, MODEL_PRICING } from "../eval-attempts/metadata";
import { CONTRACT_RESULTS_FILE, writeContractResults, type ContractResults } from "../scripts/lib/contract-results";
import { RUBRIC_ROWS } from "../scripts/lib/rubric";
import { BROWNFIELD_RUBRIC_ROWS } from "../scripts/lib/brownfield-rubric";
import { FIXTURE_PASSED, FIXTURE_RUBRIC, contractResultsFixture, fixtureText } from "./fixtures/contract-results-fixture";

const FIXTURES = fileURLToPath(new URL("fixtures/eval-results", import.meta.url));
/** Two attempts whose CSVs carry an `API cost` row the judge never writes. */
const STRAY_COST_FIXTURES = fileURLToPath(new URL("fixtures/eval-results-stray-cost", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../scripts/process-results.ts", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const tempDirs: string[] = [];

function tempDir(prefix = "agrav-process-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

interface Run {
  results: ProcessedResults;
  leaderboard: LeaderboardPayload;
  warnings: string[];
  resultsJsonPath: string;
  leaderboardJsonPath: string;
}

function run(resultsDir: string = FIXTURES): Run {
  const out = tempDir();
  const resultsJsonPath = join(out, "website", "src", "data", "results.json");
  const leaderboardJsonPath = join(out, "website", "public", "api", "leaderboard.json");
  const warnings: string[] = [];
  const outcome = processResults({
    resultsDir,
    resultsJsonPath,
    leaderboardJsonPath,
    warn: (message) => warnings.push(message),
    rubric: FIXTURE_RUBRIC,
  });
  return { ...outcome, warnings, resultsJsonPath, leaderboardJsonPath };
}

function attempt(results: ProcessedResults, id: string): AttemptResult {
  const found = results.results.find((result) => result.id === id);
  assert.ok(found !== undefined, `expected ${id} in results: ${results.results.map((r) => r.id).join(", ")}`);
  return found;
}

/**
 * A complete, contract-shaped CSV — real fixture bytes off disk, mutated one
 * row at a time, so an error-path test differs from a valid file only in the
 * thing it is testing.
 */
const CONTRACT_CSV = readFileSync(join(FIXTURES, "gemini-38-flash-low-attempt-1", "eval-results.csv"), "utf8");

function csvLines(): string[] {
  return CONTRACT_CSV.trimEnd().split("\n");
}

function rowIndex(lines: string[], name: string): number {
  const index = lines.findIndex((line) => line.startsWith(`${name},`));
  assert.notEqual(index, -1, `no ${name} row in the contract CSV`);
  return index;
}

/** Any CSV with one row replaced. */
function rowReplaced(csv: string, name: string, replacement: string): string {
  const lines = csv.trimEnd().split("\n");
  lines[rowIndex(lines, name)] = replacement;
  return `${lines.join("\n")}\n`;
}

/** The contract CSV with one row replaced. */
function withRow(name: string, replacement: string): string {
  return rowReplaced(CONTRACT_CSV, name, replacement);
}

/** The contract CSV with one row removed. */
function withoutRow(name: string): string {
  const lines = csvLines();
  lines.splice(rowIndex(lines, name), 1);
  return `${lines.join("\n")}\n`;
}

/** A results directory holding one attempt, written from real fixture bytes, with a contract-results.json that passes every hidden test unless `contract` says otherwise. */
function resultsDirWith(dirName: string, csv: string, runJson?: unknown, contract: ContractResults | null = contractResultsFixture(dirName)): string {
  const dir = tempDir("agrav-one-attempt-");
  const attemptDir = join(dir, dirName);
  mkdirSync(attemptDir, { recursive: true });
  writeFileSync(join(attemptDir, "eval-results.csv"), csv, "utf8");
  if (runJson !== undefined) {
    writeFileSync(join(attemptDir, "run.json"), `${JSON.stringify(runJson, null, 2)}\n`, "utf8");
  }
  if (contract !== null) writeContractResults(join(attemptDir, CONTRACT_RESULTS_FILE), contract);
  return dir;
}

function criterion(result: AttemptResult, name: string): CriterionResult {
  const found = result.criteria.find((entry) => entry.name === name);
  assert.ok(found !== undefined, `expected a ${name} row in ${result.id}`);
  return found;
}

// --- CSV parsing ------------------------------------------------------------

test("a quoted note containing a comma survives intact", () => {
  const path = join(FIXTURES, "gemini-38-flash-high-attempt-1", "eval-results.csv");
  const criteria = parseCriteriaCsv(readFileSync(path, "utf8"), path);

  // A regex such as /^"?([^",]+)"?,(.+?),(.+?),(.*)$/ splits this note at its first
  // comma and leaves the trailing half in a column of its own.
  const techStack = criteria.find((entry) => entry.name === "Tech stack & run contract")!;
  assert.equal(techStack.notes, "FastAPI and React present, but the frontend hard-codes the API's origin");

  // Embedded double quotes come back unescaped, and the wrapping quotes are gone.
  const localBuild = criteria.find((entry) => entry.name === "Local build")!;
  assert.equal(localBuild.notes, '"npm run build" succeeded, and the backend answered /api/v1/health');

  assert.equal(criteria.length, 14);
  assert.deepEqual(criteria.slice(0, 3).map((entry) => entry.name), [
    "Task completion time",
    "Test run",
    "Local build",
  ]);
});

test("a non-numeric Score on a scored row is refused, naming the file and the row", () => {
  assert.throws(
    () => parseCriteriaCsv(withRow("Local build", 'Local build,yes,1,"Build successful"'), "/tmp/eval-results.csv"),
    /\/tmp\/eval-results\.csv: row 3 \(Local build\) has a non-numeric Score "yes"/,
  );
});

test('"N/A" on a scored row means zero, as the hard-stop CSV writes it', () => {
  const criteria = parseCriteriaCsv(withRow("Local build", 'Local build,N/A,1,"Not evaluated"'), "x.csv");
  assert.equal(criteria.find((entry) => entry.name === "Local build")!.score, 0);
});

test("a missing column is refused rather than silently dropped", () => {
  const csv = ["Criterion,Score,Notes", "Local build,1,ok"].join("\n");
  assert.throws(() => parseCriteriaCsv(csv, "x.csv"), /missing the Max column/);
});

// --- the row set: a partial CSV must never reach a percentage ---------------

test("a CSV missing rows is refused, naming the file and the rows", () => {
  const lines = csvLines().filter((line) => !/^(Consistent UI|Code structure),/.test(line));
  assert.throws(() => parseCriteriaCsv(`${lines.join("\n")}\n`, "/tmp/eval-results.csv"), (error: Error) => {
    assert.match(error.message, /^\/tmp\/eval-results\.csv: missing row\(s\) "Code structure", "Consistent UI"\./);
    assert.match(error.message, /would score out of a smaller denominator/);
    return true;
  });
});

test("a header-only CSV is refused rather than published as a 0%", () => {
  // The worst shape: 0 / 0 reads on the dashboard as a model that scored
  // nothing, and drags its family average down with it.
  assert.throws(() => parseCriteriaCsv("Criterion,Score,Max,Notes\n", "x.csv"), /missing row\(s\) .*"Penalty"/);
  assert.throws(() => parseCriteriaCsv("Criterion,Score,Max,Notes\n", "x.csv"), /all 14 rows/);
});

test("a three-row CSV is refused rather than published as a 100%", () => {
  const lines = csvLines().filter((line) => /^(Criterion|Task completion time|Test run|Local build),/.test(line));
  assert.throws(() => parseCriteriaCsv(`${lines.join("\n")}\n`, "x.csv"), /missing row\(s\) "API contract"/);
});

test("a duplicated row is refused rather than counted twice", () => {
  const lines = csvLines();
  lines.push('Local build,1,1,"Build successful"');
  assert.throws(() => parseCriteriaCsv(`${lines.join("\n")}\n`, "x.csv"), /duplicate row\(s\) "Local build"/);
});

test("a mis-cased or renamed row is refused rather than scored as an extra criterion", () => {
  // Capital C: not the tolerated `API cost`, so it would otherwise be scored as
  // a fifteenth row and land in the denominator.
  const numeric = csvLines().concat('API Cost,0.42,1,"0.42"');
  assert.throws(() => parseCriteriaCsv(`${numeric.join("\n")}\n`, "x.csv"), /unrecognised row\(s\) "API Cost"/);

  // With a dollar sign it never gets that far — the Score guard has it first.
  const dollars = csvLines().concat('API Cost,$0.42,N/A,"$0.42"');
  assert.throws(() => parseCriteriaCsv(`${dollars.join("\n")}\n`, "x.csv"), /has a non-numeric Score "\$0\.42"/);

  // A renamed row is a missing row, whatever else it is.
  assert.throws(
    () => parseCriteriaCsv(withRow("Code structure", 'Code Structure,1,1,"Modules split"'), "x.csv"),
    /missing row\(s\) "Code structure"/,
  );
});

test('the one tolerated extra row is "API cost", which Ruling R11 drops later', () => {
  const lines = csvLines();
  lines.push('API cost,$0.42,N/A,"$0.42 (hand-written)"');
  const criteria = parseCriteriaCsv(`${lines.join("\n")}\n`, "x.csv");
  assert.equal(criteria.length, 15);
  assert.ok(criteria.some((entry) => entry.name === "API cost"));
});

test("a CSV's rows are rubric.ts's 14, in its order", () => {
  const criteria = parseCriteriaCsv(CONTRACT_CSV, "x.csv");
  assert.deepEqual(criteria.map((entry) => entry.name), RUBRIC_ROWS.map((row) => row.name));
});

test("every rubric row's Max is the one rubric.ts gives, and N/A where it gives none", () => {
  // A Max of 2 on a max-1 row would score the attempt out of 15 and publish a
  // plausible percentage; N/A on a scored row would drop it from the denominator.
  assert.throws(
    () => parseCriteriaCsv(withRow("Local build", 'Local build,1,2,"Build successful"'), "x.csv"),
    /x\.csv: row 3 \(Local build\) has Max "2"; rubric\.ts gives 1/,
  );
  assert.throws(
    () => parseCriteriaCsv(withRow("API contract", 'API contract,2,N/A,"24/24 passed"'), "x.csv"),
    /row 4 \(API contract\) has Max "N\/A"; rubric\.ts gives 2/,
  );
  assert.throws(
    () => parseCriteriaCsv(withRow("Penalty", 'Penalty,0,1,"No penalty applied"'), "x.csv"),
    /row 14 \(Penalty\) has Max "1"; rubric\.ts gives N\/A/,
  );
});

test("a Score outside what criteria.md allows stops the run", () => {
  // Nothing bounded the Score before: `Local build,10,1` with `Penalty,-3,N/A`
  // parsed to 26 out of 14 and published as 185.71%.
  const cases: ReadonlyArray<readonly [name: string, line: string, expected: RegExp]> = [
    ["Local build", 'Local build,10,1,"Build successful"', /x\.csv: row 3 \(Local build\) has Score "10"; expected 0 or 1/],
    ["Local build", 'Local build,0.5,1,"Half a build"', /\(Local build\) has Score "0\.5"; expected 0 or 1/],
    ["API contract", 'API contract,2.5,2,"25/24 passed"', /\(API contract\) has Score "2\.5"; expected a number from 0 to 2/],
    ["API contract", 'API contract,-1,2,"?"', /\(API contract\) has Score "-1"; expected a number from 0 to 2/],
    ["API contract", 'API contract,1.666,2,"20/24 passed"', /\(API contract\) has Score "1\.666"; expected at most two decimals/],
    ["Code structure", 'Code structure,0.75,1,"Mixed"', /\(Code structure\) has Score "0\.75"; expected 1, 0\.5 or 0/],
    ["Manual testing", 'Manual testing,2,1,"Worked"', /\(Manual testing\) has Score "2"; expected a number from 0 to 1/],
    ["Penalty", 'Penalty,-3,N/A,"A bonus, apparently"', /\(Penalty\) has Score "-3"; expected a number from 0 to 1/],
    ["Penalty", 'Penalty,0.25,N/A,"A quarter"', /\(Penalty\) has Score "0\.25"; expected 0, 0\.5 or 1/],
  ];
  for (const [name, line, expected] of cases) {
    assert.throws(() => parseCriteriaCsv(withRow(name, line), "x.csv"), expected, line);
  }
});

test("a number in an info row's Score is refused by its own format, not by Local build's rule", () => {
  // Both info rows are `scoredBy: "auto"`, so a number there used to be refused
  // with "expected 0 or 1" — the right outcome pointing at the wrong rule.
  const cases: ReadonlyArray<readonly [name: string, line: string, expected: RegExp]> = [
    [
      "Task completion time",
      'Task completion time,5,N/A,"5"',
      /\(Task completion time\) has Score "5"; expected the elapsed time as `Xmin Ys` \(`5min 46s`\) or `N\/A`, not a number/,
    ],
    [
      "Test run",
      'Test run,16.04,N/A,"16.04"',
      /\(Test run\) has Score "16\.04"; expected the run's date as `D\.MM\.YYYY HH:MM` \(`16\.04\.2026 21:25`\), not a number/,
    ],
  ];
  for (const [name, line, expected] of cases) {
    assert.throws(() => parseCriteriaCsv(withRow(name, line), "x.csv"), expected, line);
  }
  // …and the formats themselves still parse.
  for (const line of ['Task completion time,5min 46s,N/A,"5min 46s"', 'Test run,16.04.2026 21:25,N/A,"16.04.2026 21:25"']) {
    const name = line.slice(0, line.indexOf(","));
    assert.equal(parseCriteriaCsv(withRow(name, line), "x.csv").length, RUBRIC_ROWS.length, line);
  }
});

test("every Score criteria.md does allow parses, the fixtures included", () => {
  assert.equal(parseCriteriaCsv(CONTRACT_CSV, "x.csv").length, RUBRIC_ROWS.length);
  for (const line of [
    'Local build,0,1,"No build"',
    'API contract,1.67,2,"20/24 passed"',
    'API contract,0,2,"0/24 passed"',
    'Code structure,0.5,1,"Partly"',
    'Manual testing,0,1,"Nothing worked"',
    'Penalty,0.5,N/A,"Half a penalty"',
    // "N/A" on a scored row is the rubric's 0, and the all-zero CSV is written
    // that way; the bound check must not turn it into an error.
    'Penalty,N/A,N/A,"Not evaluated"',
  ]) {
    const name = line.slice(0, line.indexOf(","));
    assert.equal(parseCriteriaCsv(withRow(name, line), "x.csv").length, RUBRIC_ROWS.length, line);
  }
});

// --- brownfield Diff locality (continuous auto row) -------------------------

/** A complete brownfield CSV with a configurable Diff locality Score. */
function brownfieldCsv(diffLocalityScore: string): string {
  return [
    "Criterion,Score,Max,Notes",
    "Task completion time,1min 0s,N/A,1min 0s",
    "Test run,04.10.2026 12:00,N/A,04.10.2026 12:00",
    'Local build,1,1,"build ok"',
    'Regression,4,4,"4/4 passed"',
    'Change suite,3,3,"3/3 passed"',
    `Diff locality,${diffLocalityScore},1,"0 outside files, 240 lines changed"`,
    'Code structure,1,1,"clean"',
    'Self-verification,1,1,"clean"',
    'Visual design,1,1,"clean"',
    'Penalty,0,N/A,"none"',
  ].join("\n") + "\n";
}

test("brownfield Diff locality accepts a fractional score like 0.57", () => {
  const criteria = parseCriteriaCsv(brownfieldCsv("0.57"), "bf.csv", BROWNFIELD_RUBRIC_ROWS);
  const diffLocality = criteria.find((c) => c.name === "Diff locality")!;
  assert.equal(diffLocality.score, 0.57);
});

test("brownfield Diff locality 0.57 scores and percentages correctly", () => {
  const criteria = parseCriteriaCsv(brownfieldCsv("0.57"), "bf.csv", BROWNFIELD_RUBRIC_ROWS);
  const scored = scoreAttempt(criteria);
  // max = 1+4+3+1+1+1+1 = 12, total = 1+4+3+0.57+1+1+1-0 = 11.57
  assert.equal(scored.totalScore, 11.57);
  assert.equal(scored.maxScore, 12);
  assert.equal(scored.percentage, (11.57 / 12) * 100);
});

test("brownfield Diff locality boundary values 0 and 1 are accepted", () => {
  assert.equal(parseCriteriaCsv(brownfieldCsv("0"), "bf.csv", BROWNFIELD_RUBRIC_ROWS).length, BROWNFIELD_RUBRIC_ROWS.length);
  assert.equal(parseCriteriaCsv(brownfieldCsv("1"), "bf.csv", BROWNFIELD_RUBRIC_ROWS).length, BROWNFIELD_RUBRIC_ROWS.length);
  assert.equal(parseCriteriaCsv(brownfieldCsv("0.5"), "bf.csv", BROWNFIELD_RUBRIC_ROWS).length, BROWNFIELD_RUBRIC_ROWS.length);
  assert.equal(parseCriteriaCsv(brownfieldCsv("0.99"), "bf.csv", BROWNFIELD_RUBRIC_ROWS).length, BROWNFIELD_RUBRIC_ROWS.length);
});

test("brownfield Diff locality rejects out-of-range and too-many-decimals scores", () => {
  const rejectCases: ReadonlyArray<readonly [score: string, pattern: RegExp]> = [
    ["1.5", /\(Diff locality\) has Score "1\.5"; expected a number from 0 to 1/],
    ["-0.1", /\(Diff locality\) has Score "-0\.1"; expected a number from 0 to 1/],
    ["0.575", /\(Diff locality\) has Score "0\.575"; expected at most two decimal places/],
  ];
  for (const [score, expected] of rejectCases) {
    assert.throws(
      () => parseCriteriaCsv(brownfieldCsv(score), "bf.csv", BROWNFIELD_RUBRIC_ROWS),
      expected,
      `Diff locality ${score} should be rejected`,
    );
  }
});

test("brownfield Local build 0.5 is still rejected as binary", () => {
  const csv = brownfieldCsv("0.57").replace('Local build,1,1,"build ok"', 'Local build,0.5,1,"half"');
  assert.throws(
    () => parseCriteriaCsv(csv, "bf.csv", BROWNFIELD_RUBRIC_ROWS),
    /\(Local build\) has Score "0\.5"; expected 0 or 1/,
  );
});

test("a truncated CSV stops the run instead of publishing a percentage", () => {
  const dir = resultsDirWith("gemini-38-flash-high-attempt-9", withoutRow("Responsive design"));
  const result = processResultsCli("--root", tempDir("agrav-truncated-root-"), "--results-dir", dir, "--rubric", FIXTURE_RUBRIC);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing row\(s\) "Responsive design"/);
  assert.match(result.stderr, /Re-run the agrav-score-attempt skill/);
});

// --- score math -------------------------------------------------------------

test("the hand-checked attempt scores 11 / 14", () => {
  const { results } = run();
  const penalised = attempt(results, "gemini-38-flash-high-attempt-1");

  // Local build 1, the hidden rows 1.5 + 1.5 + 1 + 2, the agent rows 1 + 0.5 +
  // 0.5, the human rows 1 + 1 + 1: 12, minus a Penalty of 1 → 11. The two info
  // rows and Penalty are outside the denominator, so max is 14.
  assert.equal(penalised.totalScore, 11);
  assert.equal(penalised.maxScore, 14);
  assert.equal(penalised.percentage, (11 / 14) * 100);
});

test("Penalty is subtracted, and lowers the total by exactly its score", () => {
  const path = join(FIXTURES, "gemini-38-flash-high-attempt-1", "eval-results.csv");
  const criteria = parseCriteriaCsv(readFileSync(path, "utf8"), path);
  assert.equal(criteria.find((entry) => entry.name === "Penalty")!.score, 1);

  const withPenalty = scoreAttempt(criteria);
  const withoutPenalty = scoreAttempt(
    criteria.map((entry) => (entry.name === "Penalty" ? { ...entry, score: 0 } : entry)),
  );

  assert.equal(withoutPenalty.totalScore - withPenalty.totalScore, 1);
  assert.equal(withoutPenalty.maxScore, withPenalty.maxScore);
  assert.equal(withoutPenalty.percentage, (12 / 14) * 100);
});

test("the four excluded rows stay out of the denominator", () => {
  const criteria: CriterionResult[] = [
    { name: "Task completion time", score: null, max: 1, notes: "5min 46s" },
    { name: "Test run", score: null, max: 1, notes: "4.09.2026 22:31" },
    { name: "API cost", score: null, max: 1, notes: "$1.5000 (imputed ...)" },
    { name: "Local build", score: 1, max: 1, notes: "" },
    { name: "Penalty", score: 0, max: 1, notes: "" },
  ];
  assert.deepEqual(scoreAttempt(criteria), { totalScore: 1, maxScore: 1, percentage: 100 });
});

// --- info rows --------------------------------------------------------------

test("info rows carry score: null and their display string in notes", () => {
  const { results } = run();
  const clean = attempt(results, "gemini-38-flash-high-attempt-1");

  const time = criterion(clean, "Task completion time");
  assert.equal(time.score, null);
  assert.equal(time.notes, "5min 46s"); // 346000 ms, from run.json — not the CSV's copy

  const testRun = criterion(clean, "Test run");
  assert.equal(testRun.score, null);
  // parseFloat would turn this into the number 4.09.
  assert.equal(testRun.notes, "4.09.2026 22:31");

  assert.equal(criterion(clean, "API cost").score, null);
});

test("Task completion time comes from run.json, overriding the CSV", () => {
  assert.equal(formatDuration(346000), "5min 46s");
  assert.equal(formatDuration(421000), "7min 1s");
  assert.equal(formatDuration(42000), "0min 42s");
  assert.equal(formatDuration(4_384_000), "73min 4s");

  const { results } = run();
  // The CSV says "15min 0s" and run.json's durationMs agrees; the point is that
  // the value shown is derived, so a judge typo cannot reach the dashboard.
  assert.equal(criterion(attempt(results, "gemini-31-pro-high-attempt-1"), "Task completion time").notes, "15min 0s");
});

// --- imputed cost -----------------------------------------------------------

test("the API cost row is imputed from run.json's token counts", () => {
  const { results } = run();
  const opus = attempt(results, "claude-opus-46-high-attempt-1");

  // 100k in x $5 + 20k out x $25 + 1M cache read x $0.50, per 1M tokens.
  assert.equal(opus.cost, 1.5);
  const cost = criterion(opus, "API cost");
  assert.equal(cost.notes, "$1.5000 (imputed list-price estimate; in 100000 / out 20000 / cache read 1000000)");
  // The dashboard reads a cost row by matching a "$" amount in its notes.
  assert.match(cost.notes, /\$[0-9]+(?:\.[0-9]+)?/);

  // The cost row sits directly after Test run.
  const names = opus.criteria.map((entry) => entry.name);
  assert.equal(names.indexOf("API cost"), names.indexOf("Test run") + 1);
});

test("imputedCost prices cache reads at the cache-read rate, not the input rate", () => {
  const pricing = MODEL_PRICING["claude-opus-46-high"]!;
  assert.equal(pricing.cacheRead, 0.5);
  assert.equal(
    imputedCost(
      { input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 1_000_000, thinking_tokens: 0, total_tokens: 0 },
      pricing,
    ),
    5.5,
  );
});

test("thinking_tokens do not move the cost — they are a subset of output (Ruling R10)", () => {
  const pricing = MODEL_PRICING["claude-opus-46-high"]!;
  const usage = {
    input_tokens: 100_000,
    output_tokens: 1_000_000,
    cache_read_tokens: 0,
    thinking_tokens: 0,
    total_tokens: 0,
  };
  // 100k in x $5 + 1M out x $25, whatever share of the output was thinking.
  assert.equal(imputedCost(usage, pricing), 25.5);
  assert.equal(imputedCost({ ...usage, thinking_tokens: 900_000 }, pricing), 25.5);
  // The falsifier the assumption is written against: an envelope where
  // reasoning exceeds output would mean the counts do not overlap and the
  // formula understates. metadata.ts says what to do about it.
  assert.equal(imputedCost({ ...usage, thinking_tokens: 2_000_000 }, pricing), 25.5);
});

test("a stray API cost row in a CSV is dropped, not published (Ruling R11)", () => {
  const { results, warnings } = run(STRAY_COST_FIXTURES);

  // No usage to impute from, so the row goes and nothing replaces it: an
  // attempt shows no cost rather than a figure no total counts.
  const noUsage = attempt(results, "gpt-oss-120b-med-attempt-1");
  assert.equal(
    noUsage.criteria.some((entry) => entry.name === "API cost"),
    false,
    JSON.stringify(noUsage.criteria.map((entry) => entry.name)),
  );
  assert.equal(noUsage.cost, null);

  // With usage, the imputed row replaces it — and disagrees with it, which is
  // the whole reason the CSV's figure cannot be trusted.
  const priced = attempt(results, "claude-opus-46-high-attempt-2");
  assert.equal(priced.cost, 3);
  assert.equal(
    criterion(priced, "API cost").notes,
    "$3.0000 (imputed list-price estimate; in 200000 / out 40000 / cache read 2000000)",
  );
  assert.equal(priced.criteria.filter((entry) => entry.name === "API cost").length, 1);

  for (const dirName of ["gpt-oss-120b-med-attempt-1", "claude-opus-46-high-attempt-2"]) {
    assert.ok(
      warnings.some((message) => message.includes(`${dirName} — dropping the "API cost" row`)),
      warnings.join("\n"),
    );
  }
  // The dropped figure is quoted in the warning so it can be traced.
  assert.ok(
    warnings.some((message) => message.includes("$0.9900 (hand-written;")),
    warnings.join("\n"),
  );
});

test("a run.json belonging to another configuration is ignored, not believed", () => {
  // The model id comes from the directory name; `runJson.id` was never read. A
  // run.json copied into the wrong attempt directory during a partial re-run
  // would have imputed another configuration's duration and cost here, with
  // nothing on the dashboard to show it had happened.
  const dir = resultsDirWith("gemini-38-flash-low-attempt-1", CONTRACT_CSV, {
    id: "claude-opus-46-high",
    model: "claude-opus-4-6",
    effort: "high",
    agyVersion: "1.1.26",
    image: "agrav-bench/harness:2026-09-05@sha256:5555555555555555555555555555555555555555555555555555555555555555",
    startedAt: "2026-09-04T18:20:00.000Z",
    durationMs: 421000,
    exitCode: 0,
    envelope: {
      status: "SUCCESS",
      num_turns: 51,
      duration_seconds: 420,
      usage: {
        input_tokens: 100000,
        output_tokens: 20000,
        cache_read_tokens: 1000000,
        thinking_tokens: 5000,
        total_tokens: 1120000,
      },
      conversation_id: "55555555-5555-5555-5555-555555555555",
    },
    stderrTail: "",
    softDenied: false,
    failureKind: null,
  });

  const { results, warnings } = run(dir);
  const wrong = attempt(results, "gemini-38-flash-low-attempt-1");

  assert.ok(
    warnings.some((message) => message.includes('records id "claude-opus-46-high" but sits in a "gemini-38-flash-low"')),
    warnings.join("\n"),
  );
  // Unavailable, not another configuration's numbers.
  assert.equal(wrong.cost, null);
  assert.equal(criterion(wrong, "Task completion time").notes, "N/A");
});

test("an attempt of a disabled model is dropped out loud, not in silence", () => {
  const dir = resultsDirWith("gemini-38-flash-low-attempt-1", CONTRACT_CSV);
  DISABLED_MODELS.add("gemini-38-flash-low");
  try {
    const { results, warnings } = run(dir);
    assert.equal(results.results.length, 0);
    assert.ok(
      warnings.some((message) => message.includes('"gemini-38-flash-low" is in DISABLED_MODELS')),
      `dropping a whole family in silence is how somebody ends up asking why the dashboard is missing ` +
        `rows whose CSVs are on disk. Warnings were: ${warnings.join("\n")}`,
    );
  } finally {
    DISABLED_MODELS.delete("gemini-38-flash-low");
  }
});

test("dropping a stray cost row does not change the score", () => {
  const { results } = run(STRAY_COST_FIXTURES);
  // Every row at its max, no penalty — the cost row was never in the
  // denominator on either side of the drop.
  assert.equal(attempt(results, "gpt-oss-120b-med-attempt-1").percentage, 100);
  assert.equal(attempt(results, "claude-opus-46-high-attempt-2").maxScore, 14);
});

test("an envelope reporting no tokens publishes no cost, not $0.00", () => {
  // The account is a subscription; nobody knows yet whether agy's envelope
  // reports real token counts for it or zeros. If it reports zeros, this is the
  // difference between the dashboard saying six configurations cost $0.00 —
  // "these were free, those are unknown" — and saying all nine are unknown,
  // which is the truth. The `null` path is the one that already exists for a
  // model with no list price, three lines away.
  const dir = resultsDirWith("claude-opus-46-high-attempt-4", CONTRACT_CSV, {
    id: "claude-opus-46-high",
    model: "claude-opus-4-6",
    effort: "high",
    agyVersion: "1.1.26",
    image: "agrav-bench/harness:2026-09-05@sha256:2222222222222222222222222222222222222222222222222222222222222222",
    startedAt: "2026-09-04T18:20:00.000Z",
    durationMs: 421000,
    exitCode: 0,
    envelope: {
      status: "SUCCESS",
      num_turns: 51,
      duration_seconds: 420,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        thinking_tokens: 0,
        total_tokens: 0,
      },
      conversation_id: "44444444-4444-4444-4444-444444444444",
    },
    stderrTail: "",
    softDenied: false,
    failureKind: null,
  });
  const { results, warnings } = run(dir);
  const zero = attempt(results, "claude-opus-46-high-attempt-4");

  assert.notEqual(MODEL_PRICING["claude-opus-46-high"], null, "this test needs a priced model");
  assert.equal(zero.cost, null);
  assert.equal(
    criterion(zero, "API cost").notes,
    "N/A (envelope reported no billable tokens for claude-opus-46-high; in 0 / out 0 / cache read 0)",
  );
  // No "$" in the note, so the table cell reads N/A rather than a dollar figure.
  assert.doesNotMatch(criterion(zero, "API cost").notes, /\$/);
  assert.ok(
    warnings.some((message) => message.includes("reports 0 input, 0 output and 0 cache-read tokens")),
    warnings.join("\n"),
  );

  // …and the aggregate does not count it as a free run either.
  const average = results.modelAverages.find((entry) => entry.modelBaseId === "claude-opus-46-high")!;
  assert.equal(average.averageCost, null);
  assert.equal(average.totalCost, null);
  assert.equal(average.costCount, 0);
});

test("a model with no public list price gets no cost, but keeps its token counts", () => {
  const { results } = run();
  const flash = attempt(results, "gemini-38-flash-high-attempt-1");
  assert.equal(MODEL_PRICING["gemini-38-flash-high"], null);
  assert.equal(flash.cost, null);
  assert.equal(
    criterion(flash, "API cost").notes,
    "N/A (no public list price for gemini-38-flash-high; in 50000 / out 10000 / cache read 200000)",
  );
});

// --- which attempts count ---------------------------------------------------

test('an "infra" attempt is skipped with a warning even though it has a CSV', () => {
  const { results, warnings } = run();
  assert.equal(
    results.results.some((result) => result.id === "claude-sonnet-46-high-attempt-1"),
    false,
  );
  assert.ok(existsSync(join(FIXTURES, "claude-sonnet-46-high-attempt-1", "eval-results.csv")));
  assert.ok(
    warnings.some((message) => /claude-sonnet-46-high-attempt-1 — run\.json records an infrastructure failure/.test(message)),
    warnings.join("\n"),
  );
});

test('a "model" failure is a data point and scores 0', () => {
  const { results } = run();
  const timedOut = attempt(results, "gemini-31-pro-high-attempt-1");
  assert.equal(timedOut.totalScore, 0);
  assert.equal(timedOut.maxScore, 14);
  assert.equal(timedOut.percentage, 0);
});

test("an attempt with a CSV but no run.json is a warning, not a crash", () => {
  const { results, warnings } = run();
  const orphan = attempt(results, "gemini-31-pro-low-attempt-2");

  assert.equal(orphan.percentage, 75);
  assert.equal(criterion(orphan, "Task completion time").notes, "N/A");
  assert.equal(
    orphan.criteria.some((entry) => entry.name === "API cost"),
    false,
  );
  assert.equal(orphan.cost, null);
  assert.ok(
    warnings.some((message) => /gemini-31-pro-low-attempt-2 has no run\.json/.test(message)),
    warnings.join("\n"),
  );
});

test("an unknown benchmark id is published with a warning, not silently", () => {
  const { results, warnings } = run(resultsDirWith("totally-made-up-id-attempt-1", CONTRACT_CSV));
  const unknown = attempt(results, "totally-made-up-id-attempt-1");

  // It still counts — the CSV is real — but nothing about it is silent.
  assert.equal(unknown.modelName, "totally-made-up-id");
  assert.equal(unknown.modelFamily, "totally-made-up-id");
  assert.equal(unknown.agentEnvironment, "Unknown");
  assert.equal(unknown.percentage, 100);
  assert.ok(
    warnings.some((message) => message.includes('"totally-made-up-id" is not a known benchmark id')),
    warnings.join("\n"),
  );
});

test("a rejected run.json says it was rejected, and that the infra skip is unreachable", () => {
  const dir = resultsDirWith("gemini-38-flash-low-attempt-9", CONTRACT_CSV, {
    id: "gemini-38-flash-low",
    failureKind: "infra", // …but the file is missing every other required field
  });
  const { results, warnings } = run(dir);

  // The attempt is scored, because the failureKind could not be read — which is
  // exactly what the warning has to say out loud.
  assert.equal(attempt(results, "gemini-38-flash-low-attempt-9").percentage, 100);
  assert.ok(
    warnings.some((message) => /run\.json: model must be a string/.test(message)),
    warnings.join("\n"),
  );
  assert.ok(
    warnings.some(
      (message) =>
        message.includes("has a run.json that was rejected as malformed") &&
        message.includes("infrastructure failure recorded in it cannot be honoured"),
    ),
    warnings.join("\n"),
  );
});

// --- the hidden-test rows against contract-results.json -----------------------

/** A model-failure run.json for `id`, the shape the runner writes. */
function modelFailureRunJson(id: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, "gemini-31-pro-high-attempt-1", "run.json"), "utf8").replaceAll("gemini-31-pro-high", id));
}

test("the committed contract-results.json fixtures are the generator's output", () => {
  for (const key of Object.keys(FIXTURE_PASSED)) {
    assert.equal(
      readFileSync(join(FIXTURES, "..", key, CONTRACT_RESULTS_FILE), "utf8"),
      fixtureText(key),
      `${key}: regenerate with node --import tsx test/fixtures/contract-results-fixture.ts`,
    );
  }
});

test("an attempt without contract-results.json stops the run", () => {
  const dir = resultsDirWith("gemini-38-flash-low-attempt-9", CONTRACT_CSV, undefined, null);
  assert.throws(() => run(dir), /gemini-38-flash-low-attempt-9: no contract-results\.json/);
});

test("a hidden-test row that disagrees with contract-results.json stops the run, naming both scores", () => {
  const dir = resultsDirWith("gemini-38-flash-low-attempt-9", CONTRACT_CSV, undefined, contractResultsFixture("gemini-38-flash-low-attempt-9", [24, 6, 11, 11]));
  assert.throws(() => run(dir), /"Planner: assignment rules" is 2 in eval-results\.csv but 1 in contract-results\.json/);
});

test("another attempt's contract-results.json stops the run", () => {
  const dir = resultsDirWith("gemini-38-flash-low-attempt-9", CONTRACT_CSV, undefined, contractResultsFixture("gemini-38-flash-low-attempt-8"));
  assert.throws(() => run(dir), /records attempt "gemini-38-flash-low-attempt-8"/);
});

test("an invalid contract-results.json stops the run, naming the file", () => {
  const dir = resultsDirWith("gemini-38-flash-low-attempt-9", CONTRACT_CSV);
  const path = join(dir, "gemini-38-flash-low-attempt-9", CONTRACT_RESULTS_FILE);
  writeFileSync(path, readFileSync(path, "utf8").replace('"schemaVersion": 1', '"schemaVersion": 0'));
  assert.throws(() => run(dir), /gemini-38-flash-low-attempt-9\/contract-results\.json: .*schemaVersion must be 1/);
});

test("an attempt scored under another rubric id is skipped with a warning", () => {
  const dir = resultsDirWith("gemini-38-flash-low-attempt-9", CONTRACT_CSV, undefined, contractResultsFixture("gemini-38-flash-low-attempt-9", undefined, "maintenance-console@0000000000bb"));
  const { results, warnings } = run(dir);
  assert.equal(results.totalAttempts, 0);
  assert.ok(
    warnings.some((message) => message.includes("gemini-38-flash-low-attempt-9 — scored under rubric maintenance-console@0000000000bb")),
    warnings.join("\n"),
  );
});

test("a contract-results.json whose rubric is not a rubric id stops the run, naming the file", () => {
  const dir = resultsDirWith("gemini-38-flash-low-attempt-9", CONTRACT_CSV);
  const path = join(dir, "gemini-38-flash-low-attempt-9", CONTRACT_RESULTS_FILE);
  const valid = readFileSync(path, "utf8");
  const invalid = valid.replace(`"rubric": "${FIXTURE_RUBRIC}"`, '"rubric": "tbd"');
  assert.notEqual(invalid, valid);
  writeFileSync(path, invalid);
  assert.throws(() => run(dir), /gemini-38-flash-low-attempt-9\/contract-results\.json: .*rubric must match/);
});

test("another attempt's contract-results.json stops the run under another rubric id too, rather than being skipped", () => {
  const dir = resultsDirWith("gemini-38-flash-low-attempt-9", CONTRACT_CSV, undefined, contractResultsFixture("gemini-38-flash-low-attempt-8", undefined, "maintenance-console@0000000000bb"));
  assert.throws(() => run(dir), /records attempt "gemini-38-flash-low-attempt-8"/);
});

test("a configuration with an attempt from another rubric is withheld whole, its model failures included", () => {
  const dir = resultsDirWith("gemini-38-flash-low-attempt-1", CONTRACT_CSV, undefined, contractResultsFixture("gemini-38-flash-low-attempt-1", undefined, "maintenance-console@0000000000bb"));
  // The same configuration's model failure, which has no era of its own…
  const failure = join(dir, "gemini-38-flash-low-attempt-2");
  mkdirSync(failure);
  writeFileSync(join(failure, "eval-results.csv"), readFileSync(join(FIXTURES, "gemini-31-pro-high-attempt-1", "eval-results.csv"), "utf8"), "utf8");
  writeFileSync(join(failure, "run.json"), `${JSON.stringify(modelFailureRunJson("gemini-38-flash-low"), null, 2)}\n`, "utf8");
  // …and a configuration of model failures only, with nothing from another era.
  const alone = join(dir, "gemini-31-pro-high-attempt-1");
  mkdirSync(alone);
  for (const file of ["eval-results.csv", "run.json"]) copyFileSync(join(FIXTURES, "gemini-31-pro-high-attempt-1", file), join(alone, file));

  const { results, warnings } = run(dir);
  assert.deepEqual(results.results.map((result) => result.id), ["gemini-31-pro-high-attempt-1"]);
  assert.equal(results.totalAttempts, 1);
  assert.deepEqual(results.modelAverages.map((average) => average.modelBaseId), ["gemini-31-pro-high"]);
  assert.deepEqual(results.familyAverages.map((average) => average.modelBaseId), ["gemini-31-pro"]);
  assert.ok(
    warnings.some((message) => message.includes("gemini-38-flash-low-attempt-1 — scored under rubric maintenance-console@0000000000bb")),
    warnings.join("\n"),
  );
  assert.ok(
    warnings.some((message) =>
      message.includes(`gemini-38-flash-low: withheld, 1 attempt(s) scored under another rubric id; re-score them under ${FIXTURE_RUBRIC} to publish it`),
    ),
    warnings.join("\n"),
  );
});

test("a model failure needs no contract-results.json, but every scored row and Penalty must be 0", () => {
  const zeroCsv = readFileSync(join(FIXTURES, "gemini-31-pro-high-attempt-1", "eval-results.csv"), "utf8");
  const ok = resultsDirWith("gemini-38-flash-low-attempt-9", zeroCsv, modelFailureRunJson("gemini-38-flash-low"), null);
  assert.equal(attempt(run(ok).results, "gemini-38-flash-low-attempt-9").totalScore, 0);

  const scored = resultsDirWith("gemini-38-flash-low-attempt-9", CONTRACT_CSV, modelFailureRunJson("gemini-38-flash-low"), null);
  assert.throws(() => run(scored), /records a model failure, so every scored row and Penalty must be 0: "Local build" is 1/);

  // criteria.md's stop table zeroes every row, Penalty included. Checking only
  // the four hidden rows let an all-zero CSV with three of the other scored
  // rows flipped to 1 publish as a 21.4% data point.
  for (const [name, score, line] of [
    ["API contract", 2, 'API contract,2,2,"24/24 passed"'],
    ["Local build", 1, 'Local build,1,1,"Build successful"'],
    ["Code structure", 0.5, 'Code structure,0.5,1,"Partly tidy"'],
    ["Manual testing", 1, 'Manual testing,1,1,"Worked"'],
    ["Penalty", 1, 'Penalty,1,N/A,"A remote shell script"'],
  ] as const) {
    const dir = resultsDirWith(
      "gemini-38-flash-low-attempt-9",
      rowReplaced(zeroCsv, name, line),
      modelFailureRunJson("gemini-38-flash-low"),
      null,
    );
    assert.throws(
      () => run(dir),
      new RegExp(`records a model failure, so every scored row and Penalty must be 0: "${name}" is ${score}`),
      name,
    );
  }
});

const ROOT_SKIP = process.getuid?.() === 0 ? "running as root; file permissions are not enforced" : false;

test("a CSV that exists but cannot be read is a warning, not a crash", { skip: ROOT_SKIP }, () => {
  const dir = resultsDirWith("gemini-31-pro-high-attempt-9", CONTRACT_CSV);
  const csvPath = join(dir, "gemini-31-pro-high-attempt-9", "eval-results.csv");
  chmodSync(csvPath, 0o000);
  try {
    const { results, warnings } = run(dir);
    assert.equal(results.totalAttempts, 0);
    assert.ok(
      warnings.some((message) => /cannot read .*eval-results\.csv .*skipping gemini-31-pro-high-attempt-9/.test(message)),
      warnings.join("\n"),
    );
  } finally {
    chmodSync(csvPath, 0o644);
  }
});

test("a results directory that cannot be listed is a warning, not a crash", { skip: ROOT_SKIP }, () => {
  const dir = resultsDirWith("gemini-31-pro-low-attempt-9", CONTRACT_CSV);
  chmodSync(dir, 0o000);
  try {
    const { results, warnings } = run(dir);
    assert.equal(results.totalAttempts, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /cannot list .*; writing empty results/);
  } finally {
    chmodSync(dir, 0o755);
  }
});

test("a directory name with underscores is ignored with a warning", () => {
  const { results, warnings } = run();
  assert.equal(
    results.results.some((result) => result.id.includes("_")),
    false,
  );
  assert.ok(
    warnings.some((message) => /gemini_31_pro_low-attempt-3 — not an attempt directory name/.test(message)),
    warnings.join("\n"),
  );
});

// --- aggregation ------------------------------------------------------------

test("effort levels aggregate into one family and stay separate per config", () => {
  const { results } = run();

  const family = results.familyAverages.find((average) => average.modelBaseId === "gemini-38-flash");
  assert.ok(family !== undefined, results.familyAverages.map((a) => a.modelBaseId).join(", "));
  assert.equal(family.modelName, "Gemini 3.8 Flash");
  assert.equal(family.attemptCount, 2);
  assert.equal(family.averagePercentage, ((11 / 14) * 100 + 100) / 2);
  assert.equal(family.averageScore, 12.5);
  assert.equal(family.averageMaxScore, 14);
  // High and Low in one family have no single environment.
  assert.equal(family.agentEnvironment, "Antigravity CLI");

  const high = results.modelAverages.find((average) => average.modelBaseId === "gemini-38-flash-high");
  const low = results.modelAverages.find((average) => average.modelBaseId === "gemini-38-flash-low");
  assert.equal(high?.averagePercentage, (11 / 14) * 100);
  assert.equal(high?.attemptCount, 1);
  assert.equal(high?.agentEnvironment, "Antigravity CLI (High Effort)");
  assert.equal(low?.averagePercentage, 100);
  assert.equal(low?.agentEnvironment, "Antigravity CLI (Low Effort)");
});

test("aggregation keys on the id, and averages the cost of the attempts that have one", () => {
  const { results } = run();
  const opus = results.modelAverages.find((average) => average.modelBaseId === "claude-opus-46-high")!;
  assert.equal(opus.modelName, "Claude Opus 4.6 (Thinking)");
  assert.deepEqual(opus.pricing, { input: 5, output: 25, cacheRead: 0.5 });
  assert.equal(opus.averageCost, 1.5);
  assert.equal(opus.totalCost, 1.5);

  const flash = results.modelAverages.find((average) => average.modelBaseId === "gemini-38-flash-high")!;
  assert.equal(flash.pricing, undefined);
  assert.equal(flash.averageCost, null);
  assert.equal(flash.totalCost, null);
});

test("results are sorted by percentage and the leaderboard mirrors the model averages", () => {
  const { results, leaderboard } = run();
  const percentages = results.results.map((result) => result.percentage);
  assert.deepEqual(percentages, [...percentages].sort((a, b) => b - a));

  assert.equal(leaderboard.schemaVersion, 1);
  assert.equal(leaderboard.totalAttempts, results.totalAttempts);
  assert.equal(leaderboard.totalModels, results.modelAverages.length);
  assert.deepEqual(leaderboard.leaderboard, results.modelAverages.slice(0, 10));
});

// --- outputs ----------------------------------------------------------------

test("both documents are written and match what was returned", () => {
  const outcome = run();
  assert.deepEqual(JSON.parse(readFileSync(outcome.resultsJsonPath, "utf8")), outcome.results);
  assert.deepEqual(JSON.parse(readFileSync(outcome.leaderboardJsonPath, "utf8")), outcome.leaderboard);
});

test("an empty results directory produces valid empty documents", () => {
  const outcome = run(tempDir("agrav-empty-results-"));
  assert.deepEqual(outcome.results.results, []);
  assert.deepEqual(outcome.results.modelAverages, []);
  assert.deepEqual(outcome.results.familyAverages, []);
  assert.deepEqual(outcome.results.supersededModels, {});
  assert.equal(outcome.results.totalAttempts, 0);
  assert.deepEqual(outcome.leaderboard, {
    schemaVersion: 1,
    generatedAt: outcome.results.generatedAt,
    totalAttempts: 0,
    totalModels: 0,
    leaderboard: [],
  });
  assert.equal(outcome.warnings.length, 0);
  assert.ok(existsSync(outcome.resultsJsonPath));
  assert.ok(existsSync(outcome.leaderboardJsonPath));
});

test("a results directory that does not exist yet is a warning, not a crash", () => {
  const outcome = run(join(tempDir("agrav-absent-"), "eval-results"));
  assert.equal(outcome.results.totalAttempts, 0);
  assert.equal(outcome.warnings.length, 1);
  assert.match(outcome.warnings[0], /does not exist; writing empty results/);
});

test("the output is stable across runs apart from generatedAt", () => {
  const first = run();
  const second = run();
  assert.deepEqual({ ...first.results, generatedAt: "" }, { ...second.results, generatedAt: "" });
});

// --- the CLI ----------------------------------------------------------------

function processResultsCli(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("--help prints the usage and exits 0", () => {
  const result = processResultsCli("--help");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--results-dir <path>/);
  assert.equal(result.stderr, "");
});

test("an unknown flag is refused", () => {
  const result = processResultsCli("--top-n", "5");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown argument "--top-n"/);
});

test("--rubric refuses a value that is not a rubric id", () => {
  for (const bad of ["maintenance-console@0000000000a", ""]) {
    // A temporary root, so a flag that is not refused still writes nothing into the checkout.
    const result = processResultsCli("--root", tempDir("agrav-bad-rubric-root-"), "--results-dir", tempDir("agrav-bad-rubric-results-"), "--rubric", bad);
    assert.equal(result.status, 1, `${JSON.stringify(bad)}: ${result.stdout}`);
    assert.match(result.stderr, /--rubric needs a rubric id/);
    assert.ok(result.stderr.includes(JSON.stringify(bad)), result.stderr);
  }
});

test("--root and --results-dir write both documents outside the checkout", () => {
  const root = tempDir("agrav-cli-root-");
  const result = processResultsCli("--root", root, "--results-dir", FIXTURES, "--rubric", FIXTURE_RUBRIC);

  assert.equal(result.status, 0, result.stderr);
  const resultsJson = join(root, "website", "src", "data", "results.json");
  const leaderboardJson = join(root, "website", "public", "api", "leaderboard.json");
  assert.ok(result.stdout.includes(`✓ Generated ${resultsJson}`), result.stdout);
  assert.ok(result.stdout.includes(`✓ Generated ${leaderboardJson}`), result.stdout);
  assert.match(result.stdout, /Per-config averages \(5\):/);
  assert.match(result.stdout, /Model family averages \(3\):/);
  assert.match(result.stdout, /Gemini 3\.8 Flash: 12\.5\/14\.0 \(89\.3%\) \[2 attempt\(s\)\]/);
  assert.match(result.stderr, /records an infrastructure failure/);

  const written = JSON.parse(readFileSync(resultsJson, "utf8")) as ProcessedResults;
  assert.equal(written.totalAttempts, 5);
  assert.equal(written.familyAverages.length, 3);
  assert.equal((JSON.parse(readFileSync(leaderboardJson, "utf8")) as LeaderboardPayload).totalModels, 5);
});

test("--root without --rubric hashes this repository's rubric files, not the root's", () => {
  // The root is where the two documents are written; the rubric id and the
  // manifest the hidden rows are checked against both come from the script's
  // own repository. Taking the id from `--root` died on `fingerprint input
  // missing: prompt.md` before an empty results directory could even be read.
  const root = tempDir("agrav-default-rubric-root-");
  const result = processResultsCli("--root", root, "--results-dir", tempDir("agrav-default-rubric-results-"));

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\nRubric: maintenance-console@[0-9a-f]{12}\n/);
  assert.equal(result.stdout.includes("fingerprint input missing"), false, result.stdout);
  assert.ok(existsSync(join(root, "website", "src", "data", "results.json")), result.stdout);
});

test("a malformed CSV stops the whole run rather than scoring it as a zero", () => {
  const dir = tempDir("agrav-bad-csv-");
  const attemptDir = join(dir, "gemini-31-pro-high-attempt-9");
  mkdirSync(attemptDir, { recursive: true });
  // A stray file next to the attempt directories must be ignored silently.
  writeFileSync(join(dir, "README.txt"), "not an attempt\n", "utf8");
  writeFileSync(join(attemptDir, "eval-results.csv"), withRow("Local build", 'Local build,1/1,1,"Build successful"'), "utf8");

  const result = processResultsCli("--root", tempDir("agrav-bad-csv-root-"), "--results-dir", dir, "--rubric", FIXTURE_RUBRIC);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /has a non-numeric Score "1\/1"/);
  assert.equal(result.stderr.includes("README.txt"), false, result.stderr);
});
