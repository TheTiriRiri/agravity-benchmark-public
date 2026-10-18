import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it, test } from "node:test";

import {
  attemptArgs,
  copyBaseToWorkspace,
  evaluateRun,
  parseArgs,
  type AttemptCommand,
  type AttemptContainerRun,
  type AttemptContext,
} from "../scripts/run-matrix";
import { loadRunnerConfig, type MatrixRow } from "../scripts/lib/runner-config";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../scripts/run-matrix.ts", import.meta.url));

const CONFIG = loadRunnerConfig(join(REPO_ROOT, "benchmark", "runner.yaml"), { allowPlaceholders: true });
const ROW: MatrixRow = CONFIG.matrix.find((row) => row.id === "gemini-38-flash-high")!;

const tempDirs: string[] = [];

function makeRoot(rubric?: string): string {
  const root = mkdtempSync(join(tmpdir(), "agrav-base-test-root-"));
  tempDirs.push(root);
  mkdirSync(join(root, "benchmark"), { recursive: true });
  copyFileSync(join(REPO_ROOT, "benchmark", "runner.yaml"), join(root, "benchmark", "runner.yaml"));
  if (rubric) {
    const cfg = readFileSync(join(root, "benchmark", "runner.yaml"), "utf8");
    writeFileSync(join(root, "benchmark", "runner.yaml"), cfg.replace(/rubric: .*/, `rubric: ${rubric}`));
  }
  copyFileSync(join(REPO_ROOT, "prompt.md"), join(root, "prompt.md"));
  return root;
}

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function runMatrix(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("run-matrix --base CLI flag and workspace seeding", () => {
  test("parseArgs parses --base with an existing directory", () => {
    const baseDir = makeTempDir("agrav-base-sample-");
    const args = parseArgs(["--base", baseDir]);
    assert.equal(args.base, baseDir);
  });

  test("parseArgs and CLI refuse --base pointing to a nonexistent path with exit code 1", () => {
    const nonexistent = join(tmpdir(), "agrav-nonexistent-" + Date.now());
    assert.throws(
      () => parseArgs(["--base", nonexistent]),
      /--base.*is not a directory/,
    );

    const res = runMatrix("--base", nonexistent);
    assert.equal(res.status, 1, "CLI must exit 1 on nonexistent --base");
    assert.match(res.stderr, /is not a directory/);
  });

  test("parseArgs and CLI refuse --base pointing to a file (not a directory) with exit code 1", () => {
    const tmp = makeTempDir("agrav-file-base-");
    const filePath = join(tmp, "base-file.txt");
    writeFileSync(filePath, "not a directory");

    assert.throws(
      () => parseArgs(["--base", filePath]),
      /--base.*is not a directory/,
    );

    const res = runMatrix("--base", filePath);
    assert.equal(res.status, 1, "CLI must exit 1 on file --base");
    assert.match(res.stderr, /is not a directory/);
  });

  test("parseArgs and CLI refuse --base without a value", () => {
    assert.throws(
      () => parseArgs(["--base"]),
      /--base needs a value/,
    );

    const res = runMatrix("--base");
    assert.equal(res.status, 1);
    assert.match(res.stderr, /--base needs a value/);
  });

  test("parseArgs and CLI refuse --base followed by another flag", () => {
    assert.throws(
      () => parseArgs(["--base", "--dry-run"]),
      /--base needs a value, not the flag "--dry-run"/,
    );

    const res = runMatrix("--base", "--dry-run");
    assert.equal(res.status, 1);
    assert.match(res.stderr, /--base needs a value, not the flag "--dry-run"/);
  });

  test("attemptArgs includes --no-new-project when noNewProject is true", () => {
    const baseCmd: AttemptCommand = {
      config: CONFIG,
      row: ROW,
      attemptDir: "/repo/eval-attempts/gemini-38-flash-high-attempt-1",
      credsDir: "/tmp/creds",
      containerName: "agrav-gemini-38-flash-high-attempt-1",
      promptPath: "/repo/prompt.md",
      noNewProject: true,
    };
    const args = attemptArgs(baseCmd);
    assert.ok(args.includes("--no-new-project"), "must include --no-new-project");
    assert.equal(args[args.length - 1], "--no-new-project", "--no-new-project must be passed to run-attempt");
  });

  test("attemptArgs omits --no-new-project when noNewProject is false or undefined", () => {
    const baseCmd: AttemptCommand = {
      config: CONFIG,
      row: ROW,
      attemptDir: "/repo/eval-attempts/gemini-38-flash-high-attempt-1",
      credsDir: "/tmp/creds",
      containerName: "agrav-gemini-38-flash-high-attempt-1",
      promptPath: "/repo/prompt.md",
    };
    const argsWithout = attemptArgs(baseCmd);
    assert.ok(!argsWithout.includes("--no-new-project"));

    const argsExplicitFalse = attemptArgs({ ...baseCmd, noNewProject: false });
    assert.ok(!argsExplicitFalse.includes("--no-new-project"));
    assert.deepEqual(argsWithout, argsExplicitFalse);
  });

  test("copyBaseToWorkspace copies source files and filters out .git, node_modules, .venv, dist, .antigravitycli", () => {
    const srcDir = makeTempDir("agrav-src-base-");
    const dstDir = makeTempDir("agrav-dst-workspace-");

    // Standard files and dirs that should be copied
    mkdirSync(join(srcDir, "src", "components"), { recursive: true });
    writeFileSync(join(srcDir, "src", "index.ts"), "export const a = 1;");
    writeFileSync(join(srcDir, "src", "components", "Button.tsx"), "export const Button = null;");
    writeFileSync(join(srcDir, "package.json"), JSON.stringify({ name: "sample" }));
    writeFileSync(join(srcDir, "README.md"), "# Base Readme");

    // Directories and files that MUST be excluded
    mkdirSync(join(srcDir, ".git", "objects"), { recursive: true });
    writeFileSync(join(srcDir, ".git", "HEAD"), "ref: refs/heads/main");
    mkdirSync(join(srcDir, "node_modules", "some-dep"), { recursive: true });
    writeFileSync(join(srcDir, "node_modules", "some-dep", "index.js"), "// dep");
    mkdirSync(join(srcDir, ".venv", "bin"), { recursive: true });
    writeFileSync(join(srcDir, ".venv", "bin", "python"), "python");
    mkdirSync(join(srcDir, "dist"), { recursive: true });
    writeFileSync(join(srcDir, "dist", "bundle.js"), "bundled code");
    mkdirSync(join(srcDir, ".antigravitycli"), { recursive: true });
    writeFileSync(join(srcDir, ".antigravitycli", "state.json"), "{}");

    copyBaseToWorkspace(srcDir, dstDir);

    // Verify allowed files were copied
    assert.ok(existsSync(join(dstDir, "src", "index.ts")));
    assert.ok(existsSync(join(dstDir, "src", "components", "Button.tsx")));
    assert.ok(existsSync(join(dstDir, "package.json")));
    assert.ok(existsSync(join(dstDir, "README.md")));

    // Verify excluded directories were NOT copied
    assert.ok(!existsSync(join(dstDir, ".git")), ".git must not be copied");
    assert.ok(!existsSync(join(dstDir, "node_modules")), "node_modules must not be copied");
    assert.ok(!existsSync(join(dstDir, ".venv")), ".venv must not be copied");
    assert.ok(!existsSync(join(dstDir, "dist")), "dist must not be copied");
    assert.ok(!existsSync(join(dstDir, ".antigravitycli")), ".antigravitycli must not be copied");
  });

  test("--dry-run with --base logs copy step and passes --no-new-project, but writes nothing", () => {
    const root = makeRoot("maintenance-console-brownfield@a906b1e3cadd");
    const baseDir = makeTempDir("agrav-base-run-");
    writeFileSync(join(baseDir, "file.txt"), "hello base");

    const res = runMatrix(
      "--root",
      root,
      "--base",
      baseDir,
      "--only",
      "gemini-38-flash-high",
      "--attempts",
      "1",
      "--dry-run",
    );

    assert.equal(res.status, 0, `dry run failed: ${res.stderr}`);
    assert.match(res.stdout, new RegExp(`copy base from ${baseDir}`));
    assert.match(res.stdout, /--no-new-project/);

    // Verify nothing was created in root eval-attempts
    assert.ok(!existsSync(join(root, "eval-attempts")), "dry-run must write nothing in eval-attempts");
  });

  test("--dry-run without --base does not log copy step and does not pass --no-new-project", () => {
    const root = makeRoot();
    const res = runMatrix(
      "--root",
      root,
      "--only",
      "gemini-38-flash-high",
      "--attempts",
      "1",
      "--dry-run",
    );

    assert.equal(res.status, 0, `dry run failed: ${res.stderr}`);
    assert.ok(!res.stdout.includes("copy base"), "dry run without --base must not log copy base");
    assert.ok(!res.stdout.includes("--no-new-project"), "dry run without --base must not include --no-new-project");
  });

  describe("evaluateRun with and without baseDir", () => {
    const containerRun: AttemptContainerRun = {
      stdout: JSON.stringify({
        status: "SUCCESS",
        num_turns: 1,
        duration_seconds: 10,
        usage: null,
        conversation_id: "c1",
        error: "",
        responseTail: null,
      }),
      stderr: "",
      exitCode: 0,
      dockerError: false,
      outerTimeout: false,
      interrupted: null,
      containerOrphaned: false,
      removalDetail: null,
      startedAt: "2026-10-04T12:00:00.000Z",
      durationMs: 10000,
    };

    test("sets noDiffFromBase: true and failureKind: model when attemptDir is identical to baseDir", () => {
      const baseDir = makeTempDir("agrav-eval-base-");
      const attemptDir = makeTempDir("agrav-eval-attempt-");
      writeFileSync(join(baseDir, "app.py"), "print('base')");
      writeFileSync(join(attemptDir, "app.py"), "print('base')");

      const ctx: AttemptContext = {
        config: CONFIG,
        imageRef: "agrav-bench/harness:2026-10-04",
        root: "/tmp/root",
        dryRun: false,
        baseDir,
      };

      const { runJson, classification } = evaluateRun(ctx, ROW, containerRun, attemptDir);
      assert.equal(runJson.noDiffFromBase, true);
      assert.equal(runJson.failureKind, "model");
      assert.equal(classification.failureKind, "model");
    });

    test("sets noDiffFromBase: false and failureKind: null when attemptDir has changes against baseDir", () => {
      const baseDir = makeTempDir("agrav-eval-base-");
      const attemptDir = makeTempDir("agrav-eval-attempt-");
      writeFileSync(join(baseDir, "app.py"), "print('base')");
      writeFileSync(join(attemptDir, "app.py"), "print('modified')");

      const ctx: AttemptContext = {
        config: CONFIG,
        imageRef: "agrav-bench/harness:2026-10-04",
        root: "/tmp/root",
        dryRun: false,
        baseDir,
      };

      const { runJson, classification } = evaluateRun(ctx, ROW, containerRun, attemptDir);
      assert.equal(runJson.noDiffFromBase, false);
      assert.equal(runJson.failureKind, null);
      assert.equal(classification.failureKind, null);
    });

    test("omits noDiffFromBase when ctx has no baseDir (classic/hard tracks)", () => {
      const attemptDir = makeTempDir("agrav-eval-attempt-");
      writeFileSync(join(attemptDir, "app.py"), "print('anything')");

      const ctx: AttemptContext = {
        config: CONFIG,
        imageRef: "agrav-bench/harness:2026-10-04",
        root: "/tmp/root",
        dryRun: false,
      };

      const { runJson, classification } = evaluateRun(ctx, ROW, containerRun, attemptDir);
      assert.equal(runJson.noDiffFromBase, undefined);
      assert.equal("noDiffFromBase" in runJson, false);
      assert.equal(runJson.failureKind, null);
      assert.equal(classification.failureKind, null);
    });
  });
});
