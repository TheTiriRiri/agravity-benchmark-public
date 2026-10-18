import { cpSync, existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";

export const BASE_EXCLUDES: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  ".venv",
  "dist",
  ".antigravitycli",
]);

export function isIgnoredDiffEntry(name: string): boolean {
  return (
    BASE_EXCLUDES.has(name) ||
    name === "__pycache__" ||
    name === ".pytest_cache" ||
    name === ".mypy_cache" ||
    name === ".ruff_cache" ||
    name.endsWith(".pyc")
  );
}

export function copyBaseToWorkspace(baseDir: string, targetDir: string): void {
  const resolvedBase = resolve(baseDir);
  cpSync(baseDir, targetDir, {
    recursive: true,
    filter: (source) => {
      if (resolve(source) === resolvedBase) return true;
      return !BASE_EXCLUDES.has(basename(source));
    },
  });
}

export interface FileEntry {
  type: "file" | "symlink";
  hashOrTarget: string;
}

export function collectEntries(rootDir: string): Map<string, FileEntry> {
  const entries = new Map<string, FileEntry>();

  function walk(currentDir: string, relPrefix: string): void {
    if (!existsSync(currentDir)) return;
    const dirents = readdirSync(currentDir, { withFileTypes: true });
    for (const dirent of dirents) {
      if (isIgnoredDiffEntry(dirent.name)) continue;
      const fullPath = join(currentDir, dirent.name);
      const relPath = relPrefix ? `${relPrefix}/${dirent.name}` : dirent.name;

      if (dirent.isSymbolicLink()) {
        const linkTarget = readlinkSync(fullPath);
        entries.set(relPath, { type: "symlink", hashOrTarget: linkTarget });
      } else if (dirent.isDirectory()) {
        walk(fullPath, relPath);
      } else if (dirent.isFile()) {
        const content = readFileSync(fullPath);
        const hash = createHash("sha256").update(content).digest("hex");
        entries.set(relPath, { type: "file", hashOrTarget: hash });
      }
    }
  }

  walk(rootDir, "");
  return entries;
}

/**
 * Compares attemptDir against baseDir ignoring build/stub artifacts:
 * .git, node_modules, .venv, dist, .antigravitycli, __pycache__, *.pyc,
 * .pytest_cache, .mypy_cache, and .ruff_cache.
 *
 * Symbolic links in attemptDir are compared as links without following them,
 * preventing workspace escapes and external filesystem traversal.
 *
 * Returns true if attemptDir differs from baseDir, false if identical.
 */
export function hasBaseDiff(attemptDir: string, baseDir: string): boolean {
  const baseEntries = collectEntries(baseDir);
  const attemptEntries = collectEntries(attemptDir);

  if (baseEntries.size !== attemptEntries.size) return true;

  for (const [path, baseEntry] of baseEntries) {
    const attemptEntry = attemptEntries.get(path);
    if (!attemptEntry) return true;
    if (attemptEntry.type !== baseEntry.type) return true;
    if (attemptEntry.hashOrTarget !== baseEntry.hashOrTarget) return true;
  }

  return false;
}
