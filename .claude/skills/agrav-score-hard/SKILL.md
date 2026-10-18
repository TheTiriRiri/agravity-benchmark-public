---
name: agrav-score-hard
description: Judge one hard-track agrav-bench attempt (tracks/console-hard, the 19-point rubric) — run score-hard for the hidden contract and E2E rows and the stops, then score the three agent rows (Code structure, Tech stack & run contract, Self-verification), ask the human for Visual design and confirm the Penalty, and record them in judge-rows-hard.json. Use when the user wants a hard attempt judged or its heuristic rows replaced — "judge claude-opus-46-high-attempt-3 on the hard track", "score the hard attempts properly", "visual design for gemini-31-pro-high-attempt-2".
user-invocable: true
---

# agrav-score-hard

Judges **one** attempt of the hard track: the Meridian Maintenance Console a model built
one-shot from `tracks/console-hard/prompt.md`, a FastAPI backend in `backend/` and a React
SPA in `frontend/`, under `tracks/console-hard/eval-attempts/<dir>/`. `<dir>` is
`<id>-attempt-<n>`. Two files come out of it, both in
`tracks/console-hard/eval-results/<dir>/`:

- `eval-results.csv` and `hidden-results-hard.json`, written by `scripts/score-hard.ts`
  (the hidden rows, `Local build`, the stops, the info rows);
- `judge-rows-hard.json`, written by `scripts/hard-judge-rows.ts`, which also rewrites the
  five judged rows in the CSV. `score-hard` reads that file back on every later `--force`,
  so a rescore keeps the judge's and the human's scores while the rubric id is unchanged.

## Authority

- `tracks/console-hard/benchmark/criteria.md` is normative for the bands, the stop rules
  and the CSV. `scripts/lib/hard-rubric.ts` is normative for the rows, their order and
  their maxima. This file is the procedure: where it disagrees with either, this file is
  wrong.
- Never soften a band. Award what the wording gives. When a band is ambiguous for an
  attempt, apply the stricter reading and say in the note which way you read it. For
  `Penalty`, the stricter reading is the larger deduction, never for a defect another row
  or a stop already scores.
- Read before judging: `criteria.md` in full; `tracks/console-hard/prompt.md`, especially
  section 1, the run contract.
- `benchmark/runner-hard.yaml` records the judge (`judge:`) and the rubric id (`rubric:`).
  If this session's model is not the recorded judge, **stop** and tell the user: scores
  from another judge are not comparable. If `hardRubricId` of the repository differs from
  `rubric:`, stop as well. The rubric files changed and the whole track needs rescoring
  first.

## Input

The attempt directory name `<dir>`. Ask for it if the user gave none. One attempt per
invocation; for a batch, run the procedure once per attempt, in order, and make one
`AskUserQuestion` call per attempt.

Every command runs from the repository root. Start `score-hard` and `serve-attempt` as
`node --import tsx scripts/<name>.ts`, never through `npm run` or the `tsx` bin (signals).
Create one log directory first (`mktemp -d`) and write its literal path, `<log>` below,
into every later command. `A=tracks/console-hard/eval-attempts/<dir>` and
`R=tracks/console-hard/eval-results/<dir>` below are shorthand. Write the paths out in
full in each command, because every Bash call is a fresh shell.

The attempt directory is read-only except for the install artefacts
(`frontend/node_modules/`, `frontend/dist/`, a tool-created `frontend/package-lock.json`).
Snapshot it before Phase 1:

```bash
find tracks/console-hard/eval-attempts/<dir> \( -name node_modules -o -name dist \) -prune -o -type f -print | sort > <log>/before.txt
```

## Phase 0 — `run.json`

Read `R/run.json` (schema: `scripts/lib/run-json.ts`).

| `run.json` | Action |
|---|---|
| `failureKind: "infra"` or `softDenied: true` | **Refuse**: not a data point, it must be re-run. Write nothing. |
| `failureKind: "model"` | Run Phase 1 only: `score-hard` writes the all-zero CSV and nothing else. No judging, no serving, no `judge-rows-hard.json`. |
| `failureKind: null` | Continue. A `reclassified` field (a truncated response agy recovered from) is an ordinary data point. |
| missing | **Stop** and tell the user. |

Before anything is installed, read the `scripts` of `A/frontend/package.json`. If a
lifecycle script npm runs on the host (`preinstall`, `install`, `postinstall`, `prepare`
and their `pre`/`post` forms; `prebuild`, `build`, `postbuild`; `predev`, `dev`,
`postdev`) does something other than build or serve the project, stop and ask the user
(Ruling R7). That finding is also the `Penalty` band 1.

## Phase 1 — `score-hard`: hidden rows, build, stops

```bash
node --import tsx scripts/score-hard.ts --attempt <dir> --force > <log>/score-hard.log 2>&1; echo "exit=$?" >> <log>/score-hard.log
```

Start it with `run_in_background`: serving, six contract files, the build and two
Playwright files take 10 to 25 minutes. Wait for the notice that it exited.

| Last line | Meaning | Action |
|---|---|---|
| `exit=0` | `R/eval-results.csv` written | Continue. |
| `exit=1` | refused, or a `HarnessFault` (infra) | Stop. Report the message. Nothing new was written. |
| `exit=2` | usage | Fix the command. |
| `exit=128` or above | interrupted | Stop. Run `node --import tsx scripts/serve-attempt.ts --stop --root tracks/console-hard` only if `tracks/console-hard/.cache/serve-attempt.json` names `<dir>`. |

Read the stops off the CSV. `Local build` 1 means neither stop applies. Otherwise its
note gives the stop in `serve-attempt`'s format: `backend stop:<stage>: <detail>`,
decided by `score-hard`'s own contract backend (its layout check, its install, or its
first start), or `frontend <reason>`. A stop zeroes the rows the criteria table names.
The hidden rows, both E2E rows included, are `score-hard`'s and are already zeroed in the
CSV; the table below lists only the judged rows. `hard-judge-rows.ts` refuses to set a
zeroed row, and such a row is not asked, judged or argued:

| Stop | Judged here | Zeroed |
|---|---|---|
| none | Code structure, Tech stack & run contract, Self-verification, Visual design, Penalty | — |
| backend stop | Code structure, Tech stack & run contract, Visual design (frontend without data), Penalty | Self-verification |
| frontend stop | Code structure, Tech stack & run contract, Self-verification, Penalty | Visual design |
| both stops, or a model failure | nothing: the all-zero CSV stands | all |

Read `R/hidden-results-hard.json`. Its `failed` lists name the hidden tests that failed;
a `not run: …` entry instead marks a file the backend did not come up again for (or, on
`Frontend E2E: flows`, a served backend that did not come up). They inform the notes, but
they are never a reason to change a hidden row.

## Phase 2 — serve, the live checks, and the human row

Under a frontend stop, run Phase 2 only if the attempt has model-written tests (found as
in Self-verification below). Those tests need the backend on 5100, which
`serve-attempt` still brings up. Skip Visual design and its question. With no tests, skip
Phase 2 altogether.

```bash
node --import tsx scripts/serve-attempt.ts --attempt <dir> --root tracks/console-hard > <log>/serve.log 2>&1; echo "exit=$?" >> <log>/serve.log
```

```bash
for i in $(seq 1200); do grep -qE '^(ready: |exit=)' <log>/serve.log && break; sleep 1; done; grep -E '^(ready|backend|frontend|warning|serve-attempt|exit=)' <log>/serve.log
```

Run the first with `run_in_background`. The refusals, the infra faults and the `--stop`
rules are the classic skill's
(`.claude/skills/agrav-score-attempt/SKILL.md`, Phase 2), with `--root tracks/console-hard`.
In short:

- a busy port or another live serve is not the attempt's fault: tell the user and wait;
- a harness fault is infra: `--stop`, then write nothing;
- once serving got past its lock, `--stop` is owed on every path;
- never kill a process or remove a container you did not start.

If `score-hard` found no backend stop but `ready:` now says `backend stop`, that is the
criteria table's last row. It zeroes `Frontend E2E: flows` only. `Frontend E2E: layout &
a11y`, `Local build` and the contract rows keep what `score-hard` wrote. `score-hard`
starts each contract file on a fresh backend and serves the E2E on another one, so if it
saw this, the CSV already has `flows` at 0 with the reason. If it did not, the failure is
new to this serve. `--stop`, serve once more, and if it fails again, tell the user and
write nothing. Only `score-hard` writes hidden rows, so the user decides whether to
rescore.

### Self-verification: run the model's tests

Find model-written tests in source only:

```bash
find tracks/console-hard/eval-attempts/<dir> \( -name node_modules -o -name dist -o -name .venv -o -name __pycache__ -o -name .antigravitycli \) -prune -o -type f \( -name 'test_*.py' -o -name '*_test.py' -o -name 'conftest.py' -o -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.spec.ts' -o -name '*.spec.tsx' \) -print
```

None → `0`, and nothing to run. Otherwise run them in the harness image, with the attempt
mounted read-only, as the host user, on the host network so they reach the served
backend on 5100. Use the image `score-hard` serves with, `benchmark/runner.yaml`'s
`image:` (`readScoringImage`). For
stdlib `unittest` files:

```bash
docker run --rm --pull never --network host --user "$(id -u):$(id -g)" -e PYTHONDONTWRITEBYTECODE=1 -v "$PWD/tracks/console-hard/eval-attempts/<dir>:/workspace:ro" -w /workspace/backend --entrypoint python3 <image> -m unittest discover -v -p 'test*.py' <dir-of-tests-relative-to-backend>
```

For pytest files, use a throwaway venv inside the container: the image has no pytest.
Run `sh -c 'python3 -m venv /tmp/v && /tmp/v/bin/pip install -q -r requirements.txt pytest httpx && /tmp/v/bin/pytest -q -p no:cacheprovider <path>'`
with the same mounts. Add `httpx` only if the tests use FastAPI's `TestClient`. For
frontend tests (`vitest`), run `npx vitest run` in `A/frontend` on the host, if
`package.json` has vitest. Write the outputs to `<log>/selftests.log`.

Bands:

- `1` — at least one model-written test calls `POST /plan` (over HTTP or through
  `TestClient`) and asserts on a field of the resulting schedule, and it passes.
- `0.5` — tests exist but none passes that floor: trivial ones, or failing ones.
- `0` — none exist.

Name the files, the test that meets the floor, and the pass/fail counts. A test that
needs a package the model did not list fails: read it the strict way.

### Visual design — ask the human

Under no frontend stop, in the message before **one** `AskUserQuestion` call, give:

- the URL from `ready:`;
- the routes from the router:
  `grep -rnE "path[:=]|<Route|createBrowserRouter|useRoutes" tracks/console-hard/eval-attempts/<dir>/frontend/src`,
  or the navigation labels;
- the four screens to look at, and the seed week 2026-10-05;
- under a backend stop, that the frontend runs without data.

One question, `Visual design`, with one option per band (`1 — …`, `0.5 — …`, `0 — …`).
Each option's description is the band's text from `criteria.md`. **Never default it**:
an unanswered question is asked again. A score below 1 with no reason gets one short
follow-up. Note: `User: <reason>`.

## Phase 3 — the agent rows and the Penalty

Search source only:

```bash
grep -rn --exclude-dir={node_modules,dist,.venv,__pycache__,.antigravitycli} '<pattern>' tracks/console-hard/eval-attempts/<dir>
```

While served, `curl` against `http://127.0.0.1:5100/api/v1/…` and through the dev
server's proxy is allowed. Judge each point of `criteria.md` and name every failed point
with its file and line:

- **Code structure** — the six points. The 0 band also triggers when point 2 fails
  (planner rules in a route handler), when the backend is one file or the frontend one
  component, when three or more points fail, or when non-trivial logic is copied in full.
  Point 6: look for modules nothing imports (`grep` each `src/` module's basename among
  the imports), Vite template remains (`count is`, `react.svg`, `vite.svg`,
  `Edit src/App`), and commented-out code blocks.
- **Tech stack & run contract** — the seven points:
  - point 2: the README's commands, word for word against `prompt.md` section 1;
  - point 5: the Vite config's port and the `/api` proxy target, and the port in
    `ready:`; under a frontend stop, the config alone;
  - point 6: `grep -rnE "sqlite|sqlalchemy|open\(|json.dump|write_text" backend/app`.
    A file written at run time fails the point; reading `seed.json` does not;
  - point 7: auth, i18n, `Dockerfile` or `docker-compose*`, outbound HTTP calls.

  A defect a stop already scored is not counted again; name the stop instead.
- **Self-verification** — from Phase 2.
- **Penalty** — propose `0`, `0.5` or `1` per `criteria.md`, with evidence, never for a
  defect another row or a stop scores. Candidates: an unsafe lifecycle script; a
  committed credential; large unrelated files (`find … -size +1M`); README claims that
  are false (tests that do not exist, features that are absent); tight polling
  (`setInterval` under a second against the API). Present it in a **second**
  `AskUserQuestion`. For a proposal above 0, the options are the proposal (evidence in
  its description), `0 — no deduction`, and another amount the human types with a
  reason. For a proposal of 0, the options are `0 — no deduction` and another amount. An unconfirmed proposal is never written. Note:
  `Proposed 0.5 (README.md:40 claims tests that do not exist); user confirmed` or
  `User: 1 — <reason>`.

Then, on every path that reached Phase 2, before writing:

```bash
node --import tsx scripts/serve-attempt.ts --stop --root tracks/console-hard
```

Exit 0 means nothing is left running. Exit 1: report its message and leave the rest to
the user.

## Phase 4 — record the rows

One call, with every row this attempt's stops leave judged:

```bash
node --import tsx scripts/hard-judge-rows.ts --attempt <dir> --judge claude-opus-5-5 \
  --set "Code structure=<s>|<note>" \
  --set "Tech stack & run contract=<s>|<note>" \
  --set "Self-verification=<s>|<note>" \
  --set "Visual design=<s>|User: <reason>" \
  --set "Penalty=<s>|<note>"
```

- The script derives who scored a row from its name: the three agent rows are the
  judge's, `Visual design` and `Penalty` the human's. `--judge` must equal
  `runner-hard.yaml`'s `judge:`.
- Scores are `1`, `0.5` or `0` (`Penalty`: `0`, `0.5` or `1`). Notes go on one line, and
  quoting is the script's job. Quote the whole `--set` argument for the shell. A `'`
  inside a note needs `'\''` when the argument is in single quotes.
- Exit 1 is a refusal: a row a stop zeroed, a model failure, a wrong rubric or a bad
  value. Read the message and correct the call; never work around it by editing the CSV
  or the JSON by hand.
- It prints the new total. Keep it for the report.

## Before you report

1. The attempt directory gained only install artefacts:

   ```bash
   find tracks/console-hard/eval-attempts/<dir> \( -name node_modules -o -name dist \) -prune -o -type f -print | sort | diff <log>/before.txt -
   ```

   Expect nothing, or only a `frontend/package-lock.json` that the install created. Name
   anything else; never delete a file in the attempt.
2. `tracks/console-hard/.cache/serve-attempt.json` is gone if a `--stop` was owed.
3. `grep -c heuristic tracks/console-hard/eval-results/<dir>/eval-results.csv` is 0 for
   every judged row. A stop-zeroed row keeps its stop note.
4. Report:
   - the total out of 19 and the percentage;
   - the stops;
   - each judged row with its score and the reason it lost points;
   - the `failed` hidden tests in one line per row that lost points.

`npm run process-results:hard` regenerates the dashboard. It is a separate step, run
once after a batch.

## Never

- Never edit `criteria.md`, `prompt.md`, `seed.json`, the contract or E2E tests, or
  `hard-rubric.ts` while judging: their hash is the rubric id.
- Never fix, complete or reconfigure the attempt, and never write into it beyond the
  install artefacts. The model's tests run with the attempt mounted read-only.
- Never default `Visual design`, and never write a `Penalty` the human did not confirm.
- Never hand-edit `eval-results.csv`, `hidden-results-hard.json` or
  `judge-rows-hard.json`.
- Never re-run the model, `agy` or `run-matrix`.
- Never kill a process or remove a container you did not start.
