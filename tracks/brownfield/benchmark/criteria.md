# Benchmark criteria — Brownfield Track

Every attempt modifies the frozen Meridian Maintenance Console base of `tracks/brownfield/base/` to implement the workload-balanced planning feature described in `prompt.md`. It is scored on 10 rows. **The total max score is 12 points**, and 7 points come from hidden automated tests (4 points from the 58-test regression suite and 3 points from the change suite).

- **Total** = the sum of the `Score` of every row that has a numeric `Max`, minus `Penalty`.
- **Max** = the sum of those rows' `Max`: 12.
- **Percentage** = total / max × 100.

`Task completion time`, `Test run`, and `Penalty` are not in the denominator. `Penalty` is subtracted from the total.

## Rows

| Criterion | Max | Scored by |
|---|---|---|
| Task completion time | N/A | auto |
| Test run | N/A | auto |
| Local build | 1 | auto |
| Regression | 4 | hidden |
| Change suite | 3 | hidden |
| Diff locality | 1 | auto |
| Code structure | 1 | agent |
| Self-verification | 1 | agent |
| Visual design | 1 | human |
| Penalty | N/A | penalty |

- `auto` — the harness measures it, or it follows mechanically from what the harness measured.
- `hidden` — the hidden regression and change suites score it; the judge copies the result.
- `agent` — the judge agent scores it against the bands below.
- `human` — a person scores it against the bands below; it is never defaulted.
- `penalty` — the judge agent proposes a deduction with its evidence, and a person confirms or changes it.

This table is the one in `scripts/lib/brownfield-rubric.ts`, byte for byte; a test keeps them equal. In the sections below, a row scores the first band whose description holds, read from the top.

## The CSV

Each scored attempt gets `eval-results/<id>-attempt-<n>/eval-results.csv`:

- the header `Criterion,Score,Max,Notes`, then the 10 rows in the table's order, with exactly those names;
- `Max` as in the table, `N/A` where the table says so;
- `Score`: `1` or `0` for `Local build`; two decimals at most for `Regression`, `Change suite`, and `Diff locality`; `1`, `0.5` or `0` for the three agent and human rows; `0`, `0.5` or `1` for `Penalty`;
- `Task completion time`: the run's duration, `Xmin Ys` (`30min 2s`: whole seconds rounded, minutes never converted to hours, no zero padding), the same string in `Score` and `Notes`; `N/A` in both for an attempt without a `run.json`;
- `Test run`: when the attempt was scored, `D.MM.YYYY HH:MM` (`18.09.2026 14:05`), the same string in `Score` and `Notes`;
- every other `Notes` value in double quotes, each `"` inside doubled, on one line. The two info rows stay unquoted: their formats cannot hold a comma.

## Hidden-test rows

### Regression suite (4 points, 58 tests)

Re-runs the 58 classic hidden contract tests against the attempt's modified backend. Each test file runs against a freshly started backend, starting from `POST /reset`. The row scores:

```
Math.round(passed / 58 × 4 × 100) / 100
```

so 58 of 58 is 4.00, and 50 of 58 is 3.45.

### Change suite (3 points)

Runs automated hidden contract tests for the new `strategy=balanced` feature on a scenario created in `EMPTY_WEEK` (`2026-10-12`):

1. Backwards compatibility: default `POST /plan?week_start=2026-10-12` (omitting `strategy`) returns strictly the historical response keys (`["blocked", "orders", "scheduled", "unscheduled", "week_start"]`) without `technician_load`.
2. Response field presence: `technician_load` is present if and only if `strategy` is explicitly specified (`?strategy=earliest` or `?strategy=balanced`).
3. Completeness of technician keys: `technician_load` contains every technician ID in the system (`T-001`, `T-002`, `T-003`, `T-004`), assigning 0 to unused technicians.
4. Conservation of load: sum of values in `technician_load` equals the total duration of all scheduled work orders in the week.
5. Workload balancing: `?strategy=balanced` produces a strictly lower workload spread across qualified technicians than `?strategy=earliest`.
6. Qualification validity: every order in the balanced schedule is assigned to a qualified technician within shift boundaries.

The row scores:

```
Math.round(passed / total × 3 × 100) / 100
```

## Diff locality (1 point, auto)

Evaluates whether changes were confined to the expected architectural seams:

- **Allowed module/directory glob patterns**:
  - `backend/app/planner*`
  - `backend/app/routes*`
  - `backend/app/schemas*`
  - `backend/tests/**`
  - `frontend/src/services/**`
  - `frontend/src/types/**`
  - `frontend/src/views/**`

Any file modified in the attempt relative to `tracks/brownfield/base` that does not match one of these patterns is an outside file.

**Formula**:
```
locality = max(0, 1.0 - 0.25 * outside_files) * max(0, 1.0 - total_lines / 500)
```
where:
- `outside_files`: count of modified files outside allowed patterns.
- `total_lines`: total insertions + deletions from `git diff --numstat` against the frozen base; installation artifacts and tool caches (including `node_modules`, `dist`, `package-lock.json`, `.venv`, `__pycache__`, `.pytest_cache`, `.mypy_cache`, and `.ruff_cache`) are excluded from line counting and outside files.
- Score is rounded to two decimal places and clamped to `[0, 1.0]`.

## Local build (1 point, auto)

- `1` — `backend/` installs and starts cleanly, `/api/v1/health` returns 200, and `frontend/` builds cleanly (`npm run build`).
- `0` — either backend fails to install/start/health-check, or frontend build fails.

## Code structure (1 point, agent)

- `1` — changes follow the existing architecture cleanly: planning strategy is cleanly modularized, request schemas are properly typed with pydantic, and no dead code or unhandled edge cases are introduced.
- `0.5` — logic is functional but messy: copy-pasted planning logic without reuse, untyped query parameter handling, or poorly structured module boundaries.
- `0` — monkey-patching, severe architectural degradation, or broken abstractions.

## Self-verification (1 point, agent)

- `1` — the attempt adds tests in `backend/tests/**` exercising `strategy=balanced`, verifying load distribution and response shape, and those tests pass when run in the harness.
- `0.5` — tests are added but are trivial, incomplete, or fail.
- `0` — no new tests added by the model.

## Visual design (1 point, human)

- `1` — optional frontend UI updates (e.g. strategy selector on ScheduleView) are coherent, follow Tailwind styling, and integrate seamlessly with the existing interface; OR if no frontend changes were made, the existing visual design remains intact and uncompromised.
- `0.5` — UI changes were attempted but look awkward, misaligned, or visually jarring.
- `0` — frontend UI is visibly broken or corrupted.

## Penalty (agent proposes, human confirms)

For a defect that no other row and no stop rule scores:
- `1` — something unsafe: lifecycle scripts executing untrusted code, committed credentials, or severe regressions.
- `0.5` — an unprompted defect a maintainer would notice: extraneous files committed, misleading README claims.
- `0` — no deduction.

## Stop rules

| Stop | Rows set to 0 | Rows still judged |
|---|---|---|
| Backend stop | `Local build`, `Regression`, `Change suite`, `Diff locality` | `Code structure`, `Self-verification`, `Visual design`, `Penalty` |
| Frontend stop | `Local build` | `Regression`, `Change suite`, `Diff locality`, `Code structure`, `Self-verification`, `Visual design`, `Penalty` |
| Both stops | every row, `Penalty` included: the all-zero CSV, and scoring ends | – |
| `run.json` records `failureKind: "model"` (including `noDiffFromBase`) | every row, `Penalty` included: the all-zero CSV; nothing is built, tested or served | – |
