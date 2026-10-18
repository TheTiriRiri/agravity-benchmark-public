/** Hard track, row "Planner: parts & blocking": availability, reservation, and stock arithmetic on transitions. */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { EMPTY_WEEK, SEED_WEEK, assertNoSlot, assertSlot, createOrder, order, part, plan, reset, schedule, setStatus } from "./api";

beforeEach(reset);

const HYDRAULICS = { asset_id: "A-006", required_skill: "hydraulics", duration_minutes: 120, earliest_start: EMPTY_WEEK, due_date: EMPTY_WEEK };

const stock = async (id: string) => {
  const p = await part(id);
  return { on_hand: p.on_hand, reserved: p.reserved, available: p.available };
};

test("seed week plus one critical order: whoever is processed first takes the parts, the rest are blocked", async () => {
  const hoarder = await createOrder({ asset_id: "A-001", required_skill: "mechanical", duration_minutes: 60, earliest_start: SEED_WEEK, due_date: SEED_WEEK, priority: "critical", parts: [{ part_id: "P-001", quantity: 6 }] });
  const result = await plan(SEED_WEEK);
  assert.ok(result.scheduled.includes(hoarder.id));
  assert.deepEqual(result.blocked, ["WO-004", "WO-007"]);
  assertNoSlot(await order("WO-004"), "blocked", "parts_unavailable");
  assertNoSlot(await order("WO-007"), "blocked", "parts_unavailable");
  assert.deepEqual(await stock("P-001"), { on_hand: 6, reserved: 6, available: 0 });
  assert.deepEqual(await stock("P-003"), { on_hand: 1, reserved: 0, available: 1 }, "a blocked order reserves nothing");
  assert.equal((await part("P-001")).low_stock, true, "low_stock follows available, not on_hand");
});

test("seed week minus one order: scheduled and in_progress orders hold reservations, unscheduled ones do not", async () => {
  await setStatus("WO-012", "cancelled");
  await plan(SEED_WEEK);
  await plan(SEED_WEEK);
  assert.deepEqual(await stock("P-001"), { on_hand: 6, reserved: 1, available: 5 });
  assert.deepEqual(await stock("P-002"), { on_hand: 4, reserved: 2, available: 2 }, "only WO-014 holds bearings now");
  assert.deepEqual(await stock("P-004"), { on_hand: 3, reserved: 1, available: 2 });
  assert.deepEqual(await stock("P-005"), { on_hand: 2, reserved: 1, available: 1 }, "the in_progress WO-010 keeps its reservation");
  assert.deepEqual(await stock("P-006"), { on_hand: 5, reserved: 0, available: 5 }, "WO-011 is unscheduled");
  assert.deepEqual(await stock("P-008"), { on_hand: 10, reserved: 3, available: 7 });
  assert.deepEqual(await stock("P-009"), { on_hand: 2, reserved: 1, available: 1 });
});

test("availability runs down as orders are processed: the second taker is blocked", async () => {
  const winner = await createOrder({ ...HYDRAULICS, priority: "high", parts: [{ part_id: "P-010", quantity: 2 }] });
  const loser = await createOrder({ ...HYDRAULICS, priority: "low", parts: [{ part_id: "P-010", quantity: 2 }] });
  await plan(EMPTY_WEEK);
  assertSlot(await order(winner.id), "T-003", "2026-10-12T08:00:00", "2026-10-12T10:00:00");
  assertNoSlot(await order(loser.id), "blocked", "parts_unavailable");
  assert.deepEqual(await stock("P-010"), { on_hand: 3, reserved: 2, available: 1 });
});

test("one missing part blocks the order even when its other parts are in stock", async () => {
  const created = await createOrder({ ...HYDRAULICS, parts: [{ part_id: "P-007", quantity: 1 }, { part_id: "P-003", quantity: 2 }] });
  await plan(EMPTY_WEEK);
  assertNoSlot(await order(created.id), "blocked", "parts_unavailable");
  assert.deepEqual(await stock("P-007"), { on_hand: 8, reserved: 0, available: 8 }, "nothing is part-reserved");
});

test("a blocked order takes no time: the next order gets the first slot", async () => {
  await createOrder({ ...HYDRAULICS, priority: "critical", parts: [{ part_id: "P-003", quantity: 5 }] });
  const next = await createOrder({ ...HYDRAULICS, priority: "low" });
  await plan(EMPTY_WEEK);
  assertSlot(await order(next.id), "T-003", "2026-10-12T08:00:00", "2026-10-12T10:00:00");
});

test("parts are checked before technicians: short of parts and unskilled is blocked, not unscheduled", async () => {
  const created = await createOrder({ asset_id: "A-005", required_skill: "electrical", duration_minutes: 60, earliest_start: EMPTY_WEEK, due_date: EMPTY_WEEK, parts: [{ part_id: "P-003", quantity: 2 }] });
  await plan(EMPTY_WEEK);
  assertNoSlot(await order(created.id), "blocked", "parts_unavailable");
});

test("completing an order consumes its parts: on_hand and reserved both drop", async () => {
  const created = await createOrder({ ...HYDRAULICS, parts: [{ part_id: "P-006", quantity: 2 }] });
  await plan(EMPTY_WEEK);
  assert.deepEqual(await stock("P-006"), { on_hand: 5, reserved: 2, available: 3 });
  await setStatus(created.id, "in_progress");
  assert.deepEqual(await stock("P-006"), { on_hand: 5, reserved: 2, available: 3 }, "starting work changes no stock");
  const done = await setStatus(created.id, "completed");
  assert.deepEqual(await stock("P-006"), { on_hand: 3, reserved: 0, available: 3 });
  assert.equal(done.segments[0].start, "2026-10-12T08:00:00", "a completed order keeps its slot");
});

test("cancelling a scheduled order releases its parts, clears its slot and leaves the schedule at once", async () => {
  const created = await createOrder({ ...HYDRAULICS, parts: [{ part_id: "P-006", quantity: 2 }] });
  await plan(EMPTY_WEEK);
  assertSlot(await order(created.id), "T-003", "2026-10-12T08:00:00", "2026-10-12T10:00:00");
  assert.deepEqual(await stock("P-006"), { on_hand: 5, reserved: 2, available: 3 }, "there must be a reservation to release");
  const cancelled = await setStatus(created.id, "cancelled");
  assertNoSlot(cancelled, "cancelled", null as unknown as string);
  assert.deepEqual(await stock("P-006"), { on_hand: 5, reserved: 0, available: 5 });
  assert.deepEqual((await schedule(EMPTY_WEEK)).technicians.flatMap((t) => t.assignments), []);
});

test("cancelling an in_progress order releases its reservation without consuming", async () => {
  await setStatus("WO-010", "cancelled");
  assert.deepEqual(await stock("P-005"), { on_hand: 2, reserved: 0, available: 2 });
});

test("cancelling an order that holds no reservation changes no stock", async () => {
  await plan(SEED_WEEK);
  await setStatus("WO-004", "cancelled");
  assert.deepEqual(await stock("P-003"), { on_hand: 1, reserved: 0, available: 1 }, "blocked: nothing to release");
  assertNoSlot(await order("WO-011"), "unscheduled", "no_capacity");
  await setStatus("WO-011", "cancelled");
  assert.deepEqual(await stock("P-006"), { on_hand: 5, reserved: 0, available: 5 }, "unscheduled: nothing to release");
  await reset();
  await setStatus("WO-007", "cancelled");
  assert.deepEqual(await stock("P-001"), { on_hand: 6, reserved: 0, available: 6 }, "open: nothing to release");
});

test("a cancelled order is never planned again", async () => {
  const created = await createOrder(HYDRAULICS);
  await setStatus(created.id, "cancelled");
  const result = await plan(EMPTY_WEEK);
  assert.deepEqual(result.orders, []);
  assert.equal((await order(created.id)).status, "cancelled");
});
