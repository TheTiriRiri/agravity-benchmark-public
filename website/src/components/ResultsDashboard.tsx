import {useMemo, useState} from "react";
import ModelAveragesCard from "./ModelAveragesCard";
import FamilyGroupCard from "./FamilyGroupCard";
import AccordionSection from "./AccordionSection";
import DetailedComparison from "./DetailedComparison";
import ModelComparison from "./ModelComparison";
import ScoreLegend from "./ScoreLegend";
import EmptyState from "./EmptyState";
import TrackSelector from "./TrackSelector";
import {
  COST_DISCLAIMER,
  aggregateFamilies,
  groupKeyOf,
  sumTokens,
  type GroupMode,
  type TokenTotals,
} from "./comparisonUtils";
import type {AttemptResult, ModelFamilyAverage} from "../data/types";

interface Props {
  /** One entry per (model, effort) benchmark id. */
  modelAverages: ModelFamilyAverage[];
  /** One entry per model family — the effort levels of a model, together. */
  familyAverages: ModelFamilyAverage[];
  sortedResults: AttemptResult[];
  supersededModels: Record<string, string>;
  screenshotHashes: Record<string, string>;
  /** Hard track data — empty when no hard results exist yet. */
  hardModelAverages?: ModelFamilyAverage[];
  hardFamilyAverages?: ModelFamilyAverage[];
  hardSortedResults?: AttemptResult[];
  hardScreenshotHashes?: Record<string, string>;
  /** Brownfield track data — empty when no brownfield results exist yet. */
  brownfieldModelAverages?: ModelFamilyAverage[];
  brownfieldFamilyAverages?: ModelFamilyAverage[];
  brownfieldSortedResults?: AttemptResult[];
  brownfieldScreenshotHashes?: Record<string, string>;
}

function areSelectionsEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function getVisibleSelection(
  currentSelection: string[],
  modelAverages: ModelFamilyAverage[],
): string[] {
  const visibleIds = new Set(modelAverages.map((avg) => avg.modelBaseId));
  const nextSelection = currentSelection
    .filter((id) => visibleIds.has(id))
    .slice(0, 2);

  modelAverages.forEach((average) => {
    if (
      nextSelection.length < 2 &&
      !nextSelection.includes(average.modelBaseId)
    ) {
      nextSelection.push(average.modelBaseId);
    }
  });

  return nextSelection;
}

export default function ResultsDashboard({
  modelAverages,
  familyAverages,
  sortedResults,
  supersededModels,
  screenshotHashes,
  hardModelAverages = [],
  hardFamilyAverages = [],
  hardSortedResults = [],
  hardScreenshotHashes = {},
  brownfieldModelAverages = [],
  brownfieldFamilyAverages = [],
  brownfieldSortedResults = [],
  brownfieldScreenshotHashes = {},
}: Props) {
  const [track, setTrack] = useState<'classic' | 'hard' | 'brownfield'>('classic');
  const [latestOnly, setLatestOnly] = useState(true);
  const [groupMode, setGroupMode] = useState<GroupMode>("config");

  // Switch data source based on active track
  const activeModelAverages =
    track === 'brownfield'
      ? brownfieldModelAverages
      : track === 'hard'
        ? hardModelAverages
        : modelAverages;
  const activeFamilyAverages =
    track === 'brownfield'
      ? brownfieldFamilyAverages
      : track === 'hard'
        ? hardFamilyAverages
        : familyAverages;
  const activeSortedResults =
    track === 'brownfield'
      ? brownfieldSortedResults
      : track === 'hard'
        ? hardSortedResults
        : sortedResults;
  const activeScreenshotHashes =
    track === 'brownfield'
      ? brownfieldScreenshotHashes
      : track === 'hard'
        ? hardScreenshotHashes
        : screenshotHashes;

  const supersededBaseIds = useMemo(
    () => new Set(Object.keys(supersededModels)),
    [supersededModels],
  );

  const filteredAverages = useMemo(() => {
    if (!latestOnly) return activeModelAverages;
    return activeModelAverages.filter(
      (avg) => !supersededBaseIds.has(avg.modelBaseId),
    );
  }, [activeModelAverages, latestOnly, supersededBaseIds]);

  const filteredResults = useMemo(() => {
    if (!latestOnly) return activeSortedResults;
    return activeSortedResults.filter(
      (r) => !supersededBaseIds.has(r.modelBaseId),
    );
  }, [activeSortedResults, latestOnly, supersededBaseIds]);

  // Aggregated from the attempts on screen rather than taken from
  // `results.json`: Task 5's `familyAverages` covers every attempt of a family
  // and cannot answer to a filter applied here, so a partially filtered family
  // would show a header describing rows it is no longer displaying — and the
  // table below, which aggregates from these same attempts, would contradict it.
  // `familyAverages` still supplies the display name and the list rate.
  const filteredFamilyAverages = useMemo(
    () => aggregateFamilies(filteredResults, activeFamilyAverages),
    [filteredResults, activeFamilyAverages],
  );

  const activeAverages =
    groupMode === "family" ? filteredFamilyAverages : filteredAverages;
  const canCompare = activeAverages.length >= 2;

  const familyNames = useMemo(
    () =>
      Object.fromEntries(
        activeFamilyAverages.map((avg) => [avg.modelBaseId, avg.modelName]),
      ),
    [activeFamilyAverages],
  );

  /** Configurations belonging to each family, for the grouped ranking. */
  const membersByFamily = useMemo(() => {
    const familyOf = new Map(
      filteredResults.map((r) => [r.modelBaseId, r.modelFamily]),
    );
    const members: Record<string, ModelFamilyAverage[]> = {};
    filteredAverages.forEach((average) => {
      const family = familyOf.get(average.modelBaseId);
      if (family === undefined) return;
      (members[family] ??= []).push(average);
    });
    return members;
  }, [filteredAverages, filteredResults]);

  /**
   * Token totals per group key, both levels at once — the cost hover needs the
   * cache-read split and `results.json` carries only the dollar figure, so the
   * counts are summed from each attempt's cost note.
   */
  const tokensByKey = useMemo(() => {
    const byKey: Record<string, TokenTotals> = {};
    const groups = new Map<string, AttemptResult[]>();
    filteredResults.forEach((attempt) => {
      (["config", "family"] as const).forEach((mode) => {
        const key = groupKeyOf(attempt, mode);
        const bucket = groups.get(key);
        if (bucket) bucket.push(attempt);
        else groups.set(key, [attempt]);
      });
    });
    groups.forEach((attempts, key) => {
      const totals = sumTokens(attempts);
      if (totals) byKey[key] = totals;
    });
    return byKey;
  }, [filteredResults]);

  const [selectedModelIds, setSelectedModelIds] = useState<string[]>(() =>
    getVisibleSelection([], filteredAverages),
  );

  /**
   * The ranking rows a given (mode, toggle) pair would show. The render path
   * uses the memos above; this is the same rule applied to the *next* state, so
   * a toggle can re-seed the comparison selection before React re-renders.
   */
  const averagesFor = (mode: GroupMode, onlyLatest: boolean): ModelFamilyAverage[] => {
    if (mode === "config") {
      return onlyLatest
        ? activeModelAverages.filter((avg) => !supersededBaseIds.has(avg.modelBaseId))
        : activeModelAverages;
    }
    const attempts = onlyLatest
      ? activeSortedResults.filter((r) => !supersededBaseIds.has(r.modelBaseId))
      : activeSortedResults;
    return aggregateFamilies(attempts, activeFamilyAverages);
  };

  const handleTrackChange = (nextTrack: 'classic' | 'hard' | 'brownfield') => {
    if (nextTrack === track) return;
    setTrack(nextTrack);
    const nextModelAverages =
      nextTrack === 'brownfield'
        ? brownfieldModelAverages
        : nextTrack === 'hard'
          ? hardModelAverages
          : modelAverages;
    const nextFiltered = latestOnly
      ? nextModelAverages.filter((avg) => !supersededBaseIds.has(avg.modelBaseId))
      : nextModelAverages;
    setSelectedModelIds(getVisibleSelection([], nextFiltered));
  };

  const handleLatestOnlyToggle = () => {
    const nextLatestOnly = !latestOnly;
    const nextAverages = averagesFor(groupMode, nextLatestOnly);

    setLatestOnly(nextLatestOnly);
    setSelectedModelIds((currentSelection) => {
      const nextSelection = getVisibleSelection(currentSelection, nextAverages);
      return areSelectionsEqual(currentSelection, nextSelection)
        ? currentSelection
        : nextSelection;
    });
  };

  // Selection ids are group keys, and the two modes key on different things —
  // a family id means nothing to the flat view. Switching re-seeds it.
  const handleGroupModeChange = (nextMode: GroupMode) => {
    if (nextMode === groupMode) return;
    setGroupMode(nextMode);
    setSelectedModelIds(getVisibleSelection([], averagesFor(nextMode, latestOnly)));
  };

  const handleCompareToggle = (modelBaseId: string) => {
    setSelectedModelIds((currentSelection) => {
      if (currentSelection.includes(modelBaseId)) {
        return currentSelection.filter((id) => id !== modelBaseId);
      }

      if (currentSelection.length >= 2) {
        return [currentSelection[0], modelBaseId];
      }

      return [...currentSelection, modelBaseId];
    });
  };

  const groupButton = (mode: GroupMode, label: string) => (
    <button
      type='button'
      onClick={() => handleGroupModeChange(mode)}
      aria-pressed={groupMode === mode}
      className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
        groupMode === mode
          ? "bg-blue-600 text-white"
          : "text-slate-300 hover:bg-slate-700"
      }`}
    >
      {label}
    </button>
  );

  return (
    <>
      {/* Track Selector */}
      <div className='mb-6'>
        <TrackSelector track={track} onTrackChange={handleTrackChange} />
      </div>

      {/* Rankings header + view toggles */}
      <div className='mb-12'>
        <div className='flex flex-col gap-3 mb-6 lg:flex-row lg:items-center lg:justify-between'>
          <h2 className='text-2xl font-bold text-slate-100'>
            {groupMode === "family"
              ? "Model Family Rankings"
              : "Model + Effort Rankings"}
          </h2>
          <div className='flex flex-col gap-3 sm:flex-row sm:items-center'>
            <div className='inline-flex w-fit rounded-lg border border-slate-700 bg-slate-800 p-1'>
              {groupButton("config", "Model + effort")}
              {groupButton("family", "Grouped by family")}
            </div>
            <div className='flex items-center gap-3'>
              <button
                onClick={handleLatestOnlyToggle}
                className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
                  latestOnly ? "bg-blue-600" : "bg-slate-600"
                }`}
                role="switch"
                aria-checked={latestOnly}
              >
                <span
                  className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                    latestOnly ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </button>
              <span className='text-sm text-slate-300 whitespace-nowrap'>Only latest models</span>
            </div>
          </div>
        </div>
        <p className='mb-4 text-sm text-slate-400'>
          {groupMode === "family"
            ? "Each block is one model; the rows inside it are the (model, effort) pairs that ran for it — more than one only where more than one effort level was run."
            : "Each row is one (model, effort) pair — the unit this benchmark scores."}
        </p>
        <div className='flex flex-col gap-4'>
          {activeAverages.length === 0 ? (
            activeSortedResults.length === 0 ? (
              <EmptyState title='No results yet'>
                Nothing has been benchmarked into{" "}
                <code className='text-slate-300'>eval-results/</code> yet. Run{" "}
                <code className='text-slate-300'>npm run run-matrix</code>, score the
                attempts with the{" "}
                <code className='text-slate-300'>agrav-score-attempt</code> skill, then{" "}
                <code className='text-slate-300'>npm run process-results</code> to fill
                this page in.
              </EmptyState>
            ) : (
              <EmptyState title='Every result is filtered out'>
                Every configuration on record is superseded. Turn off &ldquo;Only
                latest models&rdquo; to see them.
              </EmptyState>
            )
          ) : groupMode === "family" ? (
            activeAverages.map((family, index) => (
              <FamilyGroupCard
                key={family.modelBaseId}
                family={family}
                rank={index + 1}
                members={membersByFamily[family.modelBaseId] ?? []}
                screenshotHashes={activeScreenshotHashes}
                tokensByKey={tokensByKey}
                compareSelected={selectedModelIds.includes(family.modelBaseId)}
                onCompareToggle={() => handleCompareToggle(family.modelBaseId)}
                track={track}
              />
            ))
          ) : (
            activeAverages.map((average, index) => (
              <ModelAveragesCard
                key={average.modelBaseId}
                average={average}
                rank={index + 1}
                screenshotHashes={activeScreenshotHashes}
                tokens={tokensByKey[average.modelBaseId] ?? null}
                compareSelected={selectedModelIds.includes(average.modelBaseId)}
                onCompareToggle={() => handleCompareToggle(average.modelBaseId)}
                track={track}
              />
            ))
          )}
        </div>
        {activeAverages.length > 0 && (
          <p className='mt-4 text-xs text-slate-500'>{COST_DISCLAIMER}</p>
        )}
      </div>

      {/* Individual Attempts */}
      <AccordionSection
        title="Individual Attempts"
        attempts={filteredResults}
        screenshotHashes={activeScreenshotHashes}
        datasetCount={activeSortedResults.length}
        track={track}
      />

      {/* Detailed Comparison */}
      <div className="mb-8">
        <h2 className="text-2xl font-bold text-slate-100 mb-4">
          Detailed Comparison
        </h2>
        <p className="text-slate-300 text-sm mb-4">
          Review averages first, switch to all attempts for scoring notes
          {canCompare
            ? `, or compare two selected ${groupMode === "family" ? "families" : "configurations"} below`
            : ""}
          .
        </p>
        <ScoreLegend />
        <DetailedComparison
          attempts={filteredResults}
          groupMode={groupMode}
          groupNames={familyNames}
          datasetCount={activeSortedResults.length}
        />

        {/* A pairwise comparison needs a pair. `ModelComparison` renders
            nothing below two rows, so the heading goes with it rather than
            standing over an empty space on a fresh checkout. */}
        {canCompare && (
          <div className="mt-10">
            <h2 className="text-2xl font-bold text-slate-100 mb-4">
              {groupMode === "family" ? "Family Comparison" : "Configuration Comparison"}
            </h2>
            <p className="text-slate-300 text-sm mb-4">
              Compare two {groupMode === "family" ? "model families" : "(model, effort) pairs"} by
              average criterion score and attempt spread.
            </p>
            <ModelComparison
              modelAverages={activeAverages}
              attempts={filteredResults}
              selectedModelIds={selectedModelIds}
              onSelectionChange={setSelectedModelIds}
              groupMode={groupMode}
            />
          </div>
        )}
      </div>
    </>
  );
}
