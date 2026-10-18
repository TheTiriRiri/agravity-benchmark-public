import React, { useState, useEffect } from 'react';
import {
  ScheduleResult,
  Technician,
  Asset,
  Site,
  WorkOrder,
  PlanResult,
} from '../types/api';
import { api } from '../services/api';
import { StatusBadge } from '../components/StatusBadge';
import { PriorityBadge } from '../components/PriorityBadge';
import {
  Calendar,
  Sparkles,
  AlertTriangle,
  AlertCircle,
  Clock,
  ChevronLeft,
  ChevronRight,
  ShieldAlert,
  CheckCircle2,
} from 'lucide-react';

interface ScheduleViewProps {
  onSelectWorkOrder?: (woId: string) => void;
}

export const ScheduleView: React.FC<ScheduleViewProps> = ({ onSelectWorkOrder }) => {
  const [selectedWeek, setSelectedWeek] = useState('2026-10-05');
  const [schedule, setSchedule] = useState<ScheduleResult | null>(null);
  const [technicians, setTechnicians] = useState<Technician[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [weekOrders, setWeekOrders] = useState<WorkOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [planning, setPlanning] = useState(false);
  const [planSummary, setPlanSummary] = useState<PlanResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Week days Monday to Friday
  const weekDays = React.useMemo(() => {
    try {
      const monday = new Date(selectedWeek + 'T00:00:00');
      const days = [];
      const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
      for (let i = 0; i < 5; i++) {
        const d = new Date(monday);
        d.setDate(monday.getDate() + i);
        const dateStr = d.toISOString().slice(0, 10);
        days.push({
          dateStr,
          dayName: dayNames[i],
          monthDay: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        });
      }
      return days;
    } catch {
      return [];
    }
  }, [selectedWeek]);

  const loadData = async (week: string) => {
    setLoading(true);
    setError(null);
    try {
      const [sched, techList, assetList, siteList, allOrders] = await Promise.all([
        api.getSchedule(week),
        api.getTechnicians(),
        api.getAssets(),
        api.getSites(),
        api.getWorkOrders(),
      ]);
      setSchedule(sched);
      setTechnicians(techList);
      setAssets(assetList);
      setSites(siteList);

      // Identify blocked and unscheduled candidates whose window shares time with week
      const mondayStr = week;
      const fridayDate = new Date(week + 'T00:00:00');
      fridayDate.setDate(fridayDate.getDate() + 4);
      const fridayStr = fridayDate.toISOString().slice(0, 10);

      const candidates = allOrders.filter((wo) => {
        if (wo.status === 'blocked' || wo.status === 'unscheduled') {
          return !(wo.due_date < mondayStr || wo.earliest_start > fridayStr);
        }
        return false;
      });
      setWeekOrders(candidates);
    } catch (err: any) {
      setError(err?.message || 'Failed to load schedule data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData(selectedWeek);
  }, [selectedWeek]);

  const handleGeneratePlan = async () => {
    setPlanning(true);
    setError(null);
    try {
      const planRes = await api.planWeek(selectedWeek);
      setPlanSummary(planRes);
      // Reload schedule and candidates after planning
      await loadData(selectedWeek);
    } catch (err: any) {
      setError(err?.message || 'Failed to generate plan');
    } finally {
      setPlanning(false);
    }
  };

  const changeWeek = (direction: number) => {
    const current = new Date(selectedWeek + 'T00:00:00');
    current.setDate(current.getDate() + direction * 7);
    const newWeekStr = current.toISOString().slice(0, 10);
    setSelectedWeek(newWeekStr);
    setPlanSummary(null);
  };

  const assetMap = React.useMemo(() => {
    return assets.reduce((acc, a) => {
      acc[a.id] = a.name;
      return acc;
    }, {} as Record<string, string>);
  }, [assets]);

  const siteMap = React.useMemo(() => {
    return sites.reduce((acc, s) => {
      acc[s.id] = s.name;
      return acc;
    }, {} as Record<string, string>);
  }, [sites]);

  const techMap = React.useMemo(() => {
    return technicians.reduce((acc, t) => {
      acc[t.id] = t;
      return acc;
    }, {} as Record<string, Technician>);
  }, [technicians]);

  // Blocked and unscheduled orders
  const unassignedOrders = React.useMemo(() => {
    if (planSummary) {
      return planSummary.orders.filter(
        (o) => o.status === 'blocked' || o.status === 'unscheduled'
      );
    }
    return weekOrders;
  }, [planSummary, weekOrders]);

  const formatReason = (reason: string | null) => {
    if (!reason) return 'Unknown Reason';
    switch (reason) {
      case 'parts_unavailable':
        return 'Parts Unavailable';
      case 'no_qualified_technician':
        return 'No Qualified Technician';
      case 'no_capacity':
        return 'Daily Capacity Exceeded (480 min cap / shift limits)';
      default:
        return reason;
    }
  };

  if (loading && !schedule) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="flex items-center gap-3 text-slate-400">
          <div className="w-5 h-5 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
          <span>Loading dispatch schedule...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Top Header Controls */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 bg-slate-900/60 p-4 rounded-xl border border-slate-800">
        <div>
          <h1 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
            Weekly Dispatch Schedule
          </h1>
          <p className="text-xs text-slate-400">
            Timeline of technician assignments and unassigned exceptions
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Week Selector */}
          <div className="flex items-center bg-slate-950 border border-slate-700 rounded-lg p-1">
            <button
              onClick={() => changeWeek(-1)}
              className="p-1.5 hover:bg-slate-800 text-slate-400 hover:text-white rounded transition"
              title="Previous Week"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <div className="flex items-center gap-1.5 px-2">
              <Calendar className="w-3.5 h-3.5 text-cyan-400" />
              <input
                type="date"
                value={selectedWeek}
                onChange={(e) => {
                  if (e.target.value) {
                    setSelectedWeek(e.target.value);
                    setPlanSummary(null);
                  }
                }}
                className="bg-transparent text-xs font-mono text-cyan-300 border-none focus:outline-none focus:ring-0 cursor-pointer"
              />
            </div>
            <button
              onClick={() => changeWeek(1)}
              className="p-1.5 hover:bg-slate-800 text-slate-400 hover:text-white rounded transition"
              title="Next Week"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          {/* Generate Plan Button */}
          <button
            onClick={handleGeneratePlan}
            disabled={planning}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-medium text-xs shadow-lg shadow-cyan-500/20 transition disabled:opacity-50"
          >
            <Sparkles className={`w-4 h-4 ${planning ? 'animate-spin' : ''}`} />
            <span>{planning ? 'Optimizing Schedule...' : 'Generate plan'}</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="p-4 bg-red-950/50 border border-red-800 rounded-lg text-red-300 text-sm flex items-center gap-2">
          <AlertCircle className="w-5 h-5 flex-shrink-0 text-red-400" />
          <span>{error}</span>
        </div>
      )}

      {/* Plan Summary Banner if recently generated */}
      {planSummary && (
        <div className="p-4 bg-cyan-950/30 border border-cyan-800/80 rounded-xl space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold text-cyan-300">
              <CheckCircle2 className="w-4 h-4 text-cyan-400" />
              Plan Generated Successfully for week {planSummary.week_start}
            </div>
            <span className="text-xs text-slate-400 font-mono">
              {planSummary.orders.length} total candidates
            </span>
          </div>
          <div className="grid grid-cols-3 gap-3 text-center text-xs font-mono">
            <div className="bg-slate-900/80 p-2 rounded border border-cyan-900/50">
              <span className="text-slate-400">Scheduled: </span>
              <span className="font-bold text-cyan-400">{planSummary.scheduled.length}</span>
            </div>
            <div className="bg-slate-900/80 p-2 rounded border border-rose-900/50">
              <span className="text-slate-400">Blocked: </span>
              <span className="font-bold text-rose-400">{planSummary.blocked.length}</span>
            </div>
            <div className="bg-slate-900/80 p-2 rounded border border-purple-900/50">
              <span className="text-slate-400">Unscheduled: </span>
              <span className="font-bold text-purple-400">{planSummary.unscheduled.length}</span>
            </div>
          </div>
        </div>
      )}

      {/* Week Timeline */}
      <section className="bg-slate-900/60 rounded-xl border border-slate-800 overflow-hidden shadow-sm">
        <div className="p-4 border-b border-slate-800 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-300 flex items-center gap-2">
            <Clock className="w-4 h-4 text-cyan-400" />
            Technician Dispatch Grid
          </h2>
          <span className="text-xs text-slate-400">Monday &ndash; Friday (30-min grid)</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] border-collapse text-left">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-950/80 text-xs text-slate-400 uppercase font-mono">
                <th className="py-3 px-4 w-72 font-semibold">Technician & Shift</th>
                {weekDays.map((day) => (
                  <th key={day.dateStr} className="py-3 px-3 text-center border-l border-slate-800 font-semibold">
                    <div>{day.dayName}</div>
                    <div className="text-[10px] text-slate-500 font-normal">{day.monthDay}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80 text-sm">
              {schedule?.technicians.map((tSched) => {
                const tech = techMap[tSched.technician_id];
                if (!tech) return null;

                return (
                  <tr key={tech.id} className="hover:bg-slate-800/20 transition">
                    {/* Technician Column */}
                    <td className="py-4 px-4 align-top">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-bold text-cyan-400 px-1.5 py-0.5 rounded bg-cyan-950 border border-cyan-800/50">
                          {tech.id}
                        </span>
                        <span className="font-semibold text-white">{tech.name}</span>
                      </div>
                      <div className="text-xs text-slate-400 mt-1">
                        {siteMap[tech.site_id] || tech.site_id}
                      </div>
                      <div className="text-[11px] font-mono text-slate-400 mt-0.5 flex items-center gap-1">
                        <Clock className="w-3 h-3 text-slate-500" />
                        Shift {tech.shift_start} &ndash; {tech.shift_end}
                      </div>
                      <div className="flex flex-wrap gap-1 mt-2">
                        {tech.skills.map((s) => (
                          <span
                            key={s}
                            className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-slate-950 text-slate-400 border border-slate-800"
                          >
                            {s}
                          </span>
                        ))}
                      </div>
                    </td>

                    {/* Weekday Columns */}
                    {weekDays.map((day) => {
                      // Filter assignments for this technician on this day
                      const dayAssignments = tSched.assignments.filter((a) => {
                        const datePart = a.scheduled_start.slice(0, 10);
                        return datePart === day.dateStr;
                      });

                      return (
                        <td
                          key={day.dateStr}
                          className="py-3 px-2 align-top border-l border-slate-800/80 bg-slate-950/20 min-w-[140px]"
                        >
                          {dayAssignments.length === 0 ? (
                            <div className="h-14 flex items-center justify-center text-[11px] text-slate-600 italic">
                              Idle
                            </div>
                          ) : (
                            <div className="space-y-2">
                              {dayAssignments.map((assign) => {
                                const startTime = assign.scheduled_start.slice(11, 16);
                                const endTime = assign.scheduled_end.slice(11, 16);
                                const assetName = assetMap[assign.asset_id] || assign.asset_id;

                                return (
                                  <div
                                    key={assign.work_order_id}
                                    onClick={() => onSelectWorkOrder?.(assign.work_order_id)}
                                    className="p-2 rounded-lg bg-slate-900 border border-slate-700/80 hover:border-cyan-500/80 shadow-sm transition group cursor-pointer"
                                  >
                                    <div className="flex items-center justify-between gap-1 mb-1">
                                      <span className="font-mono text-[11px] font-bold text-cyan-400 group-hover:text-cyan-300">
                                        {assign.work_order_id}
                                      </span>
                                      <StatusBadge status={assign.status} className="scale-90 origin-right" />
                                    </div>
                                    <div
                                      className="text-xs font-medium text-slate-200 line-clamp-2 leading-tight"
                                      title={assign.title}
                                    >
                                      {assign.title}
                                    </div>
                                    <div className="text-[10px] text-slate-400 mt-1 truncate" title={assetName}>
                                      {assetName}
                                    </div>
                                    <div className="text-[10px] font-mono text-cyan-300/80 mt-1 flex items-center gap-1 bg-slate-950/60 px-1 py-0.5 rounded">
                                      <Clock className="w-2.5 h-2.5" />
                                      {startTime} - {endTime}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Blocked and Unscheduled Orders of that Week */}
      <section className="bg-slate-900/60 rounded-xl border border-slate-800 p-5 space-y-4">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div>
            <h2 className="text-base font-semibold text-white flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-amber-400" />
              Exceptions: Blocked &amp; Unscheduled Orders ({unassignedOrders.length})
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Candidate work orders that could not be scheduled for week {selectedWeek} with their failure reason
            </p>
          </div>
        </div>

        {unassignedOrders.length === 0 ? (
          <div className="p-8 text-center rounded-lg bg-slate-950/40 border border-dashed border-slate-800">
            <CheckCircle2 className="w-8 h-8 text-emerald-400 mx-auto mb-2" />
            <div className="text-sm font-medium text-slate-300">Zero Scheduling Exceptions</div>
            <div className="text-xs text-slate-500 mt-1">
              All candidate orders for this week are scheduled or none are blocked/unscheduled.
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {unassignedOrders.map((wo) => {
              const assetName = assetMap[wo.asset_id] || wo.asset_id;
              const isBlocked = wo.status === 'blocked';

              return (
                <div
                  key={wo.id}
                  onClick={() => onSelectWorkOrder?.(wo.id)}
                  className={`p-4 rounded-xl border transition cursor-pointer ${
                    isBlocked
                      ? 'bg-rose-950/20 border-rose-900/60 hover:border-rose-700'
                      : 'bg-purple-950/20 border-purple-900/60 hover:border-purple-700'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <span className="font-mono text-xs font-bold text-slate-200">{wo.id}</span>
                    <div className="flex items-center gap-1.5">
                      <PriorityBadge priority={wo.priority} />
                      <StatusBadge status={wo.status} />
                    </div>
                  </div>

                  <h3 className="text-sm font-semibold text-white mb-1 line-clamp-1">{wo.title}</h3>
                  <div className="text-xs text-slate-400 mb-2">{assetName}</div>

                  {/* Failure Reason Callout */}
                  <div
                    className={`p-2 rounded-lg text-xs font-medium flex items-start gap-1.5 ${
                      isBlocked
                        ? 'bg-rose-950/60 text-rose-300 border border-rose-800/80'
                        : 'bg-purple-950/60 text-purple-300 border border-purple-800/80'
                    }`}
                  >
                    <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                    <div>
                      <div className="text-[10px] uppercase tracking-wider opacity-75 font-mono">
                        Reason: {wo.status_reason || 'none'}
                      </div>
                      <div className="font-semibold">{formatReason(wo.status_reason)}</div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 mt-3 pt-2 border-t border-slate-800/80 text-[11px] font-mono text-slate-400">
                    <div>
                      Skill: <span className="text-slate-200">{wo.required_skill}</span>
                    </div>
                    <div>
                      Duration: <span className="text-slate-200">{wo.duration_minutes}m</span>
                    </div>
                    <div>
                      Earliest: <span className="text-slate-200">{wo.earliest_start}</span>
                    </div>
                    <div>
                      Due: <span className="text-slate-200">{wo.due_date}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};
