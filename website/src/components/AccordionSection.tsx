import { useState } from 'react';
import ResultCard from './ResultCard';
import EmptyState from './EmptyState';
import type { AttemptResult } from '../data/types';

interface AccordionSectionProps {
  title: string;
  attempts: AttemptResult[];
  screenshotHashes?: Record<string, string>;
  /** Attempts before the "Only latest models" filter — see `DetailedComparison`. */
  datasetCount?: number;
  track?: "classic" | "hard" | "brownfield";
}

export default function AccordionSection({ title, attempts, screenshotHashes, datasetCount, track }: AccordionSectionProps) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="mb-12">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between p-6 bg-slate-800 border border-slate-700 rounded-lg hover:bg-slate-700 transition-colors"
      >
        <h2 className="text-2xl font-bold text-slate-100">{title}</h2>
        <svg
          className={`w-6 h-6 text-slate-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
        </svg>
      </button>

      {isOpen && (
        <div className="mt-6 flex flex-col gap-4">
          {attempts.length === 0 ? (
            datasetCount === 0 ? (
              <EmptyState title="No attempts yet">
                Attempts appear here once <code className="text-slate-300">npm run run-matrix</code> has produced
                a run and the <code className="text-slate-300">agrav-score-attempt</code> skill has scored it.
              </EmptyState>
            ) : (
              <EmptyState title="Every attempt is filtered out">
                Turn off &ldquo;Only latest models&rdquo; above to see superseded configurations.
              </EmptyState>
            )
          ) : (
            attempts.map((attempt) => (
              <ResultCard key={attempt.id} attempt={attempt} screenshotHashes={screenshotHashes} track={track} />
            ))
          )}
        </div>
      )}
    </div>
  );
}
