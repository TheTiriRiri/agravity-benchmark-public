/**
 * The benchmark's model catalogue: display names, environments, families and
 * imputed prices, keyed by benchmark id.
 *
 * The unit of comparison is a **(model, effort) pair**, so every id carries an
 * effort suffix and `MODEL_FAMILY` is what puts the effort levels of one model
 * back together. Nothing here reads the filesystem — `scripts/process-results.ts`
 * joins these tables to the attempt directories.
 *
 * The ids are fixed by `benchmark/runner.yaml`; adding a row here without adding
 * it there (or vice versa) is how a model silently vanishes from the dashboard.
 */

/**
 * The harness every attempt runs under. The tool is always the Antigravity CLI
 * and the axis that varies is `--effort`, so the effort is what the environment
 * names.
 */
export enum AGENT_ENVIRONMENT {
  AntigravityHigh = "Antigravity CLI (High Effort)",
  AntigravityMedium = "Antigravity CLI (Medium Effort)",
  AntigravityLow = "Antigravity CLI (Low Effort)",
}

/** A benchmark id — one (model, effort) pair, and one row of the matrix. */
export type ModelId =
  | "gemini-38-flash-high"
  | "gemini-38-flash-med"
  | "gemini-38-flash-low"
  | "gemini-37-flash-high"
  | "gemini-31-pro-high"
  | "gemini-31-pro-low"
  | "claude-sonnet-46-high"
  | "claude-opus-46-high"
  | "gpt-oss-120b-med";

// Keyed by benchmark id (directory name without "-attempt-{n}")
export const AGENT_NAMES: Record<ModelId, string> = {
  "gemini-38-flash-high": "Gemini 3.8 Flash (High)",
  "gemini-38-flash-med": "Gemini 3.8 Flash (Medium)",
  "gemini-38-flash-low": "Gemini 3.8 Flash (Low)",
  "gemini-37-flash-high": "Gemini 3.7 Flash (High)",
  "gemini-31-pro-high": "Gemini 3.1 Pro (High)",
  "gemini-31-pro-low": "Gemini 3.1 Pro (Low)",
  "claude-sonnet-46-high": "Claude Sonnet 4.6 (Thinking)",
  "claude-opus-46-high": "Claude Opus 4.6 (Thinking)",
  "gpt-oss-120b-med": "GPT-OSS 120B (Medium)",
};

export const AGENT_ENV: Record<ModelId, AGENT_ENVIRONMENT> = {
  "gemini-38-flash-high": AGENT_ENVIRONMENT.AntigravityHigh,
  "gemini-38-flash-med": AGENT_ENVIRONMENT.AntigravityMedium,
  "gemini-38-flash-low": AGENT_ENVIRONMENT.AntigravityLow,
  "gemini-37-flash-high": AGENT_ENVIRONMENT.AntigravityHigh,
  "gemini-31-pro-high": AGENT_ENVIRONMENT.AntigravityHigh,
  "gemini-31-pro-low": AGENT_ENVIRONMENT.AntigravityLow,
  "claude-sonnet-46-high": AGENT_ENVIRONMENT.AntigravityHigh,
  "claude-opus-46-high": AGENT_ENVIRONMENT.AntigravityHigh,
  "gpt-oss-120b-med": AGENT_ENVIRONMENT.AntigravityMedium,
};

/**
 * Benchmark id → model family.
 *
 * The reason this table exists: `getModelBaseId` only strips `-attempt-N`, so
 * on its own it would make `gemini-38-flash-high` and `gemini-38-flash-low`
 * two unrelated families and the effort comparison — the whole point of this
 * benchmark — would never appear. `familyAverages` in `results.json` keys on
 * this, never on a display name.
 *
 * Must agree with the `family:` column of `benchmark/runner.yaml`.
 */
export const MODEL_FAMILY: Record<ModelId, string> = {
  "gemini-38-flash-high": "gemini-38-flash",
  "gemini-38-flash-med": "gemini-38-flash",
  "gemini-38-flash-low": "gemini-38-flash",
  "gemini-37-flash-high": "gemini-37-flash",
  "gemini-31-pro-high": "gemini-31-pro",
  "gemini-31-pro-low": "gemini-31-pro",
  "claude-sonnet-46-high": "claude-sonnet-46",
  "claude-opus-46-high": "claude-opus-46",
  "gpt-oss-120b-med": "gpt-oss-120b",
};

/**
 * Family id → display name. Kept as its own table rather than derived by
 * stripping the effort parenthetical off `AGENT_NAMES`: deriving one label from
 * another is exactly the display-name coupling the family aggregation exists to
 * avoid.
 */
export const FAMILY_NAMES: Record<string, string> = {
  "gemini-38-flash": "Gemini 3.8 Flash",
  "gemini-37-flash": "Gemini 3.7 Flash",
  "gemini-31-pro": "Gemini 3.1 Pro",
  "claude-sonnet-46": "Claude Sonnet 4.6",
  "claude-opus-46": "Claude Opus 4.6",
  "gpt-oss-120b": "GPT-OSS-120B",
};

/** Models superseded by newer versions (old → new). */
// Empty until a family is retired — e.g. when 3.6 Flash replaces 3.5 Flash and
// the older rows should drop off the public leaderboard without being deleted.
export const SUPERSEDED_MODELS: Partial<Record<ModelId, ModelId>> = {};

/** Benchmark ids to exclude from processed results (all attempts are skipped). */
// An escape hatch for un-publishing a family whose data is on disk.
// Ships empty; add an id here rather than deleting its `eval-results/` rows.
export const DISABLED_MODELS: Set<string> = new Set([]);

/**
 * Token pricing per 1M tokens, USD. There are three rates because the cost
 * formula has three terms:
 *
 *     cost = (input_tokens x input + output_tokens x output
 *             + cache_read_tokens x cacheRead) / 1e6
 *
 * (`imputedCost` in `scripts/process-results.ts` is that formula.)
 *
 * **`thinking_tokens` has no rate, and is deliberately absent from the sum.**
 * Thinking tokens are a *subset* of `output_tokens` — the near-universal
 * provider convention, where thinking is billed at the output rate and reported
 * separately only for visibility. Adding a fourth term would charge the same
 * tokens twice.
 *
 * **Checked against a real agy envelope from a run that actually used
 * thinking:** `thinking_tokens` was below `output_tokens` — inside output, not
 * beside it. The falsifier
 * (`thinking_tokens > output_tokens`, or the two plainly not overlapping) did
 * not fire. The field is spelled `thinking_tokens`; an earlier draft of this
 * file called it `reasoning_tokens`, which agy does not emit and which would
 * have read 0 forever. (Ruling R10.)
 *
 * **`cache_read_tokens` rests on the mirror-image assumption, and it is the one
 * worth more money: that `input_tokens` is *exclusive* of `cache_read_tokens`,
 * so the two can be charged as separate terms.** This is a real fork, not a
 * formality — Anthropic reports the two separately, while Google's
 * `promptTokenCount` *includes* `cachedContentTokenCount`. If agy's envelope
 * follows the inclusive convention, this formula charges the same tokens twice.
 * On a long agentic run cache reads typically dominate the token counts, and for
 * the models whose `cacheRead` equals `input` (the conservative rule below) the
 * error approaches a factor of two — in the direction of *overstating* the cost,
 * with nothing on the page to warn the reader.
 *
 * **Checked on a real envelope** whose `cache_read_tokens` was larger than its
 * `input_tokens`: `total_tokens === input_tokens + output_tokens`, so
 * `cache_read_tokens` sits **outside** that sum entirely. The counts are exclusive, the formula above is right, and it does
 * not double-charge cache reads.
 */
export interface ModelPricing {
  input: number;
  output: number;
  /**
   * Cache-read rate where the provider publishes one, otherwise equal to
   * `input` — an un-discounted read is the conservative reading, never a
   * discount we invented.
   */
  cacheRead: number;
}

/**
 * **These prices are imputed, and no attempt in this repo was billed by them.**
 *
 * The account is an Antigravity subscription: it is metered against a weekly
 * quota, not per token. What `MODEL_PRICING` says is "what the nearest publicly
 * priced equivalent of this model would have cost at these token counts" — a
 * cost *proxy* for ranking runs against each other, not a bill. The dashboard
 * must label it as imputed wherever it shows a dollar figure.
 *
 * `null` means no defensible public list price was found. A null price yields
 * no cost figure at all rather than a guessed one; the token counts still show.
 *
 * Sources, read 2026-09-04:
 * - Claude Opus 4.6, Claude Sonnet 4.6 — Anthropic's published API rates
 *   ($5/$25 and $3/$15 per MTok). Cache reads bill at ~0.1x the input rate,
 *   hence $0.50 and $0.30.
 * - Gemini 3.1 Pro — Google's list prices. No cache-read rate is published,
 *   so cache reads are priced at the input rate per the rule above.
 * - Gemini 3.8 Flash, Gemini 3.7 Flash — no public price found at all; both are
 *   newer than any list this repo could cite. (Gemini 3.5 Flash, which did have
 *   a price, is no longer in agy's catalogue as of 2026-09-05.)
 * - GPT-OSS-120B — open weights, so there is no vendor list price; the hosted
 *   rates differ several-fold between providers and picking one would be a
 *   guess dressed as a citation.
 *
 * Re-check these against the vendors' own pricing pages before publishing a
 * cost comparison, and record the date when you do.
 */
export const MODEL_PRICING: Record<ModelId, ModelPricing | null> = {
  "gemini-38-flash-high": null,
  "gemini-38-flash-med": null,
  "gemini-38-flash-low": null,
  "gemini-37-flash-high": null,
  "gemini-31-pro-high": { input: 2.0, output: 12.0, cacheRead: 2.0 },
  "gemini-31-pro-low": { input: 2.0, output: 12.0, cacheRead: 2.0 },
  "claude-sonnet-46-high": { input: 3.0, output: 15.0, cacheRead: 0.3 },
  "claude-opus-46-high": { input: 5.0, output: 25.0, cacheRead: 0.5 },
  "gpt-oss-120b-med": null,
};

/** Type guard: check whether a runtime string is a known ModelId */
export function isModelId(value: string): value is ModelId {
  return value in AGENT_NAMES;
}

/** Extract base model ID from a directory name like "claude-opus-46-high-attempt-3" → "claude-opus-46-high" */
export function getModelBaseId(dirname: string): string {
  const match = dirname.match(/^(.+)-attempt-\d+$/);
  return match ? match[1] : dirname;
}
