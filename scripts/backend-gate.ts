/**
 * Gate 3a of the maintenance-console design: prove the scoring infrastructure
 * on synthetic attempts, spending no quota.
 *
 *   npm run gate:backend                                    # every part; records the result
 *   npm run gate:backend -- --only image --only contract    # some parts; records nothing
 *
 * Parts, in this order, each selectable with a repeatable `--only <part>`:
 *
 * - `image`: the harness image named by `benchmark/runner.yaml` exists; inside
 *   it — entrypoint overridden, in named and labelled containers whose removal
 *   is verified — `python3 --version` is 3.11 and `agy --version` is the
 *   Dockerfile's `ARG AGY_VERSION` pin;
 *   and a venv plus a `pip install` of one small pinned package, run as the
 *   host uid into a host scratch directory, leave only files the host uid owns.
 * - `contract`: the reference backend through `contract-tests` scores 58/58
 *   (24/12/11/11, rows 2/2/1/2), with the image and rubric id it should
 *   record, and `contract-results --rows` prints those four rows; the
 *   `hardcoded_plan` mutant scores exactly what plan 1 measured on the host.
 * - `stops`: one small app per backend stop — `layout`, `install`, `boot`,
 *   `health` — is written as that stop with all four rows 0, and an app whose
 *   `POST /reset` answers 500 as `diagnosis: "reset-broken"`.
 * - `serve`: the reference plus a zero-dependency frontend through
 *   `serve-attempt` — ready, both halves ok, both ports answering — and
 *   `serve-attempt --stop` leaves nothing behind.
 * - `screenshots`: `take-screenshots` photographs that attempt: a 1280x720 PNG.
 * - `fuzz`: the console-fuzz track, copied into the gate's own root (a track
 *   root mirrors the repository root, Ruling H2) and checked byte for byte
 *   against the repository's own copy, scored through `contract-tests-hard`
 *   — its first run against a real container. The reference scores the
 *   manifest's max; `hardcoded_plan`'s per-stratum failures must equal gate
 *   P2-B's own record, stratum by stratum, which is what shows the container
 *   path tells backends apart rather than merely running. Every number it
 *   expects is read from that record; none is typed here. The copy is
 *   ungated by design — gate P2-B vouches for the repository's files, not
 *   for a copy of them — which is exactly why the byte-for-byte check is
 *   this part's own job, not something the `oracle`/`ungated` fields of a
 *   `contract-tests-hard` run could stand in for.
 *
 * Every part drives the CLIs the scoring skill drives — `node --import tsx
 * scripts/<cli>.ts`, as child processes, with `--ignore-run-json` — against a
 * temporary `--root` holding `eval-attempts/<dir>/` and `eval-results/<dir>/`.
 * The reference is staged there as spec §7 says: its `app/` and
 * `requirements.txt` copied into `<attempt>/backend/`, `seed.json` beside them,
 * and the copy's empty `app/__init__.py` replaced with one that sets
 * `REFERENCE_SEED_PATH` (and, for the mutant, `REFERENCE_MUTANT`) — the
 * fixture itself is a gate-2 input and is never edited, and the backend
 * runner passes the container no extra variable.
 *
 * Preconditions, checked before any part starts: ports 5100 and 5173 free
 * when `serve` or `screenshots` will run (the run contract's ports: nothing
 * here works around a taken one), Playwright's Chromium when `screenshots`
 * will — launched once as take-screenshots launches it, and closed — and the
 * image on the daemon. After every part, and once more at the
 * end: no container labelled with the gate's pid or one of its children's,
 * no scratch directory of theirs in the temp directory, and no dead-owner
 * sweep line in a child's output naming one of them. The check runs after
 * each part, not only at the end, because `serve-attempt` and
 * `take-screenshots` start with that sweep: by the end it would have removed,
 * unseen, whatever an earlier part's children left. At the end, too — when
 * `serve` or `screenshots` ran — 5100 and 5173 free again. The verdict is
 * decided first, the record's own conditions included; then the temporary
 * root is removed when everything passed, and kept, with its path printed,
 * when something did not.
 *
 * A complete passing run (no `--only`) writes gate-3-result.json, which
 * `npm test` checks against the current files (see `GATE_3_INPUTS` in
 * scripts/lib/gate-fingerprint.ts). Needs Docker with the harness image
 * built, network for pip and npm, and ports 5100 and 5173 free.
 *
 * Signal-sensitive: it owns child processes, and in `image` containers of its
 * own. Invoke it as `node --import tsx scripts/backend-gate.ts`, never through
 * the tsx bin. The children run detached, so an operator's Ctrl-C reaches the
 * gate alone and each child gets exactly one SIGTERM from it — a second
 * signal would make a child exit without removing what it started. A first
 * signal stops the running child that way and waits for it, runs
 * `serve-attempt --stop` if a serve state file is left, removes the gate's
 * own containers and the temporary root, and exits 128+N. A second exits at
 * once: a child not yet signalled gets its SIGTERM (and tears itself down
 * after the gate is gone), every container labelled with the gate's or a
 * child's pid and one of its attempts is removed with a synchronous `docker
 * rm -f`, and the temporary root goes. A SIGKILLed gate leaves a running
 * child behind; the temporary root it printed at start is what
 * `serve-attempt --stop --root <path>` needs. The handlers are installed
 * before the preconditions, so a signal during the Chromium check closes that
 * browser and starts no part. Importing this module installs nothing; `main`
 * does.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { parse as parseCsv } from "csv-parse/sync";

import { BACKEND_ROLE, FREEZE_TIMEOUT_MS, PROBE_REQUIREMENT, VENV_TIMEOUT_MS } from "./lib/attempt-backend";
import { CONTRACT_RESULTS_FILE, loadManifest, parseContractResults, type BootStage, type ContractResults, type ManifestEntry } from "./lib/contract-results";
import { busyPorts, groupAlive, KILL_WAIT_MS } from "./lib/dev-server";
import {
  DOCKER_CLI_TIMEOUT_MS,
  defaultDockerRun,
  ensureContainerRemoved,
  LABEL_ATTEMPT,
  LABEL_OWNER,
  LABEL_ROLE,
  resolveImageId,
  SCRATCH_DIR_RE,
  scratchDirPrefix,
  scratchDirsOwnedBy,
  userSpec,
} from "./lib/docker";
import { FUZZ_GATE_RESULT_PATH, GATE_3_RESULT_PATH, gate3Fingerprint, type FuzzGateResult, type Gate3Result } from "./lib/gate-fingerprint";
import { HARD_LIMITS, HARD_RESULTS_FILE, loadHardManifest, parseHardResult, type HardResult } from "./lib/hard-contract-results";
import { installInterruptHandlers, type InterruptHandlers } from "./lib/interrupt";
import { HIDDEN_ROWS, LIMITS, rubricId } from "./lib/rubric";
import { readScoringImage } from "./lib/runner-config";
import { BACKEND_PORT, FRONTEND_PORT, readServeState, STOP_WAIT_MS, statePath, type ServeState } from "./serve-attempt";

/** This repository: the CLIs, the fixtures, the image tag and where the result is recorded. */
export const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

export const PARTS = ["image", "contract", "stops", "serve", "screenshots", "fuzz"] as const;
export type Part = (typeof PARTS)[number];

// ---------------------------------------------------------------------------
// what the gate expects

/** `python3 --version` inside the image: bookworm's Python. */
export const PYTHON_VERSION_RE = /^Python 3\.11\./;
/**
 * What `agy --version` inside the image must contain: the `ARG AGY_VERSION=`
 * pin in images/harness/Dockerfile, read rather than copied so an image bump
 * cannot leave the gate expecting the old release. Throws when the line is
 * missing or appears more than once.
 */
export function pinnedAgyVersion(repoRoot: string): string {
  const path = join(repoRoot, "images", "harness", "Dockerfile");
  const pins = [...readFileSync(path, "utf8").matchAll(/^ARG AGY_VERSION=(\S+)\s*$/gm)].map((m) => m[1]);
  if (pins.length === 0) throw new Error(`${path}: no \`ARG AGY_VERSION=<version>\` line`);
  if (pins.length > 1) throw new Error(`${path}: ${pins.length} \`ARG AGY_VERSION=\` lines (${pins.join(", ")}), expected one`);
  return pins[0];
}
/** The image part's `pip install`: one small pure-Python wheel, pinned. */
export const PIP_PACKAGE = "six==1.16.0";
/** The module that package installs, which the ownership check also looks for. */
const PIP_PACKAGE_FILE = "six.py";

/** The mutant staged beside the reference. */
export const MUTANT = "hardcoded_plan";

export interface FileExpectation {
  file: string;
  total: number;
  passed: number;
  score: number;
}

/** The reference backend: every test of every file passes; each row gets its max. */
export const REFERENCE_EXPECTED: readonly FileExpectation[] = Object.freeze([
  { file: "api-contract.test.ts", total: 24, passed: 24, score: 2 },
  { file: "planner-assignment.test.ts", total: 12, passed: 12, score: 2 },
  { file: "planner-ordering.test.ts", total: 11, passed: 11, score: 1 },
  { file: "planner-parts.test.ts", total: 11, passed: 11, score: 2 },
]);

/**
 * `hardcoded_plan`, the reference replaying the memorised seed plan. The
 * per-file counts are plan 1's measurement on the host
 * (docs/superpowers/plans/2026-09-18-maintenance-console/01-task-and-hidden-tests.md,
 * "Measured effect": 0/12, 1/11 and 2/11 on the planner files, 0.45 of the 5
 * planner points; the API file passes whole, since gate 2 fails any mutant
 * that does not own it and fails it), as spec §7 3a restates them: `API
 * contract` 2, assignment 0, ordering 0.09, parts 0.36. Asserted as
 * constants because gate 2 records no per-file counts; here they run in the
 * image, through the same CLI an attempt is scored with.
 */
export const HARDCODED_PLAN_EXPECTED: readonly FileExpectation[] = Object.freeze([
  { file: "api-contract.test.ts", total: 24, passed: 24, score: 2 },
  { file: "planner-assignment.test.ts", total: 12, passed: 0, score: 0 },
  { file: "planner-ordering.test.ts", total: 11, passed: 1, score: 0.09 },
  { file: "planner-parts.test.ts", total: 11, passed: 2, score: 0.36 },
]);

export interface StopCase {
  /** A directory under test/fixtures/backend-gate/, copied as the attempt. */
  fixture: string;
  attempt: string;
  stage: BootStage;
}

/** One small app per backend stop (spec §5, "Failure taxonomy"). */
export const STOP_CASES: readonly StopCase[] = Object.freeze([
  { fixture: "stop-layout", attempt: "gate-stop-layout-attempt-1", stage: "layout" },
  { fixture: "stop-install", attempt: "gate-stop-install-attempt-1", stage: "install" },
  { fixture: "stop-boot", attempt: "gate-stop-boot-attempt-1", stage: "boot" },
  { fixture: "stop-health", attempt: "gate-stop-health-attempt-1", stage: "health" },
]);

export const RESET_BROKEN = Object.freeze({ fixture: "reset-broken", attempt: "gate-reset-broken-attempt-1" });
export const REFERENCE_ATTEMPT = "gate-reference-attempt-1";
export const MUTANT_ATTEMPT = "gate-hardcoded-plan-attempt-1";
export const SERVE_ATTEMPT = "gate-serve-attempt-1";
/** `take-screenshots --only` takes the benchmark id, not the directory. */
export const SERVE_BENCHMARK_ID = "gate-serve";
/** Where take-screenshots writes that attempt's picture, under the root. */
export const SCREENSHOT_PATH = join("website", "public", "screenshots", `${SERVE_ATTEMPT}.png`);
export const SCREENSHOT_SIZE = Object.freeze({ width: 1280, height: 720 });

/** The backend runner's install at its worst: the venv, `pip install`, the PyPI probe after it, `pip freeze`. */
const INSTALL_WORST_MS = VENV_TIMEOUT_MS + LIMITS.pipInstallMs + LIMITS.pypiProbeMs + FREEZE_TIMEOUT_MS;
/**
 * An attempt served at its worst, as `serve-attempt` and `take-screenshots`
 * serve it: the install, the health wait, the frontend's `npm install` and the
 * `npm ping` after a failed one, and every dev-server start. About 23 min.
 */
const SERVE_WORST_MS =
  INSTALL_WORST_MS +
  LIMITS.healthMs +
  LIMITS.npmInstallMs +
  LIMITS.registryProbeMs +
  (LIMITS.devServerRetries + 1) * LIMITS.devServerStartMs;
/**
 * A `contract-tests` run: the install, then the overall guard over the files
 * (which covers their starts, health waits and removals) — about 29 min at
 * its worst — and 5 min for its teardown.
 */
export const CONTRACT_CHILD_MS = INSTALL_WORST_MS + LIMITS.overallMs + 5 * 60_000;
/** A `contract-tests-hard` run: the same shape, over the fuzz's own (larger) overall budget. */
export const HARD_CONTRACT_CHILD_MS = INSTALL_WORST_MS + HARD_LIMITS.overallMs + 5 * 60_000;
const ROWS_CHILD_MS = 60_000;
/** From `serve-attempt`'s start to `status: "ready"`: its worst legitimate path, and 2 min. */
export const SERVE_READY_MS = SERVE_WORST_MS + 2 * 60_000;
const SERVE_POLL_MS = 500;
/**
 * `serve-attempt --stop`: up to `STOP_WAIT_MS` (about 90 s) waiting for a live
 * owner, then its cleanup after an owner that left its file — the group killed
 * and waited for, the container removed and inspected — and 1 min.
 */
export const STOP_CHILD_MS = STOP_WAIT_MS + KILL_WAIT_MS + 2 * DOCKER_CLI_TIMEOUT_MS + 60_000;
const SERVE_EXIT_MS = 60_000;
/** One attempt's capture: served at its worst, then Chromium, the page load (30 s), the picture and the filmstrip, in 5 min. */
export const SCREENSHOTS_CHILD_MS = SERVE_WORST_MS + 5 * 60_000;
/** After SIGTERM, how long a child gets to remove what it started before its group is SIGKILLed. */
const CHILD_TERM_WAIT_MS = 90_000;
/** After a child's `exit`, how long its pipes may stay open before they are closed from this side. */
const CLOSE_AFTER_EXIT_MS = 5_000;
/** `python3 --version`, `agy --version`. */
const IMAGE_QUICK_MS = 60_000;
/** The `exit` listener's one `docker ps` and each `docker rm -f`: it runs after "exit now", so it is kept short. */
const EXIT_DOCKER_LIST_MS = 5_000;
const EXIT_DOCKER_RM_MS = 10_000;
const HTTP_MS = 10_000;
/** How much of a child's stdout and stderr is kept, each. */
const OUTPUT_KEEP_CHARS = 1024 * 1024;
/** How much of a failed child's stderr its FAIL line quotes: the last lines, cut to this many characters from the end. */
const STDERR_QUOTE_LINES = 5;
const STDERR_QUOTE_CHARS = 600;

const FIXTURES_DIR = join("test", "fixtures", "backend-gate");
const REFERENCE_DIR = join("test", "fixtures", "reference-backend");
const SEED_FILE = join("benchmark", "context", "seed.json");

// ---------------------------------------------------------------------------
// pure helpers, exported for tests

export class UsageError extends Error {}

export interface GateArgs {
  /** The `--only` parts, de-duplicated, in `PARTS` order. Empty: every part, and the result is recorded. */
  only: Part[];
  help: boolean;
}

export function parseArgs(argv: string[]): GateArgs {
  const only = new Set<Part>();
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const eq = token.startsWith("--") ? token.indexOf("=") : -1;
    const name = eq === -1 ? token : token.slice(0, eq);
    switch (name) {
      case "--only": {
        const value = eq === -1 ? argv[++i] : token.slice(eq + 1);
        if (value === undefined || value === "" || value.startsWith("--")) throw new UsageError("--only needs a part");
        if (!(PARTS as readonly string[]).includes(value)) {
          throw new UsageError(`--only ${JSON.stringify(value)} is not a part; the parts are ${PARTS.join(", ")}`);
        }
        only.add(value as Part);
        break;
      }
      case "-h":
      case "--help":
        if (eq !== -1) throw new UsageError(`${name} takes no value`);
        help = true;
        break;
      default:
        throw new UsageError(`unknown argument ${JSON.stringify(token)}`);
    }
  }
  return { only: PARTS.filter((part) => only.has(part)), help };
}

/** The parts a run with these `--only` values runs, in order. */
export function selectedParts(only: readonly Part[]): Part[] {
  return only.length === 0 ? [...PARTS] : PARTS.filter((part) => only.includes(part));
}

/**
 * The `app/__init__.py` staged into a copy of the reference. uvicorn imports
 * the package before `app.main`, so this runs before `app.store` reads
 * `REFERENCE_SEED_PATH` and `app.mutants` reads `REFERENCE_MUTANT`. The seed
 * path is resolved from `__file__`: `<attempt>/backend/seed.json`, wherever the
 * attempt is mounted.
 */
export function initPyText(mutant: string | null): string {
  if (mutant !== null && !/^[a-z][a-z_]*$/.test(mutant)) throw new Error(`not a mutant name: ${JSON.stringify(mutant)}`);
  const lines = [
    '"""Staged by scripts/backend-gate.ts (gate 3a) in a copy of the reference backend.',
    "",
    "The fixture's own __init__.py is empty and is never edited. uvicorn imports this",
    "package before app.main, so the variables below are set before app.store and",
    'app.mutants read them; the container itself gets no extra variable."""',
    "import os",
    "",
    'os.environ["REFERENCE_SEED_PATH"] = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "seed.json")',
  ];
  if (mutant !== null) lines.push(`os.environ["REFERENCE_MUTANT"] = "${mutant}"`);
  return `${lines.join("\n")}\n`;
}

/** Copies of the fixtures leave out what a local run of them could have left behind. */
function copyFilter(source: string): boolean {
  const name = basename(source);
  return name !== "__pycache__" && name !== "node_modules" && name !== ".venv";
}

/**
 * Stage the reference backend as `<attemptDir>/backend/`: its `app/` and
 * `requirements.txt`, `seed.json` beside them, and `app/__init__.py`
 * replaced by `initPyText(mutant)`. Reads the fixture, never writes it.
 */
export function stageReference(repoRoot: string, attemptDir: string, mutant: string | null): void {
  const reference = join(repoRoot, REFERENCE_DIR);
  if (mutant !== null) {
    const mutants: unknown = JSON.parse(readFileSync(join(reference, "mutants.json"), "utf8"));
    if (typeof mutants !== "object" || mutants === null || !(mutant in mutants)) {
      throw new Error(`${mutant} is not a mutant in ${join(REFERENCE_DIR, "mutants.json")}`);
    }
  }
  const backend = join(attemptDir, "backend");
  mkdirSync(backend, { recursive: true });
  cpSync(join(reference, "app"), join(backend, "app"), { recursive: true, filter: copyFilter });
  cpSync(join(reference, "requirements.txt"), join(backend, "requirements.txt"));
  cpSync(join(repoRoot, SEED_FILE), join(backend, "seed.json"));
  writeFileSync(join(backend, "app", "__init__.py"), initPyText(mutant));
}

/** Stage one of the gate's fixtures (a directory holding `backend/`, or `frontend/`'s parent) as `attemptDir`. */
export function stageFixture(repoRoot: string, fixture: string, attemptDir: string): void {
  if (!/^[a-z0-9-]+$/.test(fixture)) throw new Error(`not a fixture name: ${JSON.stringify(fixture)}`);
  cpSync(join(repoRoot, FIXTURES_DIR, fixture), attemptDir, { recursive: true, filter: copyFilter });
}

/** The serving attempt: the reference backend, plus the zero-dependency frontend as `frontend/`. */
export function stageServeAttempt(repoRoot: string, attemptDir: string): void {
  stageReference(repoRoot, attemptDir, null);
  cpSync(join(repoRoot, FIXTURES_DIR, "frontend"), join(attemptDir, "frontend"), { recursive: true, filter: copyFilter });
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Width and height from a PNG's IHDR, which the format requires to be the
 * first chunk: 8 signature bytes, then a 4-byte length (13), "IHDR", and the
 * width and height as big-endian uint32s. Throws on anything else.
 */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // signature 8 + length 4 + type 4 + IHDR data 13 + CRC 4
  if (buf.length < 33) throw new Error(`not a PNG: ${buf.length} bytes, too short for a signature and an IHDR chunk`);
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("not a PNG: the signature does not match");
  const length = buf.readUInt32BE(8);
  const type = buf.toString("latin1", 12, 16);
  if (type !== "IHDR" || length !== 13) {
    throw new Error(`not a PNG: the first chunk is ${JSON.stringify(type)} of ${length} bytes, not a 13-byte IHDR`);
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width === 0 || height === 0) throw new Error(`not a PNG: IHDR says ${width}x${height}`);
  return { width, height };
}

export interface OwnershipWalk {
  /** Every path visited, the root included. */
  entries: number;
  /** The paths whose owner is not `uid`. */
  foreign: string[];
}

/** Every path under `root` (itself included) whose owner is not `uid`, by `lstat`: a symlink is judged as itself, never followed. */
export function walkOwnership(root: string, uid: number): OwnershipWalk {
  const walk: OwnershipWalk = { entries: 0, foreign: [] };
  const visit = (path: string): void => {
    const stat = lstatSync(path);
    walk.entries += 1;
    if (stat.uid !== uid) walk.foreign.push(path);
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
  };
  visit(root);
  return walk;
}

/** `contract-results --rows` output, read back with a real CSV parser. */
export function parseRows(stdout: string): string[][] {
  return parseCsv(stdout, { relax_column_count: false, skip_empty_lines: true }) as string[][];
}

export interface OwnedContainer {
  name: string;
  owner: number;
  attempt: string;
}

/** What `containersOwnedBy` asks docker for: every container with an owner label, one tab-separated line each. */
export const OWNED_CONTAINERS_FORMAT = `{{.Names}}\t{{.Label "${LABEL_OWNER}"}}\t{{.Label "${LABEL_ATTEMPT}"}}`;

/**
 * `docker ps --format OWNED_CONTAINERS_FORMAT` output, keeping only the
 * containers whose `agrav.owner` is one of `owners`. Every other line —
 * another run's container, the operator's — is dropped here, unread, and
 * nothing is ever reported about it or done to it. An owner label that is
 * not a plain decimal pid is never one of ours.
 */
export function parseOwnedContainers(stdout: string, owners: ReadonlySet<number>): OwnedContainer[] {
  const owned: OwnedContainer[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const [name = "", owner = "", attempt = ""] = line.split("\t");
    const pid = /^[1-9]\d{0,9}$/.test(owner.trim()) ? Number(owner.trim()) : null;
    if (pid === null || !owners.has(pid)) continue;
    owned.push({ name: name.trim(), owner: pid, attempt: attempt.trim() });
  }
  return owned;
}

/**
 * The line a dead-owner sweep prints for each thing it removed:
 * `serve-attempt`'s `removed <what>, a backend container whose owner is gone`
 * and `take-screenshots`' `Removed <what>, a … whose owner is gone.`
 */
export const SWEEP_LINE_RE = /^[Rr]emoved (.+), a (backend container|scratch directory) whose owner is gone\.?$/;

export interface SweptThing {
  kind: "container" | "scratch directory";
  /** The container's name, or the directory's path as the sweep printed it. */
  name: string;
  owner: number;
}

/**
 * What a sweep line says was removed, and whose it was: a container's owner
 * is the pid in its name's `-<pid>-<n>` tail (`agrav-backend-<attempt>-<pid>-<n>`,
 * `agrav-gate-image-<pid>-<n>`), a scratch directory's the pid in its name
 * (`SCRATCH_DIR_RE`). `null` for any other line, or an owner it cannot read.
 */
export function sweptThing(line: string): SweptThing | null {
  const match = SWEEP_LINE_RE.exec(line.trim());
  if (match === null) return null;
  const [, name, what] = match;
  if (what === "backend container") {
    const owner = /-([1-9]\d{0,9})-\d+$/.exec(name);
    return owner === null ? null : { kind: "container", name, owner: Number(owner[1]) };
  }
  const dir = SCRATCH_DIR_RE.exec(basename(name));
  return dir === null ? null : { kind: "scratch directory", name, owner: Number(dir[1]) };
}

/** One leftover, whichever way it was seen, so it is reported once: a container by name, a scratch directory by its base name. */
export function leftoverKey(kind: SweptThing["kind"], name: string): string {
  return kind === "container" ? `container ${name}` : `scratch directory ${basename(name)}`;
}

/** One thing a `leakCheck` saw: its `leftoverKey`, and how the log names it. */
export interface Leftover {
  key: string;
  what: string;
}

/** What one `leakCheck` prints, and which leftovers it reports for the first time. */
export interface LeakVerdict {
  /** The FAIL, naming each leftover no earlier check or part has reported; `null` when there is none. */
  fail: string | null;
  /** `already reported: <names>`: leftovers seen again that an earlier check or the part's own check counted. */
  alreadyReported: string | null;
  /** The `ok` summary: only when both listings answered and they and the swept list are all empty. */
  ok: string | null;
  /** The keys `fail` reports, for `Gate.reported`. */
  newlyReported: string[];
}

/**
 * What a `leakCheck` says about what it saw. A leftover is a FAIL once: one
 * in `reported` — the part's own check counted it, or an earlier check did
 * and kept it for inspection — is named as already reported, not counted
 * again. "Nothing left" is said only when both listings answered and neither
 * they nor the swept list hold anything at all: a failed listing is already a
 * FAIL and proves nothing either way, and a leftover already reported is
 * still there. Pure: the caller adds `newlyReported` to `reported`.
 */
export function leakVerdict(seen: {
  /** How many child processes the gate has started. */
  children: number;
  /** The containers labelled with one of the owners; `null` when `docker ps` failed. */
  containers: readonly Leftover[] | null;
  /** Their scratch directories; `null` when the temp directory could not be listed. */
  dirs: readonly Leftover[] | null;
  /** What a child's dead-owner sweep removed on their behalf since the last check. */
  swept: readonly Leftover[];
  reported: ReadonlySet<string>;
}): LeakVerdict {
  const summary =
    `nothing left by the gate or the ${seen.children} child process${seen.children === 1 ? "" : "es"} it has started: ` +
    "no container, no scratch directory, nothing swept";
  const found: string[] = [];
  const already: string[] = [];
  const newlyReported: string[] = [];
  const handled = new Set<string>();
  for (const { key, what } of [...(seen.containers ?? []), ...(seen.dirs ?? []), ...seen.swept]) {
    if (handled.has(key)) continue; // a container listed and swept in one check is one leftover
    handled.add(key);
    if (seen.reported.has(key)) {
      already.push(what);
    } else {
      newlyReported.push(key);
      found.push(what);
    }
  }
  const nothingLeft =
    seen.containers !== null && seen.dirs !== null && seen.containers.length === 0 && seen.dirs.length === 0 && seen.swept.length === 0;
  return {
    fail: found.length > 0 ? `${summary}: left behind: ${found.join("; ")}` : null,
    alreadyReported: already.length > 0 ? `already reported: ${already.join("; ")}` : null,
    ok: nothingLeft ? summary : null,
    newlyReported,
  };
}

// ---------------------------------------------------------------------------
// the session: what this run started, for its checks and its cleanups

class Interrupted extends Error {}

export interface CliRun {
  pid: number | null;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  error: string | null;
}

interface CliHandle {
  child: ChildProcess;
  done: Promise<CliRun>;
  /** The record `done` resolves to, filled as the child runs: what it printed so far, before it ends. */
  run: CliRun;
}

interface Facts {
  python?: string;
  agy?: string;
  reference?: Record<string, number>;
  hardcodedPlan?: Record<string, number>;
  /** Gate P2-B's own fingerprint, recorded once the fuzz part has checked the staged copy against it. */
  fuzzOracle?: string;
}

class Gate {
  problems = 0;
  handlers: InterruptHandlers | null = null;
  root: string | null = null;
  /** The gate's pid and every child's: the only owners whose containers and scratch directories it looks at. */
  readonly ownerPids = new Set<number>([process.pid]);
  /** Children already sent their one SIGTERM. */
  readonly signalled = new WeakSet<ChildProcess>();
  /** The image part's containers, registered before their `docker run`, removed once proven gone. */
  readonly containers = new Set<string>();
  readonly scratchDirs = new Set<string>();
  /** Attempt names staged under the root: a leftover container labelled with one of them is ours. */
  readonly staged = new Set<string>();
  /** Set once the end-of-run check found nothing left, so the exit listener need not ask docker again. */
  verifiedClean = false;
  containerSeq = 0;
  /** What each child pid was started as, for the messages about what it left. */
  readonly ownerLabels = new Map<number, string>();
  /** Leftovers already reported (`leftoverKey`), so a later check or sweep does not report one again. */
  readonly reported = new Set<string>();
  /** Things a child's dead-owner sweep removed that one of the gate's pids had left: reported by the next `leakCheck`. */
  readonly swept: Array<{ key: string; what: string }> = [];

  constructor(
    readonly imageTag: string,
    readonly imageRef: string,
    readonly imageId: string,
  ) {}

  interrupted(): boolean {
    return this.handlers?.interrupted() != null;
  }

  guard(): void {
    if (this.interrupted()) throw new Interrupted("interrupted");
  }

  /** `the gate (pid N)` or `<label> (pid N)`: whose a leftover is. */
  ownerName(pid: number): string {
    if (pid === process.pid) return `the gate (pid ${pid})`;
    const label = this.ownerLabels.get(pid);
    return label === undefined ? `pid ${pid}` : `${label} (pid ${pid})`;
  }

  // After a signal, nothing a check sees is a finding either way: the
  // cleanups are stopping what it looks at.
  ok(part: string, what: string): void {
    if (this.interrupted()) return;
    console.log(`ok    ${part.padEnd(12)} ${what}`);
  }

  fail(part: string, what: string): void {
    if (this.interrupted()) return;
    this.problems += 1;
    console.log(`FAIL  ${part.padEnd(12)} ${what}`);
  }

  /** Neither `ok` nor `FAIL`: something already counted, said again so the log does not contradict itself. */
  note(part: string, what: string): void {
    if (this.interrupted()) return;
    console.log(`      ${part.padEnd(12)} ${what}`);
  }

  /** One assertion: `ok` or `FAIL`, and whether it held. */
  check(part: string, holds: boolean, what: string, why: string): boolean {
    if (holds) this.ok(part, what);
    else this.fail(part, `${what}: ${why}`);
    return holds;
  }

  rootPath(): string {
    if (this.root === null) throw new Error("no temporary root");
    return this.root;
  }

  attemptDir(attempt: string): string {
    return join(this.rootPath(), "eval-attempts", attempt);
  }

  /** `<root>/eval-attempts/<attempt>/` from `stage`, and an empty `<root>/eval-results/<attempt>/`. */
  stage(attempt: string, stage: (attemptDir: string) => void): void {
    this.guard();
    const dir = this.attemptDir(attempt);
    if (this.staged.has(attempt)) return;
    this.staged.add(attempt);
    stage(dir);
    mkdirSync(join(this.rootPath(), "eval-results", attempt), { recursive: true });
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isLive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

/**
 * The end of a child's stderr as one line: its last non-empty lines, joined,
 * cut from the front to `STDERR_QUOTE_CHARS` — each CLI ends with its own
 * reason (the PyPI probe, `npm ping`, a harness fault, Playwright's missing
 * browser), so the end is what matters. Empty when there is none.
 */
export function stderrEnd(stderr: string): string {
  const flat = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(-STDERR_QUOTE_LINES)
    .join(" / ");
  return flat.length <= STDERR_QUOTE_CHARS ? flat : `…${flat.slice(-STDERR_QUOTE_CHARS)}`;
}

/**
 * How a child ended, for a FAIL line; for anything but a clean exit 0, with the
 * end of its stderr, so the child's own reason is in the line a filtered log
 * keeps and not only in its `[label]` lines above.
 */
export function describeExit(run: CliRun): string {
  let how: string;
  if (run.error !== null) how = `could not run (${run.error})`;
  else if (run.timedOut) {
    // Its `done` may not have settled yet: SIGKILLed, and no code or signal to show.
    const end = run.code !== null ? `exit ${run.code}` : (run.signal ?? "still running after SIGKILL");
    how = `timed out and was stopped (${end})`;
  }
  else if (run.code === 0) return "exit 0";
  else how = run.code === null ? `killed by ${run.signal}` : `exit ${run.code}`;
  const end = stderrEnd(run.stderr);
  return end === "" ? how : `${how}; its stderr ends: ${JSON.stringify(end)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** `promise`'s value, or `null` once `ms` have passed. The timer is cleared either way, so it holds nothing open. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<null>((done) => (timer = setTimeout(() => done(null), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

// ---------------------------------------------------------------------------
// children: `node --import tsx scripts/<cli>.ts`, as the skill runs them

/**
 * Start a scoring CLI as the skill does: `node --import tsx` directly, never
 * `npm run`. Detached, in a group of its own, so an operator's Ctrl-C reaches
 * the gate alone and the child gets exactly one SIGTERM from the gate's
 * cleanup — a second signal would make it exit without removing what it
 * started. Its output is streamed with a prefix and kept for the checks.
 */
function startCli(g: Gate, label: string, args: string[], options: { duringCleanup?: boolean } = {}): CliHandle {
  if (!options.duringCleanup) g.guard();
  const child = spawn(process.execPath, ["--import", "tsx", ...args], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  if (child.pid !== undefined) {
    g.ownerPids.add(child.pid);
    g.ownerLabels.set(child.pid, label);
  }
  const run: CliRun = { pid: child.pid ?? null, code: null, signal: null, timedOut: false, stdout: "", stderr: "", error: null };
  const keep = (stream: "stdout" | "stderr") => (line: string) => {
    run[stream] = (run[stream] + line + "\n").slice(-OUTPUT_KEEP_CHARS);
    console.log(`      [${label}] ${line}`);
    // A sweep that removes what one of this run's pids left is repairing a
    // leak, not proving there was none: the next leakCheck reports it.
    const swept = sweptThing(line);
    if (swept !== null && g.ownerPids.has(swept.owner)) {
      g.swept.push({
        key: leftoverKey(swept.kind, swept.name),
        what: `${swept.kind} ${swept.name} of ${g.ownerName(swept.owner)}, removed by ${label}'s dead-owner sweep`,
      });
    }
  };
  if (child.stdout !== null) createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", keep("stdout"));
  if (child.stderr !== null) createInterface({ input: child.stderr, crlfDelay: Infinity }).on("line", keep("stderr"));

  const done = new Promise<CliRun>((resolveRun) => {
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      resolveRun(run);
    };
    child.on("error", (error) => {
      run.error = error.message;
      if (child.pid === undefined) settle();
    });
    child.on("exit", (code, signal) => {
      run.code = code;
      run.signal = signal;
      // A grandchild holding a pipe must not keep the gate waiting.
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle();
      }, CLOSE_AFTER_EXIT_MS).unref();
    });
    child.on("close", settle);
  });
  return { child, done, run };
}

/** SIGTERM the child (once), wait for it, then SIGKILL its group — ours while unreaped. */
async function terminate(g: Gate, handle: CliHandle, waitMs: number = CHILD_TERM_WAIT_MS): Promise<void> {
  const { child } = handle;
  if (!isLive(child) || child.pid === undefined) return;
  if (!g.signalled.has(child)) {
    g.signalled.add(child);
    try {
      process.kill(child.pid, "SIGTERM");
    } catch {
      return; // gone in the meantime
    }
  }
  if ((await within(handle.done, waitMs)) !== null || !isLive(child)) return;
  console.error(`backend-gate: pid ${child.pid} did not exit within ${seconds(waitMs)} of SIGTERM; killing its group`);
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // gone
  }
  await within(handle.done, 10_000);
}

/** Every child started and not yet proven exited: what the cleanups stop. */
const handles = new Set<CliHandle>();

async function runCli(g: Gate, label: string, args: string[], timeoutMs: number, options: { duringCleanup?: boolean } = {}): Promise<CliRun> {
  const handle = startCli(g, label, args, options);
  handles.add(handle);
  try {
    const run = await within(handle.done, timeoutMs);
    if (run !== null) return run;
    console.error(`backend-gate: ${label} ran longer than ${seconds(timeoutMs)}; stopping it`);
    await terminate(g, handle);
    // `done` is given a moment to settle, but the record is the live one either
    // way: a child that outlived even SIGKILL still has what it printed.
    await within(handle.done, 1_000);
    return { ...handle.run, timedOut: true };
  } finally {
    if (!isLive(handle.child)) handles.delete(handle);
  }
}

// ---------------------------------------------------------------------------
// the gate's own containers (the image part)

interface ContainerRun {
  name: string;
  code: number | null;
  timedOut: boolean;
  output: string;
  removed: boolean;
}

/**
 * One foreground `docker run` of the image by Id, named and labelled like a
 * backend container (role `backend`, owner this pid) so the dead-owner sweep
 * finds it if the gate is SIGKILLed, registered before it starts and removed —
 * with proof — after it ends. Asynchronous with a timer: a signal is acted on
 * at once.
 */
async function runGateContainer(g: Gate, options: string[], command: string[], timeoutMs: number): Promise<ContainerRun> {
  g.guard();
  g.containerSeq += 1;
  const name = `agrav-gate-image-${process.pid}-${g.containerSeq}`;
  g.containers.add(name);
  const args = [
    "run",
    "--init",
    "--pull",
    "never",
    "--name",
    name,
    "--label",
    `${LABEL_ROLE}=${BACKEND_ROLE}`,
    "--label",
    `${LABEL_OWNER}=${process.pid}`,
    "--user",
    userSpec(),
    ...options,
    g.imageId,
    ...command,
  ];
  const result = await new Promise<{ code: number | null; timedOut: boolean; output: string }>((done) => {
    const client = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    const collect = (chunk: Buffer): void => {
      output = (output + chunk.toString()).slice(-64 * 1024);
    };
    client.stdout?.on("data", collect);
    client.stderr?.on("data", collect);
    const timer = setTimeout(() => {
      timedOut = true;
      client.kill("SIGKILL");
    }, timeoutMs);
    client.on("error", (error) => {
      clearTimeout(timer);
      done({ code: null, timedOut, output: `${output}${error.message}` });
    });
    client.on("close", (code) => {
      clearTimeout(timer);
      done({ code, timedOut, output });
    });
  });
  const removal = ensureContainerRemoved(name, {
    consequence: `The gate started it; remove it with \`docker rm -f ${name}\`.`,
  });
  settleGateContainer(g.containers, g.reported, name, removal.removed);
  return { name, ...result, removed: removal.removed };
}

/**
 * After a gate container's removal: forgotten once proven gone. Otherwise it
 * stays for the cleanups, and counts as reported — its part's own check FAILs
 * it — so the leak check after the part names it without a second FAIL.
 */
export function settleGateContainer(containers: Set<string>, reported: Set<string>, name: string, removed: boolean): void {
  if (removed) containers.delete(name);
  else reported.add(leftoverKey("container", name));
}

/**
 * The image part's FAIL detail for a `pip install` that failed: pip's last
 * lines, then what the PyPI probe after it said — so an outage reads as one,
 * as the backend runner reads it. `probe` is `null` when none ran.
 */
export function pipInstallFailure(pip: { code: number | null; timedOut: boolean; output: string }, probe: { code: number | null; timedOut: boolean } | null): string {
  const said = `exit ${pip.code}${pip.timedOut ? " (timed out)" : ""}: ${pip.output.trim().split("\n").slice(-3).join(" / ")}`;
  if (probe === null) return said;
  const how = `the PyPI probe (pip download ${PROBE_REQUIREMENT})`;
  return probe.code === 0 && !probe.timedOut
    ? `${said}; ${how} then succeeded, so PyPI was reachable`
    : `${said}; ${how} then failed too (exit ${probe.code}${probe.timedOut ? ", timed out" : ""}): an outage, retry later`;
}

// ---------------------------------------------------------------------------
// parts

async function imagePart(g: Gate, facts: Facts): Promise<void> {
  const part = "image";
  g.ok(part, `${g.imageTag} resolves to ${g.imageId}`);

  const python = await runGateContainer(g, ["--entrypoint", "python3"], ["--version"], IMAGE_QUICK_MS);
  const pythonVersion = python.output.trim();
  g.check(part, python.removed, `container ${python.name} removed`, "the daemon would not confirm it is gone");
  if (g.check(part, python.code === 0 && PYTHON_VERSION_RE.test(pythonVersion), `python3 --version: ${pythonVersion}`, `exit ${python.code}${python.timedOut ? " (timed out)" : ""}, expected ${PYTHON_VERSION_RE}`)) {
    facts.python = pythonVersion;
  }

  const agy = await runGateContainer(g, ["--entrypoint", "agy"], ["--version"], IMAGE_QUICK_MS);
  const agyVersion = agy.output.trim();
  const pinned = pinnedAgyVersion(REPO_ROOT);
  g.check(part, agy.removed, `container ${agy.name} removed`, "the daemon would not confirm it is gone");
  if (g.check(part, agy.code === 0 && agyVersion.includes(pinned), `agy --version: ${agyVersion}`, `exit ${agy.code}${agy.timedOut ? " (timed out)" : ""}, expected it to contain ${pinned}`)) {
    facts.agy = agyVersion;
  }

  // A venv and a pip install as the host uid, into a host scratch directory
  // made the way the backend runner makes its own (so the sweep knows it).
  g.guard();
  const scratch = mkdtempSync(join(tmpdir(), scratchDirPrefix(process.pid)));
  g.scratchDirs.add(scratch);
  const mount = ["-e", "HOME=/scoring/home", "-e", "PIP_DISABLE_PIP_VERSION_CHECK=1", "-e", "PIP_NO_INPUT=1", "-v", `${scratch}:/scoring`, "-w", "/scoring"];
  const venv = await runGateContainer(g, [...mount, "--entrypoint", "python3"], ["-m", "venv", "/scoring/venv"], LIMITS.pipInstallMs);
  g.check(part, venv.removed, `container ${venv.name} removed`, "the daemon would not confirm it is gone");
  g.check(part, venv.code === 0, `python3 -m venv as ${userSpec()}`, `exit ${venv.code}${venv.timedOut ? " (timed out)" : ""}: ${venv.output.trim().split("\n").slice(-3).join(" / ")}`);
  const pip = await runGateContainer(g, [...mount, "--entrypoint", "/scoring/venv/bin/pip"], ["install", PIP_PACKAGE], LIMITS.pipInstallMs);
  g.check(part, pip.removed, `container ${pip.name} removed`, "the daemon would not confirm it is gone");
  let probe: ContainerRun | null = null;
  if (pip.code !== 0 && venv.code === 0) {
    // As the backend runner does after a failed install: whether PyPI answers at all.
    probe = await runGateContainer(
      g,
      [...mount, "--entrypoint", "/scoring/venv/bin/pip"],
      ["download", "--no-deps", "--no-cache-dir", "-d", "/tmp/agrav-probe", PROBE_REQUIREMENT],
      LIMITS.pypiProbeMs,
    );
    g.check(part, probe.removed, `container ${probe.name} removed`, "the daemon would not confirm it is gone");
  }
  g.check(part, pip.code === 0, `pip install ${PIP_PACKAGE} as ${userSpec()}`, pipInstallFailure(pip, probe));

  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const walk = walkOwnership(scratch, uid);
  const installed = walkHas(scratch, PIP_PACKAGE_FILE);
  g.check(part, installed, `${PIP_PACKAGE_FILE} is in the venv's site-packages`, "pip reported success but the module is not there");
  g.check(
    part,
    walk.entries > 1 && walk.foreign.length === 0,
    `all ${walk.entries} paths under the scratch directory are owned by uid ${uid}`,
    `${walk.foreign.length} are not, e.g. ${walk.foreign.slice(0, 5).join(", ")}`,
  );
  try {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    g.scratchDirs.delete(scratch);
  } catch (error) {
    // Kept in scratchDirs: the end-of-run check tries again. Reported here, not by leakCheck too.
    g.fail(part, `could not remove the scratch directory ${scratch}: ${message(error)}`);
    g.reported.add(leftoverKey("scratch directory", scratch));
  }
}

/** The reference's `name==version` lines, as `pip freeze` prints them. */
function referencePins(repoRoot: string): string[] {
  return readFileSync(join(repoRoot, REFERENCE_DIR, "requirements.txt"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[A-Za-z0-9._-]+==\S+$/.test(line));
}

function walkHas(root: string, file: string): boolean {
  const lib = join(root, "venv", "lib");
  if (!existsSync(lib)) return false;
  return readdirSync(lib).some((python) => existsSync(join(lib, python, "site-packages", file)));
}

/** `contract-tests` on one staged attempt; the parsed result when it exited 0 with a readable file. */
async function contractTests(g: Gate, part: string, attempt: string): Promise<ContractResults | null> {
  const t0 = performance.now();
  const run = await runCli(g, `contract-tests ${attempt}`, ["scripts/contract-tests.ts", "--attempt", attempt, "--root", g.rootPath(), "--ignore-run-json"], CONTRACT_CHILD_MS);
  if (!g.check(part, run.code === 0 && !run.timedOut, `${attempt}: contract-tests exited 0 (${seconds(performance.now() - t0)})`, describeExit(run))) return null;
  const path = join(g.rootPath(), "eval-results", attempt, CONTRACT_RESULTS_FILE);
  let results: ContractResults;
  try {
    results = parseContractResults(readFileSync(path, "utf8"));
  } catch (error) {
    g.fail(part, `${attempt}: ${path} does not parse: ${message(error)}`);
    return null;
  }
  g.ok(part, `${attempt}: ${CONTRACT_RESULTS_FILE} parses`);
  g.check(part, results.attempt === attempt, `${attempt}: attempt recorded`, `it says ${JSON.stringify(results.attempt)}`);
  g.check(part, results.image === g.imageRef, `${attempt}: image ${results.image}`, `expected ${g.imageRef}`);
  const rubric = rubricId(REPO_ROOT);
  g.check(part, results.rubric === rubric, `${attempt}: rubric ${results.rubric}`, `expected ${rubric}`);
  g.check(part, results.runImage === null && !results.ungated, `${attempt}: synthetic (runImage null) and gated`, `runImage ${JSON.stringify(results.runImage)}, ungated ${results.ungated}`);
  return results;
}

/** `contract-results --rows`, parsed; checks the names, scores and maxima, and each Notes cell with `notes`. */
async function rows(g: Gate, part: string, attempt: string, scores: readonly number[], notes: (index: number, cell: string) => string | null): Promise<void> {
  const run = await runCli(g, `--rows ${attempt}`, ["scripts/contract-results.ts", "--rows", attempt, "--root", g.rootPath()], ROWS_CHILD_MS);
  if (!g.check(part, run.code === 0, `${attempt}: contract-results --rows exited 0`, describeExit(run))) return;
  let records: string[][];
  try {
    records = parseRows(run.stdout);
  } catch (error) {
    g.fail(part, `${attempt}: --rows printed what csv-parse cannot read: ${message(error)}`);
    return;
  }
  if (!g.check(part, records.length === HIDDEN_ROWS.length && records.every((r) => r.length === 4), `${attempt}: --rows printed ${HIDDEN_ROWS.length} four-field lines`, `got ${JSON.stringify(records)}`)) return;
  const problems: string[] = [];
  records.forEach(([name, score, max, cell], i) => {
    const row = HIDDEN_ROWS[i];
    if (name !== row.name) problems.push(`line ${i + 1} names ${JSON.stringify(name)}, not ${JSON.stringify(row.name)}`);
    if (score !== String(scores[i])) problems.push(`${row.name} scores ${score}, not ${scores[i]}`);
    if (max !== String(row.max)) problems.push(`${row.name} has Max ${max}, not ${row.max}`);
    const why = notes(i, cell);
    if (why !== null) problems.push(`${row.name} Notes ${JSON.stringify(cell)}: ${why}`);
  });
  g.check(part, problems.length === 0, `${attempt}: --rows scores ${scores.join("/")}, Notes as expected`, problems.join("; "));
}

function manifestTests(manifest: readonly ManifestEntry[]): Record<string, number> {
  return Object.fromEntries(manifest.map((entry) => [entry.file, entry.tests]));
}

/** Per-file counts and scores against `expected`; true when every one matches. */
function checkGroups(g: Gate, part: string, attempt: string, results: ContractResults, expected: readonly FileExpectation[]): boolean {
  const problems: string[] = [];
  if (results.groups.length !== expected.length) problems.push(`${results.groups.length} groups, not ${expected.length}`);
  expected.forEach((want, i) => {
    const got = results.groups[i];
    if (got === undefined) return;
    if (got.file !== want.file) problems.push(`group ${i + 1} is ${got.file}, not ${want.file}`);
    if (got.total !== want.total || got.passed !== want.passed) problems.push(`${want.file} ${got.passed}/${got.total}, not ${want.passed}/${want.total}`);
    if (got.score !== want.score) problems.push(`${want.file} scores ${got.score}, not ${want.score}`);
    if (got.timedOut || got.notRun !== 0) problems.push(`${want.file} timed out (${got.notRun} not run)`);
  });
  return g.check(
    part,
    problems.length === 0,
    `${attempt}: ${expected.map((e) => `${e.passed}/${e.total}`).join(", ")} → ${expected.map((e) => e.score).join("/")}`,
    problems.join("; "),
  );
}

async function contractPart(g: Gate, facts: Facts, manifest: readonly ManifestEntry[]): Promise<void> {
  const part = "contract";
  g.check(
    part,
    JSON.stringify(REFERENCE_EXPECTED.map((e) => [e.file, e.total])) === JSON.stringify(manifest.map((m) => [m.file, m.tests])),
    "the manifest still lists 24/12/11/11",
    `benchmark/contract-tests/manifest.json lists ${manifest.map((m) => `${m.file} ${m.tests}`).join(", ")}; this gate's expectations are out of date`,
  );

  g.stage(REFERENCE_ATTEMPT, (dir) => stageReference(REPO_ROOT, dir, null));
  const reference = await contractTests(g, part, REFERENCE_ATTEMPT);
  if (reference !== null) {
    g.check(part, reference.boot.ok && reference.boot.stage === null, `${REFERENCE_ATTEMPT}: booted`, `boot ${JSON.stringify(reference.boot)}`);
    g.check(part, reference.diagnosis === null, `${REFERENCE_ATTEMPT}: no diagnosis`, `diagnosis ${reference.diagnosis}`);
    const allPassed = checkGroups(g, part, REFERENCE_ATTEMPT, reference, REFERENCE_EXPECTED);
    g.check(part, reference.groups.every((group) => group.failed.length === 0 && group.hookFailed === 0), `${REFERENCE_ATTEMPT}: no failed test`, reference.groups.flatMap((group) => group.failed.map((f) => `${group.file}: ${f.name}`)).join("; "));
    await rows(g, part, REFERENCE_ATTEMPT, REFERENCE_EXPECTED.map((e) => e.score), (i, cell) => {
      const want = `${REFERENCE_EXPECTED[i].passed}/${REFERENCE_EXPECTED[i].total} passed`;
      return cell === want ? null : `expected ${JSON.stringify(want)}`;
    });
    if (allPassed) facts.reference = manifestTests(manifest);
  }

  g.stage(MUTANT_ATTEMPT, (dir) => stageReference(REPO_ROOT, dir, MUTANT));
  const mutant = await contractTests(g, part, MUTANT_ATTEMPT);
  if (mutant !== null) {
    g.check(part, mutant.boot.ok, `${MUTANT_ATTEMPT}: booted`, `boot ${JSON.stringify(mutant.boot)}`);
    g.check(part, mutant.diagnosis === null, `${MUTANT_ATTEMPT}: no diagnosis`, `diagnosis ${mutant.diagnosis}`);
    const matches = checkGroups(g, part, MUTANT_ATTEMPT, mutant, HARDCODED_PLAN_EXPECTED);
    await rows(g, part, MUTANT_ATTEMPT, HARDCODED_PLAN_EXPECTED.map((e) => e.score), (i, cell) => {
      const want = HARDCODED_PLAN_EXPECTED[i];
      const head = `${want.passed}/${want.total} passed`;
      if (want.passed === want.total) return cell === head ? null : `expected ${JSON.stringify(head)}`;
      return cell.startsWith(`${head}; failed: `) ? null : `expected it to start ${JSON.stringify(`${head}; failed: `)}`;
    });
    if (matches) facts.hardcodedPlan = Object.fromEntries(mutant.groups.map((group) => [group.file, group.passed]));
  }
}

// ---------------------------------------------------------------------------
// the fuzz part: contract-tests-hard against a copy of the console-fuzz track

/**
 * Makes `root` a track root (Ruling H2: it mirrors the repository root), by
 * copying `tracks/console-fuzz/benchmark/fuzz/` into it once. The
 * `eval-attempts/` and `eval-results/` the other parts already stage attempts
 * into sit right beside it, so `contractTestsHard` can pass `root` itself as
 * `--root`. Idempotent: a second call with the same `root` copies nothing.
 */
export function stageTrack(root: string): string {
  const dest = join(root, "benchmark", "fuzz");
  if (!existsSync(dest)) {
    mkdirSync(join(root, "benchmark"), { recursive: true });
    cpSync(join(REPO_ROOT, "tracks", "console-fuzz", "benchmark", "fuzz"), dest, { recursive: true, filter: copyFilter });
  }
  return root;
}

/**
 * Every file under `dir`, relative to `root`, `/`-separated, sorted — skipping
 * what a local run could have left behind (`copyFilter`'s own names), so a
 * stray `__pycache__` or `node_modules` on one side does not fail the
 * comparison below.
 */
function filesUnder(root: string, dir: string = root): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => copyFilter(entry.name))
    .flatMap((entry) => {
      const full = join(dir, entry.name);
      return entry.isDirectory() ? filesUnder(root, full) : [relative(root, full).split(sep).join("/")];
    })
    .sort();
}

/**
 * Compares two directory trees file by file: which paths exist only under
 * `a`, only under `b`, and which exist under both but differ byte for byte.
 * All three are empty when the trees are identical.
 */
export function compareTrees(a: string, b: string): { onlyA: string[]; onlyB: string[]; differ: string[] } {
  const filesA = new Set(filesUnder(a));
  const filesB = new Set(filesUnder(b));
  const onlyA = [...filesA].filter((f) => !filesB.has(f)).sort();
  const onlyB = [...filesB].filter((f) => !filesA.has(f)).sort();
  const differ = [...filesA]
    .filter((f) => filesB.has(f))
    .filter((f) => !readFileSync(join(a, f)).equals(readFileSync(join(b, f))))
    .sort();
  return { onlyA, onlyB, differ };
}

/**
 * `contract-tests-hard` on one staged attempt, against the gate's copy of the
 * track; the parsed envelope when it exited 0 with a readable file.
 *
 * The copy is not gate P2-B's own root, so `contract-tests-hard`'s own
 * `gate(root)` correctly calls it ungated and reports `oracle` (both computed
 * from the *repository's* own files — `contract-tests-hard.ts`, `gate()` —
 * never from what got staged) rather than the plain refusal `contractTests`
 * would get for the published track. Checking `oracle` against gate P2-B's
 * fingerprint only proves that record is current with the repository; it says
 * nothing about whether the staged copy matches the repository. That is
 * `fuzzPart`'s job, once per run, via `compareTrees` — not this function's,
 * since it runs once per attempt and the copy does not change between them.
 */
async function contractTestsHard(g: Gate, part: string, attempt: string, trackRoot: string, expectedOracle: string): Promise<HardResult | null> {
  const t0 = performance.now();
  const run = await runCli(
    g,
    `contract-tests-hard ${attempt}`,
    ["scripts/contract-tests-hard.ts", "--attempt", attempt, "--root", trackRoot, "--ignore-run-json", "--allow-ungated"],
    HARD_CONTRACT_CHILD_MS,
  );
  if (!g.check(part, run.code === 0 && !run.timedOut, `${attempt}: contract-tests-hard exited 0 (${seconds(performance.now() - t0)})`, describeExit(run))) return null;
  const path = join(trackRoot, "eval-results", attempt, HARD_RESULTS_FILE);
  const hardManifest = loadHardManifest(trackRoot);
  let result: HardResult;
  try {
    result = parseHardResult(readFileSync(path, "utf8"), hardManifest);
  } catch (error) {
    g.fail(part, `${attempt}: ${path} does not parse: ${message(error)}`);
    return null;
  }
  g.ok(part, `${attempt}: ${HARD_RESULTS_FILE} parses`);
  g.check(part, result.contract.attempt === attempt, `${attempt}: attempt recorded`, `it says ${JSON.stringify(result.contract.attempt)}`);
  g.check(part, result.contract.image === g.imageRef, `${attempt}: image ${result.contract.image}`, `expected ${g.imageRef}`);
  const rubric = rubricId(REPO_ROOT);
  g.check(part, result.contract.rubric === rubric, `${attempt}: rubric ${result.contract.rubric}`, `expected ${rubric}`);
  g.check(part, result.contract.runImage === null, `${attempt}: synthetic (runImage null)`, `runImage ${JSON.stringify(result.contract.runImage)}`);
  g.check(part, result.contract.ungated, `${attempt}: ungated — a copy of the track is never gate P2-B's own root`, `ungated ${result.contract.ungated}`);
  g.check(part, result.oracle === expectedOracle, `${attempt}: oracle ${result.oracle}`, `expected ${expectedOracle} (gate P2-B's own fingerprint)`);
  return result;
}

/** The `pydantic` line of a `pipFreeze`, or a note that none was there — the oracle was frozen on host Python 3.12, the container runs 3.11. */
export function pydanticLine(pipFreeze: readonly string[]): string {
  return pipFreeze.find((line) => line.toLowerCase().startsWith("pydantic")) ?? "(no pydantic line in pip freeze)";
}

async function fuzzPart(g: Gate, facts: Facts): Promise<void> {
  const part = "fuzz";
  const recordPath = join(REPO_ROOT, FUZZ_GATE_RESULT_PATH);
  let record: FuzzGateResult;
  try {
    record = JSON.parse(readFileSync(recordPath, "utf8"));
  } catch (error) {
    g.fail(part, `could not read ${FUZZ_GATE_RESULT_PATH}: ${message(error)} — run \`npm run gate:fuzz\` first`);
    return;
  }
  const expectedOracle = record.fingerprint.slice(0, 12);
  const trackRoot = stageTrack(g.rootPath());
  const [entry] = loadHardManifest(trackRoot);

  // The copy `stageTrack` made is the only thing `contractTestsHard` runs
  // against below; `oracle`/`ungated` (checked per attempt, inside that
  // function) only prove gate P2-B's record is current with the repository's
  // own files. Whether the staged copy actually matches those files is a
  // separate question, checked once here, against every file the copy has —
  // not just the entry points `contract-tests-hard.ts` reads.
  const source = join(REPO_ROOT, "tracks", "console-fuzz", "benchmark", "fuzz");
  const staged = join(trackRoot, "benchmark", "fuzz");
  const diff = compareTrees(source, staged);
  if (
    !g.check(
      part,
      diff.onlyA.length === 0 && diff.onlyB.length === 0 && diff.differ.length === 0,
      "the staged copy of the track is byte-identical to the repository's",
      [
        diff.onlyA.length > 0 ? `only in the repository: ${diff.onlyA.join(", ")}` : null,
        diff.onlyB.length > 0 ? `only in the copy: ${diff.onlyB.join(", ")}` : null,
        diff.differ.length > 0 ? `differ: ${diff.differ.join(", ")}` : null,
      ]
        .filter((line): line is string => line !== null)
        .join("; "),
    )
  ) {
    return;
  }

  g.stage(REFERENCE_ATTEMPT, (dir) => stageReference(REPO_ROOT, dir, null));
  const reference = await contractTestsHard(g, part, REFERENCE_ATTEMPT, trackRoot, expectedOracle);
  let referenceOk = reference !== null;
  if (reference !== null) {
    referenceOk &&= g.check(part, reference.contract.boot.ok && reference.contract.boot.stage === null, `${REFERENCE_ATTEMPT}: booted`, `boot ${JSON.stringify(reference.contract.boot)}`);
    referenceOk &&= g.check(
      part,
      reference.fuzz.passed === entry.tests && reference.fuzz.total === entry.tests && reference.fuzz.score === entry.max,
      `${REFERENCE_ATTEMPT}: ${reference.fuzz.passed}/${reference.fuzz.total} → ${reference.fuzz.score}/${entry.max}`,
      `expected ${entry.tests}/${entry.tests} → ${entry.max}/${entry.max} (the manifest's own counts)`,
    );
    const short = reference.fuzz.perStratum.filter((s) => s.passed !== s.total);
    referenceOk &&= g.check(part, short.length === 0, `${REFERENCE_ATTEMPT}: every stratum at its total`, short.map((s) => `${s.id} ${s.passed}/${s.total}`).join("; "));
    // On every run, not only a boot failure: the case this is for is a
    // reference that boots fine and then answers differently from the
    // oracle frozen on host Python — where pipFreeze is not empty, and the
    // above checks are exactly what goes red.
    g.note(part, `${REFERENCE_ATTEMPT}: pip freeze's pydantic line, in case a container-resolved version is why: ${pydanticLine(reference.contract.pipFreeze)}`);
  }

  g.stage(MUTANT_ATTEMPT, (dir) => stageReference(REPO_ROOT, dir, MUTANT));
  const mutant = await contractTestsHard(g, part, MUTANT_ATTEMPT, trackRoot, expectedOracle);
  let mutantOk = mutant !== null;
  if (mutant !== null) {
    mutantOk &&= g.check(part, mutant.contract.boot.ok, `${MUTANT_ATTEMPT}: booted`, `boot ${JSON.stringify(mutant.contract.boot)}`);
    const expectedFailures = record.mutantFailures[MUTANT];
    if (expectedFailures === undefined) {
      g.fail(part, `${MUTANT_ATTEMPT}: gate P2-B's record has no entry for ${MUTANT} (it has ${JSON.stringify(Object.keys(record.mutantFailures))})`);
      mutantOk = false;
    } else {
      const got = mutant.fuzz.total - mutant.fuzz.passed;
      mutantOk &&= g.check(
        part,
        got === expectedFailures.total,
        `${MUTANT_ATTEMPT}: ${got} failures in all, matching gate P2-B's record`,
        `gate P2-B recorded ${expectedFailures.total} for ${MUTANT}`,
      );
      // The part's teeth: not that the container path runs, but that it
      // reproduces host python's per-stratum failure count for a broken
      // backend, stratum by stratum. No number here is typed; all of them
      // come from the P2-B record.
      const mismatches = mutant.fuzz.perStratum
        .map((s) => ({ id: s.id, got: s.total - s.passed, want: expectedFailures.byStratum[s.id] ?? 0 }))
        .filter((s) => s.got !== s.want);
      mutantOk &&= g.check(
        part,
        mismatches.length === 0,
        `${MUTANT_ATTEMPT}: per-stratum failures match gate P2-B's record (${expectedFailures.total} total)`,
        mismatches.map((s) => `${s.id} ${s.got}, not ${s.want}`).join("; "),
      );
    }
  }

  if (referenceOk && mutantOk) facts.fuzzOracle = record.fingerprint;
}

async function stopsPart(g: Gate, manifest: readonly ManifestEntry[]): Promise<void> {
  const part = "stops";
  for (const stop of STOP_CASES) {
    g.stage(stop.attempt, (dir) => stageFixture(REPO_ROOT, stop.fixture, dir));
    const results = await contractTests(g, part, stop.attempt);
    if (results === null) continue;
    g.check(
      part,
      !results.boot.ok && results.boot.stage === stop.stage && (results.boot.detail ?? "").trim() !== "",
      `${stop.attempt}: backend stop (${stop.stage}) with a detail`,
      `boot ${JSON.stringify(results.boot)}`,
    );
    g.check(part, results.diagnosis === null, `${stop.attempt}: no diagnosis`, `diagnosis ${results.diagnosis}`);
    g.check(
      part,
      results.groups.length === manifest.length &&
        results.groups.every((group, i) => group.passed === 0 && group.score === 0 && group.total === manifest[i].tests && group.failed.length === 0),
      `${stop.attempt}: all four groups 0, totals from the manifest`,
      JSON.stringify(results.groups.map((group) => ({ file: group.file, passed: group.passed, total: group.total, score: group.score }))),
    );
    await rows(g, part, stop.attempt, manifest.map(() => 0), (i, cell) => {
      const head = `0/${manifest[i].tests} passed; backend stop (${stop.stage}): `;
      return cell.startsWith(head) && cell.length > head.length ? null : `expected ${JSON.stringify(`${head}…`)}`;
    });
  }

  const broken = RESET_BROKEN;
  g.stage(broken.attempt, (dir) => stageFixture(REPO_ROOT, broken.fixture, dir));
  const results = await contractTests(g, part, broken.attempt);
  if (results === null) return;
  g.check(part, results.boot.ok, `${broken.attempt}: booted`, `boot ${JSON.stringify(results.boot)}`);
  g.check(part, results.diagnosis === "reset-broken", `${broken.attempt}: diagnosis reset-broken`, `diagnosis ${results.diagnosis}`);
  g.check(
    part,
    results.groups.length === manifest.length && results.groups.every((group) => group.passed === 0 && group.score === 0 && group.hookFailed > 0),
    `${broken.attempt}: every group 0, every group with tests failed in beforeEach`,
    JSON.stringify(results.groups.map((group) => ({ file: group.file, passed: group.passed, score: group.score, hookFailed: group.hookFailed }))),
  );
  await rows(g, part, broken.attempt, manifest.map(() => 0), (i, cell) => {
    const head = `0/${manifest[i].tests} passed; POST /reset does not answer 200`;
    return cell.startsWith(head) ? null : `expected it to start ${JSON.stringify(head)}`;
  });
}

async function httpStatus(url: string): Promise<number | string> {
  try {
    const reply = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(HTTP_MS) });
    await reply.body?.cancel().catch(() => {});
    return reply.status;
  } catch (error) {
    return message(error);
  }
}

/**
 * The containers labelled with one of `owners` as their owner pid, or `null`
 * when docker cannot say. One `docker ps` however many owners there are —
 * label filters on one key AND together, so they cannot ask for several pids
 * — with everything not ours dropped by `parseOwnedContainers`.
 */
function containersOwnedBy(owners: ReadonlySet<number>, timeoutMs: number = DOCKER_CLI_TIMEOUT_MS): OwnedContainer[] | null {
  const list = defaultDockerRun(["ps", "-a", "--filter", `label=${LABEL_OWNER}`, "--format", OWNED_CONTAINERS_FORMAT], timeoutMs);
  if (list.error !== undefined || list.status !== 0) return null;
  return parseOwnedContainers(list.stdout ?? "", owners);
}

function servingAttempt(g: Gate): void {
  g.stage(SERVE_ATTEMPT, (dir) => stageServeAttempt(REPO_ROOT, dir));
}

async function servePart(g: Gate): Promise<void> {
  const part = "serve";
  servingAttempt(g);
  const root = g.rootPath();
  const t0 = performance.now();
  const serve = startCli(g, "serve-attempt", ["scripts/serve-attempt.ts", "--attempt", SERVE_ATTEMPT, "--root", root, "--ignore-run-json"]);
  handles.add(serve);
  try {
    let state: ServeState | null = null;
    const deadline = performance.now() + SERVE_READY_MS;
    while (performance.now() < deadline && isLive(serve.child)) {
      g.guard();
      state = readServeState(root);
      if (state?.status === "ready") break;
      await sleep(SERVE_POLL_MS);
    }
    if (state?.status !== "ready") {
      const why = isLive(serve.child) ? `not ready within ${seconds(SERVE_READY_MS)}` : `serve-attempt ended first (${describeExit(await serve.done)})`;
      g.fail(part, `${SERVE_ATTEMPT}: state file reached status "ready": ${why}`);
      return;
    }
    g.ok(part, `${SERVE_ATTEMPT}: state file reached status "ready" (${seconds(performance.now() - t0)})`);
    g.check(part, state.pid === serve.child.pid, `state file names the serve-attempt child (pid ${state.pid})`, `the child is pid ${serve.child.pid}`);
    g.check(part, state.backend === "ok", "backend ok", `backend ${JSON.stringify(state.backend)}`);
    g.check(part, state.frontend === "ok", "frontend ok", `frontend ${JSON.stringify(state.frontend)}`);
    g.check(part, state.container !== null, `serving container ${state.container}`, "container is null");
    g.check(part, state.image === g.imageRef, `image ${state.image}`, `expected ${g.imageRef}`);
    const pins = referencePins(REPO_ROOT);
    const unpinned = pins.filter((pin) => !state.pipFreeze.includes(pin));
    g.check(part, pins.length > 0 && unpinned.length === 0, `pip freeze has the reference's ${pins.join(", ")}`, `missing ${unpinned.join(", ")} from ${JSON.stringify(state.pipFreeze)}`);
    const url = state.url;
    if (g.check(part, url !== null && new URL(url).port === String(FRONTEND_PORT), `dev server at ${url}`, `expected port ${FRONTEND_PORT}`) && url !== null) {
      const page = await httpStatus(url);
      g.check(part, page === 200, `${url} answers 200`, `it answered ${page}`);
      const proxied = await httpStatus(new URL("/api/v1/health", url).href);
      g.check(part, typeof proxied === "number" && proxied >= 200 && proxied < 300, "the frontend's /api proxy reaches the backend's /health", `it answered ${proxied}`);
    }
    const health = await httpStatus(`http://127.0.0.1:${BACKEND_PORT}/api/v1/health`);
    g.check(part, typeof health === "number" && health >= 200 && health < 300, `http://127.0.0.1:${BACKEND_PORT}/api/v1/health answers ${health}`, `it answered ${health}`);

    const stop = await runCli(g, "serve-attempt --stop", ["scripts/serve-attempt.ts", "--stop", "--root", root], STOP_CHILD_MS);
    g.check(part, stop.code === 0, "serve-attempt --stop exited 0", describeExit(stop));
    // `--stop` cleans up after an owner that exited leaving its state file, so
    // "state file gone, no container left" alone would pass a serve-attempt
    // whose own SIGTERM teardown removed nothing. This line is the path on
    // which it tore itself down.
    const stoppedLine = `stopped pid ${serve.child.pid}`;
    g.check(
      part,
      stop.stdout.split("\n").some((line) => line.trim() === stoppedLine),
      `serve-attempt tore itself down on SIGTERM (--stop: "${stoppedLine}")`,
      "--stop printed no such line: it cleaned up after serve-attempt instead (see its output above)",
    );
    const ended = (await within(serve.done, SERVE_EXIT_MS)) !== null;
    const code = serve.child.exitCode;
    g.check(part, ended && code === 143, `serve-attempt exited 143 (SIGTERM from --stop)`, ended ? `it exited ${code ?? serve.child.signalCode}` : `still running after ${seconds(SERVE_EXIT_MS)}`);
    g.check(part, !existsSync(statePath(root)), "the state file is gone", `${statePath(root)} is still there`);
    const left = serve.child.pid === undefined ? [] : containersOwnedBy(new Set([serve.child.pid]));
    g.check(part, left !== null && left.length === 0, "no container of serve-attempt's remains", left === null ? "docker ps failed" : left.map((c) => c.name).join(", "));
    // Reported here: the leakCheck after this part removes them, without a second FAIL.
    for (const container of left ?? []) g.reported.add(leftoverKey("container", container.name));
    if (state.viteGroup !== null) {
      g.check(part, !groupAlive(state.viteGroup), `Vite group ${state.viteGroup} is gone`, "it is still alive");
    }
  } finally {
    // Whatever failed above, nothing of this part outlives it.
    await serveTeardown({
      interrupted: () => g.interrupted(),
      childLive: () => isLive(serve.child),
      terminate: () => terminate(g, serve),
      stateLeft: () => existsSync(statePath(root)),
      stop: () => runCli(g, "serve-attempt --stop", ["scripts/serve-attempt.ts", "--stop", "--root", root], STOP_CHILD_MS, { duringCleanup: true }),
    });
    if (!isLive(serve.child)) handles.delete(serve);
  }
}

/**
 * The serve part's own teardown: the child (which tears itself down on
 * SIGTERM), then — if its state file is still there — `--stop`, which removes
 * a dead owner's containers and Vite group. After a signal the cleanups do
 * both instead, and that holds for a signal that lands while the child is
 * being stopped too: a `--stop` from here would race the cleanup's own.
 */
export async function serveTeardown(steps: {
  interrupted: () => boolean;
  childLive: () => boolean;
  terminate: () => Promise<void>;
  stateLeft: () => boolean;
  stop: () => Promise<unknown>;
}): Promise<void> {
  if (steps.interrupted()) return;
  if (steps.childLive()) await steps.terminate();
  if (!steps.interrupted() && steps.stateLeft()) await steps.stop();
}

async function screenshotsPart(g: Gate): Promise<void> {
  const part = "screenshots";
  servingAttempt(g);
  const root = g.rootPath();
  const t0 = performance.now();
  const run = await runCli(g, "take-screenshots", ["scripts/take-screenshots.ts", "--root", root, "--only", SERVE_BENCHMARK_ID, "--force"], SCREENSHOTS_CHILD_MS);
  g.check(part, run.code === 0 && !run.timedOut, `take-screenshots exited 0 (${seconds(performance.now() - t0)})`, describeExit(run));
  // Exit 0 also covers a backend stop (the frontend photographed without
  // data, with a warning) — for the reference that would be a harness fault.
  const warned = run.stdout.split("\n").filter((line) => line.startsWith(`  ! ${SERVE_ATTEMPT}: `));
  g.check(
    part,
    /^Successes: 1$/m.test(run.stdout) && warned.length === 0,
    "its summary: one success, no warning",
    warned.length > 0 ? warned.join(" / ").trim() : "no \"Successes: 1\" line in its output",
  );
  const path = join(root, SCREENSHOT_PATH);
  let bytes: Buffer | null = null;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    g.fail(part, `${SCREENSHOT_PATH} was written: ${message(error)}`);
  }
  if (bytes !== null) {
    g.check(part, bytes.length > 0, `${SCREENSHOT_PATH} is ${bytes.length} bytes`, "it is empty");
    let size: { width: number; height: number } | string;
    try {
      size = pngDimensions(bytes);
    } catch (error) {
      size = message(error);
    }
    g.check(
      part,
      typeof size !== "string" && size.width === SCREENSHOT_SIZE.width && size.height === SCREENSHOT_SIZE.height,
      `its IHDR says ${typeof size === "string" ? "?" : `${size.width}x${size.height}`}`,
      typeof size === "string" ? size : `expected ${SCREENSHOT_SIZE.width}x${SCREENSHOT_SIZE.height}`,
    );
  }
  const left = run.pid === null ? [] : containersOwnedBy(new Set([run.pid]));
  g.check(part, left !== null && left.length === 0, "no container of take-screenshots' remains", left === null ? "docker ps failed" : left.map((c) => c.name).join(", "));
  // Reported here: the leakCheck after this part removes them, without a second FAIL.
  for (const container of left ?? []) g.reported.add(leftoverKey("container", container.name));
}

// ---------------------------------------------------------------------------
// preconditions, the end-of-run check, cleanups

/**
 * Why the screenshots part cannot run here, or `null`: `launch` — take-screenshots'
 * own `launchChromium` — once, and the browser closed again. Only a launch
 * tests what that launch needs: since Playwright 1.49 a headless launch runs
 * the `chromium-headless-shell` build, not the `chromium` one
 * `executablePath()` names, and the host's system libraries matter as much.
 */
export async function chromiumProblem(launch: () => Promise<{ close(): Promise<void> }>): Promise<string | null> {
  let browser: { close(): Promise<void> };
  try {
    browser = await launch();
  } catch (error) {
    // Playwright's own first lines say what is missing; its banner follows.
    const flat = message(error)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .join(" / ");
    const said = flat.length <= STDERR_QUOTE_CHARS ? flat : `${flat.slice(0, STDERR_QUOTE_CHARS)}…`;
    return (
      `the screenshots part needs the Chromium take-screenshots launches, and launching it failed: ${said}. ` +
      "Run `npx playwright install chromium` (and `npx playwright install-deps chromium` if it names missing libraries); no part was started."
    );
  }
  try {
    await browser.close();
  } catch {
    // It launched, which is what was asked.
  }
  return null;
}

/** The Chromium the preconditions launch, while they may have one open: what a signal's cleanup closes. */
export interface PreconditionBrowser {
  launching: Promise<{ close(): Promise<void> }> | null;
}

/** How long a signal's cleanup waits for a launch still in flight before it leaves the browser to its closing pipe. */
const PRECONDITION_LAUNCH_WAIT_MS = 30_000;

/**
 * A signal's cleanup for the Chromium check: waits for a launch in flight and
 * closes what it started. `CHROMIUM_LAUNCH_OPTIONS` turn Playwright's own
 * signal handlers off, so nothing else would. Never throws; a second close
 * after `chromiumProblem`'s own is harmless.
 */
export async function closePreconditionBrowser(pre: PreconditionBrowser): Promise<void> {
  if (pre.launching === null) return;
  let browser: { close(): Promise<void> } | null;
  try {
    browser = await within(pre.launching, PRECONDITION_LAUNCH_WAIT_MS);
  } catch {
    return; // the launch failed: nothing is open
  }
  try {
    await browser?.close();
  } catch {
    // already closed
  }
}

/**
 * Why no part may start (`message`), or the image every part runs by: tag,
 * `<tag>@<Id>` and the bare Id. Starts nothing but the Chromium it launches
 * and closes when `screenshots` will run, recorded in `pre` for the signal's
 * cleanup.
 */
async function preconditions(parts: readonly Part[], pre: PreconditionBrowser): Promise<{ message: string } | { tag: string; ref: string; id: string }> {
  if (parts.includes("serve") || parts.includes("screenshots")) {
    const busy = await busyPorts([BACKEND_PORT, FRONTEND_PORT]);
    if (busy.length > 0) {
      return {
        message:
          `gate 3a needs host ports ${BACKEND_PORT} and ${FRONTEND_PORT} free for its serve and screenshots parts — the run ` +
          `contract's ports, which serve-attempt and take-screenshots bind — and ${busy.join(" and ")} ${busy.length === 1 ? "is" : "are"} taken. ` +
          "Free them and run it again; nothing was started. (`--only image --only contract --only stops` runs the rest, and records nothing.)",
      };
    }
  }
  if (parts.includes("screenshots")) {
    // Imported here: loading take-screenshots loads Playwright, which no other part needs.
    const { launchChromium } = await import("./take-screenshots");
    const launching = (pre.launching = launchChromium());
    const problem = await chromiumProblem(() => launching);
    if (problem !== null) return { message: problem };
  }
  let tag: string;
  let image: { ref: string; id: string };
  try {
    tag = readScoringImage(REPO_ROOT);
    image = resolveImageId(tag);
  } catch (error) {
    return { message: `gate 3a needs the harness image benchmark/runner.yaml names, built as images/harness/IMAGE.md describes: ${message(error)}` };
  }
  return { tag, ...image };
}

/** Owned leftovers: a container this run's pids own, and either the gate's own or labelled with an attempt it staged. */
function isOurs(g: Gate, container: { name: string; attempt: string }): boolean {
  return container.name.startsWith(`agrav-gate-image-${process.pid}-`) || g.staged.has(container.attempt);
}

/**
 * Nothing of this run's pids is left: no container labelled with one of them,
 * no scratch directory of theirs in the temp directory, and nothing a child's
 * dead-owner sweep removed on their behalf. Run after every part — before the
 * next part's `serve-attempt` or `take-screenshots` sweeps it away — and once
 * more at the end. A leftover is a FAIL of the part it is found after, once;
 * seen again, it is named as already reported (`leakVerdict`), and `ok` is
 * printed only when nothing at all was listed. A leftover container that is
 * the gate's own or labelled with an attempt it staged is removed (a scratch
 * directory is kept for inspection, and the next sweep takes it). True when
 * docker could be asked and listed none.
 */
function leakCheck(g: Gate, part: string): boolean {
  const containers = containersOwnedBy(g.ownerPids);
  if (containers === null) g.fail(part, `could not list the containers labelled ${LABEL_OWNER} (docker ps failed)`);

  const tmp = tmpdir();
  let dirs: Array<{ entry: string; owner: number }> | null = null;
  try {
    dirs = scratchDirsOwnedBy(tmp, g.ownerPids);
  } catch (error) {
    g.fail(part, `could not list ${tmp}: ${message(error)}`);
  }

  const verdict = leakVerdict({
    children: g.ownerPids.size - 1,
    containers:
      containers?.map((container) => ({
        key: leftoverKey("container", container.name),
        what: `container ${container.name} of ${g.ownerName(container.owner)}`,
      })) ?? null,
    dirs:
      dirs?.map(({ entry, owner }) => ({
        key: leftoverKey("scratch directory", entry),
        what: `scratch directory ${join(tmp, entry)} of ${g.ownerName(owner)}`,
      })) ?? null,
    swept: g.swept.splice(0),
    reported: g.reported,
  });
  for (const key of verdict.newlyReported) g.reported.add(key);
  if (verdict.fail !== null) g.fail(part, verdict.fail);
  if (verdict.alreadyReported !== null) g.note(part, verdict.alreadyReported);
  if (verdict.ok !== null) g.ok(part, verdict.ok);
  for (const container of containers ?? []) {
    if (!isOurs(g, container)) continue;
    const removal = ensureContainerRemoved(container.name, { consequence: `Remove it with \`docker rm -f ${container.name}\`.` });
    console.log(`      ${removal.removed ? "removed" : "could not remove"} ${container.name}: ${removal.detail}`);
  }
  return containers !== null && containers.length === 0;
}

/** After every run: the last `leakCheck`, the gate's own scratch directories removed, and the ports free again. */
async function finalCheck(g: Gate, served: boolean): Promise<void> {
  const part = "afterwards";
  const clean = leakCheck(g, part);
  for (const dir of [...g.scratchDirs]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      g.scratchDirs.delete(dir);
    } catch (error) {
      g.fail(part, `could not remove the scratch directory ${dir}: ${message(error)}`);
    }
  }

  if (served) {
    const busy = await busyPorts([BACKEND_PORT, FRONTEND_PORT]);
    g.check(part, busy.length === 0, `ports ${BACKEND_PORT} and ${FRONTEND_PORT} free again`, `${busy.join(", ")} still taken`);
  }
  g.verifiedClean = clean;
}

/** Remove each directory on its own, so one that cannot go does not keep the rest. */
function removeDirs(dirs: Iterable<string>): void {
  for (const dir of [...dirs]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      console.error(`backend-gate: could not remove ${dir}: ${message(error)}`);
    }
  }
}

/** The first signal's cleanups, in order, each try/caught by `installInterruptHandlers`. */
function signalCleanups(g: Gate): Array<() => Promise<void> | void> {
  return [
    async () => {
      await Promise.all([...handles].map((handle) => terminate(g, handle)));
    },
    async () => {
      if (g.root === null || !existsSync(statePath(g.root))) return;
      console.error("backend-gate: a serve-attempt state file is left; running serve-attempt --stop");
      await runCli(g, "serve-attempt --stop", ["scripts/serve-attempt.ts", "--stop", "--root", g.root], STOP_CHILD_MS, { duringCleanup: true });
    },
    () => {
      for (const name of [...g.containers]) {
        const removal = ensureContainerRemoved(name, { consequence: `Remove it with \`docker rm -f ${name}\`.` });
        if (removal.removed) g.containers.delete(name);
        else console.error(`backend-gate: ${removal.detail}`);
      }
    },
    () => {
      for (const container of containersOwnedBy(g.ownerPids) ?? []) {
        if (!isOurs(g, container)) continue;
        const removal = ensureContainerRemoved(container.name, { consequence: `Remove it with \`docker rm -f ${container.name}\`.` });
        if (!removal.removed) console.error(`backend-gate: ${removal.detail}`);
      }
    },
    () => removeDirs(g.scratchDirs),
    () => {
      if (g.root !== null) rmSync(g.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    },
  ];
}

/** From the `exit` listener: synchronous, bounded, best effort. */
function exitCleanups(g: Gate): Array<() => void> {
  return [
    () => {
      // A child not yet signalled tears itself down on SIGTERM, detached, after the gate is gone.
      for (const handle of handles) {
        const { child } = handle;
        if (!isLive(child) || child.pid === undefined || g.signalled.has(child)) continue;
        g.signalled.add(child);
        try {
          process.kill(child.pid, "SIGTERM");
        } catch {
          // gone
        }
      }
    },
    () => {
      if (g.verifiedClean) return;
      const names = new Set(g.containers);
      for (const container of containersOwnedBy(g.ownerPids, EXIT_DOCKER_LIST_MS) ?? []) if (isOurs(g, container)) names.add(container.name);
      for (const name of names) defaultDockerRun(["rm", "-f", name], EXIT_DOCKER_RM_MS);
    },
    () => {
      // Kept on a failed run for inspection; an interrupted one — a second
      // signal cutting the cleanups short included — leaves nothing to inspect.
      if (g.interrupted() && g.root !== null) rmSync(g.root, { recursive: true, force: true });
    },
    () => removeDirs(g.scratchDirs),
  ];
}

// ---------------------------------------------------------------------------
// main

const USAGE = `Usage: node --import tsx scripts/backend-gate.ts [--only <part>]...

Gate 3a: the harness image, contract-tests, the backend stops, serve-attempt
and take-screenshots, on synthetic attempts in a temporary --root.

  --only <part>   Run only this part; repeatable. Parts, in order:
                  ${PARTS.join(", ")}.
                  Any --only records nothing.
  --help          Print this message.

Needs Docker with the harness image built, network for pip and npm, and —
for serve and screenshots — host ports ${BACKEND_PORT} and ${FRONTEND_PORT} free and
Playwright's Chromium. A complete passing run records ${GATE_3_RESULT_PATH}.

Exit 0: every part passed. 1: a check failed, or a precondition did not hold
(no part started). 2: usage. 128+N: interrupted.
`;

async function main(argv: string[]): Promise<number> {
  let args: GateArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`backend-gate: ${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const parts = selectedParts(args.only);
  const record = args.only.length === 0;

  // Installed before the preconditions: the Chromium check launches a browser
  // Playwright will not close on a signal, so a Ctrl-C during it must reach a
  // cleanup that does. The gate's own cleanups join once the gate exists; the
  // handlers read both lists when a signal or the exit arrives.
  const cleanups: Array<() => Promise<void> | void> = [];
  const atExit: Array<() => void> = [];
  const pre: PreconditionBrowser = { launching: null };
  cleanups.push(() => closePreconditionBrowser(pre));
  const handlers = installInterruptHandlers({ cleanups, exitCleanups: atExit });

  const ready = await preconditions(parts, pre);
  if (handlers.interrupted() !== null) return new Promise<number>(() => {}); // the handler closes the browser and exits 128+N
  if ("message" in ready) {
    console.error(`backend-gate: ${ready.message}`);
    return 1;
  }
  const manifest = loadManifest(REPO_ROOT);
  const fingerprintAtStart = gate3Fingerprint(REPO_ROOT);

  const g = new Gate(ready.tag, ready.ref, ready.id);
  g.handlers = handlers;
  cleanups.push(...signalCleanups(g));
  atExit.push(...exitCleanups(g));
  g.root = mkdtempSync(join(tmpdir(), "agrav-gate-3a-"));
  mkdirSync(join(g.root, "eval-attempts"));
  mkdirSync(join(g.root, "eval-results"));
  console.log(`gate 3a: ${parts.join(", ")} in ${ready.ref}`);
  console.log(`temporary root: ${g.root}  (gate pid ${process.pid})`);

  const facts: Facts = {};
  const timings: string[] = [];
  const run: Record<Part, () => Promise<void>> = {
    image: () => imagePart(g, facts),
    contract: () => contractPart(g, facts, manifest),
    stops: () => stopsPart(g, manifest),
    serve: () => servePart(g),
    screenshots: () => screenshotsPart(g),
    fuzz: () => fuzzPart(g, facts),
  };
  for (const part of parts) {
    if (g.interrupted()) break;
    console.log(`\n== ${part} ==`);
    const before = g.problems;
    const t0 = performance.now();
    try {
      await run[part]();
    } catch (error) {
      if (!(error instanceof Interrupted)) g.fail(part, `stopped by an error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    }
    // Now, not only at the end: the next part's serve-attempt or
    // take-screenshots would sweep away what this part's children left.
    if (!g.interrupted()) leakCheck(g, part);
    if (g.interrupted()) {
      console.log(`-- ${part}: interrupted after ${seconds(performance.now() - t0)}`);
      break;
    }
    const line = `-- ${part}: ${g.problems === before ? "passed" : `FAILED (${g.problems - before} problem(s))`} in ${seconds(performance.now() - t0)}`;
    timings.push(line);
    console.log(line);
  }
  if (g.interrupted()) return new Promise<number>(() => {}); // the handler finishes the cleanup and exits 128+N

  console.log("\n== afterwards ==");
  await finalCheck(g, parts.includes("serve") || parts.includes("screenshots"));
  if (g.interrupted()) return new Promise<number>(() => {});

  // The verdict first — the record's own conditions included — and only then
  // the root: a run that fails at any step keeps it.
  const result = record && g.problems === 0 ? recordFor(g, facts, parts, fingerprintAtStart) : null;

  console.log("");
  for (const line of timings) console.log(line);
  const root = g.rootPath();
  if (g.problems === 0) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      console.log(`removed ${root}`);
    } catch (error) {
      g.fail("afterwards", `could not remove the temporary root: ${message(error)}`);
    }
  }
  if (g.problems > 0) console.log(`kept ${root} for inspection`);

  if (result !== null && g.problems === 0) {
    try {
      writeFileSync(join(REPO_ROOT, GATE_3_RESULT_PATH), `${JSON.stringify(result, null, 2)}\n`);
      console.log(`\nrecorded ${GATE_3_RESULT_PATH}`);
    } catch (error) {
      g.fail("record", `could not write ${GATE_3_RESULT_PATH}: ${message(error)}`);
    }
  }
  console.log(g.problems === 0 ? "\ngate 3a passed" : `\ngate 3a FAILED: ${g.problems} problem(s)`);
  return g.problems === 0 ? 0 : 1;
}

/** The record a complete passing run writes, or `null` after a FAIL saying why it may not be written. Writes nothing. */
function recordFor(g: Gate, facts: Facts, parts: readonly Part[], fingerprintAtStart: string): Gate3Result | null {
  let fingerprint: string;
  try {
    fingerprint = gate3Fingerprint(REPO_ROOT);
  } catch (error) {
    g.fail("record", `could not fingerprint the gate-3a inputs: ${message(error)}`);
    return null;
  }
  if (fingerprint !== fingerprintAtStart) {
    g.fail("record", "a gate-3a input changed while the gate ran; run it again");
    return null;
  }
  if (
    facts.python === undefined ||
    facts.agy === undefined ||
    facts.reference === undefined ||
    facts.hardcodedPlan === undefined ||
    facts.fuzzOracle === undefined
  ) {
    g.fail("record", "a part passed without the facts the record needs");
    return null;
  }
  return {
    fingerprint,
    recordedAt: new Date().toISOString(),
    image: g.imageRef,
    python: facts.python,
    agy: facts.agy,
    node: process.version,
    parts: [...parts],
    reference: facts.reference,
    hardcodedPlan: facts.hardcodedPlan,
    fuzzOracle: facts.fuzzOracle,
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(`backend-gate: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      process.exit(1);
    },
  );
}
