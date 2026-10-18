import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { CasesFile, ExpectedFile, StepReply } from "../tracks/console-fuzz/benchmark/fuzz/case";
import { STRATA } from "../tracks/console-fuzz/benchmark/fuzz/strata";
import { runContractFile } from "../scripts/lib/contract-suite";
import {
  FUZZ_GATE_RESULT_PATH,
  FUZZ_ORACLE_INPUTS,
  fuzzOracleFingerprint,
  type FuzzGateResult,
} from "../scripts/lib/gate-fingerprint";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FUZZ_DIR = "../tracks/console-fuzz/benchmark/fuzz/";

const read = <T>(name: string): T =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`${FUZZ_DIR}${name}`, import.meta.url)), "utf8")) as T;

const cases = read<CasesFile>("cases.json");
const expected = read<ExpectedFile>("expected.json");
const manifest = read<{ files: { file: string; tests: number; timeoutMs: number }[] }>("manifest.json");

/** The gate P2-B record, or null when `npm run gate:fuzz` has not written one. */
function readRecord(): FuzzGateResult | null {
  try {
    return JSON.parse(readFileSync(fileURLToPath(new URL(`../${FUZZ_GATE_RESULT_PATH}`, import.meta.url)), "utf8"));
  } catch {
    return null;
  }
}

test("the oracle was produced from this generator and this seed", () => {
  assert.equal(expected.seed, cases.seed);
  assert.equal(expected.generatorVersion, cases.generatorVersion);
});

test("every case has an answer, and no answer belongs to a case that is gone", () => {
  const caseIds = new Set(cases.cases.map((c) => c.id));
  const answerIds = new Set(Object.keys(expected.replies));
  for (const id of caseIds) assert.ok(answerIds.has(id), `${id} has no recorded answer`);
  for (const id of answerIds) assert.ok(caseIds.has(id), `${id} has an answer but is no longer a case`);
});

test("each answer has one reply per scripted call", () => {
  for (const c of cases.cases) {
    assert.equal(expected.replies[c.id]?.length, c.script.length, `${c.id}: reply count does not match its script`);
  }
});

test("nothing server-generated leaked into the oracle (Ruling H5)", () => {
  // Deep equality across backends only works while responses carry no
  // timestamps, uuids or ids beyond the deterministic WO-0NN. If a future
  // resource shape adds one, this fails and the fuzz has to change with it.
  const text = JSON.stringify(expected.replies);
  assert.ok(!/"created_at"|"updated_at"|"uuid"/.test(text), "a server-generated field reached the oracle");
  assert.ok(
    !/"message"/.test(text),
    "error.message is free text by the prompt's own definition and must be normalised away (decision 8)",
  );
  assert.ok(
    !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(text),
    "a uuid reached the oracle",
  );
});

test("every error the reference answered is reduced to its status and code (decision 8)", () => {
  // Also for the 409s of the transition strata: they are errors like the rest,
  // and a body of another shape (a framework's own `detail`, say) would mean
  // the reference is not answering the contract's envelope at all.
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
    t.todo("gate P2-B has not been recorded; run `npm run gate:fuzz`");
    return;
  }
  assert.equal(
    record.fingerprint,
    fuzzOracleFingerprint(ROOT),
    "the reference, the seed, the cases, the oracle, the replay, fuzz.test.ts or the manifest changed after gate P2-B was recorded: run `npm run gate:fuzz`",
  );
});

test("the oracle list names every file a fuzz verdict depends on", () => {
  const listed = [...FUZZ_ORACLE_INPUTS].map((p) => p.split("\\").join("/"));
  for (const needed of [
    "test/fixtures/reference-backend",
    "benchmark/context/seed.json",
    "tracks/console-fuzz/benchmark/fuzz/cases.json",
    "tracks/console-fuzz/benchmark/fuzz/expected.json",
    "tracks/console-fuzz/benchmark/fuzz/replay.ts",
    "tracks/console-fuzz/benchmark/fuzz/fuzz.test.ts",
    "tracks/console-fuzz/benchmark/fuzz/manifest.json",
  ]) {
    assert.ok(listed.includes(needed), `${needed} is not covered by the gate P2-B fingerprint`);
  }
  assert.ok(Object.isFrozen(FUZZ_ORACLE_INPUTS));
});

test("the reference passes all 200, recorded by the last gate:fuzz run", (t) => {
  const record = readRecord();
  if (record === null) {
    t.todo("gate P2-B has not been recorded; run `npm run gate:fuzz`");
    return;
  }
  assert.equal(record.total, 200);
  assert.equal(record.referencePassed, 200, "the reference must answer its own oracle perfectly");
  assert.equal(record.seed, cases.seed);
  assert.equal(record.generatorVersion, cases.generatorVersion);
});

test("every mutant's failures are recorded per stratum, zeros included", (t) => {
  const record = readRecord();
  if (record === null) {
    t.todo("gate P2-B has not been recorded; run `npm run gate:fuzz`");
    return;
  }
  const mutants: string[] = Object.keys(
    JSON.parse(readFileSync(fileURLToPath(new URL("../test/fixtures/reference-backend/mutants.json", import.meta.url)), "utf8")),
  );
  assert.deepEqual(Object.keys(record.mutantFailures).sort(), [...mutants].sort(), "the record and mutants.json disagree on which mutants exist");
  const strata = new Set(STRATA.map((s) => s.id));
  for (const mutant of mutants) {
    const { total, byStratum }: FuzzGateResult["mutantFailures"][string] = record.mutantFailures[mutant];
    assert.equal(typeof total, "number", `${mutant} has no recorded count`);
    let sum = 0;
    for (const [stratum, count] of Object.entries(byStratum)) {
      assert.ok(strata.has(stratum), `${mutant}: ${stratum} is not a stratum`);
      assert.ok(Number.isInteger(count) && count > 0 && count <= 10, `${mutant}: ${stratum} has an impossible count ${count}`);
      sum += count;
    }
    assert.equal(sum, total, `${mutant}: the strata do not add up to its total`);
  }
  // Spec §10, gate P2-B: a mutant at zero is recorded, not fixed. The count is
  // what says whether a rule is covered well or barely, and a zero is a real
  // measurement — a hand-written test already carries that rule.
});

// ---------------------------------------------------------------------------
// fuzz.test.ts, run through the real scoring path against a server that
// answers from expected.json. Hermetic: no Python, no reference.

interface Fake {
  baseUrl: string;
  server: Server;
}

/**
 * Answers case k's script from `expected.json`, in the order the file runs
 * them: each `POST /reset` begins the next case, the next `setup.length` calls
 * are scaffolding, and what follows is the script. `tamper` may change a reply.
 */
async function fakeBackend(tamper: (caseId: string, step: number, reply: StepReply) => StepReply): Promise<Fake> {
  let current = -1;
  let seen = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const send = (reply: StepReply) => {
        response.statusCode = reply.status;
        response.setHeader("content-type", "application/json");
        response.end(reply.body === null ? "" : JSON.stringify(reply.body));
      };
      if (request.method === "POST" && request.url === "/api/v1/reset") {
        current += 1;
        seen = 0;
        return send({ status: 200, body: {} });
      }
      const fuzzCase = cases.cases[current];
      const index = seen++;
      if (index < fuzzCase.setup.length) return send({ status: 200, body: {} });
      const step = index - fuzzCase.setup.length;
      send(tamper(fuzzCase.id, step, expected.replies[fuzzCase.id][step]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

async function runFuzzFile(tamper: Parameters<typeof fakeBackend>[0]) {
  const fake = await fakeBackend(tamper);
  // node:test refuses to nest: `run()` inside a test process reports nothing.
  // The variable that says so is dropped for the call and put back after. That
  // is safe only while the tests of this file run one after another, as they do
  // now: give the file `concurrency` and another test would see the variable
  // missing, and fail in a way that is hard to trace back to this line.
  const context = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    const entry = manifest.files.find((f) => f.file === "fuzz.test.ts")!;
    return await runContractFile({
      file: fileURLToPath(new URL(`${FUZZ_DIR}fuzz.test.ts`, import.meta.url)),
      baseUrl: fake.baseUrl,
      seedPath: fileURLToPath(new URL("../benchmark/context/seed.json", import.meta.url)),
      timeoutMs: entry.timeoutMs,
      expectedTests: entry.tests,
    });
  } finally {
    if (context !== undefined) process.env.NODE_TEST_CONTEXT = context;
    fake.server.close();
  }
}

const moved = (reply: StepReply): StepReply => ({ ...reply, status: reply.status + 1 });

test("fuzz.test.ts passes 200/200 against a backend that answers exactly as the oracle says", async () => {
  const result = await runFuzzFile((_id, _step, reply) => reply);
  assert.equal(result.total, 200);
  assert.equal(result.passed, 200, result.failed.map((f) => f.name).join(", "));
  assert.equal(result.notRun, 0);
});

test("a changed reply fails exactly its own case, and the name carries the stratum", async () => {
  const target = cases.cases.find((c) => c.oracle !== false && c.script.length > 0)!;
  const result = await runFuzzFile((id, step, reply) => (id === target.id && step === 0 ? moved(reply) : reply));
  assert.deepEqual(result.failed.map((f) => f.name), [`${target.stratum}/${target.id}`]);
});

test("a case marked oracle:false is not compared with the reference, only with itself (decision 9)", async () => {
  const target = cases.cases.find((c) => c.oracle === false);
  assert.ok(target, "no case is marked oracle:false, so rule 10 is not measured as decision 9 describes");
  assert.ok((target.invariants ?? []).length > 0, "an oracle:false case with no invariant measures nothing");
  // Every reply of the case is different from the oracle's, consistently: the
  // backend disagrees with the reference but is deterministic against itself.
  const same = await runFuzzFile((id, _step, reply) => (id === target.id ? moved(reply) : reply));
  assert.deepEqual(same.failed, [], "an oracle:false case was compared with the oracle");
  // One of the two replies an invariant pairs moves alone: that is a backend
  // that disagrees with itself, and it must fail.
  const { a } = target.invariants![0];
  const apart = await runFuzzFile((id, step, reply) => (id === target.id && step === a ? moved(reply) : reply));
  assert.deepEqual(apart.failed.map((f) => f.name), [`${target.stratum}/${target.id}`]);
});
