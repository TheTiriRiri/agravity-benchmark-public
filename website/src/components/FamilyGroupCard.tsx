import ModelAveragesCard from "./ModelAveragesCard";
import type {TokenTotals} from "./comparisonUtils";
import type {ModelFamilyAverage} from "../data/types";

interface Props {
  family: ModelFamilyAverage;
  rank: number;
  /** The (model, effort) configurations this family aggregates. */
  members: ModelFamilyAverage[];
  screenshotHashes?: Record<string, string>;
  tokensByKey: Record<string, TokenTotals>;
  compareSelected?: boolean;
  onCompareToggle?: () => void;
  track?: "classic" | "hard" | "brownfield";
}

/**
 * Effort levels read high → medium → low, not by score.
 *
 * The ids are fixed by `benchmark/runner.yaml` and every one of them ends in an
 * effort suffix, so the suffix is the ordering key. An id that somehow has none
 * sorts last rather than being dropped.
 */
const EFFORT_SUFFIXES = ["-high", "-med", "-low"];

function effortRank(modelBaseId: string): number {
  const index = EFFORT_SUFFIXES.findIndex((suffix) =>
    modelBaseId.endsWith(suffix),
  );
  return index === -1 ? EFFORT_SUFFIXES.length : index;
}

/**
 * One model family, with its effort levels underneath it.
 *
 * This is the view the benchmark exists for: `Gemini 3.6 Flash` High / Medium /
 * Low sitting in one block, the family average on top, so the effort axis can
 * be read straight down a column instead of being reconstructed from nine flat
 * rows. A flat list with one row per model cannot express it.
 */
export default function FamilyGroupCard({
  family,
  rank,
  members,
  screenshotHashes,
  tokensByKey,
  compareSelected = false,
  onCompareToggle,
  track,
}: Props) {
  const ordered = [...members].sort(
    (a, b) =>
      effortRank(a.modelBaseId) - effortRank(b.modelBaseId) ||
      a.modelBaseId.localeCompare(b.modelBaseId),
  );
  const spread =
    ordered.length > 1
      ? Math.max(...ordered.map((m) => m.averagePercentage)) -
        Math.min(...ordered.map((m) => m.averagePercentage))
      : null;

  return (
    <div className='rounded-lg border border-slate-700 bg-slate-900/40'>
      <ModelAveragesCard
        average={family}
        rank={rank}
        compareSelected={compareSelected}
        onCompareToggle={onCompareToggle}
        tokens={tokensByKey[family.modelBaseId] ?? null}
        filmstrip={false}
        track={track}
      />
      <div className='border-t border-slate-700 px-3 pb-3 pt-3'>
        <p className='mb-2 text-xs uppercase tracking-wide text-slate-500'>
          (model, effort) pairs
          {spread !== null && (
            <span className='ml-2 normal-case tracking-normal text-slate-400'>
              spread {spread.toFixed(1)} pts between best and worst
            </span>
          )}
        </p>
        <div className='flex flex-col gap-3'>
          {ordered.map((member) => (
            <ModelAveragesCard
              key={member.modelBaseId}
              average={member}
              screenshotHashes={screenshotHashes}
              tokens={tokensByKey[member.modelBaseId] ?? null}
              track={track}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
