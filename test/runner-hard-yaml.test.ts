/**
 * Tests for benchmark/runner-hard.yaml schema.
 *
 * Validates that the hard-track runner configuration mirrors the classic runner's
 * schema but differs in rubric, timeout, and printTimeout.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { load as loadYaml } from "js-yaml";
import { loadRunnerConfig, type RunnerConfig } from "../scripts/lib/runner-config";

const ROOT = join(import.meta.dirname!, "..");
const HARD_RUNNER_PATH = join(ROOT, "benchmark", "runner-hard.yaml");
const CLASSIC_RUNNER_PATH = join(ROOT, "benchmark", "runner.yaml");

/** Known sha256 of the classic runner.yaml — ensures it's unchanged. */
const CLASSIC_RUNNER_SHA256 = "d4d2b98664b07108a4735a57b09e0a4e3e18d5c2dd48c4ad268ba8e3d00df7bf";

/**
 * Classic rows the hard runner does not mirror: Gemini 3.8 Flash (Medium) came
 * back on 2026-10-16 on the classic runner only, by operator decision.
 */
const CLASSIC_ONLY_MODELS = new Set(["gemini-3.8-flash-medium"]);

function loadHard(): RunnerConfig {
  return loadRunnerConfig(HARD_RUNNER_PATH, { allowPlaceholders: true });
}
function loadClassic(): RunnerConfig {
  return loadRunnerConfig(CLASSIC_RUNNER_PATH, { allowPlaceholders: true });
}
/** The classic matrix less its classic-only rows: what the hard matrix mirrors. */
function sharedClassicRows(): RunnerConfig["matrix"] {
  return loadClassic().matrix.filter((row) => !CLASSIC_ONLY_MODELS.has(row.model));
}

describe("runner-hard.yaml", () => {
  it("file exists at benchmark/runner-hard.yaml", () => {
    assert.ok(existsSync(HARD_RUNNER_PATH), "benchmark/runner-hard.yaml must exist");
  });

  it("rubric equals maintenance-console-hard@a0d3c3d39eb1", () => {
    const hard = loadHard();
    assert.equal(hard.rubric, "maintenance-console-hard@a0d3c3d39eb1");
  });

  it("timeoutMs equals 2820000 (47 min)", () => {
    const hard = loadHard();
    assert.equal(hard.timeoutMs, 2820000);
  });

  it("printTimeout equals '45m'", () => {
    const hard = loadHard();
    assert.equal(hard.printTimeout, "45m");
  });

  it("image matches classic runner (agrav-bench/harness:2026-10-04)", () => {
    const hard = loadHard();
    const classic = loadClassic();
    assert.equal(hard.image, classic.image);
    assert.equal(hard.image, "agrav-bench/harness:2026-10-04");
  });

  it("agyVersion matches classic runner (1.2.7)", () => {
    const hard = loadHard();
    const classic = loadClassic();
    assert.equal(hard.agyVersion, classic.agyVersion);
    assert.equal(hard.agyVersion, "1.2.7");
  });

  it("judge matches classic runner (claude-opus-5-5)", () => {
    const hard = loadHard();
    const classic = loadClassic();
    assert.equal(hard.judge, classic.judge);
    assert.equal(hard.judge, "claude-opus-5-5");
  });

  it("attempts equals 5 (NOT attemptsPerModel)", () => {
    const hard = loadHard();
    assert.equal(hard.attempts, 5);
  });

  it("quotaFloor and the per-row usageLabels match classic runner", () => {
    const hard = loadHard();
    const classic = loadClassic();
    assert.equal(hard.quotaFloor, 10);
    assert.equal(hard.quotaFloor, classic.quotaFloor);
    const labels = (rows: RunnerConfig["matrix"]) => rows.map((e) => [e.model, e.usageLabel]).sort();
    assert.deepEqual(labels(hard.matrix), labels(sharedClassicRows()));
  });

  it("credentialFiles matches classic runner", () => {
    const hard = loadHard();
    const classic = loadClassic();
    assert.deepEqual(hard.credentialFiles, classic.credentialFiles);
  });

  it("matrix is an array of 4 entries with id, model, effort, family — the classic models less its classic-only rows", () => {
    const hard = loadHard();
    const classic = loadClassic();
    for (const model of CLASSIC_ONLY_MODELS) {
      assert.ok(classic.matrix.some((row) => row.model === model), `${model} is listed as classic-only, but the classic runner has no such row`);
    }
    assert.equal(hard.matrix.length, 4, "must have 4 matrix entries");
    for (const entry of hard.matrix) {
      assert.ok("id" in entry, "entry must have id");
      assert.ok("model" in entry, "entry must have model");
      assert.ok("effort" in entry, "entry must have effort");
      assert.ok("family" in entry, "entry must have family");
    }
    // Same models as classic, its classic-only rows aside
    const hardModels = hard.matrix.map((e) => e.model).sort();
    const classicModels = sharedClassicRows().map((e) => e.model).sort();
    assert.deepEqual(hardModels, classicModels);
  });

  it("no unknown/extra fields (no env, docker, artifacts, scoring, output)", () => {
    // Raw parse to check fields — loadRunnerConfig may strip unknowns
    const raw = loadYaml(readFileSync(HARD_RUNNER_PATH, "utf8")) as Record<string, unknown>;
    const allowedKeys = new Set([
      "image", "agyVersion", "judge", "rubric", "timeoutMs", "printTimeout",
      "attempts", "quotaFloor", "credentialFiles", "matrix",
    ]);
    const keys = Object.keys(raw);
    const extra = keys.filter((k) => !allowedKeys.has(k));
    assert.deepEqual(extra, [], `unexpected fields: ${extra.join(", ")}`);
  });

  it("classic benchmark/runner.yaml is unchanged (byte-identical to known hash)", () => {
    const content = readFileSync(CLASSIC_RUNNER_PATH);
    const hash = createHash("sha256").update(content).digest("hex");
    assert.equal(hash, CLASSIC_RUNNER_SHA256, "classic runner.yaml must not change");
  });
});
