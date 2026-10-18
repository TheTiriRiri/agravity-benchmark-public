# Spec files

Every spec file in this repo is written for the maintenance-console task and its
hard and brownfield tracks.

## Written for this repo — edit freely, under review

| Path | What it is |
|---|---|
| `prompt.md` | The maintenance-console task. Normative: the hidden contract tests assert what it says. |
| `benchmark/context/seed.json` | The seed embedded in the prompt; `test/prompt.test.ts` keeps the two equal. |
| `benchmark/contract-tests/` | The hidden tests, proven by `npm run gate:reference`. |
| `benchmark/criteria.md` | The rubric: the 14 rows, the stop rules and the bands. Its rows table is tested against `scripts/lib/rubric.ts`; `/benchmark` publishes it. |

Every file above, with the scoring skill,
`scripts/lib/rubric.ts`, `scripts/lib/contract-results.ts` and
`scripts/lib/contract-suite.ts`, is hashed into the rubric id (`rubricId` in
`scripts/lib/rubric.ts`), so an edit to any of them is a new rubric.

## The hard track

| Path | What it is |
|---|---|
| `tracks/console-hard/prompt.md` | The hard task. Normative for the hidden tests. |
| `tracks/console-hard/benchmark/context/seed.json` | The hard track's seed. |
| `tracks/console-hard/benchmark/contract-tests/` | The six hidden contract-test files, proven by `npm run gate:hard-reference` and frozen by `npm run gate:h-freeze`. |
| `tracks/console-hard/benchmark/e2e-tests/` | The two Playwright E2E suites (flows; layout and accessibility). |
| `tracks/console-hard/benchmark/criteria.md` | The 19-point rubric and its stop rules; `/benchmark` publishes it. |

These, with `scripts/lib/hard-rubric.ts`, are hashed into the hard rubric id
(`HARD_RUBRIC_ID_INPUTS`). The differential fuzz oracle in
`tracks/console-hard/benchmark/fuzz/` backs the gates and scores no row.

## The brownfield track

| Path | What it is |
|---|---|
| `tracks/brownfield/prompt.md` | The change request. |
| `tracks/brownfield/base/` | The frozen FastAPI + React base every attempt starts from. |
| `tracks/brownfield/benchmark/contract-tests/` | The change suite; the regression suite is the classic `benchmark/contract-tests/`. |
| `tracks/brownfield/benchmark/criteria.md` | The 12-point rubric and its stop rules; `/benchmark` publishes it. |

These, with the brownfield scoring skill, `scripts/lib/brownfield-rubric.ts`, the
classic contract tests and `benchmark/context/seed.json`, are hashed into the
brownfield rubric id (`BROWNFIELD_RUBRIC_ID_INPUTS`).
