import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { FINGERPRINT_IGNORED, GATE_2_INPUTS, GATE_RESULT_PATH, fingerprintOf, gateFingerprint } from "../scripts/lib/gate-fingerprint";
import { HIDDEN_ROWS, LIMITS, RUBRIC_ID_INPUTS, RUBRIC_MAX, RUBRIC_ROWS, roundScore, rubricId } from "../scripts/lib/rubric";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch: string[] = [];

after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agrav-rubric-test-"));
  scratch.push(dir);
  return dir;
}

function filesUnder(path: string): string[] {
  if (statSync(path).isFile()) return [path];
  return readdirSync(path)
    .filter((name) => !FINGERPRINT_IGNORED.has(name))
    .flatMap((name) => filesUnder(join(path, name)));
}

/** A temp root holding a copy of every rubric-id input, and nothing else. */
function copyOfInputs(): string {
  const root = tempDir();
  for (const input of RUBRIC_ID_INPUTS) {
    mkdirSync(dirname(join(root, input)), { recursive: true });
    cpSync(join(ROOT, input), join(root, input), { recursive: true });
  }
  return root;
}

function flipLastByte(path: string): void {
  const bytes = readFileSync(path);
  bytes[bytes.length - 1] ^= 1;
  writeFileSync(path, bytes);
}

// --- rows -----------------------------------------------------------------------

test("RUBRIC_ROWS is spec §4's 14 rows, in order, with their maxima and scorers", () => {
  assert.deepEqual(
    RUBRIC_ROWS.map((r) => [r.name, r.max, r.scoredBy]),
    [
      ["Task completion time", null, "auto"],
      ["Test run", null, "auto"],
      ["Local build", 1, "auto"],
      ["API contract", 2, "hidden"],
      ["Planner: assignment rules", 2, "hidden"],
      ["Planner: ordering & determinism", 1, "hidden"],
      ["Planner: parts & blocking", 2, "hidden"],
      ["Frontend–API integration", 1, "agent"],
      ["Code structure", 1, "agent"],
      ["Tech stack & run contract", 1, "agent"],
      ["Manual testing", 1, "human"],
      ["Consistent UI", 1, "human"],
      ["Responsive design", 1, "human"],
      ["Penalty", null, "penalty"],
    ],
  );
  assert.equal(RUBRIC_ROWS.length, 14);
  assert.equal(new Set(RUBRIC_ROWS.map((r) => r.name)).size, 14, "row names are unique");
});

test("the integration row's dash is U+2013, an en dash, not a hyphen", () => {
  const name = RUBRIC_ROWS[7].name;
  assert.equal(name.codePointAt("Frontend".length), 0x2013);
  assert.equal(Buffer.from(name, "utf8").subarray(8, 11).toString("hex"), "e28093");
});

test("the maxima sum to RUBRIC_MAX, 14", () => {
  assert.equal(RUBRIC_MAX, 14);
  assert.equal(RUBRIC_ROWS.reduce((sum, r) => sum + (r.max ?? 0), 0), RUBRIC_MAX);
});

test("HIDDEN_ROWS are the hidden-test rows, and match manifest.json's rows and maxima in order", () => {
  assert.deepEqual(HIDDEN_ROWS, RUBRIC_ROWS.filter((r) => r.scoredBy === "hidden"));
  const manifest = JSON.parse(readFileSync(join(ROOT, "benchmark", "contract-tests", "manifest.json"), "utf8"));
  assert.deepEqual(
    HIDDEN_ROWS.map((r) => [r.name, r.max]),
    manifest.files.map((f: { row: string; max: number }) => [f.row, f.max]),
  );
  assert.equal(HIDDEN_ROWS.reduce((sum, r) => sum + (r.max ?? 0), 0), 7, "the hidden tests are worth 7");
});

test("the rows, the limits and the input list cannot be changed at run time", () => {
  assert.ok(Object.isFrozen(RUBRIC_ROWS) && RUBRIC_ROWS.every((r) => Object.isFrozen(r)));
  assert.ok(Object.isFrozen(HIDDEN_ROWS));
  assert.ok(Object.isFrozen(LIMITS));
  assert.ok(Object.isFrozen(RUBRIC_ID_INPUTS));
});

// --- rounding -------------------------------------------------------------------

test("roundScore rounds passed / total × max to two decimals", () => {
  const pins: [number, number, number, number][] = [
    [23, 24, 2, 1.92],
    [11, 12, 2, 1.83],
    [10, 11, 1, 0.91],
    [10, 11, 2, 1.82],
    [20, 24, 2, 1.67],
    [0, 24, 2, 0],
    [24, 24, 2, 2],
    [1, 11, 1, 0.09],
    [2, 11, 2, 0.36],
  ];
  for (const [passed, total, max, want] of pins) {
    assert.equal(roundScore(passed, total, max), want, `${passed}/${total} × ${max}`);
  }
});

test("roundScore refuses counts that cannot come from a run", () => {
  assert.throws(() => roundScore(0, 0, 2), RangeError);
  assert.throws(() => roundScore(25, 24, 2), RangeError);
  assert.throws(() => roundScore(-1, 24, 2), RangeError);
  assert.throws(() => roundScore(1.5, 24, 2), RangeError);
  assert.throws(() => roundScore(1, 24, Number.NaN), RangeError);
});

// --- limits ---------------------------------------------------------------------

test("LIMITS holds every scoring budget and retry count, exactly", () => {
  assert.deepEqual({ ...LIMITS }, {
    pipInstallMs: 300_000,
    healthMs: 60_000,
    healthProbeMs: 1_000,
    healthPollMs: 200,
    fileMs: 120_000,
    overallMs: 1_200_000,
    restartRetries: 1,
    pypiProbeMs: 60_000,
    npmInstallMs: 600_000,
    devServerStartMs: 60_000,
    devServerProbeMs: 1_000,
    devServerPollMs: 200,
    devServerRetries: 1,
    registryProbeMs: 60_000,
  });
});

test("the overall budget is a guard above spec §5's worst legitimate run of the four files", () => {
  // 180 + 3 × (60 + 60 + 120) = 900 s: the first start has no retry, each restart has one.
  // The 300 s install is budgeted on its own; inside the 20 minutes it would leave no margin.
  const worst = (LIMITS.healthMs + LIMITS.fileMs) + 3 * (LIMITS.healthMs * (1 + LIMITS.restartRetries) + LIMITS.fileMs);
  assert.equal(worst, 900_000);
  assert.ok(worst < LIMITS.overallMs);
});

// --- rubric id ------------------------------------------------------------------

test("RUBRIC_ID_INPUTS is spec §5's list, and every path exists", () => {
  assert.deepEqual([...RUBRIC_ID_INPUTS], [
    "prompt.md",
    "benchmark/criteria.md",
    ".claude/skills/agrav-score-attempt/SKILL.md",
    "scripts/lib/rubric.ts",
    "scripts/lib/contract-results.ts",
    "scripts/lib/contract-suite.ts",
    "benchmark/contract-tests",
    "benchmark/context/seed.json",
  ]);
  for (const input of RUBRIC_ID_INPUTS) assert.ok(existsSync(join(ROOT, input)), `${input} exists`);
});

test("rubricId is maintenance-console@ plus 12 hex digits, and deterministic", () => {
  const id = rubricId(ROOT);
  assert.match(id, /^maintenance-console@[0-9a-f]{12}$/);
  assert.equal(rubricId(ROOT), id);
  assert.equal(id, `maintenance-console@${fingerprintOf(ROOT, RUBRIC_ID_INPUTS).slice(0, 12)}`);
});

test("rubricId depends on the inputs' content and paths, not on where the repository is", () => {
  const copy = copyOfInputs();
  assert.equal(rubricId(copy), rubricId(ROOT), "a copy of the inputs elsewhere has the same id");
  writeFileSync(join(copy, "README.md"), "not an input\n");
  assert.equal(rubricId(copy), rubricId(ROOT), "a file outside the inputs does not count");
});

test("rubricId changes when any byte of any input changes", () => {
  const base = rubricId(ROOT);
  const files = RUBRIC_ID_INPUTS.flatMap((input) => filesUnder(join(ROOT, input)).map((file) => file.slice(ROOT.length + 1)));
  assert.ok(files.length >= RUBRIC_ID_INPUTS.length + 5, "benchmark/contract-tests is walked");
  const copy = copyOfInputs();
  for (const file of files) {
    const original = readFileSync(join(copy, file));
    assert.notEqual(
      original.length,
      0,
      `${file} is empty, so flipping its last byte proves nothing. An empty rubric-id input would be ` +
        "skipped silently here and its content left unchecked; give it content, or mutate it by appending.",
    );
    flipLastByte(join(copy, file));
    assert.notEqual(rubricId(copy), base, `editing ${file} changes the id`);
    writeFileSync(join(copy, file), original);
  }
  assert.equal(rubricId(copy), base, "restored, the copy has the original id again");
});

test("rubricId changes when a hidden-test file is added or renamed", () => {
  const base = rubricId(ROOT);
  const copy = copyOfInputs();
  const extra = join(copy, "benchmark", "contract-tests", "extra.test.ts");
  writeFileSync(extra, "");
  assert.notEqual(rubricId(copy), base, "an added file counts, even an empty one");
  rmSync(extra);
  const from = join(copy, "benchmark", "contract-tests", "api.ts");
  cpSync(from, join(copy, "benchmark", "contract-tests", "api2.ts"));
  rmSync(from);
  assert.notEqual(rubricId(copy), base, "a renamed file counts");
});

test("rubricId throws when an input is missing", () => {
  const copy = copyOfInputs();
  rmSync(join(copy, "benchmark", "criteria.md"));
  assert.throws(() => rubricId(copy), /fingerprint input missing: benchmark\/criteria\.md/);
});

// --- fingerprintOf and gate 2 ---------------------------------------------------

test("fingerprintOf over gate 2's inputs is gateFingerprint, which still matches the recorded gate", () => {
  assert.equal(fingerprintOf(ROOT, GATE_2_INPUTS), gateFingerprint(ROOT));
  const recorded = JSON.parse(readFileSync(join(ROOT, GATE_RESULT_PATH), "utf8"));
  assert.equal(gateFingerprint(ROOT), recorded.fingerprint);
});

test("gate 2's inputs are exactly the six paths its record was taken over", () => {
  // The recorded fingerprint guards the files' bytes; this guards the list itself,
  // so an input cannot quietly drop out of what gate 2 is said to vouch for.
  assert.deepEqual(
    [...GATE_2_INPUTS],
    [
      "benchmark/contract-tests",
      "benchmark/context/seed.json",
      "test/fixtures/reference-backend",
      "scripts/lib/contract-suite.ts",
      "scripts/lib/reference-server.ts",
      "scripts/reference-gate.ts",
    ],
  );
  assert.ok(Object.isFrozen(GATE_2_INPUTS));
});

test("fingerprintOf ignores the order of its inputs and an input listed twice", () => {
  const reversed = [...RUBRIC_ID_INPUTS].reverse();
  assert.equal(fingerprintOf(ROOT, reversed), fingerprintOf(ROOT, RUBRIC_ID_INPUTS));
  assert.equal(fingerprintOf(ROOT, [...RUBRIC_ID_INPUTS, "prompt.md"]), fingerprintOf(ROOT, RUBRIC_ID_INPUTS));
});

test("fingerprintOf hashes a file's path with its bytes: moving it changes the hash", () => {
  const root = tempDir();
  mkdirSync(join(root, "a"));
  writeFileSync(join(root, "a", "x.txt"), "same bytes");
  const before = fingerprintOf(root, ["a"]);
  mkdirSync(join(root, "a", "sub"));
  cpSync(join(root, "a", "x.txt"), join(root, "a", "sub", "x.txt"));
  rmSync(join(root, "a", "x.txt"));
  assert.notEqual(fingerprintOf(root, ["a"]), before);
});

test("fingerprintOf skips __pycache__ and gate-2-result.json at any depth", () => {
  const root = tempDir();
  mkdirSync(join(root, "d", "__pycache__"), { recursive: true });
  writeFileSync(join(root, "d", "x.py"), "x = 1\n");
  const before = fingerprintOf(root, ["d"]);
  writeFileSync(join(root, "d", "__pycache__", "x.cpython-311.pyc"), "bytecode");
  writeFileSync(join(root, "d", "gate-2-result.json"), "{}");
  assert.equal(fingerprintOf(root, ["d"]), before);
});
