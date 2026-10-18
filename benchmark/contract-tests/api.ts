/**
 * Shared plumbing for the hidden contract tests. Every file talks to one
 * backend, named by CONTRACT_BASE_URL, and starts each test from the seed.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const BASE = process.env.CONTRACT_BASE_URL;
if (!BASE) throw new Error("CONTRACT_BASE_URL is not set");

const REQUEST_TIMEOUT_MS = 10_000;
const SEED_PATH = process.env.CONTRACT_SEED_PATH ?? new URL("../context/seed.json", import.meta.url);

export const SEED_WEEK = "2026-10-05";
/** A week no seeded order's window reaches, so only test-created orders are candidates. */
export const EMPTY_WEEK = "2026-10-12";

export interface PartLine { part_id: string; quantity: number }
export interface WorkOrder {
  id: string; title: string; asset_id: string; required_skill: string; duration_minutes: number;
  earliest_start: string; due_date: string; priority: string; parts: PartLine[];
  status: string; status_reason: string | null; technician_id: string | null;
  scheduled_start: string | null; scheduled_end: string | null;
}
export interface Part { id: string; name: string; on_hand: number; reserved: number; min_stock: number; available: number; low_stock: boolean }
export interface Technician { id: string; name: string; site_id: string; skills: string[]; shift_start: string; shift_end: string }
export interface PlanResult { week_start: string; scheduled: string[]; blocked: string[]; unscheduled: string[]; orders: WorkOrder[] }
export interface Assignment { work_order_id: string; title: string; asset_id: string; status: string; scheduled_start: string; scheduled_end: string }
export interface Schedule { week_start: string; technicians: { technician_id: string; assignments: Assignment[] }[] }
export interface Seed {
  sites: { id: string; name: string }[];
  assets: { id: string; name: string; site_id: string }[];
  technicians: Technician[];
  parts: Omit<Part, "available" | "low_stock">[];
  work_orders: WorkOrder[];
}

export const seed: Seed = JSON.parse(readFileSync(SEED_PATH, "utf8"));

/** A seeded work order by id — never by array position, so the seed can grow in the middle. */
export function seedOrder(id: string): WorkOrder {
  const found = seed.work_orders.find((o) => o.id === id);
  assert.ok(found, `${id} is not in the seed`);
  return found;
}

export interface Reply<T = any> { status: number; body: T }

export async function call<T = any>(method: string, path: string, body?: unknown): Promise<Reply<T>> {
  let response: Response;
  let text: string;
  try {
    response = await fetch(`${BASE}/api/v1${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    text = await response.text();
  } catch (error) {
    // A timeout or a refused connection names its endpoint, like an assertion
    // about a status does: `POST /reset: TimeoutError The operation was aborted due to timeout`.
    const { name, message } = error instanceof Error ? error : { name: "Error", message: String(error) };
    throw new Error(`${method} ${path}: ${name} ${message}`, { cause: error });
  }
  let parsed: unknown = null;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed as T };
}

export async function reset(): Promise<void> {
  const reply = await call("POST", "/reset");
  assert.equal(reply.status, 200, "POST /reset must answer 200");
}

export async function ok<T = any>(method: string, path: string, body?: unknown, status = 200): Promise<T> {
  const reply = await call<T>(method, path, body);
  assert.equal(reply.status, status, `${method} ${path} answered ${reply.status}: ${JSON.stringify(reply.body)}`);
  return reply.body;
}

export function assertError(reply: Reply, status: number, code: string): void {
  assert.equal(reply.status, status, `expected HTTP ${status}, got ${reply.status}: ${JSON.stringify(reply.body)}`);
  assert.equal(reply.body?.error?.code, code, `expected error.code ${code}: ${JSON.stringify(reply.body)}`);
  assert.deepEqual(Object.keys(reply.body), ["error"], "an error body holds `error` and nothing else");
  assert.deepEqual(Object.keys(reply.body.error).sort(), ["code", "message"]);
  assert.equal(typeof reply.body.error.message, "string");
  assert.notEqual(reply.body.error.message, "", "error.message must not be empty");
}

export interface OrderInput {
  title?: string; asset_id: string; required_skill: string; duration_minutes: number;
  earliest_start: string; due_date: string; priority?: string; parts?: PartLine[];
}

export async function createOrder(input: OrderInput): Promise<WorkOrder> {
  return ok<WorkOrder>("POST", "/work-orders", { title: "Contract test order", priority: "medium", ...input }, 201);
}

export const plan = (week: string) => ok<PlanResult>("POST", `/plan?week_start=${week}`);
export const schedule = (week: string) => ok<Schedule>("GET", `/schedule?week_start=${week}`);
export const order = (id: string) => ok<WorkOrder>("GET", `/work-orders/${id}`);
export const setStatus = (id: string, status: string) => ok<WorkOrder>("PATCH", `/work-orders/${id}`, { status });

export async function part(id: string): Promise<Part> {
  const parts = await ok<Part[]>("GET", "/parts");
  const found = parts.find((p) => p.id === id);
  assert.ok(found, `part ${id} is missing from GET /parts`);
  return found;
}

export function slot(o: WorkOrder): string {
  return `${o.technician_id} ${o.scheduled_start} ${o.scheduled_end}`;
}

export function assertSlot(o: WorkOrder, technician: string, start: string, end: string): void {
  assert.equal(o.status, "scheduled", `${o.id} should be scheduled, is ${o.status}/${o.status_reason}`);
  assert.equal(slot(o), `${technician} ${start} ${end}`, `${o.id} landed in the wrong slot`);
  assert.equal(o.status_reason, null);
}

export function assertNoSlot(o: WorkOrder, status: string, reason: string): void {
  assert.equal(o.status, status, `${o.id} should be ${status}, is ${o.status}`);
  assert.equal(o.status_reason, reason);
  assert.equal(o.technician_id, null);
  assert.equal(o.scheduled_start, null);
  assert.equal(o.scheduled_end, null);
}
