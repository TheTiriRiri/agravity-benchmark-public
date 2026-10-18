import assert from "node:assert/strict";
import { seed, type Technician, type WorkOrder } from "../../../../benchmark/contract-tests/api";

/**
 * Validates general schedule validity for planned work orders (ruling Task 6 review-13):
 * a) scheduled_start and scheduled_end lie on the same day in the scenario's week (Mon-Fri),
 *    and scheduled_end - scheduled_start = duration_minutes.
 * b) start >= shift_start and end <= shift_end of the assigned technician (from seed).
 * c) start date not earlier than earliest_start and not later than due_date.
 * d) orders of the same technician do not overlap in time.
 */
export function assertValidSchedule(
  orders: WorkOrder[] | any[],
  weekStart: string = "2026-10-12",
  technicians: Technician[] = seed.technicians,
): void {
  const scheduled = (orders ?? []).filter((o: any) => o.status === "scheduled");

  // Calculate Mon-Fri workdays of the scenario week
  const monday = new Date(`${weekStart}T00:00:00Z`);
  const workDays: string[] = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(monday.getTime() + i * 86_400_000);
    workDays.push(d.toISOString().slice(0, 10));
  }

  const byTech = new Map<string, any[]>();

  for (const o of scheduled) {
    assert.ok(o.technician_id, `${o.id} is scheduled but has no technician_id`);
    assert.ok(o.scheduled_start, `${o.id} is scheduled but has no scheduled_start`);
    assert.ok(o.scheduled_end, `${o.id} is scheduled but has no scheduled_end`);

    const tech = technicians.find((t) => t.id === o.technician_id);
    assert.ok(tech, `${o.id} assigned to unknown technician ${o.technician_id}`);

    const startDate = o.scheduled_start.slice(0, 10);
    const endDate = o.scheduled_end.slice(0, 10);

    // a) scheduled_start and scheduled_end on the same day in the scenario week (Mon-Fri)
    assert.equal(
      startDate,
      endDate,
      `${o.id} scheduled_start (${startDate}) and scheduled_end (${endDate}) must lie on the same day`,
    );
    assert.ok(
      workDays.includes(startDate),
      `${o.id} date ${startDate} is not a workday (Mon-Fri) in scenario week ${weekStart} (${workDays.join(", ")})`,
    );

    // a) scheduled_end - scheduled_start = duration_minutes
    const startMinutes = Number(o.scheduled_start.slice(11, 13)) * 60 + Number(o.scheduled_start.slice(14, 16));
    const endMinutes = Number(o.scheduled_end.slice(11, 13)) * 60 + Number(o.scheduled_end.slice(14, 16));
    const diffMinutes = endMinutes - startMinutes;
    assert.equal(
      diffMinutes,
      o.duration_minutes,
      `${o.id} scheduled duration (${diffMinutes} min) must equal duration_minutes (${o.duration_minutes})`,
    );

    // b) start >= shift_start and end <= shift_end of the assigned technician
    const startTime = o.scheduled_start.slice(11, 16);
    const endTime = o.scheduled_end.slice(11, 16);
    assert.ok(
      startTime >= tech.shift_start,
      `${o.id} starts at ${startTime}, before ${tech.id} shift start ${tech.shift_start}`,
    );
    assert.ok(
      endTime <= tech.shift_end,
      `${o.id} ends at ${endTime}, after ${tech.id} shift end ${tech.shift_end}`,
    );

    // c) start date not earlier than earliest_start and not later than due_date
    if (o.earliest_start) {
      assert.ok(
        startDate >= o.earliest_start,
        `${o.id} start date ${startDate} is earlier than earliest_start ${o.earliest_start}`,
      );
    }
    if (o.due_date) {
      assert.ok(
        startDate <= o.due_date,
        `${o.id} start date ${startDate} is later than due_date ${o.due_date}`,
      );
    }

    const techList = byTech.get(tech.id) ?? [];
    techList.push(o);
    byTech.set(tech.id, techList);
  }

  // d) orders of the same technician do not overlap in time
  for (const [techId, techOrders] of byTech) {
    techOrders.sort((a, b) => a.scheduled_start.localeCompare(b.scheduled_start));
    for (let i = 1; i < techOrders.length; i++) {
      const prev = techOrders[i - 1];
      const curr = techOrders[i];
      assert.ok(
        prev.scheduled_end <= curr.scheduled_start,
        `${curr.id} (${curr.scheduled_start}) overlaps with ${prev.id} (ends ${prev.scheduled_end}) for technician ${techId}`,
      );
    }
  }
}
