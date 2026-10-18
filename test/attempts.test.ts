import assert from "node:assert/strict";
import { test } from "node:test";

import { ATTEMPT_DIR_RE, attemptDirName, parseAttemptDirName } from "../scripts/lib/attempts";

test("parseAttemptDirName keeps the effort suffix on the model id", () => {
  assert.deepEqual(parseAttemptDirName("gemini-38-flash-low-attempt-12"), {
    modelId: "gemini-38-flash-low",
    attempt: 12,
  });
});

test("parseAttemptDirName accepts ids with dots and digits", () => {
  assert.deepEqual(parseAttemptDirName("gpt-oss-120b-med-attempt-1"), {
    modelId: "gpt-oss-120b-med",
    attempt: 1,
  });
  assert.deepEqual(parseAttemptDirName("claude-4.6-high-attempt-3"), {
    modelId: "claude-4.6-high",
    attempt: 3,
  });
});

test("parseAttemptDirName rejects an underscore-bearing name", () => {
  assert.equal(parseAttemptDirName("gemini_36_flash_low-attempt-1"), null);
  assert.equal(parseAttemptDirName("gemini-38-flash-low_attempt_1"), null);
});

test("parseAttemptDirName rejects names that are not attempt directories", () => {
  for (const name of [
    "gemini-38-flash-low",
    "gemini-38-flash-low-attempt-",
    "gemini-38-flash-low-attempt-x",
    "Gemini-36-Flash-Low-attempt-1",
    "-attempt-1",
    "node_modules",
    "",
  ]) {
    assert.equal(parseAttemptDirName(name), null, `expected ${JSON.stringify(name)} to be rejected`);
  }
});

test("parseAttemptDirName takes the last -attempt- as the separator", () => {
  assert.deepEqual(parseAttemptDirName("weird-attempt-1-attempt-2"), {
    modelId: "weird-attempt-1",
    attempt: 2,
  });
});

test("attemptDirName round-trips through parseAttemptDirName", () => {
  const ids = [
    "gemini-38-flash-high",
    "gemini-38-flash-med",
    "gemini-38-flash-low",
    "gemini-37-flash-high",
    "gemini-31-pro-high",
    "gemini-31-pro-low",
    "claude-sonnet-46-high",
    "claude-opus-46-high",
    "gpt-oss-120b-med",
  ];
  for (const id of ids) {
    for (const attempt of [1, 5, 12]) {
      const name = attemptDirName(id, attempt);
      assert.match(name, ATTEMPT_DIR_RE);
      assert.deepEqual(parseAttemptDirName(name), { modelId: id, attempt });
    }
  }
});

test("attemptDirName refuses an id that would not parse back", () => {
  assert.throws(() => attemptDirName("gemini_36_flash", 1), /invalid benchmark id/);
  assert.throws(() => attemptDirName("Gemini-36", 1), /invalid benchmark id/);
  assert.throws(() => attemptDirName("", 1), /invalid benchmark id/);
});

test("attemptDirName refuses a non-positive or fractional attempt number", () => {
  assert.throws(() => attemptDirName("gemini-38-flash-low", 0), /invalid attempt number/);
  assert.throws(() => attemptDirName("gemini-38-flash-low", -1), /invalid attempt number/);
  assert.throws(() => attemptDirName("gemini-38-flash-low", 1.5), /invalid attempt number/);
});
