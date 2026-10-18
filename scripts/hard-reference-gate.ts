/**
 * Gates P4-A and P4-B of the hard track (spec §8.4.8): prove the hard suite
 * measures the hard contract, and that every new rule changes the seed week.
 *
 *   npm run gate:hard-reference
 *   npm run gate:hard-reference -- --only crew_single
 *
 * P4-A. The hard reference (test/fixtures/reference-backend-hard) passes every
 * hard test. Each hard mutant fails every file its owner list names; so does
 * each classic mutant, whose owners are the classic mutants.json's file names
 * read inside the hard suite, since the port keeps them. As in gate 2, a
 * planner file failing without being owned is collateral, but
 * `api-contract.test.ts` failing without being owned is a problem.
 *
 * P4-B. For each `off_*` switch, planning the pristine seed week changes at
 * least two orders' status, reason, technicians or segments, compared with the
 * reference's own plan. `travel_cap_off` must change at least one.
 *
 * A complete passing run writes test/fixtures/hard-gate/gate-hard-result.json,
 * which `npm test` checks against the current files.
 *
 * Signal-sensitive: it owns a live uvicorn child. Invoke it as
 * `node --import tsx scripts/hard-reference-gate.ts`, never through the tsx bin.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runContractFile } from "./lib/contract-suite";
import {
  HARD_GATE_RESULT_PATH,
  MIN_ORDERS_CHANGED,
  RULE_SWITCHES,
  hardGateFingerprint,
  type HardGateResult,
} from "./lib/hard-gate-fingerprint";
import { VENV_DIR as VENV, ensureVenv, startReference } from "./lib/reference-server";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BACKEND = join(ROOT, "test", "fixtures", "reference-backend-hard");
const SEED = join(ROOT, "tracks", "console-hard", "benchmark", "context", "seed.json");
const TESTS = join(ROOT, "tracks", "console-hard", "benchmark", "contract-tests");
const API_FILE = "api-contract.test.ts";
const FILE_TIMEOUT_MS = 120_000;
const SEED_WEEK = "2026-10-05";

interface Manifest {
  files: { file: string; tests: number }[];
}

const manifest: Manifest = JSON.parse(readFileSync(join(TESTS, "manifest.json"), "utf8"));
const classicMutants: Record<string, string[]> = JSON.parse(
  readFileSync(join(ROOT, "test", "fixtures", "reference-backend", "mutants.json"), "utf8"),
);
const hardMutants: Record<string, string[]> = JSON.parse(readFileSync(join(BACKEND, "mutants.json"), "utf8"));

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

async function withBackend<T>(mutant: string, body: (baseUrl: string) => Promise<T>): Promise<T> {
  const { baseUrl } = await startReference({
    mutant,
    backendDir: BACKEND,
    seedPath: SEED,
    onSpawn: (stop) => {
      stopChild = stop;
    },
  });
  try {
    return await body(baseUrl);
  } finally {
    stopBackend();
  }
}

/** File name -> names of failed tests; an empty list means the file passed. */
function runAll(mutant: string): Promise<Map<string, string[]>> {
  return withBackend(mutant, async (baseUrl) => {
    const failures = new Map<string, string[]>();
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
    return failures;
  });
}

type Placement = [string, string | null, string[], { start: string; end: string }[]];

/** The pristine seed week's plan under a mutant: order id -> what rule 8 decided. */
function seedWeekPlan(mutant: string): Promise<Map<string, Placement>> {
  return withBackend(mutant, async (baseUrl) => {
    const reply = await fetch(`${baseUrl}/api/v1/plan?week_start=${SEED_WEEK}`, { method: "POST" });
    if (reply.status !== 200) throw new Error(`${mutant}: POST /plan answered ${reply.status}`);
    const body = (await reply.json()) as { orders: { id: string; status: string; status_reason: string | null; technician_ids: string[]; segments: { start: string; end: string }[] }[] };
    return new Map(body.orders.map((o) => [o.id, [o.status, o.status_reason, o.technician_ids, o.segments] as Placement]));
  });
}

function changed(base: Map<string, Placement>, other: Map<string, Placement>): string[] {
  return [...base.keys()].filter((id) => JSON.stringify(base.get(id)) !== JSON.stringify(other.get(id)));
}

async function main(argv: string[]): Promise<number> {
  const only: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--only") only.push(argv[++i] ?? "");
    else if (argv[i].startsWith("--only=")) only.push(argv[i].slice("--only=".length));
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  const known = new Set(["reference", "switches", ...Object.keys(classicMutants), ...Object.keys(hardMutants)]);
  for (const name of only) if (!known.has(name)) throw new Error(`unknown mutant or step: ${name}`);
  const wanted = (name: string) => only.length === 0 || only.includes(name);
  ensureVenv(VENV, BACKEND);
  let problems = 0;

  if (wanted("reference")) {
    for (const [file, failed] of await runAll("")) {
      const entry = manifest.files.find((f) => f.file === file)!;
      if (failed.length === 0) {
        console.log(`ok    reference        ${file} ${entry.tests}/${entry.tests}`);
      } else {
        problems += 1;
        console.log(`FAIL  reference        ${file}: ${failed.join("; ")}`);
      }
    }
  }

  for (const [kind, mutants] of [["classic", classicMutants], ["hard", hardMutants]] as const) {
    for (const [mutant, owners] of Object.entries(mutants)) {
      if (!wanted(mutant)) continue;
      const failures = await runAll(mutant);
      const failing = [...failures].filter(([, failed]) => failed.length > 0).map(([file]) => file);
      const survived = owners.filter((file) => !failing.includes(file));
      const collateral = failing.filter((file) => !owners.includes(file));
      const apiCollateral = collateral.includes(API_FILE);
      if (apiCollateral) {
        problems += 1;
        console.log(`FAIL  ${kind} ${mutant}: ${API_FILE} failed, but this mutant does not own it`);
      }
      if (survived.length > 0) {
        problems += 1;
        console.log(`FAIL  ${kind} ${mutant}: survived ${survived.join(", ")}`);
      }
      if (!apiCollateral && survived.length === 0) {
        console.log(`ok    ${kind} ${mutant}: killed by ${owners.join(", ")}${collateral.length ? `  (collateral: ${collateral.join(", ")})` : ""}`);
      }
    }
  }

  const switches: Record<string, number> = {};
  let travelCapBites = 0;
  if (wanted("switches")) {
    const base = await seedWeekPlan("");
    for (const name of RULE_SWITCHES) {
      const ids = changed(base, await seedWeekPlan(name));
      switches[name] = ids.length;
      const ok = ids.length >= MIN_ORDERS_CHANGED;
      if (!ok) problems += 1;
      console.log(`${ok ? "ok  " : "FAIL"}  ${name}: ${ids.length} seed-week order(s) change${ids.length ? ` (${ids.join(", ")})` : ""}`);
    }
    const bites = changed(base, await seedWeekPlan("travel_cap_off"));
    travelCapBites = bites.length;
    if (travelCapBites === 0) problems += 1;
    console.log(`${travelCapBites ? "ok  " : "FAIL"}  travel_cap_off on the seed week: ${travelCapBites} order(s) change${bites.length ? ` (${bites.join(", ")})` : ""}`);
  }

  if (problems === 0 && only.length === 0) {
    const python = spawnSync(join(VENV, "bin", "python"), ["--version"], { encoding: "utf8" });
    const result: HardGateResult = {
      fingerprint: hardGateFingerprint(ROOT),
      recordedAt: new Date().toISOString(),
      python: python.stdout.trim(),
      node: process.version,
      tests: Object.fromEntries(manifest.files.map((f) => [f.file, f.tests])),
      classicMutants: Object.keys(classicMutants),
      hardMutants: Object.keys(hardMutants),
      switches,
      travelCapBites,
    };
    mkdirSync(dirname(join(ROOT, HARD_GATE_RESULT_PATH)), { recursive: true });
    writeFileSync(join(ROOT, HARD_GATE_RESULT_PATH), `${JSON.stringify(result, null, 2)}\n`);
    console.log(`\nrecorded ${HARD_GATE_RESULT_PATH}`);
  }
  console.log(problems === 0 ? "\nhard-reference gate passed" : `\nhard-reference gate FAILED: ${problems} problem(s)`);
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
