# agrav-bench

A one-shot coding benchmark driven by the **Antigravity CLI** (`agy`). Every model
gets the same prompt, `prompt.md`, and builds the Meridian Maintenance Console from it
in one go: a small full-stack app that plans preventive-maintenance work orders, with a
FastAPI backend and a React frontend.

On the classic track the result is scored out of 14 points, less any Penalty, and
published to a static dashboard:
- 7 from the hidden contract tests;
- 1 from the local build check;
- 6 from the agent-judged and human-judged rows of `benchmark/criteria.md`.

Two more tracks reuse the same pipeline:
- The **hard track** (`tracks/console-hard/`, `benchmark/runner-hard.yaml`) asks for
  a larger planner with crews, travel, splitting and preemption. It is scored out of
  19 points by hidden contract tests and Playwright E2E suites.
- The **brownfield track** (`tracks/brownfield/`) hands the model a frozen FastAPI +
  React base to change instead of an empty directory. It is scored out of 12 points
  by the base's regression suite, a change suite and diff locality.

**Each (model, effort) pair is its own benchmark row**, so a model's `--effort` levels
can be compared against each other rather than collapsed into one score. Adding or
removing a row is a one-line change in a runner.

The repository ships with no results: the dashboard builds and shows "No results
yet" until you run and judge your own attempts.

## Requirements

| | |
|---|---|
| Linux x86_64 | the harness image pins the `linux-x64` build of `agy` |
| Docker | for the harness image: a matrix run starts one container per attempt, and scoring and screenshots run each attempt's backend in it |
| Node.js 24 (npm 11), git | what CI pins and what the toolchain is tested against |
| An Antigravity account | for a matrix run: `agy` must be able to run the models in the runner's `matrix:`, and every attempt spends that account's quota |
| Claude Code | for judging: the judge skills in `.claude/skills/` run in it, on the model each runner names as `judge:` (`claude-opus-5-5`) |
| Chromium for Playwright | for screenshots, the hard track's E2E rows and `npm run gate:backend`: `npx playwright install chromium` |

Only the matrix run needs `agy`, credentials and quota. Docker is needed only for the
matrix run, scoring, screenshots and `npm run gate:backend`. A fresh clone can
install, test, typecheck and build the dashboard without either.

## Quick start

```bash
git clone <this repository> agrav-bench && cd agrav-bench
npm install                                          # also installs website/
docker build -t agrav-bench/harness:2026-10-04 images/harness
```

1. **Sign `agy` in, inside the container, once.** This is the one step that cannot be
   automated. The full procedure, with its fallbacks and the checks that it worked,
   is in [docs/INSTRUKCJA-UZYTKOWNIKA.md](docs/INSTRUKCJA-UZYTKOWNIKA.md) §7 (in
   Polish). In outline:
   ```bash
   docker run -it --pull never --user "$(id -u):$(id -g)" -e HOME=/home/agy -w /home/agy \
       -v agy-creds:/home/agy agrav-bench/harness:2026-10-04 --login
   ```
2. **Dry-run, then one attempt:**
   ```bash
   npm run run-matrix -- --only gemini-38-flash-high --attempts 1 --dry-run
   npm run run-matrix -- --only gemini-38-flash-high --attempts 1
   ```
3. **Judge it** in Claude Code, from the repository root:
   `/agrav-score-attempt gemini-38-flash-high-attempt-1`.
4. **Publish it locally:**
   ```bash
   npm run process-results
   npx playwright install chromium      # once
   npm run screenshots -- --only gemini-38-flash-high --force
   npm run dev                          # the dashboard, usually http://localhost:4321
   ```

`npm install` at the root installs `website/`'s dependencies too, through a
`postinstall` hook. That is deliberate: `npm run build` cds into `website/` and runs
`astro build`, so without it a fresh clone fails with `sh: 1: astro: not found`. The
two packages keep separate lockfiles on purpose: hoisting them into one workspace
breaks the Astro/Tailwind resolution this setup depends on.

## The three tracks

| | Classic | Hard | Brownfield |
|---|---|---|---|
| Task | `prompt.md` | `tracks/console-hard/prompt.md` | `tracks/brownfield/prompt.md`, on `tracks/brownfield/base/` |
| Rubric | `benchmark/criteria.md`, 14 points | `tracks/console-hard/benchmark/criteria.md`, 19 points | `tracks/brownfield/benchmark/criteria.md`, 12 points |
| Runner | `benchmark/runner.yaml` | `benchmark/runner-hard.yaml` | `tracks/brownfield/benchmark/runner.yaml` |
| Run | `npm run run-matrix -- --only <id> --attempts 1` | `npm run run-matrix -- --root tracks/console-hard --config benchmark/runner-hard.yaml --only <id> --attempts 1` | `npm run run-matrix -- --root tracks/brownfield --base tracks/brownfield/base --only <id> --attempts 1` |
| Judge (Claude Code) | `/agrav-score-attempt <dir>` | `/agrav-score-hard <dir>`, which runs `node --import tsx scripts/score-hard.ts --attempt <dir> --force` | `/agrav-score-brownfield <dir>` |
| Results | `npm run process-results` | `npm run process-results:hard` | `npm run process-results:brownfield` |
| Screenshots | `npm run screenshots -- --only <id> --force` | `npm run screenshots:hard -- --only <id> --force` | `npm run screenshots:brownfield -- --only <id> --force` |

`<id>` is a `matrix:` id from the runner, e.g. `gemini-38-flash-high`; `<dir>` is an
attempt directory name, `<id>-attempt-<n>`.

On the hard and brownfield tracks, attempts and results live under the track:
`tracks/<track>/eval-attempts/` and `tracks/<track>/eval-results/`. A brownfield
attempt starts from a copy of the base. An attempt that leaves the base unchanged is
a model failure, recorded with `noDiffFromBase: true` in its `run.json`.

## Layout

```
prompt.md        the classic task (spec files listed in benchmark/SPEC-FILES.md)
benchmark/       the classic rubric (criteria.md), hidden contract tests, seed and
                 runner.yaml (the matrix); runner-hard.yaml for the hard track
tracks/          console-hard/ and brownfield/: each track's prompt, rubric and
                 hidden tests (brownfield also its frozen base/); console-fuzz/:
                 the classic track's differential fuzz oracle
images/harness/  the Docker image that runs one attempt (Dockerfile + run-attempt),
                 and each attempt's backend when it is scored; IMAGE.md records it
scripts/         run-matrix, the scorers (contract-tests, score-hard,
                 contract-tests-brownfield), serve-attempt, process-results,
                 take-screenshots, the gates (npm run gate:*) + scripts/lib
eval-attempts/   classic attempts, one directory each (model output only), created
                 by a run; plus metadata.ts (model ids, names, pricing)
eval-results/    classic results, one directory per attempt, created by a run:
                 run.json (harness), contract-results.json (hidden tests),
                 eval-results.csv (judge)
website/         Astro 5 dashboard; reads src/data/results*.json and, at build
                 time, each track's prompt, criteria and runner off disk
docs/            INSTRUKCJA-UZYTKOWNIKA.md, the operator's guide (Polish)
.claude/skills/  the hybrid judges, one per track: agrav-score-attempt,
                 agrav-score-hard, agrav-score-brownfield
```

## The pipeline

Five stages, one-way. Everything downstream of the runner is regenerable from the
committed CSVs, so a scoring change never means re-running the models.

1. **`npm run run-matrix`** reads the runner and runs the harness container once per
   (model, effort, attempt), **strictly sequentially**: one OAuth session, one weekly
   quota. It reads `agy -p "/usage"` before each attempt, and with `quotaFloor` set
   it stops before an attempt whose model's bucket is below that percentage. Output
   lands in two places:
   - model output in `eval-attempts/<id>-attempt-<n>/`;
   - harness metadata (duration, exit code, token usage, failure classification) in
     `eval-results/<id>-attempt-<n>/run.json`.

   The run is resumable: an attempt with a `run.json` is skipped, except one
   recording an infrastructure failure, which is deliberately re-run. Every attempt
   ends in one of three states:
   - a **model failure** (timeout, crash) is a data point that scores 0;
   - an **infrastructure failure** (auth, quota, soft-denied tool, bad model id, a
     container that could not be confirmed removed) stops the matrix instead of
     writing fake zeros;
   - an **operator interruption** (Ctrl-C, a closed terminal) is neither: it writes
     no `run.json` at all, stops the matrix, and the next invocation re-runs the
     attempt.
2. **The judge** runs one attempt per invocation, with the classic track's
   `.claude/skills/agrav-score-attempt` as the model the other two follow:
   - it reads `run.json`;
   - it runs `contract-tests`, the hidden API tests, against the attempt's backend in
     the harness image (`contract-results.json`);
   - it installs and builds the frontend;
   - it serves the attempt with `serve-attempt` so a person can score the human rows;
   - it scores the agent rows and proposes a `Penalty` for that person to confirm.

   It writes `eval-results/<id>-attempt-<n>/eval-results.csv`, with the hidden-test
   rows pasted from `contract-results.ts --rows`, never typed. The rows, the bands and
   the stop rules (which rows a backend stop, a frontend stop or a model failure
   zeroes) are in each track's `criteria.md`.
3. **`npm run process-results`** turns those CSVs plus `run.json` into
   `website/src/data/results.json` and `website/public/api/leaderboard.json`. It holds
   each CSV's hidden-test rows to its `contract-results.json`. It publishes only the
   current rubric id's attempts: a configuration with an attempt scored under another
   id is withheld, with a warning, until it is re-scored.
4. **`npm run screenshots`** serves each attempt (its backend in the harness image, its
   frontend's dev server on the host) and captures `/` at 1280x720, plus one filmstrip
   per configuration. It runs out-of-band and its output is committed: CI never runs
   it.
5. **`npm run build`** builds the dashboard. `.github/workflows/publish.yml` tests and
   builds on a push to `main`, and deploys to Cloudflare Pages once you configure it
   (`website/DEPLOYMENT.md`).

## npm scripts

| Script | What it does |
|---|---|
| `npm run run-matrix -- --only <id> --attempts <n>` | Run the matrix. `--dry-run` prints the docker commands and writes nothing; `--root`, `--config` and `--base` select a track. `--help` for the rest. |
| `node --import tsx scripts/contract-tests.ts --attempt <dir>` | Runs the hidden contract tests against the backend of `eval-attempts/<dir>` and writes `eval-results/<dir>/contract-results.json`, a backend stop included. |
| `node --import tsx scripts/serve-attempt.ts --attempt <dir>` | Serves the backend of `eval-attempts/<dir>` on 127.0.0.1:5100 and its frontend's dev server on 5173, until a signal. `--stop` stops whatever `serve-attempt` runs under `--root`. |
| `node --import tsx scripts/score-hard.ts --attempt <dir> --force` | The hard track's scorer: hidden contract tests, E2E suites, stops and the CSV. The `agrav-score-hard` skill runs it. |
| `node --import tsx scripts/contract-tests-brownfield.ts --attempt <dir> --root tracks/brownfield` | The brownfield regression suite, change suite, diff locality and the attempt's own tests. Run it directly, not through `npm run` (signals). |
| `npm run contract-results:brownfield -- --rows <dir> --root tracks/brownfield` | Prints the three brownfield rows the skill pastes. |
| `npm run process-results` (`:hard`, `:brownfield`) | CSVs + `run.json` -> `results*.json`, `leaderboard*.json`. |
| `npm run screenshots` (`:hard`, `:brownfield`) | Playwright capture per attempt, plus filmstrips. `--only`, `--force`, `--install-timeout`, `--root`. Run from the repository root. |
| `npm run dev` | `process-results`, then the Astro dev server. |
| `npm run build` | `process-results`, then `astro build`. |
| `npm test` | The whole suite: `node --test --import tsx "test/**/*.test.ts"`. No browser, no network, no harness image; the only daemon call is the read-only `docker image inspect` the `--dry-run` tests make, which carries on when there is no daemon. Never run a bare `node --test`: it picks up every `.mjs`/`.js` under `test/`, fixture servers included, which binds port 5173 and hangs. |
| `npm run typecheck` | `tsc` at the root and in `website/`. |
| `npm run lint` | ESLint over `website/src`. |

Most scripts take `--help`; the gates and the hard and brownfield scorers run as listed above.

## Gates

The gates check that the scoring tools measure what they claim. Each one records a
fingerprint of the files it covers, and `npm test` fails when one of those files
changes without the gate being re-run.

| Gate | What it proves | Needs |
|---|---|---|
| `npm run gate:reference` | gate 2: the classic hidden tests pass on a reference backend, and each mutant (the reference with one rule broken) fails the files listed for it | Python 3 on the host |
| `npm run gate:backend` | gate 3a: the harness image, `contract-tests`, the backend stops, `serve-attempt` and `take-screenshots`, on synthetic attempts in a temporary `--root` | Docker, the harness image, Chromium, ports 5100 and 5173 free |
| `npm run gate:hard-reference` | the same for the hard contract tests, and that every new hard rule changes the seed week | Python 3 on the host |
| `npm run gate:fuzz`, `npm run gate:hard-fuzz` | the reference planner still gives the answers the differential fuzz oracle froze, and what each mutant fails; the oracle scores no row | Python 3 on the host |
| `npm run gate:h-freeze` | the hard contract suite and its oracle match their recorded fingerprint | nothing |

A complete passing `gate:backend` records `test/fixtures/backend-gate/gate-3-result.json`;
any `--only` records nothing.

**Before spending quota on a new matrix,** run the pipeline in stages, reading
`agy -p "/usage"` (`run-attempt --usage`) before each one:
1. one model x 1 attempt through the scorer, the judge, `process-results`,
   screenshots and the dashboard;
2. then that model x 5 attempts;
3. then the rest of the matrix.

The full classic matrix is 5 configurations x 5 attempts = 25 runs at up to 30
minutes each: up to about 12.5 hours of agent time, and a large slice of a weekly
quota.

## When the pinned agy release disappears

Everything the benchmark needs is committed here except the `agy` binary.
`images/harness/Dockerfile` downloads it from Google's public bucket and pins the exact
release through three build args (`AGY_VERSION`, `AGY_BUILD`, `AGY_SHA512`), checked
with `sha512sum -c`. That URL carries a build id from an auto-updater manifest, and
those rotate. When the pinned build stops being served, the image build fails closed,
on the checksum or on a 404. Tests, typecheck and the dashboard never need the image:
the suite's `--dry-run` tests only ask the daemon for its Id and carry on without one.
The matrix, scoring, screenshots and `npm run gate:backend` need it.

Recovering means bumping to a release that *is* served, which changes the CLI the
benchmark measures. Say so in the results: scores are only comparable across runs of
the same `agy` version, which is why `run.json` records it per attempt.

```bash
# 1. What is served now
curl -s https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_amd64.json | jq

# 2. Fetch that tarball and take its checksum
curl -fsSL -o /tmp/agy.tgz \
  "https://storage.googleapis.com/antigravity-public/antigravity-cli/<VERSION>-<BUILD>/linux-x64/cli_linux_x64.tar.gz"
sha512sum /tmp/agy.tgz

# 3. Confirm the layout the Dockerfile assumes: one member named `antigravity`
tar -tzf /tmp/agy.tgz | head
```

Then:
1. update the three args in `images/harness/Dockerfile`;
2. set `agyVersion` in the runners to match;
3. rebuild with a fresh date tag and put it in the runners' `image:`;
4. record what changed in `images/harness/IMAGE.md`;
5. run `npm run gate:backend` again: a new tag changes what gate 3a proved.

Step 3 of the commands above is not optional. The Dockerfile extracts a member called
`antigravity` and renames it to `agy`, so a repackaged tarball passes the checksum and
still produces an image with no `agy` in it.

A rebuilt image needs a fresh sign-in only if you also removed the `agy-creds` volume;
the credentials live outside the image.

## Local checks

These are the checks `.github/workflows/publish.yml` runs after its install step.
Run them before pushing.

```bash
npm run typecheck   # tsc at the root and in website/
npm test            # the whole suite
git grep -l -F -e raw.githubusercontent -- website/   # must print nothing (exit 1)
npm run lint        # eslint over website/src
npm run build       # process-results, then astro build
```

The third is the reproducibility check. The prompt and the rubric the benchmark page
renders are this repository's own and read off disk on purpose, so a build must never
fetch them. `git grep` is scoped to tracked files, because an unscoped grep matches
inside `website/node_modules` and fails on a dependency's README.

## Things that will surprise you

- **`npm run build` and `npm run process-results` always dirty the tree.** The results
  and leaderboard JSON files are tracked, and each carries a `generatedAt` timestamp
  stamped fresh on every run. Revert them before committing
  (`git checkout website/src/data website/public/api`) unless a CSV actually changed.
- **Screenshots are committed, not built.** They need Docker and the harness image
  (each attempt's backend runs in it), a browser and a dependency install per
  attempt.
- **Tailwind 3, not 4** (the dashboard's own stack; attempts may use either,
  `criteria.md`). v4 is incompatible with this Astro / `@astrojs/tailwind` setup.
- **Attempt directory names are parsed, not just displayed.** They must match
  `/^([a-z0-9.-]+)-attempt-(\d+)$/`, with no underscores. Every runner's matrix id
  has to satisfy it too, and carries an effort suffix (`-high`/`-med`/`-low`) even
  for a model that has no levels.
- **The effort level is part of the model id.** agy rejects an `--effort` that
  disagrees with the id's suffix, and three models (`claude-sonnet-4-6`,
  `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`) reject the flag outright; their
  rows carry `effort: null`.
- **At most 12 attempts per configuration.** Past that the filmstrip is wider than
  Chromium will render. Both the runner and `--attempts` refuse a larger number up
  front.
- **One matrix at a time.** A second `run-matrix` refuses to start, from any checkout.
  The lock is a file in the temp directory (`$TMPDIR`, `/tmp` unless the shell sets
  it) named after the credentials volume (`agrav-bench-run-matrix-agy-creds.lock`),
  because what it protects (one OAuth session, one weekly quota) is machine-wide.
  Two shells with different `TMPDIR` values get two locks. A lock file left behind by
  a `SIGKILL` is taken over rather than blocking every later run.
- **Signal-sensitive scripts run through `node --import tsx`, never the bare `tsx`
  bin.** The `tsx` wrapper forks a second process and kills it 61ms after Ctrl-C,
  before any cleanup runs. `test/package-scripts.test.ts` holds the npm scripts to
  this.
- **Keeping names out of the repository.** If certain names must never appear in this
  repository or its history, put them in a gitignored `.confidential-terms` at the
  root, one per line, and run `npm test` before pushing. The confidentiality test then
  scans tracked files and every reachable blob, path, commit and ref for them. Without
  the file it scans for secret-shaped tokens only. CI takes the same list from the
  `CONFIDENTIAL_TERMS` secret (`website/DEPLOYMENT.md`).

## Provenance

- Prompt and rubric: this repository's own, written for the maintenance-console task;
  `benchmark/SPEC-FILES.md` lists the spec files.
- This repository is MIT-licensed (`LICENSE`). The licence notice for derived code is
  in `THIRD_PARTY_NOTICES.md`; the dashboard publishes the same file at
  `/THIRD_PARTY_NOTICES.txt`, linked from its footer.
- Harness image and the `agy` build it pins: `images/harness/IMAGE.md`.
- Deployment: `website/DEPLOYMENT.md`.
- Operator's guide, step by step (Polish): `docs/INSTRUKCJA-UZYTKOWNIKA.md`.
