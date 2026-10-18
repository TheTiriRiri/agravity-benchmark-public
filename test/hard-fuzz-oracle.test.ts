import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { CasesFile, ExpectedFile, StepReply } from "../tracks/console-hard/benchmark/fuzz/case";
import { HARD_STRATA, TOTAL_CASES } from "../tracks/console-hard/benchmark/fuzz/strata";
import {
  HARD_FUZZ_INPUTS,
  HARD_FUZZ_RESULT_PATH,
  hardFuzzFingerprint,
  type HardFuzzGateResult,
} from "../scripts/lib/hard-gate-fingerprint";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FUZZ_DIR = "../tracks/console-hard/benchmark/fuzz/";

const read = <T>(name: string): T =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`${FUZZ_DIR}${name}`, import.meta.url)), "utf8")) as T;

function readRecord(): HardFuzzGateResult | null {
  try {
    return JSON.parse(readFileSync(fileURLToPath(new URL(`../${HARD_FUZZ_RESULT_PATH}`, import.meta.url)), "utf8"));
  } catch {
    return null;
  }
}

test("cases.json has 280 cases", () => {
  const cases = read<CasesFile>("cases.json");
  assert.equal(cases.cases.length, TOTAL_CASES);
});

test("the oracle was produced from this generator and this seed", () => {
  const cases = read<CasesFile>("cases.json");
  const expected = read<ExpectedFile>("expected.json");
  assert.equal(expected.seed, cases.seed);
  assert.equal(expected.generatorVersion, cases.generatorVersion);
});

test("every case has an answer, and no answer belongs to a case that is gone", () => {
  const cases = read<CasesFile>("cases.json");
  const expected = read<ExpectedFile>("expected.json");
  const caseIds = new Set(cases.cases.map((c) => c.id));
  const answerIds = new Set(Object.keys(expected.replies));
  for (const id of caseIds) assert.ok(answerIds.has(id), `${id} has no recorded answer`);
  for (const id of answerIds) assert.ok(caseIds.has(id), `${id} has an answer but is no longer a case`);
});

test("each answer has one reply per scripted call", () => {
  const cases = read<CasesFile>("cases.json");
  const expected = read<ExpectedFile>("expected.json");
  for (const c of cases.cases) {
    assert.equal(expected.replies[c.id]?.length, c.script.length, `${c.id}: reply count does not match its script`);
  }
});

test("nothing server-generated leaked into the oracle (Ruling H5)", () => {
  const expected = read<ExpectedFile>("expected.json");
  const text = JSON.stringify(expected.replies);
  assert.ok(!/"created_at"|"updated_at"|"uuid"/.test(text), "a server-generated field reached the oracle");
  assert.ok(
    !/"message"/.test(text),
    "error.message is free text by the prompt's own definition and must be normalised away",
  );
  assert.ok(
    !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(text),
    "a uuid reached the oracle",
  );
});

test("every error the reference answered is reduced to its status and code", () => {
  const expected = read<ExpectedFile>("expected.json");
  let errors = 0;
  for (const [id, replies] of Object.entries(expected.replies)) {
    replies.forEach((reply: StepReply, i) => {
      if (reply.status < 400) return;
      errors += 1;
      assert.deepEqual(
        Object.keys(reply.body as object),
        ["error"],
        `${id} step ${i + 1}: a ${reply.status} whose body is not {error: {code}}`,
      );
      assert.deepEqual(Object.keys((reply.body as { error: object }).error), ["code"], `${id} step ${i + 1}`);
      assert.equal(typeof (reply.body as { error: { code: unknown } }).error.code, "string", `${id} step ${i + 1}`);
    });
  }
  assert.ok(errors > 0, "no case reaches an error, so the strata about rejection measure nothing");
});

test("the committed oracle's fingerprint is recomputed from the one shared list", (t) => {
  const record = readRecord();
  if (record === null) {
    t.todo("gate hard-fuzz has not been recorded; run `npm run gate:hard-fuzz -- --accept-oracle`");
    return;
  }
  assert.equal(
    record.fingerprint,
    hardFuzzFingerprint(ROOT),
    "a hard fuzz input changed: run `npm run gate:hard-fuzz -- --accept-oracle`",
  );
});

test("the gate record verifies reference 280/280 and preemption mutants killed", (t) => {
  const record = readRecord();
  if (record === null) {
    t.todo("gate hard-fuzz has not been recorded; run `npm run gate:hard-fuzz -- --accept-oracle`");
    return;
  }
  assert.equal(record.total, TOTAL_CASES);
  assert.equal(record.referencePassed, TOTAL_CASES);

  for (const mutant of [
    "preempt_unfiltered",
    "preempt_evict_all",
    "preempt_parts_after",
    "preempt_no_reprocess",
    "preempt_reprocess_each_round",
  ]) {
    const failures = record.mutantFailures[mutant] as
      | { total: number; byStratum: Record<string, number> }
      | undefined;
    assert.ok(failures, `mutant ${mutant} must be recorded`);
    const count: number = failures.byStratum["preemption-edf-observable"] ?? 0;
    assert.ok(count > 0, `mutant ${mutant} must be killed by stratum preemption-edf-observable`);
  }
});
