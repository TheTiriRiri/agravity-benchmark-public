/**
 * The seeded case generator. `npm run fuzz:generate` writes cases.json; the
 * test suite regenerates in memory and compares, so a drifted file fails
 * `npm test` rather than surfacing at score time.
 *
 * Every world is built through the API (the plan's decision 2): the entities
 * are always the seed's, and `available` is lowered only by a scheduled order's
 * reservation — in a week other than the one under test where a case needs
 * stock shaped, never inside it. No endpoint sets stock.
 */
import { Rng } from "./rng";
import type { CasesFile, FuzzCase, Step } from "./case";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CASES_PER_STRATUM, STRATA, TOTAL_CASES } from "./strata";

export const FUZZ_SEED = 20260921;
export const GENERATOR_VERSION = 1;

/** A week no seeded order's window reaches, so only generated orders are candidates. */
const EMPTY_WEEK = "2026-10-12";
const WEEKDAYS = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"] as const;
const PRIORITIES = ["critical", "high", "medium", "low"] as const;
/**
 * The seed's technicians, verbatim — copy this from benchmark/context/seed.json
 * and check it against the file, do not retype it. Revision 1 of this plan had
 * T-002's skills wrong and omitted T-004 entirely, and every builder that
 * reasoned from that table reasoned about qualification incorrectly.
 *
 * The shift lengths matter as much as the skills: T-002, T-003 and T-004 work
 * exactly 480 minutes, which is the daily cap, so on those three the cap and
 * the end of the shift are indistinguishable. **T-001 is the only technician
 * on whom rule 7's cap can be observed at all** (600 minutes of shift).
 */
export const TECHNICIANS = [
  { id: "T-001", site: "S-001", skills: ["electrical", "instrumentation"], shift: ["07:00", "17:00"], minutes: 600 },
  { id: "T-002", site: "S-001", skills: ["electrical", "mechanical"], shift: ["08:00", "16:00"], minutes: 480 },
  { id: "T-003", site: "S-002", skills: ["hydraulics", "mechanical"], shift: ["08:00", "16:00"], minutes: 480 },
  { id: "T-004", site: "S-002", skills: ["mechanical"], shift: ["06:00", "14:00"], minutes: 480 },
] as const;

/**
 * Durations are always drawn as a count of 30-minute slots and multiplied.
 * `duration_minutes` is validated `ge=30, le=480, multiple_of=30`, so any other
 * way of drawing one produces a 422, the order is never created, and — because
 * setup replies are discarded — the whole case silently shifts by one WO id.
 * Revision 1 lost an entire stratum to exactly this.
 */
const slots = (rng: Rng, minSlots: number, maxSlots: number): number => rng.int(minSlots, maxSlots) * 30;

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
}

const create = (spec: OrderSpec): Step => ({
  method: "POST",
  path: "/work-orders",
  body: { title: `fuzz ${spec.required_skill} ${spec.duration_minutes}`, ...spec },
});

/**
 * The ids the seed assigns to orders created after it. The seed ends at
 * WO-014, so the first created order is WO-015. Every builder knows how many
 * orders it creates, so it knows their ids without asking the server — which
 * is what lets a case be a flat list of calls rather than a program.
 */
const createdId = (index: number): string => `WO-${String(15 + index).padStart(3, "0")}`;

/**
 * The technicians on whom a skill at a site is held by exactly one person —
 * decision 7's "one qualified technician". Derived from the table above and
 * asserted against benchmark/context/seed.json by test/fuzz-cases.test.ts, so
 * a builder that reasons from it cannot reason from a stale copy. `minutes` is
 * the shift length: the two 480-minute technicians are the ones on whom the
 * daily cap and the end of the shift are the same wall.
 */
export const SOLE = [
  { tech: "T-001", skill: "instrumentation", assets: ["A-001", "A-002", "A-003", "A-004"], minutes: 600 },
  { tech: "T-002", skill: "mechanical", assets: ["A-001", "A-002", "A-003", "A-004"], minutes: 480 },
  { tech: "T-003", skill: "hydraulics", assets: ["A-005", "A-006", "A-007", "A-008"], minutes: 480 },
] as const;
const SOLE_480 = SOLE.filter((s) => s.minutes === 480);

/**
 * `available` for every seeded part (on_hand - reserved), so a builder can ask
 * for exactly that many, or one more. Asserted against the seed by the same test.
 */
export const STOCK = [
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
] as const;
/** Stock a case can draw from without ever coming near the end of it. */
const PLENTIFUL = STOCK.filter((p) => p.available >= 5);
const AT_LEAST_THREE = STOCK.filter((p) => p.available >= 3);
const AT_LEAST_TWO = STOCK.filter((p) => p.available >= 2);

/** Weeks after the one under test. No seeded order's window reaches either. */
const OTHER_WEEKS = [
  { monday: "2026-10-19", days: ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"] },
  { monday: "2026-10-26", days: ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"] },
] as const;

const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const NOT_CRITICAL = ["high", "medium", "low"] as const;

/** Windows against the test week Mon 2026-10-12 … Fri 2026-10-16 (rule 1a). */
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

/**
 * Orders nobody is qualified for: the skill exists in the company and the site
 * has technicians, just not the two together (rule 6).
 */
const UNQUALIFIED = [
  { assets: ["A-001", "A-002", "A-003", "A-004"], skill: "hydraulics" },
  { assets: ["A-005", "A-006", "A-007", "A-008"], skill: "electrical" },
  { assets: ["A-005", "A-006", "A-007", "A-008"], skill: "instrumentation" },
] as const;

/** A count of 30-minute slots as minutes: the grid, written down once. */
const minutes = (slotCount: number): number => slotCount * 30;

/** The orders of one case that carry ids: `WO-015` onwards, in creation order. */
const observe = (count: number, from = 0): Step[] =>
  Array.from({ length: count }, (_, i) => getOrder(createdId(from + i)));

/**
 * `index` is the case's position inside its stratum, 0 to CASES_PER_STRATUM - 1.
 * A builder that has variants uses it to give every variant a share of the ten
 * cases, instead of leaving that to the dice: a variant that is never drawn is a
 * rule that is never asked about.
 */
type Builder = (rng: Rng, index: number) => Omit<FuzzCase, "id" | "stratum">;

const buildDailyCap: Builder = (rng, index) => {
  // T-001 is the only technician whose shift (600 min) is longer than the cap
  // (480), so it is the only one on whom the cap can be told apart from the end
  // of the shift. `instrumentation` at site S-001 qualifies T-001 and nobody
  // else — `electrical` would also qualify T-002 and drag rule 8's tie-break
  // into a stratum that is supposed to measure rule 7 (decision 7).
  //
  // Fill the day to `filled`, then ask for a job that either exactly reaches
  // 480 or exactly passes it. Both sides of the boundary are generated, so a
  // backend using `<` where it needs `<=` fails half the stratum, not none.
  //
  // The setup does NOT plan. Revision 2's did, which left the filler
  // `scheduled` in the test week, so the script's plan hit rule 2's bulk reset
  // and re-planned it — and a backend that mishandles re-planning a scheduled
  // candidate failed a stratum about rule 7. Both orders are simply created;
  // the filler is processed first by rule 4 (critical before low).
  //
  // One non-trivial dependency is irreducible and is recorded so triage does
  // not read it as contamination: loading a day requires an assignment, so the
  // "fits" half also needs correct overlap (rule 7) and earliest-start choice
  // (rule 8). Expect `overlap_allowed` to show against this stratum in gate
  // P2-B's table. That is the minimal regime, not a defect.
  const filled = slots(rng, 10, 14); // 300 … 420 minutes, always on the grid
  const slack = 480 - filled;
  // Split on the index, not the dice: the coin gave three "over" cases out of
  // ten when this was measured, so `cap_off` — the one mutant this stratum
  // exists to catch — failed three cases where it should fail five.
  const asked = index % 2 === 0 ? slack : slack + 30;
  const day = rng.pick(WEEKDAYS);
  return {
    aim: `T-001 is loaded to ${filled} minutes on ${day}; a ${asked}-minute job ${asked <= slack ? "exactly reaches" : "exactly passes"} the 480 cap inside a 600-minute shift`,
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

const buildPartsBeforeTechnician: Builder = (rng) => {
  // An order that is both short of parts and unqualified must come back
  // `blocked`, not `unscheduled`: rule 5 is checked before rule 6. The two
  // wrong orderings are indistinguishable on any case that breaks only one.
  const quantity = rng.int(50, 99); // far above any seeded on_hand
  const part = rng.pick(["P-001", "P-002", "P-005"]);
  return {
    aim: `an order short of ${part} and with no qualified technician must be blocked, not unscheduled`,
    setup: [],
    script: [
      create({
        // A real skill at the wrong site, never an invented one. `welding` —
        // revision 2's choice — risks a 422 from a backend that validates
        // required_skill against the technicians it knows, and that failure
        // would be charged to rules 5/6 instead of to the API row. The hidden
        // planner-parts.test.ts:63 uses exactly this shape: `electrical` on
        // A-005, at the site where no electrician works.
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

const buildReplanDeterminism: Builder = (rng) => {
  // Rule 10 verbatim: the same week planned twice is the identical response and
  // the identical stock. That is a statement about the backend against itself,
  // so it is carried by `invariants` and compared inside the run (decision 9).
  // Comparing these four replies to the oracle instead — which is what revision
  // 1 did — charges every rule-4-to-9 defect to this stratum, because a
  // backend that plans differently from the reference but identically twice is
  // perfectly deterministic and would still score zero here.
  const count = rng.int(2, 5);
  const setup = Array.from({ length: count }, (_, i) =>
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
    aim: `${count} orders planned twice in a row must give identical replies and identical stock`,
    setup,
    script: [plan(EMPTY_WEEK), getParts(), plan(EMPTY_WEEK), getParts()],
    // Step 1 vs step 3 (the two plans) and step 2 vs step 4 (the stock).
    invariants: [
      { kind: "steps-equal", a: 0, b: 2 },
      { kind: "steps-equal", a: 1, b: 3 },
    ],
    // Rule 10 only. What this backend plans is rules 4-9's business and is
    // measured by their own strata.
    oracle: false,
  };
};

// ---------------------------------------------------------------------------
// The other seventeen. Each aims at the rule quoted in STRATA[i].rule and puts
// every other rule in decision 7's trivial regime where it can: one qualified
// technician (`SOLE`), one day, a start at the shift's beginning, durations far
// from the cap, parts in plentiful supply. Where a stratum cannot be written
// that way, the comment says what is irreducible.
//
// No builder predicts an answer, and none draws a duration except through
// `slots`.
// ---------------------------------------------------------------------------

const buildCandidateWindowOverlap: Builder = (rng) => {
  // Rule 1a is decided by the window alone, and the answer has to be readable
  // without a slot: a candidate with a slot would drag in the window's clipping
  // (rule 7), the order of processing and the choice of technician. So every
  // order here is one nobody is qualified for — a candidate comes back
  // `unscheduled`, a non-candidate is still `open` — and the only thing that
  // varies is where the window sits against Monday 12 … Friday 16. Weekends
  // count as no day of the week: a window that is only Saturday and Sunday
  // shares nothing with it. (Rule 6 is the one dependency, and every stratum
  // that schedules anything has it.)
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

const buildCandidateOtherWeek: Builder = (rng) => {
  // The held order is scheduled by a plan of a *different* week, in setup, so
  // its reservation is real and its slot is fixed by a plan that is not the one
  // under test. The script then plans another week entirely and looks again.
  // Irreducible: the setup plan runs rules 5-9 once to get the order scheduled;
  // a backend that cannot do that fails here for a reason outside this rule,
  // but it fails every stratum that plans, and this one is not special.
  const sole = rng.pick(SOLE);
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

const buildCandidateTerminal: Builder = (rng) => {
  // Orders are driven to in_progress, completed or cancelled *before* the plan
  // under test, and the fresh order that plan is for sits on a different day,
  // so a terminal order's slot never touches it (that would be rule 3's
  // business, and has its own stratum). What the plan's `orders` list holds is
  // then the whole answer to rule 1. A cancelled order is cancelled while still
  // open, before anything is planned: cancelling a scheduled one would make the
  // stratum depend on the slot being cleared, which is §4's business.
  const sole = rng.pick(SOLE);
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

const buildBulkReset: Builder = (rng, index) => {
  // Rule 2: every candidate is reset before any is processed. Two ways to see
  // it, both with a newcomer that outranks what is already scheduled — on
  // priority *and* on due date, so that a backend that ignores either one, or
  // reverses the id tie-break, still processes the newcomer first and this
  // stratum stays about the reset.
  //  - reservation (even index): the newcomer needs more of a part than is free
  //    while the old order still holds its share, but no more than exists.
  //    Reset first, it is scheduled and the old order is starved; reset one at
  //    a time, the newcomer is starved instead. The two are on different days,
  //    so neither overlap nor the cap can decide anything.
  //  - slot (odd index): the newcomer takes the front of the day and the old
  //    orders move behind it, which is only possible if their old slots were
  //    released first. Their windows run one day longer than the newcomer's.
  // Irreducible: rules 4 and 5 decide who wins; they are what makes the reset
  // observable, so this is the stratum where they cannot be made trivial.
  const sole = rng.pick(SOLE);
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

const buildFixedBlocks: Builder = (rng) => {
  // Rule 3, overlap half: one or two orders are scheduled and then started or
  // finished; a new order for the same day must go around them. Every duration
  // is small, so the cap (the other half of rule 3) stays out of it.
  const sole = rng.pick(SOLE);
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

const buildFixedCounts: Builder = (rng, index) => {
  // Rule 3, cap half, on the one technician whose shift (600) is longer than
  // the cap (480). A fixed order takes `filled` minutes of the day; the new one
  // asks for exactly what is left, or one grid step more. Half the cases leave
  // the window open to the next weekday.
  const t001 = SOLE[0];
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
    aim: `a ${finished ? "completed" : "in_progress"} order fixes ${filled} minutes of ${day}; a ${asked}-minute order asks for the rest of the cap${asked > slack ? " and one step more" : ""}${due === day ? "" : ", with the next weekday open to it"}`,
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

const buildOrderByPriority: Builder = (rng) => {
  // Same day, same window, same technician; only the priority differs. The
  // creation order is drawn until it is *not* the priority order, so an
  // implementation that falls back to id order is separated from one that sorts.
  const sole = rng.pick(SOLE);
  const day = rng.pick(WEEKDAYS);
  const chosen = rng.shuffled(PRIORITIES).slice(0, rng.int(3, 4));
  const ranked = [...chosen].sort((a, b) => (PRIORITY_RANK[a] as number) - (PRIORITY_RANK[b] as number));
  let created = rng.shuffled(chosen);
  while (created.every((p, i) => p === ranked[i])) created = rng.shuffled(chosen);
  return {
    aim: `${created.length} orders for one day, created in the order ${created.join(", ")}`,
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

const buildOrderByDueDate: Builder = (rng) => {
  // Equal priority; every window opens on Monday and closes on a different
  // day, so every order wants Monday's first slot and only the due date says
  // who gets it. Creation order is drawn until it is not the due-date order.
  const sole = rng.pick(SOLE);
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

const buildOrderById: Builder = (rng) => {
  // Equal priority, equal window, different durations: nothing but the id
  // distinguishes the orders, and the durations make their positions visible.
  const sole = rng.pick(SOLE);
  const priority = rng.pick(PRIORITIES);
  const first = rng.int(0, 2);
  const last = rng.int(first, 4);
  const count = rng.int(3, 5);
  return {
    aim: `${count} ${priority} orders with one window (${WEEKDAYS[first]} to ${WEEKDAYS[last]}) and nothing else to tell them apart`,
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

const buildPartsBlocked: Builder = (rng) => {
  // Rule 5, both sides of the boundary in one case: one order asks for exactly
  // what is available and one for more, on different days so that nothing but
  // the stock can tell them apart. Half the time the short order also lists a
  // part that is in plentiful supply, to show that a blocked order reserves
  // *nothing*, not just the part that was short.
  const sole = rng.pick(SOLE);
  const [dayA, dayB] = rng.shuffled(WEEKDAYS);
  const [fits, short] = rng.shuffled(STOCK);
  const spare = rng.pick(STOCK.filter((p) => p.id !== fits.id && p.id !== short.id));
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
    aim: `one order asks for all ${fits.available} of ${fits.id}, another for more than ${short.id} has${withSpare ? ` and also lists ${spare.id}` : ""}`,
    setup: specs.map(create),
    script: [plan(EMPTY_WEEK), ...observe(2), getParts()],
  };
};

const buildPartsConsumed: Builder = (rng) => {
  // Rule 9: what an earlier order reserves is gone for the later ones. Two or
  // three orders share one part; priorities are distinct, the orders are
  // created in priority order and their days run forward with it, so the
  // processing order is the id order is the due-date order is the priority
  // order, and a backend that gets rule 4 wrong still agrees. They sit on
  // different days, so nothing but the stock can tell them apart. The first
  // takes any amount that exists; the second asks for more than what is left;
  // the third, when there is one, may or may not fit in what the second did
  // not take.
  const sole = rng.pick(SOLE);
  const part = rng.pick(AT_LEAST_TWO);
  const count = rng.int(2, 3);
  const days = rng.shuffled(WEEKDAYS).slice(0, count).sort();
  const first = rng.int(1, part.available);
  const quantities = [first, rng.int(part.available - first + 1, part.available), rng.int(1, part.available)].slice(0, count);
  return {
    aim: `${count} orders of falling priority share ${part.id} (${part.available} available): quantities in processing order ${quantities.join(", ")}`,
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

const buildNoQualified: Builder = (rng) => {
  // Rule 6: site and skill must both match. Each unqualified order has a skill
  // that exists somewhere in the company and a site that has technicians, just
  // not the two together, so neither half of the rule can be skipped without
  // the order finding someone. One qualified order rides along as the control.
  const sole = rng.pick(SOLE);
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
    aim: `${bad.length} order(s) whose skill is held only at the other site, beside one that is qualified: ${bad.map((u) => u.skill).join(", ")}`,
    setup: specs.map(create),
    script: [plan(EMPTY_WEEK), ...observe(specs.length), getSchedule(EMPTY_WEEK)],
  };
};

const buildSlotShift: Builder = (rng, index) => {
  // Rule 7's shift boundary, on a 480-minute technician, where the shift and
  // the cap coincide — so the boundary is only ever reached through a gap.
  // A short order F1 and a longer one B are scheduled back to back; B is
  // started and F1 cancelled, leaving F1's minutes empty at the front of the
  // day, a fixed block behind them, and `tail` minutes after it. The new order
  // asks for exactly the tail (ends on the shift's last minute, inclusive) or
  // one grid step more (would end after the shift, although the cap still
  // allows it). Half the time the next weekday is open to it.
  // Irreducible: B's block is fixed load (rule 3), and it is what makes the
  // shift's end reachable at all.
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
    aim: `${sole.tech}: ${f1} free minutes then a fixed ${b}-minute block leave ${tail} to the end of the shift; a ${asked}-minute order asks for ${asked === tail ? "exactly that" : "one step more"}`,
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

const buildWindowClipping: Builder = (rng, index) => {
  // Rule 7's window: max(week_start, earliest_start) to min(Friday, due_date).
  //  - start: an order whose earliest_start is before the week (a weekday of
  //    the week before, or its weekend) must land inside the week.
  //  - end: an order whose window runs on after Friday, with Friday itself
  //    already full, must not spill into the weekend or the week after. The
  //    full Friday is a fixed 480-minute order, so this variant needs a
  //    480-minute technician. Irreducible: it pulls in rule 3 to be possible.
  const variant = index % 3;
  if (variant < 2) {
    const sole = rng.pick(SOLE);
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
      aim: `an order opening on ${before}, before the week, due ${WEEKDAYS[dueIndex]}, beside one that opens inside the week`,
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
    aim: `${sole.tech}'s Friday is full; an order opening that Friday runs on to ${later}, past the end of the week`,
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

const buildChoice: Builder = (rng, index) => {
  // Rule 8 needs two qualified technicians — that much is irreducible — and a
  // tie needs one of them to be busy until exactly the other's shift begins.
  // So a first, more urgent order is placed with whoever is earliest, and the
  // second order then finds the two of them free at different instants, or at
  // the same one. The first order's length decides which of the three it is;
  // six cases in ten are the tie, because that is the half of the rule that
  // only a tie can show.
  //  - S-001, electrical (even index): T-001 (07:00) or T-002 (08:00). The
  //    first order is instrumentation, which only T-001 holds, so T-001 is busy
  //    for exactly its length and T-002 is untouched.
  //  - S-002, mechanical (odd index): T-004 (06:00) or T-003 (08:00). The first
  //    order is mechanical too and lands on T-004, who is earlier.
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
      aim: `T-001 is busy for ${busy} minutes from 07:00; an electrical order can go to T-001 or to T-002, who starts at 08:00`,
      setup: [
        create(spec(rng.pick(["A-001", "A-002", "A-003", "A-004"]), "instrumentation", busy, "critical")),
        create(spec(rng.pick(["A-001", "A-002", "A-003", "A-004"]), "electrical", slots(rng, 1, 3), "medium")),
      ],
      script: [plan(EMPTY_WEEK), ...observe(2), getSchedule(EMPTY_WEEK)],
    };
  }
  const busy = tie ? minutes(4) : minutes(rng.pick([3, 5]));
  return {
    aim: `T-004 takes a ${busy}-minute mechanical order from 06:00; a second mechanical order can go to T-004 or to T-003, who starts at 08:00`,
    setup: [
      create(spec(rng.pick(["A-005", "A-006", "A-007", "A-008"]), "mechanical", busy, "critical")),
      create(spec(rng.pick(["A-005", "A-006", "A-007", "A-008"]), "mechanical", slots(rng, 1, 3), "medium")),
    ],
    script: [plan(EMPTY_WEEK), ...observe(2), getSchedule(EMPTY_WEEK)],
  };
};

const buildNoCapacity: Builder = (rng) => {
  // Rule 8's other branch: more work for one day than the day holds. On a
  // 480-minute technician the day is 480 minutes whichever wall you call it,
  // so orders are drawn until their total exceeds it, and each carries a unit
  // of a plentiful part so that "reserves nothing" is visible in the stock.
  // Priorities fall strictly in id order, so the order the orders are processed
  // in is the same whatever a backend does with rule 4's tie-breaks.
  const sole = rng.pick(SOLE_480);
  const day = rng.pick(WEEKDAYS);
  let durations: number[] = [];
  do {
    durations = Array.from({ length: rng.int(3, 4) }, () => slots(rng, 4, 8));
  } while (durations.reduce((sum, d) => sum + d, 0) <= 480);
  return {
    aim: `${sole.tech} is asked for ${durations.reduce((sum, d) => sum + d, 0)} minutes on ${day}: ${durations.join(", ")}`,
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

const buildTransitionEffects: Builder = (rng, index) => {
  // §4's transitions, one lifecycle per case. Quantities above one, so that
  // `-= quantity` and `-= 1` are told apart; two lines about half the time. The
  // lifecycle is the index within the stratum, so every one of the six is drawn
  // at least once in ten cases rather than left to the dice.
  const sole = rng.pick(SOLE);
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

const buildersById: Record<string, Builder> = {
  "candidate-window-overlap": buildCandidateWindowOverlap,
  "candidate-other-week-untouched": buildCandidateOtherWeek,
  "candidate-terminal-excluded": buildCandidateTerminal,
  "bulk-reset-releases": buildBulkReset,
  "fixed-load-blocks-overlap": buildFixedBlocks,
  "fixed-load-counts-to-cap": buildFixedCounts,
  "order-by-priority": buildOrderByPriority,
  "order-by-due-date": buildOrderByDueDate,
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
};

export function generateCases(): CasesFile {
  counter = 0;
  const rng = new Rng(FUZZ_SEED);
  const cases: FuzzCase[] = [];
  for (const stratum of STRATA) {
    const build = buildersById[stratum.id];
    if (build === undefined) throw new Error(`no builder for stratum ${stratum.id}`);
    for (let i = 0; i < CASES_PER_STRATUM; i += 1) {
      cases.push({ id: nextId(), stratum: stratum.id, ...build(rng, i) });
    }
  }
  return {
    generatorVersion: GENERATOR_VERSION,
    seed: FUZZ_SEED,
    note: "Worlds are built through the API only. The entities are the seed's; `available` is lowered by a scheduled order's reservation in another week, never by shaping inside the week under test; and cases use one to five orders, and one week except where a stratum is about another week being left alone, rather than §6.2's four to twelve orders and one or two weeks. See the P2 plan, decisions 2 and 7.",
    cases,
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = fileURLToPath(new URL("./cases.json", import.meta.url));
  writeFileSync(target, `${JSON.stringify(generateCases(), null, 2)}\n`);
  console.log(`wrote ${TOTAL_CASES} cases to ${target}`);
}
