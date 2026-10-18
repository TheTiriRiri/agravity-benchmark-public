/**
 * Attempt directory naming.
 *
 * `eval-attempts/<id>-attempt-<n>/` holds the model's output and
 * `eval-results/<id>-attempt-<n>/` the harness metadata and scores. Both
 * downstream stages recover the benchmark id and the attempt number by parsing
 * that directory name, so this module is the single definition of the
 * convention: `process-results.ts` and `take-screenshots.ts` import it rather
 * than each carrying their own copy of the regex.
 *
 * Underscores are forbidden in a benchmark id — the id is the greedy prefix
 * before `-attempt-<digits>`, and the character class is what keeps every id
 * uniform with the family ids used elsewhere in the pipeline.
 */

/** The directory-name grammar. Group 1 is the benchmark id, group 2 the attempt number. */
export const ATTEMPT_DIR_RE = /^([a-z0-9.-]+)-attempt-(\d+)$/;

/** A benchmark id on its own — the same character set as the directory prefix. */
export const BENCHMARK_ID_RE = /^[a-z0-9.-]+$/;

/**
 * The most attempts one configuration may run.
 *
 * Not a property of the runner — the bound comes from the other end of the
 * pipeline. `take-screenshots.ts` composes a configuration's filmstrip as one
 * Chromium page `panels x 1280` pixels wide, and Chromium's practical viewport
 * ceiling is 16384: 12 panels is 15360 and renders, 13 is 16640 and does not.
 * `runner.yaml` ships `attempts: 5`, so this is generous — it exists so that
 * `--attempts 20` fails at the flag, with the reason, rather than eight hours
 * later when the capture cannot compose a strip.
 */
export const MAX_ATTEMPTS_PER_CONFIG = 12;

export interface ParsedAttemptDir {
  /** The benchmark id, e.g. `gemini-38-flash-low` — effort suffix included. */
  modelId: string;
  attempt: number;
}

/**
 * Parse an attempt directory name. Returns `null` for anything that is not one,
 * so callers can filter a directory listing with it.
 */
export function parseAttemptDirName(name: string): ParsedAttemptDir | null {
  const match = ATTEMPT_DIR_RE.exec(name);
  if (match === null) return null;
  const attempt = Number(match[2]);
  if (!Number.isSafeInteger(attempt)) return null;
  return { modelId: match[1], attempt };
}

/**
 * Build an attempt directory name. Throws on an id or attempt number that would
 * produce a directory `parseAttemptDirName` could not read back — a silently
 * malformed name would only surface much later, as a missing row in the
 * dashboard.
 */
export function attemptDirName(id: string, attempt: number): string {
  if (!BENCHMARK_ID_RE.test(id)) {
    throw new Error(
      `invalid benchmark id ${JSON.stringify(id)}: must match ${BENCHMARK_ID_RE} (lowercase, no underscores)`,
    );
  }
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error(`invalid attempt number ${JSON.stringify(attempt)}: must be a positive integer`);
  }
  return `${id}-attempt-${attempt}`;
}
