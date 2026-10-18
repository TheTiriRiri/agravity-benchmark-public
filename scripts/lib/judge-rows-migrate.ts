/**
 * Carrying judge-rows-hard.json across a hard rubric id change that touched
 * only the hidden contract tests.
 *
 * The judged rows (the three agent rows, Visual design, Penalty) are scored on
 * the attempt's source, the served app and criteria.md; the contract tests do
 * not enter them. When those tests are the only rubric input that changed, the
 * judgement still holds and can be restamped instead of redone. The proof is
 * `hardRubricIdWithContractTestsAt`: today's rubric inputs, with only
 * contract-tests/ taken from the old revision, must hash to the old id.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HARD_RUBRIC_ID_INPUTS, hardRubricId } from "./hard-rubric";
import type { JudgeRowsHard } from "./judge-rows-hard";

export const CONTRACT_TESTS_INPUT = join("tracks", "console-hard", "benchmark", "contract-tests");

/**
 * The hard rubric id of `root`'s current rubric inputs, except contract-tests/,
 * which is read from git revision `rev` of the repository at `root`.
 */
export function hardRubricIdWithContractTestsAt(root: string, rev: string): string {
  if (!HARD_RUBRIC_ID_INPUTS.includes(CONTRACT_TESTS_INPUT)) {
    throw new Error(`${CONTRACT_TESTS_INPUT} is no longer a hard rubric input`);
  }
  const dir = mkdtempSync(join(tmpdir(), "hard-rubric-at-"));
  try {
    for (const input of HARD_RUBRIC_ID_INPUTS) {
      if (input === CONTRACT_TESTS_INPUT) continue;
      cpSync(join(root, input), join(dir, input), { recursive: true });
    }
    const archive = spawnSync("git", ["archive", "--format=tar", rev, "--", CONTRACT_TESTS_INPUT.split("\\").join("/")], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (archive.status !== 0) {
      throw new Error(`git archive ${rev} failed: ${archive.stderr.toString().trim()}`);
    }
    const untar = spawnSync("tar", ["-x", "-C", dir], { input: archive.stdout });
    if (untar.status !== 0) throw new Error(`tar -x failed: ${untar.stderr.toString().trim()}`);
    return hardRubricId(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface MigrationStamp {
  toRubric: string;
  /** The git revision whose contract tests the old rubric id was computed with. */
  rev: string;
  at: string;
}

/** A copy of `data` under `toRubric`, recording the rubric it was judged under. */
export function migrateJudgeRows(data: JudgeRowsHard, stamp: MigrationStamp): JudgeRowsHard {
  return {
    ...data,
    rubric: stamp.toRubric,
    migratedFrom: { rubric: data.rubric, rev: stamp.rev, at: stamp.at },
  };
}
