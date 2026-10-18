/**
 * The shapes of a hard fuzz case.
 */
export interface Step {
  method: "GET" | "POST" | "PATCH";
  path: string;
  body?: unknown;
}

export interface FuzzCase {
  /** "case-0000" … "case-0279". */
  id: string;
  stratum: string;
  aim: string;
  setup: Step[];
  script: Step[];
  invariants?: { kind: "steps-equal"; a: number; b: number }[];
  oracle?: boolean;
}

export interface CasesFile {
  generatorVersion: number;
  seed: number;
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
  replies: Record<string, StepReply[]>;
}
