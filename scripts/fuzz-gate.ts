/**
 * Gate P2-B of the hard-track design: freeze the reference's answers to the
 * differential fuzz and count what each mutant fails.
 *
 *   npm run gate:fuzz                       # regenerate, oracle, reference, every mutant
 *   npm run gate:fuzz -- --only cap_off
 *   npm run gate:fuzz -- --accept-cases     # the generator changed on purpose
 *   npm run gate:fuzz -- --accept-oracle    # the reference changed on purpose
 *
 * In order: `cases.json` is regenerated in memory and compared with the bytes
 * on disk; the reference answers all 200 cases and those answers are compared
 * with `expected.json` on disk; `fuzz.test.ts` — the file that scores a
 * backend — runs against the same reference and must pass 200/200; then it
 * runs against each mutant, and the failures are counted per stratum. Both
 * comparisons happen BEFORE anything is written: writing first and comparing
 * after would destroy the evidence of the drift the comparison exists to
 * report.
 *
 * A mutant at zero is recorded, not fixed (spec §10): a hand-written test
 * already carries that rule, and the count says how well the fuzz does.
 *
 * A complete passing run writes gate-p2b-result.json, which `npm test` checks
 * against the current files (`FUZZ_ORACLE_INPUTS` in scripts/lib/gate-fingerprint.ts).
 *
 * Runs the reference on the host's python3, in a cached venv. No container, no
 * quota.
 *
 * Signal-sensitive: it owns a live uvicorn child. Invoke it as
 * `node --import tsx scripts/fuzz-gate.ts`, never through the tsx bin.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generateCases } from "../tracks/console-fuzz/benchmark/fuzz/generate";
import type { CasesFile, ExpectedFile } from "../tracks/console-fuzz/benchmark/fuzz/case";
import { replayCase } from "../tracks/console-fuzz/benchmark/fuzz/replay";
import { STRATA } from "../tracks/console-fuzz/benchmark/fuzz/strata";
import { runContractFile, type ContractFileResult } from "./lib/contract-suite";
import { FUZZ_GATE_RESULT_PATH, fuzzOracleFingerprint, type FuzzGateResult } from "./lib/gate-fingerprint";
import { BACKEND_DIR, SEED_PATH, ensureVenv, startReference } from "./lib/reference-server";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FUZZ_DIR = join(ROOT, "tracks", "console-fuzz", "benchmark", "fuzz");
const CASES_PATH = join(FUZZ_DIR, "cases.json");
const EXPECTED_PATH = join(FUZZ_DIR, "expected.json");
const TEST_FILE = join(FUZZ_DIR, "fuzz.test.ts");

interface FuzzManifest {
  files: { file: string; tests: number; timeoutMs: number }[];
}

let stopChild: (() => void) | null = null;

function stopBackend(): void {
  try {
    stopChild?.();
  } catch {
    // Already gone. Nothing else to clean up depends on this.
  }
  stopChild = null;
}

/** The interrupt handlers belong to the entry point, not to the module's import. */
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

/**
 * Which cases an oracle change touches: those whose recorded replies differ,
 * and those that exist on one side only. Used to tell the operator what an
 * accepted change is about to do, before it is done.
 */
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

/**
 * Compares `fresh` with what is on disk and writes only after that. A file
 * that does not exist yet is written; one that differs stops the gate unless
 * the operator said the change is meant. `describe` says what the difference
 * is, and it is printed before the write it precedes — a deliberate act leaves
 * a record of what it changed.
 */
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

/** `<stratum>/<caseId>` -> stratum; anything else is a harness fault, not a count. */
function stratumOf(testName: string, caseIds: ReadonlySet<string>): string {
  const slash = testName.indexOf("/");
  const stratum = testName.slice(0, slash);
  if (slash < 0 || !STRATA.some((s) => s.id === stratum) || !caseIds.has(testName.slice(slash + 1))) {
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
    // Not a count: the timer cut the run off, so what it did not reach is
    // unmeasured rather than failed.
    throw new Error(`fuzz.test.ts did not finish (${result.notRun} test(s) did not run, timedOut: ${result.timedOut})`);
  }
  return result;
}

async function withReference<T>(mutant: string, body: (baseUrl: string) => Promise<T>): Promise<T> {
  // Handed over as soon as the child exists, so a SIGINT during the health
  // poll still finds it: the promise has not resolved to give us one yet.
  const { baseUrl } = await startReference({
    mutant,
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
    else if (argv[i].startsWith("--only=")) only.push(argv[i].slice("--only=".length));
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
  const mutants: Record<string, string[]> = JSON.parse(readFileSync(join(BACKEND_DIR, "mutants.json"), "utf8"));
  const { only, acceptCases, acceptOracle } = parseArgs(argv, Object.keys(mutants));
  const manifest: FuzzManifest = JSON.parse(readFileSync(join(FUZZ_DIR, "manifest.json"), "utf8"));
  const entry = manifest.files.find((f) => f.file === "fuzz.test.ts");
  if (!entry) throw new Error("manifest.json has no fuzz.test.ts entry");

  // 1. The cases: regenerated in memory, compared before any write.
  const generated: CasesFile = generateCases();
  if (!reconcile("cases.json", CASES_PATH, json(generated), acceptCases, "--accept-cases")) return 1;
  const caseIds = new Set(generated.cases.map((c) => c.id));

  installHandlers();
  ensureVenv();

  // 2 and 3. The reference answers every case; its answers become the oracle
  // only once they match what is committed (or the operator accepted the change).
  const replies = await withReference("", async (baseUrl) => {
    const answers: ExpectedFile["replies"] = {};
    for (const fuzzCase of generated.cases) answers[fuzzCase.id] = await replayCase(baseUrl, fuzzCase);
    return answers;
  });
  const oracle: ExpectedFile = { generatorVersion: generated.generatorVersion, seed: generated.seed, replies };
  // Accepting new cases accepts the answers to them: the oracle follows the cases.
  const accepted = acceptOracle || acceptCases;
  if (!reconcile("expected.json", EXPECTED_PATH, json(oracle), accepted, "--accept-oracle", describeOracle)) return 1;

  let problems = 0;

  // 4. fuzz.test.ts itself, against the reference: the real scoring path.
  const reference = await withReference("", (baseUrl) => runFuzzFile(baseUrl, entry));
  console.log(`reference: ${reference.passed}/${reference.total}`);
  if (reference.failed.length > 0) {
    problems += 1;
    for (const failure of reference.failed) console.log(`FAIL  reference  ${failure.name}: ${failure.message.split("\n")[0]}`);
  }

  // 5. Each mutant, counted per stratum. A zero is a measurement.
  const mutantFailures: FuzzGateResult["mutantFailures"] = {};
  for (const mutant of Object.keys(mutants)) {
    if (only.length > 0 && !only.includes(mutant)) continue;
    const result = await withReference(mutant, (baseUrl) => runFuzzFile(baseUrl, entry));
    const byStratum: Record<string, number> = {};
    for (const failure of result.failed) {
      const stratum = stratumOf(failure.name, caseIds);
      byStratum[stratum] = (byStratum[stratum] ?? 0) + 1;
    }
    mutantFailures[mutant] = { total: result.failed.length, byStratum };
    const spread = Object.entries(byStratum).map(([stratum, count]) => `${stratum} ${count}`).join(", ");
    console.log(`${mutant.padEnd(24)} ${String(result.failed.length).padStart(3)}/${result.total}  ${spread || "-"}`);
  }
  const atZero = Object.entries(mutantFailures).filter(([, count]) => count.total === 0).map(([name]) => name);
  if (atZero.length > 0) console.log(`\nat zero (recorded, not fixed): ${atZero.join(", ")}`);

  // 6. The record, only for a complete passing run.
  if (problems === 0 && only.length === 0) {
    const record: FuzzGateResult = {
      recordedAt: new Date().toISOString(),
      seed: generated.seed,
      generatorVersion: generated.generatorVersion,
      total: reference.total,
      referencePassed: reference.passed,
      fingerprint: fuzzOracleFingerprint(ROOT),
      mutantFailures,
    };
    writeFileSync(join(ROOT, FUZZ_GATE_RESULT_PATH), json(record));
    console.log(`\nwrote ${FUZZ_GATE_RESULT_PATH}`);
  }
  console.log(problems === 0 ? "\ngate P2-B passed" : `\ngate P2-B FAILED: ${problems} problem(s)`);
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
