import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { hasBaseDiff } from "../scripts/lib/base-diff";
import { classifyFailure, type ClassifyInput } from "../scripts/lib/classify";
import type { RunEnvelope } from "../scripts/lib/run-json";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function sampleEnvelope(): RunEnvelope {
  return {
    status: "success",
    num_turns: 1,
    duration_seconds: 12.3,
    conversation_id: "conv-1",
    error: "",
    responseTail: "all done",
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      thinking_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 150,
    },
  };
}

describe("hasBaseDiff", () => {
  test("returns false when directories are byte-identical", () => {
    const base = makeTempDir("agrav-diff-base-");
    const attempt = makeTempDir("agrav-diff-attempt-");

    mkdirSync(join(base, "src"), { recursive: true });
    writeFileSync(join(base, "src", "index.ts"), "export const x = 1;");
    writeFileSync(join(base, "README.md"), "# Base");

    mkdirSync(join(attempt, "src"), { recursive: true });
    writeFileSync(join(attempt, "src", "index.ts"), "export const x = 1;");
    writeFileSync(join(attempt, "README.md"), "# Base");

    assert.equal(hasBaseDiff(attempt, base), false);
  });

  test("returns false when attemptDir has identical files plus .antigravitycli stub", () => {
    const base = makeTempDir("agrav-diff-base-");
    const attempt = makeTempDir("agrav-diff-attempt-");

    writeFileSync(join(base, "app.py"), "print('hello')");
    writeFileSync(join(attempt, "app.py"), "print('hello')");

    mkdirSync(join(attempt, ".antigravitycli"), { recursive: true });
    writeFileSync(join(attempt, ".antigravitycli", "session-123.json"), '{"stub": true}');

    assert.equal(hasBaseDiff(attempt, base), false);
  });

  test("returns false when attemptDir only ran npm install or executed python (__pycache__, *.pyc, node_modules, .venv, dist, .git)", () => {
    const base = makeTempDir("agrav-diff-base-");
    const attempt = makeTempDir("agrav-diff-attempt-");

    mkdirSync(join(base, "pkg"), { recursive: true });
    writeFileSync(join(base, "pkg", "main.py"), "print('hi')");
    writeFileSync(join(base, "package.json"), '{"name": "test"}');

    mkdirSync(join(attempt, "pkg"), { recursive: true });
    writeFileSync(join(attempt, "pkg", "main.py"), "print('hi')");
    writeFileSync(join(attempt, "package.json"), '{"name": "test"}');

    // Artifacts from running python or npm install
    mkdirSync(join(attempt, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(attempt, "node_modules", "dep", "index.js"), "// dep");
    mkdirSync(join(attempt, ".venv", "bin"), { recursive: true });
    writeFileSync(join(attempt, ".venv", "bin", "python"), "#!/bin/sh");
    mkdirSync(join(attempt, "dist"), { recursive: true });
    writeFileSync(join(attempt, "dist", "bundle.js"), "// bundle");
    mkdirSync(join(attempt, ".git", "objects"), { recursive: true });
    writeFileSync(join(attempt, ".git", "HEAD"), "ref: refs/heads/main");
    mkdirSync(join(attempt, "pkg", "__pycache__"), { recursive: true });
    writeFileSync(join(attempt, "pkg", "__pycache__", "main.cpython-311.pyc"), "bytecode");
    writeFileSync(join(attempt, "pkg", "extra.pyc"), "compiled");

    assert.equal(hasBaseDiff(attempt, base), false, "npm install and python execution artifacts must be ignored");
  });

  test("returns false when attemptDir only has Python tool caches (.pytest_cache, .mypy_cache, .ruff_cache)", () => {
    const base = makeTempDir("agrav-diff-base-");
    const attempt = makeTempDir("agrav-diff-attempt-");

    mkdirSync(join(base, "backend"), { recursive: true });
    writeFileSync(join(base, "backend", "main.py"), "print('hi')");

    mkdirSync(join(attempt, "backend"), { recursive: true });
    writeFileSync(join(attempt, "backend", "main.py"), "print('hi')");

    // Artifacts from running pytest
    mkdirSync(join(attempt, "backend", ".pytest_cache", "v", "cache"), { recursive: true });
    writeFileSync(join(attempt, "backend", ".pytest_cache", "CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55");
    writeFileSync(join(attempt, "backend", ".pytest_cache", ".gitignore"), "# pytest cache\n*\n");
    writeFileSync(join(attempt, "backend", ".pytest_cache", "README.md"), "pytest cache dir");
    writeFileSync(join(attempt, "backend", ".pytest_cache", "v", "cache", "nodeids"), "test_planner.py::test_plan");

    // Artifacts from running mypy
    mkdirSync(join(attempt, "backend", ".mypy_cache", "3.11"), { recursive: true });
    writeFileSync(join(attempt, "backend", ".mypy_cache", "3.11", "data.json"), "{}");

    // Artifacts from running ruff
    mkdirSync(join(attempt, "backend", ".ruff_cache"), { recursive: true });
    writeFileSync(join(attempt, "backend", ".ruff_cache", "content.json"), "{}");

    assert.equal(hasBaseDiff(attempt, base), false, "Python tool cache artifacts must be ignored");
  });

  test("returns true when any file content is modified", () => {
    const base = makeTempDir("agrav-diff-base-");
    const attempt = makeTempDir("agrav-diff-attempt-");

    writeFileSync(join(base, "file.txt"), "hello base");
    writeFileSync(join(attempt, "file.txt"), "hello modified");

    assert.equal(hasBaseDiff(attempt, base), true);
  });

  test("returns true when a file is added", () => {
    const base = makeTempDir("agrav-diff-base-");
    const attempt = makeTempDir("agrav-diff-attempt-");

    writeFileSync(join(base, "file.txt"), "hello base");
    writeFileSync(join(attempt, "file.txt"), "hello base");
    writeFileSync(join(attempt, "new-file.txt"), "new content");

    assert.equal(hasBaseDiff(attempt, base), true);
  });

  test("returns true when a file is deleted", () => {
    const base = makeTempDir("agrav-diff-base-");
    const attempt = makeTempDir("agrav-diff-attempt-");

    writeFileSync(join(base, "file.txt"), "hello base");
    writeFileSync(join(base, "to-delete.txt"), "bye");
    writeFileSync(join(attempt, "file.txt"), "hello base");

    assert.equal(hasBaseDiff(attempt, base), true);
  });

  test("symlinks in attemptDir: compared as links without following them outside workspace", () => {
    const base = makeTempDir("agrav-diff-base-");
    const attempt = makeTempDir("agrav-diff-attempt-");
    const outside = makeTempDir("agrav-diff-outside-");

    const outsideFile = join(outside, "secret.txt");
    writeFileSync(outsideFile, "secret external content");

    // Case A: Model created a symlink to an outside file in attemptDir (not in base)
    const symlinkInAttempt = join(attempt, "leak.txt");
    symlinkSync(outsideFile, symlinkInAttempt);

    // Must detect diff as symlink, without crashing or following
    assert.equal(hasBaseDiff(attempt, base), true);

    // Case B: Base and attempt both have identical symlinks pointing to the same target
    const baseSymlink = join(base, "link.txt");
    const attemptSymlink = join(attempt, "link.txt");
    symlinkSync("relative/target.txt", baseSymlink);
    symlinkSync("relative/target.txt", attemptSymlink);

    // Remove the extra leak.txt from attempt
    rmSync(symlinkInAttempt);
    assert.equal(hasBaseDiff(attempt, base), false, "identical symlinks must have no diff");

    // Case C: Attempt symlink target differs from base symlink target
    rmSync(attemptSymlink);
    symlinkSync("different/target.txt", attemptSymlink);
    assert.equal(hasBaseDiff(attempt, base), true, "symlinks with different targets must have diff");

    // Case D: Symlink pointing to outside directory does not traverse outside
    const outsideDir = join(outside, "dir");
    mkdirSync(outsideDir);
    writeFileSync(join(outsideDir, "huge.txt"), "content");
    const dirSymlink = join(attempt, "dir-link");
    symlinkSync(outsideDir, dirSymlink);
    assert.equal(hasBaseDiff(attempt, base), true);
  });
});

describe("classifyFailure with noDiffFromBase", () => {
  test("noDiffFromBase === true with clean exit yields model failure", () => {
    const input: ClassifyInput = {
      exitCode: 0,
      stdout: JSON.stringify(sampleEnvelope()),
      stderr: "",
      envelope: sampleEnvelope(),
      workspaceEmpty: false,
      noDiffFromBase: true,
    };

    const res = classifyFailure(input);
    assert.equal(res.failureKind, "model");
    assert.equal(res.reason, "agy exited 0 but made no changes to the base codebase");
  });

  test("noDiffFromBase === true with rate-limit in stderr yields infra failure (infra priority)", () => {
    const input: ClassifyInput = {
      exitCode: 0,
      stdout: JSON.stringify(sampleEnvelope()),
      stderr: "RESOURCE_EXHAUSTED: rate limit exceeded (429)",
      envelope: sampleEnvelope(),
      workspaceEmpty: false,
      noDiffFromBase: true,
    };

    const res = classifyFailure(input);
    assert.equal(res.failureKind, "infra");
    assert.equal(res.rateLimited, true);
    assert.equal(res.reason, "quota / rate limit");
  });

  test("noDiffFromBase === false or undefined preserves clean success", () => {
    const inputFalse: ClassifyInput = {
      exitCode: 0,
      stdout: JSON.stringify(sampleEnvelope()),
      stderr: "",
      envelope: sampleEnvelope(),
      workspaceEmpty: false,
      noDiffFromBase: false,
    };

    const resFalse = classifyFailure(inputFalse);
    assert.equal(resFalse.failureKind, null);
    assert.equal(resFalse.reason, "success");

    const inputUndefined: ClassifyInput = {
      exitCode: 0,
      stdout: JSON.stringify(sampleEnvelope()),
      stderr: "",
      envelope: sampleEnvelope(),
      workspaceEmpty: false,
    };

    const resUndefined = classifyFailure(inputUndefined);
    assert.equal(resUndefined.failureKind, null);
    assert.equal(resUndefined.reason, "success");
  });
});
