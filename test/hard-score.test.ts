import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  HarnessFault, csvNote, formatDuration, formatTestRun, loadManifest,
  parseNodeTap, parsePlaywrightJson, requireCompleted,
} from "../scripts/lib/hard-score";

const report = (stats: object) => JSON.stringify({ stats, suites: [] });

describe("parsePlaywrightJson", () => {
  it("counts expected + flaky as passed", () => {
    const r = parsePlaywrightJson(report({ expected: 5, unexpected: 3, flaky: 2, skipped: 0 }), 10);
    assert.deepEqual(r, { passed: 7, total: 10 });
  });
  it("rejects a run whose test count differs from the manifest", () => {
    assert.throws(() => parsePlaywrightJson(report({ expected: 9, unexpected: 0, flaky: 0, skipped: 0 }), 10), HarnessFault);
  });
  it("rejects output that is not a JSON report", () => {
    assert.throws(() => parsePlaywrightJson("Running 10 tests using 1 worker\n", 10), HarnessFault);
  });
});

describe("parseNodeTap", () => {
  const tap = (tests: number, pass: number) => `TAP version 13\n# tests ${tests}\n# suites 1\n# pass ${pass}\n# fail ${tests - pass}\n`;
  it("reads the TAP summary", () => assert.deepEqual(parseNodeTap(tap(29, 25), 29), { passed: 25, total: 29 }));
  it("rejects a count that differs from the manifest", () => assert.throws(() => parseNodeTap(tap(28, 28), 29), HarnessFault));
  it("rejects output with no summary", () => assert.throws(() => parseNodeTap("ok 1 - x\n", 29), HarnessFault));
});

describe("requireCompleted", () => {
  const base = { status: 1, signal: null, stdout: "", stderr: "" };
  it("accepts a non-zero exit (tests failed)", () => requireCompleted("flows", base));
  it("rejects a signal", () => assert.throws(() => requireCompleted("flows", { ...base, status: null, signal: "SIGTERM" }), HarnessFault));
  it("rejects a spawn error", () => assert.throws(() => requireCompleted("flows", { ...base, error: new Error("ETIMEDOUT") }), HarnessFault));
});

describe("csvNote", () => {
  it("quotes, doubles quotes and folds newlines", () => {
    assert.equal(csvNote('stop:install: pip said "no"\n  tail line'), '"stop:install: pip said ""no"" tail line"');
  });
});

describe("formats", () => {
  it("Test run has no zero-padded day", () => assert.equal(formatTestRun(new Date(2026, 9, 8, 9, 5)), "8.10.2026 09:05"));
  it("duration is Xmin Ys", () => assert.equal(formatDuration(1_884_695), "31min 25s"));
});

describe("loadManifest", () => {
  it("reads the real contract manifest", () => {
    const m = loadManifest(join("tracks", "console-hard", "benchmark", "contract-tests", "manifest.json"));
    assert.deepEqual(m.map((e) => e.tests), [29, 12, 11, 11, 10, 13]);
  });
  it("rejects a malformed entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "manifest-"));
    const p = join(dir, "m.json");
    writeFileSync(p, JSON.stringify({ files: [{ file: "a.ts", row: "X", max: 2 }] }));
    assert.throws(() => loadManifest(p), /malformed/);
  });
});

import { HARD_RUBRIC_ROWS } from "../scripts/lib/hard-rubric";
import { allZero, applyStops, parseHardHiddenResults, renderCsv, type RowCell } from "../scripts/lib/hard-score";

const full = (): Map<string, RowCell> =>
  new Map(HARD_RUBRIC_ROWS.filter((r) => r.max !== null || r.scoredBy === "penalty").map((r) => [r.name, { score: r.max ?? 0, notes: "x" }]));

describe("applyStops", () => {
  it("backend stop zeroes the hidden rows, Local build and Self-verification only", () => {
    const out = applyStops(full(), { backend: "stop:boot: exited", frontend: null });
    for (const r of ["Local build", "API contract", "Frontend E2E: flows", "Self-verification"]) assert.equal(out.get(r)!.score, 0, r);
    for (const r of ["Code structure", "Tech stack & run contract", "Visual design"]) assert.equal(out.get(r)!.score, 1, r);
    assert.match(out.get("API contract")!.notes, /stop:boot/);
  });
  it("frontend stop zeroes Local build, both E2E rows and Visual design", () => {
    const out = applyStops(full(), { backend: null, frontend: "stop: npm run build failed" });
    for (const r of ["Local build", "Frontend E2E: flows", "Frontend E2E: layout & a11y", "Visual design"]) assert.equal(out.get(r)!.score, 0, r);
    assert.equal(out.get("API contract")!.score, 2);
  });
  it("both stops give the all-zero rows, Penalty included", () => {
    const out = applyStops(full(), { backend: "a", frontend: "b" });
    assert.ok([...out.values()].every((c) => c.score === 0));
  });
});

describe("renderCsv", () => {
  it("writes the 16 rows in order with valid one-line cells", () => {
    const csv = renderCsv(allZero('model failure: said "hi"\nbye'), "31min 25s", "8.10.2026 09:05");
    const lines = csv.trimEnd().split("\n");
    assert.equal(lines.length, 17);
    assert.equal(lines[0], "Criterion,Score,Max,Notes");
    assert.deepEqual(lines.slice(1).map((l) => l.split(",")[0]), HARD_RUBRIC_ROWS.map((r) => r.name));
    assert.ok(lines[3]!.endsWith(',"model failure: said ""hi"" bye"'));
  });
});

describe("hidden results", () => {
  it("round-trips and rejects a wrong schema", () => {
    const r = { schemaVersion: 1, attempt: "a-attempt-1", rubric: "maintenance-console-hard@0123456789ab", scoredAt: "2026-10-08T07:00:00.000Z", backend: "ok", frontend: "ok",
      rows: [{ row: "API contract", file: "api-contract.test.ts", passed: 29, total: 29, max: 2, score: 2 }] };
    assert.deepEqual(parseHardHiddenResults(JSON.stringify(r)), r);
    assert.throws(() => parseHardHiddenResults(JSON.stringify({ ...r, schemaVersion: 2 })), /schemaVersion/);
  });
});
