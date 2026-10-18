import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { CasesFile } from "../tracks/console-hard/benchmark/fuzz/case";
import {
  FUZZ_SEED,
  GENERATOR_VERSION,
  generateCases,
} from "../tracks/console-hard/benchmark/fuzz/generate";
import {
  CASES_PER_STRATUM,
  HARD_STRATA,
  TOTAL_CASES,
} from "../tracks/console-hard/benchmark/fuzz/strata";

const casesPath = new URL("../tracks/console-hard/benchmark/fuzz/cases.json", import.meta.url);
const manifestPath = new URL("../tracks/console-hard/benchmark/fuzz/manifest.json", import.meta.url);
const seedPath = new URL("../tracks/console-hard/benchmark/context/seed.json", import.meta.url);

const hardSeed = JSON.parse(readFileSync(seedPath, "utf8"));

test("there are 28 strata and 280 cases", () => {
  assert.equal(HARD_STRATA.length, 28);
  assert.equal(CASES_PER_STRATUM, 10);
  assert.equal(TOTAL_CASES, 280);
});

test("every stratum id is unique and kebab-case", () => {
  const ids = HARD_STRATA.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate stratum id");
  for (const id of ids) {
    assert.match(id, /^[a-z0-9-]+$/, `${id} must be kebab-case`);
  }
});

test("cases.json on disk matches generateCases() byte for byte", () => {
  assert.ok(existsSync(casesPath), "cases.json must exist on disk");
  const regenerated = `${JSON.stringify(generateCases(), null, 2)}\n`;
  const onDisk = readFileSync(casesPath, "utf8");
  assert.equal(regenerated, onDisk, "cases.json is stale — run `npm run hard-fuzz:generate`");
});

test("cases.json records the seed and generator version", () => {
  const committed: CasesFile = JSON.parse(readFileSync(casesPath, "utf8"));
  assert.equal(committed.seed, FUZZ_SEED);
  assert.equal(committed.generatorVersion, GENERATOR_VERSION);
  assert.equal(committed.cases.length, TOTAL_CASES);
});

test("each stratum holds exactly ten contiguous cases", () => {
  const committed: CasesFile = JSON.parse(readFileSync(casesPath, "utf8"));
  const counts = new Map<string, number>();
  for (const c of committed.cases) {
    counts.set(c.stratum, (counts.get(c.stratum) ?? 0) + 1);
  }
  for (const stratum of HARD_STRATA) {
    assert.equal(counts.get(stratum.id), CASES_PER_STRATUM, `${stratum.id} case count`);
  }
  assert.equal(counts.size, HARD_STRATA.length);

  let index = 0;
  for (const stratum of HARD_STRATA) {
    for (let i = 0; i < CASES_PER_STRATUM; i += 1, index += 1) {
      assert.equal(committed.cases[index]?.stratum, stratum.id, `case ${index} stratum order mismatch`);
    }
  }
});

test("case ids are sequential case-0000 through case-0279", () => {
  const committed: CasesFile = JSON.parse(readFileSync(casesPath, "utf8"));
  committed.cases.forEach((c, index) => {
    assert.equal(c.id, `case-${String(index).padStart(4, "0")}`);
  });
});

test("every case has valid script length and aim", () => {
  const committed: CasesFile = JSON.parse(readFileSync(casesPath, "utf8"));
  for (const c of committed.cases) {
    assert.ok(c.script.length >= 3 && c.script.length <= 15, `${c.id} script length ${c.script.length}`);
    assert.ok(c.aim.length > 0, `${c.id} missing aim`);
    for (const step of [...c.setup, ...c.script]) {
      assert.ok(step.path.startsWith("/"), `${c.id}: ${step.path} must start with /`);
      assert.ok(!step.path.includes("/reset"), `${c.id}: reset is implicit`);
    }
  }
});

test("created orders start at WO-026 and follow all hard contract validation rules", () => {
  const committed: CasesFile = JSON.parse(readFileSync(casesPath, "utf8"));
  const assetIds = new Set(hardSeed.assets.map((a: { id: string }) => a.id));
  const partIds = new Set(hardSeed.parts.map((p: { id: string }) => p.id));
  const PRIORITIES = new Set(["critical", "high", "medium", "low"]);

  for (const c of committed.cases) {
    let created = 0;
    for (const step of [...c.setup, ...c.script]) {
      if (step.method === "POST" && step.path === "/work-orders") {
        const b = step.body as {
          title: string; asset_id: string; required_skill: string; duration_minutes: number;
          earliest_start: string; due_date: string; priority: string;
          parts?: { part_id: string; quantity: number }[];
          crew_size?: number; splittable?: boolean; min_segment_minutes?: number | null;
        };
        const where = `${c.id} create #${created}`;
        assert.ok(b.title.length > 0 && b.required_skill.length > 0, `${where}: empty title or skill`);
        assert.ok(assetIds.has(b.asset_id), `${where}: ${b.asset_id} is not in hard seed`);
        assert.equal(b.duration_minutes % 30, 0, `${where}: duration not on 30m grid`);
        assert.ok(b.duration_minutes >= 30, `${where}: duration < 30`);
        assert.ok(b.duration_minutes <= 1440, `${where}: duration > 1440`);
        if (!b.splittable) {
          assert.ok(b.duration_minutes <= 480, `${where}: unsplittable duration > 480`);
          assert.equal(b.min_segment_minutes ?? null, null, `${where}: unsplittable min_segment_minutes must be null`);
        } else {
          assert.ok(b.min_segment_minutes !== undefined && b.min_segment_minutes !== null, `${where}: splittable min_segment_minutes required`);
          assert.ok(b.min_segment_minutes >= 60, `${where}: min_segment_minutes < 60`);
          assert.equal(b.min_segment_minutes % 30, 0, `${where}: min_segment_minutes not multiple of 30`);
        }
        if (b.crew_size !== undefined) {
          assert.ok(b.crew_size === 1 || b.crew_size === 2, `${where}: crew_size must be 1 or 2`);
        }
        assert.match(b.earliest_start, /^\d{4}-\d{2}-\d{2}$/, `${where}: earliest_start format`);
        assert.match(b.due_date, /^\d{4}-\d{2}-\d{2}$/, `${where}: due_date format`);
        assert.ok(b.due_date >= b.earliest_start, `${where}: due_date before earliest_start`);
        assert.ok(PRIORITIES.has(b.priority), `${where}: priority invalid`);
        const lines = b.parts ?? [];
        assert.equal(new Set(lines.map((l) => l.part_id)).size, lines.length, `${where}: duplicate part_id`);
        for (const line of lines) {
          assert.ok(partIds.has(line.part_id), `${where}: part ${line.part_id} not in hard seed`);
          assert.ok(Number.isInteger(line.quantity) && line.quantity >= 1, `${where}: quantity invalid`);
        }
        created += 1;
      }
      const ref = /\/work-orders\/WO-(\d{3})/.exec(step.path);
      if (ref && Number(ref[1]) >= 26) {
        assert.ok(
          Number(ref[1]) - 26 < created,
          `${c.id} refers to WO-${ref[1]} before that many orders have been created`,
        );
      }
    }
  }
});

test("stratum 28 preemption-edf-observable exercises the preemption conditions of spec §8.4.4", () => {
  const committed: CasesFile = JSON.parse(readFileSync(casesPath, "utf8"));
  const preemptionCases = committed.cases.filter((c) => c.stratum === "preemption-edf-observable");
  assert.equal(preemptionCases.length, 10);
  for (const c of preemptionCases) {
    const creates = [...c.setup, ...c.script].filter((s) => s.method === "POST" && s.path === "/work-orders");
    // Must have a critical order due on Saturday (2026-10-17) after the Friday window
    const criticalOrder = creates.find((s) => (s.body as any).priority === "critical" && (s.body as any).due_date === "2026-10-17");
    assert.ok(criticalOrder, `${c.id} must include critical order due Saturday 2026-10-17`);
    // Must have a lower priority victim order due earlier in the week
    const victimOrder = creates.find((s) => (s.body as any).priority !== "critical" && (s.body as any).due_date < "2026-10-17");
    assert.ok(victimOrder, `${c.id} must include lower-priority victim order due earlier than Saturday`);
    // Must call POST /plan
    const hasPlan = c.script.some((s) => s.method === "POST" && s.path.startsWith("/plan"));
    assert.ok(hasPlan, `${c.id} script must call POST /plan`);
  }
});

test("fuzz manifest promises 280 tests", () => {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const entry = manifest.files.find((f: { file: string }) => f.file === "fuzz.test.ts");
  assert.ok(entry, "manifest must contain fuzz.test.ts");
  assert.equal(entry.tests, 280);
});
