import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { ok, reset } from "../../../../benchmark/contract-tests/api";
import { loadsFromOrders } from "./loads";
import { assertValidSchedule } from "./schedule";

const scenarioPath = new URL("./balanced-scenario.json", import.meta.url);
const scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));

beforeEach(reset);

async function setupScenario(): Promise<void> {
  for (const orderInput of scenario.orders) {
    await ok("POST", "/work-orders", orderInput, 201);
  }
}

test("default POST /plan returns 5 historical keys without technician_load AND explicit strategy returns technician_load", async () => {
  await setupScenario();

  // 1. Default POST /plan (omitting strategy)
  const defaultRes = await ok("POST", `/plan?week_start=${scenario.week_start}`);
  assert.deepEqual(
    Object.keys(defaultRes).sort(),
    ["blocked", "orders", "scheduled", "unscheduled", "week_start"],
    "default POST /plan must return exactly the 5 historical keys",
  );
  assert.equal("technician_load" in defaultRes, false, "technician_load must be omitted when strategy is omitted");

  // 2. Explicit strategy=earliest
  const earliestRes = await ok("POST", `/plan?week_start=${scenario.week_start}&strategy=earliest`);
  assert.ok(
    earliestRes.technician_load && typeof earliestRes.technician_load === "object",
    "technician_load must be an object for strategy=earliest",
  );
  const expectedKeys = Object.keys(scenario.expected_earliest.technician_load).sort();
  assert.deepEqual(Object.keys(earliestRes.technician_load).sort(), expectedKeys);

  // 3. Explicit strategy=balanced
  const balancedRes = await ok("POST", `/plan?week_start=${scenario.week_start}&strategy=balanced`);
  assert.ok(
    balancedRes.technician_load && typeof balancedRes.technician_load === "object",
    "technician_load must be an object for strategy=balanced",
  );
  assert.deepEqual(Object.keys(balancedRes.technician_load).sort(), expectedKeys);
});

test("conservation of load and valid qualified technician assignments", async () => {
  await setupScenario();

  const totalDuration = scenario.orders.reduce(
    (sum: number, o: { duration_minutes: number }) => sum + o.duration_minutes,
    0,
  );

  const defaultRes = await ok("POST", `/plan?week_start=${scenario.week_start}`);
  const earliestRes = await ok("POST", `/plan?week_start=${scenario.week_start}&strategy=earliest`);
  const balancedRes = await ok("POST", `/plan?week_start=${scenario.week_start}&strategy=balanced`);

  // Backwards compatibility: schedule for earliest matches default schedule
  assert.deepEqual(earliestRes.scheduled, defaultRes.scheduled);
  assert.deepEqual(
    earliestRes.orders.map((o: any) => ({
      id: o.id,
      tech: o.technician_id,
      start: o.scheduled_start,
      end: o.scheduled_end,
    })),
    defaultRes.orders.map((o: any) => ({
      id: o.id,
      tech: o.technician_id,
      start: o.scheduled_start,
      end: o.scheduled_end,
    })),
  );

  // Conservation of load
  assert.equal(
    Object.values(earliestRes.technician_load ?? {}).reduce((a: number, b: any) => a + Number(b), 0),
    totalDuration,
    "sum of technician_load for earliest must equal total scheduled minutes",
  );
  assert.equal(
    Object.values(balancedRes.technician_load ?? {}).reduce((a: number, b: any) => a + Number(b), 0),
    totalDuration,
    "sum of technician_load for balanced must equal total scheduled minutes",
  );

  // Consistency between technician_load and actual scheduled order assignments for both strategies.
  // In this scenario there is no fixed load (in_progress/completed orders in the week), so equality must be exact.
  for (const [strategyName, res] of [["earliest", earliestRes], ["balanced", balancedRes]] as const) {
    const orderLoads = loadsFromOrders(res.orders);
    for (const [techId, load] of Object.entries(res.technician_load ?? {})) {
      assert.equal(
        orderLoads[techId] ?? 0,
        Number(load),
        `technician_load[${techId}] (${load}) must match sum of scheduled order duration_minutes (${orderLoads[techId] ?? 0}) for strategy=${strategyName}`,
      );
    }
  }

  // Qualified technician assignment: orders in balanced must be assigned to qualified technicians at S-001
  for (const o of balancedRes.orders) {
    if (o.status === "scheduled") {
      assert.ok(
        ["T-001", "T-002"].includes(o.technician_id),
        `${o.id} must be assigned to a qualified electrical technician at S-001`,
      );
    }
  }

  // General schedule validity for both strategies (Ruling Task 6 review-13)
  assertValidSchedule(earliestRes.orders, scenario.week_start);
  assertValidSchedule(balancedRes.orders, scenario.week_start);
});

test("strategy=balanced achieves strictly lower workload spread across qualified technicians than strategy=earliest (D11)", async () => {
  await setupScenario();

  const earliestRes = await ok("POST", `/plan?week_start=${scenario.week_start}&strategy=earliest`);
  const balancedRes = await ok("POST", `/plan?week_start=${scenario.week_start}&strategy=balanced`);

  assert.ok(earliestRes.technician_load && balancedRes.technician_load, "both responses must include technician_load");
  assertValidSchedule(earliestRes.orders, scenario.week_start);
  assertValidSchedule(balancedRes.orders, scenario.week_start);

  const qualifiedTechs = ["T-001", "T-002"];
  const earliestLoads = loadsFromOrders(earliestRes.orders);
  const balancedLoads = loadsFromOrders(balancedRes.orders);

  const spreadEarliest =
    Math.max(...qualifiedTechs.map((t) => earliestLoads[t] ?? 0)) -
    Math.min(...qualifiedTechs.map((t) => earliestLoads[t] ?? 0));
  const spreadBalanced =
    Math.max(...qualifiedTechs.map((t) => balancedLoads[t] ?? 0)) -
    Math.min(...qualifiedTechs.map((t) => balancedLoads[t] ?? 0));

  assert.ok(
    spreadBalanced < spreadEarliest,
    `balanced workload spread (${spreadBalanced}) must be strictly less than earliest spread (${spreadEarliest}) across qualified technicians`,
  );
});
