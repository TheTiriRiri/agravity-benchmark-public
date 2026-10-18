/**
 * Gate P4-B/Fuzz of the hard track: freeze the reference's answers to the
 * hard differential fuzz and count what each of the 47 mutants fails.
 *
 *   npm run gate:hard-fuzz                       # regenerate, oracle, reference, every mutant
 *   npm run gate:hard-fuzz -- --only cap_off
 *   npm run gate:hard-fuzz -- --accept-cases     # the generator changed on purpose
 *   npm run gate:hard-fuzz -- --accept-oracle    # the reference changed on purpose
 *
 * Runs the hard reference on the host's python3, in a cached venv.
 * Signal-sensitive: it owns a live uvicorn child.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generateCases } from "../tracks/console-hard/benchmark/fuzz/generate";
import type { CasesFile, ExpectedFile } from "../tracks/console-hard/benchmark/fuzz/case";
import { replayCase } from "../tracks/console-hard/benchmark/fuzz/replay";
import { HARD_STRATA } from "../tracks/console-hard/benchmark/fuzz/strata";
import { runContractFile, type ContractFileResult } from "./lib/contract-suite";
import {
  HARD_FUZZ_RESULT_PATH,
  hardFuzzFingerprint,
  type HardFuzzGateResult,
} from "./lib/hard-gate-fingerprint";
import { ensureVenv, startReference } from "./lib/reference-server";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FUZZ_DIR = join(ROOT, "tracks", "console-hard", "benchmark", "fuzz");
const CASES_PATH = join(FUZZ_DIR, "cases.json");
const EXPECTED_PATH = join(FUZZ_DIR, "expected.json");
const TEST_FILE = join(FUZZ_DIR, "fuzz.test.ts");
const BACKEND_DIR = join(ROOT, "test", "fixtures", "reference-backend-hard");
const CLASSIC_BACKEND_DIR = join(ROOT, "test", "fixtures", "reference-backend");
const SEED_PATH = join(ROOT, "tracks", "console-hard", "benchmark", "context", "seed.json");

const PREEMPTION_MUTANTS = [
  "preempt_unfiltered",
  "preempt_evict_all",
  "preempt_parts_after",
  "preempt_no_reprocess",
  "preempt_reprocess_each_round",
];

interface FuzzManifest {
  files: { file: string; tests: number; timeoutMs: number }[];
}

let stopChild: (() => void) | null = null;

function stopBackend(): void {
  try {
    stopChild?.();
  } catch {
    // Already gone.
  }
  stopChild = null;
}

function installHandlers(): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      stopBackend();
      process.exit(130);
    });
  }
  process.on("exit", stopBackend);
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function readOrNull(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function oracleDrift(onDisk: string, fresh: string): { changed: string[]; added: string[]; removed: string[] } {
  const before = (JSON.parse(onDisk) as ExpectedFile).replies;
  const after = (JSON.parse(fresh) as ExpectedFile).replies;
  return {
    changed: Object.keys(after).filter((id) => id in before && JSON.stringify(before[id]) !== JSON.stringify(after[id])),
    added: Object.keys(after).filter((id) => !(id in before)),
    removed: Object.keys(before).filter((id) => !(id in after)),
  };
}

const FIRST = 5;
const named = (ids: string[]): string => `${ids.slice(0, FIRST).join(", ")}${ids.length > FIRST ? ", …" : ""}`;

function reconcile(
  name: string,
  path: string,
  fresh: string,
  accepted: boolean,
  flag: string,
  describe?: (onDisk: string, fresh: string) => string,
): boolean {
  const onDisk = readOrNull(path);
  if (onDisk === fresh) {
    console.log(`${name} unchanged`);
    return true;
  }
  const what = onDisk !== null && describe ? describe(onDisk, fresh) : "";
  if (onDisk !== null && !accepted) {
    console.log(`FAIL  ${name} differs from what is on disk (nothing was written)${what ? `: ${what}` : ""}. If that is intended, run again with ${flag}.`);
    return false;
  }
  if (what) console.log(`${name}: ${what}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, fresh);
  console.log(onDisk === null ? `wrote ${name} (new)` : `wrote ${name} (accepted: ${flag})`);
  return true;
}

function describeOracle(onDisk: string, fresh: string): string {
  const { changed, added, removed } = oracleDrift(onDisk, fresh);
  const parts = [`${changed.length} case(s) answered differently${changed.length ? ` (${named(changed)})` : ""}`];
  if (added.length) parts.push(`${added.length} new (${named(added)})`);
  if (removed.length) parts.push(`${removed.length} gone (${named(removed)})`);
  return parts.join("; ");
}

function stratumOf(testName: string, caseIds: ReadonlySet<string>): string {
  const slash = testName.indexOf("/");
  const stratum = testName.slice(0, slash);
  if (slash < 0 || !HARD_STRATA.some((s) => s.id === stratum) || !caseIds.has(testName.slice(slash + 1))) {
    throw new Error(`unparseable test name from fuzz.test.ts: ${JSON.stringify(testName)}`);
  }
  return stratum;
}

async function runFuzzFile(baseUrl: string, entry: FuzzManifest["files"][number]): Promise<ContractFileResult> {
  const result = await runContractFile({
    file: TEST_FILE,
    baseUrl,
    seedPath: SEED_PATH,
    timeoutMs: entry.timeoutMs,
    expectedTests: entry.tests,
  });
  if (result.notRun > 0 || result.timedOut) {
    throw new Error(`fuzz.test.ts did not finish (${result.notRun} test(s) did not run, timedOut: ${result.timedOut})`);
  }
  return result;
}

async function withReference<T>(mutant: string, body: (baseUrl: string) => Promise<T>): Promise<T> {
  const { baseUrl } = await startReference({
    mutant,
    backendDir: BACKEND_DIR,
    seedPath: SEED_PATH,
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

function parseArgs(argv: string[], mutants: string[]): { only: string[]; acceptCases: boolean; acceptOracle: boolean } {
  const only: string[] = [];
  let acceptCases = false;
  let acceptOracle = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--only") only.push(argv[++i] ?? "");
    else if (argv[i]?.startsWith("--only=")) only.push(argv[i]!.slice("--only=".length));
    else if (argv[i] === "--accept-cases") acceptCases = true;
    else if (argv[i] === "--accept-oracle") acceptOracle = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  for (const name of only) {
    if (!mutants.includes(name)) throw new Error(`unknown mutant: ${name}`);
  }
  return { only, acceptCases, acceptOracle };
}

async function main(argv: string[]): Promise<number> {
  const hardMutants: Record<string, string[]> = JSON.parse(readFileSync(join(BACKEND_DIR, "mutants.json"), "utf8"));
  const classicMutants: Record<string, string[]> = JSON.parse(readFileSync(join(CLASSIC_BACKEND_DIR, "mutants.json"), "utf8"));
  const allMutants = { ...hardMutants, ...classicMutants };

  const { only, acceptCases, acceptOracle } = parseArgs(argv, Object.keys(allMutants));
  const manifest: FuzzManifest = JSON.parse(readFileSync(join(FUZZ_DIR, "manifest.json"), "utf8"));
  const entry = manifest.files.find((f) => f.file === "fuzz.test.ts");
  if (!entry) throw new Error("manifest.json has no fuzz.test.ts entry");

  // 1. Generate & reconcile cases.json
  const generated: CasesFile = generateCases();
  if (!reconcile("cases.json", CASES_PATH, json(generated), acceptCases, "--accept-cases")) return 1;
  const caseIds = new Set(generated.cases.map((c) => c.id));

  installHandlers();
  ensureVenv(undefined, BACKEND_DIR);

  // 2. Reference answers every case to produce the oracle
  console.log(`Replaying 280 cases against reference backend...`);
  const replies = await withReference("", async (baseUrl) => {
    const answers: ExpectedFile["replies"] = {};
    for (const fuzzCase of generated.cases) {
      answers[fuzzCase.id] = await replayCase(baseUrl, fuzzCase);
    }
    return answers;
  });
  const oracle: ExpectedFile = { generatorVersion: generated.generatorVersion, seed: generated.seed, replies };
  const accepted = acceptOracle || acceptCases;
  if (!reconcile("expected.json", EXPECTED_PATH, json(oracle), accepted, "--accept-oracle", describeOracle)) return 1;

  let problems = 0;

  // 3. fuzz.test.ts against reference backend
  console.log(`Running fuzz.test.ts against reference backend...`);
  const reference = await withReference("", (baseUrl) => runFuzzFile(baseUrl, entry));
  console.log(`reference: ${reference.passed}/${reference.total}`);
  if (reference.failed.length > 0) {
    problems += 1;
    for (const failure of reference.failed) console.log(`FAIL  reference  ${failure.name}: ${failure.message.split("\n")[0]}`);
  }

  // 4. Run each mutant and count failures per stratum
  console.log(`Running against mutants...`);
  const mutantFailures: HardFuzzGateResult["mutantFailures"] = {};
  for (const mutant of Object.keys(allMutants)) {
    if (only.length > 0 && !only.includes(mutant)) continue;
    const result = await withReference(mutant, (baseUrl) => runFuzzFile(baseUrl, entry));
    const byStratum: Record<string, number> = {};
    for (const failure of result.failed) {
      const stratum = stratumOf(failure.name, caseIds);
      byStratum[stratum] = (byStratum[stratum] ?? 0) + 1;
    }
    mutantFailures[mutant] = { total: result.failed.length, byStratum };
    const spread = Object.entries(byStratum).map(([stratum, count]) => `${stratum} ${count}`).join(", ");
    console.log(`${mutant.padEnd(28)} ${String(result.failed.length).padStart(3)}/${result.total}  ${spread || "-"}`);
  }

  // 5. Assert preemption mutants are killed by preemption-edf-observable
  if (only.length === 0) {
    for (const mutant of PREEMPTION_MUTANTS) {
      const byStratum = mutantFailures[mutant]?.byStratum ?? {};
      const count = byStratum["preemption-edf-observable"] ?? 0;
      if (count === 0) {
        problems += 1;
        console.error(`FAIL  mutant ${mutant} was NOT killed by stratum 'preemption-edf-observable'`);
      } else {
        console.log(`✔ preemption mutant ${mutant} killed by preemption-edf-observable (${count} tests)`);
      }
    }
  }

  // 6. Record gate result
  if (problems === 0 && only.length === 0) {
    const record: HardFuzzGateResult = {
      recordedAt: new Date().toISOString(),
      seed: generated.seed,
      generatorVersion: generated.generatorVersion,
      total: reference.total,
      referencePassed: reference.passed,
      fingerprint: hardFuzzFingerprint(ROOT),
      mutantFailures,
    };
    mkdirSync(dirname(join(ROOT, HARD_FUZZ_RESULT_PATH)), { recursive: true });
    writeFileSync(join(ROOT, HARD_FUZZ_RESULT_PATH), json(record));
    console.log(`\nwrote ${HARD_FUZZ_RESULT_PATH}`);
  }

  console.log(problems === 0 ? "\nhard fuzz gate passed" : `\nhard fuzz gate FAILED: ${problems} problem(s)`);
  return problems === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      stopBackend();
      process.exit(1);
    },
  );
}
