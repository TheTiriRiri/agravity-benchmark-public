import {useState, type MouseEvent} from "react";
import {
  COST_DISCLAIMER,
  COST_LABEL,
  costTooltip,
  formatCost,
  type TokenTotals,
} from "./comparisonUtils";
import type {ModelFamilyAverage} from "../data/types";

interface Props {
  average: ModelFamilyAverage;
  /** Leaderboard position. Omitted for a row nested inside a family group. */
  rank?: number;
  screenshotHashes?: Record<string, string>;
  compareSelected?: boolean;
  compareDisabled?: boolean;
  onCompareToggle?: () => void;
  /** Summed token counts behind the cost figures, for the hover breakdown. */
  tokens?: TokenTotals | null;
  /**
   * Whether a filmstrip may exist for this row. Families have no filmstrip —
   * `take-screenshots.ts` captures per (model, effort) — so the group header
   * turns the probe off rather than 404ing on every render.
   */
  filmstrip?: boolean;
  track?: "classic" | "hard" | "brownfield";
}

export default function ModelAveragesCard({
  average,
  rank,
  screenshotHashes,
  compareSelected = false,
  compareDisabled = false,
  onCompareToggle,
  tokens = null,
  filmstrip = true,
  track = "classic",
}: Props) {
  const [hasFilmstrip, setHasFilmstrip] = useState(filmstrip);
  const [expanded, setExpanded] = useState(false);
  const filmstripFilename = `${average.modelBaseId}_filmstrip.png`;
  const filmstripHash = screenshotHashes?.[filmstripFilename];
  const filmstripBase =
    track === "brownfield"
      ? "/screenshots/brownfield/"
      : track === "hard"
        ? "/screenshots/hard/"
        : "/screenshots/";
  const filmstripPath = `${filmstripBase}${filmstripFilename}${filmstripHash ? `?v=${filmstripHash}` : ""}`;
  const costTitle = costTooltip(tokens);

  const getBadgeColor = (percentage: number) => {
    if (percentage >= 90) return "bg-green-900 text-green-200";
    if (percentage >= 60) return "bg-yellow-900 text-yellow-200";
    return "bg-red-900 text-red-200";
  };

  const handleCardClick = () => {
    if (hasFilmstrip) {
      setExpanded(!expanded);
    }
  };

  const handleCompareClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();

    if (!compareDisabled || compareSelected) {
      onCompareToggle?.();
    }
  };

  const compareButton = onCompareToggle ? (
    <button
      type='button'
      onClick={handleCompareClick}
      disabled={compareDisabled && !compareSelected}
      className={`rounded border px-3 py-1.5 text-xs font-semibold transition-colors ${
        compareSelected
          ? "border-blue-500 bg-blue-600 text-white"
          : "border-slate-600 bg-slate-700 text-slate-200 hover:bg-slate-600"
      } ${
        compareDisabled && !compareSelected
          ? "cursor-not-allowed opacity-50 hover:bg-slate-700"
          : ""
      }`}
    >
      {compareSelected ? "Selected" : "Compare"}
    </button>
  ) : null;

  const rankBadge =
    rank === undefined ? null : (
      <span className='inline-flex items-center justify-center w-8 h-8 flex-shrink-0 rounded-full bg-blue-600 text-white font-bold text-sm'>
        {rank}
      </span>
    );

  const costLines = (
    <>
      {average.pricing && (
        <p className='text-xs text-slate-500 truncate' title={COST_DISCLAIMER}>
          List rate: ${average.pricing.input} / ${average.pricing.output} per 1M
        </p>
      )}
      {average.averageCost != null && (
        // Not truncated: the clipped half of "Est. cost (list price): $1.50
        // avg" would be the number. It wraps instead.
        <p className='text-xs text-slate-500' title={costTitle}>
          {COST_LABEL}:{" "}
          <span className='font-semibold text-slate-300'>
            {formatCost(average.averageCost)}
          </span>
          <span className='text-slate-600'> avg</span>
          {average.totalCost != null && (
            // "total" over what, said out loud. An attempt with no run.json, no
            // token counts or no list price contributes nothing to the sum, so
            // on a mixed group this is the total of *some* of the attempts the
            // card counts — and an unqualified "total" beside a larger attempt
            // count is the reading that would be wrong.
            <span className='text-slate-600'>
              {" "}
              · {formatCost(average.totalCost)} total
              {average.costCount != null &&
                average.costCount !== average.attemptCount &&
                ` over ${average.costCount} of ${average.attemptCount}`}
            </span>
          )}
        </p>
      )}
    </>
  );

  return (
    <div className='bg-slate-800 rounded-lg shadow-sm border border-slate-700 hover:shadow-md transition-shadow'>
      <div
        className={`p-4 ${hasFilmstrip ? "cursor-pointer" : ""}`}
        onClick={handleCardClick}
      >
        {/* Mobile layout */}
        <div className='md:hidden'>
          <div className='flex items-center justify-between mb-2'>
            <div className='flex items-center gap-3 min-w-0'>
              {rankBadge}
              <div className='min-w-0'>
                <h3 className='text-base font-semibold text-slate-100 truncate'>
                  {average.modelName}
                </h3>
                <p className='text-xs text-slate-400 truncate'>
                  {average.attemptCount} attempt
                  {average.attemptCount !== 1 ? "s" : ""}
                  {average.agentEnvironment && (
                    <span className='ml-1 text-slate-500'>
                      via {average.agentEnvironment}
                    </span>
                  )}
                </p>
                {costLines}
                {compareButton && <div className='mt-2'>{compareButton}</div>}
              </div>
            </div>
            <div className='flex items-center gap-2 flex-shrink-0'>
              <div
                className={`px-3 py-2 rounded-lg text-sm font-semibold whitespace-nowrap ${getBadgeColor(average.averagePercentage)}`}
              >
                {average.averagePercentage.toFixed(1)}%
              </div>
              {hasFilmstrip && (
                <svg
                  className={`w-5 h-5 text-slate-400 transition-transform ${expanded ? "rotate-180" : ""}`}
                  fill='none'
                  stroke='currentColor'
                  viewBox='0 0 24 24'
                >
                  <path
                    strokeLinecap='round'
                    strokeLinejoin='round'
                    strokeWidth={2}
                    d='M19 9l-7 7-7-7'
                  />
                </svg>
              )}
            </div>
          </div>
          <div className='w-full bg-slate-700 rounded-full h-2 mb-2'>
            <div
              className={`h-2 rounded-full transition-all ${
                average.averagePercentage >= 90
                  ? "bg-green-500"
                  : average.averagePercentage >= 60
                    ? "bg-yellow-500"
                    : "bg-red-500"
              }`}
              style={{width: `${average.averagePercentage}%`}}
            ></div>
          </div>
          <p className='text-xs text-slate-400'>
            Average:{" "}
            <span className='font-bold text-slate-100'>
              {average.averageScore.toFixed(1)}/
              {average.averageMaxScore.toFixed(1)}
            </span>
          </p>
        </div>

        {/* Desktop layout */}
        <div className='hidden md:flex items-center justify-between gap-4'>
          {/* w-64, not w-52: the cost label needs the room. */}
          <div className='flex items-center gap-3 flex-shrink-0 w-64'>
            {rankBadge}
            <div className='min-w-0'>
              <h3 className='text-base font-semibold text-slate-100 truncate'>
                {average.modelName}
              </h3>
              <p className='text-xs text-slate-400 truncate'>
                {average.attemptCount} attempt
                {average.attemptCount !== 1 ? "s" : ""}
                {average.agentEnvironment && (
                  <span className='ml-1 text-slate-500'>
                    via {average.agentEnvironment}
                  </span>
                )}
              </p>
              {costLines}
            </div>
          </div>

          <div className='flex-1 min-w-0'>
            <div className='w-full bg-slate-700 rounded-full h-2'>
              <div
                className={`h-2 rounded-full transition-all ${
                  average.averagePercentage >= 90
                    ? "bg-green-500"
                    : average.averagePercentage >= 60
                      ? "bg-yellow-500"
                      : "bg-red-500"
                }`}
                style={{width: `${average.averagePercentage}%`}}
              ></div>
            </div>
          </div>

          <div className='flex items-center gap-3 flex-shrink-0'>
            {compareButton}
            <div className='text-right'>
              <p className='text-xs text-slate-400'>Average</p>
              <p className='text-lg font-bold text-slate-100'>
                {average.averageScore.toFixed(1)}/
                {average.averageMaxScore.toFixed(1)}
              </p>
            </div>
            <div
              className={`px-3 py-2 rounded-lg text-sm font-semibold whitespace-nowrap ${getBadgeColor(average.averagePercentage)}`}
            >
              {average.averagePercentage.toFixed(1)}%
            </div>
            {hasFilmstrip && (
              <svg
                className={`w-5 h-5 text-slate-400 transition-transform ${expanded ? "rotate-180" : ""}`}
                fill='none'
                stroke='currentColor'
                viewBox='0 0 24 24'
              >
                <path
                  strokeLinecap='round'
                  strokeLinejoin='round'
                  strokeWidth={2}
                  d='M19 9l-7 7-7-7'
                />
              </svg>
            )}
          </div>
        </div>
      </div>

      {hasFilmstrip && expanded && (
        <div className='border-t border-slate-700 p-3'>
          <a
            href={filmstripPath}
            target='_blank'
            rel='noopener noreferrer'
            title='Click to open full resolution'
          >
            <img
              src={filmstripPath}
              alt={`Filmstrip of ${average.modelName} attempts`}
              className='w-full rounded border border-slate-600 hover:border-blue-400 transition-colors'
              onError={() => {
                setHasFilmstrip(false);
                setExpanded(false);
              }}
            />
          </a>
        </div>
      )}

      {/* Hidden image to detect if filmstrip exists */}
      {hasFilmstrip && !expanded && (
        <img
          src={filmstripPath}
          className='hidden'
          onError={() => setHasFilmstrip(false)}
          aria-hidden='true'
        />
      )}
    </div>
  );
}
