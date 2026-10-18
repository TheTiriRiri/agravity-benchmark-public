---
name: agrav-score-attempt
description: Score one agrav-bench attempt of the maintenance-console task (a FastAPI backend and a React SPA) against benchmark/criteria.md and write its 14-row eval-results.csv — hidden contract tests, the frontend build, the stop rules, the agent rows and the human rows. Use when the user wants an attempt judged, scored or evaluated — "score gemini-38-flash-high attempt 2", "eval this attempt", "run the judge on claude-opus-46-high-attempt-1", "generate eval-results.csv" — in the agrav-bench repo.
user-invocable: true
---

# agrav-score-attempt

Judges **one** attempt: the Meridian Maintenance Console a model built one-shot from
`prompt.md`, a FastAPI backend in `backend/` and a React SPA in `frontend/`. The output is
one file, `eval-results/<dir>/eval-results.csv`, where `<dir>` is `<id>-attempt-<n>`.

## Authority

- `benchmark/criteria.md` is normative for the bands, the stop rules and the CSV format.
  `scripts/lib/rubric.ts` is normative for the rows, their order, their maxima and every
  limit (`LIMITS`). This file is the procedure: where it disagrees with either, this file
  is wrong.
- Never soften a band. Award what the wording gives, not what the attempt deserves on
  vibes. When a band is ambiguous for an attempt, apply the stricter reading (the one that
  leaves the attempt fewer points; for `Penalty`, the larger deduction, though never for a
  defect another row or a stop may already score) and say in the Notes which way you read
  it.
- Read before scoring: `benchmark/criteria.md`; `prompt.md`, what the model was asked (its
  section 1 is the run contract); `benchmark/context/seed.json`.
- `benchmark/runner.yaml` records the judge (`judge:`). Scores are comparable only under
  the same judge and rubric, so if this session's model is not the one recorded, tell the
  user before scoring — and likewise if `contract-results.json`'s `rubric` (Phase 1) is not
  `runner.yaml`'s `rubric:`.

## Input

- The attempt directory name `<dir>`, e.g. `gemini-38-flash-high-attempt-2`. Ask for it if
  the user gave none; do not guess from a listing. One attempt per invocation.
- An optional root `<r>`, the repository by default. It holds `eval-attempts/` and
  `eval-results/`: read `<r>/eval-attempts/<dir>/` and `<r>/eval-results/<dir>/run.json`,
  write `<r>/eval-results/<dir>/eval-results.csv`. With a root, pass `--root <r>` to
  `contract-tests`, `serve-attempt` and `contract-results.ts --rows` — written
  `[--root <r>]` below. The scripts, the hidden tests, `criteria.md` and `runner.yaml`
  always come from the repository, and every command runs from the repository root.

- **The layout is pinned:** the backend is `<attempt>/backend`, the frontend
  `<attempt>/frontend`. No heuristic and no search for a nested project: an attempt that
  put them elsewhere meets the stop rules.
- **The attempt directory is read-only** except for install artefacts:
  `frontend/node_modules/`, `frontend/dist/` and a `frontend/package-lock.json` the install
  created. `backend/` is mounted read-only into its containers, and the backend's venv
  lives in a scratch directory outside the attempt.

Start `contract-tests` and `serve-attempt` as `node --import tsx scripts/<name>.ts`, never
through `npm run` (it does not reliably forward signals) and never through the `tsx` bin.
Each Bash call is a fresh shell, so create one log directory outside the repository first
(`mktemp -d`) and write its literal path — `<log>` below — into every later command.

## Phase 0 — `run.json`

Read `<r>/eval-results/<dir>/run.json` (schema: `scripts/lib/run-json.ts`).

| `run.json` | Action |
|---|---|
| `failureKind: "infra"`, or `softDenied: true` | **Refuse.** Tell the user which (`stderrTail`, `softDenied`) and that the attempt must be re-run. Write nothing. |
| `failureKind: "model"` | Write the **all-zero CSV** (Phase 4) with the measured duration, and stop. Run nothing — no contract tests, no npm, no serving — whatever is on disk. |
| `failureKind: null` | Continue. |
| missing | **Stop** and tell the user. Only if the user says the attempt is synthetic: continue, pass `--ignore-run-json` to both scripts (written `[--ignore-run-json]` below), and write `Task completion time` as `N/A`. |

Keep `durationMs` for Phase 4. Before Phase 1, snapshot the attempt for the final check:

```bash
find <r>/eval-attempts/<dir> \( -name node_modules -o -name dist \) -prune -o -type f -print | sort > <log>/before.txt
```

## Phase 1 — hidden tests and frontend build

### Hidden tests

**Always re-run them**: a `contract-results.json` from an earlier run survives a re-run of
the attempt and would score files that are gone. One Bash call is capped at 10 minutes,
while the install alone may take 5 (`LIMITS.pipInstallMs`) and the test files up to 20 more
(`LIMITS.overallMs`), so start it with the Bash tool's `run_in_background` and wait for the
notice that it exited:

```bash
node --import tsx scripts/contract-tests.ts --attempt <dir> [--root <r>] [--ignore-run-json] > <log>/contract-tests.log 2>&1; echo "exit=$?" >> <log>/contract-tests.log
```

| Last line | Meaning | Action |
|---|---|---|
| `exit=0` | `contract-results.json` written, a backend stop included | Read it (below). |
| `exit=1` | Refused, or a harness fault: infra | Stop. Write nothing. Report the `contract-tests:` message. |
| `exit=2` | Usage | Your command is wrong: fix it and start again. |
| `exit=128` or above | Interrupted by a signal | Stop. Write nothing. |

A refusal because the hidden tests differ from gate 2's record is the user's to resolve;
pass `--allow-ungated` only when the user says so.

From `<r>/eval-results/<dir>/contract-results.json` take `boot` — `ok: false` is the
**backend stop**, with its `stage` and `detail` — and `warnings`, `pipFreeze` and `rubric`.
Never copy scores out of it by hand: Phase 4 pastes the printed rows.

A warning `the serving container exited with code N during <file>` means that file's later
tests ran against no backend. The backend may have crashed on its own, which the rows
score, or been killed from outside the attempt (the kernel's OOM killer, which `dmesg` or
`journalctl -k` names): tell the user. If they find it was killed from outside, that is
**infra**: write nothing, and run `contract-tests` again once the cause is gone.

### Frontend

Running the model's npm scripts on the host is a decided exposure (Ruling R7, which now
covers `frontend/` only): no `--ignore-scripts`, no sandbox, no skipping. Before
installing, read the `scripts` of `frontend/package.json`; if a script npm runs on the host
(`preinstall`, `install`, `postinstall`, `prepublish`, `preprepare`, `prepare`,
`postprepare` for the install; `prebuild`, `build`, `postbuild` for the build; `predev`,
`dev`, `postdev` for serving) does something other than build or serve the project, stop
and ask the user. Note whether `frontend/package-lock.json` exists yet.

1. `frontend/package.json` missing → **frontend stop**.
2. `npm install`, bounded by `LIMITS.npmInstallMs` (10 minutes), in the background:

   ```bash
   (cd <r>/eval-attempts/<dir>/frontend && timeout -v -k 10 600 npm install) > <log>/npm-install.log 2>&1; echo "exit=$?" >> <log>/npm-install.log
   ```

   On any non-zero exit, first remove the partial install, an install artefact that
   `serve-attempt` and `take-screenshots` would take for a finished one:
   `rm -rf <r>/eval-attempts/<dir>/frontend/node_modules`. Then read the log:
   - a `timeout: sending signal` line and an exit of 124 or 137: the 10-minute limit ran
     out (124, or 137 when npm ignored the TERM and was killed 10 s later). Ask the
     registry, from the repository root and bounded by `LIMITS.registryProbeMs` (60 s):
     `timeout -k 5 60 npm ping`. It fails → **infra**: stop, write nothing, tell the user.
     It succeeds → **frontend stop**;
   - no such line, and an exit below 128: the install failed. Ask the registry the same
     way: it fails → **infra**; it succeeds → **frontend stop**;
   - no such line and an exit of 128 or above, or such a line with any exit other than
     124 or 137 (143, for example — `timeout -v` prints the line too when it passes on a
     signal sent to it from outside): npm ended on a signal (128 + its number) that the
     limit did not send. The model's own code can cause that — npm passes on a
     lifecycle script's signal, and `JavaScript heap out of memory` aborts with 134 — but
     so can something outside the attempt: the kernel's OOM killer (`dmesg` or
     `journalctl -k` names it) or the user stopping the task. Write nothing yet and ask
     the user whether something outside the attempt killed it. Record a **frontend stop**
     only if they say no; otherwise it is **infra**: stop, write nothing.
3. `npm run build`, in the background the same way:

   ```bash
   (cd <r>/eval-attempts/<dir>/frontend && npm run build) > <log>/build.log 2>&1; echo "exit=$?" >> <log>/build.log
   ```

   A non-zero exit below 128 → **frontend stop**. An exit of 128 or above is a signal, as
   in step 2 (`build.log` may end in `Killed`): ask the user whether something outside the
   attempt killed it, and record a **frontend stop** only if they say no; otherwise write
   nothing. `rubric.ts` sets no limit on the build: if it still runs after 10 minutes, ask
   the user rather than deciding a stop on a limit the rubric does not have. If they call
   it off, stop that background command with its process tree (the build's own children
   included), check that `build.log` stops growing, and write nothing.

For every stop, record the first concrete error line of its log
(`src/api.ts(3,10): error TS2305: …`, not `npm ERR! code 1`).

### The stop rules

`criteria.md`'s stop rules, row by row:

| Row | Backend stop | Frontend stop | Both stops, or `run.json` model | Backend fails only in `serve-attempt` |
|---|---|---|---|---|
| Local build | 0 | 0 | 0 | as Phase 1 decided |
| the four hidden-test rows | pasted (0) | pasted | 0 | pasted |
| Frontend–API integration | 0 | 0 | 0 | 0 |
| Code structure | judged | judged | 0 | judged |
| Tech stack & run contract | judged, names the stop | judged, names the stop | 0 | judged |
| Manual testing | 0 | 0 | 0 | 0 |
| Consistent UI | judged without data | 0 | 0 | judged without data |
| Responsive design | judged without data | 0 | 0 | judged without data |
| Penalty | proposed, confirmed | proposed, confirmed | 0 | proposed, confirmed |

- **Both stops** → write the all-zero CSV now (Phase 4) and stop: no Phase 2, no Phase 3.
- **A frontend stop** → skip Phase 2 (every row it would serve is zeroed) and go to Phase 3.
- **A backend stop** → Phase 2 still runs, for the two rows judged on the frontend without
  data.
- `contract-results.json` is the only source of a backend stop: one recorded there stands
  even if `serve-attempt` brings the backend up later.

A row a stop zeroes is not scored, not asked and not argued. Its Notes say so:
`"Not scored: backend stop (install) — ERROR: No matching distribution found for fastapi==9.9"`.

## Phase 2 — serve, and the human rows

**Phase 2 begins once `serve-attempt` gets past its lock and its port check**, and from
then on Phase 3's `--stop` runs before you finish, on every path — a stop rule found now, an
infra fault, an error, the user calling it off; after an interruption, as `exit=128` below
says. A refusal before that started nothing and owes no `--stop`: one about the attempt
(its name, its directory, its `run.json`), one about another run's state file — `already
serving <attempt> (pid N)`, `names pid N … which is no longer running`, `cannot be read`,
`existed a moment ago` — or a busy port (`port 5100 is already in use`, `ports 5100 and
5173 are already in use`), for which `serve-attempt` releases its lock itself. Never
answer `already serving … (pid N)` with `--stop`: that pid is a live serve-attempt this
skill did not start, and `--stop` would send it SIGTERM.

Start `serve-attempt` in the background, then wait with a second background command that
exits once it is ready or gone:

```bash
node --import tsx scripts/serve-attempt.ts --attempt <dir> [--root <r>] [--ignore-run-json] > <log>/serve.log 2>&1; echo "exit=$?" >> <log>/serve.log
```

```bash
for i in $(seq 1200); do grep -qE '^(ready: |exit=)' <log>/serve.log && break; sleep 1; done; grep -E '^(ready|backend|frontend|warning|serve-attempt|exit=)' <log>/serve.log
```

Reaching `ready:` can take about 10 minutes: a fresh backend install, then the dev
server's start and its one retry. The wait gives up after 20 minutes: if neither line is
there by then, tell the user what `serve.log` shows — `serve-attempt` may still be working,
or its shell may have ended without writing `exit=` — rather than waiting on.

- **`exit=1` before `ready:`** — read the `serve-attempt:` message:
  - another serve-attempt runs, or port 5100 or 5173 is taken: not the attempt's fault. If
    the message names a pid that is no longer running, run `--stop` (Phase 3) to remove
    what that dead run left, and start once more. Otherwise tell the user what holds it
    and wait until they free it — `already serving … (pid N)` and a busy port owe no
    `--stop` (above).
    Never kill a process or remove a container you did not start;
  - a harness fault (the backend could not be served; `npm ping` failed after a failed
    install; `npm install was killed by <signal>, which the harness did not send`; a port
    that `… is held by something else` after serving began — unlike the busy-port
    refusal, which says `already in use`): **infra** — `--stop`, write nothing, report it.
- **`exit=2`** — usage: your command is wrong. Nothing was started; fix it and start again.
- **`exit=128` or above** — interrupted by a signal: stop and write nothing. A `--stop`
  is owed only if this run got past its lock, and must never reach another run. Read the
  state file, and look for the line `serve-attempt` prints once it is past its lock and
  the port check, `serve-attempt: <dir> in <image>` (`<image>` is `<tag>@sha256:…`):

  ```bash
  cat <r>/.cache/serve-attempt.json 2>/dev/null || echo "no state file"; grep "^serve-attempt: <dir> in " <log>/serve.log
  test -f <r>/.cache/serve-attempt.json && node --import tsx --input-type=module -e '
  import { readFileSync } from "node:fs";
  import { isServeOwnerLive } from "./scripts/serve-attempt";
  console.log(isServeOwnerLive(JSON.parse(readFileSync(process.argv[1], "utf8"))) ? "owner live" : "owner gone");
  ' <r>/.cache/serve-attempt.json
  ```

  - `owner live` — the state file's `pid` runs, with the start time the file records (a
    pid reused by an unrelated process has another start time and reads `owner gone`): it
    is another run's (this run's `serve-attempt` has exited), so leave it: no `--stop`;
  - otherwise, if the state file's `attempt` is `<dir>`, or `serve.log` has that line:
    `--stop` (Phase 3), which removes what this run left;
  - otherwise the signal came before the lock: nothing of this run is left, and no
    `--stop` is owed;
  - the command fails because the state file cannot be parsed: leave the file and write
    nothing, no `--stop`. `--stop` refuses an unreadable state file too, since it names no
    process that can be proven running.
- **`ready: <url> (backend ok|backend stop (<stage>); frontend ok|frontend stop)`**:
  - `frontend stop` (its reason is on the `frontend stop: …` line) is a **frontend stop**.
    Apply the table; with a backend stop recorded in `contract-results.json` as well, it
    is both stops: `--stop` and write the all-zero CSV;
  - `backend stop` while `contract-results.json` says the backend booted is the table's
    last column: `Frontend–API integration` and `Manual testing` are 0, their Notes quote
    `serve-attempt`'s reason, and `Local build` and the hidden rows stand;
  - that serve-only backend failure together with a frontend stop is **not** the
    both-stops case: apply the frontend stop's column — the hidden rows are pasted as
    `--rows` prints them, and `Code structure`, `Tech stack & run contract` and `Penalty`
    are judged.

### Asking the human

Unless a stop rule has zeroed all three, make **one** `AskUserQuestion` call. In the
message before it, give the human:

- the URL from the `ready:` line;
- the SPA's routes, read from the attempt's router
  (`grep -rnE "path[:=]|<Route|createBrowserRouter|useRoutes" <r>/eval-attempts/<dir>/frontend/src`),
  or its navigation labels if it switches screens without one — only `/` is photographed,
  so the human needs the rest;
- the five flows of `Manual testing` and the seed week, 2026-10-05;
- under a backend stop: the frontend runs without data, and only `Consistent UI` and
  `Responsive design` are asked;
- that a free-form answer can add specifics.

Then:

- One question per row a stop rule has not zeroed: `Manual testing`, `Consistent UI`,
  `Responsive design`.
- One option per band, labelled `1 — …`, `0.5 — …`, `0 — …`, each with the band's text
  from `criteria.md` as its description.
- **Never default a human row.** No "Neutral baseline", no "assumed fine", no score the
  human did not give: the previous task's run defaulted 12 of 17 CSVs this way, and a
  defaulted row measures nothing. A question left unanswered is asked again.
- A score below 1 with no reason gets one short follow-up asking for the specifics.
- Notes are prefixed `User:` — `"User: the schedule timeline overflows the page below 400px"`.

## Phase 3 — the agent rows and the Penalty

The attempt is still served (unless a frontend stop skipped Phase 2). Search source only,
skipping `node_modules/`, `dist/`, `.venv/`, `__pycache__/` and `.antigravitycli/`:

```bash
grep -rn --exclude-dir={node_modules,dist,.venv,__pycache__,.antigravitycli} '<pattern>' <r>/eval-attempts/<dir>
```

`curl` against the backend (`http://127.0.0.1:5100/api/v1/…`) and through the dev server's
proxy (`http://localhost:5173/api/v1/…`, or the port the `ready:` line names) is allowed.
Score each row against its points in `criteria.md`, and name every point that failed with
a file and line:

- **Frontend–API integration** — the eight points, unless a stop zeroed it. Read the API
  module and each screen's calls; check the proxy with a `curl` of `/api/v1/health` on the
  dev server's port; look for domain data held in the frontend
  (`grep -rnE "Northgate|WO-0[0-9]{2}|instrumentation|hydraulics" …/frontend/src`).
- **Code structure** — the six points, under any single stop.
- **Tech stack & run contract** — the seven points, under any single stop. Read `warnings`
  in `contract-results.json` and, if Phase 2 began, in the state file
  `<r>/.cache/serve-attempt.json` (without Phase 2, a state file there is another run's):
  a dev server on a port other than 5173 fails point 5 (under a frontend stop, which
  serves nothing, judge point 5 on the Vite config and the `dev` script, Vite's default
  port being 5173); an image warning is the harness's and deducts nothing, and so does
  `the dev server exited after it was ready (…)`, which the `serve.log` check below
  handles. A defect that caused a stop is not counted again: name the stop in the Notes.
- **pip freeze** — if Phase 2 began, compare the state file's `pipFreeze` with
  `contract-results.json`'s. Any difference means the backend the human saw is not the one
  the tests scored: name the packages in `Manual testing`'s Notes.
- **Penalty** — propose `0`, `0.5` or `1` with its evidence, per `criteria.md`, never for
  what another row or a stop already scored. Present it in a **second** `AskUserQuestion`
  call, one question, whose options are the proposed deduction (its evidence in the
  description), no deduction, and another amount the human types with a reason (with a
  proposal of 0: that, and another amount). Left unanswered, it is asked again: a proposal
  nobody confirmed is never written. Notes:
  `"Proposed 0.5 (README.md:40 claims tests that do not exist); user confirmed"`, or
  `"User: 1 — <reason>"`. An all-zero CSV skips this: its `Penalty` is 0.

If Phase 2 began, read the state file before stopping — the teardown deletes it — and look
in `serve.log` for the line `serve-attempt` prints if the dev server dies while serving:

```bash
grep "^warning: the dev server exited after it was ready" <log>/serve.log
```

`criteria.md` has no stop for a dev server that served and then exited, so do not decide
one: if the line is there, tell the user, and ask whether the rows judged on the live app
stand or the attempt is served and judged again. Then, on every path that reached Phase 2
(`serve-attempt` got past its lock and its port check):

```bash
node --import tsx scripts/serve-attempt.ts --stop [--root <r>]
```

Exit 0: nothing is left running, and the background `serve-attempt` ends with `exit=143`,
the normal end of serving. Exit 1: the teardown could not finish — report its message and
leave the rest to the user; never remove containers or kill processes by hand.

## Phase 4 — the CSV

Write `<r>/eval-results/<dir>/eval-results.csv` and nothing else: no report file, nothing
in the attempt directory. The template — the header and the 14 rows of `rubric.ts`, in
order, each name exact (the dash in `Frontend–API integration` is U+2013, an en dash):

```csv
Criterion,Score,Max,Notes
Task completion time,<Xmin Ys|N/A>,N/A,<same value>
Test run,<D.MM.YYYY HH:MM>,N/A,<same value>
Local build,<1|0>,1,"<note>"
API contract,<replace this whole line with line 1 of --rows>
Planner: assignment rules,<replace this whole line with line 2 of --rows>
Planner: ordering & determinism,<replace this whole line with line 3 of --rows>
Planner: parts & blocking,<replace this whole line with line 4 of --rows>
Frontend–API integration,<1|0.5|0>,1,"<note>"
Code structure,<1|0.5|0>,1,"<note>"
Tech stack & run contract,<1|0.5|0>,1,"<note>"
Manual testing,<1|0.5|0>,1,"<note>"
Consistent UI,<1|0.5|0>,1,"<note>"
Responsive design,<1|0.5|0>,1,"<note>"
Penalty,<0|0.5|1>,N/A,"<note>"
```

- **The four hidden-test rows are pasted verbatim** from
  `node --import tsx scripts/contract-results.ts --rows <dir> [--root <r>]`, which prints
  them in this order. Each printed line is a whole CSV row that already starts with the
  row name — `API contract,2,2,"24/24 passed"` — and replaces its template line
  entirely: the name is never written twice. Compute, edit and re-round nothing in them.
  Its exit 1 means `contract-results.json` is missing or invalid: go back to Phase 1.
- `Max` is `rubric.ts`'s: `1`, the hidden rows' `2`, `2`, `1`, `2`, and `N/A` for the two
  info rows and `Penalty`.
- `Score` is `1`, `0.5` or `0` for the six agent and human rows, `1` or `0` for
  `Local build` (1 only with no backend stop and no frontend stop), and `0`, `0.5` or `1`
  for `Penalty` — never a percentage, never `1/1`.
- **`Task completion time`:** `s = round(durationMs / 1000)`, then
  `` `${floor(s / 60)}min ${s % 60}s` ``: `421000` → `7min 1s`, `1802000` → `30min 2s`.
  Never hours, never zero-padded (`7min 01s` is wrong). The same string in `Score` and
  `Notes`; `N/A` in both for a synthetic attempt.
- **`Test run`:** `date +"%-d.%m.%Y %H:%M"`, the same string in both columns.
- **Quoting:** every `Notes` value in double quotes, each `"` inside doubled, on one line.
  The two info rows stay unquoted, as in the template.
- **No `API cost` row:** `process-results` adds it.
- A trailing newline, and no blank lines.

### The all-zero CSV

For a `failureKind: "model"` run, and for both stops: every row 0, `Penalty` 0, and
`Task completion time` keeps the measured duration. A model run has no
`contract-results.json`, so its hidden rows come from the template, as below. Under both
stops they are pasted from `--rows` as usual — already 0, with the backend stop in their
Notes — and every other Note names both stops. For `durationMs: 1802000`, scored on
18 September 2026 at 14:05:

```csv
Criterion,Score,Max,Notes
Task completion time,30min 2s,N/A,30min 2s
Test run,18.09.2026 14:05,N/A,18.09.2026 14:05
Local build,0,1,"Not scored: run.json failureKind model (timeout waiting for response)"
API contract,0,2,"Not scored: run.json failureKind model (timeout waiting for response)"
Planner: assignment rules,0,2,"Not scored: run.json failureKind model (timeout waiting for response)"
Planner: ordering & determinism,0,1,"Not scored: run.json failureKind model (timeout waiting for response)"
Planner: parts & blocking,0,2,"Not scored: run.json failureKind model (timeout waiting for response)"
Frontend–API integration,0,1,"Not scored: run.json failureKind model (timeout waiting for response)"
Code structure,0,1,"Not scored: run.json failureKind model (timeout waiting for response)"
Tech stack & run contract,0,1,"Not scored: run.json failureKind model (timeout waiting for response)"
Manual testing,0,1,"Not scored: run.json failureKind model (timeout waiting for response)"
Consistent UI,0,1,"Not scored: run.json failureKind model (timeout waiting for response)"
Responsive design,0,1,"Not scored: run.json failureKind model (timeout waiting for response)"
Penalty,0,N/A,"Forced to 0: an all-zero CSV"
```

The reason in brackets is `envelope.error` when there is one, otherwise the exit code.

## Before you report

1. Check the file against `rubric.ts`, from the repository root:

   ```bash
   node --import tsx --input-type=module -e '
   import { parse } from "csv-parse/sync";
   import { readFileSync } from "node:fs";
   import { RUBRIC_ROWS } from "./scripts/lib/rubric";
   const text = readFileSync(process.argv[1], "utf8");
   let rows;
   try { rows = parse(text, { columns: true }); } catch (error) { console.log("WRONG: not a CSV of the four columns: " + error.message); process.exit(0); }
   const scoreOk = (r, { Score: s, Notes: n }) =>
     r.name === "Task completion time" ? /^((0|[1-9]\d*)min [1-5]?\ds|N\/A)$/.test(s) && n === s
     : r.name === "Test run" ? /^[1-9]\d?\.\d\d\.\d{4} \d\d:\d\d$/.test(s) && n === s
     : r.scoredBy === "hidden" ? /^\d+(\.\d+)?$/.test(s) && Number(s) <= r.max
     : (r.name === "Local build" ? ["1", "0"] : r.scoredBy === "penalty" ? ["0", "0.5", "1"] : ["1", "0.5", "0"]).includes(s);
   const wrong = RUBRIC_ROWS.filter((r, i) => rows[i]?.Criterion !== r.name || rows[i].Max !== String(r.max ?? "N/A") || !scoreOk(r, rows[i]));
   const problems = [];
   if (rows.length !== RUBRIC_ROWS.length) problems.push("WRONG ROW COUNT, " + RUBRIC_ROWS.length + " expected");
   if (wrong.length > 0) problems.push("WRONG: " + wrong.map((r) => r.name).join(" | "));
   if (!text.endsWith("\n")) problems.push("NO TRAILING NEWLINE");
   console.log(text.split("\n").length - 1 + " lines, " + rows.length + " rows; " + (problems.join("; ") || "names, order, Max and Score cells match rubric.ts"));
   ' <r>/eval-results/<dir>/eval-results.csv
   ```

   Expect `15 lines, 14 rows; names, order, Max and Score cells match rubric.ts`. The
   Score cells it checks: `Local build` 1 or 0; the agent and human rows 1, 0.5 or 0;
   `Penalty` 0, 0.5 or 1; each hidden row a number from 0 to its Max; the two info rows
   in their formats, the same string in Score and Notes.
2. Unless Phase 0 ended scoring, the attempt directory gained only install artefacts:

   ```bash
   find <r>/eval-attempts/<dir> \( -name node_modules -o -name dist \) -prune -o -type f -print | sort | diff <log>/before.txt -; find <r>/eval-attempts/<dir> \( -name node_modules -o -name dist \) -prune -o -type f -newer <log>/before.txt -print
   ```

   Expect nothing but a `frontend/package-lock.json` that did not exist before the install —
   a tool-created one, on a `>` line of the diff and in the list after it; say so. Name
   anything else in the report (build output the model's own scripts wrote, or on a `<`
   line a file they deleted), and never delete a file in the attempt.
3. If a `--stop` was owed — Phase 2 began and no signal ended it, or an interruption owed
   one (`exit=128` above) — `--stop` exited 0, and `<r>/.cache/serve-attempt.json` is
   gone. After a refusal at the lock or at the port check, or an interruption that owed
   no `--stop` (`exit=128` above), a state file there is another run's: leave it.
4. Report the total out of 14 (the scored rows minus `Penalty`), the percentage, the stop
   rules that applied, and every row that lost points with its reason.

`npm run process-results` regenerates the dashboard; it is a separate step, not part of
this skill.

## Never

- Never edit `benchmark/criteria.md`, `prompt.md`, `benchmark/context/seed.json`, the
  hidden tests in `benchmark/contract-tests/` or `scripts/lib/rubric.ts` while scoring:
  they are the rubric, and its id covers them.
- Never fix, complete or reconfigure the attempt, and never write into its directory
  beyond the install artefacts.
- Never continue past a stop rule.
- Never default a human row.
- Never award a score the band's wording does not support.
- Never re-run the model, `agy` or `run-matrix`: producing attempts spends the user's
  quota.
- Never start `contract-tests` or `serve-attempt` through `npm run` or the `tsx` bin.
- Never pass `--ignore-run-json` unless the user said the attempt is synthetic, and never
  pass `--allow-ungated` unless the user asked for it.
- Never kill a process or remove a container you did not start: `serve-attempt --stop`
  ends serving.
