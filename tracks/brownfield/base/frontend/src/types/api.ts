export interface Site {
  id: string;
  name: string;
}

export interface Asset {
  id: string;
  name: string;
  site_id: string;
}

export interface Part {
  id: string;
  name: string;
  on_hand: number;
  reserved: number;
  min_stock: number;
  available: number;
  low_stock: boolean;
}

export interface Technician {
  id: string;
  name: string;
  site_id: string;
  skills: string[];
  shift_start: string;
  shift_end: string;
}

export interface PartRequirement {
  part_id: string;
  quantity: number;
}

export type WorkOrderPriority = 'critical' | 'high' | 'medium' | 'low';

export type WorkOrderStatus =
  | 'open'
  | 'scheduled'
  | 'blocked'
  | 'unscheduled'
  | 'in_progress'
  | 'completed'
  | 'cancelled';

export interface WorkOrder {
  id: string;
  title: string;
  asset_id: string;
  required_skill: string;
  duration_minutes: number;
  earliest_start: string;
  due_date: string;
  priority: WorkOrderPriority;
  parts: PartRequirement[];
  status: WorkOrderStatus;
  status_reason: string | null;
  technician_id: string | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
}

export interface WorkOrderCreatePayload {
  title: string;
  asset_id: string;
  required_skill: string;
  duration_minutes: number;
  earliest_start: string;
  due_date: string;
  priority: WorkOrderPriority;
  parts?: PartRequirement[];
}

export interface PlanResult {
  week_start: string;
  scheduled: string[];
  blocked: string[];
  unscheduled: string[];
  orders: WorkOrder[];
}

export interface ScheduleAssignment {
  work_order_id: string;
  title: string;
  asset_id: string;
  status: WorkOrderStatus;
  scheduled_start: string;
  scheduled_end: string;
}

export interface ScheduleTechnician {
  technician_id: string;
  assignments: ScheduleAssignment[];
}

export interface ScheduleResult {
  week_start: string;
  technicians: ScheduleTechnician[];
}

export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}
