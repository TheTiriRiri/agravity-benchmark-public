/**
 * The contract-results.json files the process-results fixtures carry, built
 * the way contract-tests builds one (`groupFromFileResult` over the real
 * manifest) and validated by `parseContractResults`, so they cannot drift
 * from the shape. Committed, and kept byte-equal to this generator's output
 * by a test in test/process-results.test.ts; regenerate them with
 *
 *   node --import tsx test/fixtures/contract-results-fixture.ts
 *
 * Every failed test is named `fixture failure <n>` and fails at
 * `GET /schedule`, so the CSV Notes are predictable.
 */
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  diagnose,
  groupFromFileResult,
  loadManifest,
  parseContractResults,
  type ContractResults,
} from "../../scripts/lib/contract-results";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** A rubric id no real file set hashes to: fixtures never depend on the current one. */
export const FIXTURE_RUBRIC = "maintenance-console@0000000000aa";

export function contractResultsFixture(attempt: string, passed?: readonly number[], rubric: string = FIXTURE_RUBRIC): ContractResults {
  const manifest = loadManifest(REPO_ROOT);
  const counts = passed ?? manifest.map((entry) => entry.tests);
  if (counts.length !== manifest.length) throw new Error(`passed has ${counts.length} counts; the manifest has ${manifest.length} files`);
  const groups = manifest.map((entry, i) =>
    groupFromFileResult(entry, {
      file: entry.file,
      total: entry.tests,
      passed: counts[i],
      failed: Array.from({ length: entry.tests - counts[i] }, (_, n) => ({
        name: `fixture failure ${n + 1}`,
        failureType: "testCodeFailure",
        message: "GET /schedule answered 500",
      })),
      notRun: 0,
      hookFailed: 0,
      timedOut: false,
    }),
  );
  return parseContractResults(
    JSON.stringify({
      schemaVersion: 1,
      attempt,
      image: `agrav-bench/harness:2026-09-19@sha256:${"1".repeat(64)}`,
      runImage: null,
      rubric,
      testsCommit: "0".repeat(40),
      testsDirty: false,
      ungated: false,
      startedAt: "2026-09-20T10:00:00.000Z",
      durationMs: 60000,
      pipFreeze: ["fastapi==0.115.14", "uvicorn==0.30.6"],
      warnings: [],
      boot: { ok: true, stage: null, detail: null },
      diagnosis: diagnose(groups),
      groups,
    }),
  );
}

/** `<fixture tree>/<attempt dir>` → passed counts in manifest order, for each fixture that carries a file. */
export const FIXTURE_PASSED: Readonly<Record<string, readonly number[]>> = Object.freeze({
  "eval-results/gemini-38-flash-high-attempt-1": [18, 9, 11, 11],
  "eval-results/gemini-38-flash-low-attempt-1": [24, 12, 11, 11],
  "eval-results/claude-opus-46-high-attempt-1": [20, 12, 10, 10],
  "eval-results/gemini-31-pro-low-attempt-2": [24, 6, 11, 11],
  "eval-results-stray-cost/claude-opus-46-high-attempt-2": [24, 12, 11, 11],
  "eval-results-stray-cost/gpt-oss-120b-med-attempt-1": [24, 12, 11, 11],
});

/** The bytes of one committed fixture file. */
export function fixtureText(key: string): string {
  const attempt = key.slice(key.indexOf("/") + 1);
  return `${JSON.stringify(contractResultsFixture(attempt, FIXTURE_PASSED[key]), null, 2)}\n`;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const key of Object.keys(FIXTURE_PASSED)) {
    writeFileSync(join(REPO_ROOT, "test", "fixtures", key, "contract-results.json"), fixtureText(key));
  }
}
