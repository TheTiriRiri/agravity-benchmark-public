/**
 * Runs one hidden contract-test file against a live backend and counts the
 * outcome. Two callers: the reference gate (`scripts/reference-gate.ts`) and
 * the scorer (`scripts/contract-tests.ts`). A gate-2 input: editing this file
 * means re-running `npm run gate:reference`.
 *
 * The file runs in its own node process (node:test's default isolation), so a
 * test that hangs or crashes cannot take the caller down with it.
 *
 * What the caller gets back is only ever the model's result. Anything that
 * means the test file itself did not run as written — a throw at module level,
 * a failed import, a crash, a skipped test, more tests than the manifest
 * promises, tests that vanished without the timer firing — is thrown as a
 * ContractHarnessError instead of being scored as the model's failures.
 * Event shapes were probed on node v24.14.0.
 */
import { run } from "node:test";
import type { TestEvent } from "node:test/reporters";

export interface FailedTest {
  name: string;
  /** node:test's failureType: `testCodeFailure`, `hookFailed`, … */
  failureType: string;
  message: string;
}

export interface ContractFileResult {
  /** The path as the caller passed it. */
  file: string;
  /** Always max(reported, expectedTests), so a file cut short still scores out of the manifest's count. */
  total: number;
  passed: number;
  /** Tests that ran and failed. */
  failed: FailedTest[];
  /** Tests the per-file timer cut off before they reported: expectedTests - reported. */
  notRun: number;
  /** How many of `failed` failed in a hook (`beforeEach(reset)`), not in the test's own body. */
  hookFailed: number;
  /** The per-file timer fired and the run was aborted. */
  timedOut: boolean;
}

export interface RunContractFileOptions {
  file: string;
  baseUrl: string;
  seedPath: string;
  timeoutMs: number;
  /** From the manifest. A file that dies early still scores out of this many. */
  expectedTests: number;
}

/**
 * The test file, not the backend, is at fault: nothing about this run may be
 * scored. `stderrTail` is the end of what the file wrote to stderr.
 */
export class ContractHarnessError extends Error {
  readonly file: string;
  readonly stderrTail: string;

  constructor(file: string, reason: string, stderrTail: string) {
    super(`${file}: ${reason}; a harness fault, not the model's${stderrTail ? `\n--- stderr tail ---\n${stderrTail}` : ""}`);
    this.name = "ContractHarnessError";
    this.file = file;
    this.stderrTail = stderrTail;
  }
}

const ENV_KEYS = ["CONTRACT_BASE_URL", "CONTRACT_SEED_PATH", "NODE_OPTIONS"] as const;
/** Cap on one failure message: a backend can put anything in a body the message quotes. */
const MESSAGE_LIMIT = 2_000;
const STDERR_KEEP = 16_384;
const STDERR_TAIL_LINES = 30;
/** Leaf failures that mean "did not finish", not "failed". */
const UNFINISHED = new Set(["testAborted", "cancelledByParent"]);

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trimEnd() : null;
}

function capped(text: string): string {
  return text.length <= MESSAGE_LIMIT ? text : `${text.slice(0, MESSAGE_LIMIT)}… (${text.length - MESSAGE_LIMIT} more characters)`;
}

/**
 * The first non-empty of `error.cause.message`, the first line of
 * `error.cause.stack` and `error.message`. For a hook failure the error's own
 * message is the constant "failed running beforeEach hook"; a fetch timeout's
 * DOMException arrives with an empty `message` but a `TimeoutError: …` stack.
 */
function failureMessage(error: unknown, failureType: string): string {
  const outer = (error ?? {}) as { message?: unknown; cause?: unknown };
  const cause = (outer.cause !== null && typeof outer.cause === "object" ? outer.cause : {}) as { message?: unknown; stack?: unknown };
  const stackLine = typeof cause.stack === "string" ? cause.stack.split("\n")[0] : undefined;
  const found = nonEmpty(cause.message) ?? nonEmpty(stackLine) ?? nonEmpty(outer.message);
  return capped(found ?? `(${failureType}, no message)`);
}

function failureTypeOf(error: unknown): string {
  const type = (error as { failureType?: unknown } | undefined)?.failureType;
  return typeof type === "string" && type !== "" ? type : "unknown";
}

function tailOf(stderr: string): string {
  return stderr.trimEnd().split("\n").slice(-STDERR_TAIL_LINES).join("\n");
}

export async function runContractFile(options: RunContractFileOptions): Promise<ContractFileResult> {
  const result: ContractFileResult = { file: options.file, total: 0, passed: 0, failed: [], notRun: 0, hookFailed: 0, timedOut: false };
  let reported = 0;
  let stderr = "";
  let harnessFault: string | null = null;

  // The child inherits process.env: `run()` has no per-call env before node
  // 25.6, and the loader must reach the child too. Restored in `finally`, so
  // the caller can spawn node/npm afterwards; still one backend at a time —
  // never call this for two backends concurrently.
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const);
  const controller = new AbortController();
  const timer = setTimeout(() => {
    result.timedOut = true;
    controller.abort();
  }, options.timeoutMs);

  try {
    process.env.CONTRACT_BASE_URL = options.baseUrl;
    process.env.CONTRACT_SEED_PATH = options.seedPath;
    const nodeOptions = process.env.NODE_OPTIONS ?? "";
    if (!nodeOptions.includes("--import tsx")) process.env.NODE_OPTIONS = `${nodeOptions} --import tsx`.trim();

    const stream = run({ files: [options.file], concurrency: 1, signal: controller.signal });
    for await (const event of stream as AsyncIterable<TestEvent>) {
      if (event.type === "test:stderr") {
        stderr = (stderr + event.data.message).slice(-STDERR_KEEP);
        continue;
      }
      if (event.type !== "test:pass" && event.type !== "test:fail") continue;
      const data = event.data;
      if (data.details.type === "suite") continue;
      // node reports the file itself as a test named by the path exactly as
      // passed, only when it did not end normally.
      if (data.name === options.file) {
        if (event.type !== "test:fail" || harnessFault !== null) continue;
        const failureType = failureTypeOf(event.data.details.error);
        // Our abort (the timer) is the timeout path. Anything else — a module
        // throw, a failed import, a crash, a stray rejection — is the file's.
        if (!result.timedOut && failureType !== "testAborted") {
          const { exitCode, signal } = (event.data.details.error ?? {}) as { exitCode?: unknown; signal?: unknown };
          harnessFault = `the test file itself failed (${failureType}${exitCode != null ? `, exit code ${exitCode}` : ""}${signal ? `, signal ${signal}` : ""}), so none of its tests can be scored`;
        }
        continue;
      }
      if (data.skip !== undefined || data.todo !== undefined) {
        harnessFault ??= `test "${data.name}" is marked skip or todo; a hidden test must run, or a skip would score as a pass`;
        continue;
      }
      if (event.type === "test:pass") {
        reported += 1;
        result.passed += 1;
        continue;
      }
      const error = event.data.details.error;
      const failureType = failureTypeOf(error);
      if (UNFINISHED.has(failureType)) continue;
      reported += 1;
      result.failed.push({ name: data.name, failureType, message: failureMessage(error, failureType) });
      if (failureType === "hookFailed") result.hookFailed += 1;
    }
  } finally {
    clearTimeout(timer);
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  if (harnessFault !== null) throw new ContractHarnessError(options.file, harnessFault, tailOf(stderr));
  if (reported > options.expectedTests) {
    throw new ContractHarnessError(
      options.file,
      `ran ${reported} tests but the manifest says ${options.expectedTests}; update the manifest`,
      tailOf(stderr),
    );
  }
  // A timeout mid-file leaves tests unreported. They count as failed: scoring
  // out of the tests that happened to run would reward hanging early.
  result.notRun = options.expectedTests - reported;
  result.total = Math.max(reported, options.expectedTests);
  if (result.notRun > 0 && !result.timedOut) {
    throw new ContractHarnessError(
      options.file,
      `${result.notRun} of ${options.expectedTests} tests never reported and the file did not time out`,
      tailOf(stderr),
    );
  }
  return result;
}
