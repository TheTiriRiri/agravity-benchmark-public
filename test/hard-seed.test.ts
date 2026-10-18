/** The hard seed's invariants (spec §8.4.2 and §8.4.6), checked without a backend. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { HARD_SCHEMA, HARD_SEED, renderHardSeed } from "../tracks/console-hard/benchmark/context/hard-seed";

const text = readFileSync(HARD_SEED, "utf8");
const seed = JSON.parse(text);
const classic = JSON.parse(readFileSync(new URL("../benchmark/context/seed.json", import.meta.url), "utf8"));

const HARD_SKILLS = ["pneumatics", "welding"];
const WEEKS = { seed: "2026-10-05", empty: "2026-10-12", rules: "2026-10-19" };

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const inWeek = (day: string, monday: string) => {
  const offset = (Date.parse(day) - Date.parse(monday)) / 86_400_000;
  return offset >= 0 && offset <= 4;
};
const siteOf = (assetId: string): string => seed.assets.find((a: { id: string }) => a.id === assetId).site_id;
const travel = (a: string, b: string): number => seed.sites.find((s: { id: string }) => s.id === a).travel_minutes[b];

test("the committed hard seed is exactly what hard-seed.ts builds from the committed classic seed", () => {
  assert.equal(text, renderHardSeed(), "run `npm run hard-seed:write` and commit seed.json");
  assert.equal(seed.schema, HARD_SCHEMA);
});

test("every classic entity keeps its id and attributes, reshaped; everything added comes after", () => {
  for (const kind of ["sites", "assets", "technicians", "parts", "work_orders"] as const) {
    const ids = seed[kind].map((x: { id: string }) => x.id);
    assert.deepEqual(ids.slice(0, classic[kind].length), classic[kind].map((x: { id: string }) => x.id), kind);
    assert.deepEqual(ids, [...ids].sort(), `${kind} are sorted by id`);
  }
  for (const [index, t] of classic.technicians.entries()) {
    const { site_id, ...rest } = t;
    assert.deepEqual(seed.technicians[index], { ...rest, site_ids: [site_id], absences: [] });
  }
  for (const [index, o] of classic.work_orders.entries()) {
    const hard = seed.work_orders[index];
    assert.deepEqual(hard.technician_ids, o.technician_id === null ? [] : [o.technician_id]);
    assert.deepEqual(hard.segments, o.scheduled_start === null ? [] : [{ start: o.scheduled_start, end: o.scheduled_end }]);
    assert.deepEqual([hard.crew_size, hard.splittable, hard.min_segment_minutes], [1, false, null]);
  }
  assert.deepEqual(seed.assets.slice(0, classic.assets.length), classic.assets);
  assert.deepEqual(seed.parts.slice(0, classic.parts.length), classic.parts);
});

test("only the added technicians hold the hard skills, and they hold no classic one", () => {
  for (const t of seed.technicians) {
    const hard = t.skills.filter((s: string) => HARD_SKILLS.includes(s));
    const added = classic.technicians.every((c: { id: string }) => c.id !== t.id);
    assert.equal(hard.length > 0, added, `${t.id}`);
    if (added) assert.deepEqual(hard, t.skills, `${t.id} holds a classic skill, so a ported classic world would change`);
  }
});

test("the travel matrix is complete, symmetric, zero exactly on the diagonal, on the grid, and satisfies the triangle inequality", () => {
  const ids: string[] = seed.sites.map((s: { id: string }) => s.id);
  for (const s of seed.sites) assert.deepEqual(Object.keys(s.travel_minutes), ids, `${s.id}'s travel row`);
  for (const a of ids) {
    for (const b of ids) {
      assert.equal(travel(a, b), travel(b, a), `${a}-${b} is not symmetric`);
      assert.equal(travel(a, b) === 0, a === b, `${a}-${b}: zero exactly on the diagonal`);
      assert.equal(travel(a, b) % 30, 0, `${a}-${b} is off the grid`);
      for (const c of ids) assert.ok(travel(a, c) <= travel(a, b) + travel(b, c), `${a}-${c} > ${a}-${b}-${c}`);
    }
  }
});

test("absences are sorted, on the grid, non-empty and inside the shift; holidays are sorted", () => {
  for (const t of seed.technicians) {
    const keys = t.absences.map((a: { date: string; from: string }) => `${a.date} ${a.from}`);
    assert.deepEqual(keys, [...keys].sort(), `${t.id}'s absences`);
    for (const a of t.absences) {
      assert.ok(minutes(a.from) < minutes(a.to) && minutes(a.from) % 30 === 0 && minutes(a.to) % 30 === 0, `${t.id} ${a.date}`);
      assert.ok(a.from >= t.shift_start && a.to <= t.shift_end, `${t.id} ${a.date} is outside the shift`);
    }
  }
  for (const s of seed.sites) assert.deepEqual(s.holidays, [...s.holidays].sort(), `${s.id}'s holidays`);
});

test("the fixed load avoids absences and holidays and already satisfies travel and the cap", () => {
  const fixed = seed.work_orders.filter((o: { status: string }) => o.status === "in_progress" || o.status === "completed");
  assert.ok(fixed.length > 0);
  const days = new Map<string, { start: string; end: string; site: string }[]>();
  for (const o of fixed) {
    for (const id of o.technician_ids) {
      const t = seed.technicians.find((x: { id: string }) => x.id === id);
      for (const s of o.segments) {
        const day = s.start.slice(0, 10);
        assert.ok(!seed.sites.find((x: { id: string }) => x.id === siteOf(o.asset_id)).holidays.includes(day), `${o.id} is on a holiday`);
        for (const a of t.absences.filter((x: { date: string }) => x.date === day)) {
          assert.ok(s.end.slice(11, 16) <= a.from || s.start.slice(11, 16) >= a.to, `${o.id} overlaps ${id}'s absence`);
        }
        days.set(`${id} ${day}`, [...(days.get(`${id} ${day}`) ?? []), { start: s.start, end: s.end, site: siteOf(o.asset_id) }]);
      }
    }
  }
  for (const [key, rows] of days) {
    rows.sort((x, y) => x.start.localeCompare(y.start));
    let load = 0;
    rows.forEach((r, i) => {
      load += minutes(r.end.slice(11, 16)) - minutes(r.start.slice(11, 16));
      if (i === 0) return;
      const gap = minutes(r.start.slice(11, 16)) - minutes(rows[i - 1].end.slice(11, 16));
      assert.ok(gap >= travel(rows[i - 1].site, r.site), `${key}: no time to travel`);
      load += travel(rows[i - 1].site, r.site);
    });
    assert.ok(load <= 480, `${key}: ${load} minutes of fixed work and travel`);
  }
});

test("rule 7(iv) can bite: some multi-site technician's shift is longer than 480 minutes", () => {
  assert.ok(seed.technicians.some((t: { site_ids: string[]; shift_start: string; shift_end: string }) => t.site_ids.length > 1 && minutes(t.shift_end) - minutes(t.shift_start) > 480));
});

test("the three weeks hold what spec §8.4.6 says: every rule in the seed week, nothing in the empty week, absences and a holiday but no order in the rules week", () => {
  const absences = seed.technicians.flatMap((t: { absences: { date: string }[] }) => t.absences.map((a) => a.date));
  const holidays = seed.sites.flatMap((s: { holidays: string[] }) => s.holidays);
  const touches = (monday: string) => seed.work_orders.filter((o: { earliest_start: string; due_date: string }) => {
    const friday = new Date(Date.parse(monday) + 4 * 86_400_000).toISOString().slice(0, 10);
    return o.earliest_start <= friday && o.due_date >= monday;
  });
  assert.ok(absences.some((d: string) => inWeek(d, WEEKS.seed)) && holidays.some((d: string) => inWeek(d, WEEKS.seed)), "seed week");
  assert.deepEqual(touches(WEEKS.empty), [], "no seeded order's window reaches the empty week");
  assert.ok(!absences.some((d: string) => inWeek(d, WEEKS.empty)) && !holidays.some((d: string) => inWeek(d, WEEKS.empty)), "empty week");
  assert.deepEqual(touches(WEEKS.rules), [], "no seeded order's window reaches the rules week");
  assert.ok(absences.some((d: string) => inWeek(d, WEEKS.rules)) && holidays.some((d: string) => inWeek(d, WEEKS.rules)), "rules week");
});
