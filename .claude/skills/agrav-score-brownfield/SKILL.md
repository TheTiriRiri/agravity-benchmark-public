---
name: agrav-score-brownfield
description: Score one agrav-bench brownfield attempt (modifying tracks/brownfield/base with FastAPI balanced planner) against tracks/brownfield/benchmark/criteria.md and write its 10-row eval-results.csv — hidden contract tests, change suite, diff locality, local build, stop rules, agent rows, and visual design. Use when the user wants a brownfield attempt judged, scored or evaluated in the agrav-bench repo.
user-invocable: true
---

# agrav-score-brownfield

Judges **one** brownfield attempt: the Meridian Maintenance Console modifying the frozen
FastAPI and React base in `tracks/brownfield/base/` according to `tracks/brownfield/prompt.md`
(adding `strategy=balanced` to `POST /plan` with technician load balancing and returning
`technician_load`). The output is one file, `<r>/eval-results/<dir>/eval-results.csv`,
where `<dir>` is `<id>-attempt-<n>`.

## Authority

- `tracks/brownfield/benchmark/criteria.md` is normative for the bands, the stop rules and
  the CSV format. `scripts/lib/brownfield-rubric.ts` is normative for the rows, their order
  and their maxima. This file is the procedure: where it disagrees with either, this file
  is wrong.
- Never soften a band. Award what the wording gives, not what the attempt deserves on
  vibes. When a band is ambiguous for an attempt, apply the stricter reading (the one that
  leaves the attempt fewer points; for `Penalty`, the larger deduction, though never for a
  defect another row or a stop may already score) and say in the Notes which way you read
  it.
- Read before scoring: `tracks/brownfield/benchmark/criteria.md`; `tracks/brownfield/prompt.md`
  (what the model was asked); `benchmark/context/seed.json`.
- `tracks/brownfield/benchmark/runner.yaml` records the judge (`judge:`) and rubric (`rubric:`).
  Scores are comparable only under the same judge and rubric, so if this session's model is not
  the one recorded, tell the user before scoring — and likewise if
  `contract-results-brownfield.json`'s `rubric` (Phase 1) is not `runner.yaml`'s `rubric:`.

## Input

- The attempt directory name `<dir>`, e.g. `gemini-38-flash-low-attempt-1`. Ask for it if
  the user gave none; do not guess from a listing. One attempt per invocation.
- The track root `<r>`, `tracks/brownfield` by default. It holds `eval-attempts/` and
  `eval-results/`: read `<r>/eval-attempts/<dir>/` and `<r>/eval-results/<dir>/run.json`,
  write `<r>/eval-results/<dir>/eval-results.csv`. You MUST pass `--root <r>` explicitly to
  all commands (`contract-tests-brownfield`, `serve-attempt`, `serve-attempt --stop`, and
  `contract-results-brownfield --rows`): scripts like `serve-attempt` default to the repository
  root, so omitting `--root` would run or score a classic attempt of the same name. The scripts,
  the hidden tests, `criteria.md` and `runner.yaml` always come from the repository, and every
  command runs from the repository root.
- **The layout is pinned:** the backend is `<attempt>/backend`, the frontend `<attempt>/frontend`.
  No heuristic and no search for a nested project: an attempt that put them elsewhere meets
  the stop rules.
- **The attempt directory is read-only** except for install artefacts:
  `frontend/node_modules/`, `frontend/dist/` and a `frontend/package-lock.json` the install
  created. `backend/` is mounted read-only into its containers, and the backend's venv
  lives in a scratch directory outside the attempt.

Start `contract-tests-brownfield` and `serve-attempt` as `node --import tsx scripts/<name>.ts`,
never through `npm run` (it does not reliably forward signals) and never through the `tsx` bin.
Each Bash call is a fresh shell, so create one log directory outside the repository first
(`mktemp -d`) and write its literal path — `<log>` below — into every later command.

## Phase 0 — `run.json`

Read `<r>/eval-results/<dir>/run.json` (schema: `scripts/lib/run-json.ts`).

| `run.json` | Action |
|---|---|
| `failureKind: "infra"`, or `softDenied: true` | **Refuse.** Tell the user which (`stderrTail`, `softDenied`) and that the attempt must be re-run. Write nothing. |
| `failureKind: "model"` (including `noDiffFromBase`) | Write the **all-zero CSV** (Phase 4) with the measured duration and failure reason from `run.json` (`noDiffFromBase: true` → "no changes against base"; otherwise reason from `envelope.status` / `stderrTail`, e.g. timeout, crash), and stop. Run nothing — no contract tests, no npm, no serving — whatever is on disk. |
| `failureKind: null` | Continue. |
| missing | **Stop** and tell the user. Only if the user says the attempt is synthetic: continue, pass `--ignore-run-json` to both scripts (written `[--ignore-run-json]` below), and write `Task completion time` as `N/A`. |

Keep `durationMs` for Phase 4. Before Phase 1, snapshot the attempt for the final check:

```bash
find <r>/eval-attempts/<dir> \( -name node_modules -o -name dist \) -prune -o -type f -print | sort > <log>/before.txt
```

## Phase 1 — hidden tests and frontend build

### Hidden tests

**Always re-run them**: a `contract-results-brownfield.json` from an earlier run survives a
re-run of the attempt and would score files that are gone. Start it in the background and wait
for exit:

```bash
node --import tsx scripts/contract-tests-brownfield.ts --attempt <dir> --root <r> [--ignore-run-json] > <log>/contract-tests-brownfield.log 2>&1; echo "exit=$?" >> <log>/contract-tests-brownfield.log
```

| Last line | Meaning | Action |
|---|---|---|
| `exit=0` | `contract-results-brownfield.json` written, a backend stop included | Read it (below). |
| `exit=1` | Refused, or a harness fault: infra | Stop. Write nothing. Report the `contract-tests-brownfield:` message. |
| `exit=2` | Usage | Your command is wrong: fix it and start again. |
| `exit=128` or above | Interrupted by a signal | Stop. Write nothing. |

From `<r>/eval-results/<dir>/contract-results-brownfield.json` take `boot` — `ok: false` is the
**backend stop**, with its `stage` and `detail` — and `warnings`, `pipFreeze`, `rubric`,
`regression`, `changeSuite`, `diffLocality` and `pytest`.
Never copy scores out of it by hand: Phase 4 pastes the printed rows from
`contract-results-brownfield.ts --rows`.

### Frontend build

Before installing, read the `scripts` of `frontend/package.json`. If a script npm runs on the host
(`preinstall`, `install`, `postinstall`, `prepublish`, `preprepare`, `prepare`, `postprepare` for install;
`prebuild`, `build`, `postbuild` for build; `predev`, `dev`, `postdev` for serving) does something
other than build or serve the project, stop and ask the user. Note whether `frontend/package-lock.json`
exists yet.

1. `frontend/package.json` missing → **frontend stop**.
2. `npm install`, bounded by 10 minutes, in the background:

   ```bash
   (cd <r>/eval-attempts/<dir>/frontend && timeout -v -k 10 600 npm install) > <log>/npm-install.log 2>&1; echo "exit=$?" >> <log>/npm-install.log
   ```

   On any non-zero exit, first remove the partial install:
   `rm -rf <r>/eval-attempts/<dir>/frontend/node_modules`. Then check the log:
   - timeout (124 or 137): probe registry with `timeout -k 5 60 npm ping`. Fails → **infra**; succeeds → **frontend stop**;
   - non-zero below 128: probe registry. Fails → **infra**; succeeds → **frontend stop**;
   - signal 128 or above: ask user if killed from outside. Yes → **infra**; No → **frontend stop**.
3. `npm run build`, in the background:

   ```bash
   (cd <r>/eval-attempts/<dir>/frontend && npm run build) > <log>/build.log 2>&1; echo "exit=$?" >> <log>/build.log
   ```

   A non-zero exit below 128 → **frontend stop**. Signal 128 or above: ask user if killed from outside.
   If running after 10 minutes, ask user.

### Local build rule (`criteria.md:98-101`)

`Local build = 1` if and only if **both**:
1. `boot.ok` in `contract-results-brownfield.json` is `true`, AND
2. `npm run build` in `frontend/` exited with code 0.

Otherwise `Local build = 0`.

### The stop rules

| Stop | Rows set to 0 | Rows still judged |
|---|---|---|
| **Backend stop** | `Local build`, `Regression`, `Change suite`, `Diff locality` | `Code structure`, `Self-verification`, `Visual design`, `Penalty` |
| **Frontend stop** | `Local build` | `Regression`, `Change suite`, `Diff locality`, `Code structure`, `Self-verification`, `Visual design`, `Penalty` |
| **Both stops** | Every row, `Penalty` included: all-zero CSV, scoring ends | – |
| `run.json` `failureKind: "model"` (incl. `noDiffFromBase`) | Every row, `Penalty` included: all-zero CSV; nothing tested or served | – |
| **Backend fails only in `serve-attempt`** | see below | see below |

#### Backend boots in `contract-tests-brownfield` but not in `serve-attempt`

If the backend came up for contract tests (`boot.ok` is `true` in `contract-results-brownfield.json`),
but `serve-attempt` reports `backend stop`:
- `Local build`: **keeps its Phase 1 value** (1 if frontend build passed, 0 if it failed).
- `Regression`, `Change suite`, `Diff locality`: **pasted from `--rows`** as usual.
- `Visual design`: **still judged** without backend data (evaluating UI skeleton or intact layout).
- `Code structure`, `Self-verification`: **still judged** (agent reads source code).
- `Penalty`: **proposed and confirmed** as usual.

This is **not** a "both stops" case.

- **Both stops** → write the all-zero CSV now (Phase 4) and stop: no Phase 2, no Phase 3.
- **A frontend stop** → skip Phase 2 (the frontend cannot be served) and go to Phase 3.
- **A backend stop** → Phase 2 still runs, for `Visual design` judged on the frontend without data.

A row a stop zeroes is not scored, not asked and not argued. Its Notes say so:
`"Not scored: backend stop (install) — ERROR: No matching distribution found for fastapi==9.9"`.

## Phase 2 — serve, and the human row

**Phase 2 begins once `serve-attempt` gets past its lock and its port check**, and from
then on Phase 3's `--stop` runs before you finish, on every path.

Start `serve-attempt` in the background, passing `--root <r>` explicitly:

```bash
node --import tsx scripts/serve-attempt.ts --attempt <dir> --root <r> [--ignore-run-json] > <log>/serve.log 2>&1; echo "exit=$?" >> <log>/serve.log
```

Wait for readiness:

```bash
for i in $(seq 1200); do grep -qE '^(ready: |exit=)' <log>/serve.log && break; sleep 1; done; grep -E '^(ready|backend|frontend|warning|serve-attempt|exit=)' <log>/serve.log
```

- **`exit=1` before `ready:`** — read the `serve-attempt:` message:
  - another serve-attempt runs, or ports 5100/5173 taken: tell user and wait.
  - dead pid state file: run `--stop` (Phase 3) and start once more.
  - harness fault: **infra** — `--stop`, write nothing, report it.
- **`exit=2`** — usage error: fix command and start again.
- **`exit=128` or above** — interrupted by signal: stop and write nothing. Run `--stop` only if
  past the lock for this attempt.
- **`ready: <url> (backend ok|backend stop (<stage>); frontend ok|frontend stop)`**:
  - `frontend stop`: apply table. If backend stop was also recorded, it is both stops: `--stop` and write all-zero CSV.
  - `backend stop` while contract tests booted: apply backend-fails-only-in-serve column.

### Asking the human

Unless a stop rule zeroed it, make **one** `AskUserQuestion` call:
- Give the human the URL from `ready:`, the SPA routes (`grep -rnE "path[:=]|<Route|createBrowserRouter|useRoutes" <r>/eval-attempts/<dir>/frontend/src`),
  and context: "This is a brownfield attempt modifying the base. The model was asked to add `strategy=balanced` to the planner. Visual design evaluates whether any UI changes are coherent or, if none were made, that the existing UI remains intact."
- One question for `Visual design`, with bands from `criteria.md:115-119`:
  - `1` — optional frontend UI updates are coherent, follow Tailwind styling, integrate seamlessly; OR if no frontend changes were made, the existing visual design remains intact and uncompromised.
  - `0.5` — UI changes were attempted but look awkward, misaligned, or visually jarring.
  - `0` — frontend UI is visibly broken or corrupted.
- **Never default the human row.** A question left unanswered is asked again.
- Under a backend stop, the frontend runs without data: still ask `Visual design`.
- Notes are prefixed `User:` — `"User: existing UI layout intact, no regressions"`.

## Phase 3 — the agent rows and the Penalty

Search source only, skipping `node_modules/`, `dist/`, `.venv/`, `__pycache__/` and `.antigravitycli/`:

```bash
grep -rn --exclude-dir={node_modules,dist,.venv,__pycache__,.antigravitycli} '<pattern>' <r>/eval-attempts/<dir>
```

1. **Code structure** (`criteria.md:103-107`, 1 point):
   - `1` — changes follow existing architecture cleanly: balanced strategy cleanly modularized in `backend/app/planner*`, pydantic schemas used, no copy-pasting, no dead code.
   - `0.5` — functional but messy: copy-pasted planner logic, untyped parameters, poor module boundaries.
   - `0` — monkey-patching, severe architectural degradation, or bypassed schemas.
   Name every point that failed with a file and line.

2. **Self-verification** (`criteria.md:109-113`, 1 point):
   Read `pytest` from `contract-results-brownfield.json`:
   - `1` — tests added/extended in `backend/tests/**` exercising `strategy=balanced` (load distribution across technicians, response shape — per OQ-7b-3) AND clean pass (`ran: true, exitCode: 0, failed: 0, errors: 0, timedOut: false`).
   - `0.5` — tests added but trivial/incomplete, OR pytest failed (exit code non-zero, errors > 0, timed out, or missing in venv `notRunReason: "pytest not installed in the attempt's venv"`).
   - `0` — no new/extended tests for balanced strategy (`notRunReason: "no backend/tests"` or diff shows no tests added/extended).
   Under a backend stop (`pytest.notRunReason === "backend stop"`): since pytest could not run, the row is capped at `0.5` with note (e.g. `"backend stop: tests added in backend/tests/test_planner.py but could not be executed"` or `0` if no tests were added).
   Verify by comparing with base: `diff -rq tracks/brownfield/base/backend/tests <r>/eval-attempts/<dir>/backend/tests`, plus reading changed or added files and the `pytest` object from `<r>/eval-results/<dir>/contract-results-brownfield.json`.

3. **Penalty** (`criteria.md:121-126`):
   - Propose `0`, `0.5`, or `1` with evidence. Never for what another row or stop already scored.
   - Present in a **second** `AskUserQuestion` call. Left unanswered, ask again.
   - Notes: `"Proposed 0.5 (<reason>); user confirmed"`, or `"User: 1 — <reason>"`.
   - All-zero CSV skips this: `Penalty` is `0`.

After scoring, if Phase 2 began:

```bash
node --import tsx scripts/serve-attempt.ts --stop --root <r>
```

## Phase 4 — the CSV

Write `<r>/eval-results/<dir>/eval-results.csv` and nothing else.
The template — header and the 10 rows of `scripts/lib/brownfield-rubric.ts`, in order:

```csv
Criterion,Score,Max,Notes
Task completion time,<Xmin Ys|N/A>,N/A,<same value>
Test run,<D.MM.YYYY HH:MM>,N/A,<same value>
Local build,<1|0>,1,"<note>"
Regression,<replace this whole line with line 1 of --rows>
Change suite,<replace this whole line with line 2 of --rows>
Diff locality,<replace this whole line with line 3 of --rows>
Code structure,<1|0.5|0>,1,"<note>"
Self-verification,<1|0.5|0>,1,"<note>"
Visual design,<1|0.5|0>,1,"<note>"
Penalty,<0|0.5|1>,N/A,"<note>"
```

- **The three tool-provided rows are pasted verbatim** from:

  ```bash
  node --import tsx scripts/contract-results-brownfield.ts --rows <dir> --root <r>
  ```

  Each printed line is a whole CSV row starting with the row name:
  `Regression,4,4,"58/58 passed"`
  `Change suite,3,3,"4/4 passed"`
  `Diff locality,1,1,"0 outside files, 45 lines changed"`
  Compute, edit and re-round nothing in them.
- `Max` from `brownfield-rubric.ts`: `1`, `4`, `3`, `1`, `1`, `1`, `1`, and `N/A` for the two info rows and `Penalty`.
- `Score` is `1`, `0.5` or `0` for the three agent/human rows; `1` or `0` for `Local build`; `0`, `0.5` or `1` for `Penalty`.
- **`Task completion time`:** `s = round(durationMs / 1000)`, then `${floor(s / 60)}min ${s % 60}s` (`30min 2s`). Never hours, never zero-padded. Same string in Score and Notes; `N/A` for synthetic.
- **`Test run`:** `date +"%-d.%m.%Y %H:%M"`, same string in Score and Notes.
- **Quoting:** every `Notes` value in double quotes, each `"` inside doubled, on one line. Info rows stay unquoted.
- **No `API cost` row:** `process-results` adds it.
- Trailing newline, no blank lines.

### The all-zero CSV

For `failureKind: "model"` (including `noDiffFromBase`) and both stops: every scored row 0, `Penalty` 0, and `Task completion time` keeps measured duration. The reason in Notes for `failureKind: "model"` (`"Not scored: run.json failureKind model (<reason>)"`) comes from `run.json`: when `noDiffFromBase: true`, use `"no changes against base"`; otherwise take the reason from `envelope.status` / `stderrTail` (e.g. timeout, crash).

For `durationMs: 1802000`, scored on 4 October 2026 at 14:05:

```csv
Criterion,Score,Max,Notes
Task completion time,30min 2s,N/A,30min 2s
Test run,4.10.2026 14:05,N/A,4.10.2026 14:05
Local build,0,1,"Not scored: run.json failureKind model (no changes against base)"
Regression,0,4,"Not scored: run.json failureKind model (no changes against base)"
Change suite,0,3,"Not scored: run.json failureKind model (no changes against base)"
Diff locality,0,1,"Not scored: run.json failureKind model (no changes against base)"
Code structure,0,1,"Not scored: run.json failureKind model (no changes against base)"
Self-verification,0,1,"Not scored: run.json failureKind model (no changes against base)"
Visual design,0,1,"Not scored: run.json failureKind model (no changes against base)"
Penalty,0,N/A,"Forced to 0: an all-zero CSV"
```

## Before you report

1. Check the file against `scripts/lib/brownfield-rubric.ts`, from the repository root:

   ```bash
   node --import tsx --input-type=module -e '
   import { parse } from "csv-parse/sync";
   import { readFileSync } from "node:fs";
   import { BROWNFIELD_RUBRIC_ROWS } from "./scripts/lib/brownfield-rubric";
   const text = readFileSync(process.argv[1], "utf8");
   let rows;
   try { rows = parse(text, { columns: true }); } catch (error) { console.log("WRONG: not a CSV: " + error.message); process.exit(0); }
   const scoreOk = (r, { Score: s, Notes: n }) =>
     r.name === "Task completion time" ? /^((0|[1-9]\d*)min [1-5]?\ds|N\/A)$/.test(s) && n === s
     : r.name === "Test run" ? /^[1-9]\d?\.\d\d\.\d{4} \d\d:\d\d$/.test(s) && n === s
     : r.scoredBy === "hidden" ? /^\d+(\.\d+)?$/.test(s) && Number(s) <= r.max
     : r.scoredBy === "auto" && r.name === "Diff locality" ? /^\d+(\.\d+)?$/.test(s) && Number(s) <= r.max
     : (r.name === "Local build" ? ["1", "0"] : r.scoredBy === "penalty" ? ["0", "0.5", "1"] : ["1", "0.5", "0"]).includes(s);
   const wrong = BROWNFIELD_RUBRIC_ROWS.filter((r, i) => rows[i]?.Criterion !== r.name || rows[i].Max !== String(r.max ?? "N/A") || !scoreOk(r, rows[i]));
   const problems = [];
   if (rows.length !== BROWNFIELD_RUBRIC_ROWS.length) problems.push("WRONG ROW COUNT, " + BROWNFIELD_RUBRIC_ROWS.length + " expected");
   if (wrong.length > 0) problems.push("WRONG: " + wrong.map((r) => r.name).join(" | "));
   if (!text.endsWith("\n")) problems.push("NO TRAILING NEWLINE");
   console.log(text.split("\n").length - 1 + " lines, " + rows.length + " rows; " + (problems.join("; ") || "names, order, Max and Score cells match brownfield-rubric.ts"));
   ' <r>/eval-results/<dir>/eval-results.csv
   ```

   Expect `11 lines, 10 rows; names, order, Max and Score cells match brownfield-rubric.ts`.
2. Check attempt directory gained only install artefacts:

   ```bash
   find <r>/eval-attempts/<dir> \( -name node_modules -o -name dist \) -prune -o -type f -print | sort | diff <log>/before.txt -; find <r>/eval-attempts/<dir> \( -name node_modules -o -name dist \) -prune -o -type f -newer <log>/before.txt -print
   ```

3. If `--stop` was owed, check that it exited 0 and `<r>/.cache/serve-attempt.json` is gone.
4. Report total out of 12 (scored rows minus `Penalty`), percentage, stops, and reasons.

## Never

- Never edit `tracks/brownfield/benchmark/criteria.md`, `tracks/brownfield/prompt.md`,
  `benchmark/context/seed.json`, the hidden tests in `benchmark/contract-tests/` or
  `tracks/brownfield/benchmark/contract-tests/`, or `scripts/lib/brownfield-rubric.ts` while scoring.
- Never fix, complete or reconfigure the attempt, and never write into its directory
  beyond install artefacts.
- Never continue past a stop rule.
- Never default the human row (`Visual design`).
- Never award a score the band's wording does not support.
- Never re-run the model, `agy` or `run-matrix`.
- Never start `contract-tests-brownfield` or `serve-attempt` through `npm run` or the `tsx` bin.
- Never pass `--ignore-run-json` unless the user said the attempt is synthetic, and never
  pass `--allow-ungated` unless the user asked for it.
- Never kill a process or remove a container you did not start: `serve-attempt --stop` ends serving.
