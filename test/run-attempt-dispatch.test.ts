import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = join(import.meta.dirname!, "..");
const RUN_ATTEMPT = join(ROOT, "images", "harness", "run-attempt");

describe("run-attempt dispatcher", () => {
  it("images/harness/run-attempt exists", () => {
    assert.ok(existsSync(RUN_ATTEMPT), "images/harness/run-attempt must exist");
  });

  it("run-attempt --help includes --no-new-project in usage", () => {
    const res = spawnSync("bash", [RUN_ATTEMPT, "--help"], { encoding: "utf8" });
    assert.equal(res.status, 2, "run-attempt --help must exit 2");
    assert.match(res.stderr, /--no-new-project/, "usage must document --no-new-project");
  });

  it("by default, run-attempt passes --new-project to agy", () => {
    const tmp = mkdtempSync(join(tmpdir(), "run-attempt-test-"));
    try {
      const binDir = join(tmp, "bin");
      mkdirSync(binDir, { recursive: true });
      const fakeAgy = join(binDir, "agy");
      const logFile = join(tmp, "agy-args.json");
      writeFileSync(
        fakeAgy,
        `#!/usr/bin/env bash\nnode -e 'fs.writeFileSync(process.env.LOG_FILE, JSON.stringify(process.argv.slice(1)))' -- "$@"\n`,
        { mode: 0o755 },
      );

      const promptFile = join(tmp, "prompt.md");
      writeFileSync(promptFile, "Test prompt");

      const res = spawnSync("bash", [RUN_ATTEMPT, "--model", "gemini-3.8-flash-high", "--prompt-file", promptFile], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          LOG_FILE: logFile,
        },
      });

      assert.equal(res.status, 0, `run-attempt failed: ${res.stderr}`);
      const args: string[] = JSON.parse(readFileSync(logFile, "utf8"));
      assert.ok(args.includes("--new-project"), "default run must include --new-project");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("when --no-new-project is passed, run-attempt omits --new-project", () => {
    const tmp = mkdtempSync(join(tmpdir(), "run-attempt-test-"));
    try {
      const binDir = join(tmp, "bin");
      mkdirSync(binDir, { recursive: true });
      const fakeAgy = join(binDir, "agy");
      const logFile = join(tmp, "agy-args.json");
      writeFileSync(
        fakeAgy,
        `#!/usr/bin/env bash\nnode -e 'fs.writeFileSync(process.env.LOG_FILE, JSON.stringify(process.argv.slice(1)))' -- "$@"\n`,
        { mode: 0o755 },
      );

      const promptFile = join(tmp, "prompt.md");
      writeFileSync(promptFile, "Test prompt");

      const res = spawnSync(
        "bash",
        [RUN_ATTEMPT, "--model", "gemini-3.8-flash-high", "--no-new-project", "--prompt-file", promptFile],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            LOG_FILE: logFile,
          },
        },
      );

      assert.equal(res.status, 0, `run-attempt failed: ${res.stderr}`);
      const args: string[] = JSON.parse(readFileSync(logFile, "utf8"));
      assert.ok(!args.includes("--new-project"), "run with --no-new-project must NOT include --new-project");
      assert.ok(args.includes("--model"), "must include --model");
      assert.ok(args.includes("gemini-3.8-flash-high"), "must include model id");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
