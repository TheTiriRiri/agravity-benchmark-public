/** The hard reference and its gate record (spec §8.4.5, §8.4.8), checked without starting a backend. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  HARD_GATE_INPUTS,
  HARD_GATE_RESULT_PATH,
  MIN_ORDERS_CHANGED,
  RULE_SWITCHES,
  hardGateFingerprint,
  type HardGateResult,
} from "../scripts/lib/hard-gate-fingerprint";
import { GATE_2_INPUTS, GATE_3_INPUTS, FUZZ_ORACLE_INPUTS } from "../scripts/lib/gate-fingerprint";
import { RUBRIC_ID_INPUTS } from "../scripts/lib/rubric";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HARD = join(ROOT, "test", "fixtures", "reference-backend-hard");
const CLASSIC = join(ROOT, "test", "fixtures", "reference-backend");
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));

function readRecord(): HardGateResult | null {
  try {
    return json(join(ROOT, HARD_GATE_RESULT_PATH));
  } catch {
    return null;
  }
}

test("the hard reference shares the classic venv: its requirements are byte-identical", () => {
  assert.equal(readFileSync(join(HARD, "requirements.txt"), "utf8"), readFileSync(join(CLASSIC, "requirements.txt"), "utf8"));
});

test("every module of the hard reference parses as Python 3.11, the harness's version", () => {
  for (const name of readdirSync(join(HARD, "app")).filter((f) => f.endsWith(".py"))) {
    const done = spawnSync("python3", ["-c", "import ast,sys; ast.parse(open(sys.argv[1]).read(), feature_version=(3, 11))", join(HARD, "app", name)], { encoding: "utf8" });
    assert.equal(done.status, 0, `${name}: ${done.stderr}`);
  }
});

test("the hard reference refuses to boot on a seed without its schema marker (Ruling H13, amended)", () => {
  const done = spawnSync("python3", ["-c", "import app.store"], {
    cwd: HARD,
    env: { ...process.env, REFERENCE_SEED_PATH: join(ROOT, "benchmark", "context", "seed.json"), PYTHONDONTWRITEBYTECODE: "1" },
    encoding: "utf8",
  });
  assert.notEqual(done.status, 0, "the classic seed booted the hard reference");
  assert.match(done.stderr, /expected 'console-hard\/1'/);
});

test("hard mutants, classic mutants and rule switches are three disjoint sets of names", () => {
  const hard = Object.keys(json(join(HARD, "mutants.json")));
  const classic = Object.keys(json(join(CLASSIC, "mutants.json")));
  const all = [...hard, ...classic, ...RULE_SWITCHES];
  assert.equal(new Set(all).size, all.length);
  assert.ok(RULE_SWITCHES.every((name) => name.startsWith("off_")));
});

test("the hard gate shares exactly three read-only inputs with the classic gates and the rubric id (spec §8.4.8, H1)", () => {
  const classic = [...GATE_2_INPUTS, ...GATE_3_INPUTS, ...FUZZ_ORACLE_INPUTS, ...RUBRIC_ID_INPUTS].map((p) => p.split("\\").join("/"));
  const shared = HARD_GATE_INPUTS.map((p) => p.split("\\").join("/"))
    .filter((input) => classic.some((c) => input === c || input.startsWith(`${c}/`) || c.startsWith(`${input}/`)));
  // Read, never edited by the hard track. Editing one also moves gate 2; contract-suite.ts moves gate 3a and the
  // rubric id too, and mutants.json moves P2-B's oracle.
  assert.deepEqual(shared.sort(), ["scripts/lib/contract-suite.ts", "scripts/lib/reference-server.ts", "test/fixtures/reference-backend/mutants.json"]);
});

test("the hard gate was run against the hard reference, seed and suite as they are now", (t) => {
  const record = readRecord();
  if (record === null) {
    t.todo("the hard gate has not been recorded; run `npm run gate:hard-reference`");
    return;
  }
  assert.equal(hardGateFingerprint(ROOT), record.fingerprint, "a hard-gate input changed; run `npm run gate:hard-reference` and commit its record");
});

test("the recorded hard gate covered every file, every mutant and every switch, and each switch bit", (t) => {
  const record = readRecord();
  if (record === null) {
    t.todo("the hard gate has not been recorded; run `npm run gate:hard-reference`");
    return;
  }
  const manifest = json(join(ROOT, "tracks", "console-hard", "benchmark", "contract-tests", "manifest.json"));
  assert.deepEqual(record.tests, Object.fromEntries(manifest.files.map((f: { file: string; tests: number }) => [f.file, f.tests])));
  assert.deepEqual(record.classicMutants, Object.keys(json(join(CLASSIC, "mutants.json"))));
  assert.deepEqual(record.hardMutants, Object.keys(json(join(HARD, "mutants.json"))));
  assert.deepEqual(Object.keys(record.switches), [...RULE_SWITCHES]);
  for (const [name, count] of Object.entries(record.switches)) assert.ok(count >= MIN_ORDERS_CHANGED, `${name} changed ${count}`);
  assert.ok(record.travelCapBites >= 1);
});
