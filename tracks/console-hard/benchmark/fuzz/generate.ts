/**
 * The hard track seeded case generator. `npm run hard-fuzz:generate` writes cases.json.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { CasesFile, FuzzCase, Step } from "./case";
import { Rng } from "./rng";
import { CASES_PER_STRATUM, HARD_STRATA, TOTAL_CASES } from "./strata";

export const FUZZ_SEED = 20260921;
export const GENERATOR_VERSION = 1;

const EMPTY_WEEK = "2026-10-12";
const WEEKDAYS = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"] as const;
const PRIORITIES = ["critical", "high", "medium", "low"] as const;

export const HARD_TECHNICIANS = [
  { id: "T-001", site_ids: ["S-001"], skills: ["electrical", "instrumentation"], shift: ["07:00", "17:00"], minutes: 600 },
  { id: "T-002", site_ids: ["S-001"], skills: ["electrical", "mechanical"], shift: ["08:00", "16:00"], minutes: 480 },
  { id: "T-003", site_ids: ["S-002"], skills: ["hydraulics", "mechanical"], shift: ["08:00", "16:00"], minutes: 480 },
  { id: "T-004", site_ids: ["S-002"], skills: ["mechanical"], shift: ["06:00", "14:00"], minutes: 480 },
  { id: "T-005", site_ids: ["S-001", "S-003"], skills: ["pneumatics", "welding"], shift: ["07:00", "17:00"], minutes: 600 },
  { id: "T-006", site_ids: ["S-002", "S-003"], skills: ["pneumatics"], shift: ["08:00", "16:00"], minutes: 480 },
  { id: "T-007", site_ids: ["S-003"], skills: ["pneumatics", "welding"], shift: ["08:00", "16:00"], minutes: 480 },
] as const;

export const HARD_SOLE = [
  { tech: "T-001", skill: "instrumentation", assets: ["A-001", "A-002", "A-003", "A-004"], minutes: 600 },
  { tech: "T-002", skill: "mechanical", assets: ["A-001", "A-002", "A-003", "A-004"], minutes: 480 },
  { tech: "T-003", skill: "hydraulics", assets: ["A-005", "A-006", "A-007", "A-008"], minutes: 480 },
  { tech: "T-005", skill: "welding", assets: ["A-001", "A-002", "A-003", "A-004"], minutes: 600 },
  { tech: "T-005", skill: "pneumatics", assets: ["A-001", "A-002", "A-003", "A-004"], minutes: 600 },
] as const;
const SOLE_480 = HARD_SOLE.filter((s) => s.minutes === 480);

export const HARD_STOCK = [
  { id: "P-001", available: 6 },
  { id: "P-002", available: 4 },
  { id: "P-003", available: 1 },
  { id: "P-004", available: 3 },
  { id: "P-005", available: 1 },
  { id: "P-006", available: 5 },
  { id: "P-007", available: 8 },
  { id: "P-008", available: 10 },
  { id: "P-009", available: 2 },
  { id: "P-010", available: 3 },
  { id: "P-011", available: 2 },
  { id: "P-012", available: 3 },
] as const;

const PLENTIFUL = HARD_STOCK.filter((p) => p.available >= 5);
const AT_LEAST_THREE = HARD_STOCK.filter((p) => p.available >= 3);
const AT_LEAST_TWO = HARD_STOCK.filter((p) => p.available >= 2);

const OTHER_WEEKS = [
  { monday: "2026-10-26", days: ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"] },
  { monday: "2026-11-02", days: ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"] },
] as const;

const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const NOT_CRITICAL = ["high", "medium", "low"] as const;

const OVERLAPPING_WINDOWS = [
  { label: "ends on the Monday", earliest: "2026-10-08", due: "2026-10-12" },
  { label: "starts on the Friday", earliest: "2026-10-16", due: "2026-10-20" },
  { label: "spans the whole week", earliest: "2026-10-05", due: "2026-10-30" },
  { label: "sits inside the week", earliest: "2026-10-13", due: "2026-10-14" },
  { label: "is the Monday alone", earliest: "2026-10-12", due: "2026-10-12" },
  { label: "is the Friday alone", earliest: "2026-10-16", due: "2026-10-16" },
] as const;

const DISJOINT_WINDOWS = [
  { label: "ends on the Sunday before", earliest: "2026-10-08", due: "2026-10-11" },
  { label: "starts on the Saturday after", earliest: "2026-10-17", due: "2026-10-21" },
  { label: "ends on the Friday before", earliest: "2026-10-05", due: "2026-10-09" },
  { label: "is the weekend before", earliest: "2026-10-10", due: "2026-10-11" },
  { label: "is the weekend after", earliest: "2026-10-17", due: "2026-10-18" },
] as const;

const UNQUALIFIED = [
  { assets: ["A-001", "A-002", "A-003", "A-004"], skill: "hydraulics" },
  { assets: ["A-005", "A-006", "A-007", "A-008"], skill: "electrical" },
  { assets: ["A-005", "A-006", "A-007", "A-008"], skill: "instrumentation" },
] as const;

const slots = (rng: Rng, minSlots: number, maxSlots: number): number => rng.int(minSlots, maxSlots) * 30;
const minutes = (slotCount: number): number => slotCount * 30;

let counter = 0;
const nextId = (): string => `case-${String(counter++).padStart(4, "0")}`;

const plan = (week: string): Step => ({ method: "POST", path: `/plan?week_start=${week}` });
const getOrder = (id: string): Step => ({ method: "GET", path: `/work-orders/${id}` });
const getParts = (): Step => ({ method: "GET", path: "/parts" });
const getSchedule = (week: string): Step => ({ method: "GET", path: `/schedule?week_start=${week}` });
const patch = (id: string, status: string): Step => ({
  method: "PATCH",
  path: `/work-orders/${id}`,
  body: { status },
});

interface OrderSpec {
  asset_id: string;
  required_skill: string;
  duration_minutes: number;
  earliest_start: string;
  due_date: string;
  priority: string;
  parts?: { part_id: string; quantity: number }[];
  crew_size?: number;
  splittable?: boolean;
  min_segment_minutes?: number | null;
}

const create = (spec: OrderSpec): Step => {
  const { crew_size, splittable, min_segment_minutes, ...rest } = spec;
  const body: Record<string, unknown> = {
    title: `fuzz ${spec.required_skill} ${spec.duration_minutes}`,
    ...rest,
  };
  if (crew_size !== undefined) body.crew_size = crew_size;
  if (splittable !== undefined) body.splittable = splittable;
  if (min_segment_minutes !== undefined) body.min_segment_minutes = min_segment_minutes;
  return {
    method: "POST",
    path: "/work-orders",
    body,
  };
};

/** Seed ends at WO-025, so generated orders start at WO-026. */
export const createdId = (index: number): string => `WO-${String(26 + index).padStart(3, "0")}`;

const observe = (count: number, from = 0): Step[] =>
  Array.from({ length: count }, (_, i) => getOrder(createdId(from + i)));

type Builder = (rng: Rng, index: number) => Omit<FuzzCase, "id" | "stratum">;

// 1. candidate-window-overlap
const buildCandidateWindowOverlap: Builder = (rng) => {
  const touching = rng.shuffled(OVERLAPPING_WINDOWS).slice(0, rng.int(2, 3));
  const apart = rng.shuffled(DISJOINT_WINDOWS).slice(0, rng.int(1, 2));
  const windows = rng.shuffled([...touching, ...apart]);
  return {
    aim: `${windows.length} orders nobody is qualified for; each window ${windows.map((w) => w.label).join(", ")}`,
    setup: windows.map((w) => {
      const kind = rng.pick(UNQUALIFIED);
      return create({
        asset_id: rng.pick(kind.assets),
        required_skill: kind.skill,
        duration_minutes: slots(rng, 1, 2),
        earliest_start: w.earliest,
        due_date: w.due,
        priority: rng.pick(PRIORITIES),
      });
    }),
    script: [plan(EMPTY_WEEK), ...observe(windows.length), getSchedule(EMPTY_WEEK)],
  };
};

// 2. candidate-other-week-untouched
const buildCandidateOtherWeek: Builder = (rng) => {
  const sole = rng.pick(HARD_SOLE);
  const other = rng.pick(OTHER_WEEKS);
  const part = rng.pick(PLENTIFUL);
  const held = rng.int(1, 3);
  const own = rng.int(1, 2);
  const otherDay = rng.pick(other.days);
  const day = rng.pick(WEEKDAYS);
  return {
    aim: `an order held by the plan of ${other.monday} (${held} x ${part.id}) must survive a plan of ${EMPTY_WEEK} that does not touch its week`,
    setup: [
      create({
        asset_id: rng.pick(sole.assets),
        required_skill: sole.skill,
        duration_minutes: slots(rng, 2, 6),
        earliest_start: otherDay,
        due_date: otherDay,
        priority: rng.pick(PRIORITIES),
        parts: [{ part_id: part.id, quantity: held }],
      }),
      plan(other.monday),
      create({
        asset_id: rng.pick(sole.assets),
        required_skill: sole.skill,
        duration_minutes: slots(rng, 1, 3),
        earliest_start: day,
        due_date: day,
        priority: rng.pick(PRIORITIES),
        parts: [{ part_id: part.id, quantity: own }],
      }),
    ],
    script: [
      plan(EMPTY_WEEK),
      ...observe(2),
      getParts(),
      getSchedule(other.monday),
      getSchedule(EMPTY_WEEK),
    ],
  };
};

// 3. candidate-terminal-excluded
const buildCandidateTerminal: Builder = (rng) => {
  const sole = rng.pick(HARD_SOLE);
  const kinds = rng.shuffled(["in_progress", "completed", "cancelled"]).slice(0, rng.int(1, 3));
  const days = rng.shuffled(WEEKDAYS);
  const spec = (day: string): OrderSpec => ({
    asset_id: rng.pick(sole.assets),
    required_skill: sole.skill,
    duration_minutes: slots(rng, 1, 4),
    earliest_start: day,
    due_date: day,
    priority: rng.pick(PRIORITIES),
  });
  const setup: Step[] = kinds.map((_, i) => create(spec(days[i] as string)));
  kinds.forEach((kind, i) => {
    if (kind === "cancelled") setup.push(patch(createdId(i), "cancelled"));
  });
  setup.push(plan(EMPTY_WEEK));
  kinds.forEach((kind, i) => {
    if (kind === "cancelled") return;
    setup.push(patch(createdId(i), "in_progress"));
    if (kind === "completed") setup.push(patch(createdId(i), "completed"));
  });
  return {
    aim: `orders driven to ${kinds.join(", ")} must not come back as candidates when a later order is planned`,
    setup,
    script: [create(spec(days[kinds.length] as string)), plan(EMPTY_WEEK), ...observe(kinds.length + 1)],
  };
};

// 4. bulk-reset-releases
const buildBulkReset: Builder = (rng, index) => {
  const sole = rng.pick(HARD_SOLE);
  const base = (day: string, until: string) => ({
    asset_id: rng.pick(sole.assets),
    required_skill: sole.skill,
    duration_minutes: slots(rng, 1, 3),
    earliest_start: day,
    due_date: until,
  });
  if (index % 2 === 0) {
    const part = rng.pick(AT_LEAST_THREE);
    const held = rng.int(2, part.available - 1);
    const wanted = rng.int(part.available - held + 1, part.available);
    const earlier = rng.int(0, 3);
    const later = rng.int(earlier + 1, 4);
    const [oldDay, newDay] = [WEEKDAYS[later], WEEKDAYS[earlier]];
    return {
      aim: `${part.id} has ${part.available}: an order holds ${held}, then a critical newcomer due earlier asks for ${wanted}`,
      setup: [
        create({ ...base(oldDay, oldDay), priority: rng.pick(NOT_CRITICAL), parts: [{ part_id: part.id, quantity: held }] }),
        plan(EMPTY_WEEK),
      ],
      script: [
        create({ ...base(newDay, newDay), priority: "critical", parts: [{ part_id: part.id, quantity: wanted }] }),
        plan(EMPTY_WEEK),
        ...observe(2),
        getParts(),
      ],
    };
  }
  const held = rng.int(1, 2);
  const at = rng.int(0, 3);
  const day = WEEKDAYS[at];
  const after = WEEKDAYS[at + 1];
  return {
    aim: `${held} scheduled order(s) on one day, then a critical newcomer due earlier for the same day`,
    setup: [
      ...NOT_CRITICAL.slice(0, held).map((priority) => create({ ...base(day, after), priority })),
      plan(EMPTY_WEEK),
    ],
    script: [
      create({ ...base(day, day), priority: "critical" }),
      plan(EMPTY_WEEK),
      ...observe(held + 1),
      getSchedule(EMPTY_WEEK),
    ],
  };
};

// 5. fixed-load-blocks-overlap
const buildFixedBlocks: Builder = (rng) => {
  const sole = rng.pick(HARD_SOLE);
  const day = rng.pick(WEEKDAYS);
  const kinds = Array.from({ length: rng.int(1, 2) }, () => (rng.chance(0.5) ? "in_progress" : "completed"));
  const spec = (priority: string): OrderSpec => ({
    asset_id: rng.pick(sole.assets),
    required_skill: sole.skill,
    duration_minutes: slots(rng, 1, 4),
    earliest_start: day,
    due_date: day,
    priority,
  });
  const setup: Step[] = [...kinds.map((_, i) => create(spec(NOT_CRITICAL[i] as string))), plan(EMPTY_WEEK)];
  kinds.forEach((kind, i) => {
    setup.push(patch(createdId(i), "in_progress"));
    if (kind === "completed") setup.push(patch(createdId(i), "completed"));
  });
  return {
    aim: `${kinds.join(" and ")} order(s) fixed on one day; a new order for that day must not overlap them`,
    setup,
    script: [
      create(spec(rng.pick(PRIORITIES))),
      plan(EMPTY_WEEK),
      ...observe(kinds.length + 1),
      getSchedule(EMPTY_WEEK),
    ],
  };
};

// 6. fixed-load-counts-to-cap
const buildFixedCounts: Builder = (rng, index) => {
  const t001 = HARD_SOLE[0];
  const day = rng.pick(WEEKDAYS);
  const filled = slots(rng, 10, 14);
  const slack = 480 - filled;
  const asked = index % 2 === 0 ? slack : slack + 30;
  const finished = rng.chance(0.5);
  const spill = rng.chance(0.5);
  const due = spill && day !== WEEKDAYS[4] ? WEEKDAYS[WEEKDAYS.indexOf(day) + 1] : day;
  const spec = (duration: number, until: string): OrderSpec => ({
    asset_id: rng.pick(t001.assets),
    required_skill: t001.skill,
    duration_minutes: duration,
    earliest_start: day,
    due_date: until,
    priority: "medium",
  });
  return {
    aim: `a ${finished ? "completed" : "in_progress"} order fixes ${filled} minutes of ${day}; a ${asked}-minute order asks for the rest of the cap`,
    setup: [
      create(spec(filled, day)),
      plan(EMPTY_WEEK),
      patch(createdId(0), "in_progress"),
      ...(finished ? [patch(createdId(0), "completed")] : []),
    ],
    script: [
      create(spec(asked, due)),
      plan(EMPTY_WEEK),
      ...observe(2),
      getSchedule(EMPTY_WEEK),
    ],
  };
};

// 7. order-by-due-date (Rule 4 EDF)
const buildOrderByDueDate: Builder = (rng) => {
  const sole = rng.pick(HARD_SOLE);
  const priority = rng.pick(PRIORITIES);
  const dues = rng.shuffled(WEEKDAYS).slice(0, rng.int(3, 4));
  const ascending = [...dues].sort();
  let created = rng.shuffled(dues);
  while (created.every((d, i) => d === ascending[i])) created = rng.shuffled(dues);
  return {
    aim: `${created.length} ${priority} orders opening Monday, created with due dates ${created.join(", ")}`,
    setup: created.map((due) =>
      create({
        asset_id: rng.pick(sole.assets),
        required_skill: sole.skill,
        duration_minutes: slots(rng, 1, 3),
        earliest_start: WEEKDAYS[0],
        due_date: due,
        priority,
      }),
    ),
    script: [plan(EMPTY_WEEK), ...observe(created.length), getSchedule(EMPTY_WEEK)],
  };
};

// 8. order-by-priority (Rule 4 EDF: equal due_date broken by priority)
const buildOrderByPriority: Builder = (rng) => {
  const sole = rng.pick(HARD_SOLE);
  const day = rng.pick(WEEKDAYS);
  const chosen = rng.shuffled(PRIORITIES).slice(0, rng.int(3, 4));
  const ranked = [...chosen].sort((a, b) => (PRIORITY_RANK[a] as number) - (PRIORITY_RANK[b] as number));
  let created = rng.shuffled(chosen);
  while (created.every((p, i) => p === ranked[i])) created = rng.shuffled(chosen);
  return {
    aim: `${created.length} orders for one day (${day}), created in priority order ${created.join(", ")}`,
    setup: created.map((priority) =>
      create({
        asset_id: rng.pick(sole.assets),
        required_skill: sole.skill,
        duration_minutes: slots(rng, 1, 3),
        earliest_start: day,
        due_date: day,
        priority,
      }),
    ),
    script: [plan(EMPTY_WEEK), ...observe(created.length), getSchedule(EMPTY_WEEK)],
  };
};

// 9. order-by-id (Rule 4 EDF: equal due_date and priority broken by id ascending)
const buildOrderById: Builder = (rng) => {
  const sole = rng.pick(HARD_SOLE);
  const priority = rng.pick(PRIORITIES);
  const first = rng.int(0, 2);
  const last = rng.int(first, 4);
  const count = rng.int(3, 5);
  return {
    aim: `${count} ${priority} orders with one window (${WEEKDAYS[first]} to ${WEEKDAYS[last]}) ordered by id`,
    setup: Array.from({ length: count }, () =>
      create({
        asset_id: rng.pick(sole.assets),
        required_skill: sole.skill,
        duration_minutes: slots(rng, 1, 3),
        earliest_start: WEEKDAYS[first],
        due_date: WEEKDAYS[last],
        priority,
      }),
    ),
    script: [plan(EMPTY_WEEK), ...observe(count), getSchedule(EMPTY_WEEK)],
  };
};

// 10. parts-blocked
const buildPartsBlocked: Builder = (rng) => {
  const sole = rng.pick(HARD_SOLE);
  const [dayA, dayB] = rng.shuffled(WEEKDAYS);
  const [fits, short] = rng.shuffled(HARD_STOCK);
  const spare = rng.pick(HARD_STOCK.filter((p) => p.id !== fits.id && p.id !== short.id));
  const withSpare = rng.chance(0.5);
  const shortLines = [
    { part_id: short.id, quantity: short.available + rng.int(1, 2) },
    ...(withSpare ? [{ part_id: spare.id, quantity: 1 }] : []),
  ];
  const fitsLines = [{ part_id: fits.id, quantity: fits.available }];
  const spec = (day: string, parts: { part_id: string; quantity: number }[]): OrderSpec => ({
    asset_id: rng.pick(sole.assets),
    required_skill: sole.skill,
    duration_minutes: slots(rng, 1, 2),
    earliest_start: day,
    due_date: day,
    priority: rng.pick(PRIORITIES),
    parts,
  });
  const shortFirst = rng.chance(0.5);
  const specs = shortFirst
    ? [spec(dayA, shortLines), spec(dayB, fitsLines)]
    : [spec(dayA, fitsLines), spec(dayB, shortLines)];
  return {
    aim: `one order asks for all ${fits.available} of ${fits.id}, another for more than ${short.id} has`,
    setup: specs.map(create),
    script: [plan(EMPTY_WEEK), ...observe(2), getParts()],
  };
};

// 11. parts-consumed-in-order
const buildPartsConsumed: Builder = (rng) => {
  const sole = rng.pick(HARD_SOLE);
  const part = rng.pick(AT_LEAST_TWO);
  const count = rng.int(2, 3);
  const days = rng.shuffled(WEEKDAYS).slice(0, count).sort();
  const first = rng.int(1, part.available);
  const quantities = [first, rng.int(part.available - first + 1, part.available), rng.int(1, part.available)].slice(0, count);
  return {
    aim: `${count} orders share ${part.id} (${part.available} available): quantities in processing order ${quantities.join(", ")}`,
    setup: quantities.map((quantity, i) =>
      create({
        asset_id: rng.pick(sole.assets),
        required_skill: sole.skill,
        duration_minutes: slots(rng, 1, 3),
        earliest_start: days[i] as string,
        due_date: days[i] as string,
        priority: PRIORITIES[i] as string,
        parts: [{ part_id: part.id, quantity }],
      }),
    ),
    script: [plan(EMPTY_WEEK), getParts(), ...observe(count)],
  };
};

// 12. parts-before-technician
const buildPartsBeforeTechnician: Builder = (rng) => {
  const quantity = rng.int(50, 99);
  const part = rng.pick(["P-001", "P-002", "P-005"]);
  return {
    aim: `an order short of ${part} and with no qualified technician must be blocked, not unscheduled`,
    setup: [],
    script: [
      create({
        asset_id: "A-005",
        required_skill: "electrical",
        duration_minutes: 60,
        earliest_start: WEEKDAYS[0],
        due_date: WEEKDAYS[4],
        priority: rng.pick([...PRIORITIES]),
        parts: [{ part_id: part, quantity }],
      }),
      plan(EMPTY_WEEK),
      getOrder(createdId(0)),
      getParts(),
    ],
  };
};

// 13. no-qualified-technician
const buildNoQualified: Builder = (rng) => {
  const sole = rng.pick(HARD_SOLE);
  const bad = rng.shuffled(UNQUALIFIED).slice(0, rng.int(1, 2));
  const day = rng.pick(WEEKDAYS);
  const spec = (asset: string, skill: string): OrderSpec => ({
    asset_id: asset,
    required_skill: skill,
    duration_minutes: slots(rng, 1, 3),
    earliest_start: day,
    due_date: day,
    priority: rng.pick(PRIORITIES),
  });
  const specs = rng.shuffled([
    ...bad.map((u) => spec(rng.pick(u.assets), u.skill)),
    spec(rng.pick(sole.assets), sole.skill),
  ]);
  return {
    aim: `${bad.length} order(s) whose skill is held only at the other site, beside one that is qualified`,
    setup: specs.map(create),
    script: [plan(EMPTY_WEEK), ...observe(specs.length), getSchedule(EMPTY_WEEK)],
  };
};

// 14. slot-grid-and-shift
const buildSlotShift: Builder = (rng, index) => {
  const sole = rng.pick(SOLE_480);
  const at = rng.int(0, 3);
  const day = WEEKDAYS[at];
  const f1 = slots(rng, 1, 3);
  const b = slots(rng, 2, 6);
  const tail = 480 - f1 - b;
  const asked = index % 2 === 0 ? tail : tail + 30;
  const due = rng.chance(0.5) ? WEEKDAYS[at + 1] : day;
  const spec = (duration: number, until: string, priority: string): OrderSpec => ({
    asset_id: rng.pick(sole.assets),
    required_skill: sole.skill,
    duration_minutes: duration,
    earliest_start: day,
    due_date: until,
    priority,
  });
  return {
    aim: `${sole.tech}: ${f1} free minutes then fixed ${b}m block leaves ${tail}m to end of shift`,
    setup: [
      create(spec(f1, day, "high")),
      create(spec(b, day, "medium")),
      plan(EMPTY_WEEK),
      patch(createdId(1), "in_progress"),
      patch(createdId(0), "cancelled"),
    ],
    script: [
      create(spec(asked, due, "medium")),
      plan(EMPTY_WEEK),
      getOrder(createdId(1)),
      getOrder(createdId(2)),
      getSchedule(EMPTY_WEEK),
    ],
  };
};

// 15. slot-window-clipping
const buildWindowClipping: Builder = (rng, index) => {
  const variant = index % 3;
  if (variant < 2) {
    const sole = rng.pick(HARD_SOLE);
    const before = variant === 0 ? rng.pick(["2026-10-01", "2026-10-07", "2026-10-09"]) : rng.pick(["2026-10-10", "2026-10-11"]);
    const spec = (earliest: string, due: string): OrderSpec => ({
      asset_id: rng.pick(sole.assets),
      required_skill: sole.skill,
      duration_minutes: slots(rng, 1, 3),
      earliest_start: earliest,
      due_date: due,
      priority: rng.pick(PRIORITIES),
    });
    const dueIndex = rng.int(0, 4);
    const insideIndex = rng.int(1, 3);
    return {
      aim: `an order opening on ${before} before the week, due ${WEEKDAYS[dueIndex]}`,
      setup: [create(spec(before, WEEKDAYS[dueIndex])), create(spec(WEEKDAYS[insideIndex], WEEKDAYS[4]))],
      script: [plan(EMPTY_WEEK), ...observe(2), getSchedule(EMPTY_WEEK)],
    };
  }
  const sole = rng.pick(SOLE_480);
  const friday = WEEKDAYS[4];
  const later = rng.pick(["2026-10-17", "2026-10-19", "2026-10-21", "2026-10-30"]);
  const spec = (duration: number, until: string): OrderSpec => ({
    asset_id: rng.pick(sole.assets),
    required_skill: sole.skill,
    duration_minutes: duration,
    earliest_start: friday,
    due_date: until,
    priority: "medium",
  });
  return {
    aim: `${sole.tech}'s Friday is full; an order opening that Friday runs to ${later}`,
    setup: [create(spec(minutes(16), friday)), plan(EMPTY_WEEK), patch(createdId(0), "in_progress")],
    script: [
      create(spec(slots(rng, 1, 4), later)),
      plan(EMPTY_WEEK),
      getOrder(createdId(0)),
      getOrder(createdId(1)),
      getSchedule(EMPTY_WEEK),
    ],
  };
};

// 16. daily-cap-480
const buildDailyCap: Builder = (rng, index) => {
  const filled = slots(rng, 10, 14);
  const slack = 480 - filled;
  const asked = index % 2 === 0 ? slack : slack + 30;
  const day = rng.pick(WEEKDAYS);
  return {
    aim: `T-001 is loaded to ${filled} minutes on ${day}; a ${asked}-minute job ${asked <= slack ? "fits" : "exceeds"} 480 cap`,
    setup: [
      create({ asset_id: "A-004", required_skill: "instrumentation", duration_minutes: filled, earliest_start: day, due_date: day, priority: "critical" }),
    ],
    script: [
      create({ asset_id: "A-004", required_skill: "instrumentation", duration_minutes: asked, earliest_start: day, due_date: day, priority: "low" }),
      plan(EMPTY_WEEK),
      getOrder(createdId(0)),
      getOrder(createdId(1)),
      getSchedule(EMPTY_WEEK),
    ],
  };
};

// 17. choice-earliest-then-lowest-id
const buildChoice: Builder = (rng, index) => {
  const tie = index % 4 < 2;
  const day = rng.pick(WEEKDAYS);
  const spec = (asset: string, skill: string, duration: number, priority: string): OrderSpec => ({
    asset_id: asset,
    required_skill: skill,
    duration_minutes: duration,
    earliest_start: day,
    due_date: day,
    priority,
  });
  if (index % 2 === 0) {
    const busy = tie ? minutes(2) : minutes(rng.pick([1, 3, 4]));
    return {
      aim: `T-001 is busy for ${busy}m from 07:00; electrical order can go to T-001 or T-002`,
      setup: [
        create(spec(rng.pick(["A-001", "A-002", "A-003", "A-004"]), "instrumentation", busy, "critical")),
        create(spec(rng.pick(["A-001", "A-002", "A-003", "A-004"]), "electrical", slots(rng, 1, 3), "medium")),
      ],
      script: [plan(EMPTY_WEEK), ...observe(2), getSchedule(EMPTY_WEEK)],
    };
  }
  const busy = tie ? minutes(4) : minutes(rng.pick([3, 5]));
  return {
    aim: `T-004 takes ${busy}m order from 06:00; mechanical order can go to T-004 or T-003`,
    setup: [
      create(spec(rng.pick(["A-005", "A-006", "A-007", "A-008"]), "mechanical", busy, "critical")),
      create(spec(rng.pick(["A-005", "A-006", "A-007", "A-008"]), "mechanical", slots(rng, 1, 3), "medium")),
    ],
    script: [plan(EMPTY_WEEK), ...observe(2), getSchedule(EMPTY_WEEK)],
  };
};

// 18. no-capacity
const buildNoCapacity: Builder = (rng) => {
  const sole = rng.pick(SOLE_480);
  const day = rng.pick(WEEKDAYS);
  let durations: number[] = [];
  do {
    durations = Array.from({ length: rng.int(3, 4) }, () => slots(rng, 4, 8));
  } while (durations.reduce((sum, d) => sum + d, 0) <= 480);
  return {
    aim: `${sole.tech} is asked for ${durations.reduce((sum, d) => sum + d, 0)} minutes on ${day}`,
    setup: durations.map((d, i) =>
      create({
        asset_id: rng.pick(sole.assets),
        required_skill: sole.skill,
        duration_minutes: d,
        earliest_start: day,
        due_date: day,
        priority: PRIORITIES[i] as string,
        parts: [{ part_id: "P-008", quantity: 1 }],
      }),
    ),
    script: [plan(EMPTY_WEEK), getParts(), getSchedule(EMPTY_WEEK), ...observe(durations.length)],
  };
};

// 19. replan-determinism
const buildReplanDeterminism: Builder = (rng) => {
  const count = rng.int(2, 5);
  const setup = Array.from({ length: count }, () =>
    create({
      asset_id: rng.pick(["A-001", "A-002", "A-003"]),
      required_skill: rng.pick(["electrical", "mechanical", "instrumentation"]),
      duration_minutes: rng.int(1, 8) * 30,
      earliest_start: WEEKDAYS[0],
      due_date: WEEKDAYS[4],
      priority: rng.pick([...PRIORITIES]),
      parts: rng.chance(0.5) ? [{ part_id: "P-008", quantity: 1 }] : [],
    }),
  );
  return {
    aim: `${count} orders planned twice give identical replies and stock`,
    setup,
    script: [plan(EMPTY_WEEK), getParts(), plan(EMPTY_WEEK), getParts()],
    invariants: [
      { kind: "steps-equal", a: 0, b: 2 },
      { kind: "steps-equal", a: 1, b: 3 },
    ],
    oracle: false,
  };
};

// 20. transition-stock-effects
const buildTransitionEffects: Builder = (rng, index) => {
  const sole = rng.pick(HARD_SOLE);
  const day = rng.pick(WEEKDAYS);
  const lines = rng
    .shuffled(AT_LEAST_THREE)
    .slice(0, rng.int(1, 2))
    .map((p) => ({ part_id: p.id, quantity: rng.int(2, 3) }));
  const lifecycle = index % 6;
  const LIFECYCLES: { aim: string; script: Step[] }[] = [
    {
      aim: "planned, started, completed",
      script: [plan(EMPTY_WEEK), patch(createdId(0), "in_progress"), getParts(), patch(createdId(0), "completed"), getOrder(createdId(0)), getParts()],
    },
    {
      aim: "planned, then cancelled while scheduled",
      script: [plan(EMPTY_WEEK), getParts(), patch(createdId(0), "cancelled"), getOrder(createdId(0)), getParts()],
    },
    {
      aim: "planned, started, then cancelled while in progress",
      script: [plan(EMPTY_WEEK), patch(createdId(0), "in_progress"), patch(createdId(0), "cancelled"), getOrder(createdId(0)), getParts()],
    },
    {
      aim: "cancelled while still open, never planned",
      script: [getParts(), patch(createdId(0), "cancelled"), getOrder(createdId(0)), getParts()],
    },
    {
      aim: "planned and started, not finished",
      script: [plan(EMPTY_WEEK), patch(createdId(0), "in_progress"), getOrder(createdId(0)), getParts()],
    },
    {
      aim: "planned, then asked to jump straight to completed",
      script: [plan(EMPTY_WEEK), patch(createdId(0), "completed"), getOrder(createdId(0)), getParts()],
    },
  ];
  const chosen = LIFECYCLES[lifecycle] as { aim: string; script: Step[] };
  return {
    aim: `an order holding ${lines.map((l) => `${l.quantity} x ${l.part_id}`).join(" and ")}: ${chosen.aim}`,
    setup: [
      create({
        asset_id: rng.pick(sole.assets),
        required_skill: sole.skill,
        duration_minutes: slots(rng, 1, 3),
        earliest_start: day,
        due_date: day,
        priority: rng.pick(PRIORITIES),
        parts: lines,
      }),
    ],
    script: chosen.script,
  };
};

// 21. crews-both-technicians
const buildCrewsBothTechnicians: Builder = (rng, index) => {
  const day = rng.pick(WEEKDAYS);
  const dur = slots(rng, 2, 4);
  if (index % 2 === 0) {
    return {
      aim: `crew order at A-009 (welding) requires both T-005 and T-007 to be free`,
      setup: [
        create({ asset_id: "A-009", required_skill: "welding", duration_minutes: dur, earliest_start: day, due_date: day, priority: "high", crew_size: 2 }),
      ],
      script: [
        plan(EMPTY_WEEK),
        getOrder(createdId(0)),
        getSchedule(EMPTY_WEEK),
      ],
    };
  }
  return {
    aim: `T-005 is busy at S-001; crew order for T-005 and T-007 at S-003 waits until both are free`,
    setup: [
      create({ asset_id: "A-001", required_skill: "welding", duration_minutes: 240, earliest_start: day, due_date: day, priority: "critical" }),
      create({ asset_id: "A-009", required_skill: "welding", duration_minutes: dur, earliest_start: day, due_date: day, priority: "high", crew_size: 2 }),
    ],
    script: [
      plan(EMPTY_WEEK),
      ...observe(2),
      getSchedule(EMPTY_WEEK),
    ],
  };
};

// 22. crews-tie-breaker
const buildCrewsTieBreaker: Builder = (rng) => {
  const day = WEEKDAYS[0];
  const dur = slots(rng, 1, 3);
  return {
    aim: `pneumatics at S-003 qualifies T-005, T-006 and T-007; crew_size 2 chooses lowest sorted id pair T-005 and T-006`,
    setup: [
      create({ asset_id: "A-010", required_skill: "pneumatics", duration_minutes: dur, earliest_start: day, due_date: day, priority: "high", crew_size: 2 }),
    ],
    script: [
      plan(EMPTY_WEEK),
      getOrder(createdId(0)),
      getSchedule(EMPTY_WEEK),
    ],
  };
};

// 23. multi-site-qualification
const buildMultiSiteQualification: Builder = (rng, index) => {
  const day = rng.pick(WEEKDAYS);
  const dur = slots(rng, 1, 3);
  if (index % 2 === 0) {
    return {
      aim: `T-005 serves S-001 and S-003: must qualify for welding at S-003 (A-009)`,
      setup: [
        create({ asset_id: "A-009", required_skill: "welding", duration_minutes: dur, earliest_start: day, due_date: day, priority: "high" }),
      ],
      script: [
        plan(EMPTY_WEEK),
        getOrder(createdId(0)),
        getSchedule(EMPTY_WEEK),
      ],
    };
  }
  return {
    aim: `T-006 serves S-002 and S-003: must qualify for pneumatics at S-002 (A-005)`,
    setup: [
      create({ asset_id: "A-005", required_skill: "pneumatics", duration_minutes: dur, earliest_start: day, due_date: day, priority: "high" }),
    ],
    script: [
      plan(EMPTY_WEEK),
      getOrder(createdId(0)),
      getSchedule(EMPTY_WEEK),
    ],
  };
};

// 24. travel-matrix-consecutive
const buildTravelMatrixConsecutive: Builder = (rng) => {
  const day = rng.pick(WEEKDAYS);
  const dur1 = slots(rng, 2, 4);
  const dur2 = slots(rng, 1, 3);
  return {
    aim: `T-005 works at S-001 then S-003 on ${day}: consecutive assignments require transit gap >= 30m`,
    setup: [
      create({ asset_id: "A-001", required_skill: "welding", duration_minutes: dur1, earliest_start: day, due_date: day, priority: "high" }),
      create({ asset_id: "A-009", required_skill: "welding", duration_minutes: dur2, earliest_start: day, due_date: day, priority: "medium" }),
    ],
    script: [
      plan(EMPTY_WEEK),
      ...observe(2),
      getSchedule(EMPTY_WEEK),
    ],
  };
};

// 25. travel-daily-cap
const buildTravelDailyCap: Builder = (rng, index) => {
  const day = rng.pick(WEEKDAYS);
  const asked = index % 2 === 0 ? 60 : 90;
  return {
    aim: `T-005 has 360m work + 60m travel = 420m on ${day}; a ${asked}m order ${asked === 60 ? "fits" : "exceeds"} 480 cap`,
    setup: [
      create({ asset_id: "A-001", required_skill: "welding", duration_minutes: 240, earliest_start: day, due_date: day, priority: "critical" }),
      create({ asset_id: "A-009", required_skill: "welding", duration_minutes: 120, earliest_start: day, due_date: day, priority: "high", crew_size: 2 }),
    ],
    script: [
      create({ asset_id: "A-001", required_skill: "welding", duration_minutes: asked, earliest_start: day, due_date: day, priority: "medium" }),
      plan(EMPTY_WEEK),
      ...observe(3),
      getSchedule(EMPTY_WEEK),
    ],
  };
};

// 26. absence-and-holiday-slots
const buildAbsenceAndHolidaySlots: Builder = (rng, index) => {
  if (index % 2 === 0) {
    return {
      aim: `T-005 is absent 09:00-11:00 on 2026-10-20; a 120m welding order at S-001 must not overlap the absence`,
      setup: [
        create({ asset_id: "A-001", required_skill: "welding", duration_minutes: 120, earliest_start: "2026-10-20", due_date: "2026-10-20", priority: "high" }),
      ],
      script: [
        plan("2026-10-19"),
        getOrder(createdId(0)),
        getSchedule("2026-10-19"),
      ],
    };
  }
  return {
    aim: `S-003 has site holiday on 2026-10-22: order due that day cannot be scheduled at S-003`,
    setup: [
      create({ asset_id: "A-009", required_skill: "welding", duration_minutes: 120, earliest_start: "2026-10-22", due_date: "2026-10-22", priority: "high" }),
    ],
    script: [
      plan("2026-10-19"),
      getOrder(createdId(0)),
      getSchedule("2026-10-19"),
    ],
  };
};

// 27. split-placement-and-key
const buildSplitPlacementAndKey: Builder = (rng, index) => {
  const dur = index % 2 === 0 ? 600 : 720;
  return {
    aim: `splittable ${dur}m order with min_segment_minutes 120 splits across 2 days under key minimization`,
    setup: [
      create({ asset_id: "A-001", required_skill: "welding", duration_minutes: dur, earliest_start: "2026-10-12", due_date: "2026-10-16", priority: "low", splittable: true, min_segment_minutes: 120 }),
    ],
    script: [
      plan(EMPTY_WEEK),
      getOrder(createdId(0)),
      getSchedule(EMPTY_WEEK),
    ],
  };
};

// 28. preemption-edf-observable
const buildPreemptionEdfObservable: Builder = (rng, index) => {
  if (index === 0 || index === 1) {
    return {
      aim: "critical order evicts only Thursday; preempt_evict_all evicts Wednesday/Tuesday/Monday as well",
      setup: [
        create({ asset_id: "A-004", required_skill: "pneumatics", duration_minutes: 240, earliest_start: "2026-10-12", due_date: "2026-10-12", priority: "low" }),
        create({ asset_id: "A-004", required_skill: "pneumatics", duration_minutes: 240, earliest_start: "2026-10-13", due_date: "2026-10-13", priority: "low" }),
        create({ asset_id: "A-004", required_skill: "pneumatics", duration_minutes: 240, earliest_start: "2026-10-14", due_date: "2026-10-14", priority: "low" }),
        create({ asset_id: "A-004", required_skill: "pneumatics", duration_minutes: 240, earliest_start: "2026-10-15", due_date: "2026-10-15", priority: "low" }),
        create({ asset_id: "A-004", required_skill: "pneumatics", duration_minutes: 240, earliest_start: "2026-10-16", due_date: "2026-10-16", priority: "medium" }),
      ],
      script: [
        create({ asset_id: "A-004", required_skill: "pneumatics", duration_minutes: 480, earliest_start: "2026-10-12", due_date: "2026-10-17", priority: "critical" }),
        plan(EMPTY_WEEK),
        getOrder(createdId(2)),
        getOrder(createdId(3)),
        getOrder(createdId(5)),
      ],
    };
  }

  if (index === 2 || index === 3) {
    return {
      aim: "unrelated technician is not evicted; preempt_unfiltered evicts unrelated order",
      setup: [
        create({ asset_id: "A-004", required_skill: "pneumatics", duration_minutes: 480, earliest_start: "2026-10-13", due_date: "2026-10-13", priority: "critical" }),
        create({ asset_id: "A-004", required_skill: "pneumatics", duration_minutes: 480, earliest_start: "2026-10-14", due_date: "2026-10-14", priority: "critical" }),
        create({ asset_id: "A-004", required_skill: "pneumatics", duration_minutes: 480, earliest_start: "2026-10-15", due_date: "2026-10-15", priority: "critical" }),
        create({ asset_id: "A-004", required_skill: "pneumatics", duration_minutes: 480, earliest_start: "2026-10-16", due_date: "2026-10-16", priority: "critical" }),
        plan(EMPTY_WEEK),
        patch(createdId(0), "in_progress"),
        patch(createdId(1), "in_progress"),
        patch(createdId(2), "in_progress"),
        patch(createdId(3), "in_progress"),
      ],
      script: [
        create({ asset_id: "A-009", required_skill: "welding", duration_minutes: 240, earliest_start: "2026-10-12", due_date: "2026-10-12", priority: "medium" }),
        create({ asset_id: "A-010", required_skill: "welding", duration_minutes: 240, earliest_start: "2026-10-12", due_date: "2026-10-13", priority: "low" }),
        create({ asset_id: "A-004", required_skill: "pneumatics", duration_minutes: 480, earliest_start: "2026-10-12", due_date: "2026-10-17", priority: "critical" }),
        plan(EMPTY_WEEK),
        getOrder(createdId(5)),
        getOrder(createdId(4)),
        getOrder(createdId(6)),
      ],
    };
  }

  if (index === 4 || index === 5) {
    return {
      aim: "critical with insufficient parts evicts nobody; preempt_parts_after evicts holder",
      setup: [
        create({ asset_id: "A-004", required_skill: "pneumatics", duration_minutes: 240, earliest_start: "2026-10-12", due_date: "2026-10-12", priority: "low" }),
        create({ asset_id: "A-004", required_skill: "pneumatics", duration_minutes: 240, earliest_start: "2026-10-13", due_date: "2026-10-13", priority: "low" }),
        create({ asset_id: "A-004", required_skill: "pneumatics", duration_minutes: 240, earliest_start: "2026-10-14", due_date: "2026-10-14", priority: "low" }),
        create({ asset_id: "A-004", required_skill: "pneumatics", duration_minutes: 240, earliest_start: "2026-10-15", due_date: "2026-10-15", priority: "low" }),
        create({ asset_id: "A-004", required_skill: "pneumatics", duration_minutes: 240, earliest_start: "2026-10-16", due_date: "2026-10-16", priority: "low", parts: [{ part_id: "P-011", quantity: 1 }] }),
      ],
      script: [
        create({ asset_id: "A-004", required_skill: "pneumatics", duration_minutes: 480, earliest_start: "2026-10-12", due_date: "2026-10-17", priority: "critical", parts: [{ part_id: "P-011", quantity: 1 }] }),
        create({ asset_id: "A-010", required_skill: "pneumatics", duration_minutes: 60, earliest_start: "2026-10-12", due_date: "2026-10-17", priority: "low", parts: [{ part_id: "P-011", quantity: 1 }] }),
        plan(EMPTY_WEEK),
        getOrder(createdId(4)),
        getOrder(createdId(5)),
        getOrder(createdId(6)),
      ],
    };
  }

  if (index === 6 || index === 7) {
    return {
      aim: "evicted low order replans on Friday; preempt_no_reprocess leaves it open",
      setup: [
        create({ asset_id: "A-004", required_skill: "pneumatics", duration_minutes: 480, earliest_start: "2026-10-13", due_date: "2026-10-13", priority: "critical" }),
        create({ asset_id: "A-004", required_skill: "pneumatics", duration_minutes: 480, earliest_start: "2026-10-14", due_date: "2026-10-14", priority: "critical" }),
        create({ asset_id: "A-004", required_skill: "pneumatics", duration_minutes: 480, earliest_start: "2026-10-15", due_date: "2026-10-15", priority: "critical" }),
        create({ asset_id: "A-004", required_skill: "pneumatics", duration_minutes: 240, earliest_start: "2026-10-16", due_date: "2026-10-16", priority: "critical" }),
        plan(EMPTY_WEEK),
        patch(createdId(0), "in_progress"),
        patch(createdId(1), "in_progress"),
        patch(createdId(2), "in_progress"),
        patch(createdId(3), "in_progress"),
      ],
      script: [
        create({ asset_id: "A-004", required_skill: "pneumatics", duration_minutes: 240, earliest_start: "2026-10-12", due_date: "2026-10-16", priority: "low" }),
        create({ asset_id: "A-004", required_skill: "pneumatics", duration_minutes: 480, earliest_start: "2026-10-12", due_date: "2026-10-17", priority: "critical" }),
        plan(EMPTY_WEEK),
        getOrder(createdId(4)),
        getOrder(createdId(5)),
        getSchedule(EMPTY_WEEK),
      ],
    };
  }

  return {
    aim: "reprocess happens after all rounds; preempt_reprocess_each_round blocks second critical",
    setup: [
      create({ asset_id: "A-004", required_skill: "pneumatics", duration_minutes: 480, earliest_start: "2026-10-13", due_date: "2026-10-13", priority: "critical" }),
      create({ asset_id: "A-004", required_skill: "pneumatics", duration_minutes: 480, earliest_start: "2026-10-14", due_date: "2026-10-14", priority: "critical" }),
      create({ asset_id: "A-004", required_skill: "pneumatics", duration_minutes: 480, earliest_start: "2026-10-15", due_date: "2026-10-15", priority: "critical" }),
      create({ asset_id: "A-004", required_skill: "pneumatics", duration_minutes: 240, earliest_start: "2026-10-16", due_date: "2026-10-16", priority: "critical" }),
      plan(EMPTY_WEEK),
      patch(createdId(0), "in_progress"),
      patch(createdId(1), "in_progress"),
      patch(createdId(2), "in_progress"),
      patch(createdId(3), "in_progress"),
    ],
    script: [
      create({ asset_id: "A-004", required_skill: "pneumatics", duration_minutes: 240, earliest_start: "2026-10-12", due_date: "2026-10-12", priority: "low" }),
      create({ asset_id: "A-004", required_skill: "pneumatics", duration_minutes: 240, earliest_start: "2026-10-16", due_date: "2026-10-16", priority: "low", parts: [{ part_id: "P-011", quantity: 1 }] }),
      create({ asset_id: "A-004", required_skill: "pneumatics", duration_minutes: 480, earliest_start: "2026-10-12", due_date: "2026-10-17", priority: "critical" }),
      create({ asset_id: "A-004", required_skill: "pneumatics", duration_minutes: 240, earliest_start: "2026-10-16", due_date: "2026-10-17", priority: "critical", parts: [{ part_id: "P-011", quantity: 1 }] }),
      create({ asset_id: "A-010", required_skill: "pneumatics", duration_minutes: 60, earliest_start: "2026-10-12", due_date: "2026-10-17", priority: "low", parts: [{ part_id: "P-011", quantity: 1 }] }),
      plan(EMPTY_WEEK),
      getOrder(createdId(7)),
      getOrder(createdId(6)),
    ],
  };
};

const buildersById: Record<string, Builder> = {
  "candidate-window-overlap": buildCandidateWindowOverlap,
  "candidate-other-week-untouched": buildCandidateOtherWeek,
  "candidate-terminal-excluded": buildCandidateTerminal,
  "bulk-reset-releases": buildBulkReset,
  "fixed-load-blocks-overlap": buildFixedBlocks,
  "fixed-load-counts-to-cap": buildFixedCounts,
  "order-by-due-date": buildOrderByDueDate,
  "order-by-priority": buildOrderByPriority,
  "order-by-id": buildOrderById,
  "parts-blocked": buildPartsBlocked,
  "parts-consumed-in-order": buildPartsConsumed,
  "parts-before-technician": buildPartsBeforeTechnician,
  "no-qualified-technician": buildNoQualified,
  "slot-grid-and-shift": buildSlotShift,
  "slot-window-clipping": buildWindowClipping,
  "daily-cap-480": buildDailyCap,
  "choice-earliest-then-lowest-id": buildChoice,
  "no-capacity": buildNoCapacity,
  "replan-determinism": buildReplanDeterminism,
  "transition-stock-effects": buildTransitionEffects,
  "crews-both-technicians": buildCrewsBothTechnicians,
  "crews-tie-breaker": buildCrewsTieBreaker,
  "multi-site-qualification": buildMultiSiteQualification,
  "travel-matrix-consecutive": buildTravelMatrixConsecutive,
  "travel-daily-cap": buildTravelDailyCap,
  "absence-and-holiday-slots": buildAbsenceAndHolidaySlots,
  "split-placement-and-key": buildSplitPlacementAndKey,
  "preemption-edf-observable": buildPreemptionEdfObservable,
};

export function generateCases(): CasesFile {
  counter = 0;
  const rng = new Rng(FUZZ_SEED);
  const cases: FuzzCase[] = [];
  for (const stratum of HARD_STRATA) {
    const build = buildersById[stratum.id];
    if (build === undefined) throw new Error(`no builder for stratum ${stratum.id}`);
    for (let i = 0; i < CASES_PER_STRATUM; i += 1) {
      cases.push({ id: nextId(), stratum: stratum.id, ...build(rng, i) });
    }
  }
  return {
    generatorVersion: GENERATOR_VERSION,
    seed: FUZZ_SEED,
    note: "Hard track differential fuzz cases (28 strata, 280 cases).",
    cases,
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = fileURLToPath(new URL("./cases.json", import.meta.url));
  writeFileSync(target, `${JSON.stringify(generateCases(), null, 2)}\n`);
  console.log(`wrote ${TOTAL_CASES} cases to ${target}`);
}
