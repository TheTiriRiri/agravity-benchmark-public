---
title: Running the agrav-bench benchmark
kicker: agrav-bench · Antigravity CLI
subtitle: From cloning the repository to publishing the results on the dashboard — for an operator with no programming background.
scope: Stages 1–8 · classic, hard and brownfield tracks
status: "!info Current procedure — read before the first full run"
lang: en
meta:
  Audience: an operator with no programming background
  Task: Meridian Maintenance Console
  Judge: claude-opus-5-5
  Harness image: agrav-bench/harness:2026-10-04
  agy version: 1.2.7
footer: "docs/OPERATOR-GUIDE.md"
---

## 1. Purpose and how it works

agrav-bench measures how well the AI models available in **Antigravity CLI** (`agy`) build the **Meridian Maintenance Console** application from a single fixed prompt (`prompt.md`). It is a small web application that schedules maintenance work for technicians at industrial sites: a Python backend (FastAPI) and a React frontend. Every model gets the same task, and its result is scored against a fixed list of criteria worth **14 points**: 7 from hidden API contract tests, 1 for the local build, 3 from criteria scored by the judge agent and 3 from criteria scored by a human; any penalty (Penalty) is subtracted. The scores go to a comparison dashboard. Two more tracks — **hard** (a bigger planner, 19 points) and **brownfield** (changing an existing application, 12 points) — use the same process; chapter 13 describes them.

A run consists of eight stages, done in order:

| Stage | What happens | Who does it | Time |
|---|---|---|---|
| 1 | Preparing the workstation | Human | 30–60 min (once) |
| 2 | Cloning the repository and installing | Human | 10 min |
| 3 | Building the runtime environment (Docker image) | Automated | 5 min |
| 4 | Signing in to Antigravity and the smoke test | Human | 15 min |
| 5 | Running the attempts (the model builds the application) | Automated | up to 32 min per attempt |
| 6 | Scoring each attempt | Automated + human (4 questions) | 20–40 min per attempt |
| 7 | Processing the results, screenshots, dashboard preview | Automated | 5–10 min |
| 8 | Committing to the repository and publishing | Human | 10 min |

> [!WARNING]
> **The overriding rule: first one attempt of one model through the whole process, then that model × 5 attempts, and only then the full matrix — reading the quota before each of these steps.** The full classic-track matrix is 5 configurations × 5 attempts = 25 runs of up to 30 minutes each, i.e. up to about 12.5 hours of automated work and a large share of the Antigravity account's weekly quota. Do not spend that quota on an unvalidated process.

---

## 2. Glossary

| Term | Meaning |
|---|---|
| **Terminal** | The text window where you type commands. Linux/macOS: the "Terminal" app. Windows: use WSL2 (Ubuntu) — this guide assumes a Linux terminal. |
| **Repository** | The project directory with its full change history, managed by Git. |
| **Configuration** | A (model, effort level) pair, e.g. `gemini-38-flash-high`. Each one has its own row in the results. |
| **Attempt** | One run of a model on the task. Each configuration has 5 attempts: `<configuration>-attempt-1` … `-attempt-5`. |
| **Docker image** | A sealed, reproducible environment in which `agy` runs and, during scoring, so does each attempt's backend. The model works only inside it. |
| **`agy-creds` volume** | Persistent Docker storage holding the saved Antigravity sign-in. It is created once. |
| **Quota** | The Antigravity account's weekly budget. Every attempt uses some of it. |
| **Hidden contract tests** | 58 automated API tests in `benchmark/contract-tests/` that the model never sees. `contract-tests` runs them against the attempt's backend; they are worth 7 of the 14 points. |
| **Stop rule** | When an attempt's backend or frontend cannot be installed or started, the criteria that cannot be scored get 0 (`benchmark/criteria.md`). |
| **Judge** | The Claude model that scores the attempts (recorded in `benchmark/runner.yaml` as `judge: claude-opus-5-5`). |
| **Dashboard** | The website with the results table; it is built from files in the repository. |

Conventions in this document: replace anything in angle brackets `<…>` with your own value; type commands in a terminal in the repository's root directory unless stated otherwise.

---

## 3. Prerequisites

### 3.1 Accounts and access

| Requirement | Notes |
|---|---|
| A Google account with active Antigravity access | Needed only to run the attempts (stages 4–5). Before the full matrix, the weekly quota should be at least ~30% on every model. |
| Access to the repository (a URL to clone) | Read access to start; write access for stage 8. |
| A Claude account with access to Claude Code | Needed to score the attempts (stage 6). |
| A Cloudflare account with a Pages project `agrav-bench`, and secrets in GitHub | Needed only to publish the dashboard on the internet (stage 8). Without it the dashboard works locally. The setup is described in `website/DEPLOYMENT.md`; an administrator does it. |

### 3.2 Software on the computer

| Program | Version | Check in the terminal | Expected result |
|---|---|---|---|
| Git | any current | `git --version` | `git version 2.x` |
| Node.js | **24** | `node --version` | `v24.x.x` |
| npm | 11 (ships with Node 24) | `npm --version` | `11.x.x` |
| Docker | current | `docker run --rm hello-world` | the message `Hello from Docker!` |
| Claude Code | current | `claude --version` | a version number |

If `docker run` reports `permission denied`, your user account must be added to the `docker` group (an administrator does this) — without it stages 3–7 do not work.

### 3.3 Resources

- A stable, unrestricted internet connection — while working, the model installs npm and PyPI packages, and scoring installs the backend's (PyPI) and the frontend's (npm) dependencies.
- About 10 GB of free disk space (Docker image, dependencies, results).
- Ports 5100 and 5173 free during scoring (stage 6) and screenshots (stage 7) — the application being scored runs on them.
- The computer must not go to sleep during stage 5.

---

## 4. Stage 1 — Preparing the workstation

1. Install the programs in table 3.2 and confirm each version with the command shown.
2. Sign in to Claude Code: run `claude` in any directory, sign in following the prompts, and finish with the `/exit` command.
3. Make sure the Google account meant for the benchmark is signed in in the browser, and that **every tab left over from earlier Antigravity sign-in attempts is closed** (an old open tab causes the `Invalid code verifier` error in stage 4).

---

## 5. Stage 2 — Cloning the repository and installing

```bash
git clone <repository URL> agrav-bench
cd agrav-bench
npm install
```

`npm install` installs the dependencies of the main project and of the dashboard (`website/`). It takes 1–3 minutes.

**Checking the workstation** — three commands, each of which must finish without an error:

```bash
npm test          # expected: a summary with "fail 0"
npm run typecheck # expected: no messages
npm run build     # expected: finishes without an error; the last lines summarise the pages built
```

After `npm run build`, `git status` shows two modified files: `website/src/data/results.json` and `website/public/api/leaderboard.json`. `npm run build` first runs `process-results`, which writes both, each with a new timestamp (`generatedAt`) — with no new scores, that is the only change and it does not matter. Restore them with:

```bash
git checkout website/src/data/results.json website/public/api/leaderboard.json
```

---

## 6. Stage 3 — Building the runtime environment

The image contains the `agy` program at one exact version (1.2.7), Python 3.11 (in which each attempt's backend runs during scoring) and the script that drives an attempt. The image name must be identical to the `image:` entry in `benchmark/runner.yaml` (currently `agrav-bench/harness:2026-10-04`). `images/harness/IMAGE.md` describes what the image contains and how to check it.

```bash
docker build -t agrav-bench/harness:2026-10-04 images/harness
```

Expected result: the last line starts with `Successfully tagged` or `naming to docker.io/agrav-bench/harness:2026-10-04`.

**If the build fails at the `sha512sum` step or with `404`**, the vendor has stopped publishing the pinned `agy` version. Do not change anything yourself — changing the `agy` version makes the results incomparable. Hand the situation to the project's administrator (procedure: `README.md`, section "When the pinned agy release disappears").

---

## 7. Stage 4 — Signing in to Antigravity and the smoke test

> [!STOP]
> **The sign-in must happen inside the container**, never through an `agy` installed directly on the computer. Signing in on the computer saves the credentials somewhere the benchmark cannot reach, and every attempt will then run signed out.

You sign in once per `agy-creds` volume. If the volume already exists (the sign-in was done earlier), skip 7.1 and start at 7.2 — step 7.3 will show whether the saved sign-in still works. Apart from the sign-in itself, the volume is never mounted as `agy`'s home directory, because `agy` writes logs to its home directory and may refresh the token. Steps 7.2–7.6 work on a throwaway copy of the credentials, just as `run-matrix` does for every attempt.

Every `docker run` of the harness image in this guide includes `--pull never`: if the image is not on the computer, the command fails instead of pulling an image of that name from the public registry, where anyone could have put one. The image is built in stage 3.

### 7.1 Signing in

```bash
docker run -it --pull never --user "$(id -u):$(id -g)" -e HOME=/home/agy -w /home/agy \
    -v agy-creds:/home/agy agrav-bench/harness:2026-10-04 --login
```

What happens:

1. The terminal shows `agy`'s full-screen interface with a sign-in URL (or the browser opens by itself).
2. Copy the URL into the browser, sign in with the Google account that has Antigravity access, and accept the consents.
3. After the success message, go back to the terminal and close `agy` (Ctrl+C). The container exits — the saved sign-in stays on the `agy-creds` volume.

**Without a terminal (e.g. over SSH without `-t`, or from a script).** The same command behaves differently depending on a single Docker flag — the kind of input the container has decides whether `agy` shows the sign-in URL:

| You have | Use | Result |
|---|---|---|
| a terminal | `-it … --login` (the command above) | the full sign-in interface |
| a pseudo-terminal, but no terminal | `script -qec "docker run -it …" /dev/null` | the sign-in URL and a place to paste the code |
| neither | any print-mode command (e.g. `--usage`) **without `-i`** | the sign-in URL and a 60-second wait — but the input is `/dev/null`, so there is nowhere to paste the code |
| — | `-i` without `-t` | an immediate refusal `Error: authentication required. Run 'agy' to log in, then retry.` — this is a trap: it looks like a broken install, and it is not |

When there is no terminal, the most reliable option is to get a pseudo-terminal (`script`, `ssh -t`). The `--models` command never starts a sign-in — with or without `-i` it answers at once with `Error: Please sign in to view available models.` — which is why it is the one used to check the sign-in (7.3).

The image always runs `run-attempt`, not `agy`: the command `docker run … <image> agy …` fails with `unknown arg: agy`. `run-attempt` has four modes — `--login`, `--models`, `--usage` and the attempt itself.

This is the only command in chapter 7 that writes to the `agy-creds` volume; steps 7.2–7.6 mount it read-only or not at all. The `-it` flags are mandatory. Without them the command fails with `error opening TTY` **and a green status** — which is why you check the result of the sign-in only with step 7.3, never by the absence of an error message. Do **one** sign-in from start to finish, without breaks; on an `Invalid code verifier` message, close every browser tab related to Antigravity and repeat the step from the beginning.

### 7.2 A throwaway copy of the credentials

Do steps 7.2–7.6 in order in **one terminal window**: the commands below store the image name and the temporary directory in the variables `IMAGE` and `SMOKE`, which the following steps use.

```bash
IMAGE=agrav-bench/harness:2026-10-04
SMOKE=$(mktemp -d); mkdir -p "$SMOKE/home" "$SMOKE/work"
docker run --rm --pull never --user "$(id -u):$(id -g)" -w /src -v agy-creds:/src:ro -v "$SMOKE/home:/dst" \
    --entrypoint cp "$IMAGE" --parents \
    .gemini/antigravity-cli/antigravity-oauth-token .gemini/antigravity-cli/installation_id /dst/
```

The command copies only two files from the volume, which is mounted read-only: the sign-in token and the installation id — the same two that `run-matrix` copies before every attempt. **The `$SMOKE` directory holds the account's live token** and is deleted in step 7.6. If the command fails with `cp: cannot stat …`, there is no sign-in on the volume: do 7.6, then 7.1, then 7.2 again.

### 7.3 Checking the sign-in (mandatory)

```bash
docker run --rm --pull never --user "$(id -u):$(id -g)" -e HOME=/home/agy -w /home/agy \
    -v "$SMOKE/home:/home/agy" "$IMAGE" --models
```

| Result | Meaning |
|---|---|
| A list of a dozen or so model ids (`gemini-3.8-flash-high`, `claude-sonnet-4-6`, …) | **Sign-in succeeded.** You can continue. |
| `Error: Please sign in to view available models.` | The sign-in was not completed or has expired. Do 7.6, repeat 7.1, then continue from 7.2. |

### 7.4 Smoke test

The test checks the whole path every attempt takes: the credentials copy, running the model in a container with a 30-minute time limit, and writing the results as the current user. It is a single, very short model call; it uses a small part of the quota.

```bash
printf 'Create hello.txt containing the word hello\n' > "$SMOKE/prompt.md"
docker run --rm --pull never --user "$(id -u):$(id -g)" -e HOME=/home/agy -e TIMEOUT=30m \
    -v "$SMOKE/work:/workspace" -v "$SMOKE/home:/home/agy" -v "$SMOKE/prompt.md:/prompt.md:ro" \
    "$IMAGE" --model gemini-3.8-flash-high --effort high --prompt-file /prompt.md \
    >"$SMOKE/stdout.json" 2>"$SMOKE/stderr.log"
```

Checking the result — four commands:

```bash
ls -l "$SMOKE/work/hello.txt"
node -e 'const e = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); console.log(e.status, e.usage.total_tokens > 0)' "$SMOKE/stdout.json"
grep -c soft-deny "$SMOKE/stderr.log"
docker run --rm --pull never --entrypoint agy "$IMAGE" --version
```

| Command | Expected result |
|---|---|
| `ls -l …` | The file `hello.txt` exists and is owned by the current user, not `root`. |
| `node -e …` | `SUCCESS true`. With `TIMEOUT=30m` this also means `agy` accepted the 30-minute time limit. |
| `grep -c soft-deny …` | `0` |
| `… --version` | The version recorded in `images/harness/IMAGE.md` (currently 1.2.7). |

If any result differs, do not run any attempts: do 7.6 and hand the results to the administrator.

### 7.5 Reading the quota

```bash
docker run --rm --pull never --user "$(id -u):$(id -g)" -e HOME=/home/agy -w /home/agy \
    -v "$SMOKE/home:/home/agy" "$IMAGE" --usage
```

The output is a table with the percentage of quota **remaining** and the reset time for each model. The shape of a row (sample values; the real ones will differ):

```
All Models	Gemini 3.8 Flash (High)	100%	<reset time>
All Models	Claude Opus 4.6 (Thinking)	100%	<reset time>
```

Write down the value for the model you are about to run — after 5 attempts, comparing the two readings shows the real cost of one configuration. If a sign-in URL and a 60-second wait appear instead of the table, the sign-in did not work: interrupt (Ctrl+C), do 7.6 and go back to 7.1.

### 7.6 Deleting the credentials copy (mandatory)

```bash
rm -rf "$SMOKE"
```

The directory holds the account's live token, so always delete it — including when a step failed. Along with it goes any token `agy` may have refreshed during the smoke test: unlike an attempt run by `run-matrix`, nothing writes it back to the volume. So if the next run reports a sign-in error right after the smoke test, that is most likely the cause — sign in again (7.1).

The sign-in stays valid until it is revoked. Repeat it only when step 7.3 stops returning the model list. You can read the quota at any time with steps 7.2, 7.5 and 7.6, without the smoke test.

---

## 8. Stage 5 — Running the attempts

### 8.1 Dry run (uses no quota)

```bash
npm run run-matrix -- --only gemini-38-flash-high --attempts 5 --dry-run
```

It prints the Docker commands that would be run and finishes with the line `dry run complete — nothing was written.` It writes nothing. If it fails, the cause lies in the workstation setup (stages 2–4), not in the model.

### 8.2 The first configuration — 1 attempt, then 5

Recommended first configuration: `gemini-38-flash-high` (the fastest model in the matrix). The `matrix:` section of `benchmark/runner.yaml` has the full list of ids.

First **one** attempt, which goes through the whole process — scoring (stage 6), processing the results, the screenshot and the dashboard preview (stage 7) — before the next one starts:

```bash
npm run run-matrix -- --only gemini-38-flash-high --attempts 1
```

Only when that attempt has passed stages 6–7 with no issues, read the quota (7.2, 7.5, 7.6) and run the remaining four. Attempt 1 is already finished, so it will be skipped:

```bash
npm run run-matrix -- --only gemini-38-flash-high --attempts 5
```

What happens:

- The attempts run **one after another**, never in parallel. Each takes up to 32 minutes (the model has 30 minutes; after that the attempt is cut off and counts as a model failure).
- Before each attempt the program reads the quota (`/usage`) and prints it in the terminal.
- After each attempt a line such as `[gemini-38-flash-high-attempt-1] ok: … (412s, exit 0)` appears.
- The whole run ends with the line `matrix complete.`

Results:

- `eval-attempts/<configuration>-attempt-<n>/` — the application the model built (the `backend/` and `frontend/` directories). **Do not change or add anything there** — it is the material being scored.
- `eval-results/<configuration>-attempt-<n>/run.json` — the attempt's metrics (time, tokens, status).

### 8.3 Interrupting and resuming

- **Interrupting** — Ctrl+C in the terminal. It is safe: the current attempt is abandoned without being recorded. When the interruption hits a running attempt container (almost always the case), three consecutive lines confirm a clean exit: `SIGINT — <configuration>-attempt-<n> was interrupted. No run.json was written, so it is not a data point and rerunning resumes from it.`, a line about removing the container (`docker rm -f <container name> succeeded`) and `SIGINT — cleaning up before exiting; send it again to exit at once.`; `SIGTERM` and `SIGHUP` behave the same, with that signal's name. In the first seconds of an attempt, before the container starts, the first line shows `(seeding credentials)` or `(quota gate)` after the attempt name — i.e. `SIGINT — <configuration>-attempt-<n> (quota gate) was interrupted. …` — and there is no container line. An interruption during the 60-second pause before a rate-limited attempt is retried (it is preceded by the message `[<configuration>-attempt-<n>] rate limited (<reason>); sleeping 60s and retrying once.`) gives two lines: `SIGINT — cleaning up before exiting; send it again to exit at once.`, followed by `credential directory removed; rerun to resume.`. The credentials-copy directory is deleted in each of these cases; only the last case prints a separate line about it, so do not look for one in the others. If the deletion fails, a warning `could not remove the throwaway HOME … delete it by hand` appears with the path; the table row in chapter 14 says what to do.
- **A signal sent to the process alone** (`kill <pid>`) works differently from Ctrl+C or `kill %1`, which reach the whole foreground process group and so the container too: the effect shows only at the boundary between attempts — when the current container finishes, i.e. up to ~30 minutes later. Only two lines are printed then, `SIGINT — cleaning up before exiting; send it again to exit at once.` (or `SIGTERM — …`) and `credential directory removed; rerun to resume.`, with no line about an interrupted attempt. An attempt that was finishing in the meantime is recorded normally; no further ones start.
- **Resuming** — the same command as in 8.2. Finished attempts are skipped (message `skipped: … already exists`); an interrupted one, or one that failed for infrastructure reasons, runs again.
- Only **one** `run-matrix` can run at a time on the whole computer — even when the second one runs in another copy of the repository. The second one refuses to start and names the root directory of the first; this is intentional (one account, one quota).

### 8.4 Three ways an attempt can end

| Terminal message | Meaning | Action |
|---|---|---|
| `ok: …` | The model finished the task. | None. |
| `model: …` (e.g. timeout, empty directory) | The model could not handle the task. This is a **valid result**, scored 0. | None. The matrix carries on. |
| `Stopping the matrix: … failed for infrastructure reasons` | A failure on the side of the tools or the account (sign-in, quota, provider overload, Docker). **It is not a result.** | Read the cause under `stderr tail:`, fix it (table in chapter 14), and run the command again — the attempt will be repeated. |

---

## 9. Stage 6 — Scoring the attempts

Scoring is done by the `agrav-score-attempt` skill, run in Claude Code. You score **one attempt per invocation**. In order, the skill:

1. reads the attempt's `run.json`: it refuses an attempt with an infrastructure failure, and scores a model failure 0 at once;
2. runs `contract-tests` — the hidden API contract tests (58 tests in 4 files), which start the attempt's backend in the harness image and write the result to `eval-results/<configuration>-attempt-<n>/contract-results.json`; they are 7 of the 14 points;
3. installs and builds the frontend (`npm install`, `npm run build` in `frontend/`) and applies the stop rules;
4. starts the application with `serve-attempt` — the backend on port 5100, the frontend on port 5173 — and asks the human 3 questions about how it works and looks;
5. scores 3 criteria itself (frontend–API integration, code structure, tech stack and run contract), proposes a penalty (Penalty) and asks the human to confirm it — that is the fourth question;
6. stops the application (`serve-attempt --stop`) and writes the score.

> [!WARNING]
> **Security note.** Scoring installs and runs code generated by the model: the frontend directly on the computer (`npm install`, `npm run build`, `npm run dev`), the backend in a Docker container with internet access. The benchmark accepts this risk deliberately — without this step there is no way to measure whether the application works. Do the scoring on a workstation set aside for the benchmark, not on a computer holding sensitive data.

### 9.1 Starting the scoring

1. Run `claude` in the repository's root directory.
2. Check the judge model: type `/model` and choose the model that matches the `judge:` entry in `benchmark/runner.yaml` (currently Claude Opus). Scores made with a different judge are not comparable.
3. Type:

   ```
   /agrav-score-attempt gemini-38-flash-high-attempt-1
   ```

4. The skill runs the automated steps: the hidden tests and the frontend build, then starting the application (up to about 10 minutes). This usually takes a few minutes. In the worst case the hidden tests alone take 25 minutes (5 minutes to install the backend's dependencies and 20 minutes for the test files), and the frontend's `npm install` another 10 minutes — about 35 minutes in total; the frontend build itself has no time limit, so when it takes longer than 10 minutes, the skill asks whether to keep waiting. It then gives the application's address (usually `http://localhost:5173`), the list of its screens and five scenarios to check, and asks you to open the address in the browser.

If the skill refuses to score because of `failureKind: "infra"`, the attempt must be repeated (stage 5) — it is not a model result. If the model's backend or frontend cannot be installed or started, the skill applies the stop rules from `benchmark/criteria.md`: the criteria that cannot be scored get 0 with a reason, and when neither the backend nor the frontend works, every criterion gets 0. This is the correct behaviour. A failure on the side of the tools (Docker, no access to PyPI or the npm registry, a port in use) is not a result: the skill writes nothing and describes the problem.

### 9.2 The four questions for the human

Before answering, go through the five scenarios the skill lists, in the browser: navigation across the four screens; the schedule (week 2026-10-05, the "Generate plan" button); the work-order list (filters, form, error message for invalid data); the work-order details (every field, an allowed status change); the dashboard and the parts inventory. Then do the same at phone width (375 px; F12 → the phone icon) and at desktop width (1280 px or more).

| Question | 1 point | 0.5 points | 0 points |
|---|---|---|---|
| **Manual testing** — do the five scenarios work? | All five work without manually reloading the page. | Exactly one does not work or is missing; or all work, but fresh data appears only after a manual reload. | The application does not load, or two or more scenarios do not work or are missing. |
| **Consistent UI** — do the four screens look consistent? | The application's styles work on every screen, and the screens share navigation, layout, typography, colours, spacing, and button, table and form styles. | As for 1 point, with a few local deviations (e.g. one screen with its own button style, a form in the browser's default style). | Styles broken or missing on any screen, the screens look like different applications, or deviations on most screens. |
| **Responsive design** — does the application work on a phone and on a desktop? | Every screen is usable at both widths: navigation is reachable, the page does not scroll sideways (a table or timeline may scroll in its own box), forms fit. | Navigation and content of every screen are reachable at both widths, with minor problems on one or two screens (e.g. a table pushing the page sideways). | The layout does not adapt: navigation or content is cut off or unreachable, most screens scroll sideways, or there are minor problems on three or more screens. |
| **Penalty** — confirm the penalty the skill proposes? | `0` = no penalty (the usual case). | `0.5` = a flaw outside the other criteria that a user or maintainer would notice (e.g. files unrelated to the task, a README promising something that is not there). | `1` = something dangerous (e.g. an install script that does more than build, credentials written into the code). |

If the attempt's backend does not work, the skill asks about Consistent UI and Responsive design — the frontend is then scored without data — and then, in a separate question, for confirmation of the penalty (Penalty). If the frontend does not work, only the penalty question remains. When neither the backend nor the frontend works, the skill asks nothing and writes all zeros.

Rules for answering:

- Score by the definitions in the table (full wording: `benchmark/criteria.md`), not by overall impression.
- **Every score below 1 needs a one-sentence reason** in the answer field (e.g. "the timeline runs off the screen below 400 px"). A score without a reason is useless in a later audit.
- Do not skip any question or accept a score "by default" — the skill asks an unanswered question again.
- Apply the same standard to every attempt of every model.

After the answers, the skill stops the application and writes **one file**: `eval-results/<configuration>-attempt-<n>/eval-results.csv` (14 rows; next to it is `contract-results.json` from the hidden tests). Repeat steps 9.1–9.2 for the next attempts.

---

## 10. Stage 7 — Processing the results and previewing the dashboard

### 10.1 Recomputing the results

```bash
npm run process-results
```

It collects every `eval-results.csv`, `contract-results.json` and `run.json` file into `website/src/data/results.json` and `website/public/api/leaderboard.json`. It takes seconds. It fails if the hidden-test rows in `eval-results.csv` disagree with `contract-results.json` — in that case, score the attempt again (stage 6).

### 10.2 Screenshots (one-time browser setup)

```bash
npx playwright install chromium        # once per workstation
npm run screenshots -- --only gemini-38-flash-high
```

It starts each attempt of the given configuration in turn (the backend in the harness image on port 5100, the frontend on port 5173), takes a screenshot of its home page (1280×720) into `website/public/screenshots/`, and also assembles the configuration's summary strip. It takes a few minutes per attempt. An attempt that cannot be started gets an error card — this is intentional, so that every dashboard row has an image.

To retake the screenshots after a fix, add `--force`.

### 10.3 Previewing the dashboard

```bash
npm run dev
```

The dashboard opens at the address printed in the terminal (usually `http://localhost:4321`). Check that the configuration is in the table with 5 attempts, that the screenshots are there, and that the time and cost values are sensible. Stop the preview with Ctrl+C.

---

## 11. Stage 8 — Committing to the repository and publishing

### 11.1 Committing the results

```bash
git status
```

The list should contain only: the scored configuration's `eval-attempts/…` and `eval-results/…` directories, `website/src/data/results.json`, `website/public/api/leaderboard.json`, `website/public/screenshots/…`, `website/src/data/screenshot-hashes.json`. Any other change means an accidental modification and must be explained before committing.

**If certain names must never appear in the repository** (e.g. a client's or a project's), then before the first `git push` create a `.confidential-terms` file in the root directory — the restricted names, one per line; the file is in `.gitignore` and never enters the repository — and run `npm test`. The confidentiality test then scans the repository's whole history, i.e. what `git push` sends. Without that file the test looks only for secrets (tokens, keys). The `CONFIDENTIAL_TERMS` secret in CI (11.2) is a second line of defence and acts only after the push, not before.

```bash
git add eval-attempts eval-results website/src/data website/public/api website/public/screenshots
# hard and brownfield tracks: also tracks/console-hard/eval-attempts tracks/console-hard/eval-results
# or tracks/brownfield/eval-attempts tracks/brownfield/eval-results
git commit -m "Record <configuration> x 5 attempts"
git push
```

**If `git add` prints `warning: adding embedded git repository`**, the model created its own repository inside its application, which Git cannot include. Do not continue; move the hidden `.git` directory out of the scored material, into a `model-git/` directory next to the attempt's results:

```bash
mkdir -p eval-results/<configuration>-attempt-<n>/model-git
mv <path shown in the warning>/.git eval-results/<configuration>-attempt-<n>/model-git/project
```

and run `git add` again.

### 11.2 Publishing the dashboard

After a `git push` to the `main` branch, an automated process (GitHub Actions, the file `.github/workflows/publish.yml`) runs the tests, builds the dashboard and — if publishing is configured — publishes it to Cloudflare Pages. Progress is visible in the repository's **Actions** tab on GitHub.

Publishing is set up by the administrator (`website/DEPLOYMENT.md`): they create their own Cloudflare Pages project, enter its name in the repository and add two secrets, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Without them every step passes and the "Deploy" step is skipped — the results are stored in the repository and the dashboard is available locally (10.3). The optional `CONFIDENTIAL_TERMS` secret passes the list of restricted names to CI; the repository variable `REQUIRE_CONFIDENTIAL_TERMS=true` makes the "Test" step fail when that list is missing.

If you work on a separate branch, publishing happens after it is merged into `main`.

---

## 12. The full matrix — after the process is validated

Move on to the full matrix only when the first configuration has passed stages 5–8 with no issues: first one attempt, then five (8.2).

1. Read the quota (7.2, 7.5, 7.6). The full matrix needs a substantial reserve on every model; if one model's value is low, leave it out of the current run and come back after the quota resets.
2. Run the remaining configurations. One at a time is recommended, because scoring (stage 6) can then go on in parallel with the next configuration. Scoring does load the computer, though (package installs, the backend container, the frontend server), and can inflate the time recorded for the attempt running at that moment — when the times must be clean, score only after the run has finished:

   ```bash
   npm run run-matrix -- --only gemini-31-pro-high --attempts 5
   ```

   or everything at once (the remaining 20 attempts, up to about 10.5 hours; the computer must not go to sleep):

   ```bash
   npm run run-matrix
   ```

3. Score every attempt with the same judge and to the same standard (stage 6).
4. After each configuration: `npm run process-results`, screenshots, preview, commit (stages 7–8). Committing after each configuration protects the work done.

The classic track's configurations and their ids (the `matrix:` section in `benchmark/runner.yaml`; the hard and brownfield tracks have the same configurations except `gemini-38-flash-med`):

| Id | Model | Effort level |
|---|---|---|
| `gemini-38-flash-high` | Gemini 3.8 Flash | high |
| `gemini-38-flash-med` | Gemini 3.8 Flash | medium |
| `gemini-31-pro-high` | Gemini 3.1 Pro | high |
| `claude-sonnet-46-high` | Claude Sonnet 4.6 | not selectable |
| `claude-opus-46-high` | Claude Opus 4.6 (Thinking) | not selectable |

---

## 13. The hard and brownfield tracks

Both tracks go through the same stages 5–8 as the classic track, with the same image, sign-in and rules (chapter 15). They differ in their commands and in where the results go:

| | Classic track | Hard track | Brownfield track |
|---|---|---|---|
| Task | `prompt.md` | `tracks/console-hard/prompt.md` — a bigger planner: crews, travel, splitting and preemption of work orders | `tracks/brownfield/prompt.md` — changing the existing application in `tracks/brownfield/base/` |
| Points | 14 | 19 | 12 |
| Matrix | `benchmark/runner.yaml` | `benchmark/runner-hard.yaml` | `tracks/brownfield/benchmark/runner.yaml` |
| Model time limit | 30 min | 45 min | 30 min |
| Attempts and results | `eval-attempts/`, `eval-results/` | `tracks/console-hard/eval-attempts/`, `…/eval-results/` | `tracks/brownfield/eval-attempts/`, `…/eval-results/` |
| Scoring skill | `agrav-score-attempt` | `agrav-score-hard` | `agrav-score-brownfield` |

**Running the attempts** (first `--dry-run`, then 1 attempt, then 5 — as in 8.1–8.2):

```bash
# hard track
npm run run-matrix -- --root tracks/console-hard --config benchmark/runner-hard.yaml --only gemini-38-flash-high --attempts 1
# brownfield track
npm run run-matrix -- --root tracks/brownfield --base tracks/brownfield/base --only gemini-38-flash-high --attempts 1
```

In the brownfield track each attempt starts from a copy of the base, and the model modifies it. An attempt in which the model changed nothing against the base is a model failure (in `run.json`: `"noDiffFromBase": true`) and gets 0.

**Scoring** — in Claude Code, one attempt per invocation:

```
/agrav-score-hard gemini-38-flash-high-attempt-1
/agrav-score-brownfield gemini-38-flash-high-attempt-1
```

The hard-track skill runs the hidden contract tests and the in-browser E2E tests itself (`scripts/score-hard.ts`), scores the three agent criteria, and asks the human about the look (Visual design) and to confirm the penalty. The brownfield-track skill runs the base's regression tests, the change tests, the diff-locality check and the model's own tests, and asks the human about the look (Visual design) and to confirm the penalty.

**Processing the results and screenshots:**

```bash
npm run process-results:hard
npm run screenshots:hard -- --only gemini-38-flash-high
npm run process-results:brownfield
npm run screenshots:brownfield -- --only gemini-38-flash-high
```

The dashboard (`npm run dev`) has a track switcher; each track has its own results table.

---

## 14. Troubleshooting

| Symptom | Cause | Action |
|---|---|---|
| `Cannot find package 'tsx'` on any `npm run …` | `npm install` was not run in this clone. | `npm install`, then repeat. |
| `sh: 1: astro: not found` | The dashboard's dependencies are not installed. | `npm install` in the root directory (it installs `website/` too). |
| `docker run … --pull never` reports a missing image (e.g. `No such image`) | The harness image is not built on this computer; `--pull never` deliberately does not download it from the internet. | Stage 3 (chapter 6). |
| `cp: cannot stat …` in step 7.2 | There is no sign-in on the `agy-creds` volume. | 7.6, then stage 4 from 7.1. |
| `--models` returns `Please sign in` | The sign-in was not completed or has expired. | 7.6, then stage 4 from 7.1. |
| `--usage` shows a sign-in URL and waits 60 s | As above. | Ctrl+C, 7.6, stage 4. |
| `Stopping the matrix … authentication` | The credentials on the volume are out of date. | Stage 4, then rerun `run-matrix`. |
| `Stopping the matrix … quota` / `rate limit` | The weekly quota for this model is used up. | Wait for the reset; run other configurations with `--only`. |
| `Stopping the matrix … high traffic` | Overload on the model provider's side. | Wait a few minutes and rerun — the attempt repeats automatically. |
| `Stopping the matrix … soft-deny` | A tool was blocked inside `agy`. | Report it to the administrator; do not score this attempt. |
| `run-matrix` refuses to start: lock | Another run is in progress (the message gives its `pid` and root directory — it may be another copy of the repository), or the previous one was killed without cleaning up. | Check that no second terminal is running it; if none is, delete the lock file named in the message, `agrav-bench-run-matrix-agy-creds.lock` in the temporary directory (`$TMPDIR`, or `/tmp` when it is not set), and retry. The lock covers only that one directory: two shells with different `$TMPDIR` values have two different locks, and both runs will start. `run-matrix` takes over a lock left behind by `SIGKILL` on its own. |
| Warning `could not remove the throwaway HOME … delete it by hand` | The temporary directory holding the token was not deleted. | Delete that directory immediately (`rm -rf <path>`); it holds the account's live token. |
| Scoring skill: `port 5100 is already in use` or `ports 5100 and 5173 are already in use` | Another program is using the port. | Close the program using the port and tell the skill the port is free. |
| Scoring skill: the frontend does not start on the first try | `serve-attempt` retries starting the frontend server once by itself; only a failed retry is a stop rule. | None — wait for the skill's result. |
| `npm run process-results` fails with an error about hidden-test rows | The attempt's `eval-results.csv` disagrees with its `contract-results.json`, or that file is missing. | Score the attempt again (stage 6). |
| Image build: `sha512sum` / `404` error | The vendor withdrew the pinned `agy` version. | Administrator (chapter 6). |
| `git status` shows modified `results.json` and `leaderboard.json` with no new scores | Timestamps from the last `npm run build`; `process-results` writes both files. | `git checkout website/src/data/results.json website/public/api/leaderboard.json`. |
| Terminal closed between steps 7.2 and 7.6 (or the `$SMOKE` variable lost) | The credentials copy with a live token was left in the system temporary directory (`$TMPDIR`, or `/tmp` when it is not set). | Find it and delete it — see the block below the table. |

**An abandoned credentials copy.** The directory from step 7.2 is created by `mktemp -d`, so it sits under a random name in the system temporary directory: `$TMPDIR`, or `/tmp` when that variable is not set (on macOS `$TMPDIR` is always set). If the terminal was closed before step 7.6, the directory with the live token is still on disk. The command below searches exactly that directory, prints **only paths** — it shows the contents of no file — and looks only for directories owned by the current user:

```bash
find "${TMPDIR:-/tmp}" -maxdepth 4 -type d -user "$(id -un)" -path '*/home/.gemini/antigravity-cli' 2>/dev/null
```

Each printed path ends in `tmp.XXXXXXXX/home/.gemini/antigravity-cli`. What you delete is the part before `/home/` — `<directory>` below; on macOS it is not under `/tmp` but wherever `$TMPDIR` points. First check that directory's owner and creation time:

```bash
ls -ld "<directory>"
```

It must belong to the current user and come from their own session. Only after looking at the output, delete **that one** directory — never the whole temporary directory or a path that was not on the printed list:

```bash
rm -rf "<directory>"
```

In both commands, replace `<directory>` with the path printed by `find`, minus the `/home/.gemini/antigravity-cli` ending; a command pasted without the replacement deletes nothing.

No output means there is no copy in the temporary directory that was searched.

---

## 15. Rules that must not be broken

```items
- **R1** **Do not change the contents of `eval-attempts/`.** No fixes to the model's code, no added files. A change invalidates the attempt.
- **R2** **Do not edit `eval-results.csv` or `contract-results.json` by hand.** Changing a score requires rerunning the skill.
- **R3** **One `run-matrix` at a time.** One account, one quota.
- **R4** **Sign in to Antigravity only inside the container (7.1).** Never through `agy` on the computer, never by mounting the computer's `~/.gemini` directory.
- **R5** **The same judge and the same criteria for every attempt.** Changing the judge model, the `agy` version or the rubric id (`rubric:` in `benchmark/runner.yaml`) starts a new, incomparable series.
- **R6** **An infrastructure failure is not a result.** An attempt cut short by the quota, the sign-in or the provider is repeated, not recorded as 0.
- **R7** **First one attempt, then one configuration through the whole process, then the rest.** Read the quota before each of these steps (7.2, 7.5, 7.6).
- **R8** **At most 12 attempts per configuration.** A limit of the screenshot strip; the standard is 5.
```

---

## 16. Completion checklist

A configuration is complete when every item is met:

- [ ] 5 directories `eval-attempts/<configuration>-attempt-1…5/`
- [ ] 5 files `eval-results/<configuration>-attempt-<n>/run.json`, none with `"failureKind": "infra"`
- [ ] A file `eval-results/<configuration>-attempt-<n>/contract-results.json` for every attempt that is not a model failure
- [ ] 5 files `eval-results/<configuration>-attempt-<n>/eval-results.csv`; every score below 1 has a reason in the `Notes` column
- [ ] `npm run process-results` run; the configuration visible in the dashboard preview with 5 attempts
- [ ] 5 screenshots and the summary strip in `website/public/screenshots/`
- [ ] Changes committed (`git commit`) and pushed (`git push`)
- [ ] The run in the Actions tab finished green (if publishing is configured)
- [ ] The quota readings before and after recorded in your notes

A track is complete when the list is met for every configuration in its matrix (`matrix:` in the track's runner), and the dashboard preview shows each of them with 5 attempts.

---

## 17. Source documents

| Document | Contents |
|---|---|
| `README.md` | Technical description of the project, scripts, the fallback procedure for `agy` |
| `prompt.md` | The task every model gets |
| `benchmark/criteria.md` | The full definition of the 14 scoring rows, the stop rules and the score thresholds |
| `tracks/console-hard/benchmark/criteria.md`, `tracks/brownfield/benchmark/criteria.md` | The same for the hard and brownfield tracks |
| `benchmark/runner.yaml` | The configuration matrix, the judge, the rubric id, the time limits |
| `images/harness/IMAGE.md` | What the harness image contains and how to check it |
| `.claude/skills/agrav-score-attempt/SKILL.md` | The judge's procedure step by step (hard and brownfield tracks: `agrav-score-hard`, `agrav-score-brownfield`) |
| `website/DEPLOYMENT.md` | Publishing setup (administrator) |
