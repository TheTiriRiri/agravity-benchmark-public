import {
  Site,
  Asset,
  Part,
  Technician,
  WorkOrder,
  WorkOrderCreatePayload,
  WorkOrderStatus,
  PlanResult,
  ScheduleResult,
  ApiError
} from '../types/api';

const BASE_URL = '/api/v1';

export class ApiException extends Error {
  code: string;
  statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = 'ApiException';
    this.code = code;
    this.statusCode = statusCode;
  }
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let errorJson: ApiError | null = null;
    try {
      errorJson = await response.json();
    } catch {
      // response wasn't JSON
    }

    if (errorJson && errorJson.error) {
      throw new ApiException(
        errorJson.error.code,
        errorJson.error.message,
        response.status
      );
    }
    throw new ApiException(
      'unknown_error',
      `HTTP Error ${response.status}: ${response.statusText}`,
      response.status
    );
  }
  return response.json();
}

export const api = {
  async getSites(): Promise<Site[]> {
    const res = await fetch(`${BASE_URL}/sites`);
    return handleResponse<Site[]>(res);
  },

  async getAssets(): Promise<Asset[]> {
    const res = await fetch(`${BASE_URL}/assets`);
    return handleResponse<Asset[]>(res);
  },

  async getTechnicians(): Promise<Technician[]> {
    const res = await fetch(`${BASE_URL}/technicians`);
    return handleResponse<Technician[]>(res);
  },

  async getParts(): Promise<Part[]> {
    const res = await fetch(`${BASE_URL}/parts`);
    return handleResponse<Part[]>(res);
  },

  async getWorkOrders(filters?: {
    status?: string;
    priority?: string;
    site_id?: string;
  }): Promise<WorkOrder[]> {
    const params = new URLSearchParams();
    if (filters?.status) params.append('status', filters.status);
    if (filters?.priority) params.append('priority', filters.priority);
    if (filters?.site_id) params.append('site_id', filters.site_id);

    const query = params.toString() ? `?${params.toString()}` : '';
    const res = await fetch(`${BASE_URL}/work-orders${query}`);
    return handleResponse<WorkOrder[]>(res);
  },

  async getWorkOrder(id: string): Promise<WorkOrder> {
    const res = await fetch(`${BASE_URL}/work-orders/${id}`);
    return handleResponse<WorkOrder>(res);
  },

  async createWorkOrder(payload: WorkOrderCreatePayload): Promise<WorkOrder> {
    const res = await fetch(`${BASE_URL}/work-orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return handleResponse<WorkOrder>(res);
  },

  async patchWorkOrderStatus(id: string, targetStatus: WorkOrderStatus): Promise<WorkOrder> {
    const res = await fetch(`${BASE_URL}/work-orders/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: targetStatus }),
    });
    return handleResponse<WorkOrder>(res);
  },

  async planWeek(weekStart: string): Promise<PlanResult> {
    const res = await fetch(`${BASE_URL}/plan?week_start=${encodeURIComponent(weekStart)}`, {
      method: 'POST',
    });
    return handleResponse<PlanResult>(res);
  },

  async getSchedule(weekStart: string): Promise<ScheduleResult> {
    const res = await fetch(`${BASE_URL}/schedule?week_start=${encodeURIComponent(weekStart)}`);
    return handleResponse<ScheduleResult>(res);
  },

  async resetData(): Promise<{ status: string }> {
    const res = await fetch(`${BASE_URL}/reset`, {
      method: 'POST',
    });
    return handleResponse<{ status: string }>(res);
  },
};
