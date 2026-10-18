/** Rubric row "API contract": paths, shapes, status codes, error format, reset, seed fidelity. */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { EMPTY_WEEK, SEED_WEEK, assertError, call, createOrder, ok, plan, reset, schedule, seed, seedOrder, setStatus } from "./api";

beforeEach(reset);

const VALID = {
  title: "Replace filter", asset_id: "A-001", required_skill: "mechanical", duration_minutes: 60,
  earliest_start: EMPTY_WEEK, due_date: "2026-10-16", priority: "medium", parts: [{ part_id: "P-007", quantity: 1 }],
};

test("GET /health answers ok", async () => {
  assert.deepEqual(await ok("GET", "/health"), { status: "ok" });
});

test("GET /sites returns the seeded sites sorted by id", async () => {
  assert.deepEqual(await ok("GET", "/sites"), seed.sites);
});

test("GET /assets returns the seeded assets sorted by id", async () => {
  assert.deepEqual(await ok("GET", "/assets"), seed.assets);
});

test("GET /technicians returns the seeded technicians sorted by id", async () => {
  assert.deepEqual(await ok("GET", "/technicians"), seed.technicians);
});

test("GET /parts adds available and a strict low_stock flag", async () => {
  const expected = seed.parts.map((p) => ({
    ...p, available: p.on_hand - p.reserved, low_stock: p.on_hand - p.reserved < p.min_stock,
  }));
  const parts = await ok("GET", "/parts");
  assert.deepEqual(parts, expected);
  assert.equal(parts.find((p: any) => p.id === "P-003")?.low_stock, true, "1 available < min 2");
  assert.equal(parts.find((p: any) => p.id === "P-010")?.low_stock, false, "3 available is not below min 3");
});

test("GET /work-orders returns the seeded orders with null for unset fields", async () => {
  assert.deepEqual(await ok("GET", "/work-orders"), seed.work_orders);
});

test("GET /work-orders filters by status, priority and the asset's site, combinably", async () => {
  const ids = async (query: string) => (await ok("GET", `/work-orders?${query}`)).map((o: any) => o.id);
  assert.deepEqual(await ids("status=in_progress"), ["WO-010"]);
  assert.deepEqual(await ids("priority=critical"), ["WO-001", "WO-014"]);
  assert.deepEqual(await ids("site_id=S-002"), ["WO-009", "WO-010", "WO-011", "WO-012", "WO-013", "WO-014"]);
  assert.deepEqual(await ids("status=open&site_id=S-002&priority=low"), ["WO-012", "WO-013"]);
  assert.deepEqual(await ids("status=cancelled"), []);
});

test("GET /work-orders/{id} returns one order, and 404 not_found for an unknown id", async () => {
  assert.deepEqual(await ok("GET", "/work-orders/WO-004"), seedOrder("WO-004"));
  assertError(await call("GET", "/work-orders/WO-999"), 404, "not_found");
});

test("POST /work-orders creates an open order with the next id and null slot fields", async () => {
  const created = await ok("POST", "/work-orders", VALID, 201);
  assert.deepEqual(created, {
    id: "WO-015", ...VALID, status: "open", status_reason: null,
    technician_id: null, scheduled_start: null, scheduled_end: null,
  });
  assert.deepEqual(await ok("GET", "/work-orders/WO-015"), created);
  const { parts: _omitted, ...withoutParts } = VALID;
  const second = await ok("POST", "/work-orders", withoutParts, 201);
  assert.equal(second.id, "WO-016");
  assert.deepEqual(second.parts, [], "parts defaults to an empty list");
});

/** Grouped by kind of mistake, so validation weighs about a quarter of this row, not half. */
const INVALID: [string, Record<string, unknown>[]][] = [
  ["a missing required field", ["title", "asset_id", "required_skill", "duration_minutes", "earliest_start", "due_date", "priority"].map((field) => ({ [field]: undefined }))],
  ["an empty title or required_skill", [{ title: "" }, { required_skill: "" }]],
  ["a duration that is off the 30-minute grid, out of range or not a number", [{ duration_minutes: 45 }, { duration_minutes: 0 }, { duration_minutes: 510 }, { duration_minutes: "soon" }]],
  ["a malformed date or a due_date before earliest_start", [{ due_date: "16/10/2026" }, { earliest_start: "2026-10-14", due_date: "2026-10-13" }]],
  ["an unknown priority", [{ priority: "urgent" }]],
  ["a quantity below 1 or a part listed twice", [{ parts: [{ part_id: "P-007", quantity: 0 }] }, { parts: [{ part_id: "P-007", quantity: 1 }, { part_id: "P-007", quantity: 2 }] }]],
  ["an asset_id or part_id that does not exist", [{ asset_id: "A-999" }, { parts: [{ part_id: "P-999", quantity: 1 }] }]],
];

for (const [name, patches] of INVALID) {
  test(`POST /work-orders rejects ${name} with 422 validation_error`, async () => {
    for (const patch of patches) {
      const reply = await call("POST", "/work-orders", { ...VALID, ...patch });
      assertError(reply, 422, "validation_error");
    }
    assert.equal((await ok("GET", "/work-orders")).length, seed.work_orders.length, "nothing may be created");
  });
}

test("PATCH /work-orders/{id} rejects illegal transitions with 409 invalid_transition", async () => {
  assertError(await call("PATCH", "/work-orders/WO-001", { status: "in_progress" }), 409, "invalid_transition");
  assertError(await call("PATCH", "/work-orders/WO-001", { status: "completed" }), 409, "invalid_transition");
  assertError(await call("PATCH", "/work-orders/WO-010", { status: "scheduled" }), 409, "invalid_transition");
  assertError(await call("PATCH", "/work-orders/WO-008", { status: "cancelled" }), 409, "invalid_transition");
});

test("PATCH /work-orders/{id}: cancelled and completed are terminal", async () => {
  await setStatus("WO-001", "cancelled");
  for (const target of ["open", "scheduled", "in_progress", "completed", "cancelled"]) {
    assertError(await call("PATCH", "/work-orders/WO-001", { status: target }), 409, "invalid_transition");
  }
  assertError(await call("PATCH", "/work-orders/WO-008", { status: "in_progress" }), 409, "invalid_transition");
});

test("PATCH /work-orders/{id} answers 422 for an unknown status and 404 for an unknown id", async () => {
  assertError(await call("PATCH", "/work-orders/WO-001", { status: "paused" }), 422, "validation_error");
  assertError(await call("PATCH", "/work-orders/WO-001", {}), 422, "validation_error");
  assertError(await call("PATCH", "/work-orders/WO-999", { status: "cancelled" }), 404, "not_found");
});

test("PATCH /work-orders/{id} walks scheduled -> in_progress -> completed and returns the order", async () => {
  const planned = (await plan(SEED_WEEK)).orders.find((o) => o.status === "scheduled");
  assert.ok(planned, "the seed week must schedule at least one order");
  const started = await setStatus(planned.id, "in_progress");
  assert.deepEqual(started, { ...planned, status: "in_progress" }, "the slot is kept");
  const done = await setStatus(planned.id, "completed");
  assert.deepEqual(done, { ...planned, status: "completed" });
});

test("POST /plan and GET /schedule reject a missing, malformed or non-Monday week_start", async () => {
  for (const path of ["/plan", "/schedule"]) {
    const method = path === "/plan" ? "POST" : "GET";
    assertError(await call(method, path), 422, "validation_error");
    assertError(await call(method, `${path}?week_start=next-week`), 422, "validation_error");
    assertError(await call(method, `${path}?week_start=2026-10-06`), 422, "validation_error");
  }
});

test("POST /plan returns the summary lists sorted and every candidate in full", async () => {
  const result = await plan(SEED_WEEK);
  assert.deepEqual(Object.keys(result).sort(), ["blocked", "orders", "scheduled", "unscheduled", "week_start"]);
  assert.equal(result.week_start, SEED_WEEK);
  const candidates = seed.work_orders.filter((o) => o.status === "open").map((o) => o.id);
  assert.deepEqual(result.orders.map((o) => o.id), candidates, "orders holds every candidate, sorted by id");
  assert.deepEqual([...result.scheduled, ...result.blocked, ...result.unscheduled].sort(), candidates);
  for (const list of [result.scheduled, result.blocked, result.unscheduled]) {
    assert.deepEqual(list, [...list].sort());
  }
  for (const o of result.orders) {
    assert.deepEqual(Object.keys(o).sort(), Object.keys(seed.work_orders[0]).sort());
    assert.deepEqual(o, await ok("GET", `/work-orders/${o.id}`), "the plan result matches what GET returns");
  }
});

test("GET /schedule lists every technician, with assignments sorted by start", async () => {
  const before = await schedule(SEED_WEEK);
  assert.deepEqual(before.technicians.map((t) => t.technician_id), ["T-001", "T-002", "T-003", "T-004"]);
  assert.deepEqual(before.technicians[0].assignments, [], "a technician with no work still appears");
  assert.deepEqual(before.technicians[1].assignments, [{
    work_order_id: "WO-008", title: "Lubricate air compressor", asset_id: "A-003", status: "completed",
    scheduled_start: "2026-10-05T08:00:00", scheduled_end: "2026-10-05T09:00:00",
  }]);
  await plan(SEED_WEEK);
  const after = await schedule(SEED_WEEK);
  for (const technician of after.technicians) {
    const starts = technician.assignments.map((a) => a.scheduled_start);
    assert.deepEqual(starts, [...starts].sort());
  }
  assert.deepEqual((await schedule(EMPTY_WEEK)).technicians.flatMap((t) => t.assignments), []);
});

test("POST /reset restores the seed exactly after writes, planning and transitions", async () => {
  await createOrder({ asset_id: "A-001", required_skill: "mechanical", duration_minutes: 60, earliest_start: EMPTY_WEEK, due_date: EMPTY_WEEK });
  await plan(SEED_WEEK);
  await setStatus("WO-007", "in_progress");
  await setStatus("WO-007", "completed");
  await setStatus("WO-001", "cancelled");
  assert.deepEqual(await ok("POST", "/reset"), { status: "ok" });
  assert.deepEqual(await ok("GET", "/work-orders"), seed.work_orders);
  assert.deepEqual((await ok("GET", "/parts")).map(({ available, low_stock, ...rest }: any) => rest), seed.parts);
});
