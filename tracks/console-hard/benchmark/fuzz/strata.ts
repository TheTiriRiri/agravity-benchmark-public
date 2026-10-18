/**
 * The twenty-eight strata of the hard track differential fuzz (spec §8.4.4, §8.4.9).
 */
export interface Stratum {
  id: string;
  rule: string;
}

export const CASES_PER_STRATUM = 10;

export const HARD_STRATA: readonly Stratum[] = Object.freeze([
  { id: "candidate-window-overlap", rule: "rule 1a — a window sharing at least one day with the week" },
  { id: "candidate-other-week-untouched", rule: "rule 1a — a scheduled order in another week is left alone and keeps its reservation" },
  { id: "candidate-terminal-excluded", rule: "rule 1 — in_progress, completed and cancelled are never candidates" },
  { id: "bulk-reset-releases", rule: "rule 2 — candidates reset to open and scheduled ones release their reservations" },
  { id: "fixed-load-blocks-overlap", rule: "rule 3 — in_progress and completed slots block overlapping work" },
  { id: "fixed-load-counts-to-cap", rule: "rules 3 and 7 — fixed minutes count toward the 480 daily cap" },
  { id: "order-by-due-date", rule: "rule 4 (EDF) — earlier due_date first" },
  { id: "order-by-priority", rule: "rule 4 (EDF) — equal due_date broken by priority (critical first)" },
  { id: "order-by-id", rule: "rule 4 (EDF) — equal due_date and priority broken by id ascending" },
  { id: "parts-blocked", rule: "rule 5 — quantity above available is blocked/parts_unavailable and reserves nothing" },
  { id: "parts-consumed-in-order", rule: "rules 5 and 9 — an earlier order's reservation lowers available for later ones" },
  { id: "parts-before-technician", rule: "rule 5 before rule 6 — short of parts and unqualified is blocked, not unscheduled" },
  { id: "no-qualified-technician", rule: "rule 6 — site and skill must both match" },
  { id: "slot-grid-and-shift", rule: "rule 7 — 30-minute grid, inside the shift inclusive, never spanning two days" },
  { id: "slot-window-clipping", rule: "rule 7 — max(week_start, earliest_start) to min(Friday, due_date)" },
  { id: "daily-cap-480", rule: "rule 7 — a technician's minutes on one day never exceed 480" },
  { id: "choice-earliest-then-lowest-id", rule: "rule 8 — earliest feasible start, ties to the lower technician id" },
  { id: "no-capacity", rule: "rule 8 — no feasible slot is unscheduled/no_capacity and reserves nothing" },
  { id: "replan-determinism", rule: "rule 10 — planning the same week twice returns the identical response and stock" },
  { id: "transition-stock-effects", rule: "§4 transitions — completion consumes on_hand, cancellation releases and clears the slot" },
  { id: "crews-both-technicians", rule: "rule 8.1 — crew_size 2 requires both qualified technicians free for the full duration" },
  { id: "crews-tie-breaker", rule: "rule 8.1 — ties between crews starting at the same instant broken by lowest sorted id list" },
  { id: "multi-site-qualification", rule: "rule 6 — a technician with multiple sites qualifies at all of their sites" },
  { id: "travel-matrix-consecutive", rule: "rule 7(iii) — consecutive assignments at different sites require transit gap >= travel_minutes" },
  { id: "travel-daily-cap", rule: "rule 7(iv) — 480 daily cap counts both worked minutes and transit minutes" },
  { id: "absence-and-holiday-slots", rule: "rule 7(i)-(ii) — slots overlapping absences or falling on site holidays are rejected" },
  { id: "split-placement-and-key", rule: "rule 8.2 — splitting only when unsplit impossible, minimizing (k, s1, ids, -l1, ...)" },
  { id: "preemption-edf-observable", rule: "rule 11 — critical order evicts shortest prefix of lower priority victims under EDF" },
]);

export const TOTAL_CASES = HARD_STRATA.length * CASES_PER_STRATUM;
