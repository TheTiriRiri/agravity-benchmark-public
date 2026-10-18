# Benchmark criteria — Hard Track

Every attempt builds the Meridian Maintenance Console of `prompt.md` one-shot: a
FastAPI backend in `backend/` and a React SPA in `frontend/`. It is scored on
16 rows. **The total max score is 19 points**, and 14 points come from hidden
automated tests (11 points from 6 contract test files and 3 points from 2 Playwright
E2E test files).

- **Total** = the sum of the `Score` of every row that has a numeric `Max`,
  minus `Penalty`.
- **Max** = the sum of those rows' `Max`: 19.
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
| Planner: crews & travel | 2 | hidden |
| Planner: splitting & preemption | 2 | hidden |
| Frontend E2E: flows | 2 | hidden |
| Frontend E2E: layout & a11y | 1 | hidden |
| Code structure | 1 | agent |
| Tech stack & run contract | 1 | agent |
| Self-verification | 1 | agent |
| Visual design | 1 | human |
| Penalty | N/A | penalty |

- `auto` — the harness measures it, or it follows mechanically from what the
  harness measured.
- `hidden` — the hidden contract and E2E tests score it; the judge copies the result.
- `agent` — the judge agent scores it against the bands below.
- `human` — a person scores it against the bands below; it is never defaulted.
- `penalty` — the judge agent proposes a deduction with its evidence, and a
  person confirms or changes it.

This table is the one in `scripts/lib/hard-rubric.ts`, byte for byte; a test keeps
them equal. In the sections below, a row scores the first band whose
description holds, read from the top.

## The CSV

Each scored attempt gets `eval-results/<id>-attempt-<n>/eval-results.csv`:

- the header `Criterion,Score,Max,Notes`, then the 16 rows in the table's
  order, with exactly those names, and no `API cost` row;
- `Max` as in the table, `N/A` where the table says so;
- `Score`: `1` or `0` for `Local build`; two decimals at most for the eight
  hidden-test rows; `1`, `0.5` or `0` for the four agent and human rows; `0`,
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

### Contract test suite (11 points, 6 files, 86 tests)

`tracks/console-hard/benchmark/contract-tests/` holds one test file per contract row, 86 tests in all:

| Row | Tests | Max | What it checks |
|---|---|---|---|
| API contract | 29 | 2 | every endpoint's status codes, fields, sorting, filters and error body; strict typing on `crew_size`, `splittable`, `min_segment_minutes`; `PATCH` transitions; `POST /reset` |
| Planner: assignment rules | 12 | 2 | basic qualification, shift boundaries, 30-minute grid, single-day slots, overlap prevention, fixed load, week clipping, candidate selection |
| Planner: ordering & determinism | 11 | 1 | EDF processing order (due date earlier first, priority critical first, id ascending), technician tie-breaks, determinism |
| Planner: parts & blocking | 11 | 2 | parts checked first, available stock tracking, reservation holding, `PATCH` stock arithmetic |
| Planner: crews & travel | 10 | 2 | 2-technician crews, multi-site qualification, travel matrix gaps, daily 480-minute cap with travel, absences, site holidays |
| Planner: splitting & preemption | 13 | 2 | multi-day splitting with $k \ge 2$ segments, segment key minimization, preemption of lower-priority victims for critical orders, parts first, shortest prefix, victim reprocessing |

Each file runs against a freshly started backend, and every test starts from
`POST /reset`. A row scores

```
Math.round(passed / total × Max × 100) / 100
```

so 25 of 29 on a Max-2 row is 1.72.

### Frontend E2E test suite (3 points, 2 files, 18 tests)

Playwright runs against the attempt's running backend on port 5100 and dev server on 5173:

| Row | Tests | Max | What it checks |
|---|---|---|---|
| Frontend E2E: flows | 10 | 2 | navigation across 4 screens; creating orders and viewing validation errors; status transitions; filters; dashboard counts; crew and split order visualizations |
| Frontend E2E: layout & a11y | 8 | 1 | responsive viewport testing at 375×667 and 1280×800; no page-level horizontal overflow (`scrollWidth <= clientWidth + 1`); axe-core automated a11y audit with zero critical violations |

## Stop rules

A **backend stop** is a failure at a stage the model's files decide:
`layout` (`backend/`, `backend/requirements.txt` or `backend/app/main.py`
missing), `install` (`pip install -r requirements.txt` fails or takes over
5 minutes while PyPI is reachable, or leaves no `uvicorn`), `boot` (the server
exits before `/api/v1/health` answers) or `health` (no 2xx from
`/api/v1/health` within 60 s, each request answering within 1 s).

A **frontend stop** is `frontend/package.json` missing, `npm install` failing
or taking over 10 minutes while the registry answers `npm ping`, `npm run
build` failing, or `npm run dev` not answering HTTP at its `Local:` URL within
60 s (each request within 1 s), after one retry.

| Stop | Rows set to 0 | Rows still judged |
|---|---|---|
| Backend stop | `Local build`, the eight hidden-test rows, `Self-verification` | `Code structure`, `Tech stack & run contract`; `Visual design` on the frontend as it renders without data; `Penalty` |
| Frontend stop | `Local build`, the two frontend E2E rows, `Visual design` | the six contract hidden-test rows, `Code structure`, `Tech stack & run contract`, `Self-verification`, `Penalty` |
| Both stops | every row, `Penalty` included: the all-zero CSV, and scoring ends | – |
| `run.json` records `failureKind: "model"` | every row, `Penalty` included: the all-zero CSV, whatever is on disk; nothing is built, tested or served | – |
| The backend booted for the hidden tests but does not come up when served for the human and the judge | `Frontend E2E: flows`, with the served backend's failure in Notes | `Local build` and the hidden contract rows keep what `contract-results.json` says; every other row is judged |

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
  frontend.
- `0.5` — one or two points fail, and point 2 holds.
- `1` — all six points hold.

## Tech stack & run contract (agent)

Judged on the source, against `prompt.md` section 1, and on the port the
served dev server reported. The seven points:

1. **Layout:** `backend/` and `frontend/` sit at the attempt's root, with
   `README.md` beside them.
2. **README:** it gives the run contract's commands for both halves:
   `python3 -m venv .venv`, `.venv/bin/pip install -r requirements.txt` and
   `.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 5100` in `backend/`;
   `npm install && npm run build` and `npm run dev` in `frontend/`.
3. **Backend stack:** FastAPI and pydantic; `requirements.txt` lists the
   backend's direct PyPI dependencies, `uvicorn` included; `app/main.py`
   exposes `app`.
4. **Frontend stack:** React, TypeScript, Vite and Tailwind CSS, with `build`
   and `dev` scripts in `frontend/package.json`.
5. **Dev server:** port 5173, and `/api` proxied to `http://localhost:5100` in
   the Vite config.
6. **In-memory state:** no database, no file written at run time; a restart
   returns the seed.
7. **Nothing forbidden:** no authentication, no internationalisation, no
   Docker files, no call to an LLM or any other external API.

- `1` — no point fails.
- `0.5` — exactly one point fails.
- `0` — two or more points fail.

## Self-verification (agent)

Judged on whether the model wrote and verified tests of its own (spec §8.3):

- `1` — the repository carries model-written tests exercising the planner that pass
  when run in the harness container. Operational floor: at least one model-written
  test that calls `POST /plan` and asserts on a field of the resulting schedule passes.
- `0.5` — tests exist but are trivial or fail.
- `0` — no model-written tests exist.

## Visual design (human)

Replaces `Consistent UI` (spec §8.1). Evaluates design quality beyond automated layout/a11y checks:

- `1` — professional appearance with coherent typography, consistent spacing scale,
  deliberate color palette, clear visual hierarchy across all screens, and clear active states.
- `0.5` — minor visual inconsistencies: awkward spacing, poor contrast on secondary elements,
  or unpolished alignment on one screen.
- `0` — unstyled or broken appearance, jarring visual clashes, or completely generic browser defaults.

## Penalty (agent proposes, human confirms)

For a defect that no other row and no stop rule scores:

- `1` — something unsafe: a lifecycle script that does more than build the project,
  an unauthorized endpoint executing input, a committed credential.
- `0.5` — an unprompted defect a user or maintainer would notice: large unrelated files,
  misleading README claims, polling the API in a tight loop.
- `0` — no deduction.

## Notes

Notes are the audit trail. Name what decided the score: file and line, endpoint and status code,
or failure details. When a band is ambiguous for an attempt, apply the stricter reading.
