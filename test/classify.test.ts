import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  checkQuotaFloor,
  classifyFailure,
  detectTruncationRecovered,
  parseUsageRemaining,
  parseUsageRows,
  type ClassifyInput,
} from "../scripts/lib/classify";
import { parseEnvelope } from "../scripts/lib/run-json";

const FIXTURES = new URL("./fixtures/", import.meta.url);

function fixture(name: string): string {
  return readFileSync(new URL(name, FIXTURES), "utf8");
}

const SUCCESS_STDOUT = fixture("envelope-success.json");
const TIMEOUT_STDOUT = fixture("envelope-timeout.json");
const OUTPUT_TOKEN_LIMIT_STDOUT = fixture("envelope-output-token-limit.json");
const CLEAN_STDERR = fixture("stderr-clean.txt");

/** A clean, successful attempt; every case below is this with one thing changed. */
function baseInput(overrides: Partial<ClassifyInput> = {}): ClassifyInput {
  const stdout = overrides.stdout ?? SUCCESS_STDOUT;
  return {
    exitCode: 0,
    stdout,
    stderr: CLEAN_STDERR,
    envelope: parseEnvelope(stdout),
    workspaceEmpty: false,
    ...overrides,
  };
}

test("a clean run is a data point", () => {
  const result = classifyFailure(baseInput());
  assert.equal(result.failureKind, null);
  assert.equal(result.softDenied, false);
  assert.equal(result.rateLimited, false);
  assert.equal(result.reason, "success");
});

test("a clean run is not thrown away by the --print-timeout echo on stderr", () => {
  assert.match(CLEAN_STDERR, /--print-timeout/);
  assert.equal(classifyFailure(baseInput()).failureKind, null);
});

test("a clean run is not thrown away by the model's own prose in the envelope", () => {
  // The success fixture's `result` text mentions a "Please sign in" UI string.
  assert.match(SUCCESS_STDOUT, /Please sign in/);
  assert.equal(classifyFailure(baseInput()).failureKind, null);
});

test("a soft-deny notice on stderr is infra and sets softDenied", () => {
  const result = classifyFailure(baseInput({ stderr: fixture("stderr-soft-deny.txt") }));
  assert.equal(result.failureKind, "infra");
  assert.equal(result.softDenied, true);
  assert.match(result.reason, /soft-deny/);
});

test("softDenied is reported even when another signal decides the verdict", () => {
  const result = classifyFailure(
    baseInput({ dockerError: true, stderr: fixture("stderr-soft-deny.txt") }),
  );
  assert.equal(result.failureKind, "infra");
  assert.equal(result.softDenied, true);
});

test("an auth error is infra", () => {
  const result = classifyFailure(
    baseInput({ exitCode: 1, stdout: "", envelope: null, stderr: fixture("stderr-auth.txt"), workspaceEmpty: true }),
  );
  assert.equal(result.failureKind, "infra");
  assert.equal(result.reason, "auth error");
  assert.equal(result.rateLimited, false);
});

test("a rate limit is infra and asks for the single retry", () => {
  const result = classifyFailure(
    baseInput({
      exitCode: 1,
      stdout: "",
      envelope: null,
      stderr: fixture("stderr-rate-limit.txt"),
      workspaceEmpty: true,
    }),
  );
  assert.equal(result.failureKind, "infra");
  assert.equal(result.rateLimited, true);
  assert.match(result.reason, /quota \/ rate limit/);
});

test("a provider overload is infra and asks for the single retry, not a model zero", () => {
  // agy exits 1 with an ERROR envelope whose only signal is the provider's own
  // capacity message. Without SERVICE_OVERLOAD_RES this falls through to the
  // `exitCode !== 0` fallback and is recorded as a `model` failure worth 0.
  const stdout = fixture("envelope-service-overload.json");
  const result = classifyFailure(
    baseInput({
      exitCode: 1,
      stdout,
      envelope: parseEnvelope(stdout),
      workspaceEmpty: true,
    }),
  );
  assert.equal(result.failureKind, "infra");
  assert.equal(result.rateLimited, true);
  assert.match(result.reason, /overloaded or unavailable/);
});

test("agy losing its connection to the server is infra that stops the matrix, not a model zero", () => {
  // agy loses its connection late in a run with a finished app in the
  // workspace and exits 0 with this ERROR envelope; the fallback would record
  // it as a `model` failure worth 0.
  const stdout = fixture("envelope-network-issue.json");
  const result = classifyFailure(
    baseInput({ exitCode: 0, stdout, envelope: parseEnvelope(stdout), workspaceEmpty: false }),
  );
  assert.equal(result.failureKind, "infra");
  // Not the one-minute retry: a dropped network is for the operator to check,
  // and the resume rule re-runs the attempt once the matrix is restarted.
  assert.equal(result.rateLimited, false);
  assert.match(result.reason, /network/);
});

test("network-loss phrasings are infra; a model writing about networks in its response is not", () => {
  for (const message of [
    "There was a network issue connecting to the server, please try again.",
    "error: network error connecting to the server",
  ]) {
    const result = classifyFailure(
      baseInput({ exitCode: 1, stdout: "", envelope: null, stderr: message, workspaceEmpty: true }),
    );
    assert.equal(result.failureKind, "infra", message);
  }
  // Only stderr and the envelope's status and error are scanned, never its response.
  const stdout = JSON.stringify({
    status: "ERROR",
    num_turns: 1,
    duration_seconds: 10,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, thinking_tokens: 0, total_tokens: 2 },
    conversation_id: "x",
    error: "agy crashed",
    response: "I added retry logic for a network issue connecting to the server.",
  });
  const modelCrash = classifyFailure(
    baseInput({ exitCode: 1, stdout, envelope: parseEnvelope(stdout), workspaceEmpty: false }),
  );
  assert.equal(modelCrash.failureKind, "model");
});

test("provider-overload phrasings are all infra, and a plain model crash still is not", () => {
  const overloaded = [
    "Our servers are experiencing high traffic right now, please try again in a minute.",
    "The service is temporarily unavailable.",
    "upstream returned HTTP 503",
    "overloaded_error: the model is overloaded",
    "Our servers are overloaded.",
  ];
  for (const message of overloaded) {
    const result = classifyFailure(
      baseInput({ exitCode: 1, stdout: "", envelope: null, stderr: message, workspaceEmpty: true }),
    );
    assert.equal(result.failureKind, "infra", message);
    assert.equal(result.rateLimited, true, message);
  }

  const modelFailure = classifyFailure(
    baseInput({
      exitCode: 1,
      stdout: "",
      envelope: null,
      stderr: "TypeError: Cannot read properties of undefined",
      workspaceEmpty: true,
    }),
  );
  assert.equal(modelFailure.failureKind, "model");
  assert.equal(modelFailure.rateLimited, false);
});

test("an unresolved --model is infra", () => {
  const result = classifyFailure(
    baseInput({
      exitCode: 1,
      stdout: "",
      envelope: null,
      stderr: "Error: unknown model \"TODO-cli-id\"\n",
      workspaceEmpty: true,
    }),
  );
  assert.equal(result.failureKind, "infra");
  assert.match(result.reason, /could not resolve --model/);
});

test("a docker failure is infra, by flag or by exit code", () => {
  assert.equal(classifyFailure(baseInput({ dockerError: true })).failureKind, "infra");
  for (const exitCode of [125, 126, 127]) {
    const result = classifyFailure(
      baseInput({
        exitCode,
        stdout: "",
        envelope: null,
        stderr: "docker: Error response from daemon: no such image\n",
        workspaceEmpty: true,
      }),
    );
    assert.equal(result.failureKind, "infra", `exit ${exitCode}`);
    assert.match(result.reason, /docker error/);
  }
});

test("a run-attempt contract error is infra, not a model zero", () => {
  for (const exitCode of [2, 3, 5]) {
    const result = classifyFailure(
      baseInput({
        exitCode,
        stdout: "",
        envelope: null,
        stderr: "prompt not readable: /prompt.md\n",
        workspaceEmpty: true,
      }),
    );
    assert.equal(result.failureKind, "infra", `exit ${exitCode}`);
    assert.match(result.reason, /harness contract error/);
  }
});

test("a container that could not be confirmed removed is infra, and outranks the timeout", () => {
  // The outer timeout on its own is a model failure and a data point. A
  // container the daemon would not confirm gone is not about this attempt at
  // all: it says the *next* one would run alongside a live agy session on the
  // same OAuth token and the same weekly quota, which is the one thing the
  // sequential design forbids — so it stops the matrix instead.
  const result = classifyFailure(
    baseInput({
      exitCode: null,
      outerTimeout: true,
      containerOrphaned: true,
      stdout: "",
      envelope: null,
      workspaceEmpty: false,
    }),
  );
  assert.equal(result.failureKind, "infra");
  assert.match(result.reason, /could not be confirmed removed/);
});

test("an agy timeout is a model failure", () => {
  const result = classifyFailure(
    baseInput({ exitCode: 1, stdout: TIMEOUT_STDOUT, envelope: parseEnvelope(TIMEOUT_STDOUT) }),
  );
  assert.equal(result.failureKind, "model");
  assert.equal(result.reason, "agy timeout");
});

test("the outer docker timeout is a model failure", () => {
  const result = classifyFailure(baseInput({ exitCode: null, outerTimeout: true, stdout: "", envelope: null }));
  assert.equal(result.failureKind, "model");
  assert.match(result.reason, /outer docker timeout/);
});

test("a non-zero exit after a real run is a model failure", () => {
  const result = classifyFailure(
    baseInput({ exitCode: 1, stdout: "", envelope: null, stderr: "panic: nil map write\n" }),
  );
  assert.equal(result.failureKind, "model");
  assert.equal(result.reason, "agy exited 1");
});

test("a kill by signal is a model failure", () => {
  const result = classifyFailure(baseInput({ exitCode: null, stdout: "", envelope: null, stderr: "" }));
  assert.equal(result.failureKind, "model");
  assert.match(result.reason, /killed by a signal/);
});

test("an empty workspace after a clean exit is a model failure", () => {
  const result = classifyFailure(baseInput({ workspaceEmpty: true }));
  assert.equal(result.failureKind, "model");
  assert.match(result.reason, /workspace is empty/);
});

test("exit 0 with unparsed stdout but real output is still a data point", () => {
  const result = classifyFailure(baseInput({ stdout: "", envelope: null, stderr: "" }));
  assert.equal(result.failureKind, null);
});

test("a killed run's partial stdout is not scanned for infra signals", () => {
  // stdout here is a truncated dump of the model's own prose: a generated login
  // page and a paragraph about rate limits. With no envelope to displace it, an
  // unguarded haystack would call this infra and stop the whole matrix.
  const partialProse =
    '{"status":"SUCCESS","response":"Login screen: \\"Please sign in\\", plus a note on the API rate limit (429';

  const killedByOuterTimeout = classifyFailure(
    baseInput({
      exitCode: null,
      outerTimeout: true,
      stdout: partialProse,
      envelope: null,
      stderr: "",
      workspaceEmpty: false,
    }),
  );
  assert.equal(killedByOuterTimeout.failureKind, "model");
  assert.match(killedByOuterTimeout.reason, /outer docker timeout/);

  const killedBySignal = classifyFailure(
    baseInput({ exitCode: null, stdout: partialProse, envelope: null, stderr: "", workspaceEmpty: false }),
  );
  assert.equal(killedBySignal.failureKind, "model");
  assert.match(killedBySignal.reason, /killed by a signal/);
});

test("stderr stays trusted on a killed run", () => {
  // The channel narrowing must not blind the runner to agy's own diagnostics.
  const result = classifyFailure(
    baseInput({
      exitCode: null,
      outerTimeout: true,
      stdout: "",
      envelope: null,
      stderr: fixture("stderr-rate-limit.txt"),
      workspaceEmpty: true,
    }),
  );
  assert.equal(result.failureKind, "infra");
  assert.equal(result.rateLimited, true);
});

test("an exited run with no envelope still has its stdout scanned", () => {
  // agy crashed before emitting an envelope: stdout is the only signal left.
  const result = classifyFailure(
    baseInput({
      exitCode: 1,
      stdout: "Error: unknown model \"TODO-cli-id\"\n",
      envelope: null,
      stderr: "",
      workspaceEmpty: true,
    }),
  );
  assert.equal(result.failureKind, "infra");
  assert.match(result.reason, /could not resolve --model/);
});

test("infra beats model: an auth failure that also left an empty workspace is infra", () => {
  const result = classifyFailure(
    baseInput({
      exitCode: 1,
      stdout: "",
      envelope: null,
      stderr: fixture("stderr-auth.txt"),
      workspaceEmpty: true,
      outerTimeout: true,
    }),
  );
  assert.equal(result.failureKind, "infra");
  assert.equal(result.reason, "auth error");
});

test("parseUsageRows reads the per-model table agy 1.1.26 actually prints", () => {
  const rows = parseUsageRows(fixture("usage-remaining.txt"));
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0], {
    pool: "All Models",
    label: "Gemini 3.8 Flash (High)",
    percent: 94,
    resetsAt: "2030-03-04T09:20:11Z",
  });
  // Quota is per model, not one number: these buckets differ, and they reset at
  // different times on the same account.
  assert.deepEqual(
    rows.map((row) => row.percent),
    [94, 94, 100, 81],
  );
});

test("parseUsageRemaining without a label takes the lowest bucket", () => {
  assert.equal(parseUsageRemaining(fixture("usage-remaining.txt")), 81);
});

test("parseUsageRemaining with a label reads that model's own bucket", () => {
  const usage = fixture("usage-remaining.txt");
  assert.equal(parseUsageRemaining(usage, "Gemini 3.1 Pro (High)"), 100);
  assert.equal(parseUsageRemaining(usage, "gemini 3.8 flash (high)"), 94);
  // A label agy did not print is not silently the minimum — it is unknown.
  assert.equal(parseUsageRemaining(usage, "Gemini 9.9 Flash (High)"), null);
});

test("parseUsageRemaining returns null when it recognises nothing", () => {
  assert.equal(parseUsageRemaining(""), null);
  // What an unauthenticated quota gate actually prints.
  assert.equal(parseUsageRemaining(fixture("usage-unparseable.txt")), null);
  assert.equal(parseUsageRemaining("All Models\tGemini 3.8 Flash (High)\tplenty"), null);
  // A bare number with no percent sign is not a reading in this format.
  assert.equal(parseUsageRemaining("remaining\t42"), null);
});

test("a null quotaFloor logs and proceeds", () => {
  const check = checkQuotaFloor(fixture("usage-remaining.txt"), null);
  assert.equal(check.ok, true);
  assert.equal(check.remaining, 81);
  assert.match(check.reason, /not enforced/);
});

test("a numeric quotaFloor stops the matrix below it and passes above it", () => {
  const usage = fixture("usage-remaining.txt");
  assert.equal(checkQuotaFloor(usage, 20).ok, true);
  assert.equal(checkQuotaFloor(usage, 81).ok, true);
  const stopped = checkQuotaFloor(usage, 90);
  assert.equal(stopped.ok, false);
  assert.match(stopped.reason, /below quotaFloor 90/);
});

test("a labelled quotaFloor reads that model's bucket, not the lowest one", () => {
  const usage = fixture("usage-remaining.txt");
  // The lowest bucket is Claude Opus at 81; Gemini 3.1 Pro (High) still has 100.
  const pro = checkQuotaFloor(usage, 90, "Gemini 3.1 Pro (High)");
  assert.equal(pro.ok, true);
  assert.equal(pro.remaining, 100);
  const opus = checkQuotaFloor(usage, 90, "Claude Opus 4.6 (Thinking)");
  assert.equal(opus.ok, false);
  assert.equal(opus.remaining, 81);
});

test("a labelled quotaFloor whose label is not in /usage stops and names the labels it saw", () => {
  const check = checkQuotaFloor(fixture("usage-remaining.txt"), 10, "Claude Sonnet 4.6 (Thinking)");
  assert.equal(check.ok, false);
  assert.equal(check.remaining, null);
  assert.match(check.reason, /no \/usage row is labelled "Claude Sonnet 4\.6 \(Thinking\)"/);
  assert.match(check.reason, /"Gemini 3\.1 Pro \(High\)"/);
});

test("a numeric quotaFloor against unreadable /usage output stops rather than guesses", () => {
  const check = checkQuotaFloor(fixture("usage-unparseable.txt"), 20);
  assert.equal(check.ok, false);
  assert.equal(check.remaining, null);
  assert.match(check.reason, /parseUsageRemaining/);
});

test("an ERROR envelope on a zero exit is a model failure, not a clean run", () => {
  // agy can exit 0 with status ERROR and its own message: "Your previous response
  // was cut off because it exceeded the output token limit". With a full
  // workspace, `workspaceEmpty` does not catch it; none of the infra detectors
  // match that text; so the function would fall through to its final `success`.
  // A run agy itself calls ERROR must never be recorded as a clean data point.
  const result = classifyFailure(
    baseInput({
      exitCode: 0,
      envelope: {
        status: "ERROR",
        num_turns: 1,
        duration_seconds: 1120.0,
        usage: null,
        conversation_id: "c",
        error: "Your previous response was cut off because it exceeded the output token limit",
        responseTail: null,
      },
      workspaceEmpty: false,
    }),
  );
  assert.equal(result.failureKind, "model");
  assert.match(result.reason, /ERROR/);
});

// --- truncation-recovery detector -------------------------------------------

test("a truncated response that agy recovered from is a data point, not a model failure", () => {
  // agy exits 0 with ERROR and "exceeded the output token limit … Retries
  // remaining: 3", but the model continues after the retry and finishes the
  // app, so the workspace holds a complete result. That is scored normally.
  const result = classifyFailure(
    baseInput({
      exitCode: 0,
      stdout: OUTPUT_TOKEN_LIMIT_STDOUT,
      envelope: parseEnvelope(OUTPUT_TOKEN_LIMIT_STDOUT),
      workspaceEmpty: false,
    }),
  );
  assert.equal(result.failureKind, null);
  assert.match(result.reason, /truncated response it recovered from/);
});

test("a truncated response with an empty workspace is still a model failure", () => {
  const result = classifyFailure(
    baseInput({
      exitCode: 0,
      stdout: OUTPUT_TOKEN_LIMIT_STDOUT,
      envelope: parseEnvelope(OUTPUT_TOKEN_LIMIT_STDOUT),
      workspaceEmpty: true,
    }),
  );
  assert.equal(result.failureKind, "model");
  assert.match(result.reason, /workspace is empty/);
});

test("Retries remaining: 0 means every retry was spent — still a model failure", () => {
  const result = classifyFailure(
    baseInput({
      exitCode: 0,
      envelope: {
        status: "ERROR",
        num_turns: 1,
        duration_seconds: 1800,
        usage: null,
        conversation_id: "x",
        error:
          "Your previous response was cut off because it exceeded the output token limit\n" +
          "Please continue from where you left off, keeping your response shorter\n" +
          "Retries remaining: 0",
        responseTail: null,
      },
      workspaceEmpty: false,
    }),
  );
  assert.equal(result.failureKind, "model");
  assert.match(result.reason, /ERROR/);
});

test("a model writing about 'output token limit' in its response (not the error) does not trigger recovery", () => {
  // The envelope's status is SUCCESS, and the model's own prose in `response`
  // mentions the output token limit. detectTruncationRecovered must not fire
  // because it only reads envelope.error, not response.
  const stdout = JSON.stringify({
    status: "SUCCESS",
    num_turns: 1,
    duration_seconds: 600,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, thinking_tokens: 0, total_tokens: 2 },
    conversation_id: "y",
    error: "",
    response:
      "I added retry logic for when the output token limit is exceeded. Retries remaining: 3 will be shown.",
  });
  assert.equal(detectTruncationRecovered(parseEnvelope(stdout)), false);
  const result = classifyFailure(
    baseInput({ exitCode: 0, stdout, envelope: parseEnvelope(stdout), workspaceEmpty: false }),
  );
  // Should be a clean success — the model didn't fail.
  assert.equal(result.failureKind, null);
  assert.equal(result.reason, "success");
});
