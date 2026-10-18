import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { CasesFile } from "../tracks/console-fuzz/benchmark/fuzz/case";
import { generateCases, FUZZ_SEED, GENERATOR_VERSION, SOLE, STOCK, TECHNICIANS } from "../tracks/console-fuzz/benchmark/fuzz/generate";
import { CASES_PER_STRATUM, STRATA, TOTAL_CASES } from "../tracks/console-fuzz/benchmark/fuzz/strata";

const COMMITTED: CasesFile = JSON.parse(
  readFileSync(fileURLToPath(new URL("../tracks/console-fuzz/benchmark/fuzz/cases.json", import.meta.url)), "utf8"),
);

test("there are twenty strata and two hundred cases", () => {
  assert.equal(STRATA.length, 20);
  assert.equal(CASES_PER_STRATUM, 10);
  assert.equal(TOTAL_CASES, 200);
});

test("every stratum id is unique and usable inside a test name", () => {
  const ids = STRATA.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate stratum id");
  for (const id of ids) {
    assert.match(id, /^[a-z0-9-]+$/, `${id} must be kebab-case: it is half of a test name`);
  }
});

test("the committed cases.json is exactly what the generator produces now", () => {
  // Byte-identity, not deep equality: gate:fuzz rewrites this file, and a
  // whitespace-only difference there would churn the diff of every future
  // regeneration.
  const regenerated = `${JSON.stringify(generateCases(), null, 2)}\n`;
  const onDisk = readFileSync(
    fileURLToPath(new URL("../tracks/console-fuzz/benchmark/fuzz/cases.json", import.meta.url)),
    "utf8",
  );
  assert.equal(regenerated, onDisk, "cases.json is stale — run `npm run fuzz:generate`");
});

test("the file records the seed and the generator version it came from", () => {
  assert.equal(COMMITTED.seed, FUZZ_SEED);
  assert.equal(COMMITTED.generatorVersion, GENERATOR_VERSION);
  assert.equal(FUZZ_SEED, 20260921, "the seed is part of the artefact; changing it regenerates everything");
});

test("each stratum holds exactly ten cases, assigned by the generator", () => {
  const counts = new Map<string, number>();
  for (const c of COMMITTED.cases) counts.set(c.stratum, (counts.get(c.stratum) ?? 0) + 1);
  for (const stratum of STRATA) {
    assert.equal(counts.get(stratum.id), CASES_PER_STRATUM, `${stratum.id} has ${counts.get(stratum.id) ?? 0} cases`);
  }
  assert.equal(counts.size, STRATA.length, "a case carries a stratum that is not in STRATA");
});

test("case ids are the dense, ordered range the oracle keys on", () => {
  assert.equal(COMMITTED.cases.length, TOTAL_CASES);
  COMMITTED.cases.forEach((c, index) => {
    assert.equal(c.id, `case-${String(index).padStart(4, "0")}`, "ids must stay positional and stable");
  });
});

test("every case is self-contained, small enough to read, and aims at something", () => {
  for (const c of COMMITTED.cases) {
    assert.ok(c.script.length >= 4 && c.script.length <= 10, `${c.id} has ${c.script.length} scripted calls`);
    assert.ok(c.aim.length > 0, `${c.id} has no aim`);
    for (const step of [...c.setup, ...c.script]) {
      assert.ok(step.path.startsWith("/"), `${c.id}: ${step.path} is not a path under /api/v1`);
      assert.ok(!step.path.includes("/reset"), `${c.id}: reset is implicit, never a step`);
    }
  }
});

test("every create step would be accepted by the contract, so no case shifts its ids", () => {
  // The builders address created orders as WO-015, WO-016, … (prompt.md §2
  // guarantees it, and api-contract.test.ts asserts it against every backend).
  // That only holds while every create succeeds: a 422 creates nothing, the
  // next order takes the number this one did not, and `getOrder(createdId(n))`
  // then asks about the wrong order — or about one that does not exist, whose
  // 404 body is free-text prose. Revision 1 lost a whole stratum this way, so
  // the contract's validation rules are re-asserted here, statically.
  const seed = JSON.parse(
    readFileSync(fileURLToPath(new URL("../benchmark/context/seed.json", import.meta.url)), "utf8"),
  ) as { assets: { id: string }[]; parts: { id: string }[] };
  const assets = new Set(seed.assets.map((a) => a.id));
  const partIds = new Set(seed.parts.map((p) => p.id));
  const PRIORITIES = new Set(["critical", "high", "medium", "low"]);

  for (const c of COMMITTED.cases) {
    let created = 0;
    for (const step of [...c.setup, ...c.script]) {
      if (step.method === "POST" && step.path === "/work-orders") {
        const b = step.body as {
          title: string; asset_id: string; required_skill: string; duration_minutes: number;
          earliest_start: string; due_date: string; priority: string;
          parts?: { part_id: string; quantity: number }[];
        };
        const where = `${c.id} create #${created}`;
        assert.ok(b.title.length > 0 && b.required_skill.length > 0, `${where}: empty title or skill is 422`);
        assert.ok(assets.has(b.asset_id), `${where}: ${b.asset_id} is not a seeded asset`);
        assert.equal(b.duration_minutes % 30, 0, `${where}: ${b.duration_minutes} is not on the 30-minute grid`);
        assert.ok(b.duration_minutes >= 30 && b.duration_minutes <= 480, `${where}: ${b.duration_minutes} is out of [30, 480]`);
        assert.match(b.earliest_start, /^\d{4}-\d{2}-\d{2}$/, `${where}: malformed earliest_start`);
        assert.match(b.due_date, /^\d{4}-\d{2}-\d{2}$/, `${where}: malformed due_date`);
        assert.ok(b.due_date >= b.earliest_start, `${where}: due_date before earliest_start is 422`);
        assert.ok(PRIORITIES.has(b.priority), `${where}: ${b.priority} is not a priority`);
        const lines = b.parts ?? [];
        assert.equal(new Set(lines.map((l) => l.part_id)).size, lines.length, `${where}: a part_id appears twice`);
        for (const line of lines) {
          assert.ok(partIds.has(line.part_id), `${where}: ${line.part_id} is not a seeded part`);
          assert.ok(Number.isInteger(line.quantity) && line.quantity >= 1, `${where}: quantity ${line.quantity} is 422`);
        }
        created += 1;
      }
      const referenced = /\/work-orders\/WO-(\d{3})/.exec(step.path);
      if (referenced && Number(referenced[1]) >= 15) {
        assert.ok(
          Number(referenced[1]) - 15 < created,
          `${c.id} refers to WO-${referenced[1]} before that many orders have been created`,
        );
      }
    }
  }
});

test("each stratum's cases are contiguous, because notRun is a tail", () => {
  // contract-suite reports tests a timeout cut off as a count with no names,
  // and they are the tail of the file in file order (measured on node 24
  // during review). scoreFuzz can only attribute that tail to strata while the
  // file's order is STRATA's order and each stratum's cases are consecutive.
  let index = 0;
  for (const stratum of STRATA) {
    for (let i = 0; i < CASES_PER_STRATUM; i += 1, index += 1) {
      assert.equal(COMMITTED.cases[index]?.stratum, stratum.id, `case ${index} breaks the stratum blocks`);
    }
  }
});

test("the manifest promises exactly as many tests as there are cases", () => {
  // contract-suite raises a harness fault when a file reports more tests than
  // the manifest says, which would discard the whole run rather than score it.
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL("../tracks/console-fuzz/benchmark/fuzz/manifest.json", import.meta.url)), "utf8"),
  ) as { files: { file: string; tests: number }[] };
  const entry = manifest.files.find((f) => f.file === "fuzz.test.ts");
  assert.ok(entry, "the manifest has no fuzz.test.ts entry");
  assert.equal(entry.tests, COMMITTED.cases.length);
});

test("no case names an entity the seed does not have", () => {
  // A case referring to A-999 would fail against every backend for a reason
  // that has nothing to do with the model.
  const seed = JSON.parse(
    readFileSync(fileURLToPath(new URL("../benchmark/context/seed.json", import.meta.url)), "utf8"),
  ) as { assets: { id: string }[]; parts: { id: string }[]; technicians: { id: string }[] };
  const known = new Set([...seed.assets, ...seed.parts, ...seed.technicians].map((e) => e.id));
  const referenced = JSON.stringify(COMMITTED.cases).match(/"[APT]-\d{3}"/g) ?? [];
  for (const raw of referenced) {
    const id = raw.slice(1, -1);
    assert.ok(known.has(id), `${id} is referenced by a case but is not in the seed`);
  }
});

test("the generator's technician, stock and sole-qualified tables are the seed's", () => {
  // Revision 1 of the plan reasoned from a technician table that was wrong, and
  // every builder that trusted it was wrong with it. These tables are typed into
  // the generator and re-derived here from the file they claim to copy, so the
  // next drift is a red test rather than a stratum that measures the wrong rule.
  const seed = JSON.parse(
    readFileSync(fileURLToPath(new URL("../benchmark/context/seed.json", import.meta.url)), "utf8"),
  ) as {
    assets: { id: string; site_id: string }[];
    technicians: { id: string; site_id: string; skills: string[]; shift_start: string; shift_end: string }[];
    parts: { id: string; on_hand: number; reserved: number }[];
  };
  const minutesOf = (hhmm: string): number => {
    const [h, m] = hhmm.split(":").map(Number) as [number, number];
    return h * 60 + m;
  };

  assert.equal(TECHNICIANS.length, seed.technicians.length, "a technician is missing from, or extra in, the table");
  for (const t of TECHNICIANS) {
    const real = seed.technicians.find((x) => x.id === t.id);
    assert.ok(real, `${t.id} is not in the seed`);
    assert.equal(real.site_id, t.site, `${t.id}: site`);
    assert.deepEqual([...real.skills].sort(), [...t.skills].sort(), `${t.id}: skills`);
    assert.deepEqual([real.shift_start, real.shift_end], [...t.shift], `${t.id}: shift`);
    assert.equal(minutesOf(real.shift_end) - minutesOf(real.shift_start), t.minutes, `${t.id}: shift minutes`);
  }

  for (const entry of SOLE) {
    const sites = new Set(entry.assets.map((a) => seed.assets.find((x) => x.id === a)?.site_id));
    assert.equal(sites.size, 1, `${entry.tech}: its assets are not all at one site`);
    const [site] = [...sites];
    const qualified = seed.technicians.filter((t) => t.site_id === site && t.skills.includes(entry.skill));
    assert.deepEqual(
      qualified.map((t) => t.id),
      [entry.tech],
      `${entry.skill} at ${site} must be held by exactly ${entry.tech}, or decision 7's trivial regime is false`,
    );
    const [only] = qualified;
    assert.equal(minutesOf(only!.shift_end) - minutesOf(only!.shift_start), entry.minutes, `${entry.tech}: minutes`);
  }

  assert.equal(STOCK.length, seed.parts.length, "a part is missing from, or extra in, the stock table");
  for (const p of STOCK) {
    const real = seed.parts.find((x) => x.id === p.id);
    assert.ok(real, `${p.id} is not in the seed`);
    assert.equal(real.on_hand - real.reserved, p.available, `${p.id}: available`);
  }
});
