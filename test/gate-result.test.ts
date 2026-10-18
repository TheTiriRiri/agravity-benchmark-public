import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  fingerprintOf,
  FUZZ_GATE_RESULT_PATH,
  GATE_3_INPUTS,
  GATE_3_RESULT_PATH,
  GATE_RESULT_PATH,
  gate3Fingerprint,
  gateFingerprint,
  type FuzzGateResult,
  type Gate3Result,
  type GateResult,
} from "../scripts/lib/gate-fingerprint";
import { readScoringImage } from "../scripts/lib/runner-config";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const recorded: GateResult = JSON.parse(readFileSync(join(ROOT, GATE_RESULT_PATH), "utf8"));

const scratch: string[] = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

test("gate 2 was run against the hidden tests, seed and reference backend as they are now", () => {
  assert.equal(
    gateFingerprint(ROOT),
    recorded.fingerprint,
    "a gate-2 input changed since the gate last passed; run `npm run gate:reference` and commit gate-2-result.json",
  );
});

test("the recorded gate run covered every file in the manifest and every mutant", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "benchmark", "contract-tests", "manifest.json"), "utf8"));
  const mutants = JSON.parse(readFileSync(join(ROOT, "test", "fixtures", "reference-backend", "mutants.json"), "utf8"));
  assert.deepEqual(recorded.tests, Object.fromEntries(manifest.files.map((f: { file: string; tests: number }) => [f.file, f.tests])));
  assert.deepEqual(recorded.mutants, Object.keys(mutants));
});

// ---------------------------------------------------------------------------
// gate 3a

/** The scoring CLIs and the gate: what gate 3a vouches for, with everything they import. */
const GATE_3_ENTRY_POINTS = [
  "scripts/contract-tests.ts",
  "scripts/contract-results.ts",
  "scripts/serve-attempt.ts",
  "scripts/take-screenshots.ts",
  "scripts/backend-gate.ts",
  "scripts/contract-tests-hard.ts",
];

/**
 * The relative module specifiers in a TypeScript source: `import … from`,
 * `export … from` (either one `import type` too, and across lines), a bare
 * `import "./x"`, and `import("./x")`. Package imports are not followed.
 */
function relativeImports(source: string): string[] {
  const specifiers = new Set<string>();
  for (const pattern of [
    /\bfrom\s+["'](\.{1,2}\/[^"']+)["']/g,
    /(?:^|[\s;])import\s+["'](\.{1,2}\/[^"']+)["']/g,
    /\bimport\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g,
  ]) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1]);
  }
  return [...specifiers];
}

/** `./x` from `file`: `x`, `x.ts` or `x/index.ts`, whichever is a file; `null` when none is. */
function resolveImport(file: string, specifier: string): string | null {
  const base = resolve(dirname(file), specifier);
  for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Every file reached from `entries` by relative imports, repo-relative with `/`; and every import that did not resolve. */
function importClosure(entries: readonly string[]): { reached: string[]; unresolved: string[] } {
  const seen = new Set<string>();
  const unresolved: string[] = [];
  const queue = entries.map((entry) => join(ROOT, entry));
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of relativeImports(readFileSync(file, "utf8"))) {
      const target = resolveImport(file, specifier);
      if (target === null) unresolved.push(`${relative(ROOT, file)}: ${specifier}`);
      else queue.push(target);
    }
  }
  return { reached: [...seen].map((file) => relative(ROOT, file).split(sep).join("/")).sort(), unresolved };
}

/**
 * Files outside `scripts/` the entry points import and GATE_3_INPUTS leaves
 * out on purpose; its doc comment says why. A new one fails the closure test
 * until it is either listed as an input or added here.
 */
const GATE_3_OUTSIDE_SCRIPTS_NOT_INPUTS = [
  "eval-attempts/metadata.ts",
  // Reached through scripts/lib/fuzz-score.ts. A track has its own gate, P2-B,
  // and its fingerprint covers this file through cases.json (see the doc
  // comment on GATE_3_INPUTS): not a gate-3a input on purpose.
  "tracks/console-fuzz/benchmark/fuzz/strata.ts",
];

/** Whether `path` (repo-relative, `/`) is an input: listed itself, or under a listed directory. */
function isGate3Input(path: string): boolean {
  return GATE_3_INPUTS.some((input) => path === input || path.startsWith(`${input}/`));
}

test("relativeImports finds every form of relative import and ignores packages", () => {
  const source = [
    'import { a } from "./a";',
    'import type { B } from "../lib/b";',
    "import {",
    "  c,",
    '} from "./c";',
    'export { d } from "./d";',
    'export type { E } from "./e";',
    'import "./side-effect";',
    'const f = await import("./f");',
    'type G = import("./g").G;',
    'import { parse } from "csv-parse/sync";',
    'import { join } from "node:path";',
  ].join("\n");
  assert.deepEqual(relativeImports(source).sort(), ["../lib/b", "./a", "./c", "./d", "./e", "./f", "./g", "./side-effect"]);
});

test("gate 3a's inputs cover every scripts/ module its entry points import, directly or not", () => {
  const { reached, unresolved } = importClosure(GATE_3_ENTRY_POINTS);
  assert.deepEqual(unresolved, [], "a relative import that resolves to no file");
  // Not vacuous: the scanner reaches the libraries the spec names.
  for (const module of ["scripts/lib/docker.ts", "scripts/lib/interrupt.ts", "scripts/lib/attempt-backend.ts", "scripts/lib/dev-server.ts", "scripts/lib/contract-suite.ts"]) {
    assert.ok(reached.includes(module), `${module} should be reached`);
  }
  const missing = reached.filter((path) => path.startsWith("scripts/") && !isGate3Input(path));
  assert.deepEqual(
    missing,
    [],
    `imported by gate 3a's entry points but not in GATE_3_INPUTS (scripts/lib/gate-fingerprint.ts): ${missing.join(", ")}`,
  );
  const outside = reached.filter((path) => !path.startsWith("scripts/") && !isGate3Input(path));
  assert.deepEqual(
    outside,
    GATE_3_OUTSIDE_SCRIPTS_NOT_INPUTS,
    "the files outside scripts/ that gate 3a's entry points import changed: list a new one in GATE_3_INPUTS, " +
      "or say in its doc comment why it is left out and add it to GATE_3_OUTSIDE_SCRIPTS_NOT_INPUTS",
  );
});

test("every gate-3a input exists", () => {
  for (const input of GATE_3_INPUTS) assert.ok(existsSync(join(ROOT, input)), `${input} is listed in GATE_3_INPUTS but missing`);
  for (const entry of GATE_3_ENTRY_POINTS) assert.ok(GATE_3_INPUTS.includes(entry), `${entry} is an entry point`);
  for (const image of ["images/harness/Dockerfile", "images/harness/run-attempt"]) assert.ok(GATE_3_INPUTS.includes(image), image);
});

test("the fingerprint skips gate 3a's own record, as it skips gate 2's", () => {
  const root = mkdtempSync(join(tmpdir(), "gate-3-fingerprint-"));
  scratch.push(root);
  const fixtures = join(root, "test", "fixtures", "backend-gate");
  mkdirSync(fixtures, { recursive: true });
  writeFileSync(join(fixtures, "app.py"), "app = None\n");
  const inputs = ["test/fixtures/backend-gate"];
  const before = fingerprintOf(root, inputs);
  writeFileSync(join(fixtures, "gate-3-result.json"), "{}\n");
  assert.equal(fingerprintOf(root, inputs), before);
  writeFileSync(join(fixtures, "other.json"), "{}\n");
  assert.notEqual(fingerprintOf(root, inputs), before);
});

function recordedGate3(): Gate3Result | null {
  const path = join(ROOT, GATE_3_RESULT_PATH);
  // Absent between a change to a gate-3a input and the operator's re-run of
  // `npm run gate:backend`. Red would say the code is wrong; it is not — the
  // record is simply owed. The two callers skip themselves as `todo`.
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

test("gate 3a was run against the image, the scoring CLIs and their modules as they are now", (t) => {
  const recorded = recordedGate3();
  if (recorded === null) {
    t.todo("gate 3a has not been recorded; run `npm run gate:backend`");
    return;
  }
  assert.equal(
    gate3Fingerprint(ROOT),
    recorded.fingerprint,
    "a gate-3a input changed since the gate last passed; run `npm run gate:backend` and commit gate-3-result.json",
  );
});

test("the recorded gate-3a run covered every part and the manifest's files", async (t) => {
  const result = recordedGate3();
  if (result === null) {
    t.todo("gate 3a has not been recorded; run `npm run gate:backend`");
    return;
  }
  const gate = await import("../scripts/backend-gate");
  const manifest = JSON.parse(readFileSync(join(ROOT, "benchmark", "contract-tests", "manifest.json"), "utf8"));
  assert.deepEqual(result.parts, [...gate.PARTS]);
  assert.deepEqual(result.reference, Object.fromEntries(manifest.files.map((f: { file: string; tests: number }) => [f.file, f.tests])));
  assert.deepEqual(result.hardcodedPlan, Object.fromEntries(gate.HARDCODED_PLAN_EXPECTED.map((e) => [e.file, e.passed])));
  assert.match(result.image, /^agrav-bench\/harness:[^@]+@sha256:[0-9a-f]{64}$/);
  // runner.yaml is not a gate-3a input: a new tag there must not inherit a record
  // made in another image, and the Id is the one images/harness/IMAGE.md records.
  assert.equal(result.image.slice(0, result.image.indexOf("@")), readScoringImage(ROOT), "gate 3a ran in another tag than runner.yaml's");
  const imageDoc = readFileSync(join(ROOT, "images", "harness", "IMAGE.md"), "utf8").replace(/\s+/g, " ");
  assert.ok(imageDoc.includes(`**Local image Id:** \`${result.image.slice(result.image.indexOf("@") + 1)}\``), "gate 3a ran in another image Id than IMAGE.md records");
  assert.match(result.python, gate.PYTHON_VERSION_RE);
  assert.ok(result.agy.includes(gate.pinnedAgyVersion(ROOT)));
});

test("the recorded gate-3a run checked the fuzz part against gate P2-B's current record", (t) => {
  const result = recordedGate3();
  if (result === null) {
    t.todo("gate 3a has not been recorded; run `npm run gate:backend`");
    return;
  }
  const p2b: FuzzGateResult = JSON.parse(readFileSync(join(ROOT, FUZZ_GATE_RESULT_PATH), "utf8"));
  assert.equal(
    result.fuzzOracle,
    p2b.fingerprint,
    "gate P2-B's record changed since gate 3a last checked the fuzz part against it; run `npm run gate:backend` again",
  );
});
