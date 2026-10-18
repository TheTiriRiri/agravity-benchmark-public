import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  RESPONSE_TAIL_BYTES,
  STDERR_TAIL_BYTES,
  parseEnvelope,
  readRunJson,
  runJsonRefusal,
  stderrTail,
  tailBytes,
  writeRunJson,
  type RunJson,
} from "../scripts/lib/run-json";

const FIXTURES = new URL("./fixtures/", import.meta.url);

function fixture(name: string): string {
  return readFileSync(new URL(name, FIXTURES), "utf8");
}

function withTempDir<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "agrav-run-json-test-"));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SAMPLE: RunJson = {
  id: "gemini-38-flash-low",
  model: "gemini-3.8-flash",
  effort: "low",
  agyVersion: "1.1.26",
  image: "agrav-bench/harness:2026-09-05@sha256:916ace98438349506d21addf754f5a8ae4fae7a2e432ab05f232866a2ad31261",
  startedAt: "2026-09-04T18:00:00.000Z",
  durationMs: 346000,
  exitCode: 0,
  envelope: {
    status: "SUCCESS",
    num_turns: 42,
    duration_seconds: 345,
    usage: {
      input_tokens: 128340,
      output_tokens: 39211,
      cache_read_tokens: 91002,
      thinking_tokens: 15873,
      total_tokens: 167551,
    },
    conversation_id: "c7f1e2d0-0000-4000-8000-abcdefabcdef",
    error: "",
    responseTail: null,
  },
  stderrTail: "Antigravity CLI 1.1.26\n",
  softDenied: false,
  failureKind: null,
};

test("writeRunJson -> readRunJson round-trips every field", () => {
  withTempDir((dir) => {
    const path = join(dir, "gemini-38-flash-low-attempt-1", "run.json");
    writeRunJson(path, SAMPLE);
    assert.deepEqual(readRunJson(path), SAMPLE);
  });
});

test("writeRunJson -> readRunJson round-trips envelope: null and a failure", () => {
  withTempDir((dir) => {
    const failed: RunJson = {
      ...SAMPLE,
      exitCode: 1,
      envelope: null,
      stderrTail: "panic: nope\n",
      softDenied: true,
      failureKind: "infra",
    };
    const path = join(dir, "run.json");
    writeRunJson(path, failed);
    const read = readRunJson(path);
    assert.deepEqual(read, failed);
    assert.equal(read.envelope, null);
    assert.equal(read.failureKind, "infra");
    assert.equal(read.softDenied, true);
  });
});

test("writeRunJson round-trips a null exitCode and a usage-less envelope", () => {
  withTempDir((dir) => {
    const killed: RunJson = {
      ...SAMPLE,
      exitCode: null,
      envelope: { status: "ERROR", num_turns: 0, duration_seconds: 0, usage: null, conversation_id: null, error: "boom", responseTail: null },
      failureKind: "model",
    };
    const path = join(dir, "run.json");
    writeRunJson(path, killed);
    assert.deepEqual(readRunJson(path), killed);
  });
});

test("writeRunJson creates the eval-results directory and ends the file with a newline", () => {
  withTempDir((dir) => {
    const path = join(dir, "eval-results", "gemini-31-pro-high-attempt-2", "run.json");
    writeRunJson(path, SAMPLE);
    assert.match(readFileSync(path, "utf8"), /\n$/);
  });
});

test("writeRunJson drops fields that are not in the schema", () => {
  withTempDir((dir) => {
    const path = join(dir, "run.json");
    writeRunJson(path, { ...SAMPLE, secretToken: "hunter2" } as unknown as RunJson);
    assert.equal("secretToken" in JSON.parse(readFileSync(path, "utf8")), false);
  });
});

test("readRunJson rejects a malformed file, naming the path", () => {
  withTempDir((dir) => {
    const path = join(dir, "run.json");

    writeFileSync(path, "not json at all", "utf8");
    assert.throws(() => readRunJson(path), new RegExp(`${escape(path)}: not valid JSON`));

    writeFileSync(path, JSON.stringify({ ...SAMPLE, failureKind: "weird" }), "utf8");
    assert.throws(() => readRunJson(path), /failureKind must be null/);

    writeFileSync(path, JSON.stringify({ ...SAMPLE, durationMs: "346000" }), "utf8");
    assert.throws(() => readRunJson(path), /durationMs must be a finite number/);

    writeFileSync(path, JSON.stringify({ ...SAMPLE, id: 7 }), "utf8");
    assert.throws(() => readRunJson(path), /id must be a string/);

    writeFileSync(path, JSON.stringify([SAMPLE]), "utf8");
    assert.throws(() => readRunJson(path), /expected a JSON object/);
  });
});

test("writeRunJson refuses to persist a malformed record", () => {
  withTempDir((dir) => {
    const path = join(dir, "run.json");
    assert.throws(
      () => writeRunJson(path, { ...SAMPLE, softDenied: "yes" } as unknown as RunJson),
      /softDenied must be a boolean/,
    );
  });
});

test("parseEnvelope reads the success fixture", () => {
  const envelope = parseEnvelope(fixture("envelope-success.json"));
  assert.notEqual(envelope, null);
  assert.equal(envelope?.status, "SUCCESS");
  assert.equal(envelope?.num_turns, 42);
  assert.equal(envelope?.duration_seconds, 345);
  assert.equal(envelope?.conversation_id, "c7f1e2d0-0000-4000-8000-abcdefabcdef");
  assert.equal(envelope?.usage?.total_tokens, 167551);
  assert.equal(envelope?.usage?.cache_read_tokens, 91002);
});

test("parseEnvelope finds the envelope after leading noise", () => {
  const noisy = `warming up\nstill working\n${fixture("envelope-timeout.json")}`;
  const envelope = parseEnvelope(noisy);
  assert.equal(envelope?.status, "ERROR");
  assert.match(envelope?.error ?? "", /print timeout/);
  assert.equal(envelope?.usage?.output_tokens, 12000);
});

test("parseEnvelope returns null when there is no envelope", () => {
  assert.equal(parseEnvelope(""), null);
  assert.equal(parseEnvelope("panic: runtime error\n"), null);
  assert.equal(parseEnvelope('{"hello": "world"}'), null);
  assert.equal(parseEnvelope('{"status": '), null);
});

test("parseEnvelope defaults missing counters instead of failing", () => {
  const envelope = parseEnvelope('{"status":"SUCCESS"}');
  assert.deepEqual(envelope, {
    status: "SUCCESS",
    num_turns: 0,
    duration_seconds: 0,
    usage: null,
    conversation_id: null,
    error: "",
    responseTail: null,
  });
});

test("runJsonRefusal admits a clean data point, with its run.json, and says why it refuses anything else", () => {
  withTempDir((dir) => {
    const path = join(dir, "run.json");
    assert.deepEqual(runJsonRefusal(dir, "contract-tests"), {
      refusal: `no run.json at ${path}. A real attempt has one; pass --ignore-run-json only for a synthetic attempt.`,
    });
    // A directory where the file should be is no run.json either.
    mkdirSync(path);
    assert.match((runJsonRefusal(dir, "contract-tests") as { refusal: string }).refusal, /^no run\.json at /);
    rmSync(path, { recursive: true });

    writeFileSync(path, "{not json");
    assert.match((runJsonRefusal(dir, "contract-tests") as { refusal: string }).refusal, new RegExp(`^cannot use ${escape(path)}: .*not valid JSON`));

    writeRunJson(path, SAMPLE);
    assert.deepEqual(runJsonRefusal(dir, "contract-tests"), { run: SAMPLE });

    for (const [change, refusal] of [
      [{ failureKind: "infra" }, `${path} records an infra failure: the attempt is not a data point. Rerun the attempt; do not score it.`],
      [{ softDenied: true }, `${path} records a soft-deny: a tool was blocked, so the attempt is not a data point. Rerun it; do not score it.`],
      [{ failureKind: "model" }, `${path} records failureKind "model": the attempt scores 0 whatever is on disk, and its CSV is all zero without serving it.`],
    ] as const) {
      writeRunJson(path, { ...SAMPLE, ...change });
      assert.deepEqual(runJsonRefusal(dir, "serving it"), { refusal });
    }
  });
});

test("stderrTail keeps the last bytes only", () => {
  const short = "short stderr\n";
  assert.equal(stderrTail(short), short);

  const long = `${"x".repeat(STDERR_TAIL_BYTES)}TAIL`;
  const tail = stderrTail(long);
  assert.equal(Buffer.byteLength(tail, "utf8"), STDERR_TAIL_BYTES);
  assert.equal(tail.endsWith("TAIL"), true);

  assert.equal(stderrTail("abcdef", 3), "def");
});

test("tailBytes keeps the last bytes and leaves a short string alone", () => {
  assert.equal(tailBytes("short", 4096), "short");
  assert.equal(tailBytes("abcdef", 3), "def");
  assert.equal(tailBytes("", 10), "");
});

test("stderrTail is tailBytes at STDERR_TAIL_BYTES", () => {
  const long = "x".repeat(STDERR_TAIL_BYTES + 100);
  assert.equal(stderrTail(long), tailBytes(long, STDERR_TAIL_BYTES));
  assert.equal(stderrTail(long).length, STDERR_TAIL_BYTES);
});

test("parseEnvelope keeps the tail of response", () => {
  const envelope = parseEnvelope(
    JSON.stringify({
      conversation_id: "c",
      status: "SUCCESS",
      response: "I have created the backend and the frontend.",
      duration_seconds: 1.5,
      num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 2, cache_read_tokens: 0, thinking_tokens: 0, total_tokens: 3 },
    }),
  );
  assert.ok(envelope);
  assert.equal(envelope.responseTail, "I have created the backend and the frontend.");
});

test("parseEnvelope truncates a long response to the last RESPONSE_TAIL_BYTES bytes", () => {
  const response = `${"a".repeat(RESPONSE_TAIL_BYTES)}THE-END`;
  const envelope = parseEnvelope(JSON.stringify({ status: "SUCCESS", response, num_turns: 1 }));
  assert.ok(envelope);
  assert.equal(envelope.responseTail?.length, RESPONSE_TAIL_BYTES);
  assert.ok(envelope.responseTail?.endsWith("THE-END"), "the tail keeps the end, not the start");
});

test("parseEnvelope reports a missing response as null, an empty one as the empty string", () => {
  const missing = parseEnvelope(JSON.stringify({ status: "SUCCESS", num_turns: 1 }));
  assert.ok(missing);
  assert.equal(missing.responseTail, null, "no response field is not the same as an empty one");

  const empty = parseEnvelope(JSON.stringify({ status: "SUCCESS", num_turns: 1, response: "" }));
  assert.ok(empty);
  assert.equal(empty.responseTail, "");
});

test("responseTail round-trips through writeRunJson and readRunJson", () => {
  withTempDir((dir) => {
    const path = join(dir, "run.json");
    const value: RunJson = {
      ...SAMPLE,
      envelope: { ...SAMPLE.envelope!, responseTail: "Done. Created backend/app/main.py." },
    };
    writeRunJson(path, value);
    assert.equal(readRunJson(path).envelope?.responseTail, "Done. Created backend/app/main.py.");
  });
});

test("a run.json written before responseTail existed still reads, with null", () => {
  withTempDir((dir) => {
    const path = join(dir, "run.json");
    const legacy = { ...SAMPLE, envelope: { ...SAMPLE.envelope } };
    delete (legacy.envelope as Record<string, unknown>).responseTail;
    writeFileSync(path, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
    assert.equal(readRunJson(path).envelope?.responseTail, null);
  });
});

test("a non-string responseTail on disk is rejected, not coerced", () => {
  withTempDir((dir) => {
    const path = join(dir, "run.json");
    const bad = { ...SAMPLE, envelope: { ...SAMPLE.envelope, responseTail: 42 } };
    writeFileSync(path, `${JSON.stringify(bad, null, 2)}\n`, "utf8");
    assert.throws(() => readRunJson(path), /responseTail must be a string or null/);
  });
});

test("an over-long responseTail on disk is truncated rather than trusted", () => {
  withTempDir((dir) => {
    const path = join(dir, "run.json");
    const long = `${"a".repeat(RESPONSE_TAIL_BYTES)}THE-END`;
    writeFileSync(path, `${JSON.stringify({ ...SAMPLE, envelope: { ...SAMPLE.envelope, responseTail: long } }, null, 2)}\n`, "utf8");
    const read = readRunJson(path).envelope?.responseTail;
    assert.equal(read?.length, RESPONSE_TAIL_BYTES);
    assert.ok(read?.endsWith("THE-END"));
  });
});

test("noDiffFromBase round-trips true and false through writeRunJson and readRunJson", () => {
  withTempDir((dir) => {
    const pathTrue = join(dir, "run-true.json");
    writeRunJson(pathTrue, { ...SAMPLE, noDiffFromBase: true });
    assert.equal(readRunJson(pathTrue).noDiffFromBase, true);

    const pathFalse = join(dir, "run-false.json");
    writeRunJson(pathFalse, { ...SAMPLE, noDiffFromBase: false });
    assert.equal(readRunJson(pathFalse).noDiffFromBase, false);
  });
});

test("a run.json written without noDiffFromBase parses with undefined, and writeRunJson omits it", () => {
  withTempDir((dir) => {
    const path = join(dir, "run.json");
    writeRunJson(path, SAMPLE);
    const read = readRunJson(path);
    assert.equal(read.noDiffFromBase, undefined);
    assert.equal("noDiffFromBase" in read, false);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    assert.equal("noDiffFromBase" in raw, false);
  });
});

test("a non-boolean noDiffFromBase on disk is rejected by readRunJson", () => {
  withTempDir((dir) => {
    const path = join(dir, "run.json");
    for (const badValue of ["true", 1, null, [true], {}]) {
      writeFileSync(path, `${JSON.stringify({ ...SAMPLE, noDiffFromBase: badValue }, null, 2)}\n`, "utf8");
      assert.throws(() => readRunJson(path), /noDiffFromBase must be a boolean/);
    }
  });
});

test("writeRunJson refuses to persist a malformed noDiffFromBase", () => {
  withTempDir((dir) => {
    const path = join(dir, "run.json");
    assert.throws(
      () => writeRunJson(path, { ...SAMPLE, noDiffFromBase: "yes" as unknown as boolean }),
      /noDiffFromBase must be a boolean/,
    );
  });
});

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
