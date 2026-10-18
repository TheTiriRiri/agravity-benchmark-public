import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BROWNFIELD_RUBRIC_ID_INPUTS,
  brownfieldRubricId,
} from "../scripts/lib/brownfield-rubric";
import { rubricId } from "../scripts/lib/rubric";
import { hardRubricId } from "../scripts/lib/hard-rubric";

const ROOT = join(import.meta.dirname!, "..");

describe("brownfield rubric id with scoring skill (Subtask 7b.4 / 7b.5.2)", () => {
  it("BROWNFIELD_RUBRIC_ID_INPUTS includes .claude/skills/agrav-score-brownfield/SKILL.md", () => {
    const expectedSkillPath = join(".claude", "skills", "agrav-score-brownfield", "SKILL.md");
    assert.ok(
      BROWNFIELD_RUBRIC_ID_INPUTS.includes(expectedSkillPath),
      `BROWNFIELD_RUBRIC_ID_INPUTS must include ${expectedSkillPath}`,
    );
  });

  it("brownfieldRubricId returns string matching rubric pattern", () => {
    const id = brownfieldRubricId(ROOT);
    assert.match(id, /^maintenance-console-brownfield@[0-9a-f]{12}$/);
  });

  it("modifying agrav-score-brownfield/SKILL.md changes brownfieldRubricId", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "agrav-bf-skill-rubric-test-"));
    try {
      for (const input of BROWNFIELD_RUBRIC_ID_INPUTS) {
        const src = join(ROOT, input);
        const dst = join(tempDir, input);
        cpSync(src, dst, { recursive: true });
      }

      const baseId = brownfieldRubricId(tempDir);
      const skillFile = join(tempDir, ".claude", "skills", "agrav-score-brownfield", "SKILL.md");
      const origSkill = readFileSync(skillFile, "utf8");
      writeFileSync(skillFile, `${origSkill}\n# small change\n`);

      const modifiedId = brownfieldRubricId(tempDir);
      assert.notEqual(modifiedId, baseId, "Modifying agrav-score-brownfield/SKILL.md must change brownfieldRubricId");

      writeFileSync(skillFile, origSkill);
      assert.equal(brownfieldRubricId(tempDir), baseId, "Restoring skill restores id");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("modifying classic skill agrav-score-attempt does not change brownfieldRubricId", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "agrav-classic-skill-test-"));
    try {
      for (const input of BROWNFIELD_RUBRIC_ID_INPUTS) {
        const src = join(ROOT, input);
        const dst = join(tempDir, input);
        cpSync(src, dst, { recursive: true });
      }

      const baseId = brownfieldRubricId(tempDir);
      const classicSkill = join(tempDir, ".claude", "skills", "agrav-score-attempt", "SKILL.md");
      // Create classic skill dir in tempDir if needed
      cpSync(join(ROOT, ".claude", "skills", "agrav-score-attempt"), join(tempDir, ".claude", "skills", "agrav-score-attempt"), { recursive: true });
      writeFileSync(classicSkill, "modified classic skill\n");

      assert.equal(brownfieldRubricId(tempDir), baseId, "Classic skill is not a brownfield input");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("modifying brownfield skill does not change classic or hard rubric IDs", () => {
    assert.equal(rubricId(ROOT), "maintenance-console@0f3acd25cedc");
    assert.equal(hardRubricId(ROOT), "maintenance-console-hard@a0d3c3d39eb1");
  });
});
