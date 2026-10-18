/**
 * Gate H-FREEZE: the hard contract suite and the hard fuzz oracle are frozen.
 *
 * Their content is hashed with `fingerprintOf` (the hash gates 2 and 3a and
 * the rubric ids use) and held to `H_FREEZE_FINGERPRINT`. A change to any
 * file under `H_FREEZE_PATHS` turns the gate red; changing the suite or the
 * oracle on purpose means recording a new fingerprint here, in the same
 * commit, together with the new hard rubric id.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprintOf } from "./lib/gate-fingerprint";

export const H_FREEZE_PATHS: readonly string[] = Object.freeze([
  "tracks/console-hard/benchmark/contract-tests/",
  "tracks/console-hard/benchmark/fuzz/expected.json",
]);

export const H_FREEZE_FINGERPRINT = "4dd21fedfa50ecce304428fb3254ec8c80e856dce98f39588f523085e1d23626";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface HFreezeResult {
  ok: boolean;
  expected: string;
  actual: string;
  paths: readonly string[];
}

export function checkHFreeze(expected = H_FREEZE_FINGERPRINT, root = DEFAULT_ROOT): HFreezeResult {
  const actual = fingerprintOf(root, H_FREEZE_PATHS);
  return { ok: actual === expected, expected, actual, paths: H_FREEZE_PATHS };
}

export function main(): number {
  console.log(`Checking Gate H-FREEZE against fingerprint ${H_FREEZE_FINGERPRINT.slice(0, 12)} ...`);
  console.log(`Target paths:`);
  for (const p of H_FREEZE_PATHS) {
    console.log(`  - ${p}`);
  }

  const result = checkHFreeze();
  if (!result.ok) {
    console.error(`\n❌ Gate H-FREEZE FAILED: the frozen files changed.`);
    console.error(`  expected ${result.expected}`);
    console.error(`  actual   ${result.actual}`);
    return 1;
  }

  console.log(`\n✓ Gate H-FREEZE passed: hard contract suite and oracle match fingerprint ${H_FREEZE_FINGERPRINT.slice(0, 12)}.`);
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
