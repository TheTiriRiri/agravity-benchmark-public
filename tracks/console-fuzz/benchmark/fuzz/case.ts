/**
 * The shapes of a fuzz case. Both the oracle (scripts/fuzz-gate.ts) and the
 * replay (fuzz.test.ts) read these, so they live apart from the generator.
 *
 * A `Step` is one HTTP call. `POST /reset` is not a step: every case begins
 * with one, implicitly, so a case cannot inherit another's state.
 */
// Deliberately not `(typeof STRATA)[number]["id"]`: `STRATA` is annotated
// `readonly Stratum[]` with `id: string`, so that form collapses to `string`
// and checks nothing — a type that looks like a union and silently accepts a
// typo is worse than none. The runtime check in test/fuzz-cases.test.ts ("a
// case carries a stratum that is not in STRATA") is what actually holds the
// ids together; `stratum` below is a plain string because cases.json is parsed
// JSON either way.

export interface Step {
  method: "GET" | "POST" | "PATCH";
  /** Path under /api/v1, e.g. "/work-orders" or "/plan?week_start=2026-10-05". */
  path: string;
  /** Absent for GET and for POST /plan. */
  body?: unknown;
}

export interface FuzzCase {
  /** "case-0000" … "case-0199". Stable across regeneration; see the plan's decision 5. */
  id: string;
  stratum: string;
  /** One sentence, written by the stratum builder, naming the rule the case aims at. */
  aim: string;
  /** Built through the API after POST /reset; see the plan's decision 2. */
  setup: Step[];
  /** The calls whose replies are compared. */
  script: Step[];
  /**
   * Checked against this backend's own replies, not against the oracle
   * (decision 9). Absent on most cases; rule 10's stratum is what it exists
   * for. `a` and `b` are zero-based indices into `script`.
   */
  invariants?: { kind: "steps-equal"; a: number; b: number }[];
  /**
   * `false` suppresses the oracle comparison for this case, leaving only
   * `invariants`. Default `true`. A case that says what the backend must agree
   * with *itself* about has no business also demanding it agree with the
   * reference — that would charge every rule-4-to-9 defect to rule 10's
   * stratum.
   */
  oracle?: boolean;
}

export interface CasesFile {
  /** Bumped by hand when the generator's output changes on purpose. */
  generatorVersion: number;
  seed: number;
  /** Recorded so a reader of the file alone knows how the world is built. */
  note: string;
  cases: FuzzCase[];
}

export interface StepReply {
  status: number;
  body: unknown;
}

export interface ExpectedFile {
  generatorVersion: number;
  seed: number;
  /** Case id -> the reference's reply to each entry of `script`, in order. */
  replies: Record<string, StepReply[]>;
}
