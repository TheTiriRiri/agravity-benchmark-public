import React, { useState, useEffect } from 'react';
import { Part } from '../types/api';
import { api } from '../services/api';
import {
  AlertTriangle,
  CheckCircle2,
  Search,
  RefreshCw,
  Package,
  Layers,
  Archive,
  Check,
} from 'lucide-react';

export const InventoryView: React.FC = () => {
  const [parts, setParts] = useState<Part[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [onlyLowStock, setOnlyLowStock] = useState(false);

  const loadParts = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getParts();
      setParts(data);
    } catch (err: any) {
      setError(err?.message || 'Failed to load inventory');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadParts();
  }, []);

  const filteredParts = React.useMemo(() => {
    return parts.filter((part) => {
      if (onlyLowStock && !part.low_stock) return false;
      if (searchTerm.trim()) {
        const term = searchTerm.toLowerCase();
        return (
          part.id.toLowerCase().includes(term) ||
          part.name.toLowerCase().includes(term)
        );
      }
      return true;
    });
  }, [parts, onlyLowStock, searchTerm]);

  // Metric aggregates
  const totalOnHand = parts.reduce((sum, p) => sum + p.on_hand, 0);
  const totalReserved = parts.reduce((sum, p) => sum + p.reserved, 0);
  const totalAvailable = parts.reduce((sum, p) => sum + p.available, 0);
  const lowStockCount = parts.filter((p) => p.low_stock).length;

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-slate-900/60 p-4 rounded-xl border border-slate-800">
        <div>
          <h1 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
            Spare Parts Inventory
          </h1>
          <p className="text-xs text-slate-400">
            Real-time stock on hand, reservations by scheduled work orders, and reorder thresholds
          </p>
        </div>

        <button
          onClick={loadParts}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium border border-slate-700 transition"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-cyan-400' : ''}`} />
          <span>Refresh Stock</span>
        </button>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <div className="bg-slate-900/60 p-4 rounded-xl border border-slate-800 flex items-center gap-3">
          <div className="p-2.5 rounded-lg bg-blue-950/60 text-blue-400 border border-blue-800/50">
            <Archive className="w-5 h-5" />
          </div>
          <div>
            <div className="text-[11px] font-mono text-slate-400 uppercase">Total SKUs</div>
            <div className="text-xl font-bold font-mono text-white">{parts.length}</div>
          </div>
        </div>

        <div className="bg-slate-900/60 p-4 rounded-xl border border-slate-800 flex items-center gap-3">
          <div className="p-2.5 rounded-lg bg-cyan-950/60 text-cyan-400 border border-cyan-800/50">
            <Package className="w-5 h-5" />
          </div>
          <div>
            <div className="text-[11px] font-mono text-slate-400 uppercase">On Hand</div>
            <div className="text-xl font-bold font-mono text-white">{totalOnHand}</div>
          </div>
        </div>

        <div className="bg-slate-900/60 p-4 rounded-xl border border-slate-800 flex items-center gap-3">
          <div className="p-2.5 rounded-lg bg-amber-950/60 text-amber-400 border border-amber-800/50">
            <Layers className="w-5 h-5" />
          </div>
          <div>
            <div className="text-[11px] font-mono text-slate-400 uppercase">Reserved</div>
            <div className="text-xl font-bold font-mono text-amber-400">{totalReserved}</div>
          </div>
        </div>

        <div className="bg-slate-900/60 p-4 rounded-xl border border-slate-800 flex items-center gap-3">
          <div className="p-2.5 rounded-lg bg-emerald-950/60 text-emerald-400 border border-emerald-800/50">
            <Check className="w-5 h-5" />
          </div>
          <div>
            <div className="text-[11px] font-mono text-slate-400 uppercase">Available</div>
            <div className="text-xl font-bold font-mono text-emerald-400">{totalAvailable}</div>
          </div>
        </div>

        <div className="bg-slate-900/60 p-4 rounded-xl border border-slate-800 flex items-center gap-3">
          <div
            className={`p-2.5 rounded-lg border ${
              lowStockCount > 0
                ? 'bg-rose-950/60 text-rose-400 border-rose-800/50 animate-pulse'
                : 'bg-emerald-950/60 text-emerald-400 border-emerald-800/50'
            }`}
          >
            {lowStockCount > 0 ? <AlertTriangle className="w-5 h-5" /> : <CheckCircle2 className="w-5 h-5" />}
          </div>
          <div>
            <div className="text-[11px] font-mono text-slate-400 uppercase">Low Stock</div>
            <div
              className={`text-xl font-bold font-mono ${
                lowStockCount > 0 ? 'text-rose-400' : 'text-emerald-400'
              }`}
            >
              {lowStockCount}
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div className="p-4 bg-red-950/50 border border-red-800 rounded-lg text-red-300 text-sm flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 text-red-400" />
          <span>{error}</span>
        </div>
      )}

      {/* Filter and Search Bar */}
      <div className="bg-slate-900/60 p-4 rounded-xl border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-500" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search parts by ID or description..."
            className="w-full bg-slate-950 border border-slate-700 rounded-lg pl-8 pr-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 font-mono"
          />
        </div>

        <label className="flex items-center gap-2 text-xs font-medium text-slate-300 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={onlyLowStock}
            onChange={(e) => setOnlyLowStock(e.target.checked)}
            className="rounded bg-slate-950 border-slate-700 text-cyan-600 focus:ring-0"
          />
          <span>Show low-stock items only</span>
        </label>
      </div>

      {/* Parts Table */}
      <div className="bg-slate-900/60 rounded-xl border border-slate-800 overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-950/80 text-xs text-slate-400 uppercase font-mono">
                <th className="py-3 px-4">Part ID</th>
                <th className="py-3 px-4">Description / Name</th>
                <th className="py-3 px-4 text-center">On Hand</th>
                <th className="py-3 px-4 text-center">Reserved</th>
                <th className="py-3 px-4 text-center">Available</th>
                <th className="py-3 px-4 text-center">Min Stock</th>
                <th className="py-3 px-4 text-right">Status Flag</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {filteredParts.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-500 text-sm">
                    No parts match the selected filters.
                  </td>
                </tr>
              ) : (
                filteredParts.map((part) => {
                  return (
                    <tr
                      key={part.id}
                      className={`hover:bg-slate-800/30 transition ${
                        part.low_stock ? 'bg-rose-950/10' : ''
                      }`}
                    >
                      <td className="py-3 px-4 font-mono font-bold text-xs text-cyan-400 whitespace-nowrap">
                        {part.id}
                      </td>
                      <td className="py-3 px-4 font-semibold text-slate-200">
                        {part.name}
                      </td>
                      <td className="py-3 px-4 text-center font-mono text-slate-300">
                        {part.on_hand}
                      </td>
                      <td className="py-3 px-4 text-center font-mono">
                        <span
                          className={
                            part.reserved > 0
                              ? 'text-amber-400 font-bold'
                              : 'text-slate-500'
                          }
                        >
                          {part.reserved}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-center font-mono">
                        <span
                          className={`font-bold ${
                            part.low_stock ? 'text-rose-400' : 'text-emerald-400'
                          }`}
                        >
                          {part.available}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-center font-mono text-slate-400">
                        {part.min_stock}
                      </td>
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        {part.low_stock ? (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold uppercase bg-rose-950/80 text-rose-400 border border-rose-800 animate-pulse">
                            <AlertTriangle className="w-3 h-3" />
                            Low Stock
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-950/40 text-emerald-400 border border-emerald-800/40">
                            <CheckCircle2 className="w-3 h-3" />
                            Normal
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
