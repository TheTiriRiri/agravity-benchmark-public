/**
 * What gates 2 and 3a vouched for. Each gate records a hash of every file its
 * verdict depends on; `test/gate-result.test.ts` recomputes it, so editing a
 * hidden test, the seed or the reference backend without re-running gate 2 —
 * or the image, a scoring CLI or a module they import without re-running gate
 * 3a — turns `npm test` red, without `npm test` needing Python or Docker.
 *
 * The hashing itself, `fingerprintOf`, is shared: the rubric id
 * (`scripts/lib/rubric.ts`) hashes its own list of files the same way. This
 * file is a gate-3a input (the gate imports it) but not a gate-2 input, and
 * `gateFingerprint` must keep returning exactly what it did when
 * gate-2-result.json was recorded, or that record stops verifying.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const GATE_RESULT_PATH = join("test", "fixtures", "reference-backend", "gate-2-result.json");

/** Gate 2's inputs, relative to the repository root. */
export const GATE_2_INPUTS: readonly string[] = Object.freeze([
  join("benchmark", "contract-tests"),
  join("benchmark", "context", "seed.json"),
  join("test", "fixtures", "reference-backend"),
  join("scripts", "lib", "contract-suite.ts"),
  join("scripts", "lib", "reference-server.ts"),
  join("scripts", "reference-gate.ts"),
]);

/**
 * Skipped at any depth, by name: Python's bytecode cache, and each gate's own
 * record, which sits among its inputs. gate-2-result.json was always skipped;
 * no file named gate-3-result.json occurs under gate 2's or the rubric id's
 * inputs, so adding it here changed neither.
 */
export const FINGERPRINT_IGNORED: ReadonlySet<string> = new Set(["__pycache__", "gate-2-result.json", "gate-3-result.json"]);

function filesUnder(path: string): string[] {
  if (statSync(path).isFile()) return [path];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => !FINGERPRINT_IGNORED.has(entry.name))
    .flatMap((entry) => filesUnder(join(path, entry.name)));
}

/**
 * sha256 over every file under `inputs` (files, or directories walked
 * recursively), sorted by path: for each file its path relative to `root`
 * with `/` separators, a NUL, its bytes, a NUL. The same files under another
 * root give the same hash; renaming, adding, removing or editing one changes
 * it. An input listed twice counts once. A missing input throws.
 */
export function fingerprintOf(root: string, inputs: readonly string[]): string {
  for (const input of inputs) {
    if (!existsSync(join(root, input))) throw new Error(`fingerprint input missing: ${input} (under ${root})`);
  }
  const hash = createHash("sha256");
  const files = [...new Set(inputs.flatMap((input) => filesUnder(join(root, input))))].sort();
  for (const file of files) {
    hash.update(relative(root, file).split("\\").join("/"));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export interface GateResult {
  fingerprint: string;
  recordedAt: string;
  python: string;
  node: string;
  tests: Record<string, number>;
  mutants: string[];
}

export function gateFingerprint(root: string): string {
  return fingerprintOf(root, GATE_2_INPUTS);
}

// ---------------------------------------------------------------------------
// gate 3a

export const GATE_3_RESULT_PATH = join("test", "fixtures", "backend-gate", "gate-3-result.json");

/**
 * Gate 3a's inputs, repo-relative (spec §7, 3a): the image, the four scoring
 * CLIs and the gate itself, every `scripts/` module they import — directly or
 * not — and the gate's fixtures (its own record excepted, by `FINGERPRINT_IGNORED`).
 * `test/gate-result.test.ts` follows the entry points' relative imports and
 * fails when one they reach under `scripts/` is missing here.
 *
 * Not inputs, each on purpose:
 *
 * - `benchmark/runner.yaml`, which plan 3 edits (its timeouts and `hold`):
 *   the record names the image by tag and Id instead.
 * - `eval-attempts/metadata.ts`, the one file outside `scripts/` the entry
 *   points import (take-screenshots reads `DISABLED_MODELS`, `AGENT_NAMES` and
 *   `isModelId` from it). It is the model catalogue — names, pricing, which
 *   ids are disabled — and changes with every catalogue edit, none of which
 *   bears on whether the scoring tools work: the gate's synthetic id is not in
 *   it, and take-screenshots' use of it is in take-screenshots.ts, which is an
 *   input. The spec's list stops at `scripts/lib/`; the closure test in
 *   `test/gate-result.test.ts` names this file as the one allowed exception,
 *   so a new import from outside `scripts/` has to be decided on too.
 * - `tracks/console-fuzz/benchmark/fuzz/strata.ts`, the second file outside
 *   `scripts/` (`scripts/lib/fuzz-score.ts` imports the strata's ids and size).
 *   Calling it "outside gate 3a" is only half true since the gate's `fuzz`
 *   part started staging a copy of `tracks/console-fuzz/benchmark/fuzz/` and
 *   running it through `contract-tests-hard` (Task 7): the part does exercise
 *   these files, and its own comparison of the staged copy against the
 *   repository's own catches an edit to any of them, byte for byte. What
 *   still keeps them out of this list is that they are not this
 *   fingerprint's job: they stay gate P2-B's own inputs (`FUZZ_ORACLE_INPUTS`),
 *   whose fingerprint the fuzz part reads and records as `fuzzOracle` rather
 *   than re-covering here — one file, one fingerprint that owns it.
 *   `test/fuzz-cases.test.ts` also pins `cases.json` byte for byte to the
 *   generator built from these strata, and `cases.json` is a P2-B input, so a
 *   change to which strata exist, their order or their size cannot pass
 *   without moving that fingerprint too. Editing only a stratum's `rule` text
 *   moves nothing, and scores nothing.
 * - The hidden tests, their manifest, the seed and the reference backend:
 *   gate 2's inputs, and not gate 3a's by the spec's explicit list. But gate
 *   3a's verdict does depend on them — `HARDCODED_PLAN_EXPECTED` in
 *   scripts/backend-gate.ts holds plan 1's per-file counts for them, and the
 *   reference's 24/12/11/11 comes from the manifest — so a change to any of
 *   them, which re-runs gate 2, should re-run gate 3a as well. `npm test`
 *   does not ask for that; the gate itself checks the manifest's counts when
 *   it runs.
 */
export const GATE_3_INPUTS: readonly string[] = Object.freeze([
  "images/harness/Dockerfile",
  "images/harness/run-attempt",
  // the entry points
  "scripts/contract-tests.ts",
  "scripts/contract-results.ts",
  "scripts/serve-attempt.ts",
  "scripts/take-screenshots.ts",
  "scripts/backend-gate.ts",
  "scripts/contract-tests-hard.ts",
  // their import closure under scripts/
  "scripts/lib/atomic-write.ts",
  "scripts/lib/attempt-backend.ts",
  "scripts/lib/attempts.ts",
  "scripts/lib/contract-results.ts",
  "scripts/lib/contract-suite.ts",
  "scripts/lib/dev-server.ts",
  "scripts/lib/docker.ts",
  "scripts/lib/fuzz-score.ts",
  "scripts/lib/gate-fingerprint.ts",
  "scripts/lib/hard-contract-results.ts",
  "scripts/lib/interrupt.ts",
  "scripts/lib/pytest-summary.ts",
  "scripts/lib/rubric.ts",
  "scripts/lib/run-json.ts",
  "scripts/lib/runner-config.ts",
  // the gate's fixtures
  "test/fixtures/backend-gate",
]);

/** What `npm run gate:backend` writes after a complete passing run. */
export interface Gate3Result {
  fingerprint: string;
  recordedAt: string;
  /** `<tag>@<image Id>`: `runner.yaml` is not an input, so the record says which image passed. */
  image: string;
  /** `python3 --version` inside the image. */
  python: string;
  /** `agy --version` inside the image. */
  agy: string;
  /** The host's node, which ran the CLIs and the hidden tests. */
  node: string;
  /** The parts that ran and passed, in order. */
  parts: string[];
  /** The reference backend: tests per file, every one of them passed. */
  reference: Record<string, number>;
  /** The `hardcoded_plan` mutant: tests passed per file. */
  hardcodedPlan: Record<string, number>;
  /**
   * Gate P2-B's own fingerprint (`test/fixtures/fuzz-gate/gate-p2b-result.json`),
   * as of the fuzz part's run: proves the part checked a *current* oracle, not
   * a stale one left over from before a re-run of `gate:fuzz`.
   */
  fuzzOracle: string;
}

export function gate3Fingerprint(root: string): string {
  return fingerprintOf(root, GATE_3_INPUTS);
}

// ---------------------------------------------------------------------------
// gate P2-B (the differential fuzz's oracle)

export const FUZZ_GATE_RESULT_PATH = join("test", "fixtures", "fuzz-gate", "gate-p2b-result.json");

/**
 * Everything a fuzz verdict depends on, repo-relative: the reference that
 * produced `expected.json`, the seed it ran on, the cases and their answers,
 * and the two files that replay one against a backend. `fuzz.test.ts` and
 * `manifest.json` are here because nothing else covers them — `tracks/` is
 * outside `GATE_3_INPUTS` by design — and a verdict that can change while no
 * hashed artefact notices is exactly what Ruling H3 forbids.
 *
 * One list, used by `scripts/fuzz-gate.ts` to write the record's fingerprint
 * and by every reader that recomputes it. Two copies would agree until someone
 * added a file to one.
 *
 * The record itself lives outside these paths, and gate 2's and gate 3a's
 * records are skipped by `FINGERPRINT_IGNORED`, so re-recording either does
 * not move this fingerprint.
 */
export const FUZZ_ORACLE_INPUTS: readonly string[] = Object.freeze([
  join("test", "fixtures", "reference-backend"),
  join("benchmark", "context", "seed.json"),
  join("tracks", "console-fuzz", "benchmark", "fuzz", "cases.json"),
  join("tracks", "console-fuzz", "benchmark", "fuzz", "expected.json"),
  join("tracks", "console-fuzz", "benchmark", "fuzz", "replay.ts"),
  join("tracks", "console-fuzz", "benchmark", "fuzz", "fuzz.test.ts"),
  join("tracks", "console-fuzz", "benchmark", "fuzz", "manifest.json"),
]);

/** What `npm run gate:fuzz` writes after a complete passing run. */
export interface FuzzGateResult {
  recordedAt: string;
  seed: number;
  generatorVersion: number;
  total: number;
  referencePassed: number;
  fingerprint: string;
  /**
   * Per mutant, the cases of the 200 it fails: in all and per stratum. A
   * stratum that the mutant does not fail is absent from `byStratum`, and a
   * mutant at zero has `total: 0` and `byStratum: {}` — a measurement, not a
   * defect (spec §10, gate P2-B).
   */
  mutantFailures: Record<string, { total: number; byStratum: Record<string, number> }>;
}

export function fuzzOracleFingerprint(root: string): string {
  return fingerprintOf(root, FUZZ_ORACLE_INPUTS);
}
