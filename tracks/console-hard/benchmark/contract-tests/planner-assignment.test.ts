/** Hard track, row "Planner: assignment rules": skill, site, shift, overlap, daily cap, fixed load, week clipping — the classic twelve in the hard shape. */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { EMPTY_WEEK, SEED_WEEK, assertNoSlot, assertSlot, createOrder, order, plan, reset, schedule, seed, seedOrder, setStatus } from "./api";

beforeEach(reset);

const minutes = (iso: string) => Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16));

/**
 * Most seed-week tests change the week through the API before planning it, so
 * a memorised answer to the pristine seed does not match them: a backend that
 * replays one scores 0/12 in this file (measured). The 0.45 of the 5 planner
 * points it keeps comes from elsewhere: the pristine-seed test in
 * planner-ordering.test.ts, and two cancellation tests in planner-parts.test.ts,
 * one that never plans and one that plans only the untouched seed.
 */
const URGENT_CALIBRATION = { asset_id: "A-004", required_skill: "instrumentation", duration_minutes: 120, earliest_start: SEED_WEEK, due_date: SEED_WEEK, priority: "critical" };

test("seed week plus one critical order: every assignment respects crew, skill, sites, shift, grid, one-day, absences, holidays, travel and the cap", async () => {
  const urgent = await createOrder(URGENT_CALIBRATION);
  const result = await plan(SEED_WEEK);
  assert.ok(result.scheduled.includes(urgent.id), "the new critical order must be planned");
  assertNoSlot(await order("WO-009"), "unscheduled", "no_qualified_technician");
  const assets = new Map(seed.assets.map((a) => [a.id, a]));
  const sites = new Map(seed.sites.map((s) => [s.id, s]));
  for (const o of result.orders.filter((x) => x.status === "scheduled")) {
    assert.equal(o.technician_ids.length, o.crew_size, `${o.id} has ${o.technician_ids.length} technicians for a crew of ${o.crew_size}`);
    const total = o.segments.reduce((sum, s) => sum + minutes(s.end) - minutes(s.start), 0);
    assert.equal(total, o.duration_minutes, `${o.id}'s segments do not add up to its duration`);
    for (const id of o.technician_ids) {
      const technician = seed.technicians.find((t) => t.id === id);
      assert.ok(technician, `${o.id} names an unknown technician`);
      assert.ok(technician.skills.includes(o.required_skill), `${o.id}: ${technician.id} lacks ${o.required_skill}`);
      assert.ok(technician.site_ids.includes(assets.get(o.asset_id)!.site_id), `${o.id}: ${technician.id} does not serve that site`);
      for (const s of o.segments) {
        assert.equal(s.start.slice(0, 10), s.end.slice(0, 10), `${o.id} spans two days`);
        assert.equal(minutes(s.start) % 30, 0, `${o.id} is off the 30-minute grid`);
        assert.ok(s.start.slice(11, 16) >= technician.shift_start, `${o.id} starts before the shift`);
        assert.ok(s.end.slice(11, 16) <= technician.shift_end, `${o.id} ends after the shift`);
        assert.ok(s.start.slice(0, 10) >= o.earliest_start && s.start.slice(0, 10) <= o.due_date);
        const day = s.start.slice(0, 10);
        assert.ok(!sites.get(assets.get(o.asset_id)!.site_id)!.holidays.includes(day), `${o.id} works at a closed site on ${day}`);
        for (const a of technician.absences.filter((x) => x.date === day)) {
          assert.ok(s.end.slice(11, 16) <= a.from || s.start.slice(11, 16) >= a.to, `${o.id}: ${technician.id} is absent then`);
        }
      }
    }
  }
  for (const technician of (await schedule(SEED_WEEK)).technicians) {
    const perDay = new Map<string, number>();
    const rows = technician.assignments;
    rows.forEach((a, index) => {
      const day = a.scheduled_start.slice(0, 10);
      let load = minutes(a.scheduled_end) - minutes(a.scheduled_start);
      const previous = rows[index - 1];
      if (previous && previous.scheduled_start.slice(0, 10) === day) {
        const travel = sites.get(assets.get(previous.asset_id)!.site_id)!.travel_minutes[assets.get(a.asset_id)!.site_id];
        assert.ok(minutes(a.scheduled_start) - minutes(previous.scheduled_end) >= travel, `${technician.technician_id} has no time to travel on ${day}`);
        load += travel;
      }
      perDay.set(day, (perDay.get(day) ?? 0) + load);
    });
    for (const [day, total] of perDay) assert.ok(total <= 480, `${technician.technician_id} has ${total} min of work and travel on ${day}`);
  }
});


test("seed week plus one critical order: the 480-minute cap binds before a ten-hour shift does", async () => {
  const urgent = await createOrder(URGENT_CALIBRATION);
  await plan(SEED_WEEK);
  assertSlot(await order("WO-001"), "T-001", "2026-10-05T07:00:00", "2026-10-05T11:00:00");
  assertSlot(await order(urgent.id), "T-001", "2026-10-05T11:00:00", "2026-10-05T13:00:00");
  assertNoSlot(await order("WO-002"), "unscheduled", "no_capacity");
  assertSlot(await order("WO-003"), "T-001", "2026-10-05T13:00:00", "2026-10-05T14:00:00");
});

test("seed week: work that fits neither side of a fixed slot is unscheduled, and fits once the slot is freed", async () => {
  await plan(SEED_WEEK);
  assertNoSlot(await order("WO-011"), "unscheduled", "no_capacity");
  await setStatus("WO-010", "cancelled");
  await plan(SEED_WEEK);
  assertSlot(await order("WO-011"), "T-003", "2026-10-07T08:00:00", "2026-10-07T13:00:00");
});

test("seed week plus one critical order: completed and in_progress orders are never moved and block their slot", async () => {
  const urgent = await createOrder({ asset_id: "A-001", required_skill: "mechanical", duration_minutes: 60, earliest_start: SEED_WEEK, due_date: SEED_WEEK, priority: "critical" });
  const result = await plan(SEED_WEEK);
  assert.ok(!result.orders.some((o) => o.id === "WO-008" || o.id === "WO-010"), "fixed orders are not candidates");
  assert.deepEqual(await order("WO-008"), seedOrder("WO-008"));
  assert.deepEqual(await order("WO-010"), seedOrder("WO-010"));
  assertSlot(await order(urgent.id), "T-002", "2026-10-05T09:00:00", "2026-10-05T10:00:00");
  // EDF: WO-005 (due Tuesday) now goes before WO-007 (due Friday), whatever their priorities.
  assertSlot(await order("WO-005"), "T-002", "2026-10-05T10:00:00", "2026-10-05T11:30:00");
  assertSlot(await order("WO-007"), "T-002", "2026-10-05T11:30:00", "2026-10-05T14:30:00");
  assertSlot(await order("WO-006"), "T-002", "2026-10-05T14:30:00", "2026-10-05T15:30:00");
});

test("skill: a later-starting skilled technician wins over an earlier unskilled one", async () => {
  const created = await createOrder({ asset_id: "A-006", required_skill: "hydraulics", duration_minutes: 60, earliest_start: EMPTY_WEEK, due_date: EMPTY_WEEK });
  await plan(EMPTY_WEEK);
  assertSlot(await order(created.id), "T-003", "2026-10-12T08:00:00", "2026-10-12T09:00:00");
});

test("site: a skilled technician at another site does not qualify", async () => {
  const created = await createOrder({ asset_id: "A-005", required_skill: "electrical", duration_minutes: 60, earliest_start: EMPTY_WEEK, due_date: EMPTY_WEEK });
  await plan(EMPTY_WEEK);
  assertNoSlot(await order(created.id), "unscheduled", "no_qualified_technician");
});

test("overlap: two orders for one technician are placed back to back", async () => {
  const base = { asset_id: "A-006", required_skill: "hydraulics", duration_minutes: 240, earliest_start: EMPTY_WEEK, due_date: EMPTY_WEEK };
  const first = await createOrder({ ...base, priority: "high" });
  const second = await createOrder({ ...base, priority: "low" });
  await plan(EMPTY_WEEK);
  assertSlot(await order(first.id), "T-003", "2026-10-12T08:00:00", "2026-10-12T12:00:00");
  assertSlot(await order(second.id), "T-003", "2026-10-12T12:00:00", "2026-10-12T16:00:00");
});

test("daily cap: the ninth hour of work moves to the next day when the window allows it", async () => {
  const base = { asset_id: "A-004", required_skill: "instrumentation", earliest_start: EMPTY_WEEK, due_date: "2026-10-13" };
  const a = await createOrder({ ...base, duration_minutes: 240, priority: "critical" });
  const b = await createOrder({ ...base, duration_minutes: 240, priority: "high" });
  const c = await createOrder({ ...base, duration_minutes: 60, priority: "low" });
  await plan(EMPTY_WEEK);
  assertSlot(await order(a.id), "T-001", "2026-10-12T07:00:00", "2026-10-12T11:00:00");
  assertSlot(await order(b.id), "T-001", "2026-10-12T11:00:00", "2026-10-12T15:00:00");
  assertSlot(await order(c.id), "T-001", "2026-10-13T07:00:00", "2026-10-13T08:00:00");
});

test("fixed load: an in_progress order keeps its slot and its minutes count toward the cap", async () => {
  const base = { asset_id: "A-004", required_skill: "instrumentation", earliest_start: EMPTY_WEEK, due_date: EMPTY_WEEK };
  const running = await createOrder({ ...base, duration_minutes: 240, priority: "critical" });
  await plan(EMPTY_WEEK);
  await setStatus(running.id, "in_progress");
  const next = await createOrder({ ...base, duration_minutes: 240, priority: "high" });
  const overflow = await createOrder({ ...base, duration_minutes: 60, priority: "low" });
  const result = await plan(EMPTY_WEEK);
  assert.ok(!result.orders.some((o) => o.id === running.id), "an in_progress order is not a candidate");
  assert.equal((await order(running.id)).segments[0].start, "2026-10-12T07:00:00");
  assertSlot(await order(next.id), "T-001", "2026-10-12T11:00:00", "2026-10-12T15:00:00");
  assertNoSlot(await order(overflow.id), "unscheduled", "no_capacity");
});

test("shift: work may not run past shift end, even under the cap and with a free gap too small to use", async () => {
  const base = { asset_id: "A-006", required_skill: "hydraulics", earliest_start: "2026-10-14", due_date: "2026-10-14" };
  const gap = await createOrder({ ...base, duration_minutes: 60, priority: "critical" });
  const fixed = await createOrder({ ...base, duration_minutes: 120, priority: "high" });
  await plan(EMPTY_WEEK);
  assertSlot(await order(fixed.id), "T-003", "2026-10-14T09:00:00", "2026-10-14T11:00:00");
  await setStatus(fixed.id, "in_progress");
  await setStatus(gap.id, "cancelled");
  const long = await createOrder({ ...base, duration_minutes: 330, priority: "medium" });
  const short = await createOrder({ ...base, duration_minutes: 60, priority: "low" });
  await plan(EMPTY_WEEK);
  assertNoSlot(await order(long.id), "unscheduled", "no_capacity");
  assertSlot(await order(short.id), "T-003", "2026-10-14T08:00:00", "2026-10-14T09:00:00");
});

test("week clipping: a window that opened last week starts on Monday, and weekends are never used", async () => {
  const early = await createOrder({ asset_id: "A-006", required_skill: "hydraulics", duration_minutes: 60, earliest_start: "2026-10-10", due_date: EMPTY_WEEK, priority: "low" });
  const friday = { asset_id: "A-006", required_skill: "hydraulics", duration_minutes: 480, earliest_start: "2026-10-16" };
  const fills = await createOrder({ ...friday, due_date: "2026-10-16", priority: "critical" });
  const spills = await createOrder({ ...friday, due_date: "2026-10-18", priority: "medium" });
  await plan(EMPTY_WEEK);
  assertSlot(await order(early.id), "T-003", "2026-10-12T08:00:00", "2026-10-12T09:00:00");
  assertSlot(await order(fills.id), "T-003", "2026-10-16T08:00:00", "2026-10-16T16:00:00");
  assertNoSlot(await order(spills.id), "unscheduled", "no_capacity");
});

test("candidates: an order whose window misses the week entirely stays open", async () => {
  const later = await createOrder({ asset_id: "A-006", required_skill: "hydraulics", duration_minutes: 60, earliest_start: "2026-10-19", due_date: "2026-10-20" });
  const result = await plan(EMPTY_WEEK);
  assert.deepEqual(result.orders, []);
  assert.equal((await order(later.id)).status, "open");
});
