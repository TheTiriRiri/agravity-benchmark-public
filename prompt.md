> **Execution Constraint:** Do NOT use subagents or invoke_subagent. Implement all backend and frontend files directly in the main session.

Build "Meridian Maintenance Console": a small full-stack web application that plans preventive-maintenance work orders for technicians across industrial sites. Work in the current directory, do not ask questions, and finish with everything runnable using exactly the commands below. The result is verified automatically against this specification, so follow every path, field name, status code and rule literally.

## 1. Stack and run contract

Two directories at the repository root, plus a README:

```
backend/   Python 3.11, FastAPI, pydantic
           requirements.txt ; app/main.py exposing the ASGI object `app`
           python3 -m venv .venv
           .venv/bin/pip install -r requirements.txt
           .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 5100
frontend/  React, TypeScript, Vite, Tailwind CSS
           npm install && npm run build
           npm run dev        (port 5173, proxies /api to http://localhost:5100)
README.md  the commands above
```

- The system Python refuses a bare `pip install` (PEP 668), so use the virtual environment exactly as shown. All commands for `backend/` run from inside `backend/`, and the ones for `frontend/` from inside `frontend/`.
- `requirements.txt` must list everything the backend needs, including `uvicorn`. It lists only packages from PyPI, no local paths (such as `.` or `-e .`).
- Backend state is **in memory only**: no database, no files written at run time. Restarting the backend returns the seed data of section 6.
- No authentication, no internationalisation, no Docker, no calls to any LLM or external API.
- The frontend reads all domain data from the API. Do not copy the seed into the frontend.

## 2. Conventions

- Ids are strings: a prefix and a zero-padded three-digit number — `S-001` (site), `A-001` (asset), `P-001` (part), `T-001` (technician), `WO-001` (work order). They compare as plain strings. A newly created work order gets the next free number: with the seed loaded, the first one created is `WO-015`.
- Dates are `YYYY-MM-DD`. Datetimes are `YYYY-MM-DDTHH:MM:SS`, local and naive (no time zone, no `Z`). Shift times are `HH:MM`.
- Everything lives on a 30-minute grid: shift boundaries, durations, and every start time the planner may choose.
- A field with no value is JSON `null`. Never omit it and never use `""`.
- Every response contains **exactly** the fields shown in sections 3 and 4 — no extra fields such as timestamps or nested copies of related resources, and none left out. Responses are compared field by field.
- Every list response is a bare JSON array sorted by `id` ascending, unless stated otherwise.

## 3. Resources

```json
{"id": "S-001", "name": "Northgate Plant"}
```
```json
{"id": "A-001", "name": "Conveyor Line 1", "site_id": "S-001"}
```
```json
{"id": "P-001", "name": "Drive belt", "on_hand": 6, "reserved": 0, "min_stock": 2, "available": 6, "low_stock": false}
```
```json
{"id": "T-001", "name": "Ada Lindqvist", "site_id": "S-001", "skills": ["electrical", "instrumentation"], "shift_start": "07:00", "shift_end": "17:00"}
```
```json
{"id": "WO-001", "title": "Calibrate cabinet sensors", "asset_id": "A-004", "required_skill": "instrumentation",
 "duration_minutes": 240, "earliest_start": "2026-10-05", "due_date": "2026-10-05", "priority": "critical",
 "parts": [{"part_id": "P-004", "quantity": 1}],
 "status": "scheduled", "status_reason": null, "technician_id": "T-001",
 "scheduled_start": "2026-10-05T07:00:00", "scheduled_end": "2026-10-05T11:00:00"}
```

- Part: `available = on_hand - reserved`, and `low_stock` is true exactly when `available < min_stock`. Both are computed for every response; they are not stored in the seed.
- Technician: the shift is the same Monday to Friday. Nobody works at weekends.
- Work order `priority`: `critical` > `high` > `medium` > `low`.
- Work order `status`: `open`, `scheduled`, `blocked`, `unscheduled`, `in_progress`, `completed`, `cancelled`.
- `status_reason` is `null` except: `blocked` → `"parts_unavailable"`; `unscheduled` → `"no_qualified_technician"` or `"no_capacity"`.
- A work order holds a **reservation** of its parts exactly while it is `scheduled` or `in_progress`. A part's `reserved` is the sum of the quantities of all such orders.
- `earliest_start` and `due_date` form an inclusive window of days in which the work may be done.

## 4. API

All paths are under `/api/v1`.

| Method and path | Request | Success |
|---|---|---|
| `GET /health` | – | 200 `{"status": "ok"}` |
| `POST /reset` | – | 200 `{"status": "ok"}`; all state is the seed again |
| `GET /sites`, `GET /assets`, `GET /technicians`, `GET /parts` | – | 200 array |
| `GET /work-orders` | optional query `status`, `priority`, `site_id` (the site of the order's asset); filters combine with AND | 200 array |
| `POST /work-orders` | body below | 201 the created work order |
| `GET /work-orders/{id}` | – | 200 work order |
| `PATCH /work-orders/{id}` | `{"status": "<target>"}` | 200 the updated work order |
| `POST /plan?week_start=YYYY-MM-DD` | – | 200 plan result |
| `GET /schedule?week_start=YYYY-MM-DD` | – | 200 schedule |

**Errors.** Every error response, validation errors included, has this body and nothing else:

```json
{"error": {"code": "validation_error", "message": "duration_minutes must be a multiple of 30"}}
```

`code` is one of `not_found` (HTTP 404, unknown work order id), `invalid_transition` (HTTP 409), `validation_error` (HTTP 422). `message` is any non-empty human-readable string. FastAPI's default `{"detail": ...}` body is not acceptable.

**`POST /work-orders`.** Required: `title`, `asset_id`, `required_skill`, `duration_minutes`, `earliest_start`, `due_date`, `priority`. Optional: `parts` (default `[]`), a list of `{"part_id", "quantity"}`. The order is created with `status: "open"` and `null` in `status_reason`, `technician_id`, `scheduled_start`, `scheduled_end`. Answer 422 and create nothing when: a required field is missing or has the wrong type; `title` or `required_skill` is empty; `duration_minutes` is below 30, above 480 or not a multiple of 30; a date is malformed; `due_date` is before `earliest_start`; `priority` is not one of the four; a `quantity` is below 1; the same `part_id` appears twice; `asset_id` or a `part_id` does not exist.

**`PATCH /work-orders/{id}`.** Only the status changes, and only along these transitions:

| From | To | Parts (per listed part) | Slot fields |
|---|---|---|---|
| `scheduled` | `in_progress` | unchanged | kept |
| `in_progress` | `completed` | `on_hand -= quantity` and `reserved -= quantity` | kept |
| `scheduled`, `in_progress` | `cancelled` | `reserved -= quantity` | `technician_id`, `scheduled_start`, `scheduled_end` become `null` |
| `open`, `blocked`, `unscheduled` | `cancelled` | unchanged (there is no reservation) | already `null` |

`status_reason` becomes `null` on cancellation. Any other pair of states is 409 `invalid_transition`. A `status` value that is not one of the seven, or a missing `status`, is 422. An unknown id is 404.

**`POST /plan`** runs the planner of section 5 for the week starting on `week_start` and answers:

```json
{"week_start": "2026-10-05",
 "scheduled": ["WO-001", "WO-002"], "blocked": ["WO-004"], "unscheduled": ["WO-003"],
 "orders": [ ...every candidate work order, in full, as it is after planning, sorted by id... ]}
```

The three id lists are sorted ascending and together contain every candidate exactly once.

**`GET /schedule`** answers with every technician (sorted by id, including those with nothing to do) and, for each, the work orders in status `scheduled`, `in_progress` or `completed` assigned to them whose `scheduled_start` falls in that Monday–Friday, sorted by `scheduled_start`:

```json
{"week_start": "2026-10-05",
 "technicians": [{"technician_id": "T-001", "assignments": [
   {"work_order_id": "WO-001", "title": "Calibrate cabinet sensors", "asset_id": "A-004", "status": "scheduled",
    "scheduled_start": "2026-10-05T07:00:00", "scheduled_end": "2026-10-05T11:00:00"}]}]}
```

For both endpoints, a `week_start` that is missing, malformed or not a Monday is 422.

## 5. Planner rules

The planned week is Monday `week_start` to Friday, both inclusive. The planner is deterministic; follow the rules in this order.

1. **Candidates.** (a) Every work order in status `open`, `blocked` or `unscheduled` whose window `[earliest_start, due_date]` shares at least one day with the week. (b) Every `scheduled` work order whose `scheduled_start` is in the week. A `scheduled` order in any other week is left completely alone and keeps its reservation. `in_progress`, `completed` and `cancelled` orders are never candidates.
2. **Bulk reset first.** Before any candidate is processed, all candidates become `open`, their `status_reason`, `technician_id`, `scheduled_start` and `scheduled_end` become `null`, and the reservations of those that were `scheduled` are released. Planning is therefore a recomputation from scratch for that week.
3. **Fixed load.** `in_progress` and `completed` orders with a slot in the week are never moved. Their slots block overlapping work, and their minutes count toward the daily cap of rule 7.
4. **Processing order.** Candidates are processed one at a time, sorted by `priority` (critical first), then `due_date` (earlier first), then `id`.
5. **Parts.** If, for any listed part, `quantity` is greater than that part's `available` at that moment, the order becomes `blocked` with reason `parts_unavailable`, gets no slot and reserves nothing. Parts are checked before technicians.
6. **Qualified technicians.** A technician is qualified when their `site_id` equals the site of the order's asset and their `skills` contain `required_skill`. If nobody is qualified, the order becomes `unscheduled` with reason `no_qualified_technician`.
7. **Feasible slots.** A slot for a qualified technician is feasible when: it starts on the 30-minute grid; it lies on a weekday between `max(week_start, earliest_start)` and `min(Friday, due_date)` inclusive; it starts and ends within the technician's shift, inclusive, on that same day (a slot never spans two days); it overlaps none of that technician's other assignments; and that technician's total assigned minutes on that day, this order included, do not exceed 480.
8. **Choice.** Take the earliest feasible start over all qualified technicians. If two technicians can start at the same instant, the lower technician `id` wins. If there is no feasible slot, the order becomes `unscheduled` with reason `no_capacity` and reserves nothing.
9. **On success** the order becomes `scheduled`, `technician_id`, `scheduled_start` and `scheduled_end` are set, and its parts are reserved — which lowers `available` for the orders processed after it.
10. **Determinism.** Calling `POST /plan` twice in a row for the same week returns the identical response and leaves the identical stock.

## 6. Seed data

The backend starts with exactly this data, and `POST /reset` restores exactly this data. Parts are stored without `available` and `low_stock`; compute them. The seed week is 2026-10-05.

```json seed
{
  "sites": [
    {"id": "S-001", "name": "Northgate Plant"},
    {"id": "S-002", "name": "Harbor Works"}
  ],
  "assets": [
    {"id": "A-001", "name": "Conveyor Line 1", "site_id": "S-001"},
    {"id": "A-002", "name": "Packaging Robot", "site_id": "S-001"},
    {"id": "A-003", "name": "Air Compressor", "site_id": "S-001"},
    {"id": "A-004", "name": "Control Cabinet", "site_id": "S-001"},
    {"id": "A-005", "name": "Dock Crane", "site_id": "S-002"},
    {"id": "A-006", "name": "Hydraulic Press", "site_id": "S-002"},
    {"id": "A-007", "name": "Pump Station", "site_id": "S-002"},
    {"id": "A-008", "name": "Cooling Tower", "site_id": "S-002"}
  ],
  "technicians": [
    {"id": "T-001", "name": "Ada Lindqvist", "site_id": "S-001", "skills": ["electrical", "instrumentation"], "shift_start": "07:00", "shift_end": "17:00"},
    {"id": "T-002", "name": "Bruno Okafor", "site_id": "S-001", "skills": ["electrical", "mechanical"], "shift_start": "08:00", "shift_end": "16:00"},
    {"id": "T-003", "name": "Chiara Mendes", "site_id": "S-002", "skills": ["hydraulics", "mechanical"], "shift_start": "08:00", "shift_end": "16:00"},
    {"id": "T-004", "name": "Deniz Arslan", "site_id": "S-002", "skills": ["mechanical"], "shift_start": "06:00", "shift_end": "14:00"}
  ],
  "parts": [
    {"id": "P-001", "name": "Drive belt", "on_hand": 6, "reserved": 0, "min_stock": 2},
    {"id": "P-002", "name": "Bearing set", "on_hand": 4, "reserved": 0, "min_stock": 2},
    {"id": "P-003", "name": "Contactor 24V", "on_hand": 1, "reserved": 0, "min_stock": 2},
    {"id": "P-004", "name": "Pressure sensor", "on_hand": 3, "reserved": 0, "min_stock": 1},
    {"id": "P-005", "name": "Hydraulic seal kit", "on_hand": 2, "reserved": 1, "min_stock": 1},
    {"id": "P-006", "name": "Hydraulic oil 20L", "on_hand": 5, "reserved": 0, "min_stock": 2},
    {"id": "P-007", "name": "Filter cartridge", "on_hand": 8, "reserved": 0, "min_stock": 3},
    {"id": "P-008", "name": "Fuse pack", "on_hand": 10, "reserved": 0, "min_stock": 4},
    {"id": "P-009", "name": "Coupling", "on_hand": 2, "reserved": 0, "min_stock": 1},
    {"id": "P-010", "name": "Gasket set", "on_hand": 3, "reserved": 0, "min_stock": 3}
  ],
  "work_orders": [
    {"id": "WO-001", "title": "Calibrate cabinet sensors", "asset_id": "A-004", "required_skill": "instrumentation", "duration_minutes": 240, "earliest_start": "2026-10-05", "due_date": "2026-10-05", "priority": "critical", "parts": [{"part_id": "P-004", "quantity": 1}], "status": "open", "status_reason": null, "technician_id": null, "scheduled_start": null, "scheduled_end": null},
    {"id": "WO-002", "title": "Loop check packaging robot", "asset_id": "A-002", "required_skill": "instrumentation", "duration_minutes": 240, "earliest_start": "2026-10-05", "due_date": "2026-10-05", "priority": "high", "parts": [], "status": "open", "status_reason": null, "technician_id": null, "scheduled_start": null, "scheduled_end": null},
    {"id": "WO-003", "title": "Inspect compressor gauges", "asset_id": "A-003", "required_skill": "instrumentation", "duration_minutes": 60, "earliest_start": "2026-10-05", "due_date": "2026-10-05", "priority": "medium", "parts": [], "status": "open", "status_reason": null, "technician_id": null, "scheduled_start": null, "scheduled_end": null},
    {"id": "WO-004", "title": "Replace conveyor contactor", "asset_id": "A-001", "required_skill": "electrical", "duration_minutes": 120, "earliest_start": "2026-10-06", "due_date": "2026-10-08", "priority": "high", "parts": [{"part_id": "P-003", "quantity": 2}], "status": "open", "status_reason": null, "technician_id": null, "scheduled_start": null, "scheduled_end": null},
    {"id": "WO-005", "title": "Thermal scan control cabinet", "asset_id": "A-004", "required_skill": "electrical", "duration_minutes": 90, "earliest_start": "2026-10-01", "due_date": "2026-10-06", "priority": "medium", "parts": [{"part_id": "P-008", "quantity": 1}], "status": "open", "status_reason": null, "technician_id": null, "scheduled_start": null, "scheduled_end": null},
    {"id": "WO-006", "title": "Replace packaging robot fuses", "asset_id": "A-002", "required_skill": "electrical", "duration_minutes": 60, "earliest_start": "2026-10-05", "due_date": "2026-10-10", "priority": "medium", "parts": [{"part_id": "P-008", "quantity": 2}], "status": "open", "status_reason": null, "technician_id": null, "scheduled_start": null, "scheduled_end": null},
    {"id": "WO-007", "title": "Conveyor belt replacement", "asset_id": "A-001", "required_skill": "mechanical", "duration_minutes": 180, "earliest_start": "2026-10-05", "due_date": "2026-10-09", "priority": "high", "parts": [{"part_id": "P-001", "quantity": 1}], "status": "open", "status_reason": null, "technician_id": null, "scheduled_start": null, "scheduled_end": null},
    {"id": "WO-008", "title": "Lubricate air compressor", "asset_id": "A-003", "required_skill": "mechanical", "duration_minutes": 60, "earliest_start": "2026-10-05", "due_date": "2026-10-05", "priority": "low", "parts": [{"part_id": "P-007", "quantity": 1}], "status": "completed", "status_reason": null, "technician_id": "T-002", "scheduled_start": "2026-10-05T08:00:00", "scheduled_end": "2026-10-05T09:00:00"},
    {"id": "WO-009", "title": "Pressure transmitter check", "asset_id": "A-007", "required_skill": "instrumentation", "duration_minutes": 60, "earliest_start": "2026-10-05", "due_date": "2026-10-09", "priority": "high", "parts": [], "status": "open", "status_reason": null, "technician_id": null, "scheduled_start": null, "scheduled_end": null},
    {"id": "WO-010", "title": "Reseal hydraulic press", "asset_id": "A-006", "required_skill": "hydraulics", "duration_minutes": 120, "earliest_start": "2026-10-07", "due_date": "2026-10-07", "priority": "high", "parts": [{"part_id": "P-005", "quantity": 1}], "status": "in_progress", "status_reason": null, "technician_id": "T-003", "scheduled_start": "2026-10-07T10:00:00", "scheduled_end": "2026-10-07T12:00:00"},
    {"id": "WO-011", "title": "Hydraulic hose inspection", "asset_id": "A-006", "required_skill": "hydraulics", "duration_minutes": 300, "earliest_start": "2026-10-07", "due_date": "2026-10-07", "priority": "medium", "parts": [{"part_id": "P-006", "quantity": 1}], "status": "open", "status_reason": null, "technician_id": null, "scheduled_start": null, "scheduled_end": null},
    {"id": "WO-012", "title": "Dock crane gearbox service", "asset_id": "A-005", "required_skill": "mechanical", "duration_minutes": 120, "earliest_start": "2026-10-05", "due_date": "2026-10-09", "priority": "low", "parts": [{"part_id": "P-002", "quantity": 1}, {"part_id": "P-009", "quantity": 1}], "status": "open", "status_reason": null, "technician_id": null, "scheduled_start": null, "scheduled_end": null},
    {"id": "WO-013", "title": "Pump coupling alignment", "asset_id": "A-007", "required_skill": "mechanical", "duration_minutes": 120, "earliest_start": "2026-10-05", "due_date": "2026-10-09", "priority": "low", "parts": [{"part_id": "P-009", "quantity": 1}], "status": "open", "status_reason": null, "technician_id": null, "scheduled_start": null, "scheduled_end": null},
    {"id": "WO-014", "title": "Cooling tower fan bearing", "asset_id": "A-008", "required_skill": "mechanical", "duration_minutes": 480, "earliest_start": "2026-10-06", "due_date": "2026-10-06", "priority": "critical", "parts": [{"part_id": "P-002", "quantity": 2}], "status": "open", "status_reason": null, "technician_id": null, "scheduled_start": null, "scheduled_end": null}
  ]
}
```

## 7. Frontend

A single-page application in English with navigation between four screens, all backed by the API:

- **Dashboard** — work orders counted by status, each technician's assigned hours for the selected week, and the parts that are low on stock.
- **Schedule** — a week timeline with one row per technician showing their assignments, a week selector defaulting to 2026-10-05, and a "Generate plan" button that calls `POST /plan` and refreshes the view. Blocked and unscheduled orders of that week are listed with their reason.
- **Work Orders** — the list with filters for status, priority and site; a form that creates a work order and shows validation errors returned by the API; a detail view with every field including `status_reason`, and buttons for the status transitions that are legal from the current status.
- **Inventory** — the parts table with on hand, reserved, available, minimum stock and a visible low-stock flag.

The layout must be usable on a phone and on a desktop, with a consistent visual style across the four screens.

## 8. Code quality

Keep the HTTP layer, the request/response schemas, the in-memory store and the planner in separate backend modules. Use TypeScript types for the API resources in the frontend and keep API calls in one place.
