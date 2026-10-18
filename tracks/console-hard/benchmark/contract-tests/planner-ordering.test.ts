/** Hard track, row "Planner: ordering & determinism": EDF processing order, tie-breaks, recomputation, idempotency. */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { EMPTY_WEEK, SEED_WEEK, assertNoSlot, assertSlot, createOrder, ok, order, plan, reset, setStatus } from "./api";

beforeEach(reset);

const HYDRAULICS = { asset_id: "A-006", required_skill: "hydraulics", duration_minutes: 120, earliest_start: EMPTY_WEEK, due_date: EMPTY_WEEK };
const MECHANICAL = { asset_id: "A-005", required_skill: "mechanical", duration_minutes: 120, earliest_start: EMPTY_WEEK, due_date: EMPTY_WEEK };

test("EDF: the due date decides first, whatever the priority and the creation order", async () => {
  const critical = await createOrder({ ...HYDRAULICS, priority: "critical", due_date: "2026-10-16" });
  const medium = await createOrder({ ...HYDRAULICS, priority: "medium", due_date: "2026-10-13" });
  const low = await createOrder({ ...HYDRAULICS, priority: "low" });
  await plan(EMPTY_WEEK);
  assertSlot(await order(low.id), "T-003", "2026-10-12T08:00:00", "2026-10-12T10:00:00");
  assertSlot(await order(medium.id), "T-003", "2026-10-12T10:00:00", "2026-10-12T12:00:00");
  assertSlot(await order(critical.id), "T-003", "2026-10-12T12:00:00", "2026-10-12T14:00:00");
});

test("equal due_date: the higher priority goes first", async () => {
  const low = await createOrder({ ...HYDRAULICS, priority: "low", due_date: "2026-10-13" });
  const high = await createOrder({ ...HYDRAULICS, priority: "high", due_date: "2026-10-13" });
  await plan(EMPTY_WEEK);
  assertSlot(await order(high.id), "T-003", "2026-10-12T08:00:00", "2026-10-12T10:00:00");
  assertSlot(await order(low.id), "T-003", "2026-10-12T10:00:00", "2026-10-12T12:00:00");
});

test("equal priority and due_date: the lower id goes first", async () => {
  const first = await createOrder(HYDRAULICS);
  const second = await createOrder(HYDRAULICS);
  await plan(EMPTY_WEEK);
  assertSlot(await order(first.id), "T-003", "2026-10-12T08:00:00", "2026-10-12T10:00:00");
  assertSlot(await order(second.id), "T-003", "2026-10-12T10:00:00", "2026-10-12T12:00:00");
});

test("the earliest start wins across technicians, and an exact tie goes to the lower technician id", async () => {
  const first = await createOrder({ ...MECHANICAL, priority: "high" });
  const second = await createOrder({ ...MECHANICAL, priority: "medium" });
  const third = await createOrder({ ...MECHANICAL, priority: "low" });
  await plan(EMPTY_WEEK);
  assertSlot(await order(first.id), "T-004", "2026-10-12T06:00:00", "2026-10-12T08:00:00");
  assertSlot(await order(second.id), "T-003", "2026-10-12T08:00:00", "2026-10-12T10:00:00");
  assertSlot(await order(third.id), "T-004", "2026-10-12T08:00:00", "2026-10-12T10:00:00");
});

test("seed week minus one order: due_date, id and technician tie-breaks place the tied orders", async () => {
  // Without WO-012, T-004's 06:00 slot is free for WO-013, which the pristine seed sends to T-003 at 08:00.
  // EDF: WO-005 (due Tuesday) takes T-002's first free slot, before WO-007 (due Friday) and WO-006 (due Saturday).
  await setStatus("WO-012", "cancelled");
  await plan(SEED_WEEK);
  assertSlot(await order("WO-005"), "T-002", "2026-10-05T09:00:00", "2026-10-05T10:30:00");
  assertSlot(await order("WO-007"), "T-002", "2026-10-05T10:30:00", "2026-10-05T13:30:00");
  assertSlot(await order("WO-006"), "T-002", "2026-10-05T13:30:00", "2026-10-05T14:30:00");
  assertSlot(await order("WO-013"), "T-004", "2026-10-05T06:00:00", "2026-10-05T08:00:00");
  assertSlot(await order("WO-014"), "T-004", "2026-10-06T06:00:00", "2026-10-06T14:00:00");
});

test("the pristine seed week: the full tie goes to the lower order id, the equal start to the lower technician id", async () => {
  await plan(SEED_WEEK);
  assertSlot(await order("WO-012"), "T-004", "2026-10-05T06:00:00", "2026-10-05T08:00:00");
  assertSlot(await order("WO-013"), "T-003", "2026-10-05T08:00:00", "2026-10-05T10:00:00");
});

test("determinism: planning the same state twice returns the identical result and stock", async () => {
  await setStatus("WO-012", "cancelled");
  const first = await plan(SEED_WEEK);
  assert.ok(!first.orders.some((o) => o.id === "WO-012"), "a cancelled order is not a candidate");
  const partsAfterFirst = await ok("GET", "/parts");
  const second = await plan(SEED_WEEK);
  assert.deepEqual(second, first);
  assert.deepEqual(await ok("GET", "/parts"), partsAfterFirst, "re-planning must not reserve twice");
});

test("determinism: the same holds for a week built through the API", async () => {
  await createOrder({ ...MECHANICAL, priority: "high", parts: [{ part_id: "P-002", quantity: 1 }] });
  await createOrder({ ...HYDRAULICS, priority: "low", parts: [{ part_id: "P-006", quantity: 2 }] });
  const first = await plan(EMPTY_WEEK);
  assert.equal(first.scheduled.length, 2);
  assert.deepEqual(await plan(EMPTY_WEEK), first);
});

test("recomputation: a new critical order displaces a planned one from its slot and its parts", async () => {
  const planned = await createOrder({ ...HYDRAULICS, priority: "low", parts: [{ part_id: "P-010", quantity: 3 }] });
  await plan(EMPTY_WEEK);
  assertSlot(await order(planned.id), "T-003", "2026-10-12T08:00:00", "2026-10-12T10:00:00");
  const urgent = await createOrder({ ...HYDRAULICS, priority: "critical", parts: [{ part_id: "P-010", quantity: 1 }] });
  const result = await plan(EMPTY_WEEK);
  assert.deepEqual(result.orders.map((o) => o.id), [planned.id, urgent.id], "a scheduled order in the week is a candidate again");
  assertSlot(await order(urgent.id), "T-003", "2026-10-12T08:00:00", "2026-10-12T10:00:00");
  assertNoSlot(await order(planned.id), "blocked", "parts_unavailable");
});

test("recomputation: blocked and unscheduled orders are retried on the next plan", async () => {
  await plan(SEED_WEEK);
  assertNoSlot(await order("WO-003"), "unscheduled", "no_capacity");
  await setStatus("WO-002", "cancelled");
  await plan(SEED_WEEK);
  assertSlot(await order("WO-003"), "T-001", "2026-10-05T11:00:00", "2026-10-05T12:00:00");
});

test("other weeks: planning one week leaves another week's scheduled orders alone", async () => {
  const seedPlan = await plan(SEED_WEEK);
  const created = await createOrder(HYDRAULICS);
  const result = await plan(EMPTY_WEEK);
  assert.deepEqual(result.orders.map((o) => o.id), [created.id]);
  for (const planned of seedPlan.orders) assert.deepEqual(await order(planned.id), planned);
  const partsBefore = await ok("GET", "/parts");
  await plan(EMPTY_WEEK);
  assert.deepEqual(await ok("GET", "/parts"), partsBefore, "the other week keeps its reservations");
});
