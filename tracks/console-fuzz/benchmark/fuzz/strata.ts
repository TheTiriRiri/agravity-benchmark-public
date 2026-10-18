/**
 * The twenty strata. Spec §6.3 scores the stratum mean, so a stratum is the
 * unit of both scoring and triage: a bug's cost is set by which rule it breaks,
 * not by how often the generator happened to exercise that rule.
 *
 * Each id doubles as the first half of a test name (decision 1), so ids are
 * kebab-case and free of `/`.
 */
export interface Stratum {
  id: string;
  /** The planner rule (prompt.md §5) or contract clause this stratum aims at. */
  rule: string;
}

export const CASES_PER_STRATUM = 10;

export const STRATA: readonly Stratum[] = Object.freeze([
  { id: "candidate-window-overlap", rule: "rule 1a — a window sharing at least one day with the week" },
  { id: "candidate-other-week-untouched", rule: "rule 1a — a scheduled order in another week is left alone and keeps its reservation" },
  { id: "candidate-terminal-excluded", rule: "rule 1 — in_progress, completed and cancelled are never candidates" },
  { id: "bulk-reset-releases", rule: "rule 2 — candidates reset to open and scheduled ones release their reservations" },
  { id: "fixed-load-blocks-overlap", rule: "rule 3 — in_progress and completed slots block overlapping work" },
  { id: "fixed-load-counts-to-cap", rule: "rules 3 and 7 — fixed minutes count toward the 480 daily cap" },
  { id: "order-by-priority", rule: "rule 4 — critical first" },
  { id: "order-by-due-date", rule: "rule 4 — equal priority broken by earlier due_date" },
  { id: "order-by-id", rule: "rule 4 — equal priority and due_date broken by id" },
  { id: "parts-blocked", rule: "rule 5 — quantity above available is blocked/parts_unavailable and reserves nothing" },
  { id: "parts-consumed-in-order", rule: "rules 5 and 9 — an earlier order's reservation lowers available for later ones" },
  { id: "parts-before-technician", rule: "rule 5 before rule 6 — short of parts *and* unqualified is blocked, not unscheduled" },
  { id: "no-qualified-technician", rule: "rule 6 — site and skill must both match" },
  { id: "slot-grid-and-shift", rule: "rule 7 — 30-minute grid, inside the shift inclusive, never spanning two days" },
  { id: "slot-window-clipping", rule: "rule 7 — max(week_start, earliest_start) to min(Friday, due_date)" },
  { id: "daily-cap-480", rule: "rule 7 — a technician's minutes on one day never exceed 480" },
  { id: "choice-earliest-then-lowest-id", rule: "rule 8 — earliest feasible start, ties to the lower technician id" },
  { id: "no-capacity", rule: "rule 8 — no feasible slot is unscheduled/no_capacity and reserves nothing" },
  { id: "replan-determinism", rule: "rule 10 — planning the same week twice returns the identical response and stock" },
  { id: "transition-stock-effects", rule: "§4 transitions — completion consumes on_hand, cancellation releases and clears the slot" },
]);

export const TOTAL_CASES = STRATA.length * CASES_PER_STRATUM;
