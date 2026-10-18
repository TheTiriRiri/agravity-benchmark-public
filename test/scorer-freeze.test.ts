/**
 * The scorer freeze (`scripts/lib/scorer-freeze.ts`): the hard and brownfield
 * scoring code that no rubric id covers is held to a recorded fingerprint, and
 * the Playwright the hard E2E runs on to the versions it was scored with.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { BROWNFIELD_RUBRIC_ID_INPUTS } from "../scripts/lib/brownfield-rubric";
import { HARD_RUBRIC_ID_INPUTS } from "../scripts/lib/hard-rubric";
import {
  BROWNFIELD_SCORER_FINGERPRINT,
  BROWNFIELD_SCORER_INPUTS,
  HARD_E2E_PINS,
  HARD_SCORER_FINGERPRINT,
  HARD_SCORER_INPUTS,
  brownfieldScorerFingerprint,
  hardScorerFingerprint,
  installedE2EPinMismatches,
} from "../scripts/lib/scorer-freeze";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function redMessage(track: string, inputs: readonly string[], idInputs: string, recorded: string, computed: string): string {
  return (
    `the ${track} scorer (${inputs.join(", ")}) hashes to ${computed}, but scripts/lib/scorer-freeze.ts records ${recorded}. ` +
    "A file that scores rows changed outside the rubric id. Either (i) the scoring rule changed: give the track a new " +
    `rubric id (fold the file into ${idInputs} and drop it from this list) and re-score its attempts; or (ii) it is a refactor that provably ` +
    "leaves every row as it was: record the new fingerprint and say in the commit message why no row can change."
  );
}

test("the hard scorer matches its recorded fingerprint", () => {
  const computed = hardScorerFingerprint(ROOT);
  assert.equal(
    computed,
    HARD_SCORER_FINGERPRINT,
    redMessage("hard", HARD_SCORER_INPUTS, "HARD_RUBRIC_ID_INPUTS", HARD_SCORER_FINGERPRINT, computed),
  );
});

test("the brownfield scorer matches its recorded fingerprint", () => {
  const computed = brownfieldScorerFingerprint(ROOT);
  assert.equal(
    computed,
    BROWNFIELD_SCORER_FINGERPRINT,
    redMessage("brownfield", BROWNFIELD_SCORER_INPUTS, "BROWNFIELD_RUBRIC_ID_INPUTS", BROWNFIELD_SCORER_FINGERPRINT, computed),
  );
});

test("every scorer input exists", () => {
  for (const input of [...HARD_SCORER_INPUTS, ...BROWNFIELD_SCORER_INPUTS]) {
    assert.ok(existsSync(join(ROOT, input)), `${input} is missing`);
  }
});

test("no scorer input is already covered by its own track's rubric id", () => {
  assert.deepEqual(HARD_SCORER_INPUTS.filter((input) => HARD_RUBRIC_ID_INPUTS.includes(input)), []);
  assert.deepEqual(BROWNFIELD_SCORER_INPUTS.filter((input) => BROWNFIELD_RUBRIC_ID_INPUTS.includes(input)), []);
});

test("the root lockfile holds the Playwright and axe versions the hard E2E was scored on", () => {
  const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8")) as {
    packages: Record<string, { version?: string }>;
  };
  for (const [name, version] of Object.entries(HARD_E2E_PINS)) {
    assert.equal(
      lock.packages[`node_modules/${name}`]?.version,
      version,
      `package-lock.json resolves ${name} to another version than the hard E2E was scored on (${version}): ` +
        "its verdicts may change. Re-score the hard track on the new version, or keep the lock.",
    );
  }
});

test("this checkout's node_modules holds the pinned Playwright and axe", () => {
  assert.deepEqual(installedE2EPinMismatches(ROOT), []);
});

test("installedE2EPinMismatches names a package installed at another version and one not installed", () => {
  const root = mkdtempSync(join(tmpdir(), "scorer-freeze-"));
  try {
    for (const [name, version] of Object.entries(HARD_E2E_PINS)) {
      if (name === "axe-core") continue;
      mkdirSync(join(root, "node_modules", name), { recursive: true });
      const installed = name === "playwright-core" ? "1.99.0" : version;
      writeFileSync(join(root, "node_modules", name, "package.json"), JSON.stringify({ name, version: installed }));
    }
    assert.deepEqual(installedE2EPinMismatches(root), [
      `playwright-core: installed 1.99.0 (pinned ${HARD_E2E_PINS["playwright-core"]})`,
      `axe-core: not installed (pinned ${HARD_E2E_PINS["axe-core"]})`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("score-hard never lets npx fetch a Playwright from the registry", () => {
  const source = readFileSync(join(ROOT, "scripts", "score-hard.ts"), "utf8");
  assert.match(source, /runProcess\("npx", \["--no-install", "playwright", "test"/);
  assert.doesNotMatch(source, /\("npx", \["playwright"/);
});
