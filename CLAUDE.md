# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**agrav-bench** runs models through the Antigravity CLI (`agy`) instead of per-vendor API keys. Each model builds the Meridian Maintenance Console (a FastAPI backend and a React frontend) one-shot from a fixed prompt, is scored against its track's rubric, and the results land on an Astro dashboard. **Each (model, effort) pair is its own benchmark row**, so a model's `--effort` levels can be compared directly. `README.md` is the user-facing overview; `docs/OPERATOR-GUIDE.md` is the operator's step-by-step guide, including the `agy` sign-in.

The repository ships with no results: `eval-attempts/` and `eval-results/` hold only `.gitkeep` and `eval-attempts/metadata.ts`, and the committed `website/src/data/results*.json` are empty.

Three tracks share one pipeline:

- **Classic:** `prompt.md`, 14-point rubric (`benchmark/criteria.md`, `scripts/lib/rubric.ts`), runner `benchmark/runner.yaml`, judge skill `.claude/skills/agrav-score-attempt/SKILL.md`.
- **Hard:** `tracks/console-hard/prompt.md`, 19-point rubric with expanded planner rules (crews, travel, splitting, preemption), hidden contract tests and Playwright E2E suites (`tracks/console-hard/benchmark/`, `scripts/lib/hard-rubric.ts`), runner `benchmark/runner-hard.yaml`, scorer `scripts/score-hard.ts`, judge skill `agrav-score-hard`. The skill records its agent rows and the human's `Visual design` and `Penalty` in each attempt's `judge-rows-hard.json`, which `score-hard --force` re-applies while the rubric id is unchanged. A differential fuzz oracle backs the gates (`gate:fuzz`, `gate:hard-fuzz`) and scores no row.
- **Brownfield:** the model modifies the frozen FastAPI + React base in `tracks/brownfield/base/` (`tracks/brownfield/prompt.md`: add `strategy=balanced` to `POST /plan` and a `technician_load` field). 12-point rubric (`tracks/brownfield/benchmark/criteria.md`, `scripts/lib/brownfield-rubric.ts`, 10 CSV rows), runner `tracks/brownfield/benchmark/runner.yaml`, judge skill `agrav-score-brownfield`.

All three runners use the harness image `agrav-bench/harness:2026-10-04` (agy 1.2.7, `images/harness/IMAGE.md`) and the judge `claude-opus-5-5`. The classic runner carries five rows (Gemini 3.8 Flash at High and Medium, Gemini 3.1 Pro High, Claude Sonnet 4.6, Claude Opus 4.6 Thinking); the hard and brownfield runners carry the same rows without 3.8 Flash Medium. Adding a row is a one-line change in a runner; `eval-attempts/metadata.ts` must know the id.

`benchmark/SPEC-FILES.md` lists the spec files. The repository is MIT (`LICENSE`); `THIRD_PARTY_NOTICES.md` holds the licence notice for code this repository derives from, and the dashboard publishes a byte copy at `/THIRD_PARTY_NOTICES.txt` (`website/public/`, linked from the footer; `test/third-party-notices.test.ts` keeps the two equal).

The benchmark page reads each track's prompt and criteria **off disk** at build time, never from the network: fetching them from raw.githubusercontent would make builds non-reproducible. CI fails a build whose tracked `website/` files mention raw.githubusercontent.

## What the `agy` binary actually does

**The envelope.** A headless run prints:

```json
{"conversation_id":"…","status":"SUCCESS","response":"…","duration_seconds":12.0,
 "num_turns":3,"usage":{"input_tokens":50000,"output_tokens":1000,
 "thinking_tokens":400,"cache_read_tokens":20000,"total_tokens":51000}}
```

`status` (upper case), `duration_seconds`, `response`, `thinking_tokens`. A failure adds `error` and sets `status: "ERROR"`; `classifyFailure` (`scripts/lib/classify.ts`) reads this shape, pinned by tests and fixtures. `total_tokens === input_tokens + output_tokens`, with `cache_read_tokens` outside the sum (so cache reads are not double-charged), and `thinking_tokens` is a subset of output (so it has no rate of its own). An envelope whose `error` says "interrupted" is an operator interruption, which writes no `run.json`; one saying agy lost its network connection to the server is infra.

**`--effort` is part of the model id, not a free axis.** agy lists `gemini-3.8-flash-high` / `-medium` / `-low` as three ids and hard-fails a mismatch (`--model gemini-3.8-flash-low conflicts with --effort=high`, exit 1). Three models have no levels at all and reject the flag (`--effort is not supported for model "claude-sonnet-4-6"`): `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`, the last despite ending in `-medium`, which is its name, not a level. Their runner rows carry `effort: null`. The benchmark ids still carry `-high`/`-med`/`-low` because that suffix is a directory name and a dashboard label, not a CLI argument. agy's catalogue moves: re-check ids with `run-attempt --models`, and never take them from the model picker's display names.

**`agy -p "/usage"` is a per-model table**, not one number and with no `remaining` label:

```
All Models	Gemini 3.8 Flash (High)	<percent remaining>	<reset time>
All Models	Claude Opus 4.6 (Thinking)	<percent remaining>	<reset time>
```

`parseUsageRemaining` takes the lowest bucket unless given a model label. `quotaFloor: 10` on all three runners stops a matrix before an attempt whose model's bucket is below 10%; every matrix row carries a `usageLabel` (its `/usage` label, e.g. `Claude Sonnet 4.6 (Thinking)`) so the floor reads that model's own bucket, and the loader refuses a number while a row has none. A rerun after the reset resumes the matrix.

**Sign-in happens inside the container**, onto the named volume `agy-creds`. agy stores its token in the system keyring and only falls back to a file when no keyring is reachable; the image has none, so the token lands at `.gemini/antigravity-cli/antigravity-oauth-token`, beside `installation_id`. A host sign-in puts the token where Docker cannot mount it. The guide's §7 has the procedure. Two things that are easy to get wrong:
- the image's entrypoint is `run-attempt`, so bare `agy …` is rejected with `unknown arg: agy`;
- **the `-i` trap:** with `-it` you get the TUI, with no `-i` at all you get the OAuth URL and a 60s wait but nowhere to paste, and with `-i` alone agy refuses immediately in a way that looks like a broken install and is not.

A sign-in can fail with `token exchange failed: oauth2: "invalid_grant" "Invalid code verifier."`: that is a PKCE mismatch from answering an older `agy` process's URL. Close stale tabs, run one flow, and finish it promptly.

A bad `--model` exits **1** (no collision with `run-attempt`'s reserved 2/3/5). The root-owned binary defeats agy's self-updater, so `agy --version` stays what the image pins.

## Headless model invocation

```bash
agy -p "$PROMPT" --model "$MODEL" [--effort "$EFFORT"] --new-project \
    --mode accept-edits --dangerously-skip-permissions \
    --output-format json --print-timeout 30m
```

`--effort` is **optional and must agree with the model id**: omit it for `claude-sonnet-4-6`, `claude-opus-4-6-thinking` and `gpt-oss-120b-medium`, which reject it outright, and never pass one that disagrees with an effort-suffixed id. Either mistake is exit 1 with an `ERROR` envelope, i.e. an attempt that never runs. The brownfield track runs `run-attempt --no-new-project`, so agy works on the copy of the base.

`--print-timeout` defaults to 5m, which is too short for this task, so always pass it (`run-attempt` passes `$TIMEOUT`, which `run-matrix` sets from the runner's `printTimeout`: 30m, and 45m on the hard track). The outer docker timeout must be longer (32 min; 47 min on the hard track) so agy's own timeout status is what gets recorded (`timeoutMs: 1920000`, hard `2820000`; `run-matrix` refuses to start if it is not longer). Capture stderr: a `soft-deny` line means a tool was blocked and the run is an infra failure, not a model failure.

## Credential handling — do not shortcut this

Per attempt the runner copies **only** `.gemini/antigravity-cli/antigravity-oauth-token` and `.gemini/antigravity-cli/installation_id` from the `agy-creds` volume into a throwaway dir mounted as `HOME`, and removes it afterwards. Sign-in also writes `settings.json`, `cache/onboarding.json` and an `implicit/<uuid>.pb` onto the volume; none of them are copied, and a run needs none of them.

**Copy them as paths, not as bare filenames.** `agy`'s file store is `$HOME/.gemini/antigravity-cli/`, so the throwaway `HOME` must reproduce that layout: the runners' `credentialFiles` are relative paths under it, copied with `cp --parents` from a `/src` working directory. A flat copy either fails outright or, worse, succeeds with the right basenames in the wrong place and runs **every attempt unauthenticated**. Never mount the host's `~/.gemini`: it can hold API keys, history and project state that don't belong in a benchmark container. No secret ever goes in argv. Containers run as the host uid (`--user $(id -u):$(id -g)`) so `eval-attempts/` stays user-owned and the root-owned `agy` binary cannot self-update.

## Pipeline architecture

Five stages, each producing input for the next. Data flows one way and everything downstream of the runner is regenerable from committed CSVs.

1. **`scripts/run-matrix.ts`** reads the runner (image tag, resolved to its Id at run time; agy version, judge, rubric id, timeouts, attempts, model matrix with explicit `family`) and runs the harness container per (model, effort, attempt), **sequentially**: one shared OAuth session and a weekly quota rule out parallelism. It checks `-p "/usage"` before each run. It writes the generated project to `eval-attempts/<id>-attempt-<n>/` (model output only) and harness metadata to `eval-results/<id>-attempt-<n>/run.json` (`durationMs`, `exitCode`, envelope `usage`, `softDenied`, `failureKind`).
   - **Resume** skips any attempt whose `run.json` records a *result*. It does not key on `package.json`, which the run contract puts in `frontend/`, and it re-runs a `run.json` recording an `infra` failure, because that is not a data point.
   - `failureKind: "model"` (timeout, crash) is a data point scoring 0.
   - `failureKind: "infra"` (auth, quota, bad model id, soft-deny, **and a container that could not be verifiably removed**) **stops the matrix**.
   - **Operator interruption** is a third outcome: it writes no `run.json` at all, so a Ctrl-C never fabricates a model failure and never becomes a permanent zero.
2. **`.claude/skills/agrav-score-attempt/SKILL.md`** is the hybrid judge, one attempt per invocation. The layout is pinned: the backend is `<attempt>/backend`, the frontend `<attempt>/frontend`, with no search for a nested project.
   - Phase 0 reads `run.json`: `infra` or `softDenied` is refused, and a `model` failure gets the all-zero CSV at once.
   - Phase 1 runs `contract-tests` (the hidden API tests, against the attempt's backend served in the harness image; writes `contract-results.json`), then installs and builds the frontend and applies the stop rules.
   - Phase 2 serves the attempt with `serve-attempt` and asks the human for the three human rows via AskUserQuestion.
   - Phase 3 scores the three agent rows and proposes the Penalty, which the human confirms.
   - Phase 4 writes `eval-results/<id>-attempt-<n>/eval-results.csv` (header + the 14 rows of `scripts/lib/rubric.ts`); the four hidden-test rows are pasted from `contract-results.ts --rows`, never typed.
3. **`eval-attempts/metadata.ts`**: the `ModelId` union, display names, `AGENT_ENV` (effort-flavoured: `AntigravityHigh`/`Medium`/`Low`), `MODEL_FAMILY` (maps `gemini-38-flash-high` → `gemini-38-flash`; `getModelBaseId` alone would make each effort level its own family), `MODEL_PRICING`, `SUPERSEDED_MODELS`, `isModelId`, `getModelBaseId`.
4. **`scripts/process-results.ts`** turns CSVs + `run.json` + `contract-results.json` into `website/src/data/results.json` and `website/public/api/leaderboard.json` (`schemaVersion: 1`).
   - Every CSV must carry the 14 rows of `rubric.ts` with its `Max` cells; the `API cost` row is added from `run.json`'s usage.
   - It holds each CSV's four hidden-test rows to its `contract-results.json`: a missing, invalid or disagreeing file, or another attempt's, stops the run. A `failureKind: "model"` attempt needs none, and its hidden rows must be 0.
   - It publishes only the current rubric id's attempts: a configuration with any attempt scored under another rubric id is withheld whole, its model failures included, with a warning, until it is re-scored.
5. **`website/`**: Astro 5 static dashboard reading `results*.json`, with a track switcher. Nothing reads `eval-attempts/` at runtime.

**The hard track** runs with `--root tracks/console-hard --config benchmark/runner-hard.yaml`; its attempts and results live under `tracks/console-hard/`. `scripts/score-hard.ts --attempt <dir> --force` runs the hidden contract and E2E suites and the stops and writes the CSV, applying `judge-rows-hard.json`; then `process-results:hard` and `screenshots:hard -- --only <config> --force`. A new or re-run attempt needs the `agrav-score-hard` skill. A rubric id change that touches only `contract-tests/` keeps the judgement: `node --import tsx scripts/migrate-judge-rows-hard.ts --from-rev <rev> --write` restamps every `judge-rows-hard.json` once it has reproduced the old id from today's files with `contract-tests/` taken from `<rev>`; record the suite's new fingerprint in `scripts/gate-h-freeze.ts` in the same change.

**The brownfield track differs in four places.**
- `run-matrix` takes `--root tracks/brownfield --base tracks/brownfield/base`: each attempt starts from a copy of the base, `run-attempt --no-new-project` runs agy on it, and an attempt with no change against the base is `failureKind: "model"` with `noDiffFromBase: true` in its `run.json`.
- The judge is `.claude/skills/agrav-score-brownfield/SKILL.md`, which passes `--root tracks/brownfield` to every script (`serve-attempt` defaults to the repository root).
- `scripts/contract-tests-brownfield.ts` runs the 58-test regression suite, the change suite and diff locality, then the attempt's own `pytest backend/tests` in its backend container, and writes `contract-results-brownfield.json`; `contract-results-brownfield.ts --rows` prints the three rows the skill pastes.
- `process-results --track brownfield` writes `results-brownfield.json` and `leaderboard-brownfield.json`.

`scripts/take-screenshots.ts` runs out-of-band: per attempt it starts the backend in the harness image on 5100 and the frontend's dev server on 5173, Playwright-captures `/` at 1280×720, and writes `website/public/screenshots/`. Screenshots are committed, not built in CI. Run it after a configuration's matrix has finished: `--only` takes the whole configuration, including an attempt still being written.

## Invariants that will silently break things

- **Attempt directory names must match `/^([a-z0-9.-]+)-attempt-(\d+)$/`.** No underscores: `process-results.ts` parses model id and attempt number straight out of the dirname. Every runner matrix `id` has to satisfy this too, and every id carries an effort suffix (`-high`/`-med`/`-low`) even when only one level is run.
- **Attempt dirs hold model output only, plus install artefacts.** No `prompt.md`, no run metadata. `agy` drops `.antigravitycli/<uuid>.json` into every workspace it touches; it is gitignored. The carve-out for install artefacts is unavoidable:
  - scoring, serving and screenshot capture run `npm install` *inside* `<attempt>/frontend`, because installing out of tree would change what is scored, and `--no-package-lock` would re-resolve and make two attempts incomparable;
  - the skill's `npm run build` writes there too;
  - so `frontend/node_modules/`, `frontend/dist/` and a **tool-created** `frontend/package-lock.json` are install artefacts, not model output.

  The backend never installs into the attempt: its venv lives in a scratch directory outside it, and the attempt is mounted read-only. `take-screenshots.ts` and `serve-attempt` (through `dev-server.ts`'s `ensureNodeModules`) remove only a lockfile they created themselves and never touch a model-written one, which stays committed because it is scoreable output.
- **Tailwind 3, not 4** (the dashboard's own stack; attempts may use either, `criteria.md`). v4 is incompatible with this Astro/`@astrojs/tailwind` setup.
- **Stop rules:** `benchmark/criteria.md`'s stop table (backend stop, frontend stop, both, model failure, and a backend that boots for the hidden tests but not when served) decides which rows are zeroed; the skill applies it. Both stops and a model failure are the all-zero CSV. A harness fault is never a stop: it is infra, and nothing is written. Preserve it: it keeps scores honest.
- **Score math:** `Task completion time`, `Test run`, `Penalty`, and `API cost` are excluded from the denominator; `Penalty` is subtracted from the total; `percentage = total / max * 100`. Family aggregation keys on `getModelBaseId`, not display name (two configurations can share a name).
- **CSV shape:** header `Criterion,Score,Max,Notes`, then the 14 rows of `scripts/lib/rubric.ts`'s `RUBRIC_ROWS`, in its order and with its names (the dash in `Frontend–API integration` is an en dash), and no `API cost` row. `Task completion time` uses `Xmin Ys` (e.g. `5min 46s`) or `N/A` in both Score and Notes; `Test run` uses `D.MM.YYYY HH:MM`. The dashboard (`comparisonUtils.ts`, which `ResultsTable.tsx` uses) reads these formats literally. Use a real CSV parser: a regex mis-splits quoted notes containing commas.
- **Full network egress in the harness container** is required: the model installs npm and PyPI packages, and the backend's `pip install` during scoring needs PyPI.
- **Record the judge model in the runner.** Comparisons are only valid with the same judge and the same rubric id (the runner's `rubric:`, a content hash of the files in `RUBRIC_ID_INPUTS`; `test/rubric-id.test.ts` fails when one of them changes and the id does not). The hard and brownfield ids hash their specs, suites and rubric modules but not the scorer code around them, so `test/scorer-freeze.test.ts` holds that code (and the root lockfile's Playwright and axe versions, which the hard E2E runs on) to the fingerprints in `scripts/lib/scorer-freeze.ts`. When it is red, either:
  - a scoring rule changed: that is a new rubric id and a re-score;
  - or a refactor provably changed no row: record the new fingerprint and say why in the commit.

  Stop classification (`attempt-backend.ts`, `serve-attempt.ts`, `dev-server.ts`, `pytest-summary.ts`) stays under gate 3a's fingerprint. A red gate 3a caused by a changed stop rule is a new rubric too, not a re-recording.
- **At most 12 attempts per configuration.** Above that the filmstrip composition breaks.
- **One matrix at a time.** A second `run-matrix` refuses to start: there is a single shared OAuth session, so two runs would interleave on one token and one quota.
- **Operator interruption writes nothing.** Ctrl-C is neither a model failure nor an infra failure; the attempt is simply left un-run so a rerun picks it up.
- **Never invoke a signal-sensitive script through the bare `tsx` bin.** `npm run run-matrix` runs `node --import tsx scripts/run-matrix.ts`, not `tsx scripts/run-matrix.ts`, and `test/package-scripts.test.ts` fails if that changes. The `tsx` bin forks a second node process and relays signals over an IPC pipe. A runner blocked in `spawnSync("docker", …)` cannot answer that relay, so the wrapper escalates to **SIGKILL 61ms after Ctrl-C** and no handler, `finally` or `exit` listener runs. It then exits 130, the code a clean Ctrl-C produces, so nothing shows that the cleanup never ran. That can leave a live OAuth token in the temp directory and strand the matrix lock. Cleanup functions are also individually try/caught, because a throw in one `exit` listener aborts the rest.
- **The confidentiality test** (`test/confidentiality.test.ts`) scans tracked files and the whole history for secret-shaped tokens. It also scans for the terms in a gitignored `.confidential-terms` or the `CONFIDENTIAL_TERMS` variable, if either is present. It fails without terms only when `REQUIRE_CONFIDENTIAL_TERMS=true`. Never write a term from that list into a tracked file or a commit message.

## Verification gates

Gate 2 (`npm run gate:reference`) and gate 3a (`npm run gate:backend`) record results whose fingerprints `npm test` checks against the files they cover. The other gates:
- `gate:hard-reference`;
- `gate:fuzz` and `gate:hard-fuzz`, the differential fuzz oracles;
- `gate:h-freeze`, the hard contract suite and oracle fingerprint.

The overriding rule: **run the pipeline in stages before launching the rest of a matrix.** First one model × 1 attempt through the scorer, the judge skill, `process-results`, screenshots and the dashboard; then that model × 5; then the rest. Check `agy -p "/usage"` before each stage. The classic runner's five rows make 25 runs, up to about 12.5 h at up to 30 minutes each: a large slice of a weekly Antigravity quota. Do not spend it on an unvalidated pipeline.

## npm scripts

```bash
npm test                                           # node --test, no container needed
npm run typecheck                                  # both legs: scripts/ + website/src/
npm run lint
npm run run-matrix -- --only <id> --attempts <n>   # sequential, resumable, one at a time
npm run process-results                            # CSVs → results.json
npm run dev                                        # process-results && cd website && astro dev
npm run build                                      # process-results && cd website && astro build
npm run screenshots -- --only <id> --force         # Playwright capture per attempt
npm run process-results:hard                       # likewise :brownfield
npm run screenshots:hard -- --force                # likewise :brownfield; run from the repository root
node --import tsx scripts/contract-tests-brownfield.ts --attempt <dir> --root tracks/brownfield   # not via npm run (signals)
npm run contract-results:brownfield -- --rows <dir> --root tracks/brownfield
```

`postinstall` installs `website/`'s dependencies too, so a fresh clone builds from a single `npm install`. The screenshot script needs `npx playwright install` once.
