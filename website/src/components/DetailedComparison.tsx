import {useState, useMemo} from "react";
import TableFilters, {type FilterState} from "./TableFilters";
import ResultsTable from "./ResultsTable";
import ModelAveragesTable from "./ModelAveragesTable";
import type {GroupMode} from "./comparisonUtils";
import {HIDDEN_TEST_ROWS, TECH_STACK_ROW} from "./comparisonUtils";
import type {AttemptResult} from "../data/types";

interface Props {
  attempts: AttemptResult[];
  /** Columns per benchmark id, or per model family. Set by the page toggle. */
  groupMode?: GroupMode;
  /** Display names for family keys; ignored in `config` mode. */
  groupNames?: Record<string, string>;
  /**
   * Every attempt in `results.json`, before the "Only latest models" toggle
   * upstream of this component has run. `attempts` has already been through it,
   * so it cannot tell an empty dataset from a filter that hid everything.
   */
  datasetCount?: number;
}

function hasMaxScore(attempt: AttemptResult, criterionName: string): boolean {
  const c = attempt.criteria.find((c) => c.name === criterionName);
  return c ? c.score === c.max : false;
}

export default function DetailedComparison({
  attempts,
  groupMode = "config",
  groupNames = {},
  datasetCount,
}: Props) {
  const [viewMode, setViewMode] = useState<"models" | "attempts">("models");
  const [filters, setFilters] = useState<FilterState>({
    localBuild: false,
    manualTesting: false,
    techStack: false,
    hiddenTests: false,
  });

  const handleToggle = (filter: keyof FilterState) => {
    setFilters((prev) => ({...prev, [filter]: !prev[filter]}));
  };

  const filteredAttempts = useMemo(
    () =>
      attempts.filter((attempt) => {
        if (filters.localBuild && !hasMaxScore(attempt, "Local build"))
          return false;
        if (filters.manualTesting && !hasMaxScore(attempt, "Manual testing"))
          return false;
        if (filters.techStack && !hasMaxScore(attempt, TECH_STACK_ROW))
          return false;
        if (
          filters.hiddenTests &&
          !HIDDEN_TEST_ROWS.every((name) => hasMaxScore(attempt, name))
        )
          return false;
        return true;
      }),
    [attempts, filters],
  );

  const averagesLabel =
    groupMode === "family"
      ? "Family averages"
      : "Model averages";

  return (
    <div>
      <TableFilters
        filters={filters}
        onToggle={handleToggle}
        totalCount={attempts.length}
        filteredCount={filteredAttempts.length}
      />
      <div className='mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between'>
        <div className='text-sm text-slate-400'>
          {viewMode === "models"
            ? groupMode === "family"
              ? "Showing one averaged column per model family, all effort levels folded together."
              : "Showing one averaged column per (model, effort) configuration."
            : "Showing every individual attempt as its own column."}
        </div>
        <div className='inline-flex w-fit rounded-lg border border-slate-700 bg-slate-800 p-1'>
          <button
            type='button'
            onClick={() => setViewMode("models")}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              viewMode === "models"
                ? "bg-blue-600 text-white"
                : "text-slate-300 hover:bg-slate-700"
            }`}
          >
            {averagesLabel}
          </button>
          <button
            type='button'
            onClick={() => setViewMode("attempts")}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              viewMode === "attempts"
                ? "bg-blue-600 text-white"
                : "text-slate-300 hover:bg-slate-700"
            }`}
          >
            All attempts
          </button>
        </div>
      </div>
      {viewMode === "models" ? (
        <ModelAveragesTable
          attempts={filteredAttempts}
          groupMode={groupMode}
          groupNames={groupNames}
          datasetCount={datasetCount ?? attempts.length}
        />
      ) : (
        <ResultsTable
          attempts={filteredAttempts}
          datasetCount={datasetCount ?? attempts.length}
        />
      )}
    </div>
  );
}
