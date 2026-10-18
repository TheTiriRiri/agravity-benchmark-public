/**
 * Hard track, new rules (spec §8.4.4): crews, multi-site qualification, travel,
 * the cap with travel, absences and holidays. Every world is built in a week
 * no seeded order reaches, and only the three hard technicians hold the two
 * hard skills, so the classic technicians never interfere:
 *   T-005 serves S-001 and S-003, pneumatics and welding, 07:00-17:00, absent 2026-10-20 09:00-11:00
 *   T-006 serves S-002 and S-003, pneumatics, 08:00-16:00, absent 2026-10-21 12:00-14:00
 *   T-007 serves S-003, pneumatics and welding, 08:00-16:00
 * Travel S-001<->S-003 is 30 minutes. S-003 is closed on 2026-10-22.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { EMPTY_WEEK, RULES_WEEK, assertNoSlot, assertPlacement, assertSlot, createOrder, order, plan, reset, schedule, setStatus } from "./api";

beforeEach(reset);

const MON = EMPTY_WEEK;
/** Welding at Northgate (S-001): T-005 is the only technician who can do it. */
const NORTH_WELD = { asset_id: "A-001", required_skill: "welding", earliest_start: MON, due_date: MON };
/** Welding at Ridge Depot (S-003): T-005 or T-007. */
const RIDGE_WELD = { asset_id: "A-009", required_skill: "welding", earliest_start: MON, due_date: MON };
/** Pneumatics at Ridge Depot: T-005, T-006 or T-007. */
const RIDGE_AIR = { asset_id: "A-010", required_skill: "pneumatics", earliest_start: MON, due_date: MON };

test("crew: two qualified technicians share one slot, listed sorted, and the schedule shows it under both", async () => {
  const crew = await createOrder({ ...RIDGE_WELD, duration_minutes: 120, crew_size: 2 });
  await plan(MON);
  assertPlacement(await order(crew.id), ["T-005", "T-007"], [["2026-10-12T08:00:00", "2026-10-12T10:00:00"]]);
  const rows = (await schedule(MON)).technicians.filter((t) => t.assignments.some((a) => a.work_order_id === crew.id));
  assert.deepEqual(rows.map((t) => t.technician_id), ["T-005", "T-007"]);
  const cancelled = await setStatus(crew.id, "cancelled");
  assert.deepEqual([cancelled.technician_ids, cancelled.segments], [[], []], "cancelling clears both lists");
  assert.ok(!(await schedule(MON)).technicians.some((t) => t.assignments.some((a) => a.work_order_id === crew.id)));
});

test("crew: fewer qualified technicians than crew_size is no_qualified_technician", async () => {
  const crew = await createOrder({ ...NORTH_WELD, duration_minutes: 60, crew_size: 2 });
  await plan(MON);
  assertNoSlot(await order(crew.id), "unscheduled", "no_qualified_technician");
});

test("crew: every member must be free, not only the first", async () => {
  const first = await createOrder({ ...RIDGE_WELD, duration_minutes: 120, priority: "high" });
  const second = await createOrder({ ...RIDGE_WELD, duration_minutes: 120, priority: "high" });
  const crew = await createOrder({ ...RIDGE_WELD, duration_minutes: 120, crew_size: 2, priority: "medium" });
  await plan(MON);
  assertSlot(await order(first.id), "T-005", "2026-10-12T07:00:00", "2026-10-12T09:00:00");
  assertSlot(await order(second.id), "T-007", "2026-10-12T08:00:00", "2026-10-12T10:00:00");
  assertPlacement(await order(crew.id), ["T-005", "T-007"], [["2026-10-12T10:00:00", "2026-10-12T12:00:00"]]);
});

test("crew: when several crews can start at once, the lexicographically lowest id list wins", async () => {
  const crew = await createOrder({ ...RIDGE_AIR, duration_minutes: 60, crew_size: 2 });
  await plan(MON);
  assertPlacement(await order(crew.id), ["T-005", "T-006"], [["2026-10-12T08:00:00", "2026-10-12T09:00:00"]]);
});

test("multi-site: a technician qualifies at every site they serve, not only the first", async () => {
  const ridge = await createOrder({ ...RIDGE_WELD, duration_minutes: 120 });
  const harbor = await createOrder({ asset_id: "A-005", required_skill: "pneumatics", duration_minutes: 60, earliest_start: MON, due_date: MON });
  await plan(MON);
  assertSlot(await order(ridge.id), "T-005", "2026-10-12T07:00:00", "2026-10-12T09:00:00");
  assertSlot(await order(harbor.id), "T-006", "2026-10-12T08:00:00", "2026-10-12T09:00:00");
});

test("travel: moving between sites takes the matrix's minutes between consecutive assignments", async () => {
  const north = await createOrder({ ...NORTH_WELD, duration_minutes: 120, priority: "high" });
  const ridge = await createOrder({ ...RIDGE_WELD, duration_minutes: 120, crew_size: 2, priority: "medium" });
  await plan(MON);
  assertSlot(await order(north.id), "T-005", "2026-10-12T07:00:00", "2026-10-12T09:00:00");
  assertPlacement(await order(ridge.id), ["T-005", "T-007"], [["2026-10-12T09:30:00", "2026-10-12T11:30:00"]]);
});

test("travel: an insertion needs travel to the next assignment as well as from the previous one", async () => {
  const filler = await createOrder({ ...NORTH_WELD, duration_minutes: 120, priority: "critical" });
  const fixed = await createOrder({ ...NORTH_WELD, asset_id: "A-002", duration_minutes: 120, priority: "high" });
  await plan(MON);
  assertSlot(await order(fixed.id), "T-005", "2026-10-12T09:00:00", "2026-10-12T11:00:00");
  await setStatus(fixed.id, "in_progress");
  await setStatus(filler.id, "cancelled");
  // 08:00-09:00 at S-003 would leave no time to reach S-001 by 09:00.
  const ridge = await createOrder({ ...RIDGE_WELD, duration_minutes: 60, crew_size: 2 });
  await plan(MON);
  assertPlacement(await order(ridge.id), ["T-005", "T-007"], [["2026-10-12T11:30:00", "2026-10-12T12:30:00"]]);
});

test("the cap counts travel: 480 minutes of work that need 60 minutes of travel do not fit one day", async () => {
  const morning = await createOrder({ ...NORTH_WELD, duration_minutes: 240, priority: "critical" });
  const ridge = await createOrder({ ...RIDGE_WELD, duration_minutes: 120, crew_size: 2, priority: "high" });
  const back = await createOrder({ ...NORTH_WELD, asset_id: "A-002", duration_minutes: 120, priority: "medium" });
  await plan(MON);
  assertSlot(await order(morning.id), "T-005", "2026-10-12T07:00:00", "2026-10-12T11:00:00");
  assertPlacement(await order(ridge.id), ["T-005", "T-007"], [["2026-10-12T11:30:00", "2026-10-12T13:30:00"]]);
  // 14:00-16:00 is inside the ten-hour shift and brings work to 480, but travel to 540.
  assertNoSlot(await order(back.id), "unscheduled", "no_capacity");
});

test("absences: a slot may not overlap one, may touch it, and travel may pass through it", async () => {
  const TUE = "2026-10-20";
  const before = await createOrder({ ...NORTH_WELD, duration_minutes: 120, earliest_start: TUE, due_date: TUE, priority: "high" });
  const after = await createOrder({ ...RIDGE_WELD, duration_minutes: 60, crew_size: 2, earliest_start: TUE, due_date: TUE, priority: "medium" });
  const long = await createOrder({ ...NORTH_WELD, asset_id: "A-002", duration_minutes: 180, earliest_start: TUE, due_date: TUE, priority: "low" });
  await plan(RULES_WEEK);
  // T-005 is away 09:00-11:00: the first job ends exactly as the absence starts.
  assertSlot(await order(before.id), "T-005", "2026-10-20T07:00:00", "2026-10-20T09:00:00");
  // The 30-minute trip to S-003 fits inside the absence, so the crew starts the moment T-005 is back.
  assertPlacement(await order(after.id), ["T-005", "T-007"], [["2026-10-20T11:00:00", "2026-10-20T12:00:00"]]);
  assertSlot(await order(long.id), "T-005", "2026-10-20T12:30:00", "2026-10-20T15:30:00");
});

test("holidays: nothing is done at a closed site that day, but its technicians may work elsewhere", async () => {
  const THU = "2026-10-22";
  const FRI = "2026-10-23";
  const closed = await createOrder({ ...RIDGE_AIR, duration_minutes: 120, earliest_start: THU, due_date: FRI });
  const open = await createOrder({ ...NORTH_WELD, duration_minutes: 120, earliest_start: THU, due_date: THU });
  await plan(RULES_WEEK);
  assertSlot(await order(closed.id), "T-005", "2026-10-23T07:00:00", "2026-10-23T09:00:00");
  assertSlot(await order(open.id), "T-005", "2026-10-22T07:00:00", "2026-10-22T09:00:00");
});
