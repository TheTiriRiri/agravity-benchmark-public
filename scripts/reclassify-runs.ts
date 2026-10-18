/**
 * reclassify-runs — re-evaluate `failureKind` on existing `run.json` files.
 *
 * Usage:
 *   node --import tsx scripts/reclassify-runs.ts \
 *     --root <track root> [--config <runner yaml>] [--only <attempt dir>]... [--write]
 *
 * For each `eval-results/<id>/run.json` with `failureKind: "model"`, the script
 * reconstructs a `ClassifyInput` from the fields the runner originally wrote,
 * calls `classifyFailure`, and compares the old and new verdicts.
 *
 * By default this is a **dry run**: it prints a table and exits. With `--write`,
 * any attempt whose verdict changes from `"model"` to `null` is updated in
 * place: `failureKind` is set to `null` and a `reclassified` object is added
 * recording what it was, when it changed, and why. Other transitions (or the
 * same verdict) are never written.
 *
 * `outerTimeout` is reconstructed as `durationMs >= timeoutMs` from the runner
 * YAML. Without `--config`, the script reads `<root>/benchmark/runner.yaml`;
 * with `--config`, the path is resolved relative to the repo root. When the
 * file does not exist or `timeoutMs` cannot be parsed, the script errors out
 * (exit 1) rather than guessing: a wrong `outerTimeout` would silently flip a
 * real timeout into a data point, or hide a recoverable run behind a timeout.
 *
 * For the hard track, whose runner YAML lives at `benchmark/runner-hard.yaml`
 * and is passed via `--config` at run time, use:
 *   --root tracks/console-hard --config benchmark/runner-hard.yaml
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { writeFileAtomic } from "./lib/atomic-write";
import { classifyFailure, type ClassifyInput } from "./lib/classify";
import { readRunJson, type RunJson } from "./lib/run-json";
import { isWorkspaceEmpty } from "./lib/workspace";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// --- runner YAML timeout ---------------------------------------------------

/**
 * Read `timeoutMs` from a runner YAML file via regex. Returns `null` when the
 * key is absent or unparseable; the caller decides whether that is an error.
 */
function readTimeoutMs(yamlPath: string): number | null {
  let content: string;
  try {
    content = readFileSync(yamlPath, "utf8");
  } catch {
    return null;
  }
  const match = /^timeoutMs:\s*(\d+)/m.exec(content);
  if (match === null) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/**
 * Resolve the runner YAML path and extract `timeoutMs`, or return an error
 * string. Without `--config`, the default is `<root>/benchmark/runner.yaml`.
 */
function resolveTimeoutMs(root: string, configArg?: string): { timeoutMs: number } | { error: string } {
  const yamlPath = configArg !== undefined
    ? resolve(REPO_ROOT, configArg)
    : join(root, "benchmark", "runner.yaml");

  if (!existsSync(yamlPath)) {
    return {
      error:
        `runner YAML not found at ${yamlPath}` +
        (configArg === undefined
          ? ". Pass --config <runner yaml> if the track uses a non-default location."
          : "."),
    };
  }

  const timeoutMs = readTimeoutMs(yamlPath);
  if (timeoutMs === null) {
    return { error: `timeoutMs not found or not a number in ${yamlPath}` };
  }
  return { timeoutMs };
}

// --- reclassification -------------------------------------------------------

interface ReclassifyResult {
  dirName: string;
  oldKind: "model";
  newKind: string | null;
  reason: string;
  changed: boolean;
}

function reclassifyOne(
  root: string,
  dirName: string,
  timeoutMs: number,
): ReclassifyResult {
  const resultsDir = join(root, "eval-results", dirName);
  const runJsonPath = join(resultsDir, "run.json");
  const run = readRunJson(runJsonPath);

  // Reconstruct ClassifyInput from the fields the runner wrote.
  const attemptDir = join(root, "eval-attempts", dirName);
  const workspaceEmpty = isWorkspaceEmpty(attemptDir);

  const outerTimeout = run.durationMs >= timeoutMs;

  const input: ClassifyInput = {
    exitCode: run.exitCode,
    stdout: "",
    stderr: run.stderrTail,
    envelope: run.envelope,
    workspaceEmpty,
    noDiffFromBase: run.noDiffFromBase,
    outerTimeout,
  };

  const classification = classifyFailure(input);

  return {
    dirName,
    oldKind: "model",
    newKind: classification.failureKind,
    reason: classification.reason,
    changed: classification.failureKind !== "model",
  };
}

// --- CLI --------------------------------------------------------------------

const USAGE = `Usage: node --import tsx scripts/reclassify-runs.ts --root <track root> [options]

Options:
  --root <path>      Track root holding eval-results/ and eval-attempts/.
  --config <path>    Runner YAML file (resolved relative to the repo root).
                     Default: <root>/benchmark/runner.yaml.
  --only <dir>       Process only this attempt directory (repeatable).
  --write            Write changes to disk (only model → null transitions).
  --help             Print this message.

By default this is a dry run.
`;

interface CliArgs {
  root: string;
  config?: string;
  only: string[];
  write: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { root: "", only: [], write: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const eq = token.indexOf("=");
    const name = token.startsWith("--") && eq !== -1 ? token.slice(0, eq) : token;
    const inlineValue = token.startsWith("--") && eq !== -1 ? token.slice(eq + 1) : undefined;
    const takeValue = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[++i];
      if (next === undefined) throw new Error(`${name} needs a value`);
      return next;
    };
    switch (name) {
      case "--root":
        args.root = resolve(takeValue());
        break;
      case "--config":
        args.config = takeValue();
        break;
      case "--only":
        args.only.push(takeValue());
        break;
      case "--write":
        args.write = true;
        break;
      case "--":
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        throw new Error(`unknown argument ${JSON.stringify(token)}\n\n${USAGE}`);
    }
  }
  return args;
}

export function main(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (!args.root) {
    console.error("error: --root is required\n");
    console.error(USAGE);
    return 1;
  }

  const root = args.root;
  const resultsDir = join(root, "eval-results");
  if (!existsSync(resultsDir)) {
    console.error(`error: ${resultsDir} does not exist`);
    return 1;
  }

  const resolved = resolveTimeoutMs(root, args.config);
  if ("error" in resolved) {
    console.error(`error: ${resolved.error}`);
    return 1;
  }
  const { timeoutMs } = resolved;
  console.log(`runner YAML timeoutMs: ${timeoutMs}`);

  // Discover attempt directories with failureKind "model".
  const allDirs = readdirSync(resultsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  const candidateDirs =
    args.only.length > 0
      ? args.only.filter((d) => allDirs.includes(d))
      : allDirs;

  const results: ReclassifyResult[] = [];
  for (const dirName of candidateDirs) {
    const runJsonPath = join(resultsDir, dirName, "run.json");
    if (!existsSync(runJsonPath)) continue;
    let run: RunJson;
    try {
      run = readRunJson(runJsonPath);
    } catch (error) {
      console.warn(`warning: cannot read ${runJsonPath}: ${(error as Error).message}`);
      continue;
    }
    if (run.failureKind !== "model") continue;

    const result = reclassifyOne(root, dirName, timeoutMs);
    results.push(result);
  }

  if (results.length === 0) {
    console.log("no model failures found to reclassify");
    return 0;
  }

  // Print table.
  const header = ["attempt", "old", "new", "reason"];
  const rows = results.map((r) => [
    r.dirName,
    r.oldKind,
    r.newKind === null ? "null (data point)" : r.newKind,
    r.reason,
  ]);

  // Column widths.
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i].length)),
  );
  const sep = widths.map((w) => "-".repeat(w)).join(" | ");
  const fmtRow = (row: string[]) =>
    row.map((cell, i) => cell.padEnd(widths[i])).join(" | ");

  console.log();
  console.log(fmtRow(header));
  console.log(sep);
  for (const row of rows) {
    console.log(fmtRow(row));
  }
  console.log();

  const changed = results.filter((r) => r.changed);
  console.log(
    `${results.length} model failure(s) checked, ${changed.length} would change`,
  );

  if (!args.write) {
    if (changed.length > 0) {
      console.log("dry run — pass --write to apply changes");
    }
    return 0;
  }

  // Write changes.
  const now = new Date().toISOString();
  let written = 0;
  for (const r of changed) {
    if (r.newKind !== null) {
      // Only write model → null transitions.
      console.log(`skipping ${r.dirName}: new kind is ${JSON.stringify(r.newKind)}, not null`);
      continue;
    }
    const runJsonPath = join(resultsDir, r.dirName, "run.json");
    const raw = JSON.parse(readFileSync(runJsonPath, "utf8"));
    raw.failureKind = null;
    raw.reclassified = {
      from: "model",
      at: now,
      reason: r.reason,
    };
    writeFileAtomic(runJsonPath, `${JSON.stringify(raw, null, 2)}\n`);
    console.log(`wrote ${runJsonPath}`);
    written++;
  }
  console.log(`${written} file(s) updated`);
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
