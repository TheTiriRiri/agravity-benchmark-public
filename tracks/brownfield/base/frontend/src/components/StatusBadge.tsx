import React from 'react';
import { WorkOrderStatus } from '../types/api';

interface StatusBadgeProps {
  status: WorkOrderStatus;
  className?: string;
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status, className = '' }) => {
  const styles: Record<WorkOrderStatus, { label: string; bg: string; text: string; border: string; dot: string }> = {
    open: {
      label: 'Open',
      bg: 'bg-blue-950/60',
      text: 'text-blue-400',
      border: 'border-blue-800/60',
      dot: 'bg-blue-400',
    },
    scheduled: {
      label: 'Scheduled',
      bg: 'bg-cyan-950/60',
      text: 'text-cyan-300',
      border: 'border-cyan-700/60',
      dot: 'bg-cyan-400',
    },
    in_progress: {
      label: 'In Progress',
      bg: 'bg-amber-950/60',
      text: 'text-amber-400',
      border: 'border-amber-700/60',
      dot: 'bg-amber-400 animate-pulse',
    },
    completed: {
      label: 'Completed',
      bg: 'bg-emerald-950/60',
      text: 'text-emerald-400',
      border: 'border-emerald-700/60',
      dot: 'bg-emerald-400',
    },
    blocked: {
      label: 'Blocked',
      bg: 'bg-rose-950/60',
      text: 'text-rose-400',
      border: 'border-rose-800/60',
      dot: 'bg-rose-500',
    },
    unscheduled: {
      label: 'Unscheduled',
      bg: 'bg-purple-950/60',
      text: 'text-purple-300',
      border: 'border-purple-800/60',
      dot: 'bg-purple-400',
    },
    cancelled: {
      label: 'Cancelled',
      bg: 'bg-slate-800/80',
      text: 'text-slate-400',
      border: 'border-slate-700',
      dot: 'bg-slate-500',
    },
  };

  const current = styles[status] || {
    label: status,
    bg: 'bg-slate-800',
    text: 'text-slate-300',
    border: 'border-slate-700',
    dot: 'bg-slate-400',
  };

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border ${current.bg} ${current.text} ${current.border} ${className}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${current.dot}`} />
      {current.label}
    </span>
  );
};
