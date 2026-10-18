# Harness image provenance

- **Build date:** 2026-10-04
- **Tag:** `agrav-bench/harness:2026-10-04`
- **Local image Id:**
  `sha256:c17480130daaf9571b25568faa348dbaea58e9bfc094061d7d693044d4579442`
  (from `docker image inspect -f '{{.Id}}' agrav-bench/harness:2026-10-04`)

Rebuilt on 2026-10-04 for brownfield track support (P3):
`run-attempt` now supports the `--no-new-project` flag for brownfield workspace mode
(omits `--new-project` when launching `agy -p "$PROMPT"` so `agy` runs on an existing
project directory). Dockerfile unchanged apart from the build-command comment; agy is still pinned to 1.2.7.

The base image `node:22-bookworm-slim` and the apt packages may have moved on in the rebuild.
Versions in the new image:
- `agy --version`: 1.2.7
- `python3 --version`: Python 3.11.2
- `node --version`: v22.23.2

## Image 2026-09-19

- **Build date:** 2026-09-19
- **Tag:** `agrav-bench/harness:2026-09-19`
- **Local image Id:**
  `sha256:b081f59c89cbca82835393ccbf7035cbf8dd9ab751dce4a4c14fc4e4b6d04b5c`
  (from `docker image inspect -f '{{.Id}}' agrav-bench/harness:2026-09-19`)

Rebuilt on 2026-09-19 for one change: **agy 1.1.26 -> 1.2.7** (build
`6731160148115456`). Nothing else in the Dockerfile or `run-attempt` changed.
Checked against the new binary, signed in on a fresh `agy-creds` volume:

- `agy --output-format json models` lists the same four matrix models
  (`gemini-3.8-flash-high`, `gemini-3.1-pro-high`, `claude-sonnet-4-6`,
  `claude-opus-4-6-thinking`), plus `gemini-3.6-flash-*`, which `docs/PLAN.md`
  already lists on 1.1.26 and is not new here.
- `--effort` rules are unchanged: `gemini-3.8-flash-low --effort high` and
  `claude-sonnet-4-6 --effort high` both exit 1 with the same `ERROR` messages.
- The envelope has the same fields (`status`, `response`, `duration_seconds`,
  `usage.thinking_tokens` <= `output_tokens`). A models call adds a `command`
  object; a run does not.
- A run authenticates from a throwaway `HOME` holding only
  `.gemini/antigravity-cli/antigravity-oauth-token` and `installation_id`
  (copied with `cp --parents`), though sign-in now writes many more files
  (`builtin/skills/`, `bin/webm_encoder`, `conversation_summaries.db`, ...).
- `/usage` prints the same per-model table; the Claude rows are now labelled
  `Claude Sonnet 4.6 (Thinking)`.

Measured on 1.2.7 on 2026-09-19 (plan 3, gates 3b and 4), through the matrix's
own credential copy into a throwaway `HOME`: a `-p` run as the host uid left
only host-owned files; no `soft-deny` on stderr; `agy --version` still 1.2.7
afterwards, so the root-owned binary still defeats the self-updater; and
`TIMEOUT=30m` (`--print-timeout 30m`) was accepted. Gate 0 in the same
session: agy refreshed the token, the stored one being more than an hour old.
The first agy call in the throwaway `HOME` (`--models`) changed it; the `-p`
run and `--usage` after it did not (docs/DECISIONS.md, R46). That was one short
call. Not re-measured: the updater after a task-length run, and the cost
assumptions on a task-sized envelope; the first real attempts' `run.json`
files will show both. Every `run.json` records `agyVersion`, so runs on 1.1.26
and 1.2.7 are different eras and must not be compared.

Rebuilt on 2026-09-18 for one Dockerfile change: **Python joins the image.**
The maintenance-console task has a Python 3.11 / FastAPI backend, and its
hidden contract tests run each attempt's backend in this image, in a fresh
venv built as the host uid. `python3`, `python3-venv` and `python3-pip` join
the existing apt layer, with `--no-install-recommends`:

- `python3-venv` is what `python3 -m venv` needs (ensurepip and its bundled
  pip). Inside a venv, the venv's own pip is used, not the system one.
- `python3-pip` is not on the scoring path. It is there so that, in the
  model's own session, a bare `pip install` fails with the PEP 668
  "externally managed" error that `prompt.md` promises, rather than with
  "pip: command not found".
- `--no-install-recommends` leaves out `build-essential` and `python3-dev`, so
  the image has **no C compiler**. A requirement that has no cp311 manylinux
  wheel and needs a C compiler to build fails, both in the model's session
  and when scoring, so it fails the same way in both. Pure-Python packages
  are unaffected: a `py3-none-any` wheel, or an sdist with no native
  extension, installs without a compiler.

Nothing else changed: same agy 1.1.26 tarball as that build, and
`run-attempt` is unchanged.

## Previous images

- `agrav-bench/harness:2026-09-19`
  (`sha256:b081f59c89cbca82835393ccbf7035cbf8dd9ab751dce4a4c14fc4e4b6d04b5c`):
  agy 1.2.7 upgrade. Used for classic and hard track benchmark executions.
- `agrav-bench/harness:2026-09-18`
  (`sha256:794921a17374a821673f7c5acad34014e46eafa6137a9bb1bec2fb0b3b30b251`):
  agy 1.1.26 with Python added. Only synthetic scoring runs used it.
- `agrav-bench/harness:2026-09-05`
  (`sha256:eeac6b0de11287f40e40fbd7eae6a495441d1689f680d11c12474fe7eaae71fa`):
  `--effort` made optional in `run-attempt`, after Phase 0 sign-in showed that
  agy 1.1.26 rejects the flag outright for `claude-sonnet-4-6`,
  `claude-opus-4-6-thinking` and `gpt-oss-120b-medium`
  (`--effort is not supported for model "…"`, exit 1). Every run of the old
  task records this Id in its `run.json`. It is no longer on the daemon, so
  the 2026-09-18 image is built from scratch and nothing can stand in for the
  agy tarball; its URL is checked before the build (see Rebuilding).
- `agrav-bench/harness:2026-09-04`
  (`sha256:916ace98438349506d21addf754f5a8ae4fae7a2e432ab05f232866a2ad31261`):
  no attempt was ever run against it.

A locally built image has no repository digest (nothing was pushed to a
registry). `runner.yaml` pins the tag above; `run-matrix.ts` resolves and
records this image Id at run time instead (Ruling P10), and the scoring tools
read the same tag through `readScoringImage()`.

## Base image and toolchain

- **Base:** `node:22-bookworm-slim`, a floating tag in the Dockerfile. The
  build uses the base already on the daemon (no `--pull`), measured on
  2026-09-18 before the build:
  - repo digest
    `node@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5`
    (`docker image inspect node:22-bookworm-slim --format '{{json .RepoDigests}}'`)
  - local Id `sha256:6e6261159fd399ebe5a3d556b7d89da9c85c873f3f270918aad6c8107da8b411`,
    created 2026-08-25, `amd64`
  - Node `v22.23.2` (`docker run --rm node:22-bookworm-slim node --version`)
  - Debian `12.15` (`/etc/debian_version`); no `python3` in the base
- **Python:** `Python 3.11.2` (bookworm's `python3`)
- **pip (system `python3-pip`):** `pip 23.0.1`
  (`from /usr/lib/python3/dist-packages/pip (python 3.11)`)
- **pip (inside a fresh venv):** `pip 23.0.1`
  (`from /scoring/venv/lib/python3.11/site-packages/pip (python 3.11)`)

Measured on 2026-09-18 after that build (image Id in "Previous images"): `agy --version`
1.1.26; Node `v22.23.2` and the base repo digest above, both unchanged. The
venv check (under Rebuilding) ran as the host uid: `python3 -m venv` exited 0,
and the venv's pip installed fastapi 0.115.14 and uvicorn 0.30.6; of the
2,615 files under the scratch directory, 0 were not owned by the host uid.
The scratch directory was removed afterwards and no container was left
behind. The no-compiler check, run the same day against the tag with each of
`cc`, `gcc` and `c++` looked up separately, printed nothing (a control run
of the same loop over `sh python3 cc` printed the first two paths, so the
loop does report what it finds).

## agy pin

- **Version:** 1.2.7
- **Build:** 6731160148115456
- **Manifest url:**
  `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_amd64.json`
  — fetched live on 2026-09-04 and matched the plan's pinned constants
  exactly (no drift).
- **Manifest, re-fetched 2026-09-19:** `version` 1.2.7, the url below and the
  sha512 below.
- **Tarball url:**
  `https://storage.googleapis.com/antigravity-public/antigravity-cli/1.2.7-6731160148115456/linux-x64/cli_linux_x64.tar.gz`
  — downloaded 2026-09-19: 61,763,170 bytes, sha512 matches. The sha512 below
  is what the build verifies.
- **sha512:**
  `fec769d611c4afdf0ae72d38bdb2652c8e2c8e71e4f6de97a27b80dda3c50429160d9e03776a36a59b8857c20e76783c4a49cb0feb8b2f5c3bf925b0cc03bb77`
- **Tarball internal layout:** verified by downloading the tarball once and
  running `tar -tzf`. It contains a single top-level member named
  `antigravity` — matching the plan's assumption exactly. No change was
  needed to the extraction command
  (`tar -xzf /tmp/agy.tgz -C /usr/local/bin antigravity`).

## Known agy CLI quirk found during verification

`agy models --output-format json` (flag *after* the subcommand, as the
plan's prose describes it) fails with `Error: flags provided but not
defined: -output-format` — the `models` subcommand's own `--help` lists
only `-h`/`--help`. The global `--output-format` flag has to precede the
subcommand: `agy --output-format json models`. `run-attempt --models` uses
the working form; see the comment at its call site.

## Review round 1 fixes (image Id changed)

Made for the 2026-09-04 build; `run-attempt` has not changed since, so both
still hold. Code review found two issues in `run-attempt`, both fixed and
re-verified before that Id was recorded:

- A recognized flag given without its value (e.g. `--model` as the last
  token) crashed with bash's `set -u` "unbound variable" error (exit 1,
  outside the documented exit-code set) instead of a clean usage error.
  Each of the three value-taking branches (`--model`, `--effort`,
  `--prompt-file`) now checks `$# -ge 2` first and falls through to the
  same `usage`/exit-2 path as the script's other validation errors.
- The final `case "$MODE" in … esac` had no `*)` default arm; added
  `*) usage ;;` so a future mode-setting flag added without its case arm
  fails loudly instead of falling through to exit 0.

## Brownfield support (`--no-new-project`)

Added for the brownfield track (P3): `run-attempt` supports `--no-new-project`
to omit `--new-project` when launching `agy -p "$PROMPT"`. This allows `agy` to run on an
existing project directory seeded in `/workspace` instead of initializing a brand new project.
In classic greenfield runs without this flag, `--new-project` continues to be passed.

## Rebuilding

The build and the checks after it need network: apt, the agy tarball, PyPI.

```
curl -fsSI https://storage.googleapis.com/antigravity-public/antigravity-cli/1.2.7-6731160148115456/linux-x64/cli_linux_x64.tar.gz
docker build -t agrav-bench/harness:2026-10-04 images/harness
```

Then record the image Id above, and check that the base's repo digest is still
the one under "Base image and toolchain" (record the new one if it is not).

Verify, and record the versions above:

```bash
TAG=agrav-bench/harness:2026-10-04
docker image inspect -f '{{.Id}}' "$TAG"
docker run --rm --pull never --entrypoint python3 "$TAG" --version          # Python 3.11.x
docker run --rm --pull never --entrypoint agy "$TAG" --version              # 1.2.7
docker run --rm --pull never --entrypoint python3 "$TAG" -m pip --version   # system pip
docker run --rm --pull never --entrypoint pip3 "$TAG" install fastapi       # must fail: externally-managed-environment
# must print nothing: no compiler. One name per `command -v`: the image's sh is
# dash, whose `command -v` looks only at its first operand.
docker run --rm --pull never --entrypoint sh "$TAG" -c 'for c in cc gcc c++; do command -v "$c"; done'

# A venv and a pip install as the host uid leave only host-owned files.
S=$(mktemp -d) && mkdir "$S/home"
RUN=(docker run --rm --pull never --user "$(id -u):$(id -g)" -e HOME=/scoring/home -w /scoring -v "$S":/scoring)
"${RUN[@]}" --entrypoint python3 "$TAG" -m venv /scoring/venv
"${RUN[@]}" --entrypoint /scoring/venv/bin/pip "$TAG" install fastapi==0.115.14 uvicorn==0.30.6
"${RUN[@]}" --entrypoint /scoring/venv/bin/pip "$TAG" --version   # venv pip
find "$S" ! -uid "$(id -u)"                                        # must print nothing
rm -rf "$S"
```

`-w /scoring` because the image's `WORKDIR /workspace` is root-owned and only
the attempt container mounts over it.

Re-verify the manifest and tarball layout (steps above) before bumping
`AGY_VERSION`/`AGY_BUILD`/`AGY_SHA512` — the sha512 check in the Dockerfile
will fail closed if they don't match what's actually served.
