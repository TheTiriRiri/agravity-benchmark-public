/**
 * `eval-results/<id>-attempt-<n>/run.json` — the harness metadata for one
 * attempt.
 *
 * The runner writes it; the scoring skill, `process-results.ts` and
 * `take-screenshots.ts` read it. The field list is fixed by the project's
 * global constraints: do not add or rename fields here without changing them
 * there first, because everything downstream is regenerable from these files
 * and a schema drift would be invisible until the dashboard renders wrong.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Token counts as reported by the agy JSON envelope.
 *
 * The field names are agy's own, verified against a real 1.1.26 run in Phase 0:
 * `{input_tokens, output_tokens, thinking_tokens, cache_read_tokens,
 * total_tokens}`. An earlier draft of this file guessed `reasoning_tokens`,
 * which agy does not emit — it would have silently read 0 for every run.
 *
 * Two relationships were measured on a real envelope that used every field, and
 * the cost formula in `eval-attempts/metadata.ts` depends on both:
 *
 * - `total_tokens === input_tokens + output_tokens`, and `cache_read_tokens` is
 *   **outside** that sum, so pricing cache reads separately does not
 *   double-charge them.
 * - `thinking_tokens < output_tokens`, consistent with thinking being a subset
 *   of output rather than a separate bucket, so it carries no rate of its own.
 */
export interface RunUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  thinking_tokens: number;
  total_tokens: number;
}

/**
 * The subset of agy's `--output-format json` envelope that we keep.
 *
 * Verified against agy 1.1.26 in Phase 0. The envelope is
 * `{conversation_id, status, response, duration_seconds, num_turns, usage}`,
 * plus `error` on a failure. Note `status: "SUCCESS"` (upper case) rather than
 * a `subtype`, and `duration_seconds` as a float rather than `duration_ms` —
 * both were guessed wrong before sign-in, and `classifyFailure` compared
 * against the guess, so every clean run would have been filed as a model
 * failure scoring 0.
 */
export interface RunEnvelope {
  status: string;
  num_turns: number;
  duration_seconds: number;
  usage: RunUsage | null;
  conversation_id: string | null;
  /** agy's own error string on a failed run; `""` on success. */
  error: string;
  /**
   * The last RESPONSE_TAIL_BYTES bytes of agy's `response`, or `null` when the
   * envelope carried no `response` field at all — which is every run.json
   * written before 2026-09-21, since `response` was parsed and dropped.
   *
   * It exists to answer one question (spec 2026-09-21 §1.1, §5): when a turn
   * ends with `status: "SUCCESS"`, `num_turns: 1` and an output-token count at
   * the 9-12.5k ceiling while the workspace is half-written, did the model
   * claim it had finished, or was it cut off? `status` cannot say: it is agy's
   * word for "the turn ended without an error", which a truncated turn also is.
   */
  responseTail: string | null;
}

/**
 * `null` — the attempt is a clean data point.
 * `"model"` — the model failed (timeout, crash, empty workspace); scores 0.
 * `"infra"` — the harness or the account failed (auth, quota, docker,
 * unresolved model id, soft-deny); not a data point, and it stops the matrix.
 */
export type FailureKind = null | "model" | "infra";

export interface RunJson {
  /** Benchmark id, e.g. `gemini-38-flash-low`. */
  id: string;
  /** The CLI model id passed to `agy --model`. */
  model: string;
  /**
   * The `--effort` level, or `null` for a model that does not accept the flag.
   *
   * agy 1.1.26 rejects `--effort` outright for `claude-sonnet-4-6`,
   * `claude-opus-4-6-thinking` and `gpt-oss-120b-medium`
   * (`--effort is not supported for model "…"`, exit 1), so those rows carry
   * `null` and the runner omits the flag.
   */
  effort: string | null;
  agyVersion: string;
  /** `<tag>@<resolved image Id>` — a locally built image has no registry digest. */
  image: string;
  startedAt: string;
  durationMs: number;
  exitCode: number | null;
  envelope: RunEnvelope | null;
  stderrTail: string;
  softDenied: boolean;
  failureKind: FailureKind;
  noDiffFromBase?: boolean;
  /**
   * Present only when `reclassify-runs.ts` changed `failureKind` after the
   * original run. Records what it was, when it changed, and why. The runner
   * never writes this; only the reclassifier does.
   */
  reclassified?: {
    from: FailureKind;
    at: string;
    reason: string;
  };
}

/** How much of stderr `stderrTail` keeps. */
export const STDERR_TAIL_BYTES = 4096;

/**
 * How much of agy's `response` `envelope.responseTail` keeps. The same budget
 * as stderr's, defined in terms of it so the two cannot drift apart: a
 * completion claim sits at the *end* of a final message, after any file
 * listing, so the tail is the informative end here too.
 */
export const RESPONSE_TAIL_BYTES = STDERR_TAIL_BYTES;

/** Last `maxBytes` bytes of `text`, measured in bytes rather than characters. */
export function tailBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  return buffer.subarray(buffer.length - maxBytes).toString("utf8");
}

/**
 * Last `maxBytes` bytes of stderr. A soft-deny notice or an auth error is the
 * last thing agy prints, so the tail is the informative end.
 */
export function stderrTail(stderr: string, maxBytes: number = STDERR_TAIL_BYTES): string {
  return tailBytes(stderr, maxBytes);
}

const ENVELOPE_KEYS = ["status", "num_turns", "duration_seconds", "usage", "conversation_id", "response"];

/**
 * Parse agy's stdout into an envelope, or `null` when it does not contain one.
 *
 * `--output-format json` prints a single object, but a crashed or truncated run
 * can leave other text around it, so the whole payload is tried first and then
 * individual lines from the end (which also covers a `stream-json` tail).
 */
export function parseEnvelope(stdout: string): RunEnvelope | null {
  const whole = tryEnvelope(stdout);
  if (whole !== null) return whole;
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const candidate = tryEnvelope(lines[i]);
    if (candidate !== null) return candidate;
  }
  return null;
}

function tryEnvelope(text: string): RunEnvelope | null {
  const trimmed = text.trim();
  if (trimmed === "" || !trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  // Guard against latching onto some unrelated JSON the model happened to print.
  if (!ENVELOPE_KEYS.some((key) => key in parsed)) return null;
  return {
    status: typeof parsed.status === "string" ? parsed.status : "",
    num_turns: finiteOr(parsed.num_turns, 0),
    duration_seconds: finiteOr(parsed.duration_seconds, 0),
    usage: toUsage(parsed.usage),
    conversation_id: typeof parsed.conversation_id === "string" ? parsed.conversation_id : null,
    error: typeof parsed.error === "string" ? parsed.error : "",
    responseTail: typeof parsed.response === "string" ? tailBytes(parsed.response, RESPONSE_TAIL_BYTES) : null,
  };
}

function toUsage(value: unknown): RunUsage | null {
  if (!isRecord(value)) return null;
  return {
    input_tokens: finiteOr(value.input_tokens, 0),
    output_tokens: finiteOr(value.output_tokens, 0),
    cache_read_tokens: finiteOr(value.cache_read_tokens, 0),
    thinking_tokens: finiteOr(value.thinking_tokens, 0),
    total_tokens: finiteOr(value.total_tokens, 0),
  };
}

/** Read and validate a `run.json`. Throws with the path on anything malformed. */
export function readRunJson(path: string): RunJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path}: not valid JSON: ${(error as Error).message}`);
  }
  return normalizeRunJson(parsed, path);
}

/**
 * Whether a scoring tool may use the attempt whose results directory is
 * `resultsDir`, by its `run.json`: `{run}` to go on, or `{refusal}` saying why
 * not — no `run.json` (a real attempt has one), one that cannot be read, or one
 * recording `infra`, a soft-deny or `failureKind: "model"`. `without` ends the
 * last message: what the all-zero CSV is written without (`contract-tests`,
 * `serving it`). `contract-tests` and `serve-attempt` both admit by this.
 */
export function runJsonRefusal(resultsDir: string, without: string): { refusal: string } | { run: RunJson } {
  const runJsonPath = join(resultsDir, "run.json");
  if (!isFile(runJsonPath)) {
    return { refusal: `no run.json at ${runJsonPath}. A real attempt has one; pass --ignore-run-json only for a synthetic attempt.` };
  }
  let run: RunJson;
  try {
    run = readRunJson(runJsonPath);
  } catch (error) {
    return { refusal: `cannot use ${runJsonPath}: ${(error as Error).message}` };
  }
  if (run.failureKind === "infra") {
    return { refusal: `${runJsonPath} records an infra failure: the attempt is not a data point. Rerun the attempt; do not score it.` };
  }
  if (run.softDenied) {
    return { refusal: `${runJsonPath} records a soft-deny: a tool was blocked, so the attempt is not a data point. Rerun it; do not score it.` };
  }
  if (run.failureKind === "model") {
    return { refusal: `${runJsonPath} records failureKind "model": the attempt scores 0 whatever is on disk, and its CSV is all zero without ${without}.` };
  }
  return { run };
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Write a `run.json`, creating its directory. Validates before writing. */
export function writeRunJson(path: string, value: RunJson): void {
  const normalized = normalizeRunJson(value, path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

/**
 * Validate against the fixed schema and rebuild, so unknown fields never reach
 * disk or a downstream consumer.
 */
function normalizeRunJson(value: unknown, path: string): RunJson {
  if (!isRecord(value)) throw new Error(`${path}: expected a JSON object`);
  const fail = (message: string): never => {
    throw new Error(`${path}: ${message}`);
  };

  for (const key of ["id", "model", "agyVersion", "image", "startedAt", "stderrTail"]) {
    if (typeof value[key] !== "string") fail(`${key} must be a string`);
  }
  if (value.effort !== null && typeof value.effort !== "string") fail("effort must be a string or null");
  if (typeof value.durationMs !== "number" || !Number.isFinite(value.durationMs)) {
    fail("durationMs must be a finite number");
  }
  if (value.exitCode !== null && (typeof value.exitCode !== "number" || !Number.isFinite(value.exitCode))) {
    fail("exitCode must be a number or null");
  }
  if (typeof value.softDenied !== "boolean") fail("softDenied must be a boolean");
  if (value.failureKind !== null && value.failureKind !== "model" && value.failureKind !== "infra") {
    fail('failureKind must be null, "model" or "infra"');
  }
  if (value.noDiffFromBase !== undefined && typeof value.noDiffFromBase !== "boolean") {
    fail("noDiffFromBase must be a boolean");
  }

  let envelope: RunEnvelope | null = null;
  if (value.envelope !== null && value.envelope !== undefined) {
    if (!isRecord(value.envelope)) fail("envelope must be an object or null");
    const raw = value.envelope as Record<string, unknown>;
    if (typeof raw.status !== "string") fail("envelope.status must be a string");
    if (raw.responseTail !== undefined && raw.responseTail !== null && typeof raw.responseTail !== "string") {
      fail("envelope.responseTail must be a string or null");
    }
    envelope = {
      status: raw.status as string,
      num_turns: finiteOr(raw.num_turns, 0),
      duration_seconds: finiteOr(raw.duration_seconds, 0),
      usage: toUsage(raw.usage),
      conversation_id: typeof raw.conversation_id === "string" ? raw.conversation_id : null,
      error: typeof raw.error === "string" ? raw.error : "",
      // Truncated again on the way in: the field is only ever as trustworthy as
      // the file, and an oversized one would put an unbounded model-authored
      // string into every downstream consumer.
      responseTail: typeof raw.responseTail === "string" ? tailBytes(raw.responseTail, RESPONSE_TAIL_BYTES) : null,
    };
  }

  const runJson: RunJson = {
    id: value.id as string,
    model: value.model as string,
    effort: value.effort as string | null,
    agyVersion: value.agyVersion as string,
    image: value.image as string,
    startedAt: value.startedAt as string,
    durationMs: value.durationMs as number,
    exitCode: value.exitCode as number | null,
    envelope,
    stderrTail: value.stderrTail as string,
    softDenied: value.softDenied as boolean,
    failureKind: value.failureKind as FailureKind,
  };
  if (typeof value.noDiffFromBase === "boolean") {
    runJson.noDiffFromBase = value.noDiffFromBase;
  }
  if (value.reclassified !== undefined) {
    if (!isRecord(value.reclassified)) fail("reclassified must be an object");
    const rc = value.reclassified as Record<string, unknown>;
    if (rc.from !== null && rc.from !== "model" && rc.from !== "infra") {
      fail('reclassified.from must be null, "model" or "infra"');
    }
    if (typeof rc.at !== "string") fail("reclassified.at must be a string");
    if (typeof rc.reason !== "string") fail("reclassified.reason must be a string");
    runJson.reclassified = { from: rc.from as FailureKind, at: rc.at as string, reason: rc.reason as string };
  }
  return runJson;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
