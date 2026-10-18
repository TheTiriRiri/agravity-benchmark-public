/**
 * Carrying judge-rows-hard.json across a rubric id change that touched only the
 * hidden contract tests: the judged rows (agent rows, Visual design, Penalty)
 * do not depend on those files, so the judgement stays valid. The proof is that
 * the old id is reproduced from today's files with only contract-tests/ taken
 * from an older revision.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { HARD_RUBRIC_ID_INPUTS, hardRubricId } from "../scripts/lib/hard-rubric";
import { hardRubricIdWithContractTestsAt, migrateJudgeRows } from "../scripts/lib/judge-rows-migrate";
import { parseJudgeRowsHard, type JudgeRowsHard } from "../scripts/lib/judge-rows-hard";

const ROOT = join(import.meta.dirname, "..");
const CONTRACT_TEST = join("tracks", "console-hard", "benchmark", "contract-tests", "planner-split-preempt.test.ts");

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
}

/** A git repository holding only the rubric inputs, copied from this checkout and committed. */
function rubricRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rubric-migrate-"));
  for (const input of HARD_RUBRIC_ID_INPUTS) cpSync(join(ROOT, input), join(dir, input), { recursive: true });
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "inputs");
  return dir;
}

describe("hardRubricIdWithContractTestsAt", () => {
  it("reproduces the old id when only contract-tests/ changed since the revision", () => {
    const dir = rubricRepo();
    try {
      const before = hardRubricId(dir);
      appendFileSync(join(dir, CONTRACT_TEST), "\n// moved\n");
      assert.notEqual(hardRubricId(dir), before);
      assert.equal(hardRubricIdWithContractTestsAt(dir, "HEAD"), before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not reproduce the old id when another rubric input changed too", () => {
    const dir = rubricRepo();
    try {
      const before = hardRubricId(dir);
      appendFileSync(join(dir, CONTRACT_TEST), "\n// moved\n");
      appendFileSync(join(dir, "tracks", "console-hard", "prompt.md"), "\nOne more rule.\n");
      assert.notEqual(hardRubricIdWithContractTestsAt(dir, "HEAD"), before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws on a revision git does not know", () => {
    const dir = rubricRepo();
    try {
      assert.throws(() => hardRubricIdWithContractTestsAt(dir, "no-such-rev"), /no-such-rev/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("migrateJudgeRows", () => {
  const original: JudgeRowsHard = {
    schemaVersion: 1,
    attempt: "a-attempt-1",
    rubric: "maintenance-console-hard@aaaaaaaaaaaa",
    judge: "claude-opus-5-5",
    judgedAt: "2026-10-09T12:00:00.000Z",
    rows: { "Visual design": { score: 1, note: "User: 1", by: "human" } },
  };

  it("restamps the rubric, records where it came from and keeps every row and the judgement time", () => {
    const migrated = migrateJudgeRows(original, { toRubric: "maintenance-console-hard@bbbbbbbbbbbb", rev: "abc1234", at: "2026-10-10T00:00:00.000Z" });
    assert.equal(migrated.rubric, "maintenance-console-hard@bbbbbbbbbbbb");
    assert.deepEqual(migrated.migratedFrom, { rubric: "maintenance-console-hard@aaaaaaaaaaaa", rev: "abc1234", at: "2026-10-10T00:00:00.000Z" });
    assert.deepEqual(migrated.rows, original.rows);
    assert.equal(migrated.judgedAt, original.judgedAt);
    assert.equal(original.rubric, "maintenance-console-hard@aaaaaaaaaaaa", "the input is not mutated");
  });

  it("round-trips through parseJudgeRowsHard", () => {
    const migrated = migrateJudgeRows(original, { toRubric: "maintenance-console-hard@bbbbbbbbbbbb", rev: "abc1234", at: "2026-10-10T00:00:00.000Z" });
    assert.deepEqual(parseJudgeRowsHard(JSON.stringify(migrated)), migrated);
  });

  it("parseJudgeRowsHard rejects a malformed migratedFrom", () => {
    assert.throws(() => parseJudgeRowsHard(JSON.stringify({ ...original, migratedFrom: { rubric: 1 } })), /migratedFrom/);
  });
});
