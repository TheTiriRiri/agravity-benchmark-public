import React, { useState, useEffect } from 'react';
import {
  WorkOrder,
  Technician,
  Part,
  Site,
  WorkOrderStatus,
  ScheduleResult,
} from '../types/api';
import { api } from '../services/api';
import { StatusBadge } from '../components/StatusBadge';
import {
  AlertTriangle,
  CheckCircle2,
  Calendar,
  AlertCircle,
  Users,
  Wrench,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';

interface DashboardViewProps {
  onNavigateToWorkOrders: (statusFilter?: string) => void;
  onNavigateToInventory: () => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  onNavigateToWorkOrders,
  onNavigateToInventory,
}) => {
  const [selectedWeek, setSelectedWeek] = useState('2026-10-05');
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [technicians, setTechnicians] = useState<Technician[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [parts, setParts] = useState<Part[]>([]);
  const [schedule, setSchedule] = useState<ScheduleResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = async (week: string) => {
    setLoading(true);
    setError(null);
    try {
      const [wos, techs, siteList, partList, sched] = await Promise.all([
        api.getWorkOrders(),
        api.getTechnicians(),
        api.getSites(),
        api.getParts(),
        api.getSchedule(week),
      ]);
      setWorkOrders(wos);
      setTechnicians(techs);
      setSites(siteList);
      setParts(partList);
      setSchedule(sched);
    } catch (err: any) {
      setError(err?.message || 'Failed to load dashboard data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData(selectedWeek);
  }, [selectedWeek]);

  // Adjust week by 7 days
  const changeWeek = (direction: number) => {
    const current = new Date(selectedWeek + 'T00:00:00');
    current.setDate(current.getDate() + direction * 7);
    const newWeekStr = current.toISOString().slice(0, 10);
    setSelectedWeek(newWeekStr);
  };

  // Status counts
  const statuses: WorkOrderStatus[] = [
    'open',
    'scheduled',
    'in_progress',
    'completed',
    'blocked',
    'unscheduled',
    'cancelled',
  ];

  const statusCounts = statuses.reduce((acc, s) => {
    acc[s] = workOrders.filter((wo) => wo.status === s).length;
    return acc;
  }, {} as Record<WorkOrderStatus, number>);

  // Compute technician assigned hours from schedule
  // Each technician's assignments duration
  const techHoursMap = React.useMemo(() => {
    const map: Record<string, number> = {};
    if (!schedule) return map;

    for (const t of schedule.technicians) {
      let minutes = 0;
      for (const a of t.assignments) {
        const start = new Date(a.scheduled_start).getTime();
        const end = new Date(a.scheduled_end).getTime();
        minutes += Math.max(0, (end - start) / (1000 * 60));
      }
      map[t.technician_id] = minutes / 60; // in hours
    }
    return map;
  }, [schedule]);

  const siteMap = React.useMemo(() => {
    return sites.reduce((acc, s) => {
      acc[s.id] = s.name;
      return acc;
    }, {} as Record<string, string>);
  }, [sites]);

  const lowStockParts = parts.filter((p) => p.low_stock);

  if (loading && workOrders.length === 0) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="flex items-center gap-3 text-slate-400">
          <div className="w-5 h-5 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
          <span>Loading console telemetry...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Top Banner & Week Selector */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-slate-900/60 p-4 rounded-xl border border-slate-800">
        <div>
          <h1 className="text-xl font-bold text-white tracking-tight">Executive Dashboard</h1>
          <p className="text-xs text-slate-400">Preventive maintenance telemetry and dispatch readiness</p>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-slate-400 flex items-center gap-1.5">
            <Calendar className="w-3.5 h-3.5 text-cyan-400" />
            Week Starting:
          </span>
          <div className="flex items-center bg-slate-950 border border-slate-700 rounded-lg p-1">
            <button
              onClick={() => changeWeek(-1)}
              className="p-1 hover:bg-slate-800 text-slate-400 hover:text-white rounded"
              title="Previous Week"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <input
              type="date"
              value={selectedWeek}
              onChange={(e) => {
                if (e.target.value) setSelectedWeek(e.target.value);
              }}
              className="bg-transparent text-xs font-mono text-cyan-300 px-2 py-0.5 border-none focus:outline-none focus:ring-0"
            />
            <button
              onClick={() => changeWeek(1)}
              className="p-1 hover:bg-slate-800 text-slate-400 hover:text-white rounded"
              title="Next Week"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="p-4 bg-red-950/50 border border-red-800 rounded-lg text-red-300 text-sm flex items-center gap-2">
          <AlertCircle className="w-5 h-5 flex-shrink-0 text-red-400" />
          <span>{error}</span>
        </div>
      )}

      {/* 1. Work Orders Counted by Status */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-2">
            <Wrench className="w-4 h-4 text-cyan-400" />
            Work Orders by Status ({workOrders.length} total)
          </h2>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
          {statuses.map((st) => {
            const count = statusCounts[st] || 0;
            return (
              <button
                key={st}
                onClick={() => onNavigateToWorkOrders(st)}
                className="flex flex-col p-3 rounded-xl bg-slate-900/70 hover:bg-slate-800/80 border border-slate-800 hover:border-slate-700 transition text-left group"
              >
                <div className="flex items-center justify-between mb-2">
                  <StatusBadge status={st} />
                </div>
                <span className="text-2xl font-bold font-mono text-white group-hover:text-cyan-400 transition">
                  {count}
                </span>
                <span className="text-[11px] text-slate-500 mt-1">orders</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Grid: Technician Assigned Hours & Low Stock Parts */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* 2. Each Technician's Assigned Hours */}
        <section className="lg:col-span-7 bg-slate-900/60 p-5 rounded-xl border border-slate-800 space-y-4">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <div>
              <h2 className="text-base font-semibold text-white flex items-center gap-2">
                <Users className="w-4 h-4 text-cyan-400" />
                Technician Workload
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">Assigned hours for week {selectedWeek}</p>
            </div>
            <span className="text-xs font-mono px-2 py-1 bg-slate-800 text-slate-300 rounded border border-slate-700">
              Max 40h/wk
            </span>
          </div>

          <div className="space-y-4">
            {technicians.map((tech) => {
              const assignedHours = techHoursMap[tech.id] || 0;
              const maxWeeklyHours = 40; // 5 days * 8h max
              const percent = Math.min(100, Math.round((assignedHours / maxWeeklyHours) * 100));

              return (
                <div
                  key={tech.id}
                  className="p-3.5 rounded-lg bg-slate-950/60 border border-slate-800/80 hover:border-slate-700 transition"
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono text-cyan-400 font-bold">{tech.id}</span>
                        <span className="text-sm font-medium text-slate-200">{tech.name}</span>
                      </div>
                      <div className="text-[11px] text-slate-400 mt-0.5">
                        {siteMap[tech.site_id] || tech.site_id} &bull; Shift {tech.shift_start}–{tech.shift_end}
                      </div>
                    </div>

                    <div className="text-right">
                      <span className="text-base font-bold font-mono text-white">
                        {assignedHours.toFixed(1)}
                      </span>
                      <span className="text-xs text-slate-400 font-mono"> hrs</span>
                      <div className="text-[10px] text-slate-500">{percent}% load</div>
                    </div>
                  </div>

                  {/* Progress bar */}
                  <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${
                        percent >= 90
                          ? 'bg-red-500'
                          : percent >= 75
                          ? 'bg-amber-500'
                          : percent > 0
                          ? 'bg-cyan-500'
                          : 'bg-slate-700'
                      }`}
                      style={{ width: `${percent}%` }}
                    />
                  </div>

                  {/* Skills tags */}
                  <div className="flex flex-wrap gap-1 mt-2.5">
                    {tech.skills.map((s) => (
                      <span
                        key={s}
                        className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-900 text-slate-400 border border-slate-800"
                      >
                        {s}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* 3. Parts that are Low on Stock */}
        <section className="lg:col-span-5 bg-slate-900/60 p-5 rounded-xl border border-slate-800 space-y-4">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <div>
              <h2 className="text-base font-semibold text-white flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-400" />
                Low Stock Alerts
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">Inventory items below minimum reorder threshold</p>
            </div>
            <button
              onClick={onNavigateToInventory}
              className="text-xs text-cyan-400 hover:text-cyan-300 hover:underline font-medium"
            >
              All Inventory &rarr;
            </button>
          </div>

          {lowStockParts.length === 0 ? (
            <div className="p-8 text-center rounded-lg bg-slate-950/40 border border-dashed border-slate-800">
              <CheckCircle2 className="w-8 h-8 text-emerald-400 mx-auto mb-2" />
              <div className="text-sm font-medium text-slate-300">Inventory Healthy</div>
              <div className="text-xs text-slate-500 mt-1">
                All parts meet or exceed required minimum stock levels.
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {lowStockParts.map((part) => (
                <div
                  key={part.id}
                  className="p-3.5 rounded-lg bg-red-950/20 border border-red-900/50 hover:border-red-800/80 transition"
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono font-bold text-red-400">{part.id}</span>
                        <span className="text-sm font-semibold text-white">{part.name}</span>
                      </div>
                      <div className="text-xs text-slate-400 mt-1">
                        Min stock required: <span className="font-mono text-slate-200">{part.min_stock}</span>
                      </div>
                    </div>

                    <span className="px-2 py-0.5 rounded text-[11px] font-bold uppercase bg-red-950 text-red-400 border border-red-800">
                      Low Stock
                    </span>
                  </div>

                  <div className="grid grid-cols-3 gap-2 mt-3 pt-2 border-t border-red-950/80 text-center font-mono text-xs">
                    <div className="bg-slate-950/60 p-1.5 rounded border border-slate-800/80">
                      <div className="text-slate-500 text-[10px]">ON HAND</div>
                      <div className="text-slate-300 font-bold">{part.on_hand}</div>
                    </div>
                    <div className="bg-slate-950/60 p-1.5 rounded border border-slate-800/80">
                      <div className="text-slate-500 text-[10px]">RESERVED</div>
                      <div className="text-amber-400 font-bold">{part.reserved}</div>
                    </div>
                    <div className="bg-red-950/40 p-1.5 rounded border border-red-900/60">
                      <div className="text-red-400 text-[10px]">AVAILABLE</div>
                      <div className="text-red-300 font-bold">{part.available}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
