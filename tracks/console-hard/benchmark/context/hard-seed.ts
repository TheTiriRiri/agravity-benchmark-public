/**
 * The hard seed (spec §8.4.2, §8.4.6), built from the classic seed so the two
 * cannot drift: every classic entity keeps its id and attributes, reshaped;
 * everything added carries an id after the classic ones.
 *
 *   npm run hard-seed:write   # rewrites seed.json next to this file
 *
 * `test/hard-seed.test.ts` pins the committed seed.json to `buildHardSeed()`
 * of the committed classic seed, byte for byte.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const HARD_SCHEMA = "console-hard/1";

const CLASSIC_SEED = new URL("../../../../benchmark/context/seed.json", import.meta.url);
export const HARD_SEED = new URL("./seed.json", import.meta.url);

/** Symmetric, zero on the diagonal, multiples of 30, and the triangle inequality holds (60 <= 30 + 60). */
const TRAVEL: Record<string, number> = { "S-001|S-002": 60, "S-001|S-003": 30, "S-002|S-003": 60 };
const HOLIDAYS: Record<string, string[]> = { "S-001": [], "S-002": [], "S-003": ["2026-10-08", "2026-10-22"] };

const NEW_SITES = [{ id: "S-003", name: "Ridge Depot" }];
const NEW_ASSETS = [
  { id: "A-009", name: "Kiln Line", site_id: "S-003" },
  { id: "A-010", name: "Boiler House", site_id: "S-003" },
];
/**
 * The only holders of the two hard skills, so a classic world a ported test
 * builds keeps exactly its technicians. T-005's ten-hour shift over two sites
 * is what lets rule 7(iv) bite (spec §8.4.2).
 */
const NEW_TECHNICIANS = [
  {
    id: "T-005", name: "Emeka Varga", site_ids: ["S-001", "S-003"], skills: ["pneumatics", "welding"], shift_start: "07:00", shift_end: "17:00",
    absences: [{ date: "2026-10-06", from: "10:00", to: "12:00" }, { date: "2026-10-20", from: "09:00", to: "11:00" }],
  },
  {
    id: "T-006", name: "Freya Holm", site_ids: ["S-002", "S-003"], skills: ["pneumatics"], shift_start: "08:00", shift_end: "16:00",
    absences: [{ date: "2026-10-21", from: "12:00", to: "14:00" }],
  },
  { id: "T-007", name: "Goran Petit", site_ids: ["S-003"], skills: ["pneumatics", "welding"], shift_start: "08:00", shift_end: "16:00", absences: [] },
];
const NEW_PARTS = [
  { id: "P-011", name: "Solenoid valve", on_hand: 2, reserved: 0, min_stock: 1 },
  { id: "P-012", name: "Welding rod pack", on_hand: 3, reserved: 0, min_stock: 1 },
];

type OrderInput = {
  id: string; title: string; asset_id: string; required_skill: string; duration_minutes: number;
  earliest_start: string; due_date: string; priority: string;
  parts?: { part_id: string; quantity: number }[]; crew_size?: number; splittable?: boolean; min_segment_minutes?: number;
};

/**
 * The seed week's hard orders. Each `off_*` switch changes at least two of the
 * week's orders (gate P4-B), measured on the reference:
 *   crews      WO-017 needs T-005 and T-007 together
 *   travel     T-005 goes S-001 -> S-003 on Monday (WO-015, WO-017) and WO-016 cannot come back:
 *              work 480 but work plus travel 540, the rule 7(iv) day
 *   absences   T-005 is away Tuesday 10:00-12:00, which pushes WO-018 to 12:00 and lets WO-016 in first
 *   holidays   S-003 is closed Thursday: WO-019 and WO-020 move to Friday
 *   splitting  WO-021 and WO-022 fit no single day
 *   preemption WO-023 is critical and due Saturday; low WO-024 and WO-025, due earlier, take its days under EDF
 */
const NEW_ORDERS: OrderInput[] = [
  { id: "WO-015", title: "Weld conveyor guard", asset_id: "A-001", required_skill: "welding", duration_minutes: 240, earliest_start: "2026-10-05", due_date: "2026-10-05", priority: "high" },
  { id: "WO-016", title: "Weld robot base plate", asset_id: "A-002", required_skill: "welding", duration_minutes: 120, earliest_start: "2026-10-05", due_date: "2026-10-06", priority: "medium" },
  { id: "WO-017", title: "Reline kiln burner", asset_id: "A-009", required_skill: "welding", duration_minutes: 120, earliest_start: "2026-10-05", due_date: "2026-10-05", priority: "medium", crew_size: 2 },
  { id: "WO-018", title: "Weld compressor frame", asset_id: "A-003", required_skill: "welding", duration_minutes: 240, earliest_start: "2026-10-06", due_date: "2026-10-06", priority: "high" },
  { id: "WO-019", title: "Service boiler actuators", asset_id: "A-010", required_skill: "pneumatics", duration_minutes: 180, earliest_start: "2026-10-08", due_date: "2026-10-09", priority: "medium", parts: [{ part_id: "P-011", quantity: 1 }] },
  { id: "WO-020", title: "Check boiler valves", asset_id: "A-010", required_skill: "pneumatics", duration_minutes: 180, earliest_start: "2026-10-08", due_date: "2026-10-09", priority: "low" },
  { id: "WO-021", title: "Rebuild kiln shell", asset_id: "A-009", required_skill: "welding", duration_minutes: 720, earliest_start: "2026-10-05", due_date: "2026-10-09", priority: "low", splittable: true, min_segment_minutes: 120, parts: [{ part_id: "P-012", quantity: 2 }] },
  { id: "WO-022", title: "Overhaul boiler air lines", asset_id: "A-010", required_skill: "pneumatics", duration_minutes: 600, earliest_start: "2026-10-05", due_date: "2026-10-09", priority: "low", splittable: true, min_segment_minutes: 120 },
  { id: "WO-023", title: "Replace cabinet air supply", asset_id: "A-004", required_skill: "pneumatics", duration_minutes: 480, earliest_start: "2026-10-05", due_date: "2026-10-10", priority: "critical" },
  { id: "WO-024", title: "Inspect compressor pneumatics", asset_id: "A-003", required_skill: "pneumatics", duration_minutes: 240, earliest_start: "2026-10-07", due_date: "2026-10-07", priority: "low" },
  { id: "WO-025", title: "Inspect cabinet pneumatics", asset_id: "A-004", required_skill: "pneumatics", duration_minutes: 240, earliest_start: "2026-10-08", due_date: "2026-10-08", priority: "low" },
];

const travel = (a: string, b: string) => (a === b ? 0 : TRAVEL[[a, b].sort().join("|")]);

export function buildHardSeed(classic: any): Record<string, unknown> {
  const sites = [...classic.sites, ...NEW_SITES];
  const ids = sites.map((s: { id: string }) => s.id);
  return {
    schema: HARD_SCHEMA,
    sites: sites.map((s: { id: string; name: string }) => ({
      ...s,
      holidays: HOLIDAYS[s.id],
      travel_minutes: Object.fromEntries(ids.map((other: string) => [other, travel(s.id, other)])),
    })),
    assets: [...classic.assets, ...NEW_ASSETS],
    technicians: [
      ...classic.technicians.map(({ site_id, ...t }: any) => ({
        id: t.id, name: t.name, site_ids: [site_id], skills: t.skills, shift_start: t.shift_start, shift_end: t.shift_end, absences: [],
      })),
      ...NEW_TECHNICIANS,
    ],
    parts: [...classic.parts, ...NEW_PARTS],
    work_orders: [
      ...classic.work_orders.map(({ technician_id, scheduled_start, scheduled_end, status, status_reason, ...o }: any) => ({
        ...o, crew_size: 1, splittable: false, min_segment_minutes: null, status, status_reason,
        technician_ids: technician_id === null ? [] : [technician_id],
        segments: scheduled_start === null ? [] : [{ start: scheduled_start, end: scheduled_end }],
      })),
      ...NEW_ORDERS.map(({ parts = [], crew_size = 1, splittable = false, min_segment_minutes, ...o }) => ({
        ...o, parts, crew_size, splittable, min_segment_minutes: min_segment_minutes ?? null,
        status: "open", status_reason: null, technician_ids: [], segments: [],
      })),
    ],
  };
}

/** The classic seed's formatting: one-space indent and a trailing newline. */
export function renderHardSeed(): string {
  return `${JSON.stringify(buildHardSeed(JSON.parse(readFileSync(CLASSIC_SEED, "utf8"))), null, 1)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes("--write")) throw new Error("usage: hard-seed.ts --write");
  writeFileSync(HARD_SEED, renderHardSeed());
}
