import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { parse as parseCsv } from "csv-parse/sync";

import { main } from "../scripts/contract-results";
import type { ContractFileResult, FailedTest } from "../scripts/lib/contract-suite";
import {
  CONTRACT_RESULTS_FILE,
  EMPTY_STOP_DETAIL,
  diagnose,
  groupFromFileResult,
  hiddenRowLines,
  loadManifest,
  notesFor,
  parseContractResults,
  readContractResults,
  restartFailedGroup,
  stoppedBoot,
  stoppedGroups,
  writeContractResults,
  type ContractResults,
  type GroupResult,
  type ManifestEntry,
} from "../scripts/lib/contract-results";
import { HIDDEN_ROWS } from "../scripts/lib/rubric";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "scripts", "contract-results.ts");
const MANIFEST = loadManifest(ROOT);
const [API, ASSIGNMENT, ORDERING, PARTS] = MANIFEST;
const ATTEMPT = "gemini-38-flash-high-attempt-1";
const scratch: string[] = [];

after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agrav-contract-results-test-"));
  scratch.push(dir);
  return dir;
}

function failure(name: string, message = `${name} broke`, failureType = "testCodeFailure"): FailedTest {
  return { name, failureType, message };
}

function fileResult(entry: ManifestEntry, passed: number, failed: FailedTest[], extra: Partial<ContractFileResult> = {}): ContractFileResult {
  const notRun = extra.notRun ?? entry.tests - passed - failed.length;
  return {
    file: `/repo/benchmark/contract-tests/${entry.file}`,
    total: entry.tests,
    passed,
    failed,
    notRun,
    hookFailed: failed.filter((f) => f.failureType === "hookFailed").length,
    timedOut: false,
    ...extra,
  };
}

function allPassed(entry: ManifestEntry): GroupResult {
  return groupFromFileResult(entry, fileResult(entry, entry.tests, []));
}

function results(groups: GroupResult[], overrides: Partial<ContractResults> = {}): ContractResults {
  return {
    schemaVersion: 1,
    attempt: ATTEMPT,
    image: "agrav-bench/harness:2026-09-18@sha256:" + "a".repeat(64),
    runImage: null,
    rubric: "maintenance-console@0123456789ab",
    testsCommit: "b".repeat(40),
    testsDirty: false,
    ungated: false,
    startedAt: "2026-09-18T10:00:00.000Z",
    durationMs: 61_234,
    pipFreeze: ["fastapi==0.115.14", "uvicorn==0.34.0"],
    warnings: [],
    boot: { ok: true, stage: null, detail: null },
    diagnosis: diagnose(groups),
    groups,
    ...overrides,
  };
}

/** 20 of 24 on API contract, the rest clean: the spec's example. */
function typical(): ContractResults {
  const api = groupFromFileResult(API, fileResult(API, 20, [
    failure("GET /parts adds available and a strict low_stock flag", "GET /parts answered 200: [] \n\n1 !== 2"),
    failure("PATCH /work-orders/{id}: cancelled and completed are terminal", "PATCH /work-orders/61 answered 200: {}"),
    failure("POST /reset restores the seed exactly after writes, planning and transitions", "seed differs"),
    failure("GET /work-orders filters by status, priority and the asset's site, combinably", "GET /work-orders?status=open answered 500: \"boom\""),
  ]));
  return results([api, allPassed(ASSIGNMENT), allPassed(ORDERING), allPassed(PARTS)]);
}

function hookFailures(entry: ManifestEntry, n: number, message = "POST /reset must answer 200\n\n500 !== 200"): FailedTest[] {
  return Array.from({ length: n }, (_, i) => failure(`${entry.file} test ${i}`, message, "hookFailed"));
}

function resetBroken(): ContractResults {
  const groups = MANIFEST.map((entry) => groupFromFileResult(entry, fileResult(entry, 0, hookFailures(entry, entry.tests))));
  return results(groups);
}

function stopped(stage: "layout" | "install" | "boot" | "health", detail: string): ContractResults {
  return results(stoppedGroups(MANIFEST), { boot: { ok: false, stage, detail }, pipFreeze: [] });
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** A deep copy of `typical()` as plain JSON, edited by `edit`. */
function mutated(edit: (doc: any) => void, base: ContractResults = typical()): string {
  const doc = JSON.parse(json(base));
  edit(doc);
  return json(doc);
}

// --- manifest and group building ------------------------------------------------

test("loadManifest reads the four files in rubric order", () => {
  assert.deepEqual(
    MANIFEST.map((e) => [e.row, e.max, e.file, e.tests]),
    [
      ["API contract", 2, "api-contract.test.ts", 24],
      ["Planner: assignment rules", 2, "planner-assignment.test.ts", 12],
      ["Planner: ordering & determinism", 1, "planner-ordering.test.ts", 11],
      ["Planner: parts & blocking", 2, "planner-parts.test.ts", 11],
    ],
  );
  assert.deepEqual(MANIFEST.map((e) => [e.row, e.max]), HIDDEN_ROWS.map((r) => [r.name, r.max]));
});

test("loadManifest refuses a manifest that disagrees with rubric.ts", () => {
  const root = tempDir();
  const dir = join(root, "benchmark", "contract-tests");
  mkdirSync(dir, { recursive: true });
  const files = JSON.parse(readFileSync(join(ROOT, "benchmark", "contract-tests", "manifest.json"), "utf8")).files;
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ files: [files[1], files[0], files[2], files[3]] }));
  assert.throws(() => loadManifest(root), /does not match rubric\.ts's hidden-test rows/);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ files: files.map((f: ManifestEntry, i: number) => (i === 2 ? { ...f, max: 2 } : f)) }));
  assert.throws(() => loadManifest(root), /does not match/);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ files: files.map((f: ManifestEntry, i: number) => (i === 0 ? { ...f, file: "../x.test.ts" } : f)) }));
  assert.throws(() => loadManifest(root), /base name/);
  // The rows and maxima all match rubric.ts; only the file is repeated.
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ files: files.map((f: ManifestEntry, i: number) => (i === 1 ? { ...f, file: files[0].file } : f)) }));
  assert.throws(() => loadManifest(root), /a file is listed twice/);
});

test("groupFromFileResult scores with roundScore and takes row, file and max from the manifest", () => {
  const group = groupFromFileResult(API, fileResult(API, 20, [failure("a"), failure("b"), failure("c"), failure("d")]));
  assert.equal(group.row, "API contract");
  assert.equal(group.file, "api-contract.test.ts", "the manifest's name, not the path the run used");
  assert.equal(group.max, 2);
  assert.equal(group.total, 24);
  assert.equal(group.score, 1.67);
  assert.equal(group.detail, null);
  assert.equal(group.failed.length, 4);
});

test("groupFromFileResult refuses a result that does not add up or disagrees with the manifest", () => {
  assert.throws(() => groupFromFileResult(API, { ...fileResult(API, 24, []), total: 25 }), /manifest says 24/);
  assert.throws(() => groupFromFileResult(API, { ...fileResult(API, 20, []), notRun: 0 }), /is not 24/);
});

test("stoppedGroups: all four present, nothing run, every score 0 out of the manifest's count", () => {
  const groups = stoppedGroups(MANIFEST);
  assert.deepEqual(groups.map((g) => [g.row, g.total, g.passed, g.score, g.notRun, g.failed.length, g.detail]), [
    ["API contract", 24, 0, 0, 24, 0, null],
    ["Planner: assignment rules", 12, 0, 0, 12, 0, null],
    ["Planner: ordering & determinism", 11, 0, 0, 11, 0, null],
    ["Planner: parts & blocking", 11, 0, 0, 11, 0, null],
  ]);
});

test("stoppedBoot keeps a detail, and turns an empty or whitespace-only one into the placeholder", () => {
  assert.deepEqual(stoppedBoot("boot", "Traceback\n(the container exited with code 1)"), { ok: false, stage: "boot", detail: "Traceback\n(the container exited with code 1)" });
  assert.deepEqual(stoppedBoot("boot", ""), { ok: false, stage: "boot", detail: EMPTY_STOP_DETAIL });
  assert.deepEqual(stoppedBoot("health", " \n\t"), { ok: false, stage: "health", detail: EMPTY_STOP_DETAIL });
  assert.notEqual(EMPTY_STOP_DETAIL.trim(), "");
  // What it builds validates, and is what Notes quote.
  const value = results(stoppedGroups(MANIFEST), { boot: stoppedBoot("boot", ""), pipFreeze: [] });
  assert.deepEqual(parseContractResults(json(value)), value);
  assert.equal(notesFor(value.groups[0], value), `0/24 passed; backend stop (boot): ${EMPTY_STOP_DETAIL}`);
  // Without the builder, the same stop is rejected.
  assert.throws(() => parseContractResults(json({ ...value, boot: { ok: false, stage: "boot", detail: " " } })), /boot\.detail must not be empty/);
});

test("restartFailedGroup scores 0 with the reason, never an empty one", () => {
  const group = restartFailedGroup(ORDERING, "the container exited before /health answered");
  assert.equal(group.score, 0);
  assert.equal(group.notRun, 11);
  assert.equal(group.detail, "the container exited before /health answered");
  assert.equal(restartFailedGroup(ORDERING, "  ").detail, "(no detail)");
});

// --- diagnose -------------------------------------------------------------------

test("diagnose: every test that ran failed in beforeEach, in every file → reset-broken", () => {
  assert.equal(diagnose(resetBroken().groups), "reset-broken");
});

test("diagnose ignores tests a timeout cut short: a hanging /reset still reads as reset-broken", () => {
  const groups = MANIFEST.map((entry) => {
    const ran = Math.min(entry.tests, 11);
    return groupFromFileResult(entry, fileResult(entry, 0, hookFailures(entry, ran, "POST /reset: TimeoutError The operation was aborted due to timeout"), {
      notRun: entry.tests - ran,
      timedOut: ran < entry.tests,
    }));
  });
  assert.equal(diagnose(groups), "reset-broken");
});

test("diagnose: one passing test anywhere → null", () => {
  const groups = resetBroken().groups;
  groups[3] = groupFromFileResult(PARTS, fileResult(PARTS, 1, hookFailures(PARTS, 10)));
  assert.equal(diagnose(groups), null);
});

test("diagnose: a file with zero reported tests → null", () => {
  const groups = resetBroken().groups;
  groups[1] = groupFromFileResult(ASSIGNMENT, fileResult(ASSIGNMENT, 0, [], { notRun: 12, timedOut: true }));
  assert.equal(diagnose(groups), null);
  const restarted = resetBroken().groups;
  restarted[2] = restartFailedGroup(ORDERING, "exited");
  assert.equal(diagnose(restarted), null);
  assert.equal(diagnose(stoppedGroups(MANIFEST)), null, "a backend stop is not reset-broken");
});

test("diagnose: one failure in a test body among hook failures → null", () => {
  const groups = resetBroken().groups;
  const failed = hookFailures(API, 24);
  failed[5] = failure("body", "GET /sites answered 500: {}");
  groups[0] = groupFromFileResult(API, fileResult(API, 0, failed));
  assert.equal(diagnose(groups), null);
});

// --- Notes ----------------------------------------------------------------------

test("Notes: the passed count and the failed names", () => {
  const value = typical();
  assert.equal(
    notesFor(value.groups[0], value),
    "20/24 passed; failed: GET /parts adds available and a strict low_stock flag | " +
      "PATCH /work-orders/{id}: cancelled and completed are terminal | " +
      "POST /reset restores the seed exactly after writes, planning and transitions | " +
      "GET /work-orders filters by status, priority and the asset's site, combinably",
  );
  assert.equal(notesFor(value.groups[1], value), "12/12 passed", "nothing failed, nothing listed");
});

test("Notes: a backend stop names its stage and detail, on one line, the tail of a long detail only", () => {
  const value = stopped("boot", "Traceback (most recent call last):\n  File \"app/main.py\", line 3\n\nModuleNotFoundError: No module named 'sqlmodel'\n");
  assert.equal(
    notesFor(value.groups[0], value),
    "0/24 passed; backend stop (boot): Traceback (most recent call last): / File \"app/main.py\", line 3 / ModuleNotFoundError: No module named 'sqlmodel'",
  );
  assert.equal(notesFor(value.groups[3], value), "0/11 passed; backend stop (boot): Traceback (most recent call last): / File \"app/main.py\", line 3 / ModuleNotFoundError: No module named 'sqlmodel'");
  const long = stopped("install", `${"x".repeat(1_000)}\nERROR: No matching distribution found for nosuchpkg==9.9`);
  const notes = notesFor(long.groups[0], long);
  assert.ok(notes.startsWith("0/24 passed; backend stop (install): …"));
  assert.ok(notes.endsWith("ERROR: No matching distribution found for nosuchpkg==9.9"));
  assert.ok(notes.length < 500);
  assert.equal(notesFor(stopped("layout", "backend/app/main.py is missing").groups[1], stopped("layout", "backend/app/main.py is missing")),
    "0/12 passed; backend stop (layout): backend/app/main.py is missing");
});

test("Notes: reset-broken takes precedence over the failed names", () => {
  const value = resetBroken();
  assert.equal(notesFor(value.groups[0], value), "0/24 passed; POST /reset does not answer 200");
  assert.equal(notesFor(value.groups[2], value), "0/11 passed; POST /reset does not answer 200");
});

test("Notes: a restart that failed twice", () => {
  const value = results([allPassed(API), allPassed(ASSIGNMENT), restartFailedGroup(ORDERING, "the container exited\nbefore /health answered"), allPassed(PARTS)]);
  assert.equal(notesFor(value.groups[2], value), "0/11 passed; restart failed: the container exited / before /health answered");
});

test("Notes: a file cut short by its timer says after how many tests", () => {
  const cut = groupFromFileResult(API, fileResult(API, 10, [failure("slow one", "GET /schedule: TimeoutError The operation was aborted due to timeout")], { notRun: 13, timedOut: true }));
  const value = results([cut, allPassed(ASSIGNMENT), allPassed(ORDERING), allPassed(PARTS)]);
  assert.equal(cut.score, 0.83);
  assert.equal(notesFor(cut, value), "10/24 passed; failed: slow one; timed out after 11 tests; most failures at GET /schedule");
  const one = groupFromFileResult(ORDERING, fileResult(ORDERING, 1, [], { notRun: 10, timedOut: true }));
  assert.equal(notesFor(one, results([allPassed(API), allPassed(ASSIGNMENT), one, allPassed(PARTS)])), "1/11 passed; timed out after 1 test");
});

test("Notes: a timer that fired after every test had reported adds no 'timed out' clause", () => {
  // `timedOut` is set when the per-file timer fires, which can be after the
  // last test reported but before the stream ended: nothing was cut short.
  const finished = groupFromFileResult(ORDERING, fileResult(ORDERING, 11, [], { notRun: 0, timedOut: true }));
  const withFailure = groupFromFileResult(PARTS, fileResult(PARTS, 10, [failure("one")], { notRun: 0, timedOut: true }));
  const value = results([allPassed(API), allPassed(ASSIGNMENT), finished, withFailure]);
  assert.deepEqual(parseContractResults(json(value)), value);
  assert.equal(notesFor(finished, value), "11/11 passed");
  assert.equal(notesFor(withFailure, value), "10/11 passed; failed: one");
  assert.doesNotMatch(hiddenRowLines(value).join("\n"), /timed out/);
});

test("Notes: most failures at <METHOD> <path>, for the ' answered' form", () => {
  const failed = [
    failure("a", "POST /work-orders answered 500: {\"detail\":\"x\"}"),
    failure("b", "POST /work-orders answered 422: {}"),
    failure("c", "GET /schedule?week_start=2026-10-12 answered 404: {}"),
  ];
  const group = groupFromFileResult(ASSIGNMENT, fileResult(ASSIGNMENT, 9, failed));
  const value = results([allPassed(API), group, allPassed(ORDERING), allPassed(PARTS)]);
  assert.equal(notesFor(group, value), "9/12 passed; failed: a | b | c; most failures at POST /work-orders");
});

test("Notes: most failures at <METHOD> <path>, for the ':' form, with a query string", () => {
  const failed = [
    failure("a", "POST /plan?week_start=2026-10-12: TimeoutError The operation was aborted due to timeout"),
    failure("b", "POST /plan?week_start=2026-10-12: TypeError fetch failed"),
    failure("c", "POST /plan?week_start=2026-10-19 answered 500: {}"),
  ];
  const group = groupFromFileResult(PARTS, fileResult(PARTS, 8, failed));
  const value = results([allPassed(API), allPassed(ASSIGNMENT), allPassed(ORDERING), group]);
  assert.equal(notesFor(group, value), "8/11 passed; failed: a | b | c; most failures at POST /plan?week_start=2026-10-12");
});

test("Notes: exactly half sharing an endpoint is not most, and assertion text is not an endpoint", () => {
  const failed = [
    failure("a", "POST /work-orders answered 500: {}"),
    failure("b", "POST /work-orders answered 500: {}"),
    failure("c", "GET /parts answered 500: {}"),
    failure("d", "expected 3 blocked orders"),
  ];
  const group = groupFromFileResult(PARTS, fileResult(PARTS, 7, failed));
  const value = results([allPassed(API), allPassed(ASSIGNMENT), allPassed(ORDERING), group]);
  assert.equal(notesFor(group, value), "7/11 passed; failed: a | b | c | d");
  const reset = resetBroken();
  assert.equal(notesFor(reset.groups[0], reset), "0/24 passed; POST /reset does not answer 200", "'POST /reset must answer 200' names no endpoint");
});

test("Notes: the suffix applies to reset-broken too, when a hanging /reset is what failed", () => {
  const groups = MANIFEST.map((entry) => groupFromFileResult(entry, fileResult(entry, 0, hookFailures(entry, entry.tests, "POST /reset: TimeoutError The operation was aborted due to timeout"))));
  const value = results(groups);
  assert.equal(notesFor(value.groups[1], value), "0/12 passed; POST /reset does not answer 200; most failures at POST /reset");
});

// --- CSV lines ------------------------------------------------------------------

test("hiddenRowLines: four quoted lines that csv-parse reads back exactly, commas and quotes included", () => {
  const tricky = 'rejects "urgent", a priority it does not know';
  const api = groupFromFileResult(API, fileResult(API, 23, [failure(tricky, 'POST /work-orders answered 201: {"priority":"urgent"}')]));
  const value = results([api, allPassed(ASSIGNMENT), groupFromFileResult(ORDERING, fileResult(ORDERING, 10, [failure("x")])), allPassed(PARTS)]);
  const lines = hiddenRowLines(value);
  assert.equal(lines.length, 4);
  assert.equal(lines[0], `API contract,1.92,2,"23/24 passed; failed: rejects ""urgent"", a priority it does not know; most failures at POST /work-orders"`);
  const rows: string[][] = parseCsv(`Criterion,Score,Max,Notes\n${lines.join("\n")}\n`, { from_line: 2 });
  assert.deepEqual(rows.map((r) => r.slice(0, 3)), [
    ["API contract", "1.92", "2"],
    ["Planner: assignment rules", "2", "2"],
    ["Planner: ordering & determinism", "0.91", "1"],
    ["Planner: parts & blocking", "2", "2"],
  ]);
  assert.deepEqual(rows.map((r) => r[3]), value.groups.map((g) => notesFor(g, value)));
  assert.equal(rows[0][3], `23/24 passed; failed: ${tricky}; most failures at POST /work-orders`);
  assert.ok(lines.every((line) => !line.includes("\n")), "one line each");
});

test("hiddenRowLines on a backend stop: four zero rows", () => {
  const value = stopped("health", "no 2xx from /api/v1/health within 60 s");
  assert.deepEqual(hiddenRowLines(value), [
    `API contract,0,2,"0/24 passed; backend stop (health): no 2xx from /api/v1/health within 60 s"`,
    `Planner: assignment rules,0,2,"0/12 passed; backend stop (health): no 2xx from /api/v1/health within 60 s"`,
    `Planner: ordering & determinism,0,1,"0/11 passed; backend stop (health): no 2xx from /api/v1/health within 60 s"`,
    `Planner: parts & blocking,0,2,"0/11 passed; backend stop (health): no 2xx from /api/v1/health within 60 s"`,
  ]);
});

// --- parse, read, write ---------------------------------------------------------

test("parseContractResults accepts what the builders produce, and returns it unchanged", () => {
  for (const value of [typical(), resetBroken(), stopped("install", "pip failed"), results(MANIFEST.map(allPassed), { ungated: true, testsDirty: true, runImage: `agrav-bench/harness:2026-09-18@sha256:${"b".repeat(64)}`, warnings: ["image differs"] })]) {
    assert.deepEqual(parseContractResults(json(value)), value);
  }
});

const INVALID: [string, (doc: any) => void, RegExp][] = [
  ["a wrong schemaVersion", (d) => { d.schemaVersion = 2; }, /schemaVersion must be 1/],
  ["a missing field", (d) => { delete d.testsCommit; }, /is missing "testsCommit"/],
  ["an extra field", (d) => { d.verdict = "pass"; }, /unexpected field "verdict"/],
  ["a mistyped boolean", (d) => { d.testsDirty = "no"; }, /testsDirty must be true or false/],
  ["a mistyped number", (d) => { d.durationMs = "61234"; }, /durationMs must be a non-negative integer/],
  ["a mistyped list", (d) => { d.pipFreeze = "fastapi==0.115.14"; }, /pipFreeze must be an array/],
  ["a missing group field", (d) => { delete d.groups[1].hookFailed; }, /groups\[1\] is missing "hookFailed"/],
  ["an extra group field", (d) => { d.groups[1].points = 2; }, /groups\[1\] has an unexpected field "points"/],
  ["a failed test without a message", (d) => { delete d.groups[0].failed[0].message; }, /groups\[0\]\.failed\[0\] is missing "message"/],
  ["a bad attempt name", (d) => { d.attempt = "gemini_38_flash-attempt-1"; }, /attempt must match/],
  ["an image without its Id", (d) => { d.image = "agrav-bench/harness:2026-09-18"; }, /image must match/],
  ["a bad rubric id", (d) => { d.rubric = "maintenance-console@XYZ"; }, /rubric must match/],
  ["a bad startedAt", (d) => { d.startedAt = "yesterday"; }, /startedAt must be an ISO timestamp/],
  ["three groups", (d) => { d.groups.pop(); }, /groups has 3 entries; the manifest has 4/],
  ["five groups", (d) => { d.groups.push(d.groups[3]); }, /groups has 5 entries/],
  ["groups out of order", (d) => { [d.groups[1], d.groups[2]] = [d.groups[2], d.groups[1]]; }, /groups\[1\] is "Planner: ordering & determinism"/],
  ["a group with another file", (d) => { d.groups[0].file = "planner-parts.test.ts"; }, /groups\[0\] is .* belongs here/],
  ["a group with another max", (d) => { d.groups[2].max = 2; }, /groups\[2\]\.max must be the manifest's 1/],
  ["a group with another total", (d) => { d.groups[2].total = 12; }, /groups\[2\]\.total must be the manifest's 11/],
  ["a score roundScore would not give", (d) => { d.groups[0].score = 1.66; }, /groups\[0\]\.score is 1\.66 but roundScore\(20, 24, 2\) is 1\.67/],
  ["an unrounded score", (d) => { d.groups[0].score = 20 / 24 * 2; }, /groups\[0\]\.score is 1\.666/],
  ["counts that do not add up", (d) => { d.groups[0].notRun = 1; }, /does not add up: passed 20 \+ failed 4 \+ notRun 1 is not total 24/],
  ["passed above total", (d) => { d.groups[3].passed = 12; }, /groups\[3\]\.passed is 12, more than total 11/],
  ["a hookFailed count that disagrees with failed[]", (d) => { d.groups[0].hookFailed = 1; }, /hookFailed is 1 but 0 of failed\[\]/],
  ["a boot stage while ok", (d) => { d.boot.stage = "boot"; }, /boot is ok, so its stage and detail must be null/],
  ["an unknown boot stage", (d) => { d.boot = { ok: false, stage: "venv", detail: "x" }; }, /boot\.stage must be one of layout, install, boot, health/],
  ["a diagnosis the groups do not support", (d) => { d.diagnosis = "reset-broken"; }, /diagnosis is "reset-broken" but the groups say null/],
  ["an unknown diagnosis", (d) => { d.diagnosis = "planner-broken"; }, /diagnosis must be "reset-broken" or null/],
  ["not-run tests with no reason", (d) => { d.groups[1].passed = 11; d.groups[1].notRun = 1; d.groups[1].score = 1.83; }, /notRun is 1, but the file neither timed out/],
  ["an empty restart detail", (d) => { d.groups[1].detail = ""; }, /groups\[1\]\.detail must not be empty/],
];

for (const [what, edit, reason] of INVALID) {
  test(`parseContractResults rejects ${what}`, () => {
    assert.throws(() => parseContractResults(mutated(edit)), (error: Error) => {
      assert.match(error.message, /^contract-results\.json is invalid: /);
      assert.match(error.message, reason);
      return true;
    });
  });
}

test("parseContractResults rejects a boot that is stopped without a stage, and an ok boot with a stage", () => {
  const stop = stopped("boot", "exited");
  assert.throws(() => parseContractResults(mutated((d) => { d.boot.stage = null; }, stop)), /backend stop, so it needs a stage and a detail/);
  assert.throws(() => parseContractResults(mutated((d) => { d.boot.detail = null; }, stop)), /backend stop, so it needs a stage and a detail/);
  assert.throws(() => parseContractResults(mutated((d) => { d.boot.ok = true; }, stop)), /boot is ok, so its stage and detail must be null/);
});

test("parseContractResults rejects a backend stop whose groups report tests or a detail", () => {
  const stop = stopped("boot", "exited");
  assert.throws(() => parseContractResults(mutated((d) => { d.groups[0].passed = 24; d.groups[0].notRun = 0; d.groups[0].score = 2; }, stop)), /did not run \(a backend stop\)/);
  assert.throws(() => parseContractResults(mutated((d) => { d.groups[0].detail = "exited"; }, stop)), /must be null on a backend stop/);
});

test("parseContractResults rejects text that is not JSON, or not an object", () => {
  assert.throws(() => parseContractResults("{"), /^Error: contract-results\.json is not JSON/);
  assert.throws(() => parseContractResults("[]"), /contract-results\.json must be an object/);
});

test("runImage is null or a <tag>@<id> reference, as image is", () => {
  assert.equal(parseContractResults(mutated((d) => { d.runImage = "agrav-bench/harness:2026-09-19@sha256:" + "a".repeat(64); })).runImage?.startsWith("agrav-bench/"), true);
  assert.throws(() => parseContractResults(mutated((d) => { d.runImage = "agrav-bench/harness:2026-09-19"; })), /runImage must match/);
  assert.throws(() => parseContractResults(mutated((d) => { d.runImage = ""; })), /runImage must not be empty/);
});

test("writeContractResults writes atomically, in the documented key order, and leaves no temp file", () => {
  const dir = join(tempDir(), "eval-results", ATTEMPT);
  const path = join(dir, CONTRACT_RESULTS_FILE);
  writeContractResults(path, stopped("layout", "no backend/"));
  const value = typical();
  const shuffled = Object.fromEntries(Object.entries(value).reverse()) as unknown as ContractResults;
  writeContractResults(path, shuffled);
  assert.deepEqual(readdirSync(dir), [CONTRACT_RESULTS_FILE]);
  const text = readFileSync(path, "utf8");
  assert.equal(text, `${JSON.stringify(value, null, 2)}\n`);
  assert.deepEqual(readContractResults(path), value);
  assert.deepEqual(Object.keys(JSON.parse(text)), [
    "schemaVersion", "attempt", "image", "runImage", "rubric", "testsCommit", "testsDirty", "ungated",
    "startedAt", "durationMs", "pipFreeze", "warnings", "boot", "diagnosis", "groups",
  ]);
});

test("writeContractResults never writes an invalid result, nor replaces a valid one with it", () => {
  const dir = join(tempDir(), "eval-results", ATTEMPT);
  const path = join(dir, CONTRACT_RESULTS_FILE);
  writeContractResults(path, typical());
  const before = readFileSync(path, "utf8");
  const bad = typical();
  bad.groups[0].score = 2;
  assert.throws(() => writeContractResults(path, bad), /score is 2 but roundScore/);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.deepEqual(readdirSync(dir), [CONTRACT_RESULTS_FILE]);
});

test("readContractResults names the path when the file is missing or invalid", () => {
  const dir = tempDir();
  assert.throws(() => readContractResults(join(dir, CONTRACT_RESULTS_FILE)), new RegExp(`no contract-results\\.json at ${dir}`));
  writeFileSync(join(dir, CONTRACT_RESULTS_FILE), mutated((d) => { d.schemaVersion = 0; }));
  assert.throws(() => readContractResults(join(dir, CONTRACT_RESULTS_FILE)), new RegExp(`^Error: ${dir}.*schemaVersion must be 1`));
});

// --- the CLI ----------------------------------------------------------------------

function run(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI, ...args], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function rootWith(value: ContractResults | string, dir = ATTEMPT): string {
  const root = tempDir();
  const path = join(root, "eval-results", dir, CONTRACT_RESULTS_FILE);
  if (typeof value === "string") {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value);
  } else {
    writeContractResults(path, value);
  }
  return root;
}

test("CLI: --rows prints the four lines for a valid file under --root", async () => {
  const value = typical();
  const { status, stdout, stderr } = await run(["--rows", ATTEMPT, "--root", rootWith(value)]);
  assert.equal(stderr, "");
  assert.equal(status, 0);
  assert.equal(stdout, hiddenRowLines(value).map((line) => `${line}\n`).join(""));
  const rows: string[][] = parseCsv(stdout);
  assert.deepEqual(rows.map((r) => r[0]), HIDDEN_ROWS.map((r) => r.name));
});

test("CLI: a missing file exits 1 with a message and prints no rows", async () => {
  const root = tempDir();
  const { status, stdout, stderr } = await run(["--rows", ATTEMPT, "--root", root]);
  assert.equal(status, 1);
  assert.equal(stdout, "");
  assert.match(stderr, /no contract-results\.json at /);
});

test("CLI: an invalid file exits 1 with the reason", async () => {
  const { status, stdout, stderr } = await run(["--rows", ATTEMPT, "--root", rootWith(mutated((d) => { d.groups[0].score = 2; }))]);
  assert.equal(status, 1);
  assert.equal(stdout, "");
  assert.match(stderr, /score is 2 but roundScore\(20, 24, 2\) is 1\.67/);
});

function inProcess(argv: string[]): { status: number; out: string; err: string } {
  let out = "";
  let err = "";
  const status = main(argv, { out: (t) => (out += t), err: (t) => (err += t) });
  return { status, out, err };
}

test("CLI: a file written for another attempt exits 1", () => {
  const root = rootWith(results(MANIFEST.map(allPassed), { attempt: "claude-opus-46-high-attempt-2" }));
  const { status, out, err } = inProcess(["--rows", ATTEMPT, "--root", root]);
  assert.equal(status, 1);
  assert.equal(out, "");
  assert.match(err, /is for attempt "claude-opus-46-high-attempt-2", not "gemini-38-flash-high-attempt-1"/);
});

test("CLI: usage errors exit 2", () => {
  for (const argv of [
    [],
    ["--root", "/tmp"],
    ["--rows"],
    ["--rows", "--root", "/tmp"],
    ["--rows", "../../etc"],
    ["--rows", ATTEMPT, "--rows", ATTEMPT],
    ["--rows", ATTEMPT, "--root", "/a", "--root", "/b"],
    ["--rows", ATTEMPT, "--root=/a", "--root", "/a"],
    ["--rows", ATTEMPT, "--bogus"],
    ["--rows", ATTEMPT, "--root"],
  ]) {
    const { status, out, err } = inProcess(argv);
    assert.equal(status, 2, JSON.stringify(argv));
    assert.equal(out, "");
    assert.match(err, /Usage: /);
  }
});

test("CLI: --rows=<dir> and --root=<path> forms, and --help", () => {
  const value = typical();
  const ok = inProcess([`--rows=${ATTEMPT}`, `--root=${rootWith(value)}`]);
  assert.equal(ok.status, 0);
  assert.equal(ok.out.trimEnd().split("\n").length, 4);
  const help = inProcess(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.out, /--rows <dir>/);
});
