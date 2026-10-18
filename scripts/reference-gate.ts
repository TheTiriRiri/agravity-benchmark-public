/**
 * Gate 2 of the maintenance-console design: prove the hidden contract tests
 * measure the contract.
 *
 *   npm run gate:reference            # reference + every mutant
 *   npm run gate:reference -- --only cap_off
 *
 * The reference backend must pass every test. Each mutant in `mutants.json` —
 * the reference with exactly one rule broken, or with its planner replaced by a
 * memorised seed answer (`hardcoded_plan`) — must fail every file listed for
 * it. A planner file that fails without being listed is reported as collateral,
 * not as an error: exact-slot assertions legitimately notice a neighbouring
 * rule. `api-contract.test.ts` is the exception and is enforced: no mutant may
 * fail it unless it lists it, so every mutant that does not list it — all those
 * aimed at the planner rows, the memorised plan included — must pass every API
 * test and costs the API row nothing. That is a guarantee about these mutants,
 * not about every planner: a stubbed planner still fails a couple of its tests
 * (e.g. one asserts `POST /plan` schedules something), so the row is not
 * independent of the planner outright.
 *
 * A complete passing run writes gate-2-result.json, which `npm test` checks
 * against the current files (see scripts/lib/gate-fingerprint.ts).
 *
 * Runs the reference on the host's python3, in a cached venv. It is our own
 * code, so it needs no container; attempts never run this way.
 *
 * Signal-sensitive: it owns a live uvicorn child. Invoke it as
 * `node --import tsx scripts/reference-gate.ts`, never through the tsx bin.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runContractFile } from "./lib/contract-suite";
import { GATE_RESULT_PATH, gateFingerprint, type GateResult } from "./lib/gate-fingerprint";
import { BACKEND_DIR as BACKEND, SEED_PATH as SEED, VENV_DIR as VENV, ensureVenv, startReference } from "./lib/reference-server";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TESTS = join(ROOT, "benchmark", "contract-tests");
const API_FILE = "api-contract.test.ts";
const FILE_TIMEOUT_MS = 120_000;

interface Manifest {
  files: { file: string; row: string; max: number; tests: number }[];
}

const manifest: Manifest = JSON.parse(readFileSync(join(TESTS, "manifest.json"), "utf8"));
const mutants: Record<string, string[]> = JSON.parse(readFileSync(join(BACKEND, "mutants.json"), "utf8"));

let stopChild: (() => void) | null = null;

function stopBackend(): void {
  try {
    stopChild?.();
  } catch {
    // Already gone. Nothing else to clean up depends on this.
  }
  stopChild = null;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopBackend();
    process.exit(130);
  });
}
process.on("exit", stopBackend);

/**
 * File name -> names of failed tests. Empty list means the file passed. Tests
 * a timeout cut off count as failed and are listed as "(N test(s) did not
 * run)". A harness fault in a test file throws and stops the gate.
 */
async function runAll(mutant: string): Promise<Map<string, string[]>> {
  const { baseUrl } = await startReference({
    mutant,
    // Handed over as soon as the child exists, so a SIGINT during the health
    // poll still finds it: the promise has not resolved to give us one yet.
    onSpawn: (stop) => {
      stopChild = stop;
    },
  });
  const failures = new Map<string, string[]>();
  try {
    for (const entry of manifest.files) {
      const result = await runContractFile({
        file: join(TESTS, entry.file),
        baseUrl,
        seedPath: SEED,
        timeoutMs: FILE_TIMEOUT_MS,
        expectedTests: entry.tests,
      });
      const failed = result.failed.map((failure) => failure.name);
      if (result.notRun > 0) failed.push(`(${result.notRun} test(s) did not run)`);
      failures.set(entry.file, failed);
    }
  } finally {
    stopBackend();
  }
  return failures;
}

async function main(argv: string[]): Promise<number> {
  const only: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--only") only.push(argv[++i] ?? "");
    else if (argv[i].startsWith("--only=")) only.push(argv[i].slice("--only=".length));
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  for (const name of only) {
    if (name !== "reference" && !(name in mutants)) throw new Error(`unknown mutant: ${name}`);
  }
  const wanted = (name: string) => only.length === 0 || only.includes(name);
  ensureVenv();
  let problems = 0;

  if (wanted("reference")) {
    const failures = await runAll("");
    for (const [file, failed] of failures) {
      const entry = manifest.files.find((f) => f.file === file)!;
      if (failed.length === 0) {
        console.log(`ok    reference        ${file} ${entry.tests}/${entry.tests}`);
      } else {
        problems += 1;
        console.log(`FAIL  reference        ${file}: ${failed.join("; ")}`);
      }
    }
  }

  for (const [mutant, owners] of Object.entries(mutants)) {
    if (!wanted(mutant)) continue;
    const failures = await runAll(mutant);
    const failing = [...failures].filter(([, failed]) => failed.length > 0).map(([file]) => file);
    const survived = owners.filter((file) => !failing.includes(file));
    const collateral = failing.filter((file) => !owners.includes(file));
    const apiCollateral = collateral.includes(API_FILE);
    // One problem per FAIL line, as for the reference above. A mutant can both
    // survive an owned file and illegitimately fail api-contract.test.ts, and an
    // operator who only saw the API line would fix it and re-run the ~35s gate
    // before learning it also survived.
    if (apiCollateral) {
      problems += 1;
      console.log(`FAIL  ${mutant}: ${API_FILE} failed, but this mutant does not own it`);
    }
    if (survived.length > 0) {
      problems += 1;
      console.log(`FAIL  ${mutant}: survived ${survived.join(", ")}`);
    }
    if (!apiCollateral && survived.length === 0) {
      console.log(`ok    ${mutant}: killed by ${owners.join(", ")}${collateral.length ? `  (collateral: ${collateral.join(", ")})` : ""}`);
    }
  }

  if (problems === 0 && only.length === 0) {
    const python = spawnSync(join(VENV, "bin", "python"), ["--version"], { encoding: "utf8" });
    const result: GateResult = {
      fingerprint: gateFingerprint(ROOT),
      recordedAt: new Date().toISOString(),
      python: python.stdout.trim(),
      node: process.version,
      tests: Object.fromEntries(manifest.files.map((f) => [f.file, f.tests])),
      mutants: Object.keys(mutants),
    };
    writeFileSync(join(ROOT, GATE_RESULT_PATH), `${JSON.stringify(result, null, 2)}\n`);
    console.log(`\nrecorded ${GATE_RESULT_PATH}`);
  }
  console.log(problems === 0 ? "\ngate 2 passed" : `\ngate 2 FAILED: ${problems} problem(s)`);
  return problems === 0 ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    stopBackend();
    process.exit(1);
  },
);
