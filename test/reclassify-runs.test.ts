import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { main } from "../scripts/reclassify-runs";

const FIXTURES = new URL("./fixtures/", import.meta.url);

function fixture(name: string): string {
  return readFileSync(new URL(name, FIXTURES), "utf8");
}

/**
 * Build a minimal track root in tmp: one attempt with the output-token-limit
 * envelope, a non-empty eval-attempts workspace, and a runner YAML with a
 * timeoutMs large enough that the attempt is not a timeout.
 */
function makeTmpRoot(): { root: string; runJsonPath: string; dirs: string[] } {
  const root = join(tmpdir(), `reclassify-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const attemptName = "test-model-high-attempt-1";

  // eval-results/<attempt>/run.json — a model failure with the token-limit envelope
  const resultsDir = join(root, "eval-results", attemptName);
  mkdirSync(resultsDir, { recursive: true });

  const envelope = JSON.parse(fixture("envelope-output-token-limit.json"));
  const runJson = {
    id: "test-model-high",
    model: "test-model",
    effort: "high",
    agyVersion: "1.2.7",
    image: "test:latest@sha256:abc",
    startedAt: "2026-10-08T12:00:00.000Z",
    durationMs: 1600000,
    exitCode: 0,
    envelope,
    stderrTail: "",
    softDenied: false,
    failureKind: "model",
  };
  const runJsonPath = join(resultsDir, "run.json");
  writeFileSync(runJsonPath, JSON.stringify(runJson, null, 2) + "\n");

  // eval-attempts/<attempt>/ — non-empty workspace (one file)
  const attemptDir = join(root, "eval-attempts", attemptName);
  mkdirSync(attemptDir, { recursive: true });
  writeFileSync(join(attemptDir, "main.py"), "print('hello')\n");

  // benchmark/runner.yaml with a timeoutMs
  const benchmarkDir = join(root, "benchmark");
  mkdirSync(benchmarkDir, { recursive: true });
  writeFileSync(join(benchmarkDir, "runner.yaml"), "timeoutMs: 2820000\n");

  return { root, runJsonPath, dirs: [root] };
}

test("reclassify dry-run does not modify run.json", () => {
  const { root, runJsonPath } = makeTmpRoot();
  const before = readFileSync(runJsonPath, "utf8");

  const exit = main(["--root", root]);
  assert.equal(exit, 0);

  const after = readFileSync(runJsonPath, "utf8");
  assert.equal(after, before, "dry-run must not change the file");
});

test("reclassify --write sets failureKind null and reclassified.from model", () => {
  const { root, runJsonPath } = makeTmpRoot();

  const exit = main(["--root", root, "--write"]);
  assert.equal(exit, 0);

  const written = JSON.parse(readFileSync(runJsonPath, "utf8"));
  assert.equal(written.failureKind, null);
  assert.ok(written.reclassified, "reclassified field must be present");
  assert.equal(written.reclassified.from, "model");
  assert.equal(typeof written.reclassified.at, "string");
  assert.match(written.reclassified.reason, /truncated response/);
});

test("reclassify without a runner yaml exits 1", () => {
  const root = join(tmpdir(), `reclassify-no-yaml-${Date.now()}`);
  const resultsDir = join(root, "eval-results", "x-attempt-1");
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(join(resultsDir, "run.json"), "{}");
  // No benchmark/runner.yaml

  const exit = main(["--root", root]);
  assert.equal(exit, 1);
});
