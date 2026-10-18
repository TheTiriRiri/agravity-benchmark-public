/**
 * Runs runContractFile outside any node:test context and prints one JSON line:
 * the result or the error, plus the environment around the call.
 *
 *   driver.ts <file> <timeoutMs> <expectedTests> [baseUrl] [seedPath]
 */
import { ContractHarnessError, runContractFile } from "../../../scripts/lib/contract-suite";

const [file, timeoutMs, expectedTests, baseUrl = "http://127.0.0.1:9", seedPath = "unused"] = process.argv.slice(2);
const WATCHED = ["CONTRACT_BASE_URL", "CONTRACT_SEED_PATH", "NODE_OPTIONS"];
const snapshot = () => JSON.stringify(Object.entries(process.env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const watched = () => Object.fromEntries(WATCHED.map((key) => [key, process.env[key] ?? null]));
const before = snapshot();
const watchedBefore = watched();

function report(outcome: object, code: number): void {
  console.log(JSON.stringify({ ...outcome, envUnchanged: snapshot() === before, envBefore: watchedBefore, envAfter: watched() }));
  process.exit(code);
}

runContractFile({ file, baseUrl, seedPath, timeoutMs: Number(timeoutMs), expectedTests: Number(expectedTests) }).then(
  (result) => report({ result }, 0),
  (error) => {
    console.error(String(error.message));
    report(
      {
        error: {
          name: error.name,
          harness: error instanceof ContractHarnessError,
          message: String(error.message),
          file: error instanceof ContractHarnessError ? error.file : null,
          stderrTail: error instanceof ContractHarnessError ? error.stderrTail : null,
        },
      },
      1,
    );
  },
);
