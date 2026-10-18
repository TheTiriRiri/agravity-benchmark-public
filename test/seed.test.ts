import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const seed = JSON.parse(readFileSync(new URL("../benchmark/context/seed.json", import.meta.url), "utf8"));
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** The first Monday no seeded window may reach: the hidden tests build their own week there. */
const EMPTY_WEEK = "2026-10-12";

test("the seed has the advertised size and zero-padded, sorted ids", () => {
  const sizes = Object.fromEntries(Object.entries(seed).map(([key, rows]) => [key, (rows as unknown[]).length]));
  assert.deepEqual(sizes, { sites: 2, assets: 8, technicians: 4, parts: 10, work_orders: 14 });
  const prefixes: Record<string, string> = { sites: "S", assets: "A", technicians: "T", parts: "P", work_orders: "WO" };
  for (const [key, prefix] of Object.entries(prefixes)) {
    const ids = seed[key].map((row: { id: string }) => row.id);
    for (const id of ids) assert.match(id, new RegExp(`^${prefix}-\\d{3}$`));
    assert.deepEqual(ids, [...ids].sort(), `${key} must be sorted by id`);
  }
});

test("every reference in the seed resolves", () => {
  const has = (key: string, id: string) => seed[key].some((row: { id: string }) => row.id === id);
  for (const asset of seed.assets) assert.ok(has("sites", asset.site_id));
  for (const technician of seed.technicians) assert.ok(has("sites", technician.site_id));
  for (const order of seed.work_orders) {
    assert.ok(has("assets", order.asset_id), `${order.id}: asset`);
    for (const line of order.parts) assert.ok(has("parts", line.part_id), `${order.id}: part`);
    if (order.technician_id !== null) assert.ok(has("technicians", order.technician_id));
  }
});

test("shifts, durations and seeded slots sit on the 30-minute grid", () => {
  for (const technician of seed.technicians) {
    assert.equal(minutes(technician.shift_start) % 30, 0);
    assert.equal(minutes(technician.shift_end) % 30, 0);
  }
  for (const order of seed.work_orders) {
    assert.equal(order.duration_minutes % 30, 0);
    assert.ok(order.duration_minutes >= 30 && order.duration_minutes <= 480);
    if (order.scheduled_start !== null) assert.equal(minutes(order.scheduled_start.slice(11, 16)) % 30, 0);
  }
});

test("parts carry no derived fields and `reserved` equals what scheduled and in_progress orders hold", () => {
  const held = new Map<string, number>();
  for (const order of seed.work_orders) {
    if (order.status !== "scheduled" && order.status !== "in_progress") continue;
    for (const line of order.parts) held.set(line.part_id, (held.get(line.part_id) ?? 0) + line.quantity);
  }
  for (const part of seed.parts) {
    assert.deepEqual(Object.keys(part).sort(), ["id", "min_stock", "name", "on_hand", "reserved"]);
    assert.equal(part.reserved, held.get(part.id) ?? 0, `${part.id}: reserved`);
  }
});

test("slot fields are null exactly when the order has no slot", () => {
  for (const order of seed.work_orders) {
    const fixed = order.status === "in_progress" || order.status === "completed" || order.status === "scheduled";
    for (const field of ["technician_id", "scheduled_start", "scheduled_end"]) {
      assert.equal(order[field] !== null, fixed, `${order.id}.${field}`);
    }
    assert.equal(order.status_reason, null);
  }
});

test("no seeded window reaches the week the hidden tests build for themselves", () => {
  for (const order of seed.work_orders) assert.ok(order.due_date < EMPTY_WEEK, `${order.id} is due ${order.due_date}`);
});

test("the seed contains the cases the design requires by construction", () => {
  const statuses = seed.work_orders.map((order: { status: string }) => order.status);
  assert.ok(statuses.includes("in_progress") && statuses.includes("completed"));
  assert.ok(seed.technicians.some((t: any) => minutes(t.shift_end) - minutes(t.shift_start) > 480), "a shift longer than the cap");
  assert.ok(seed.parts.some((p: any) => p.on_hand - p.reserved < p.min_stock), "a low-stock part");
  assert.ok(seed.parts.some((p: any) => p.on_hand - p.reserved === p.min_stock), "a part exactly at min_stock");
  assert.ok(seed.work_orders.some((o: any) => o.earliest_start < "2026-10-05"), "a window opening before the seed Monday");
  assert.ok(seed.work_orders.some((o: any) => o.due_date > "2026-10-09"), "a window closing after the seed Friday");
});
