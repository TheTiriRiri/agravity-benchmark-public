/**
 * The rubric id pin: `benchmark/runner.yaml`'s `rubric:` must be what
 * `rubricId()` computes from the files it covers. Changing the prompt, the
 * criteria, the scoring skill, the rows, the rounding, a limit, the Notes, the
 * suite runner, a hidden test or the seed without a new id turns this red, so
 * scores from before and after such a change can never share an id.
 *
 * What the id is made of — its format, that every input exists, and that one
 * changed byte in any input changes it — is tested in `test/rubric.test.ts`;
 * this file only ties the computed id to the recorded one.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";

import { RUBRIC_ID_INPUTS, rubricId } from "../scripts/lib/rubric";
import { loadRunnerConfig } from "../scripts/lib/runner-config";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RUNNER_YAML = join(ROOT, "benchmark", "runner.yaml");

/** `rubric:` read straight from the YAML, so neither the hold nor any other key's validation is involved. */
function recordedRubric(): unknown {
  const doc = loadYaml(readFileSync(RUNNER_YAML, "utf8")) as Record<string, unknown>;
  return doc.rubric;
}

test("runner.yaml's rubric is the id its inputs hash to", () => {
  const recorded = recordedRubric();
  assert.equal(typeof recorded, "string", "benchmark/runner.yaml has a rubric: string");
  assert.match(recorded as string, /^maintenance-console@[0-9a-f]{12}$/, "the recorded rubric is a maintenance-console id");
  const computed = rubricId(ROOT);
  assert.equal(
    recorded,
    computed,
    `benchmark/runner.yaml records rubric ${String(recorded)}, but ${RUBRIC_ID_INPUTS.join(", ")} now hash to ${computed}. ` +
      "One of them changed. If the change is meant to change what a score means, set `rubric: " +
      `${computed}\` in the same commit — scores under the old id and the new one are not comparable. If it is not, undo it.`,
  );
});

test("the loader hands run-matrix the same id", () => {
  // run-matrix records config.rubric in every run's log. `allowPlaceholders` is
  // --dry-run's option: it loads a held config without releasing it.
  const config = loadRunnerConfig(RUNNER_YAML, { allowPlaceholders: true });
  assert.equal(config.rubric, recordedRubric());
});

test("the real runner.yaml is not on hold: run-matrix accepts it", () => {
  // Plan 3 released the hold after the gates it named had run. A new hold is a
  // deliberate edit to runner.yaml, and this test is changed with it.
  const config = loadRunnerConfig(RUNNER_YAML);
  assert.equal(config.hold, null);
});

test("the command runner.yaml gives for a new id prints the current one", () => {
  const yaml = readFileSync(RUNNER_YAML, "utf8");
  const command = /^#\s+node --import tsx -e '([^']+)'$/m.exec(yaml);
  assert.ok(command, "runner.yaml's rubric comment shows a `node --import tsx -e '…'` command");
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", command[1]], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, `the command exits 0:\n${result.stderr}`);
  assert.equal(result.stdout.trim(), rubricId(ROOT));
});
