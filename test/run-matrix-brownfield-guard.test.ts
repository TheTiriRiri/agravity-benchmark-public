/**
 * Tests for run-matrix guard:
 * - Refuses to start when rubric starts with maintenance-console-brownfield@ and --base is not provided.
 * - Refuses to start when --base is provided for a non-brownfield rubric.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { validateBaseWithRubric } from "../scripts/run-matrix";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RUN_MATRIX_CLI = join(ROOT, "scripts", "run-matrix.ts");

describe("run-matrix --base and brownfield rubric guard", () => {
  it("validateBaseWithRubric throws when brownfield rubric and no baseDir", () => {
    assert.throws(
      () => validateBaseWithRubric("maintenance-console-brownfield@a906b1e3cadd", undefined, "runner.yaml"),
      /has brownfield rubric .* but --base was not provided/,
    );
  });

  it("validateBaseWithRubric throws when non-brownfield rubric and baseDir is provided", () => {
    assert.throws(
      () => validateBaseWithRubric("maintenance-console@e4feb1ee979a", "/some/base/dir", "runner.yaml"),
      /--base was provided .* but .* has non-brownfield rubric/,
    );
  });

  it("validateBaseWithRubric passes when brownfield rubric and baseDir is provided", () => {
    assert.doesNotThrow(() => {
      validateBaseWithRubric("maintenance-console-brownfield@a906b1e3cadd", "/some/base/dir", "runner.yaml");
    });
  });

  it("validateBaseWithRubric passes when non-brownfield rubric and no baseDir", () => {
    assert.doesNotThrow(() => {
      validateBaseWithRubric("maintenance-console@e4feb1ee979a", undefined, "runner.yaml");
    });
    assert.doesNotThrow(() => {
      validateBaseWithRubric("maintenance-console-hard@5533ac1eb5c5", undefined, "runner.yaml");
    });
  });

  it("CLI: rejects --base with classic runner.yaml under --dry-run", () => {
    const res = spawnSync(
      "node",
      ["--import", "tsx", RUN_MATRIX_CLI, "--base", join(ROOT, "tracks", "brownfield", "base"), "--dry-run"],
      { cwd: ROOT, encoding: "utf8" },
    );
    assert.equal(res.status, 1, "expected non-zero exit code");
    assert.match(res.stderr, /--base was provided .* has non-brownfield rubric/);
  });
});
