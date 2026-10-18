/**
 * Computes technician workload in minutes from scheduled order assignments.
 */
export function loadsFromOrders(
  orders: Array<{ status?: string; technician_id?: string | null; duration_minutes?: number }>,
  technicianIds: readonly string[] = ["T-001", "T-002", "T-003", "T-004"],
): Record<string, number> {
  const loads: Record<string, number> = {};
  for (const t of technicianIds) {
    loads[t] = 0;
  }
  for (const o of orders ?? []) {
    if (o.status === "scheduled" && o.technician_id) {
      loads[o.technician_id] = (loads[o.technician_id] ?? 0) + (o.duration_minutes ?? 0);
    }
  }
  return loads;
}
