import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BASE_DIR = join(ROOT, "tracks", "brownfield", "base");
const EXPECTED_TREE_HASH = "7de4334f5c3b75de53c54471b1859ec4afb0bb5b";

const FORBIDDEN_NAMES = new Set([
  ".git",
  "node_modules",
  ".venv",
  ".pytest_cache",
  "dist",
  ".antigravitycli",
  "__pycache__",
]);

function gitBlobHash(content: Buffer): string {
  const header = Buffer.from(`blob ${content.length}\0`);
  return createHash("sha1").update(Buffer.concat([header, content])).digest("hex");
}

function getAllFiles(dir: string, relPrefix = ""): string[] {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getAllFiles(full, rel));
    } else {
      files.push(rel);
    }
  }
  return files;
}

function getAllDirectories(dir: string, relPrefix = ""): string[] {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  const dirs: string[] = [];
  for (const entry of entries) {
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      dirs.push(rel);
      dirs.push(...getAllDirectories(full, rel));
    }
  }
  return dirs;
}

describe("frozen brownfield base in tracks/brownfield/base", () => {
  test("tracks/brownfield/base exists and contains key entrypoints", () => {
    assert.ok(
      existsSync(join(BASE_DIR, "backend", "app", "main.py")),
      "tracks/brownfield/base/backend/app/main.py must exist and be readable",
    );
    assert.ok(
      existsSync(join(BASE_DIR, "frontend", "package.json")),
      "tracks/brownfield/base/frontend/package.json must exist",
    );
    assert.ok(
      existsSync(join(BASE_DIR, "frontend", "package-lock.json")),
      "tracks/brownfield/base/frontend/package-lock.json must exist",
    );
  });

  test("tracks/brownfield/base has no build or environment artifacts (.git, node_modules, .venv, .pytest_cache, dist, .antigravitycli, __pycache__, *.pyc)", () => {
    assert.ok(existsSync(BASE_DIR), "tracks/brownfield/base must exist");

    const allDirs = getAllDirectories(BASE_DIR);
    for (const dir of allDirs) {
      const parts = dir.split("/");
      for (const part of parts) {
        assert.ok(!FORBIDDEN_NAMES.has(part), `forbidden directory artifact found in base: ${dir}`);
      }
    }

    const allFiles = getAllFiles(BASE_DIR);
    for (const file of allFiles) {
      const parts = file.split("/");
      for (const part of parts) {
        assert.ok(!FORBIDDEN_NAMES.has(part), `forbidden file in artifact directory: ${file}`);
      }
      assert.ok(!file.endsWith(".pyc"), `forbidden compiled python file found in base: ${file}`);
    }
  });

  test("tracks/brownfield/base file tree matches git source tree 7de4334f5c3b75de53c54471b1859ec4afb0bb5b byte for byte", () => {
    const lsTree = spawnSync(
      "git",
      ["ls-tree", "-r", EXPECTED_TREE_HASH],
      { cwd: ROOT, encoding: "utf8" },
    );
    assert.equal(lsTree.status, 0, `git ls-tree failed: ${lsTree.stderr}`);

    const expectedTreeFiles = new Map<string, string>();
    for (const line of lsTree.stdout.trim().split("\n")) {
      if (!line) continue;
      // Format: <mode> blob <hash>\t<path>
      const match = /^(\d+)\s+blob\s+([0-9a-f]{40})\t(.+)$/.exec(line);
      assert.ok(match, `malformed ls-tree line: ${line}`);
      expectedTreeFiles.set(match[3], match[2]);
    }

    assert.equal(expectedTreeFiles.size, 30, "expected source tree must contain exactly 30 files");

    // Verify all 30 files exist in BASE_DIR with exact git blob hashes
    for (const [relPath, expectedBlobHash] of expectedTreeFiles) {
      const filePath = join(BASE_DIR, relPath);
      assert.ok(existsSync(filePath), `missing file from base: ${relPath}`);
      const content = readFileSync(filePath);
      const actualBlobHash = gitBlobHash(content);
      assert.equal(
        actualBlobHash,
        expectedBlobHash,
        `file ${relPath} blob hash mismatch: expected ${expectedBlobHash}, got ${actualBlobHash}`,
      );
    }

    // Verify no extra files exist on disk in BASE_DIR
    const onDiskFiles = getAllFiles(BASE_DIR);
    assert.equal(
      onDiskFiles.length,
      expectedTreeFiles.size,
      `on-disk file count (${onDiskFiles.length}) must match git tree file count (${expectedTreeFiles.size})`,
    );
  });

  test("tracks/brownfield/base git tree hash matches expected tree hash 7de4334f5c3b75de53c54471b1859ec4afb0bb5b", () => {
    // When committed to HEAD or staged in index:
    let treeHash: string | null = null;
    const revParseHead = spawnSync("git", ["rev-parse", "HEAD:tracks/brownfield/base"], { cwd: ROOT, encoding: "utf8" });
    if (revParseHead.status === 0 && revParseHead.stdout.trim()) {
      treeHash = revParseHead.stdout.trim();
    } else {
      // Check staged index write-tree
      const writeTree = spawnSync("git", ["write-tree", "--prefix=tracks/brownfield/base"], { cwd: ROOT, encoding: "utf8" });
      if (writeTree.status === 0 && writeTree.stdout.trim()) {
        treeHash = writeTree.stdout.trim();
      }
    }

    assert.equal(
      treeHash,
      EXPECTED_TREE_HASH,
      `git tree hash for tracks/brownfield/base must equal ${EXPECTED_TREE_HASH}`,
    );
  });
});
