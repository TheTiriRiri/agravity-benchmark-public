/**
 * 200 top-level tests, one per case, named `<stratum>/<caseId>` — the test
 * name is how a per-case result reaches the scorer, because
 * scripts/lib/contract-suite.ts is a RUBRIC_ID_INPUT and reports only names
 * (the P2 plan, decision 1).
 *
 * Run by contract-suite.ts unchanged, like every other hidden suite.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { replayCase } from "./replay";
import type { CasesFile, ExpectedFile } from "./case";

const BASE = process.env.CONTRACT_BASE_URL;
if (!BASE) throw new Error("CONTRACT_BASE_URL is not set");

const cases: CasesFile = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8"));
const expected: ExpectedFile = JSON.parse(readFileSync(new URL("./expected.json", import.meta.url), "utf8"));

for (const fuzzCase of cases.cases) {
  test(`${fuzzCase.stratum}/${fuzzCase.id}`, async () => {
    const actual = await replayCase(BASE, fuzzCase);
    const want = expected.replies[fuzzCase.id];
    assert.ok(want, `${fuzzCase.id} has no recorded answer`);
    // decision 9: a case that measures the backend against itself does not
    // also measure it against the reference.
    if (fuzzCase.oracle !== false) {
      for (let i = 0; i < want.length; i += 1) {
        assert.deepEqual(
          actual[i],
          want[i],
          `${fuzzCase.aim}\nstep ${i + 1}: ${fuzzCase.script[i]?.method} ${fuzzCase.script[i]?.path}`,
        );
      }
    }
    // Checked against this run, never against the oracle (decision 9): rule 10
    // is a statement about the backend's agreement with itself.
    for (const invariant of fuzzCase.invariants ?? []) {
      assert.deepEqual(
        actual[invariant.a],
        actual[invariant.b],
        `${fuzzCase.aim}\nsteps ${invariant.a + 1} and ${invariant.b + 1} must answer identically on the same backend`,
      );
    }
  });
}
