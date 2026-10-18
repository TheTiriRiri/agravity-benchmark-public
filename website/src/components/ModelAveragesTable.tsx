import type {AttemptResult} from "../data/types";
import EmptyState from "./EmptyState";
import {
  aggregateCriterion,
  buildModelAggregates,
  criterionLabel,
  formatAverageScore,
  getOrderedCriteria,
  getPenaltyColor,
  getScoreColor,
  isPenaltyRow,
  type CriterionAggregate,
  type GroupMode,
} from "./comparisonUtils";

interface Props {
  attempts: AttemptResult[];
  /** One column per benchmark id, or one per model family. */
  groupMode?: GroupMode;
  /** Display names for family keys; ignored in `config` mode. */
  groupNames?: Record<string, string>;
  /**
   * Every attempt in `results.json`, before *any* filter — the criterion
   * filters here and the "Only latest models" toggle above alike. It decides
   * only which empty state to show: blaming the pipeline for what a filter did
   * would send the reader to re-run the matrix over a checkbox.
   */
  datasetCount?: number;
}

function ScoreDots({
  aggregate,
  isPenalty,
}: {
  aggregate: CriterionAggregate;
  isPenalty: boolean;
}) {
  return (
    <div className='mt-2 flex justify-center gap-1'>
      {aggregate.attemptScores.map((attempt) => (
        <span
          key={attempt.attemptNumber}
          className={`h-2 w-2 rounded-full ${
            isPenalty
              ? getPenaltyColor(attempt.score)
              : getScoreColor(attempt.score, attempt.max)
          }`}
          title={`Attempt ${attempt.attemptNumber}: ${attempt.score}`}
        />
      ))}
    </div>
  );
}

function AverageScoreCell({aggregate}: {aggregate: CriterionAggregate}) {
  const isPenalty = isPenaltyRow(aggregate.name);
  const colorClass =
    aggregate.averageScore === null
      ? "bg-slate-700 text-slate-400"
      : isPenalty
        ? getPenaltyColor(aggregate.averageScore)
        : getScoreColor(aggregate.averageScore, aggregate.max);

  return (
    <td className='px-3 py-3 text-center align-top'>
      <div className='flex flex-col items-center'>
        <span
          className={`inline-block rounded px-2 py-1 text-sm font-semibold ${colorClass}`}
        >
          {isPenalty && aggregate.averageScore && aggregate.averageScore > 0
            ? `-${formatAverageScore(aggregate.averageScore)}`
            : formatAverageScore(aggregate.averageScore)}
        </span>
        {aggregate.attemptScores.length > 0 && (
          <ScoreDots aggregate={aggregate} isPenalty={isPenalty} />
        )}
        <span className='mt-1 text-[11px] text-slate-500'>
          {aggregate.attemptScores.length} attempts
        </span>
      </div>
    </td>
  );
}

export default function ModelAveragesTable({
  attempts,
  groupMode = "config",
  groupNames = {},
  datasetCount,
}: Props) {
  const models = buildModelAggregates(attempts, groupMode, groupNames);
  const criteria = getOrderedCriteria(attempts, false);

  if (attempts.length === 0) {
    return datasetCount === 0 ? (
      <EmptyState title='No scored attempts yet'>
        This table fills in once an attempt has a{" "}
        <code className='text-slate-300'>eval-results.csv</code> and{" "}
        <code className='text-slate-300'>npm run process-results</code> has run.
      </EmptyState>
    ) : (
      <div className='rounded-lg border border-slate-700 bg-slate-800 p-4 text-sm text-slate-400'>
        No attempts match the active filters.
      </div>
    );
  }

  return (
    <div>
      <div className='overflow-x-auto rounded-lg border border-slate-700'>
        <table className='w-full border-collapse bg-slate-800'>
          <thead>
            <tr className='border-b border-slate-700 bg-slate-900'>
              <th className='sticky left-0 z-20 w-56 border-r border-slate-700 bg-slate-900 px-4 py-3 text-left font-semibold text-slate-100'>
                Criterion
              </th>
              {models.map((model) => (
                <th
                  key={model.modelBaseId}
                  className='min-w-[8rem] px-3 py-3 text-center text-sm font-semibold text-slate-100'
                >
                  <div className='font-semibold'>{model.modelName}</div>
                  <div className='text-xs font-normal text-slate-400'>
                    {model.attempts.length} attempts avg
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {criteria.map((criterion, idx) => {
              const isPenalty = isPenaltyRow(criterion.name);

              return (
                <tr
                  key={criterion.name}
                  className={`${
                    isPenalty
                      ? "border-t-2 border-slate-700 bg-slate-900/40"
                      : idx % 2 === 0
                        ? "bg-slate-800"
                        : "bg-slate-900"
                  }`}
                >
                  <td
                    className={`sticky left-0 z-10 border-r border-slate-700 px-4 py-3 text-sm ${
                      isPenalty
                        ? "bg-slate-900 font-medium text-slate-300"
                        : "bg-inherit font-medium text-slate-100"
                    }`}
                  >
                    <div className='max-w-xs'>{criterionLabel(criterion.name)}</div>
                  </td>
                  {models.map((model) => (
                    <AverageScoreCell
                      key={model.modelBaseId}
                      aggregate={aggregateCriterion(
                        model.attempts,
                        criterion.name,
                      )}
                    />
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className='mt-3 px-4 text-xs text-slate-400'>
        Dots show the individual attempts that make up each average.
      </p>
    </div>
  );
}
