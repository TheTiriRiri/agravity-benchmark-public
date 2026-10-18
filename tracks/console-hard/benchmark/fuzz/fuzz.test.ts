/**
 * 280 top-level tests, one per case, named `<stratum>/<caseId>` — the test
 * name is how a per-case result reaches the scorer.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { replayCase } from "./replay";
import type { CasesFile, ExpectedFile } from "./case";

const BASE = process.env.CONTRACT_BASE_URL;
if (!BASE) throw new Error("CONTRACT_BASE_URL is not set");

const casesUrl = new URL("./cases.json", import.meta.url);
const expectedUrl = new URL("./expected.json", import.meta.url);

const cases: CasesFile = JSON.parse(readFileSync(casesUrl, "utf8"));
const expected: ExpectedFile | null = existsSync(expectedUrl)
  ? JSON.parse(readFileSync(expectedUrl, "utf8"))
  : null;

for (const fuzzCase of cases.cases) {
  test(`${fuzzCase.stratum}/${fuzzCase.id}`, async () => {
    const actual = await replayCase(BASE, fuzzCase);
    if (expected && fuzzCase.oracle !== false) {
      const want = expected.replies[fuzzCase.id];
      assert.ok(want, `${fuzzCase.id} has no recorded answer`);
      for (let i = 0; i < want.length; i += 1) {
        assert.deepEqual(
          actual[i],
          want[i],
          `${fuzzCase.aim}\nstep ${i + 1}: ${fuzzCase.script[i]?.method} ${fuzzCase.script[i]?.path}`,
        );
      }
    }
    for (const invariant of fuzzCase.invariants ?? []) {
      assert.deepEqual(
        actual[invariant.a],
        actual[invariant.b],
        `${fuzzCase.aim}\nsteps ${invariant.a + 1} and ${invariant.b + 1} must answer identically on the same backend`,
      );
    }
  });
}
