# Maintenance Console: Workload Balancing Feature

> **Execution Constraint:** Do NOT use subagents or invoke_subagent. Make all backend, frontend and test changes directly in the main session.

You are working on an existing full-stack application for industrial maintenance planning, Meridian Maintenance Console. The codebase has a running FastAPI backend in `backend/` and a React TypeScript SPA in `frontend/`.

Your task is to implement a new feature: **workload-balanced schedule planning**.

Follow the conventions and structure of the existing codebase. Work in the current directory, do not ask questions, and ensure existing behavior and tests remain intact.

---

## 1. Feature Requirements

### 1.1 Planning Strategy Parameter
The weekly planner endpoint `POST /api/v1/plan` currently plans work orders using an earliest-completion approach.
Extend `POST /api/v1/plan` to support an optional query parameter `strategy`:

- `POST /api/v1/plan?week_start=YYYY-MM-DD&strategy=balanced`
  Generates a schedule balancing total scheduled workload (in minutes) across qualified technicians over the week.
- `POST /api/v1/plan?week_start=YYYY-MM-DD&strategy=earliest`
  Explicitly selects the standard earliest-completion strategy.
- When `strategy` is omitted (e.g. `POST /api/v1/plan?week_start=YYYY-MM-DD`), the default strategy is `earliest`.

### 1.2 Technician Load in Plan Response
When `strategy` is explicitly provided in the query string (`?strategy=earliest` or `?strategy=balanced`), the JSON response of `POST /api/v1/plan` must include an additional field:

- `technician_load`: an object mapping every technician ID in the system (e.g. `"T-001"`, `"T-002"`, ...) to their total scheduled minutes for that planned week (integer).
- If a technician has no orders scheduled in that week, their entry in `technician_load` must have value `0`.
- The sum of all values in `technician_load` must equal the sum of duration minutes of all scheduled work orders in the week.

### 1.3 Strict Backwards Compatibility
Backwards compatibility for existing clients is a critical requirement:
- Calling `POST /api/v1/plan` **without** the `strategy` query parameter must return the exact historical response schema: `blocked`, `orders`, `scheduled`, `unscheduled`, and `week_start`. The `technician_load` field must be **omitted** when `strategy` is not specified.
- The schedule produced when `strategy` is omitted must be byte-for-byte identical to the historical `earliest` schedule.
- All existing API endpoints, data models, and constraints (shift hours, qualifications, part reservations, status transitions) must continue to function unchanged.

---

## 2. Scope and Diff Locality

Keep changes localized to the modules responsible for planning, routing, data contracts, and tests:
- Backend target modules: `backend/app/planner*`, `backend/app/routes*`, `backend/app/schemas*`
- Backend tests: `backend/tests/**`
- Frontend API client & types: `frontend/src/services/**`, `frontend/src/types/**`
- Frontend views (optional): `frontend/src/views/**`

Do not modify untouched core files (such as `backend/app/main.py`, `backend/app/store.py`, `frontend/package.json`, or configuration files). Unnecessary changes outside the modules above are penalized under diff locality.

Updating the frontend UI to expose the strategy selection (e.g. on the schedule view) is optional; if present, it is evaluated under visual design.

---

## 3. Verification

Before completing your work, run tests to verify that:
1. All existing functionality and regression tests continue to pass.
2. The new `strategy=balanced` option successfully distributes workload across qualified technicians.
3. `POST /plan` without `strategy` maintains strict backwards compatibility.
4. Added tests in `backend/tests/**` exercise the new strategy and response fields.
