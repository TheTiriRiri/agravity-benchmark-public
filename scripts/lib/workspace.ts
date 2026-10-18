/**
 * Whether an attempt directory holds nothing but agy's own project stub.
 *
 * Extracted from `run-matrix.ts` so both `run-matrix` and `reclassify-runs`
 * can share the same definition.
 */

import { existsSync, readdirSync } from "node:fs";

/** agy's project stub; its presence alone still means an empty workspace. */
const AGY_STUB_DIR = ".antigravitycli";

/** Anything but agy's own project stub counts as model output. */
export function isWorkspaceEmpty(dir: string): boolean {
  if (!existsSync(dir)) return true;
  return readdirSync(dir).filter((entry) => entry !== AGY_STUB_DIR).length === 0;
}
