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

- Ids are strings: a prefix and a zero-padded three-digit number — `S-001` (site), `A-001` (asset), `P-001` (part), `T-001` (technician), `WO-001` (work order). They compare as plain strings. A newly created work order gets the next free number: with the seed loaded, the first one created is `WO-026`.
- Dates are `YYYY-MM-DD`. Datetimes are `YYYY-MM-DDTHH:MM:SS`, local and naive (no time zone, no `Z`). Shift times are `HH:MM`.
- Everything lives on a 30-minute grid: shift boundaries, durations, absences, travel times, and every start time the planner may choose.
- A field with no value is JSON `null`. Never omit it and never use `""`.
- Both `technician_ids` and `segments` are `[]` when there is no slot, never `null`. This is the one exception to the convention that a missing value is `null`.
- Every response contains **exactly** the fields shown in sections 3 and 4 — no extra fields such as timestamps or nested copies of related resources, and none left out. Responses are compared field by field.
- Every list response is a bare JSON array sorted by `id` ascending, unless stated otherwise.

## 3. Resources

```json
{"id": "S-001", "name": "Northgate Plant", "holidays": ["2026-10-21"], "travel_minutes": {"S-001": 0, "S-002": 60, "S-003": 30}}
```
```json
{"id": "A-001", "name": "Conveyor Line 1", "site_id": "S-001"}
```
```json
{"id": "P-001", "name": "Drive belt", "on_hand": 6, "reserved": 0, "min_stock": 2, "available": 6, "low_stock": false}
```
```json
{"id": "T-005", "name": "Emeka Varga", "site_ids": ["S-001", "S-003"], "skills": ["pneumatics", "welding"], "shift_start": "07:00", "shift_end": "17:00", "absences": [{"date": "2026-10-06", "from": "10:00", "to": "12:00"}]}
```
```json
{"id": "WO-001", "title": "Calibrate cabinet sensors", "asset_id": "A-004", "required_skill": "instrumentation", "duration_minutes": 240, "earliest_start": "2026-10-05", "due_date": "2026-10-05", "priority": "critical", "parts": [{"part_id": "P-004", "quantity": 1}], "crew_size": 1, "splittable": false, "min_segment_minutes": null, "status": "scheduled", "status_reason": null, "technician_ids": ["T-001"], "segments": [{"start": "2026-10-05T07:00:00", "end": "2026-10-05T11:00:00"}]}
```

- Site: `holidays` lists sorted `YYYY-MM-DD` dates on which no work is done at that site. `travel_minutes` is an object mapping every site id (including its own) to transit time in minutes. The matrix is symmetric, zero exactly on the diagonal, a multiple of 30 everywhere, and satisfies the triangle inequality.
- Part: `available = on_hand - reserved`, and `low_stock` is true exactly when `available < min_stock`. Both are computed for every response; they are not stored in the seed.
- Technician: `site_ids` (sorted, non-empty) replaces `site_id` and lists the sites where the technician is qualified to work. The shift is the same Monday to Friday. Nobody works at weekends. `absences` holds `{date, from, to}` windows, sorted by `(date, from)`, on the 30-minute grid, with `from < to`, all inside the shift. Absences and holidays come from the seed only: no endpoint creates or modifies them.
- Work order:
  - `priority`: `critical` > `high` > `medium` > `low`.
  - `status`: `open`, `scheduled`, `blocked`, `unscheduled`, `in_progress`, `completed`, `cancelled`.
  - `status_reason`: `null` except: `blocked` → `"parts_unavailable"`; `unscheduled` → `"no_qualified_technician"` or `"no_capacity"`.
  - `crew_size`: integer 1 or 2 (default 1).
  - `splittable`: boolean indicating whether the order can be split across multiple days (default false).
  - `min_segment_minutes`: integer or `null`. If `splittable` is false, it must be `null`. If `splittable` is true, it is an integer >= 60 and a multiple of 30.
  - `technician_ids`: sorted list of technician ids; `[]` when there is no slot.
  - `segments`: list of `{start, end}` datetime intervals sorted by `start`; `[]` when there is no slot.
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

**`POST /work-orders`.** Required: `title`, `asset_id`, `required_skill`, `duration_minutes`, `earliest_start`, `due_date`, `priority`.
Optional:
- `parts` (default `[]`), a list of `{"part_id", "quantity"}`.
- `crew_size` (default 1).
- `splittable` (default false).
- `min_segment_minutes` (default `null`).

The order is created with `status: "open"` and `null` in `status_reason`, `technician_ids: []`, `segments: []`.

The three fields `crew_size` (StrictInt: 1 or 2), `splittable` (StrictBool: true or false), and `min_segment_minutes` (StrictInt or null) are **strictly typed**: lax coercion (`"1"`, `1.0`, `"true"`, `1` for bool) is rejected with 422.

Answer 422 and create nothing when:
- a required field is missing or has the wrong type;
- `title` or `required_skill` is empty;
- `duration_minutes` is below 30 or not a multiple of 30;
- `duration_minutes` is above 480 and `splittable` is false;
- `duration_minutes` is above 1440;
- a date is malformed;
- `due_date` is before `earliest_start`;
- `priority` is not one of the four;
- a `quantity` is below 1;
- the same `part_id` appears twice;
- `asset_id` or a `part_id` does not exist;
- `crew_size` is present and not the integer 1 or 2 (`null`, a boolean, a float and a string are all 422);
- `splittable` is present and not a boolean (`null` is 422);
- `splittable` is true and `min_segment_minutes` is missing, `null`, not an integer, below 60 or not a multiple of 30;
- `splittable` is false and `min_segment_minutes` is present and not `null`.

Note that a `min_segment_minutes` above half of `duration_minutes` is **valid**: the order simply can never split.

**`PATCH /work-orders/{id}`.** Only the status changes, and only along these transitions:

| From | To | Parts (per listed part) | Slot fields |
|---|---|---|---|
| `scheduled` | `in_progress` | unchanged | kept |
| `in_progress` | `completed` | `on_hand -= quantity` and `reserved -= quantity` | kept |
| `scheduled`, `in_progress` | `cancelled` | `reserved -= quantity` | `technician_ids` and `segments` become `[]` |
| `open`, `blocked`, `unscheduled` | `cancelled` | unchanged (there is no reservation) | already `[]` |

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

`GET /schedule` lists **one assignment per (technician, segment)**. The assignment's shape is the classic one, with the segment's bounds in `scheduled_start`/`scheduled_end`. A crew order therefore appears under both members, and a split order appears once per day for each segment. Ties in `scheduled_start` are sorted by `work_order_id` ascending.

For both endpoints, a `week_start` that is missing, malformed or not a Monday is 422.

## 5. Planner rules

**Definition.** An order's **clipped window** for a week is the set of weekdays from `max(week_start, earliest_start)` to `min(Friday, due_date)` inclusive. Holidays do not shorten the clipped window: they are a separate feasibility condition, rule 7(ii). Rules 7, 8 and 11 all use this term.

The planned week is Monday `week_start` to Friday, both inclusive. The planner is deterministic; follow the rules in this order.

1. **Candidates.** (a) Every work order in status `open`, `blocked` or `unscheduled` whose window `[earliest_start, due_date]` shares at least one day with the week. (b) Every `scheduled` work order whose first segment's `scheduled_start` is in the week. A `scheduled` order in any other week is left completely alone and keeps its reservation. `in_progress`, `completed` and `cancelled` orders are never candidates.
2. **Bulk reset first.** Before any candidate is processed, all candidates become `open`, their `status_reason` becomes `null`, `technician_ids` and `segments` become `[]`, and the reservations of those that were `scheduled` are released. Planning is therefore a recomputation from scratch for that week.
3. **Fixed load.** `in_progress` and `completed` orders with a slot in the week are never moved. Their slots block overlapping work, and their minutes count toward the daily cap of rule 7 and carry travel.
4. **Processing order (EDF).** Candidates are processed one at a time, ordered by `due_date` (earlier first), then `priority` (critical first: `critical` > `high` > `medium` > `low`), then `id` ascending.
5. **Parts.** If, for any listed part, `quantity` is greater than that part's `available` at that moment (`on_hand - reserved`), the order becomes `blocked` with reason `parts_unavailable`, gets no slot (`technician_ids: []`, `segments: []`) and reserves nothing. Parts are checked before technicians.
6. **Qualified technicians.** A technician is qualified when the site of the order's asset is in their `site_ids` and their `skills` contain `required_skill`. Fewer than `crew_size` qualified technicians gives `unscheduled` with reason `no_qualified_technician`.
7. **Feasible slots.** A slot for a qualified technician is feasible when:
   - it starts on the 30-minute grid;
   - it lies on a single weekday of the order's clipped window;
   - it starts and ends within the technician's shift, inclusive, on that same day (a slot never spans two days);
   - it overlaps none of that technician's other assignments on that day;
   - **(i)** it overlaps none of that technician's absences on that date (touching is permitted, e.g. a slot ending at `from` or starting at `to`);
   - **(ii)** the date is not a holiday of the order's site;
   - **(iii) travel.** In that technician's assignments on that day, with this slot included and in chronological order, every pair of consecutive assignments at sites A then B has `start(next) - end(previous) >= travel_minutes[A][B]`. The first assignment of a day needs no travel. Travel may pass through an absence: absences constrain slots and nothing else;
   - **(iv) the cap.** Assigned minutes plus the sum of travel minutes between consecutive assignments, in chronological order with this slot included, do not exceed 480 minutes for that day.
   Assignments means every segment of every order the technician holds in status `scheduled`, `in_progress` or `completed`. Fixed load counts toward occupancy, travel, and the cap. Absences are not assignments: they neither need travel nor count toward the cap.
   For a crew (`crew_size == 2`), a slot must be simultaneously feasible (rule 7) for every crew member.
8. **Choice, in three steps:**
   1. **Unsplit.** A placement is a set of `crew_size` distinct qualified technicians and one slot of `duration_minutes` that is feasible (rule 7) for every member. Take the earliest start. On ties, take the lexicographically lowest sorted technician id list (`["T-001", "T-004"] < ["T-002", "T-003"]`).
   2. **Split**, only when step 1 found nothing and the order has `splittable: true`. A split placement is a technician set as above plus k >= 2 segments. Each segment lies on a different day of the clipped window. Each is at least `min_segment_minutes` long and a multiple of 30. They sum to `duration_minutes`, and each is feasible (rule 7) for every member on its own day. (Segments of one order never share a day, so they never constrain each other). Choose by minimizing the key: `(k, s_1, ids, -l_1, s_2, -l_2, ..., s_k, -l_k)`: fewest segments (k); then the earliest first segment start (s_1); then the lowest sorted id list (ids); then, segment by segment in chronological order, the longer segment (-l_i), and then the earlier start of the next segment (s_{i+1}). (Note on search: on each candidate day, feasible `(start, length)` options ordered by earlier start then longer length can be combined across days with standard search/backtracking over `(day_index, remaining_duration, remaining_segments)` to avoid combinatorial state explosion on long durations).
   3. **Neither found:** the order becomes `unscheduled` with reason `no_capacity`, sets `technician_ids: []` and `segments: []`, and reserves nothing.
9. **On success** the order becomes `scheduled`, `status_reason: null`, `technician_ids` is set to the sorted crew ids, `segments` is set to the assigned segment intervals, and its parts are reserved — which lowers `available` for subsequent orders.
10. **Determinism.** Calling `POST /plan` twice in a row for the same week returns the identical response and leaves the identical stock.
11. **Preemption, after the pass over all candidates:**
   - **Subjects.** The `critical` candidates that ended the pass `unscheduled` with reason `no_capacity`, taken in rule-4 order, one round each. A critical that ended `blocked` is not a subject.
   - **Parts first.** A round re-checks C's parts against current reservations. If any are insufficient, C stays `unscheduled` with reason `no_capacity`. It does not become `blocked`, and nobody is evicted.
   - **Victims** are orders currently `scheduled` by this plan (fixed load is never a victim) whose priority is strictly below C's (`high`, `medium`, `low`), **and** that hold at least one technician qualified for C (rule 6: site and skill), **and** that have at least one segment on a day of C's clipped window. They are ordered:
     1. Priority lowest first (`low`, then `medium`, then `high`);
     2. Latest `due_date` first;
     3. Highest `id` first.
   - **The shortest prefix, the empty one included.** If rule 8 already finds a placement for C at the start of its round (an earlier round's evictions can do that), C is assigned and nobody is evicted. Otherwise the round evicts the shortest non-empty prefix of the victim list after whose removal rule 8 (steps 1 and 2) finds a placement. Evicting means releasing the victim's reservation and setting it to `open`, clearing its `status_reason: null`, `technician_ids: []` and `segments: []`. C is then assigned by rule 8 and reserves its parts. If even the whole list does not suffice, the round evicts nothing and C remains `unscheduled` with reason `no_capacity`.
   - **Phasing.** When every round is done, each evicted order is processed once more, in rule-4 order, by rules 5–9 with no preemption of its own. An order evicted in one round is `open` in the next, so it is never a victim twice.

## 6. Seed data

The backend starts with exactly this data, and `POST /reset` restores exactly this data. Parts are stored without `available` and `low_stock`; compute them. The seed week is 2026-10-05.

```json seed
{
 "sites": [
  {
   "id": "S-001",
   "name": "Northgate Plant",
   "holidays": [],
   "travel_minutes": {
    "S-001": 0,
    "S-002": 60,
    "S-003": 30
   }
  },
  {
   "id": "S-002",
   "name": "Harbor Works",
   "holidays": [],
   "travel_minutes": {
    "S-001": 60,
    "S-002": 0,
    "S-003": 60
   }
  },
  {
   "id": "S-003",
   "name": "Ridge Depot",
   "holidays": [
    "2026-10-08",
    "2026-10-22"
   ],
   "travel_minutes": {
    "S-001": 30,
    "S-002": 60,
    "S-003": 0
   }
  }
 ],
 "assets": [
  {
   "id": "A-001",
   "name": "Conveyor Line 1",
   "site_id": "S-001"
  },
  {
   "id": "A-002",
   "name": "Packaging Robot",
   "site_id": "S-001"
  },
  {
   "id": "A-003",
   "name": "Air Compressor",
   "site_id": "S-001"
  },
  {
   "id": "A-004",
   "name": "Control Cabinet",
   "site_id": "S-001"
  },
  {
   "id": "A-005",
   "name": "Dock Crane",
   "site_id": "S-002"
  },
  {
   "id": "A-006",
   "name": "Hydraulic Press",
   "site_id": "S-002"
  },
  {
   "id": "A-007",
   "name": "Pump Station",
   "site_id": "S-002"
  },
  {
   "id": "A-008",
   "name": "Cooling Tower",
   "site_id": "S-002"
  },
  {
   "id": "A-009",
   "name": "Kiln Line",
   "site_id": "S-003"
  },
  {
   "id": "A-010",
   "name": "Boiler House",
   "site_id": "S-003"
  }
 ],
 "technicians": [
  {
   "id": "T-001",
   "name": "Ada Lindqvist",
   "site_ids": [
    "S-001"
   ],
   "skills": [
    "electrical",
    "instrumentation"
   ],
   "shift_start": "07:00",
   "shift_end": "17:00",
   "absences": []
  },
  {
   "id": "T-002",
   "name": "Bruno Okafor",
   "site_ids": [
    "S-001"
   ],
   "skills": [
    "electrical",
    "mechanical"
   ],
   "shift_start": "08:00",
   "shift_end": "16:00",
   "absences": []
  },
  {
   "id": "T-003",
   "name": "Chiara Mendes",
   "site_ids": [
    "S-002"
   ],
   "skills": [
    "hydraulics",
    "mechanical"
   ],
   "shift_start": "08:00",
   "shift_end": "16:00",
   "absences": []
  },
  {
   "id": "T-004",
   "name": "Deniz Arslan",
   "site_ids": [
    "S-002"
   ],
   "skills": [
    "mechanical"
   ],
   "shift_start": "06:00",
   "shift_end": "14:00",
   "absences": []
  },
  {
   "id": "T-005",
   "name": "Emeka Varga",
   "site_ids": [
    "S-001",
    "S-003"
   ],
   "skills": [
    "pneumatics",
    "welding"
   ],
   "shift_start": "07:00",
   "shift_end": "17:00",
   "absences": [
    {
     "date": "2026-10-06",
     "from": "10:00",
     "to": "12:00"
    },
    {
     "date": "2026-10-20",
     "from": "09:00",
     "to": "11:00"
    }
   ]
  },
  {
   "id": "T-006",
   "name": "Freya Holm",
   "site_ids": [
    "S-002",
    "S-003"
   ],
   "skills": [
    "pneumatics"
   ],
   "shift_start": "08:00",
   "shift_end": "16:00",
   "absences": [
    {
     "date": "2026-10-21",
     "from": "12:00",
     "to": "14:00"
    }
   ]
  },
  {
   "id": "T-007",
   "name": "Goran Petit",
   "site_ids": [
    "S-003"
   ],
   "skills": [
    "pneumatics",
    "welding"
   ],
   "shift_start": "08:00",
   "shift_end": "16:00",
   "absences": []
  }
 ],
 "parts": [
  {
   "id": "P-001",
   "name": "Drive belt",
   "on_hand": 6,
   "reserved": 0,
   "min_stock": 2
  },
  {
   "id": "P-002",
   "name": "Bearing set",
   "on_hand": 4,
   "reserved": 0,
   "min_stock": 2
  },
  {
   "id": "P-003",
   "name": "Contactor 24V",
   "on_hand": 1,
   "reserved": 0,
   "min_stock": 2
  },
  {
   "id": "P-004",
   "name": "Pressure sensor",
   "on_hand": 3,
   "reserved": 0,
   "min_stock": 1
  },
  {
   "id": "P-005",
   "name": "Hydraulic seal kit",
   "on_hand": 2,
   "reserved": 1,
   "min_stock": 1
  },
  {
   "id": "P-006",
   "name": "Hydraulic oil 20L",
   "on_hand": 5,
   "reserved": 0,
   "min_stock": 2
  },
  {
   "id": "P-007",
   "name": "Filter cartridge",
   "on_hand": 8,
   "reserved": 0,
   "min_stock": 3
  },
  {
   "id": "P-008",
   "name": "Fuse pack",
   "on_hand": 10,
   "reserved": 0,
   "min_stock": 4
  },
  {
   "id": "P-009",
   "name": "Coupling",
   "on_hand": 2,
   "reserved": 0,
   "min_stock": 1
  },
  {
   "id": "P-010",
   "name": "Gasket set",
   "on_hand": 3,
   "reserved": 0,
   "min_stock": 3
  },
  {
   "id": "P-011",
   "name": "Solenoid valve",
   "on_hand": 2,
   "reserved": 0,
   "min_stock": 1
  },
  {
   "id": "P-012",
   "name": "Welding rod pack",
   "on_hand": 3,
   "reserved": 0,
   "min_stock": 1
  }
 ],
 "work_orders": [
  {
   "id": "WO-001",
   "title": "Calibrate cabinet sensors",
   "asset_id": "A-004",
   "required_skill": "instrumentation",
   "duration_minutes": 240,
   "earliest_start": "2026-10-05",
   "due_date": "2026-10-05",
   "priority": "critical",
   "parts": [
    {
     "part_id": "P-004",
     "quantity": 1
    }
   ],
   "crew_size": 1,
   "splittable": false,
   "min_segment_minutes": null,
   "status": "open",
   "status_reason": null,
   "technician_ids": [],
   "segments": []
  },
  {
   "id": "WO-002",
   "title": "Loop check packaging robot",
   "asset_id": "A-002",
   "required_skill": "instrumentation",
   "duration_minutes": 240,
   "earliest_start": "2026-10-05",
   "due_date": "2026-10-05",
   "priority": "high",
   "parts": [],
   "crew_size": 1,
   "splittable": false,
   "min_segment_minutes": null,
   "status": "open",
   "status_reason": null,
   "technician_ids": [],
   "segments": []
  },
  {
   "id": "WO-003",
   "title": "Inspect compressor gauges",
   "asset_id": "A-003",
   "required_skill": "instrumentation",
   "duration_minutes": 60,
   "earliest_start": "2026-10-05",
   "due_date": "2026-10-05",
   "priority": "medium",
   "parts": [],
   "crew_size": 1,
   "splittable": false,
   "min_segment_minutes": null,
   "status": "open",
   "status_reason": null,
   "technician_ids": [],
   "segments": []
  },
  {
   "id": "WO-004",
   "title": "Replace conveyor contactor",
   "asset_id": "A-001",
   "required_skill": "electrical",
   "duration_minutes": 120,
   "earliest_start": "2026-10-06",
   "due_date": "2026-10-08",
   "priority": "high",
   "parts": [
    {
     "part_id": "P-003",
     "quantity": 2
    }
   ],
   "crew_size": 1,
   "splittable": false,
   "min_segment_minutes": null,
   "status": "open",
   "status_reason": null,
   "technician_ids": [],
   "segments": []
  },
  {
   "id": "WO-005",
   "title": "Thermal scan control cabinet",
   "asset_id": "A-004",
   "required_skill": "electrical",
   "duration_minutes": 90,
   "earliest_start": "2026-10-01",
   "due_date": "2026-10-06",
   "priority": "medium",
   "parts": [
    {
     "part_id": "P-008",
     "quantity": 1
    }
   ],
   "crew_size": 1,
   "splittable": false,
   "min_segment_minutes": null,
   "status": "open",
   "status_reason": null,
   "technician_ids": [],
   "segments": []
  },
  {
   "id": "WO-006",
   "title": "Replace packaging robot fuses",
   "asset_id": "A-002",
   "required_skill": "electrical",
   "duration_minutes": 60,
   "earliest_start": "2026-10-05",
   "due_date": "2026-10-10",
   "priority": "medium",
   "parts": [
    {
     "part_id": "P-008",
     "quantity": 2
    }
   ],
   "crew_size": 1,
   "splittable": false,
   "min_segment_minutes": null,
   "status": "open",
   "status_reason": null,
   "technician_ids": [],
   "segments": []
  },
  {
   "id": "WO-007",
   "title": "Conveyor belt replacement",
   "asset_id": "A-001",
   "required_skill": "mechanical",
   "duration_minutes": 180,
   "earliest_start": "2026-10-05",
   "due_date": "2026-10-09",
   "priority": "high",
   "parts": [
    {
     "part_id": "P-001",
     "quantity": 1
    }
   ],
   "crew_size": 1,
   "splittable": false,
   "min_segment_minutes": null,
   "status": "open",
   "status_reason": null,
   "technician_ids": [],
   "segments": []
  },
  {
   "id": "WO-008",
   "title": "Lubricate air compressor",
   "asset_id": "A-003",
   "required_skill": "mechanical",
   "duration_minutes": 60,
   "earliest_start": "2026-10-05",
   "due_date": "2026-10-05",
   "priority": "low",
   "parts": [
    {
     "part_id": "P-007",
     "quantity": 1
    }
   ],
   "crew_size": 1,
   "splittable": false,
   "min_segment_minutes": null,
   "status": "completed",
   "status_reason": null,
   "technician_ids": [
    "T-002"
   ],
   "segments": [
    {
     "start": "2026-10-05T08:00:00",
     "end": "2026-10-05T09:00:00"
    }
   ]
  },
  {
   "id": "WO-009",
   "title": "Pressure transmitter check",
   "asset_id": "A-007",
   "required_skill": "instrumentation",
   "duration_minutes": 60,
   "earliest_start": "2026-10-05",
   "due_date": "2026-10-09",
   "priority": "high",
   "parts": [],
   "crew_size": 1,
   "splittable": false,
   "min_segment_minutes": null,
   "status": "open",
   "status_reason": null,
   "technician_ids": [],
   "segments": []
  },
  {
   "id": "WO-010",
   "title": "Reseal hydraulic press",
   "asset_id": "A-006",
   "required_skill": "hydraulics",
   "duration_minutes": 120,
   "earliest_start": "2026-10-07",
   "due_date": "2026-10-07",
   "priority": "high",
   "parts": [
    {
     "part_id": "P-005",
     "quantity": 1
    }
   ],
   "crew_size": 1,
   "splittable": false,
   "min_segment_minutes": null,
   "status": "in_progress",
   "status_reason": null,
   "technician_ids": [
    "T-003"
   ],
   "segments": [
    {
     "start": "2026-10-07T10:00:00",
     "end": "2026-10-07T12:00:00"
    }
   ]
  },
  {
   "id": "WO-011",
   "title": "Hydraulic hose inspection",
   "asset_id": "A-006",
   "required_skill": "hydraulics",
   "duration_minutes": 300,
   "earliest_start": "2026-10-07",
   "due_date": "2026-10-07",
   "priority": "medium",
   "parts": [
    {
     "part_id": "P-006",
     "quantity": 1
    }
   ],
   "crew_size": 1,
   "splittable": false,
   "min_segment_minutes": null,
   "status": "open",
   "status_reason": null,
   "technician_ids": [],
   "segments": []
  },
  {
   "id": "WO-012",
   "title": "Dock crane gearbox service",
   "asset_id": "A-005",
   "required_skill": "mechanical",
   "duration_minutes": 120,
   "earliest_start": "2026-10-05",
   "due_date": "2026-10-09",
   "priority": "low",
   "parts": [
    {
     "part_id": "P-002",
     "quantity": 1
    },
    {
     "part_id": "P-009",
     "quantity": 1
    }
   ],
   "crew_size": 1,
   "splittable": false,
   "min_segment_minutes": null,
   "status": "open",
   "status_reason": null,
   "technician_ids": [],
   "segments": []
  },
  {
   "id": "WO-013",
   "title": "Pump coupling alignment",
   "asset_id": "A-007",
   "required_skill": "mechanical",
   "duration_minutes": 120,
   "earliest_start": "2026-10-05",
   "due_date": "2026-10-09",
   "priority": "low",
   "parts": [
    {
     "part_id": "P-009",
     "quantity": 1
    }
   ],
   "crew_size": 1,
   "splittable": false,
   "min_segment_minutes": null,
   "status": "open",
   "status_reason": null,
   "technician_ids": [],
   "segments": []
  },
  {
   "id": "WO-014",
   "title": "Cooling tower fan bearing",
   "asset_id": "A-008",
   "required_skill": "mechanical",
   "duration_minutes": 480,
   "earliest_start": "2026-10-06",
   "due_date": "2026-10-06",
   "priority": "critical",
   "parts": [
    {
     "part_id": "P-002",
     "quantity": 2
    }
   ],
   "crew_size": 1,
   "splittable": false,
   "min_segment_minutes": null,
   "status": "open",
   "status_reason": null,
   "technician_ids": [],
   "segments": []
  },
  {
   "id": "WO-015",
   "title": "Weld conveyor guard",
   "asset_id": "A-001",
   "required_skill": "welding",
   "duration_minutes": 240,
   "earliest_start": "2026-10-05",
   "due_date": "2026-10-05",
   "priority": "high",
   "parts": [],
   "crew_size": 1,
   "splittable": false,
   "min_segment_minutes": null,
   "status": "open",
   "status_reason": null,
   "technician_ids": [],
   "segments": []
  },
  {
   "id": "WO-016",
   "title": "Weld robot base plate",
   "asset_id": "A-002",
   "required_skill": "welding",
   "duration_minutes": 120,
   "earliest_start": "2026-10-05",
   "due_date": "2026-10-06",
   "priority": "medium",
   "parts": [],
   "crew_size": 1,
   "splittable": false,
   "min_segment_minutes": null,
   "status": "open",
   "status_reason": null,
   "technician_ids": [],
   "segments": []
  },
  {
   "id": "WO-017",
   "title": "Reline kiln burner",
   "asset_id": "A-009",
   "required_skill": "welding",
   "duration_minutes": 120,
   "earliest_start": "2026-10-05",
   "due_date": "2026-10-05",
   "priority": "medium",
   "parts": [],
   "crew_size": 2,
   "splittable": false,
   "min_segment_minutes": null,
   "status": "open",
   "status_reason": null,
   "technician_ids": [],
   "segments": []
  },
  {
   "id": "WO-018",
   "title": "Weld compressor frame",
   "asset_id": "A-003",
   "required_skill": "welding",
   "duration_minutes": 240,
   "earliest_start": "2026-10-06",
   "due_date": "2026-10-06",
   "priority": "high",
   "parts": [],
   "crew_size": 1,
   "splittable": false,
   "min_segment_minutes": null,
   "status": "open",
   "status_reason": null,
   "technician_ids": [],
   "segments": []
  },
  {
   "id": "WO-019",
   "title": "Service boiler actuators",
   "asset_id": "A-010",
   "required_skill": "pneumatics",
   "duration_minutes": 180,
   "earliest_start": "2026-10-08",
   "due_date": "2026-10-09",
   "priority": "medium",
   "parts": [
    {
     "part_id": "P-011",
     "quantity": 1
    }
   ],
   "crew_size": 1,
   "splittable": false,
   "min_segment_minutes": null,
   "status": "open",
   "status_reason": null,
   "technician_ids": [],
   "segments": []
  },
  {
   "id": "WO-020",
   "title": "Check boiler valves",
   "asset_id": "A-010",
   "required_skill": "pneumatics",
   "duration_minutes": 180,
   "earliest_start": "2026-10-08",
   "due_date": "2026-10-09",
   "priority": "low",
   "parts": [],
   "crew_size": 1,
   "splittable": false,
   "min_segment_minutes": null,
   "status": "open",
   "status_reason": null,
   "technician_ids": [],
   "segments": []
  },
  {
   "id": "WO-021",
   "title": "Rebuild kiln shell",
   "asset_id": "A-009",
   "required_skill": "welding",
   "duration_minutes": 720,
   "earliest_start": "2026-10-05",
   "due_date": "2026-10-09",
   "priority": "low",
   "parts": [
    {
     "part_id": "P-012",
     "quantity": 2
    }
   ],
   "crew_size": 1,
   "splittable": true,
   "min_segment_minutes": 120,
   "status": "open",
   "status_reason": null,
   "technician_ids": [],
   "segments": []
  },
  {
   "id": "WO-022",
   "title": "Overhaul boiler air lines",
   "asset_id": "A-010",
   "required_skill": "pneumatics",
   "duration_minutes": 600,
   "earliest_start": "2026-10-05",
   "due_date": "2026-10-09",
   "priority": "low",
   "parts": [],
   "crew_size": 1,
   "splittable": true,
   "min_segment_minutes": 120,
   "status": "open",
   "status_reason": null,
   "technician_ids": [],
   "segments": []
  },
  {
   "id": "WO-023",
   "title": "Replace cabinet air supply",
   "asset_id": "A-004",
   "required_skill": "pneumatics",
   "duration_minutes": 480,
   "earliest_start": "2026-10-05",
   "due_date": "2026-10-10",
   "priority": "critical",
   "parts": [],
   "crew_size": 1,
   "splittable": false,
   "min_segment_minutes": null,
   "status": "open",
   "status_reason": null,
   "technician_ids": [],
   "segments": []
  },
  {
   "id": "WO-024",
   "title": "Inspect compressor pneumatics",
   "asset_id": "A-003",
   "required_skill": "pneumatics",
   "duration_minutes": 240,
   "earliest_start": "2026-10-07",
   "due_date": "2026-10-07",
   "priority": "low",
   "parts": [],
   "crew_size": 1,
   "splittable": false,
   "min_segment_minutes": null,
   "status": "open",
   "status_reason": null,
   "technician_ids": [],
   "segments": []
  },
  {
   "id": "WO-025",
   "title": "Inspect cabinet pneumatics",
   "asset_id": "A-004",
   "required_skill": "pneumatics",
   "duration_minutes": 240,
   "earliest_start": "2026-10-08",
   "due_date": "2026-10-08",
   "priority": "low",
   "parts": [],
   "crew_size": 1,
   "splittable": false,
   "min_segment_minutes": null,
   "status": "open",
   "status_reason": null,
   "technician_ids": [],
   "segments": []
  }
 ]
}
```

## 7. Frontend

A single-page application in English with navigation between four screens, all backed by the API:

- **Dashboard** — work orders counted by status, each technician's assigned hours for the selected week, and the parts that are low on stock.
- **Schedule** — a week timeline with one row per technician showing their assignments, a week selector defaulting to 2026-10-05, and a "Generate plan" button that calls `POST /plan` and refreshes the view. Blocked and unscheduled orders of that week are listed with their reason. For crew orders, the assignment appears under each technician in the crew with both members listed. For split orders, each segment appears on its respective day.
- **Work Orders** — the list with filters for status, priority and site; a form that creates a work order and shows validation errors returned by the API; a detail view with every field including `status_reason`, `crew_size`, `splittable`, `min_segment_minutes`, `technician_ids` and `segments`, and buttons for the status transitions that are legal from the current status.
- **Inventory** — the parts table with on hand, reserved, available, minimum stock and a visible low-stock flag.

The layout must be usable on a phone and on a desktop, with a consistent visual style across the four screens.

## 8. Code quality

Keep the HTTP layer, the request/response schemas, the in-memory store and the planner in separate backend modules. Use TypeScript types for the API resources in the frontend and keep API calls in one place.
