# Benchmark criteria

Every attempt builds the Meridian Maintenance Console of `prompt.md` one-shot: a
FastAPI backend in `backend/` and a React SPA in `frontend/`. It is scored on
14 rows. **The total max score is 14 points**, and half of it, 7 points, comes
from hidden contract tests that do not depend on the judge.

- **Total** = the sum of the `Score` of every row that has a numeric `Max`,
  minus `Penalty`.
- **Max** = the sum of those rows' `Max`: 14.
- **Percentage** = total / max × 100.

`Task completion time`, `Test run`, `Penalty` and `API cost` are not in the
denominator. `Penalty` is subtracted from the total. `API cost` is never
written by the judge: `process-results` adds it from the run's token usage.

## Rows

| Criterion | Max | Scored by |
|---|---|---|
| Task completion time | N/A | auto |
| Test run | N/A | auto |
| Local build | 1 | auto |
| API contract | 2 | hidden |
| Planner: assignment rules | 2 | hidden |
| Planner: ordering & determinism | 1 | hidden |
| Planner: parts & blocking | 2 | hidden |
| Frontend–API integration | 1 | agent |
| Code structure | 1 | agent |
| Tech stack & run contract | 1 | agent |
| Manual testing | 1 | human |
| Consistent UI | 1 | human |
| Responsive design | 1 | human |
| Penalty | N/A | penalty |

- `auto` — the harness measures it, or it follows mechanically from what the
  harness measured.
- `hidden` — the hidden contract tests score it; the judge copies the result.
- `agent` — the judge agent scores it against the bands below.
- `human` — a person scores it against the bands below; it is never defaulted.
- `penalty` — the judge agent proposes a deduction with its evidence, and a
  person confirms or changes it.

This table is the one in `scripts/lib/rubric.ts`, byte for byte; a test keeps
them equal. In the sections below, a row scores the first band whose
description holds, read from the top.

## The CSV

Each scored attempt gets `eval-results/<id>-attempt-<n>/eval-results.csv`:

- the header `Criterion,Score,Max,Notes`, then the 14 rows in the table's
  order, with exactly those names (the dash in `Frontend–API integration` is an
  en dash), and no `API cost` row;
- `Max` as in the table, `N/A` where the table says so;
- `Score`: `1` or `0` for `Local build`; two decimals at most for the four
  hidden-test rows; `1`, `0.5` or `0` for the six agent and human rows; `0`,
  `0.5` or `1` for `Penalty`;
- `Task completion time`: the run's duration, `Xmin Ys` (`30min 2s`: whole
  seconds rounded, minutes never converted to hours, no zero padding), the same
  string in `Score` and `Notes`; `N/A` in both for an attempt without a
  `run.json`;
- `Test run`: when the attempt was scored, `D.MM.YYYY HH:MM` (`18.09.2026
  14:05`), the same string in `Score` and `Notes`;
- every other `Notes` value in double quotes, each `"` inside doubled, on one
  line. The two info rows stay unquoted: their formats cannot hold a comma.

## Hidden-test rows

`benchmark/contract-tests/` holds one test file per row, 58 tests in all:

| Row | Tests | What it checks |
|---|---|---|
| API contract | 24 | every endpoint's status codes, fields, sorting, filters and error body; `PATCH`'s legal and illegal transitions; `POST /reset` |
| Planner: assignment rules | 12 | skill, site, shift, the 30-minute grid, one day per slot, no overlap, the 480-minute cap, fixed load, week clipping, candidates |
| Planner: ordering & determinism | 11 | processing order (priority, due date, id), the earliest start and the technician tie-break, planning twice, recomputation, other weeks left alone |
| Planner: parts & blocking | 11 | parts checked first, availability running down, reservations, and `PATCH`'s stock arithmetic |

`PATCH`'s stock arithmetic — what completing or cancelling an order does to
`on_hand` and `reserved` — is scored in `Planner: parts & blocking`, not in
`API contract`, which checks only which transitions are legal.

Each file runs against a freshly started backend, and every test starts from
`POST /reset`. A row scores

```
Math.round(passed / total × Max × 100) / 100
```

so 20 of 24 on a Max-2 row is 1.67. The four CSV lines are printed from
`contract-results.json` by `scripts/contract-results.ts --rows`; the judge
pastes them and computes nothing. Their Notes take one of these forms:

- `20/24 passed; failed: <names>`, the names joined by ` | ` (`24/24 passed`
  when none failed);
- `0/24 passed; backend stop (<stage>): <detail>`;
- `0/24 passed; POST /reset does not answer 200`, when no test in any file
  passed, every test that ran failed in its `POST /reset`, and every file ran
  at least one: one defect, not 58. It takes precedence over the other forms;
- `0/11 passed; restart failed: <detail>`, for a file whose backend booted
  once but did not come back up for it after one retry;
- the first form followed by `; timed out after <n> tests`, for a file cut
  short by its time budget; its unfinished tests count as failed.

To any of them `; most failures at <METHOD> <path>` is appended when more than
half of a file's failures happened at the same method and path, query string
and ids included: the request exactly as the failure message names it.

## Stop rules

A **backend stop** is a failure at a stage the model's files decide:
`layout` (`backend/`, `backend/requirements.txt` or `backend/app/main.py`
missing), `install` (`pip install -r requirements.txt` fails or takes over
5 minutes while PyPI is reachable, or leaves no `uvicorn`), `boot` (the server
exits before `/api/v1/health` answers) or `health` (no 2xx from
`/api/v1/health` within 60 s, each request answering within 1 s).
`contract-results.json`'s `boot` is the only source of a backend stop.

A **frontend stop** is `frontend/package.json` missing, `npm install` failing
or taking over 10 minutes while the registry answers `npm ping`, `npm run
build` failing, or `npm run dev` not answering HTTP at its `Local:` URL within
60 s (each request within 1 s), after one retry.

| Stop | Rows set to 0 | Rows still judged |
|---|---|---|
| Backend stop | `Local build`, the four hidden-test rows, `Frontend–API integration`, `Manual testing` | `Code structure`, `Tech stack & run contract`; `Consistent UI` and `Responsive design` on the frontend as it renders without data; `Penalty` |
| Frontend stop | `Local build`, `Frontend–API integration`, `Manual testing`, `Consistent UI`, `Responsive design` | the four hidden-test rows, `Code structure`, `Tech stack & run contract`, `Penalty` |
| Both stops | every row, `Penalty` included: the all-zero CSV, and scoring ends | – |
| `run.json` records `failureKind: "model"` | every row, `Penalty` included: the all-zero CSV, whatever is on disk; nothing is built, tested or served | – |
| The backend booted for the hidden tests but does not come up when served for the human and the judge | `Frontend–API integration`, `Manual testing`, with the served backend's failure in Notes | `Local build` and the hidden-test rows keep what `contract-results.json` says; every other row is judged |

Every zero a stop rule causes says so in its Notes, with the stage and the
first concrete error line; the hidden-test rows quote the end of the stop's
detail instead, as `--rows` prints it, and the judge does not edit them.
`Task completion time` keeps the measured duration in an all-zero CSV.

**Infra is not data.** A harness fault is never a stop: a Docker or image
error, a busy port, a failed `python3 -m venv`, a `pip install` or `npm
install` that fails while PyPI or the registry cannot be reached either, a
step killed from outside the attempt (the kernel's OOM killer, the operator),
a container that cannot be proven removed, or a `run.json` that records
`failureKind: "infra"` or `softDenied: true`. Nothing is written for such an
attempt; it is scored once the fault is fixed, or re-run.

**No double jeopardy.** `Tech stack & run contract` and `Penalty` never
deduct again for a defect a stop rule already scored; the Notes name the stop
instead.

## Local build (auto)

- `1` — the backend booted for the hidden tests (`contract-results.json`'s
  `boot.ok` is `true`) and no frontend stop applies: `npm install` and `npm
  run build` succeed in `frontend/` and `npm run dev` serves. Build warnings do
  not reduce it.
- `0` — a backend stop or a frontend stop.

## Frontend–API integration (agent)

Scores the SPA's wiring to the backend, not the backend's answers: a screen
that faithfully shows a wrong plan is integrated, and the hidden tests score
the plan. Checked in the source and against the running backend and dev
server. The eight points:

1. **Dashboard** counts orders by status, shows each technician's hours for
   the selected week and the low-stock parts, all from API responses.
2. **Schedule** reads `GET /api/v1/schedule?week_start=…` for the week in its
   selector, which defaults to 2026-10-05.
3. **Generate plan** calls `POST /api/v1/plan?week_start=…` for that week,
   the view then shows the new schedule without a manual reload, and the
   week's blocked and unscheduled orders are listed with their
   `status_reason`.
4. **Work Orders** list reads `GET /api/v1/work-orders`, and its status,
   priority and site filters change what it shows.
5. **Create form** sends `POST /api/v1/work-orders` and shows the API's own
   `error.message` for a 422.
6. **Detail view** shows every field of the order, `status_reason` included,
   and offers only the transitions legal from its status, each sent as
   `PATCH /api/v1/work-orders/{id}`, with the view updated from the response.
7. **Inventory** reads `GET /api/v1/parts` and shows on hand, reserved,
   available, minimum stock and the `low_stock` flag the API computed.
8. **Errors are visible:** a failed request — the backend down, a 4xx — shows
   a message, not a blank screen, an endless spinner or nothing at all.

Domain data means sites, assets, technicians (their skills included), parts
and work orders; the values `prompt.md` fixes — statuses, priorities, status
reasons — are not, and neither is an input's placeholder text, what the user
just entered while its request is in flight, or a test's fixture that is not
a copy of the seed.

- `1` — all eight points hold, and the frontend holds no domain data of its
  own.
- `0.5` — at least five points hold, and no screen shows domain data that did
  not come from the API.
- `0` — four or fewer hold; or any screen shows domain data that did not come
  from the API, hard-coded, mocked or otherwise (a copy of the seed, a mock
  module, fake data shown when a request fails), which `prompt.md` forbids; or
  the frontend calls no endpoint at all.

## Code structure (agent)

Judged on the source alone. `prompt.md` asks for the HTTP layer, the
request/response schemas, the in-memory store and the planner in separate
backend modules, TypeScript types for the API resources, and the API calls in
one place. The six points:

1. **Backend modules:** routes, pydantic schemas, the in-memory store and the
   planner each live in their own module (or package) of the backend.
2. **Planner isolated:** the planning rules are functions of their own that
   take the state they need and return a result; no route handler sorts
   candidates, searches for slots or checks parts, and the planner uses no
   FastAPI object.
3. **Frontend types:** one declaration of each API resource (and of the plan
   and schedule results), used by the API calls and the screens.
4. **One API module:** every request goes through one module (or one
   directory of API modules); no screen or component calls `fetch` (or an
   HTTP client) directly.
5. **Screens as components:** each of the four screens is its own component,
   not one component switching over all four.
6. **No dead scaffolding:** no source module that nothing imports (entry
   points, type declarations and tool configs aside), no template demo left in
   place (the Vite counter, its logo assets, "Edit src/App.tsx"), no
   commented-out blocks of old code.

- `0` — point 2 fails (planner rules inside route handlers); or the backend is
  one file or the frontend one component; or three or more points fail; or
  the same non-trivial logic — a validation routine, the stock arithmetic, a
  request wrapper — is copied in full within the backend or within the
  frontend (one helper called from several places is not duplication, and
  neither is a form check that mirrors a server rule).
- `0.5` — one or two points fail, and point 2 holds.
- `1` — all six points hold.

The source present is what is judged, wherever it sits in the attempt: a
half the attempt did not produce fails its points here, and so does a planner
it did not write (points 1 and 2), since this row scores structure, not a
stop.

## Tech stack & run contract (agent)

Judged on the source, against `prompt.md` section 1, and on the port the
served dev server reported (under a frontend stop, which serves nothing, on
the Vite config and the `dev` script, Vite's default port being 5173). The
seven points:

1. **Layout:** `backend/` and `frontend/` sit at the attempt's root, with
   `README.md` beside them.
2. **README:** it gives the run contract's commands for both halves:
   `python3 -m venv .venv`, `.venv/bin/pip install -r requirements.txt` and
   `.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 5100` in `backend/`;
   `npm install && npm run build` and `npm run dev` in `frontend/`.
3. **Backend stack:** FastAPI and pydantic; `requirements.txt` lists the
   backend's direct PyPI dependencies, `uvicorn` included; `app/main.py`
   exposes `app`. A package that arrives transitively — pydantic and
   starlette through FastAPI — need not be listed separately.
4. **Frontend stack:** React, TypeScript, Vite and Tailwind CSS (version 3 or
   4, both accepted), with `build` and `dev` scripts in `frontend/package.json`.
5. **Dev server:** port 5173, and `/api` proxied to `http://localhost:5100` in
   the Vite config.
6. **In-memory state:** no database, no file written at run time; a restart
   returns the seed.
7. **Nothing forbidden:** no authentication, no internationalisation, no
   Docker files, no call to an LLM or any other external API. Static assets
   such as fonts or icons loaded from a CDN are not an external API.

- `1` — no point fails.
- `0.5` — exactly one point fails.
- `0` — two or more points fail.

A point fails only on a defect this row counts. A defect that caused a stop is
not counted again here, and neither is a point that defect makes impossible to
check; the Notes name the stop instead.
Warnings about the harness itself (an image that differs from the one the
attempt ran in) are not the model's and deduct nothing.

## Manual testing (human)

The person opens the running app, with the backend on port 5100 and the dev
server on 5173, and tries the five flows:

1. **Navigation:** all four screens are reachable and render without an
   error.
2. **Schedule:** week 2026-10-05 is preselected; "Generate plan" fills the
   timeline and lists the blocked and unscheduled orders with their reasons.
3. **Work Orders:** the filters change the list; the form creates an order,
   and an invalid submission shows the API's error message.
4. **Detail:** it shows every field including `status_reason`, and a legal
   transition works and updates the view.
5. **Dashboard and Inventory:** status counts, technician hours and low-stock
   parts are shown, and the parts table flags low stock.

- `1` — all five flows work without a manual reload.
- `0.5` — exactly one flow is broken or missing; or all five work, but only a
  manual reload shows fresh data.
- `0` — the app does not load, or two or more flows are broken or missing (a
  flow that works after a manual reload is not broken).

## Consistent UI (human)

Under a backend stop, judged on the frontend as it renders without data.

- `1` — the app's own styles apply on every screen (its shell and most of its
  content), and the four screens share one visual language: the same
  navigation and layout shell, type, colours, spacing, and button, table and
  form styles.
- `0.5` — as `1`, with a few local lapses: one screen with its own button or
  table style, a form left in browser-default styling, a misaligned block.
- `0` — styles broken or missing on any screen (unstyled HTML, CSS not
  applied), or the screens look like different applications, or lapses on
  most screens.

## Responsive design (human)

Under a backend stop, judged on the frontend as it renders without data.
Checked at a phone width (375 px) and a desktop width (1280 px or more).

- `1` — every screen is usable at both widths: the navigation stays
  reachable, the page never scrolls sideways (a table or the timeline may
  scroll inside its own container), and the forms fit.
- `0.5` — mostly responsive, with the navigation and every screen's content
  reachable at both widths (truncated labels and overlapping text still count
  as reachable), and minor issues on one or two screens: a table that pushes
  the page sideways, a cramped timeline, overlapping text.
- `0` — the layout does not adapt: at either width the navigation or content
  is cut off or unreachable, or most screens scroll sideways; or three or more
  screens have the minor issues `0.5` allows on one or two.

## Penalty (agent proposes, human confirms)

For a defect that no other row and no stop rule scores. The judge agent
proposes an amount with its evidence — a file and line, or the behaviour it
observed — and a person confirms it or sets another amount with a reason.

- `1` — something unsafe: a lifecycle script that does more than build the
  project (writes outside it, downloads and runs code), an endpoint the task
  did not ask for that executes its input, a committed credential.
- `0.5` — a defect outside every other row that a user or maintainer would
  notice: files unrelated to the task shipped beside it (large generated
  artefacts; stray source is `Code structure`'s), a README that claims what the
  attempt does not do
  (tests that do not exist), a UI that polls the API in a tight loop.
- `0` — neither of the above: no deduction.

Only an all-zero CSV — both stops, or a `failureKind: "model"` run — forces
`Penalty` to 0.

## Notes

Notes are the audit trail. Name what decided the score: a file and line, an
endpoint and its status code, a package version, the first concrete error
line. When a band is ambiguous for an attempt, apply the stricter reading —
the one that leaves the attempt fewer points; for `Penalty`, the larger
deduction, though never for a defect another row or a stop may already score
— and say in the Notes which way it was read.
