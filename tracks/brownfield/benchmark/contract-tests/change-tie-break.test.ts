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

test("exact tie-break technician_load for strategy=earliest and strategy=balanced (D9)", async () => {
  await setupScenario();

  const earliestRes = await ok("POST", `/plan?week_start=${scenario.week_start}&strategy=earliest`);
  assertValidSchedule(earliestRes.orders, scenario.week_start);
  const earliestOrderLoads = loadsFromOrders(earliestRes.orders);
  assert.deepEqual(
    earliestOrderLoads,
    scenario.expected_earliest.technician_load,
    "order assignment load for strategy=earliest must match expected earliest tie-break allocation",
  );
  assert.deepEqual(
    earliestRes.technician_load,
    scenario.expected_earliest.technician_load,
    "strategy=earliest technician_load must match expected earliest tie-break allocation",
  );

  const balancedRes = await ok("POST", `/plan?week_start=${scenario.week_start}&strategy=balanced`);
  assertValidSchedule(balancedRes.orders, scenario.week_start);
  const balancedOrderLoads = loadsFromOrders(balancedRes.orders);
  assert.deepEqual(
    balancedOrderLoads,
    scenario.expected_balanced.technician_load,
    "order assignment load for strategy=balanced must match expected balanced tie-break allocation (D9)",
  );
  assert.deepEqual(
    balancedRes.technician_load,
    scenario.expected_balanced.technician_load,
    "strategy=balanced technician_load must match expected balanced tie-break allocation (D9)",
  );
});
