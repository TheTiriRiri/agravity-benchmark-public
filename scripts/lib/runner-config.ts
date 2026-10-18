/**
 * `benchmark/runner.yaml` — loading and validating the matrix definition.
 *
 * Everything here fails closed. A matrix run costs hours of agent time and a
 * large slice of a weekly Antigravity quota, so a typo in the config has to
 * surface before the first container starts, not after the twentieth.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import { BENCHMARK_ID_RE, MAX_ATTEMPTS_PER_CONFIG } from "./attempts";

export type Effort = "low" | "medium" | "high";

export const EFFORTS: readonly Effort[] = ["low", "medium", "high"];

export interface MatrixRow {
  /** Benchmark id, effort suffix included, e.g. `gemini-36-flash-low`. */
  id: string;
  /** The CLI model id passed to `agy --model`. */
  model: string;
  /**
   * The `--effort` level, or `null` for a model that does not accept the flag.
   *
   * agy 1.1.26 makes this a hard error either way: `claude-sonnet-4-6`,
   * `claude-opus-4-6-thinking` and `gpt-oss-120b-medium` reject `--effort`
   * outright, and an effort-suffixed id like `gemini-3.8-flash-low` rejects any
   * `--effort` that disagrees with its suffix. Rows for those models carry
   * `null` and the runner omits the flag; the row's own `id` still carries an
   * effort suffix, because that suffix is the directory name and the dashboard
   * label, not a CLI argument.
   */
  effort: Effort | null;
  /** The family this row aggregates into, e.g. `gemini-36-flash`. */
  family: string;
  /**
   * The model's label in agy's `/usage` table, e.g. `Claude Sonnet 4.6 (Thinking)`,
   * or `null`. The quota floor reads this model's own bucket through it; without
   * it the floor would read the lowest bucket on the account and could stop a
   * matrix whose model still has room. Required on every row once `quotaFloor`
   * is a number.
   */
  usageLabel: string | null;
}

export interface RunnerConfig {
  /** The harness image tag; the runner resolves and records its image Id at run time. */
  image: string;
  agyVersion: string;
  /** The model that runs the scoring skill — cross-era comparisons need the same judge. */
  judge: string;
  /**
   * The rubric id, `maintenance-console@<12 hex digits>`: a content hash of the
   * files in `RUBRIC_ID_INPUTS`, computed by `rubricId()` in
   * `scripts/lib/rubric.ts`. `test/rubric-id.test.ts` keeps this value equal to
   * it; the loader only requires a non-empty string.
   */
  rubric: string;
  /** Outer docker timeout, in ms. Must exceed `printTimeout`. */
  timeoutMs: number;
  /** agy's own `--print-timeout`, as a duration string. */
  printTimeout: string;
  attempts: number;
  /**
   * `null` logs `/usage` and proceeds; a number (a percentage) stops the matrix
   * when the bucket of the row about to run, found by its `usageLabel`, is below it.
   */
  quotaFloor: number | null;
  /** The files copied out of the `agy-creds` volume into each attempt's HOME. */
  credentialFiles: string[];
  matrix: MatrixRow[];
  /**
   * Set while the repo is knowingly inconsistent — a new task with the old
   * image, say. The matrix refuses to start and prints this reason; only
   * `--dry-run` loads a held config. The plan that resolves the reason removes
   * the key; nothing else should.
   */
  hold: string | null;
}

export interface LoadRunnerConfigOptions {
  /** Restrict the placeholder check to these ids; empty or absent means all rows. */
  only?: string[];
  /** `--dry-run` only: tolerate `TODO` placeholders because nothing will run. */
  allowPlaceholders?: boolean;
}

/** Values that still need Phase 0 sign-in carry this marker. */
export const PLACEHOLDER_MARKER = "TODO";

const PHASE_0_HINT =
  "Complete Phase 0 (sign in inside the harness container, then `run-attempt --models`) and fill " +
  "the real values in. `--dry-run` exercises the runner without them.";

/**
 * Load, validate and return the config. Throws — with the config path in every
 * message — on any malformed field, on an unknown `--only` id, and, unless
 * `allowPlaceholders`, on a `TODO` placeholder in a selected row or in
 * `credentialFiles`.
 */
export function loadRunnerConfig(path: string, options: LoadRunnerConfigOptions = {}): RunnerConfig {
  const raw = loadYaml(readFileSync(path, "utf8"), { filename: path });
  const fail = (message: string): never => {
    throw new Error(`${path}: ${message}`);
  };
  if (!isRecord(raw)) fail("expected a YAML mapping at the top level");
  const doc = raw as Record<string, unknown>;

  const config: RunnerConfig = {
    image: requireString(doc, "image", fail),
    agyVersion: requireString(doc, "agyVersion", fail),
    judge: requireString(doc, "judge", fail),
    rubric: requireString(doc, "rubric", fail),
    timeoutMs: requirePositiveInt(doc, "timeoutMs", fail),
    printTimeout: requireString(doc, "printTimeout", fail),
    attempts: requirePositiveInt(doc, "attempts", fail),
    quotaFloor: requireQuotaFloor(doc, fail),
    credentialFiles: requireCredentialFiles(doc, fail),
    matrix: requireMatrix(doc, fail),
    hold: doc.hold === undefined || doc.hold === null ? null : requireString(doc, "hold", fail),
  };

  if (config.quotaFloor !== null) {
    const unlabelled = config.matrix.filter((row) => row.usageLabel === null).map((row) => row.id);
    if (unlabelled.length > 0) {
      fail(
        `quotaFloor is ${config.quotaFloor}, so every matrix row needs a usageLabel (its label in agy's /usage table); ` +
          `missing on ${unlabelled.join(", ")}`,
      );
    }
  }

  if (config.attempts > MAX_ATTEMPTS_PER_CONFIG) {
    fail(
      `attempts (${config.attempts}) is above the ${MAX_ATTEMPTS_PER_CONFIG}-attempt ceiling; ` +
        "`npm run screenshots` cannot compose a filmstrip that wide (see MAX_ATTEMPTS_PER_CONFIG in " +
        "scripts/lib/attempts.ts)",
    );
  }

  const printTimeoutMs = parseDurationMs(config.printTimeout, (message) => fail(`printTimeout: ${message}`));
  if (config.timeoutMs <= printTimeoutMs) {
    fail(
      `timeoutMs (${config.timeoutMs}) must exceed printTimeout (${config.printTimeout} = ${printTimeoutMs}ms), ` +
        "otherwise docker kills the container before agy can report its own timeout status and the run is " +
        "recorded as an infrastructure failure instead of a model timeout",
    );
  }

  const selected = selectMatrixRows(config, options.only, fail);
  if (options.allowPlaceholders !== true) {
    if (config.hold !== null) {
      fail(`the matrix is on hold: ${config.hold} \`--dry-run\` still works.`);
    }
    for (const row of selected) {
      if (hasPlaceholder(row.model)) {
        fail(
          `matrix row "${row.id}" still has the placeholder model id ${JSON.stringify(row.model)}. ` +
            `The real Antigravity CLI model ids are only discoverable from a signed-in agy. ${PHASE_0_HINT}`,
        );
      }
    }
    for (const file of config.credentialFiles) {
      if (hasPlaceholder(file)) {
        fail(
          `credentialFiles still has the placeholder entry ${JSON.stringify(file)}. ` +
            `The agy token filename is only discoverable after Phase 0 sign-in. ${PHASE_0_HINT}`,
        );
      }
    }
  }

  return config;
}

/**
 * `image` from the repository's `benchmark/runner.yaml`, for the scoring tools
 * (`contract-tests`, `serve-attempt`, `take-screenshots`, the backend gate):
 * an attempt's backend is scored in the image the matrix runs attempts in.
 *
 * It reads that one key and nothing else. `hold` is ignored — scoring has to
 * work while the matrix is held — and so is every other key; nothing returned
 * here can start a matrix, and `loadRunnerConfig` keeps refusing a held config.
 * `repoRoot` is the repository's root, never a scoring `--root`: the image is
 * the repository's, not the scored tree's.
 */
export function readScoringImage(repoRoot: string): string {
  const path = join(repoRoot, "benchmark", "runner.yaml");
  const raw = loadYaml(readFileSync(path, "utf8"), { filename: path });
  const fail = (message: string): never => {
    throw new Error(`${path}: ${message}`);
  };
  if (!isRecord(raw)) fail("expected a YAML mapping at the top level");
  return requireString(raw as Record<string, unknown>, "image", fail);
}

/**
 * The rows a run covers. `only` empty or absent means the whole matrix; an
 * unknown id is an error rather than a silent no-op.
 */
export function selectMatrixRows(
  config: RunnerConfig,
  only?: string[],
  fail: (message: string) => never = (message) => {
    throw new Error(message);
  },
): MatrixRow[] {
  if (only === undefined || only.length === 0) return config.matrix;
  const byId = new Map(config.matrix.map((row) => [row.id, row]));
  const rows: MatrixRow[] = [];
  for (const id of only) {
    const row = byId.get(id);
    if (row === undefined) {
      fail(`--only ${JSON.stringify(id)} is not a matrix id. Known ids: ${config.matrix.map((r) => r.id).join(", ")}`);
    } else if (!rows.includes(row)) {
      rows.push(row);
    }
  }
  return rows;
}

/**
 * Parse a Go-style duration (`15m`, `90s`, `1h30m`) into milliseconds. agy's
 * `--print-timeout` takes this form and the runner has to compare it against
 * `timeoutMs`.
 */
export function parseDurationMs(
  spec: string,
  fail: (message: string) => never = (message) => {
    throw new Error(message);
  },
): number {
  const text = spec.trim();
  const unitMs: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/gy;
  let total = 0;
  let matched = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    total += Number(match[1]) * unitMs[match[2]];
    matched = re.lastIndex;
  }
  if (text === "" || matched !== text.length) {
    fail(`cannot parse duration ${JSON.stringify(spec)}: expected a form like "15m", "900s" or "1h30m"`);
  }
  return total;
}

function hasPlaceholder(value: string): boolean {
  return value.includes(PLACEHOLDER_MARKER);
}

function requireString(doc: Record<string, unknown>, key: string, fail: (message: string) => never): string {
  const value = doc[key];
  if (typeof value !== "string" || value.trim() === "") fail(`${key} must be a non-empty string`);
  return value as string;
}

function requirePositiveInt(doc: Record<string, unknown>, key: string, fail: (message: string) => never): number {
  const value = doc[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    fail(`${key} must be a positive integer`);
  }
  return value as number;
}

function requireQuotaFloor(doc: Record<string, unknown>, fail: (message: string) => never): number | null {
  if (!("quotaFloor" in doc)) {
    fail("quotaFloor is required; use `quotaFloor: null` to log /usage without enforcing a floor");
  }
  const value = doc.quotaFloor;
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) fail("quotaFloor must be a number or null");
  if ((value as number) < 0 || (value as number) > 100) fail("quotaFloor is a percentage and must be between 0 and 100");
  return value as number;
}

/**
 * Paths into the `agy-creds` volume, relative to its root.
 *
 * They are relative rather than bare filenames because agy does not keep its
 * credentials at the top of `$HOME`: the file store is
 * `$HOME/.gemini/antigravity-cli/`, and the copy has to reproduce that layout in
 * the throwaway HOME or agy will not find what was copied. `credentialCopyArgs`
 * runs `cp --parents` from the volume root, which is why a leading `/` and any
 * `..` segment have to be refused here — those are the two ways an entry could
 * name something outside the volume.
 */
function requireCredentialFiles(doc: Record<string, unknown>, fail: (message: string) => never): string[] {
  const value = doc.credentialFiles;
  if (!Array.isArray(value) || value.length === 0) fail("credentialFiles must be a non-empty array");
  const files = value as unknown[];
  for (const file of files) {
    if (typeof file !== "string" || file.trim() === "") fail("credentialFiles entries must be non-empty strings");
    const path = file as string;
    // These become arguments to `cp` inside a container. Keep them inside the
    // credential volume: no absolute path, no traversal, and no leading `-`
    // that cp would read as an option.
    const bad =
      path !== path.trim() ||
      path.startsWith("/") ||
      path.startsWith("-") ||
      path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
    if (bad) {
      fail(
        `credentialFiles entry ${JSON.stringify(file)} must be a path inside the agy-creds volume, ` +
          "relative to its root (e.g. .gemini/antigravity-cli/installation_id)",
      );
    }
  }
  return files as string[];
}

function requireMatrix(doc: Record<string, unknown>, fail: (message: string) => never): MatrixRow[] {
  const value = doc.matrix;
  if (!Array.isArray(value) || value.length === 0) fail("matrix must be a non-empty array");
  const rows: MatrixRow[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of (value as unknown[]).entries()) {
    const where = `matrix[${index}]`;
    if (!isRecord(entry)) fail(`${where} must be a mapping`);
    const row = entry as Record<string, unknown>;
    const id = row.id;
    if (typeof id !== "string" || !BENCHMARK_ID_RE.test(id)) {
      fail(`${where}.id must match ${BENCHMARK_ID_RE} (lowercase, no underscores) — it becomes a directory name`);
    }
    if (seen.has(id as string)) fail(`${where}.id ${JSON.stringify(id)} is a duplicate`);
    seen.add(id as string);
    const model = row.model;
    if (typeof model !== "string" || model.trim() === "") fail(`${where}.model must be a non-empty string`);
    const effort = row.effort;
    if (effort !== null && (typeof effort !== "string" || !EFFORTS.includes(effort as Effort))) {
      fail(`${where}.effort must be one of ${EFFORTS.join(", ")}, or null for a model that rejects --effort`);
    }
    const family = row.family;
    if (typeof family !== "string" || !BENCHMARK_ID_RE.test(family)) {
      fail(`${where}.family must match ${BENCHMARK_ID_RE} (lowercase, no underscores)`);
    }
    const usageLabel = row.usageLabel ?? null;
    if (usageLabel !== null && (typeof usageLabel !== "string" || usageLabel.trim() === "")) {
      fail(`${where}.usageLabel must be a non-empty string or absent`);
    }
    rows.push({
      id: id as string,
      model: model as string,
      effort: effort as Effort | null,
      family: family as string,
      usageLabel: usageLabel as string | null,
    });
  }
  return rows;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
