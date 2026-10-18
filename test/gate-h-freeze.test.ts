/**
 * Tests for Gate H-FREEZE: the hard contract suite and the hard fuzz oracle
 * match the fingerprint recorded in scripts/gate-h-freeze.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fingerprintOf } from "../scripts/lib/gate-fingerprint";
import { checkHFreeze, H_FREEZE_FINGERPRINT, H_FREEZE_PATHS } from "../scripts/gate-h-freeze";

const ROOT = join(import.meta.dirname!, "..");

describe("Gate H-FREEZE", () => {
  it("freezes the hard contract tests and the hard fuzz oracle", () => {
    assert.deepEqual([...H_FREEZE_PATHS], [
      "tracks/console-hard/benchmark/contract-tests/",
      "tracks/console-hard/benchmark/fuzz/expected.json",
    ]);
  });

  it("records the fingerprint of the frozen files as they are", () => {
    assert.match(H_FREEZE_FINGERPRINT, /^[0-9a-f]{64}$/);
    assert.equal(fingerprintOf(ROOT, H_FREEZE_PATHS), H_FREEZE_FINGERPRINT);
    const result = checkHFreeze();
    assert.equal(result.ok, true);
    assert.equal(result.actual, H_FREEZE_FINGERPRINT);
  });

  it("fails on a copy whose frozen files changed by one byte", () => {
    const tmp = mkdtempSync(join(tmpdir(), "h-freeze-"));
    try {
      for (const p of H_FREEZE_PATHS) cpSync(join(ROOT, p), join(tmp, p), { recursive: true });
      const oracle = join(tmp, "tracks/console-hard/benchmark/fuzz/expected.json");
      writeFileSync(oracle, `${readFileSync(oracle, "utf8")} `);
      const result = checkHFreeze(H_FREEZE_FINGERPRINT, tmp);
      assert.equal(result.ok, false);
      assert.notEqual(result.actual, result.expected);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("CLI exits 0 and prints success", () => {
    const proc = spawnSync("node", ["--import", "tsx", join(ROOT, "scripts", "gate-h-freeze.ts")], { cwd: ROOT, encoding: "utf8" });
    assert.equal(proc.status, 0, proc.stderr);
    assert.match(proc.stdout, /H-FREEZE passed/);
  });
});
