/**
 * `eval-attempts/metadata.ts` — the model catalogue.
 *
 * Most of what can go wrong here is a table that disagrees with another table:
 * an id in `AGENT_NAMES` but not in `MODEL_FAMILY`, a family the dashboard has
 * no name for, or — the one that would quietly invalidate the whole benchmark —
 * a catalogue that no longer matches `benchmark/runner.yaml`, so a config runs
 * and then never appears. These tests are those cross-checks.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  AGENT_ENV,
  AGENT_ENVIRONMENT,
  AGENT_NAMES,
  DISABLED_MODELS,
  FAMILY_NAMES,
  MODEL_FAMILY,
  MODEL_PRICING,
  SUPERSEDED_MODELS,
  getModelBaseId,
  isModelId,
  type ModelId,
} from "../eval-attempts/metadata";
import { BENCHMARK_ID_RE, parseAttemptDirName } from "../scripts/lib/attempts";
import { loadRunnerConfig } from "../scripts/lib/runner-config";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const MATRIX = loadRunnerConfig(join(REPO_ROOT, "benchmark", "runner.yaml"), { allowPlaceholders: true }).matrix;
const IDS = Object.keys(AGENT_NAMES) as ModelId[];

test("every matrix row in benchmark/runner.yaml is in the catalogue", () => {
  // A row missing from the catalogue silently vanishes from the dashboard. The
  // reverse is harmless: the catalogue keeps rows the matrix no longer runs
  // (trimmed to four on 2026-09-13), so re-adding one is a runner.yaml edit.
  for (const row of MATRIX) assert.ok(isModelId(row.id), `${row.id} has no entry in eval-attempts/metadata.ts`);
});

test("every id maps to the family runner.yaml assigns it", () => {
  for (const row of MATRIX) {
    assert.equal(MODEL_FAMILY[row.id as ModelId], row.family, row.id);
  }
});

test("every table is keyed by the same ids", () => {
  for (const table of [AGENT_ENV, MODEL_FAMILY, MODEL_PRICING] as Record<string, unknown>[]) {
    assert.deepEqual(Object.keys(table).sort(), IDS.slice().sort());
  }
});

test("every family has a display name, and no display name is orphaned", () => {
  const families = new Set(Object.values(MODEL_FAMILY));
  assert.deepEqual([...families].sort(), Object.keys(FAMILY_NAMES).sort());
});

test("ids and families survive a directory name", () => {
  for (const id of IDS) {
    assert.match(id, BENCHMARK_ID_RE, id);
    assert.deepEqual(parseAttemptDirName(`${id}-attempt-3`), { modelId: id, attempt: 3 });
  }
  for (const family of Object.values(MODEL_FAMILY)) assert.match(family, BENCHMARK_ID_RE, family);
});

test("every id carries an effort suffix that matches its environment", () => {
  const expected: Record<string, AGENT_ENVIRONMENT> = {
    high: AGENT_ENVIRONMENT.AntigravityHigh,
    med: AGENT_ENVIRONMENT.AntigravityMedium,
    low: AGENT_ENVIRONMENT.AntigravityLow,
  };
  for (const id of IDS) {
    const suffix = id.slice(id.lastIndexOf("-") + 1);
    assert.ok(suffix in expected, `${id} has no -high/-med/-low suffix`);
    assert.equal(AGENT_ENV[id], expected[suffix], id);
  }
});

test("the display name says which effort level it is", () => {
  assert.equal(AGENT_NAMES["gemini-38-flash-high"], "Gemini 3.8 Flash (High)");
  assert.equal(AGENT_NAMES["gemini-38-flash-med"], "Gemini 3.8 Flash (Medium)");
  assert.equal(AGENT_NAMES["gemini-38-flash-low"], "Gemini 3.8 Flash (Low)");
  // The three effort levels are one family, which is the point of the matrix.
  assert.equal(new Set([...IDS].map((id) => MODEL_FAMILY[id])).size, 6);
});

test("a price is either defensible or absent — never a rounded guess", () => {
  for (const id of IDS) {
    const pricing = MODEL_PRICING[id];
    if (pricing === null) continue;
    assert.ok(pricing.input > 0, `${id} input`);
    assert.ok(pricing.output > 0, `${id} output`);
    // Cache reads are never dearer than fresh input; where no cache-read rate
    // is published the input rate stands in.
    assert.ok(pricing.cacheRead > 0 && pricing.cacheRead <= pricing.input, `${id} cacheRead`);
  }
  // The models without a public list price, called out in the report and in the
  // constant's own comment. A price appearing here later is fine; a price
  // appearing without a source is not. 3.8 and 3.7 Flash are newer than any
  // list this repo can cite — the priced 3.5 Flash left agy's catalogue before
  // Phase 0 ever ran.
  assert.deepEqual(
    IDS.filter((id) => MODEL_PRICING[id] === null),
    [
      "gemini-38-flash-high",
      "gemini-38-flash-med",
      "gemini-38-flash-low",
      "gemini-37-flash-high",
      "gpt-oss-120b-med",
    ],
  );
  // Every effort level of one model prices identically — it is one model. The
  // family rows in results.json take their price from whichever member sorted
  // first, so a disagreement here would make that row depend on the scores.
  for (const family of new Set(Object.values(MODEL_FAMILY))) {
    const members = IDS.filter((id) => MODEL_FAMILY[id] === family);
    for (const member of members) assert.deepEqual(MODEL_PRICING[member], MODEL_PRICING[members[0]], member);
  }
});

test("ModelPricing has exactly the three rates the cost formula uses (Ruling R10)", () => {
  // A fourth rate here — a reasoning rate, say — would mean the formula in
  // `imputedCost` has a term it is not applying. Adding one is fine; adding one
  // without wiring it in is not, and this is where that shows up.
  for (const id of IDS) {
    const pricing = MODEL_PRICING[id];
    if (pricing === null) continue;
    assert.deepEqual(Object.keys(pricing).sort(), ["cacheRead", "input", "output"], id);
  }
});

test("SUPERSEDED_MODELS and DISABLED_MODELS ship empty", () => {
  assert.deepEqual(SUPERSEDED_MODELS, {});
  assert.equal(DISABLED_MODELS.size, 0);
});

test("isModelId accepts the catalogue and nothing else", () => {
  for (const id of IDS) assert.equal(isModelId(id), true, id);
  for (const other of ["gemini-38-flash", "gemini-38-flash-high-attempt-1", "", "Gemini 3.8 Flash"]) {
    assert.equal(isModelId(other), false, other);
  }
});

test("getModelBaseId strips the attempt suffix and agrees with the shared parser", () => {
  assert.equal(getModelBaseId("claude-opus-46-high-attempt-3"), "claude-opus-46-high");
  assert.equal(getModelBaseId("claude-opus-46-high"), "claude-opus-46-high");
  for (const id of IDS) {
    const dirName = `${id}-attempt-12`;
    assert.equal(getModelBaseId(dirName), parseAttemptDirName(dirName)!.modelId, dirName);
  }
});
