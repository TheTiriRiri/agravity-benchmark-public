/**
 * What the hard-reference gate (spec §8.4.8, gates P4-A and P4-B) vouched for.
 * It lives apart from `scripts/lib/gate-fingerprint.ts` on purpose: that file
 * is a gate-3a input, and P4a edits nothing gate 3a hashes. The record sits
 * outside its own inputs, as gate P2-B's does, so `FINGERPRINT_IGNORED` needs
 * no new name.
 */
import { join } from "node:path";

import { fingerprintOf } from "./gate-fingerprint";

export const HARD_GATE_RESULT_PATH = join("test", "fixtures", "hard-gate", "gate-hard-result.json");

/** Every file the gate's verdict depends on, repo-relative. */
export const HARD_GATE_INPUTS: readonly string[] = Object.freeze([
  join("test", "fixtures", "reference-backend-hard"),
  // The classic mutants' owner lists: the gate reads them to hold the port to them in hard mode.
  join("test", "fixtures", "reference-backend", "mutants.json"),
  join("tracks", "console-hard", "benchmark", "context", "seed.json"),
  join("tracks", "console-hard", "benchmark", "contract-tests"),
  join("scripts", "lib", "contract-suite.ts"),
  join("scripts", "lib", "reference-server.ts"),
  join("scripts", "hard-reference-gate.ts"),
]);

/** The seven rule switches of spec §8.4.5, and the seed-week change each must cause. */
export const RULE_SWITCHES: readonly string[] = Object.freeze([
  "off_crews",
  "off_travel",
  "off_absences",
  "off_holidays",
  "off_splitting",
  "off_preemption",
  "off_edf",
]);
export const MIN_ORDERS_CHANGED = 2;

export interface HardGateResult {
  fingerprint: string;
  recordedAt: string;
  python: string;
  node: string;
  /** Per hard test file, the manifest's count, all of which passed on the reference. */
  tests: Record<string, number>;
  /** The classic mutants, each killed by its classic owners' ported files in hard mode. */
  classicMutants: string[];
  /** The hard mutants of reference-backend-hard/mutants.json, each killed by its owners. */
  hardMutants: string[];
  /** Gate P4-B: per switch, how many seed-week orders the switch changes. */
  switches: Record<string, number>;
  /**
   * The seed-week orders `travel_cap_off` changes: at least one means a day on
   * which work fits 480 but work plus travel does not (spec §8.4.2).
   */
  travelCapBites: number;
}

export function hardGateFingerprint(root: string): string {
  return fingerprintOf(root, HARD_GATE_INPUTS);
}

export const HARD_FUZZ_RESULT_PATH = join("test", "fixtures", "hard-gate", "gate-hard-fuzz-result.json");

export const HARD_FUZZ_INPUTS: readonly string[] = Object.freeze([
  join("test", "fixtures", "reference-backend-hard"),
  join("tracks", "console-hard", "benchmark", "context", "seed.json"),
  join("tracks", "console-hard", "benchmark", "fuzz", "cases.json"),
  join("tracks", "console-hard", "benchmark", "fuzz", "expected.json"),
  join("tracks", "console-hard", "benchmark", "fuzz", "manifest.json"),
  join("tracks", "console-hard", "benchmark", "fuzz", "fuzz.test.ts"),
  join("tracks", "console-hard", "benchmark", "fuzz", "replay.ts"),
  join("scripts", "hard-fuzz-gate.ts"),
]);

export interface HardFuzzGateResult {
  recordedAt: string;
  seed: number;
  generatorVersion: number;
  total: number;
  referencePassed: number;
  fingerprint: string;
  mutantFailures: Record<string, { total: number; byStratum: Record<string, number> }>;
}

export function hardFuzzFingerprint(root: string): string {
  return fingerprintOf(root, HARD_FUZZ_INPUTS);
}

