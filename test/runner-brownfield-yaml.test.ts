/**
 * Tests for tracks/brownfield/benchmark/runner.yaml schema.
 *
 * Validates that the brownfield runner configuration mirrors the classic runner's
 * schema with appropriate rubric and timeouts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import { loadRunnerConfig, type RunnerConfig } from "../scripts/lib/runner-config";
import { brownfieldRubricId } from "../scripts/lib/brownfield-rubric";

const ROOT = join(import.meta.dirname!, "..");
const BROWNFIELD_RUNNER_PATH = join(ROOT, "tracks", "brownfield", "benchmark", "runner.yaml");
const CLASSIC_RUNNER_PATH = join(ROOT, "benchmark", "runner.yaml");

/**
 * Classic rows the brownfield runner does not mirror: Gemini 3.8 Flash (Medium)
 * came back on 2026-10-16 on the classic runner only, by operator decision.
 */
const CLASSIC_ONLY_MODELS = new Set(["gemini-3.8-flash-medium"]);

function loadBrownfield(): RunnerConfig {
  return loadRunnerConfig(BROWNFIELD_RUNNER_PATH, { allowPlaceholders: true });
}
function loadClassic(): RunnerConfig {
  return loadRunnerConfig(CLASSIC_RUNNER_PATH, { allowPlaceholders: true });
}
/** The classic matrix less its classic-only rows: what the brownfield matrix mirrors. */
function sharedClassicRows(): RunnerConfig["matrix"] {
  return loadClassic().matrix.filter((row) => !CLASSIC_ONLY_MODELS.has(row.model));
}

describe("runner.yaml (brownfield)", () => {
  it("file exists at tracks/brownfield/benchmark/runner.yaml", () => {
    assert.ok(existsSync(BROWNFIELD_RUNNER_PATH), "tracks/brownfield/benchmark/runner.yaml must exist");
  });

  it("rubric equals brownfieldRubricId(ROOT)", () => {
    const brownfield = loadBrownfield();
    const expected = brownfieldRubricId(ROOT);
    assert.equal(brownfield.rubric, expected);
  });

  it("timeoutMs equals 1920000", () => {
    const brownfield = loadBrownfield();
    assert.equal(brownfield.timeoutMs, 1920000);
  });

  it("printTimeout equals '30m'", () => {
    const brownfield = loadBrownfield();
    assert.equal(brownfield.printTimeout, "30m");
  });

  it("image matches classic runner (agrav-bench/harness:2026-10-04)", () => {
    const brownfield = loadBrownfield();
    const classic = loadClassic();
    assert.equal(brownfield.image, classic.image);
    assert.equal(brownfield.image, "agrav-bench/harness:2026-10-04");
  });

  it("agyVersion matches classic runner (1.2.7)", () => {
    const brownfield = loadBrownfield();
    const classic = loadClassic();
    assert.equal(brownfield.agyVersion, classic.agyVersion);
    assert.equal(brownfield.agyVersion, "1.2.7");
  });

  // The brownfield judge is recorded on its own: tracks are never compared
  // across rubrics, and brownfield is scored by claude-opus-5-5 from its first attempt.
  it("judge is claude-opus-5-5", () => {
    const brownfield = loadBrownfield();
    assert.equal(brownfield.judge, "claude-opus-5-5");
  });

  it("attempts equals 5", () => {
    const brownfield = loadBrownfield();
    assert.equal(brownfield.attempts, 5);
  });

  it("quotaFloor and the per-row usageLabels match classic runner", () => {
    const brownfield = loadBrownfield();
    const classic = loadClassic();
    assert.equal(brownfield.quotaFloor, 10);
    assert.equal(brownfield.quotaFloor, classic.quotaFloor);
    const labels = (rows: RunnerConfig["matrix"]) => rows.map((e) => [e.model, e.usageLabel]).sort();
    assert.deepEqual(labels(brownfield.matrix), labels(sharedClassicRows()));
  });

  it("credentialFiles matches classic runner", () => {
    const brownfield = loadBrownfield();
    const classic = loadClassic();
    assert.deepEqual(brownfield.credentialFiles, classic.credentialFiles);
  });

  it("matrix is an array of 4 entries with id, model, effort, family — the classic models less its classic-only rows", () => {
    const brownfield = loadBrownfield();
    const classic = loadClassic();
    for (const model of CLASSIC_ONLY_MODELS) {
      assert.ok(classic.matrix.some((row) => row.model === model), `${model} is listed as classic-only, but the classic runner has no such row`);
    }
    assert.equal(brownfield.matrix.length, 4, "must have 4 matrix entries");
    for (const entry of brownfield.matrix) {
      assert.ok("id" in entry, "entry must have id");
      assert.ok("model" in entry, "entry must have model");
      assert.ok("effort" in entry, "entry must have effort");
      assert.ok("family" in entry, "entry must have family");
    }
    const brownfieldModels = brownfield.matrix.map((e) => e.model).sort();
    const classicModels = sharedClassicRows().map((e) => e.model).sort();
    assert.deepEqual(brownfieldModels, classicModels);
  });

  it("no unknown/extra fields", () => {
    const raw = loadYaml(readFileSync(BROWNFIELD_RUNNER_PATH, "utf8")) as Record<string, unknown>;
    const allowedKeys = new Set([
      "image", "agyVersion", "judge", "rubric", "timeoutMs", "printTimeout",
      "attempts", "quotaFloor", "credentialFiles", "matrix",
    ]);
    const keys = Object.keys(raw);
    const extra = keys.filter((k) => !allowedKeys.has(k));
    assert.deepEqual(extra, [], `unexpected fields: ${extra.join(", ")}`);
  });
});
