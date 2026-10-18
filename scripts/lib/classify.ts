/**
 * Failure classification — deciding whether an attempt is a data point.
 *
 * The distinction matters more than it looks. A weekly Antigravity quota hit
 * partway through a 45-run matrix would otherwise record the remaining runs as
 * zeros that look like model failures, so anything that is the harness's or the
 * account's fault (`infra`) stops the matrix instead of being scored, while
 * anything that is the model's fault (`model`) is recorded and scores 0.
 *
 * Which channel is scanned for which signal is deliberate:
 *
 * - `stderr` is always scanned. agy prints its own diagnostics there
 *   (`Error: Please sign in…`, the soft-deny notice), and the model's output
 *   never reaches it.
 * - `envelope.status` and `envelope.error` are always scanned — the structured
 *   signals.
 * - `stdout` is scanned **only when the envelope did not parse and the run was
 *   not killed**. When the envelope parsed, stdout carries the model's own
 *   prose, and a generated website that talks about a "Please sign in" page
 *   would otherwise stop the whole matrix. A killed run — the outer timeout, or
 *   a signal — is the same hazard in worse form: stdout is then a partial,
 *   unterminated dump of that prose with no envelope to displace it, and the
 *   infra detectors run before the timeout check.
 *
 * A run that plainly succeeded short-circuits before the text detectors, so an
 * incidental warning on stderr cannot throw away a good attempt. A soft-deny is
 * the exception: it means a tool was blocked, which compromises the run whatever
 * the exit code says. So is `containerOrphaned`, which is not about this attempt
 * at all: it says the *next* one would run alongside a live session.
 *
 * One outcome is deliberately absent: an attempt the operator interrupted is
 * neither `model` nor `infra`. `run-matrix.ts` recognises that synchronously
 * from `spawnSync`'s result and writes no `run.json`, so it never reaches here.
 *
 * The patterns below were written before Phase 0 sign-in, so they match agy's
 * documented and observed messages rather than a full catalogue of its error
 * strings. Widen them once a real matrix run produces failures. Phase 0 did
 * settle the envelope's own shape: `status: "SUCCESS"`, not `subtype:
 * "success"`. The success test used to compare against the guess, which was
 * never true, so every clean attempt would have fallen through to
 * `agy exited 0 but the workspace is empty` or a text detector and scored 0.
 */

import type { FailureKind, RunEnvelope } from "./run-json";

export interface ClassifyInput {
  /** The process exit status; `null` when the process was killed by a signal. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** The parsed envelope, or `null` when stdout did not contain one. */
  envelope: RunEnvelope | null;
  /** True when the attempt directory holds nothing but agy's own project stub. */
  workspaceEmpty: boolean;
  /** True when brownfield attempt left the workspace identical to base codebase. */
  noDiffFromBase?: boolean;
  /** `docker` itself failed — not reachable, image missing, container error. */
  dockerError?: boolean;
  /** The outer docker timeout fired before agy's own `--print-timeout`. */
  outerTimeout?: boolean;
  /**
   * The container could not be confirmed gone after the client was killed. It
   * may still be running a second `agy` session on the same OAuth token and the
   * same weekly quota, which is the one thing the sequential design forbids.
   */
  containerOrphaned?: boolean;
}

export interface Classification {
  failureKind: FailureKind;
  /** True when stderr carries a soft-deny notice; always forces `infra`. */
  softDenied: boolean;
  /** True when the failure was a rate limit — the caller retries once, then stops. */
  rateLimited: boolean;
  /** One line naming the signal that decided the classification. */
  reason: string;
}

/**
 * Exit codes `run-attempt` reserves for its own contract errors (usage error,
 * unreadable prompt file, unknown argument). Reaching one means the runner
 * invoked the harness wrongly, which is infrastructure, not a model failure —
 * scoring it 0 would be a fake data point.
 *
 * The ambiguity to be aware of: `run-attempt` execs `agy`, so the exit code the
 * runner sees is `agy`'s own on every path past the argument parsing. If `agy`
 * ever exits 2, 3 or 5 for a *model* failure, that attempt is misfiled here as
 * infra and stops the whole matrix on what was a data point. The codes cannot be
 * told apart after the fact — an exit code carries no origin — so the check is
 * deliberately fail-closed: stopping on a model failure costs one manual restart,
 * whereas continuing through a real harness contract error would silently write
 * zeros for every remaining row. Phase 0 step 8 settles it by failing one run on
 * purpose (a bad `--model`) and reading the code; if it collides, renumber
 * `run-attempt`'s three codes into a range agy does not use and update this set.
 */
export const HARNESS_CONTRACT_EXIT_CODES = new Set([2, 3, 5]);

/** Docker CLI's own failure codes: daemon unreachable, cannot exec, not found. */
export const DOCKER_EXIT_CODES = new Set([125, 126, 127]);

/**
 * The envelope status agy reports for a run that finished normally.
 *
 * Verified against agy 1.1.26: `"SUCCESS"` on a completed run, `"ERROR"` with a
 * populated `error` string on a rejected one (a bad `--model`, an `--effort`
 * the model does not accept). Compared case-insensitively so a future lower-case
 * spelling does not silently discard every data point the way the pre-Phase-0
 * guess would have.
 */
const SUCCESS_STATUS = "success";

const SOFT_DENY_RE = /soft[-_ ]?den(?:y|ied|ial)/i;

const AUTH_RES = [
  /please sign in/i,
  /not signed in/i,
  /sign in to (?:view|use|continue)/i,
  /\bunauthenticated\b/i,
  /\bunauthorized\b/i,
  /authentication failed/i,
  /invalid credentials/i,
  /\b(?:status|code|http)\W{0,3}401\b/i,
  /(?:re-?authenticate|token (?:has )?expired|expired token)/i,
];

const RATE_LIMIT_RES = [
  /rate[-_ ]?limit/i,
  /quota (?:exceeded|exhausted)/i,
  /\bresource[-_ ]?exhausted\b/i,
  /too many requests/i,
  /\b(?:status|code|http)\W{0,3}429\b/i,
  /you(?:'ve| have) (?:reached|hit) your (?:weekly|daily|usage) limit/i,
];

/**
 * The provider refusing work because *it* is saturated, not because the account
 * is over its quota. agy can return "Our servers are experiencing high traffic
 * right now, please try again in a minute." in the envelope `error`, and with no
 * pattern to match it that lands in the `exitCode !== 0` fallback as a `model`
 * failure — a permanent zero recorded against the model for an outage on the
 * other side of the wire.
 *
 * These share `rateLimited` with the quota detectors, which is what the message
 * asks for: `RATE_LIMIT_RETRY_DELAY_MS` is 60s, so the retry lands about a
 * minute later.
 */
const SERVICE_OVERLOAD_RES = [
  /experiencing high traffic/i,
  /\b(?:server|service)s?\b[^.\n]{0,40}\b(?:overloaded|are busy|is busy|unavailable)\b/i,
  /\boverloaded[-_ ]?error\b/i,
  /\btemporarily unavailable\b/i,
  /\b(?:status|code|http)\W{0,3}5(?:02|03|29)\b/i,
];

/**
 * agy losing its own connection to the Antigravity server mid-run. agy can end a
 * long run whose workspace already holds a finished app with "There was a
 * network issue connecting to the server, please try again." and exit 0, so the
 * fallback would record a `model` failure worth 0. It is infra without the
 * one-minute retry: a dropped network is for the operator to check, the matrix
 * stops, and the resume rule re-runs the attempt.
 */
const NETWORK_LOSS_RES = [
  /\bnetwork (?:issue|error) connecting to the server\b/i,
];

const UNRESOLVED_MODEL_RES = [
  /unknown model/i,
  /model not found/i,
  /invalid model/i,
  /unrecognized model/i,
  /no such model/i,
  /model \S+ is not (?:available|supported)/i,
];

/**
 * Deliberately narrow: agy echoes its own `--print-timeout` flag, so a bare
 * /timeout/ would call every successful run a timeout.
 */
const TIMEOUT_RES = [
  /\btimed[-_ ]?out\b/i,
  /timeout (?:exceeded|reached|after|of)\b/i,
  /exceeded[^.\n]{0,24}timeout/i,
];

/**
 * The word "interrupted" in the envelope's `error` field. agy emits this when
 * it catches SIGINT inside the container: docker forwards the signal, agy
 * handles it gracefully, and exits with a clean code (0 or 1) and `status:
 * "ERROR"`. Because the exit code is not 128+N and `spawnSync` reports `signal:
 * null`, `detectInterrupt` does not recognise it. Without this detector the
 * envelope falls through to the generic ERROR handler and is recorded as
 * `failureKind: "model"` — a permanent zero the model never earned.
 *
 * The match is on the word "interrupted" (case-insensitive). It is deliberately
 * kept narrow: only the envelope's structured `error` field is checked, never
 * stdout or stderr at large, so a model that generates text about interruptions
 * cannot trigger it.
 */
const INTERRUPTED_RE = /\binterrupted\b/i;

/**
 * agy's own message when the model's response exceeded the output token limit.
 * Only the envelope's `error` field is checked — never `response`, stdout or
 * stderr — so a model that generates prose about token limits cannot trigger it.
 */
const OUTPUT_TOKEN_LIMIT_RE = /exceeded the output token limit/i;

/**
 * agy appends "Retries remaining: N" when it will (or has) retried the
 * truncated response. A value ≥ 1 means at least one retry was available and
 * agy continued the conversation; the workspace may hold a complete result.
 * "Retries remaining: 0" means every retry was spent and the run genuinely
 * failed — that stays `model`.
 */
const RETRIES_REMAINING_NONZERO_RE = /retries remaining:\s*[1-9]/i;

/**
 * Whether the envelope's `error` field describes a truncated response that agy
 * recovered from: the output token limit was hit, but at least one retry
 * remained, so agy continued the conversation. When the workspace is non-empty
 * and no other failure signal applies, the attempt is a data point — not a
 * model failure.
 */
export function detectTruncationRecovered(envelope: RunEnvelope | null): boolean {
  if (envelope === null) return false;
  return OUTPUT_TOKEN_LIMIT_RE.test(envelope.error) && RETRIES_REMAINING_NONZERO_RE.test(envelope.error);
}

export function detectSoftDeny(stderr: string): boolean {
  return SOFT_DENY_RE.test(stderr);
}

export function detectAuthError(text: string): boolean {
  return AUTH_RES.some((re) => re.test(text));
}

export function detectRateLimit(text: string): boolean {
  return RATE_LIMIT_RES.some((re) => re.test(text));
}

export function detectServiceOverload(text: string): boolean {
  return SERVICE_OVERLOAD_RES.some((re) => re.test(text));
}

export function detectNetworkLoss(text: string): boolean {
  return NETWORK_LOSS_RES.some((re) => re.test(text));
}

export function detectUnresolvedModel(text: string): boolean {
  return UNRESOLVED_MODEL_RES.some((re) => re.test(text));
}

/**
 * Whether the envelope's `error` field says the run was interrupted.
 *
 * This is the only way to recognise an operator interruption when docker
 * forwarded SIGINT into the container and agy caught it internally: the
 * process exited cleanly, so `detectInterrupt` (which reads `spawnSync`'s
 * `signal` and exit-code fields) sees nothing. The caller — `runOneAttempt`
 * in `run-matrix.ts` — throws `MatrixInterrupted` on a `true` here, so no
 * `run.json` is written and the resume rule re-runs the attempt.
 */
export function detectEnvelopeInterrupt(envelope: RunEnvelope | null): boolean {
  if (envelope === null) return false;
  return INTERRUPTED_RE.test(envelope.error);
}

/**
 * Classify one finished attempt. `infra` signals are checked before `model`
 * ones: an auth failure that also left an empty workspace is an auth failure.
 */
export function classifyFailure(input: ClassifyInput): Classification {
  const softDenied = detectSoftDeny(input.stderr);
  const haystack = signalText(input);
  const verdict = (failureKind: FailureKind, reason: string, rateLimited = false): Classification => ({
    failureKind,
    softDenied,
    rateLimited,
    reason,
  });

  if (input.dockerError === true) return verdict("infra", "docker error");
  if (input.exitCode !== null && DOCKER_EXIT_CODES.has(input.exitCode)) {
    return verdict("infra", `docker error (exit ${input.exitCode})`);
  }
  // Before everything else, including the outer-timeout classification that
  // would otherwise make this a `model` data point: a container that may still
  // be running is not a result, it is a second live session, and the matrix
  // must not continue into one.
  if (input.containerOrphaned === true) {
    return verdict("infra", "the container could not be confirmed removed after the kill");
  }
  if (softDenied) return verdict("infra", "soft-deny notice on stderr: a tool was blocked");

  // A run that plainly worked is a data point; do not let stray warning text
  // in the logs discard it.
  const cleanRun =
    input.exitCode === 0 &&
    input.outerTimeout !== true &&
    input.envelope !== null &&
    input.envelope.status.toLowerCase() === SUCCESS_STATUS &&
    !input.workspaceEmpty &&
    input.noDiffFromBase !== true;
  if (cleanRun) return verdict(null, "success");

  if (detectAuthError(haystack)) return verdict("infra", "auth error");
  if (detectRateLimit(haystack)) return verdict("infra", "quota / rate limit", true);
  if (detectServiceOverload(haystack)) {
    return verdict("infra", "the provider reported itself overloaded or unavailable", true);
  }
  if (detectUnresolvedModel(haystack)) return verdict("infra", "agy could not resolve --model");
  if (detectNetworkLoss(haystack)) return verdict("infra", "agy lost its network connection to the server");
  if (input.exitCode !== null && HARNESS_CONTRACT_EXIT_CODES.has(input.exitCode)) {
    return verdict("infra", `harness contract error (run-attempt exit ${input.exitCode})`);
  }

  if (input.outerTimeout === true) {
    return verdict("model", "outer docker timeout fired before agy's own --print-timeout");
  }
  if (detectTimeout(input, haystack)) return verdict("model", "agy timeout");
  if (input.exitCode === null) return verdict("model", "agy was killed by a signal");
  if (input.exitCode !== 0) return verdict("model", `agy exited ${input.exitCode}`);
  if (input.workspaceEmpty) return verdict("model", "agy exited 0 but the workspace is empty");
  if (input.noDiffFromBase === true) {
    return verdict("model", "agy exited 0 but made no changes to the base codebase");
  }
  // Last, because every infra detector above reads the same envelope and must
  // have first refusal on it: a rate limit and a provider overload both arrive
  // as ERROR too, and both have to stop the matrix rather than score a zero.
  // What is left here is an ERROR agy raised about the run itself — an output
  // token limit, on the run that found this — and exit 0 with a full workspace
  // hid it from both fallbacks below and above.
  //
  // Exception: a truncated response that agy recovered from. The envelope says
  // ERROR with "exceeded the output token limit" and "Retries remaining: N"
  // where N ≥ 1. agy injected a "Please continue" prompt, the model finished,
  // and the workspace holds a complete result. The human decision: this is a
  // data point scored normally, not a model failure.
  if (detectTruncationRecovered(input.envelope)) {
    return verdict(null, "agy reported a truncated response it recovered from; the workspace is scored");
  }
  if (input.envelope !== null && input.envelope.status.toLowerCase() !== SUCCESS_STATUS) {
    return verdict("model", `agy reported status ${input.envelope.status}: ${input.envelope.error || "no error text"}`);
  }

  return verdict(null, "success");
}

function detectTimeout(input: ClassifyInput, haystack: string): boolean {
  if (input.envelope !== null && /timeout/i.test(envelopeSignal(input.envelope))) return true;
  return TIMEOUT_RES.some((re) => re.test(haystack));
}

/**
 * The envelope's structured text: its status and, on a failure, agy's own error
 * string. `response` is deliberately excluded — that is the model's prose, and
 * scanning it is what would let a generated page about a "Please sign in" screen
 * stop the whole matrix.
 */
function envelopeSignal(envelope: RunEnvelope): string {
  return `${envelope.status}\n${envelope.error}`;
}

/**
 * The text the detectors scan. See the module comment for why stdout is only
 * included when there is no structured envelope to read instead, and not even
 * then if the run was killed mid-stream.
 */
function signalText(input: ClassifyInput): string {
  const parts = [input.stderr];
  if (input.envelope !== null) {
    parts.push(envelopeSignal(input.envelope));
  } else if (input.outerTimeout !== true && input.exitCode !== null) {
    parts.push(input.stdout);
  }
  return parts.join("\n");
}

export interface QuotaCheck {
  /** False stops the matrix before the attempt runs. */
  ok: boolean;
  /** The remaining quota percentage parsed out of the `/usage` output, or `null`. */
  remaining: number | null;
  reason: string;
}

/** One row of `agy -p "/usage"`: a per-model bucket and when it resets. */
export interface UsageRow {
  /** The pool the bucket belongs to, e.g. `All Models`. */
  pool: string;
  /** agy's display label, e.g. `Gemini 3.8 Flash (High)`. */
  label: string;
  /** Percent of the allowance still available, 0-100. */
  percent: number;
  /** The reset timestamp agy prints, verbatim; `""` when it printed none. */
  resetsAt: string;
}

/**
 * Parse `agy -p "/usage"` into its per-model rows.
 *
 * Verified against agy 1.1.26. The real format is one tab-separated record per
 * model, with no header and no `remaining` label anywhere:
 *
 * ```
 * All Models\tGemini 3.8 Flash (High)\t94%\t2030-03-04T09:20:11Z
 * All Models\tClaude Opus 4.6 (Thinking)\t91%\t2030-03-04T08:05:37Z
 * ```
 *
 * Quota is **per model**, not one number: the buckets above differed by three
 * points and reset at different times on the same account. The pre-Phase-0
 * version of this parser looked for the word `remaining` and so returned `null`
 * for every real reading.
 */
export function parseUsageRows(usageOutput: string): UsageRow[] {
  const rows: UsageRow[] = [];
  for (const line of usageOutput.split(/\r?\n/)) {
    const fields = line.split("\t").map((field) => field.trim());
    if (fields.length < 3) continue;
    const percent = toNumber(fields[2]);
    if (percent === null || !/%\s*$/.test(fields[2])) continue;
    rows.push({ pool: fields[0], label: fields[1], percent, resetsAt: fields[3] ?? "" });
  }
  return rows;
}

/**
 * The remaining quota to gate on, as a percentage.
 *
 * With `label`, the bucket for that model; without it, the **lowest** bucket in
 * the output. The unlabelled reading is deliberately conservative: it can stop a
 * matrix whose own model still has room because some other model's bucket is
 * low. That is the safe direction for an unattended sequential run, and it is
 * why `run-matrix` passes the row's `usageLabel` and the config loader refuses a
 * numeric `quotaFloor` on a row without one.
 *
 * Returns `null` when nothing parsed; `checkQuotaFloor` treats that as a stop,
 * so an unrecognised format can never let the matrix run past a floor.
 */
export function parseUsageRemaining(usageOutput: string, label?: string): number | null {
  const rows = parseUsageRows(usageOutput);
  if (rows.length === 0) return null;
  if (label !== undefined) {
    const match = rows.find((row) => row.label.toLowerCase() === label.toLowerCase());
    return match === undefined ? null : match.percent;
  }
  return Math.min(...rows.map((row) => row.percent));
}

/** Apply `runner.yaml`'s `quotaFloor` to one `/usage` output. */
export function checkQuotaFloor(usageOutput: string, floor: number | null, label?: string): QuotaCheck {
  const remaining = parseUsageRemaining(usageOutput, label);
  if (floor === null) {
    return { ok: true, remaining, reason: "quotaFloor is null — /usage logged, not enforced" };
  }
  if (remaining === null && label !== undefined) {
    const labels = parseUsageRows(usageOutput).map((row) => row.label);
    if (labels.length > 0) {
      return {
        ok: false,
        remaining: null,
        reason:
          `quotaFloor is ${floor} but no /usage row is labelled ${JSON.stringify(label)} ` +
          `(labels: ${labels.map((l) => JSON.stringify(l)).join(", ")}). Fix the row's usageLabel in runner.yaml.`,
      };
    }
  }
  if (remaining === null) {
    return {
      ok: false,
      remaining: null,
      reason:
        `quotaFloor is ${floor} but no remaining quota could be parsed out of the /usage output. ` +
        "Update parseUsageRemaining in scripts/lib/classify.ts against the real output, or set quotaFloor: null.",
    };
  }
  if (remaining < floor) {
    return { ok: false, remaining, reason: `remaining quota ${remaining} is below quotaFloor ${floor}` };
  }
  return { ok: true, remaining, reason: `remaining quota ${remaining} is at or above quotaFloor ${floor}` };
}

function toNumber(text: string): number | null {
  const cleaned = text.trim().replace(/%$/, "").replace(/,/g, "");
  if (!/^-?\d+(?:\.\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}
