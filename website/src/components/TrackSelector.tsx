interface Props {
  track: "classic" | "hard" | "brownfield";
  onTrackChange: (track: "classic" | "hard" | "brownfield") => void;
}

export default function TrackSelector({ track, onTrackChange }: Props) {
  return (
    <div role="tablist" className="inline-flex rounded-lg bg-slate-800 p-1 border border-slate-700">
      <button
        role="tab"
        aria-selected={track === "classic"}
        onClick={() => onTrackChange("classic")}
        className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
          track === "classic"
            ? "bg-blue-600 text-white shadow-sm"
            : "text-slate-400 hover:text-slate-200"
        }`}
      >
        Classic
      </button>
      <button
        role="tab"
        aria-selected={track === "hard"}
        onClick={() => onTrackChange("hard")}
        className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
          track === "hard"
            ? "bg-amber-600 text-white shadow-sm"
            : "text-slate-400 hover:text-slate-200"
        }`}
      >
        Hard
      </button>
      <button
        role="tab"
        aria-selected={track === "brownfield"}
        onClick={() => onTrackChange("brownfield")}
        className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
          track === "brownfield"
            ? "bg-emerald-600 text-white shadow-sm"
            : "text-slate-400 hover:text-slate-200"
        }`}
      >
        Brownfield
      </button>
    </div>
  );
}
