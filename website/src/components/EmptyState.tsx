import type {ReactNode} from "react";

interface Props {
  title: string;
  children?: ReactNode;
}

/**
 * The "nothing here yet" panel.
 *
 * CI builds this site before a single attempt exists (Ruling P3), so every
 * table, card list and chart has to have something deliberate to render when
 * `results.json` is empty. One component so all of them say it the same way.
 */
export default function EmptyState({title, children}: Props) {
  return (
    <div className='rounded-lg border border-dashed border-slate-700 bg-slate-800/60 p-6 text-center'>
      <p className='text-base font-semibold text-slate-200'>{title}</p>
      {children && (
        <div className='mx-auto mt-2 max-w-xl text-sm text-slate-400'>
          {children}
        </div>
      )}
    </div>
  );
}
