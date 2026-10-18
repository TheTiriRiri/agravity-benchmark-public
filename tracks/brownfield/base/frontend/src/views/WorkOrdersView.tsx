import React, { useState, useEffect } from 'react';
import {
  WorkOrder,
  WorkOrderStatus,
  WorkOrderPriority,
  Asset,
  Site,
  Part,
  Technician,
  WorkOrderCreatePayload,
  PartRequirement,
} from '../types/api';
import { api } from '../services/api';
import { StatusBadge } from '../components/StatusBadge';
import { PriorityBadge } from '../components/PriorityBadge';
import {
  Plus,
  Search,
  Boxes,
  AlertTriangle,
  X,
  Play,
  Check,
  Ban,
} from 'lucide-react';

interface WorkOrdersViewProps {
  initialStatusFilter?: string;
  selectedOrderId?: string | null;
  onSelectOrder?: (id: string | null) => void;
}

export const WorkOrdersView: React.FC<WorkOrdersViewProps> = ({
  initialStatusFilter,
  selectedOrderId,
  onSelectOrder,
}) => {
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [parts, setParts] = useState<Part[]>([]);
  const [technicians, setTechnicians] = useState<Technician[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState<string>(initialStatusFilter || '');
  const [priorityFilter, setPriorityFilter] = useState<string>('');
  const [siteFilter, setSiteFilter] = useState<string>('');
  const [searchTerm, setSearchTerm] = useState<string>('');

  // Selected work order for detail modal/drawer
  const [activeOrder, setActiveOrder] = useState<WorkOrder | null>(null);
  const [transitioning, setTransitioning] = useState(false);
  const [transitionError, setTransitionError] = useState<string | null>(null);

  // Create work order modal state
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // New work order form state
  const [newTitle, setNewTitle] = useState('');
  const [newAssetId, setNewAssetId] = useState('');
  const [newRequiredSkill, setNewRequiredSkill] = useState('');
  const [newDuration, setNewDuration] = useState<number>(120);
  const [newEarliestStart, setNewEarliestStart] = useState('2026-10-05');
  const [newDueDate, setNewDueDate] = useState('2026-10-06');
  const [newPriority, setNewPriority] = useState<WorkOrderPriority>('medium');
  const [newParts, setNewParts] = useState<PartRequirement[]>([]);

  // Load lookup metadata once
  useEffect(() => {
    const loadMetadata = async () => {
      try {
        const [assetList, siteList, partList, techList] = await Promise.all([
          api.getAssets(),
          api.getSites(),
          api.getParts(),
          api.getTechnicians(),
        ]);
        setAssets(assetList);
        setSites(siteList);
        setParts(partList);
        setTechnicians(techList);
        if (assetList.length > 0) setNewAssetId(assetList[0].id);
      } catch (err: any) {
        setError(err?.message || 'Failed to load metadata');
      }
    };
    loadMetadata();
  }, []);

  // Fetch work orders when filters change
  const fetchOrders = async () => {
    setLoading(true);
    setError(null);
    try {
      const orders = await api.getWorkOrders({
        status: statusFilter || undefined,
        priority: priorityFilter || undefined,
        site_id: siteFilter || undefined,
      });
      setWorkOrders(orders);

      // Keep active order in sync if selected
      if (selectedOrderId) {
        const found = orders.find((o) => o.id === selectedOrderId);
        if (found) setActiveOrder(found);
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to load work orders');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOrders();
  }, [statusFilter, priorityFilter, siteFilter]);

  // Sync if selectedOrderId prop changes from parent
  useEffect(() => {
    if (selectedOrderId) {
      api
        .getWorkOrder(selectedOrderId)
        .then((wo) => setActiveOrder(wo))
        .catch(() => {});
    }
  }, [selectedOrderId]);

  // Handle status transition
  const handleTransition = async (targetStatus: WorkOrderStatus) => {
    if (!activeOrder) return;
    setTransitioning(true);
    setTransitionError(null);
    try {
      const updated = await api.patchWorkOrderStatus(activeOrder.id, targetStatus);
      setActiveOrder(updated);
      await fetchOrders();
    } catch (err: any) {
      setTransitionError(err?.message || 'Status transition failed');
    } finally {
      setTransitioning(false);
    }
  };

  // Add a part row to creation form
  const handleAddPartRow = () => {
    const availablePart = parts.find((p) => !newParts.some((np) => np.part_id === p.id));
    if (availablePart) {
      setNewParts([...newParts, { part_id: availablePart.id, quantity: 1 }]);
    } else if (parts.length > 0) {
      setNewParts([...newParts, { part_id: parts[0].id, quantity: 1 }]);
    }
  };

  const handleRemovePartRow = (index: number) => {
    setNewParts(newParts.filter((_, i) => i !== index));
  };

  const handlePartChange = (index: number, partId: string, quantity: number) => {
    const copy = [...newParts];
    copy[index] = { part_id: partId, quantity };
    setNewParts(copy);
  };

  // Submit Create Work Order Form
  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateLoading(true);
    setCreateError(null);

    const payload: WorkOrderCreatePayload = {
      title: newTitle,
      asset_id: newAssetId,
      required_skill: newRequiredSkill,
      duration_minutes: Number(newDuration),
      earliest_start: newEarliestStart,
      due_date: newDueDate,
      priority: newPriority,
      parts: newParts,
    };

    try {
      const created = await api.createWorkOrder(payload);
      setIsCreateModalOpen(false);
      // Reset fields
      setNewTitle('');
      setNewRequiredSkill('');
      setNewParts([]);
      await fetchOrders();
      setActiveOrder(created);
      onSelectOrder?.(created.id);
    } catch (err: any) {
      // Show exact validation error returned by API
      setCreateError(err?.message || 'Failed to create work order');
    } finally {
      setCreateLoading(false);
    }
  };

  // Lookups
  const assetMap = React.useMemo(() => {
    return assets.reduce((acc, a) => {
      acc[a.id] = a;
      return acc;
    }, {} as Record<string, Asset>);
  }, [assets]);

  const siteMap = React.useMemo(() => {
    return sites.reduce((acc, s) => {
      acc[s.id] = s.name;
      return acc;
    }, {} as Record<string, string>);
  }, [sites]);

  const partMap = React.useMemo(() => {
    return parts.reduce((acc, p) => {
      acc[p.id] = p;
      return acc;
    }, {} as Record<string, Part>);
  }, [parts]);

  const techMap = React.useMemo(() => {
    return technicians.reduce((acc, t) => {
      acc[t.id] = t;
      return acc;
    }, {} as Record<string, Technician>);
  }, [technicians]);

  // Client search filtering
  const filteredOrders = React.useMemo(() => {
    if (!searchTerm.trim()) return workOrders;
    const term = searchTerm.toLowerCase();
    return workOrders.filter((wo) => {
      const asset = assetMap[wo.asset_id];
      return (
        wo.id.toLowerCase().includes(term) ||
        wo.title.toLowerCase().includes(term) ||
        wo.required_skill.toLowerCase().includes(term) ||
        (asset && asset.name.toLowerCase().includes(term))
      );
    });
  }, [workOrders, searchTerm, assetMap]);

  // Legal transitions helper
  const getLegalTransitions = (status: WorkOrderStatus): { target: WorkOrderStatus; label: string; icon: any; color: string }[] => {
    switch (status) {
      case 'scheduled':
        return [
          { target: 'in_progress', label: 'Start Work', icon: Play, color: 'bg-amber-600 hover:bg-amber-500 text-white' },
          { target: 'cancelled', label: 'Cancel Order', icon: Ban, color: 'bg-slate-800 hover:bg-red-900 text-slate-300 hover:text-white border border-slate-700' },
        ];
      case 'in_progress':
        return [
          { target: 'completed', label: 'Mark Completed', icon: Check, color: 'bg-emerald-600 hover:bg-emerald-500 text-white' },
          { target: 'cancelled', label: 'Cancel Order', icon: Ban, color: 'bg-slate-800 hover:bg-red-900 text-slate-300 hover:text-white border border-slate-700' },
        ];
      case 'open':
      case 'blocked':
      case 'unscheduled':
        return [
          { target: 'cancelled', label: 'Cancel Order', icon: Ban, color: 'bg-slate-800 hover:bg-red-900 text-slate-300 hover:text-white border border-slate-700' },
        ];
      case 'completed':
      case 'cancelled':
      default:
        return [];
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Header & Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-slate-900/60 p-4 rounded-xl border border-slate-800">
        <div>
          <h1 className="text-xl font-bold text-white tracking-tight">Work Orders Registry</h1>
          <p className="text-xs text-slate-400">Manage, inspect, and transition maintenance tasks</p>
        </div>

        <button
          onClick={() => {
            setCreateError(null);
            setIsCreateModalOpen(true);
          }}
          className="flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-medium text-xs shadow-lg shadow-cyan-600/20 transition"
        >
          <Plus className="w-4 h-4" />
          <span>New Work Order</span>
        </button>
      </div>

      {/* Filter Controls Bar */}
      <div className="bg-slate-900/60 p-4 rounded-xl border border-slate-800 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {/* Status Filter */}
          <div>
            <label className="block text-[11px] font-mono uppercase text-slate-400 mb-1">Status</label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
            >
              <option value="">All Statuses</option>
              <option value="open">Open</option>
              <option value="scheduled">Scheduled</option>
              <option value="in_progress">In Progress</option>
              <option value="completed">Completed</option>
              <option value="blocked">Blocked</option>
              <option value="unscheduled">Unscheduled</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>

          {/* Priority Filter */}
          <div>
            <label className="block text-[11px] font-mono uppercase text-slate-400 mb-1">Priority</label>
            <select
              value={priorityFilter}
              onChange={(e) => setPriorityFilter(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
            >
              <option value="">All Priorities</option>
              <option value="critical">Critical</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </div>

          {/* Site Filter */}
          <div>
            <label className="block text-[11px] font-mono uppercase text-slate-400 mb-1">Facility Site</label>
            <select
              value={siteFilter}
              onChange={(e) => setSiteFilter(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
            >
              <option value="">All Sites</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.id})
                </option>
              ))}
            </select>
          </div>

          {/* Search Term */}
          <div>
            <label className="block text-[11px] font-mono uppercase text-slate-400 mb-1">Search Keywords</label>
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-500" />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="ID, title, skill, equipment..."
                className="w-full bg-slate-950 border border-slate-700 rounded-lg pl-8 pr-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500 font-mono"
              />
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

      {/* Main Work Orders Table */}
      <div className="bg-slate-900/60 rounded-xl border border-slate-800 overflow-hidden shadow-sm">
        <div className="p-4 border-b border-slate-800 flex items-center justify-between">
          <span className="text-xs font-mono uppercase text-slate-400">
            Showing {filteredOrders.length} work orders
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-950/80 text-xs text-slate-400 uppercase font-mono">
                <th className="py-3 px-4">ID</th>
                <th className="py-3 px-4">Title &amp; Skill</th>
                <th className="py-3 px-4">Asset &amp; Site</th>
                <th className="py-3 px-3">Priority</th>
                <th className="py-3 px-3">Status</th>
                <th className="py-3 px-3">Window</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {loading && filteredOrders.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-500 text-sm">
                    <div className="flex items-center justify-center gap-2">
                      <div className="w-4 h-4 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
                      <span>Loading work orders...</span>
                    </div>
                  </td>
                </tr>
              ) : filteredOrders.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-500 text-sm">
                    No work orders found matching the filter criteria.
                  </td>
                </tr>
              ) : (
                filteredOrders.map((wo) => {
                  const asset = assetMap[wo.asset_id];
                  const siteName = asset ? siteMap[asset.site_id] : 'Unknown';
                  const isSelected = activeOrder?.id === wo.id;

                  return (
                    <tr
                      key={wo.id}
                      onClick={() => {
                        setActiveOrder(wo);
                        onSelectOrder?.(wo.id);
                      }}
                      className={`hover:bg-slate-800/40 transition cursor-pointer ${
                        isSelected ? 'bg-slate-800/60 ring-1 ring-cyan-500/40' : ''
                      }`}
                    >
                      <td className="py-3 px-4 font-mono font-bold text-xs text-cyan-400 whitespace-nowrap">
                        {wo.id}
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-semibold text-slate-200">{wo.title}</div>
                        <div className="text-xs text-slate-400 font-mono mt-0.5">
                          {wo.required_skill} &bull; {wo.duration_minutes} min
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <div className="text-slate-300 font-medium">{asset ? asset.name : wo.asset_id}</div>
                        <div className="text-xs text-slate-500">{siteName}</div>
                      </td>
                      <td className="py-3 px-3 whitespace-nowrap">
                        <PriorityBadge priority={wo.priority} />
                      </td>
                      <td className="py-3 px-3 whitespace-nowrap">
                        <StatusBadge status={wo.status} />
                      </td>
                      <td className="py-3 px-3 font-mono text-xs text-slate-400 whitespace-nowrap">
                        <div>{wo.earliest_start}</div>
                        <div className="text-[11px] text-slate-500">to {wo.due_date}</div>
                      </td>
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setActiveOrder(wo);
                            onSelectOrder?.(wo.id);
                          }}
                          className="px-2.5 py-1 text-xs font-medium text-cyan-400 hover:text-cyan-300 hover:bg-cyan-950/60 rounded border border-cyan-800/40 transition"
                        >
                          Details
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Work Order Detail Modal / Slide-over */}
      {activeOrder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fade-in">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto shadow-2xl p-6 space-y-6">
            {/* Modal Header */}
            <div className="flex items-start justify-between border-b border-slate-800 pb-4">
              <div>
                <div className="flex items-center gap-2.5 mb-1">
                  <span className="font-mono text-sm font-bold px-2 py-0.5 rounded bg-cyan-950 text-cyan-400 border border-cyan-800">
                    {activeOrder.id}
                  </span>
                  <PriorityBadge priority={activeOrder.priority} />
                  <StatusBadge status={activeOrder.status} />
                </div>
                <h2 className="text-lg font-bold text-white tracking-tight">{activeOrder.title}</h2>
              </div>
              <button
                onClick={() => {
                  setActiveOrder(null);
                  onSelectOrder?.(null);
                }}
                className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {transitionError && (
              <div className="p-3 bg-red-950/60 border border-red-800 rounded-lg text-red-300 text-xs flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0" />
                <span>{transitionError}</span>
              </div>
            )}

            {/* Legal Status Transitions */}
            {getLegalTransitions(activeOrder.status).length > 0 && (
              <div className="p-4 bg-slate-950/80 rounded-xl border border-slate-800 space-y-2">
                <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  Available Status Transitions
                </div>
                <div className="flex flex-wrap gap-2">
                  {getLegalTransitions(activeOrder.status).map((t) => {
                    const Icon = t.icon;
                    return (
                      <button
                        key={t.target}
                        onClick={() => handleTransition(t.target)}
                        disabled={transitioning}
                        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition disabled:opacity-50 ${t.color}`}
                      >
                        <Icon className="w-3.5 h-3.5" />
                        <span>{transitioning ? 'Updating...' : t.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Detail Fields Grid - Showing EVERY field per specification */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs font-mono">
              <div className="bg-slate-950/60 p-3 rounded-lg border border-slate-800">
                <div className="text-slate-500 uppercase text-[10px] mb-1">Asset Information</div>
                <div className="font-bold text-slate-200">
                  {assetMap[activeOrder.asset_id]?.name || activeOrder.asset_id}
                </div>
                <div className="text-slate-400 text-[11px] mt-0.5">
                  ID: {activeOrder.asset_id} &bull; Site:{' '}
                  {assetMap[activeOrder.asset_id]
                    ? siteMap[assetMap[activeOrder.asset_id].site_id]
                    : 'Unknown'}
                </div>
              </div>

              <div className="bg-slate-950/60 p-3 rounded-lg border border-slate-800">
                <div className="text-slate-500 uppercase text-[10px] mb-1">Skill &amp; Duration</div>
                <div className="font-bold text-slate-200">Skill: {activeOrder.required_skill}</div>
                <div className="text-slate-400 text-[11px] mt-0.5">
                  Duration: {activeOrder.duration_minutes} minutes ({(activeOrder.duration_minutes / 60).toFixed(1)} hrs)
                </div>
              </div>

              <div className="bg-slate-950/60 p-3 rounded-lg border border-slate-800">
                <div className="text-slate-500 uppercase text-[10px] mb-1">Scheduling Window</div>
                <div className="text-slate-300">Earliest: {activeOrder.earliest_start}</div>
                <div className="text-slate-300 mt-0.5">Due Date: {activeOrder.due_date}</div>
              </div>

              <div className="bg-slate-950/60 p-3 rounded-lg border border-slate-800">
                <div className="text-slate-500 uppercase text-[10px] mb-1">Status Reason</div>
                <div className="font-bold">
                  {activeOrder.status_reason ? (
                    <span className="text-amber-400">{activeOrder.status_reason}</span>
                  ) : (
                    <span className="text-slate-500 italic">null</span>
                  )}
                </div>
              </div>

              <div className="bg-slate-950/60 p-3 rounded-lg border border-slate-800">
                <div className="text-slate-500 uppercase text-[10px] mb-1">Assigned Technician</div>
                <div className="font-bold">
                  {activeOrder.technician_id ? (
                    <span className="text-cyan-400">
                      {techMap[activeOrder.technician_id]?.name || activeOrder.technician_id} (
                      {activeOrder.technician_id})
                    </span>
                  ) : (
                    <span className="text-slate-500 italic">null</span>
                  )}
                </div>
              </div>

              <div className="bg-slate-950/60 p-3 rounded-lg border border-slate-800">
                <div className="text-slate-500 uppercase text-[10px] mb-1">Slot Datetime</div>
                <div className="text-slate-300">
                  Start: {activeOrder.scheduled_start || <span className="text-slate-500 italic">null</span>}
                </div>
                <div className="text-slate-300 mt-0.5">
                  End: {activeOrder.scheduled_end || <span className="text-slate-500 italic">null</span>}
                </div>
              </div>
            </div>

            {/* Required Parts List */}
            <div className="space-y-2">
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                <Boxes className="w-3.5 h-3.5 text-cyan-400" />
                Required Parts ({activeOrder.parts.length})
              </div>

              {activeOrder.parts.length === 0 ? (
                <div className="p-3 bg-slate-950/40 rounded-lg border border-slate-800 text-xs text-slate-500 italic">
                  No replacement parts required for this work order.
                </div>
              ) : (
                <div className="border border-slate-800 rounded-lg overflow-hidden">
                  <table className="w-full text-xs font-mono">
                    <thead className="bg-slate-950 text-slate-400">
                      <tr>
                        <th className="py-2 px-3 text-left">Part ID</th>
                        <th className="py-2 px-3 text-left">Name</th>
                        <th className="py-2 px-3 text-right">Quantity Required</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60 text-slate-300">
                      {activeOrder.parts.map((p) => {
                        const partObj = partMap[p.part_id];
                        return (
                          <tr key={p.part_id}>
                            <td className="py-2 px-3 text-cyan-400 font-bold">{p.part_id}</td>
                            <td className="py-2 px-3">{partObj ? partObj.name : 'Unknown'}</td>
                            <td className="py-2 px-3 text-right font-bold text-white">{p.quantity}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Create Work Order Modal */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fade-in">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-xl w-full max-h-[90vh] overflow-y-auto shadow-2xl p-6 space-y-6">
            <div className="flex items-center justify-between border-b border-slate-800 pb-4">
              <div>
                <h2 className="text-lg font-bold text-white tracking-tight">Create Work Order</h2>
                <p className="text-xs text-slate-400">Define preventive maintenance specifications</p>
              </div>
              <button
                onClick={() => setIsCreateModalOpen(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {createError && (
              <div className="p-3.5 bg-red-950/80 border border-red-700 rounded-xl text-red-200 text-xs flex items-start gap-2.5">
                <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                <div>
                  <div className="font-bold">Validation Error</div>
                  <div className="mt-0.5">{createError}</div>
                </div>
              </div>
            )}

            <form onSubmit={handleCreateSubmit} className="space-y-4">
              {/* Title */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Title <span className="text-rose-400">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="e.g. Inspect compressor pressure valves"
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500"
                />
              </div>

              {/* Asset & Skill */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    Asset <span className="text-rose-400">*</span>
                  </label>
                  <select
                    required
                    value={newAssetId}
                    onChange={(e) => setNewAssetId(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-cyan-500 font-mono"
                  >
                    {assets.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.id} - {a.name} ({siteMap[a.site_id]})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    Required Skill <span className="text-rose-400">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={newRequiredSkill}
                    onChange={(e) => setNewRequiredSkill(e.target.value)}
                    placeholder="e.g. instrumentation, mechanical, electrical"
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-cyan-500 font-mono"
                  />
                </div>
              </div>

              {/* Duration & Priority */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    Duration (minutes, 30&ndash;480, multiple of 30) <span className="text-rose-400">*</span>
                  </label>
                  <input
                    type="number"
                    required
                    step="30"
                    min="30"
                    max="480"
                    value={newDuration}
                    onChange={(e) => setNewDuration(parseInt(e.target.value, 10))}
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-cyan-500 font-mono"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    Priority <span className="text-rose-400">*</span>
                  </label>
                  <select
                    required
                    value={newPriority}
                    onChange={(e) => setNewPriority(e.target.value as WorkOrderPriority)}
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-cyan-500 font-mono"
                  >
                    <option value="critical">Critical</option>
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </select>
                </div>
              </div>

              {/* Earliest Start & Due Date */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    Earliest Start <span className="text-rose-400">*</span>
                  </label>
                  <input
                    type="date"
                    required
                    value={newEarliestStart}
                    onChange={(e) => setNewEarliestStart(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-cyan-500 font-mono"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    Due Date <span className="text-rose-400">*</span>
                  </label>
                  <input
                    type="date"
                    required
                    value={newDueDate}
                    onChange={(e) => setNewDueDate(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-cyan-500 font-mono"
                  />
                </div>
              </div>

              {/* Parts Section */}
              <div className="pt-2 border-t border-slate-800 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-300">Required Parts (Optional)</span>
                  <button
                    type="button"
                    onClick={handleAddPartRow}
                    className="text-xs text-cyan-400 hover:text-cyan-300 font-medium flex items-center gap-1"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add Part</span>
                  </button>
                </div>

                {newParts.map((pRow, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <select
                      value={pRow.part_id}
                      onChange={(e) => handlePartChange(idx, e.target.value, pRow.quantity)}
                      className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white font-mono"
                    >
                      {parts.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.id} - {p.name} (avail: {p.available})
                        </option>
                      ))}
                    </select>

                    <input
                      type="number"
                      min="1"
                      value={pRow.quantity}
                      onChange={(e) =>
                        handlePartChange(idx, pRow.part_id, parseInt(e.target.value, 10) || 1)
                      }
                      className="w-20 bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white font-mono text-center"
                      placeholder="Qty"
                    />

                    <button
                      type="button"
                      onClick={() => handleRemovePartRow(idx)}
                      className="p-1.5 text-slate-500 hover:text-red-400 rounded"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>

              {/* Form Buttons */}
              <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsCreateModalOpen(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-400 hover:text-white rounded-lg transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={createLoading}
                  className="px-5 py-2 text-xs font-medium bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg transition shadow-lg shadow-cyan-600/20 disabled:opacity-50"
                >
                  {createLoading ? 'Submitting...' : 'Create Work Order'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
