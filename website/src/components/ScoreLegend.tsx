export default function ScoreLegend() {
  return (
    <div className='mb-5 rounded-lg border border-slate-700 bg-slate-800 p-4'>
      <h3 className='mb-3 font-semibold text-slate-100'>Score Legend</h3>
      <div className='grid grid-cols-1 gap-3 text-sm md:grid-cols-2'>
        <div className='flex items-center gap-2'>
          <span className='inline-block rounded bg-green-900 px-2 py-1 text-xs font-semibold text-green-200'>
            Full
          </span>
          <span className='text-slate-300'>
            Full points for that row - its max is 1 or 2, so green is 2.0 where the max is 2
          </span>
        </div>
        <div className='flex items-center gap-2'>
          <span className='inline-block rounded bg-yellow-900 px-2 py-1 text-xs font-semibold text-yellow-200'>
            Partial
          </span>
          <span className='text-slate-300'>
            Partial points - criterion mostly met
          </span>
        </div>
        <div className='flex items-center gap-2'>
          <span className='inline-block rounded bg-red-900 px-2 py-1 text-xs font-semibold text-red-200'>
            None
          </span>
          <span className='text-slate-300'>No points - criterion not met</span>
        </div>
        <div className='flex items-center gap-2'>
          <span className='inline-block rounded bg-yellow-900 px-2 py-1 text-xs font-semibold text-yellow-200'>
            Fraction
          </span>
          <span className='text-slate-300'>
            Hidden-test rows - passed / total x max, to two decimals
          </span>
        </div>
      </div>
    </div>
  );
}
