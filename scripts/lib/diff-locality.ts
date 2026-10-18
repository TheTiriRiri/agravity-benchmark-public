/**
 * Diff locality computation for the brownfield track (spec §7.3, Decision D13).
 * Evaluates whether changes were confined to the expected architectural seams
 * and bounds total line changes.
 */
import { spawnSync } from "node:child_process";
import { basename, join } from "node:path";
import { collectEntries } from "./base-diff";

export const ALLOWED_PATTERNS: readonly RegExp[] = Object.freeze([
  /^backend\/app\/planner.*$/,
  /^backend\/app\/routes.*$/,
  /^backend\/app\/schemas.*$/,
  /^backend\/tests\/.*$/,
  /^frontend\/src\/services\/.*$/,
  /^frontend\/src\/types\/.*$/,
  /^frontend\/src\/views\/.*$/,
]);

export function isAllowedPath(relPath: string): boolean {
  return ALLOWED_PATTERNS.some((pattern) => pattern.test(relPath));
}

export interface DiffLocalityResult {
  score: number;
  outsideFiles: string[];
  totalLines: number;
}

export function numstatLines(fileA: string, fileB: string): number {
  const res = spawnSync("git", ["diff", "--no-index", "--numstat", fileA, fileB], {
    encoding: "utf8",
  });
  if (res.error !== undefined) {
    throw new Error(`git diff --no-index failed to run: ${res.error.message}`);
  }
  if (res.status !== 0 && res.status !== 1) {
    const stderr = (res.stderr ?? "").trim();
    throw new Error(`git diff --no-index failed with exit code ${res.status}: ${stderr}`);
  }
  const output = (res.stdout ?? "").trim();
  if (!output) return 0;
  const parts = output.split("\t");
  if (parts.length < 2) return 0;
  const added = parts[0] === "-" ? 0 : parseInt(parts[0], 10) || 0;
  const deleted = parts[1] === "-" ? 0 : parseInt(parts[1], 10) || 0;
  return added + deleted;
}

/**
 * Computes Diff Locality of `attemptDir` relative to `baseDir`:
 * - Ignores BASE_EXCLUDES (.git, node_modules, .venv, dist, .antigravitycli, __pycache__, *.pyc,
 *   .pytest_cache, .mypy_cache, .ruff_cache).
 * - Ignores package-lock.json install/tool artifacts.
 * - Measures files modified/added outside ALLOWED_PATTERNS.
 * - Measures total lines changed (insertions + deletions) via `git diff --no-index --numstat`.
 *
 * Formula:
 * locality = max(0, 1.0 - 0.25 * outside_files) * max(0, 1.0 - total_lines / 500)
 */
export function computeDiffLocality(attemptDir: string, baseDir: string): DiffLocalityResult {
  const baseEntries = collectEntries(baseDir);
  const attemptEntries = collectEntries(attemptDir);

  const allPaths = new Set([...baseEntries.keys(), ...attemptEntries.keys()]);
  const outsideFiles: string[] = [];
  let totalLines = 0;

  for (const relPath of allPaths) {
    if (basename(relPath) === "package-lock.json") continue;

    const baseEntry = baseEntries.get(relPath);
    const attemptEntry = attemptEntries.get(relPath);

    if (!baseEntry && attemptEntry) {
      // Added file
      if (!isAllowedPath(relPath)) outsideFiles.push(relPath);
      totalLines += numstatLines("/dev/null", join(attemptDir, relPath));
    } else if (baseEntry && !attemptEntry) {
      // Deleted file
      if (!isAllowedPath(relPath)) outsideFiles.push(relPath);
      totalLines += numstatLines(join(baseDir, relPath), "/dev/null");
    } else if (baseEntry && attemptEntry) {
      // In both: check if modified
      if (baseEntry.type !== attemptEntry.type || baseEntry.hashOrTarget !== attemptEntry.hashOrTarget) {
        if (!isAllowedPath(relPath)) outsideFiles.push(relPath);
        totalLines += numstatLines(join(baseDir, relPath), join(attemptDir, relPath));
      }
    }
  }

  outsideFiles.sort();

  const outsidePenalty = Math.max(0, 1.0 - 0.25 * outsideFiles.length);
  const linesPenalty = Math.max(0, 1.0 - totalLines / 500);
  const rawScore = outsidePenalty * linesPenalty;
  const score = Math.round(rawScore * 100) / 100;

  return { score, outsideFiles, totalLines };
}
