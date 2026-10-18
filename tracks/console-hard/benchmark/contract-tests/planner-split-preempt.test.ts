/**
 * Hard track, new rules (spec §8.4.4): splitting (rule 8.2) and preemption
 * (rule 11). Worlds are built in EMPTY_WEEK around T-005, the only technician
 * who can do pneumatics or welding at Northgate (S-001): 07:00-17:00, cap 480.
 * A critical order due on the Saturday after the week is the natural subject
 * of preemption under EDF (§8.4.4, "When preemption can fire at all").
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { EMPTY_WEEK, SEED_WEEK, assertNoSlot, assertPlacement, assertSlot, createOrder, ok, order, part, plan, reset, schedule, setStatus } from "./api";

beforeEach(reset);

const DAYS = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"] as const;
const [MON, TUE, WED, THU, FRI] = DAYS;
const SAT = "2026-10-17";
const NORTH_AIR = { asset_id: "A-004", required_skill: "pneumatics" };
const NORTH_WELD = { asset_id: "A-001", required_skill: "welding" };

/** One order per given day, planned and set in_progress: fixed load that blocks a 480-minute order through the cap. */
async function fixDays(days: readonly string[], minutes = 60): Promise<void> {
  const ids = [];
  for (const day of days) ids.push((await createOrder({ ...NORTH_AIR, duration_minutes: minutes, earliest_start: day, due_date: day, priority: "critical" })).id);
  await plan(EMPTY_WEEK);
  for (const id of ids) await setStatus(id, "in_progress");
}

test("split: only when no unsplit slot exists, with the longest first segment that leaves a legal rest", async () => {
  const long = await createOrder({ ...NORTH_WELD, duration_minutes: 600, earliest_start: MON, due_date: TUE, splittable: true, min_segment_minutes: 120 });
  await plan(EMPTY_WEEK);
  assertPlacement(await order(long.id), ["T-005"], [["2026-10-12T07:00:00", "2026-10-12T15:00:00"], ["2026-10-13T07:00:00", "2026-10-13T09:00:00"]]);
});

test("split: a crew keeps one technician set for every segment, and the schedule lists each segment under each member", async () => {
  const crew = await createOrder({ asset_id: "A-009", required_skill: "welding", duration_minutes: 600, earliest_start: MON, due_date: TUE, crew_size: 2, splittable: true, min_segment_minutes: 120 });
  await plan(EMPTY_WEEK);
  assertPlacement(await order(crew.id), ["T-005", "T-007"], [["2026-10-12T08:00:00", "2026-10-12T16:00:00"], ["2026-10-13T08:00:00", "2026-10-13T10:00:00"]]);
  const rows = (await schedule(EMPTY_WEEK)).technicians.flatMap((t) =>
    t.assignments.filter((a) => a.work_order_id === crew.id).map((a) => `${t.technician_id} ${a.scheduled_start}-${a.scheduled_end.slice(11)}`),
  );
  assert.deepEqual(rows, [
    "T-005 2026-10-12T08:00:00-16:00:00", "T-005 2026-10-13T08:00:00-10:00:00",
    "T-007 2026-10-12T08:00:00-16:00:00", "T-007 2026-10-13T08:00:00-10:00:00",
  ]);
});

test("split: a splittable order that fits whole is not split, even when a split would start earlier", async () => {
  const filler = await createOrder({ ...NORTH_WELD, duration_minutes: 120, earliest_start: MON, due_date: MON, priority: "critical" });
  const blocker = await createOrder({ ...NORTH_WELD, duration_minutes: 360, earliest_start: MON, due_date: MON, priority: "high" });
  await plan(EMPTY_WEEK);
  assertSlot(await order(blocker.id), "T-005", "2026-10-12T09:00:00", "2026-10-12T15:00:00");
  await setStatus(blocker.id, "in_progress");
  await setStatus(filler.id, "cancelled");
  const flexible = await createOrder({ ...NORTH_WELD, duration_minutes: 240, earliest_start: MON, due_date: TUE, splittable: true, min_segment_minutes: 120 });
  await plan(EMPTY_WEEK);
  // Monday 07:00-09:00 plus Tuesday would start earlier, but Tuesday holds it whole.
  assertSlot(await order(flexible.id), "T-005", "2026-10-13T07:00:00", "2026-10-13T11:00:00");
});

test("split: no segment is shorter than min_segment_minutes", async () => {
  const filler = await createOrder({ ...NORTH_WELD, duration_minutes: 120, earliest_start: MON, due_date: MON, priority: "critical" });
  const blocker = await createOrder({ ...NORTH_WELD, duration_minutes: 360, earliest_start: MON, due_date: MON, priority: "high" });
  await plan(EMPTY_WEEK);
  await setStatus(blocker.id, "in_progress");
  await setStatus(filler.id, "cancelled");
  // Monday has 120 minutes left, below the minimum of 180, so the first segment is Tuesday's,
  // and it stops at 420 so that Wednesday's rest is not below 180 either.
  const long = await createOrder({ ...NORTH_WELD, duration_minutes: 600, earliest_start: MON, due_date: WED, splittable: true, min_segment_minutes: 180 });
  await plan(EMPTY_WEEK);
  assertPlacement(await order(long.id), ["T-005"], [["2026-10-13T07:00:00", "2026-10-13T14:00:00"], ["2026-10-14T07:00:00", "2026-10-14T10:00:00"]]);
});

test("preemption: a critical order evicts the shortest prefix of low work first, latest due first, and the evicted order is replanned", async () => {
  const lows = [];
  for (const day of [MON, TUE, WED, THU]) lows.push(await createOrder({ ...NORTH_AIR, duration_minutes: 240, earliest_start: day, due_date: day, priority: "low" }));
  const medium = await createOrder({ ...NORTH_AIR, duration_minutes: 240, earliest_start: FRI, due_date: FRI, priority: "medium" });
  const critical = await createOrder({ ...NORTH_AIR, duration_minutes: 480, earliest_start: MON, due_date: SAT, priority: "critical" });
  const result = await plan(EMPTY_WEEK);
  // Every day holds 240 minutes of earlier-due work, so the critical order fits nowhere in the pass.
  // Victims run low before medium, then latest due first: Thursday's low order is the whole prefix.
  assertSlot(await order(critical.id), "T-005", "2026-10-15T07:00:00", "2026-10-15T15:00:00");
  assertNoSlot(await order(lows[3].id), "unscheduled", "no_capacity");
  for (const [index, low] of lows.slice(0, 3).entries()) assertSlot(await order(low.id), "T-005", `${DAYS[index]}T07:00:00`, `${DAYS[index]}T11:00:00`);
  assertSlot(await order(medium.id), "T-005", "2026-10-16T07:00:00", "2026-10-16T11:00:00");
  assert.deepEqual(result.unscheduled, [lows[3].id]);
});

test("preemption: a later round assigns without evicting when an earlier round already made room", async () => {
  await fixDays([TUE, WED, THU]);
  await fixDays([FRI], 240);
  const monday = await createOrder({ ...NORTH_AIR, duration_minutes: 240, earliest_start: MON, due_date: MON, priority: "low" });
  const friday = await createOrder({ ...NORTH_AIR, duration_minutes: 240, earliest_start: FRI, due_date: FRI, priority: "low" });
  const first = await createOrder({ ...NORTH_AIR, duration_minutes: 480, earliest_start: MON, due_date: SAT, priority: "critical" });
  const second = await createOrder({ ...NORTH_AIR, duration_minutes: 240, earliest_start: FRI, due_date: SAT, priority: "critical" });
  await plan(EMPTY_WEEK);
  // The first round evicts Friday's low order (useless: Friday's fixed load still caps the day), then Monday's.
  assertSlot(await order(first.id), "T-005", "2026-10-12T07:00:00", "2026-10-12T15:00:00");
  // The second round finds Friday's freed slot at once: the empty prefix, nobody else evicted.
  assertSlot(await order(second.id), "T-005", "2026-10-16T11:00:00", "2026-10-16T15:00:00");
  assertNoSlot(await order(monday.id), "unscheduled", "no_capacity");
  assertNoSlot(await order(friday.id), "unscheduled", "no_capacity");
});

test("preemption: evicted orders are replanned only after every round, so a later round sees their parts free", async () => {
  await fixDays([TUE, WED, THU]);
  await fixDays([FRI], 240);
  const P011 = [{ part_id: "P-011", quantity: 1 }];
  const monday = await createOrder({ ...NORTH_AIR, duration_minutes: 240, earliest_start: MON, due_date: MON, priority: "low" });
  const friday = await createOrder({ ...NORTH_AIR, duration_minutes: 240, earliest_start: FRI, due_date: FRI, priority: "low", parts: P011 });
  const first = await createOrder({ ...NORTH_AIR, duration_minutes: 480, earliest_start: MON, due_date: SAT, priority: "critical" });
  const second = await createOrder({ ...NORTH_AIR, duration_minutes: 240, earliest_start: FRI, due_date: SAT, priority: "critical", parts: P011 });
  const taker = await createOrder({ asset_id: "A-010", required_skill: "pneumatics", duration_minutes: 60, earliest_start: MON, due_date: SAT, priority: "low", parts: P011 });
  await plan(EMPTY_WEEK);
  // Round 1 evicts Friday's low order and frees its P-011; it is replanned only after round 2,
  // so the second critical passes its parts check and takes the freed slot, and the low order finds no P-011.
  assertSlot(await order(first.id), "T-005", "2026-10-12T07:00:00", "2026-10-12T15:00:00");
  assertSlot(await order(second.id), "T-005", "2026-10-16T11:00:00", "2026-10-16T15:00:00");
  assertNoSlot(await order(friday.id), "blocked", "parts_unavailable");
  assertNoSlot(await order(monday.id), "unscheduled", "no_capacity");
  assertSlot(await order(taker.id), "T-006", "2026-10-12T08:00:00", "2026-10-12T09:00:00");
  assert.equal((await part("P-011")).reserved, 2);
});

test("preemption: rounds run in rule-4 order, so the lower id takes the only freed day", async () => {
  await fixDays([TUE, WED, THU, FRI]);
  const victim = await createOrder({ ...NORTH_AIR, duration_minutes: 240, earliest_start: MON, due_date: MON, priority: "low" });
  const first = await createOrder({ ...NORTH_AIR, duration_minutes: 480, earliest_start: MON, due_date: SAT, priority: "critical" });
  const second = await createOrder({ ...NORTH_AIR, duration_minutes: 480, earliest_start: MON, due_date: SAT, priority: "critical" });
  await plan(EMPTY_WEEK);
  assertSlot(await order(first.id), "T-005", "2026-10-12T07:00:00", "2026-10-12T15:00:00");
  assertNoSlot(await order(second.id), "unscheduled", "no_capacity");
  assertNoSlot(await order(victim.id), "unscheduled", "no_capacity");
});

test("preemption: on equal priority and due date, the victim with the highest id goes first", async () => {
  await fixDays([WED, THU, FRI]);
  const onMonday = await createOrder({ ...NORTH_AIR, duration_minutes: 240, earliest_start: MON, due_date: TUE, priority: "low" });
  const onTuesday = await createOrder({ ...NORTH_AIR, duration_minutes: 240, earliest_start: TUE, due_date: TUE, priority: "low" });
  const critical = await createOrder({ ...NORTH_AIR, duration_minutes: 480, earliest_start: MON, due_date: SAT, priority: "critical" });
  await plan(EMPTY_WEEK);
  assertSlot(await order(onMonday.id), "T-005", "2026-10-12T07:00:00", "2026-10-12T11:00:00");
  assertSlot(await order(critical.id), "T-005", "2026-10-13T07:00:00", "2026-10-13T15:00:00");
  assertNoSlot(await order(onTuesday.id), "unscheduled", "no_capacity");
});

test("preemption: parts are checked first, and a critical order short of parts stays no_capacity and evicts nobody", async () => {
  const lows = [];
  for (const day of [MON, TUE, WED, THU]) lows.push(await createOrder({ ...NORTH_AIR, duration_minutes: 240, earliest_start: day, due_date: day, priority: "low" }));
  const holder = await createOrder({ ...NORTH_AIR, duration_minutes: 240, earliest_start: FRI, due_date: FRI, priority: "low", parts: [{ part_id: "P-011", quantity: 1 }] });
  const critical = await createOrder({ ...NORTH_AIR, duration_minutes: 480, earliest_start: MON, due_date: SAT, priority: "critical", parts: [{ part_id: "P-011", quantity: 1 }] });
  const taker = await createOrder({ asset_id: "A-010", required_skill: "pneumatics", duration_minutes: 60, earliest_start: MON, due_date: SAT, priority: "low", parts: [{ part_id: "P-011", quantity: 1 }] });
  await plan(EMPTY_WEEK);
  // In the pass the critical order still found one P-011; the later-due taker then took the last one.
  assertSlot(await order(taker.id), "T-006", "2026-10-12T08:00:00", "2026-10-12T09:00:00");
  assertNoSlot(await order(critical.id), "unscheduled", "no_capacity");
  assertSlot(await order(holder.id), "T-005", "2026-10-16T07:00:00", "2026-10-16T11:00:00");
  for (const [index, low] of lows.entries()) assertSlot(await order(low.id), "T-005", `${DAYS[index]}T07:00:00`, `${DAYS[index]}T11:00:00`);
  assert.equal((await part("P-011")).reserved, 2);
});

test("preemption: only victims holding a technician qualified for the critical order are evicted", async () => {
  await fixDays([TUE, WED, THU, FRI]);
  // R is related (T-005 serves S-001), L is not (T-007 does not): the filter keeps L out of the list.
  const related = await createOrder({ asset_id: "A-009", required_skill: "welding", duration_minutes: 240, earliest_start: MON, due_date: MON, priority: "medium" });
  const unrelated = await createOrder({ asset_id: "A-010", required_skill: "welding", duration_minutes: 240, earliest_start: MON, due_date: TUE, priority: "low" });
  const critical = await createOrder({ ...NORTH_AIR, duration_minutes: 480, earliest_start: MON, due_date: SAT, priority: "critical" });
  await plan(EMPTY_WEEK);
  assertSlot(await order(critical.id), "T-005", "2026-10-12T07:00:00", "2026-10-12T15:00:00");
  assertSlot(await order(unrelated.id), "T-007", "2026-10-12T08:00:00", "2026-10-12T12:00:00");
  assertSlot(await order(related.id), "T-007", "2026-10-12T12:00:00", "2026-10-12T16:00:00");
});

test("determinism: re-planning the seed week, preemption included, returns the identical result and stock", async () => {
  const first = await plan(SEED_WEEK);
  // WO-023 fits no day in the pass; the victim list opens with WO-025 (low, due Thursday, T-005 07:00-11:00),
  // whose eviction frees Thursday. S-003's holiday that day does not touch A-004, which is at S-001.
  assertSlot(await order("WO-023"), "T-005", "2026-10-08T07:00:00", "2026-10-08T15:00:00");
  assertNoSlot(await order("WO-025"), "unscheduled", "no_capacity");
  const parts = await ok("GET", "/parts");
  assert.deepEqual(await plan(SEED_WEEK), first);
  assert.deepEqual(await ok("GET", "/parts"), parts);
});

// Last on purpose: a planner whose split search is slow keeps computing after this test's
// request times out, so any test after it would meet a busy backend and fail for that alone.
// This file is also the manifest's last, and score-hard serves the E2E on another backend.
test("split: an order longer than the week's free capacity is no_capacity, and the search over many partial-day options still answers", async () => {
  // Five 240-minute critical fillers leave T-005 240 minutes under the cap each day, as many
  // partial-day options: 1200 minutes in all, short of 1440, so every segment count fails and
  // the order is no_capacity.
  for (const day of DAYS) await createOrder({ ...NORTH_WELD, duration_minutes: 240, earliest_start: day, due_date: day, priority: "critical" });
  const long = await createOrder({ asset_id: "A-002", required_skill: "welding", duration_minutes: 1440, earliest_start: MON, due_date: FRI, splittable: true, min_segment_minutes: 60 });
  await plan(EMPTY_WEEK);
  assertNoSlot(await order(long.id), "unscheduled", "no_capacity");
});
