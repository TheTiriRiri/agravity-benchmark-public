import React from 'react';
import { WorkOrderPriority } from '../types/api';

interface PriorityBadgeProps {
  priority: WorkOrderPriority;
  className?: string;
}

export const PriorityBadge: React.FC<PriorityBadgeProps> = ({ priority, className = '' }) => {
  const styles: Record<WorkOrderPriority, { label: string; bg: string; text: string; border: string }> = {
    critical: {
      label: 'Critical',
      bg: 'bg-red-950/60',
      text: 'text-red-400',
      border: 'border-red-700/60',
    },
    high: {
      label: 'High',
      bg: 'bg-orange-950/60',
      text: 'text-orange-400',
      border: 'border-orange-700/60',
    },
    medium: {
      label: 'Medium',
      bg: 'bg-amber-950/40',
      text: 'text-amber-300',
      border: 'border-amber-800/50',
    },
    low: {
      label: 'Low',
      bg: 'bg-slate-800/60',
      text: 'text-slate-300',
      border: 'border-slate-700',
    },
  };

  const current = styles[priority] || {
    label: priority,
    bg: 'bg-slate-800',
    text: 'text-slate-300',
    border: 'border-slate-700',
  };

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold uppercase tracking-wider border ${current.bg} ${current.text} ${current.border} ${className}`}
    >
      {current.label}
    </span>
  );
};
