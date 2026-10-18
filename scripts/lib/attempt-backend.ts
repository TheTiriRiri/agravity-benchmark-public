/**
 * One attempt's backend, run from the harness image: the only implementation,
 * with three callers — `contract-tests` (the hidden tests, on an ephemeral host
 * port), `serve-attempt` and `take-screenshots` (on 127.0.0.1:5100).
 *
 * The lifecycle, and who decides what (spec §5, "Backend runner" and "Failure
 * taxonomy"):
 *
 * 1. `checkLayout()` — on the host, before any container: `backend/`,
 *    `backend/requirements.txt`, `backend/app/main.py`. Missing → a `layout`
 *    stop. Checking here, not through docker's exit codes, is what keeps a
 *    docker error meaning a harness fault.
 * 2. `install()` — `python3 -m venv` into a scratch directory the harness owns
 *    (it never reads the attempt, so its failure is infra), then `pip install
 *    -r requirements.txt` with `LIMITS.pipInstallMs`. A failed or timed-out
 *    install whose output carries a network-error signature (timeout, reset,
 *    DNS — `NETWORK_ERROR_RE`) is retried once in a fresh container but the
 *    same venv; if the retry succeeds the result is ok. The signature only
 *    triggers the retry, it does not decide blame. Any final failed install
 *    (whether on first attempt or after retry) is the model's (`install`) only
 *    if a PyPI probe from the same image then succeeds; otherwise PyPI was
 *    unreachable and it is infra. One whose output says the disk is full is
 *    infra before any retry or probe. A venv with no `bin/uvicorn` afterwards
 *    is an `install` stop too.
 * 3. `start()` — one detached serving container; its host port is always read
 *    back with `docker port`, never assumed; then `GET /api/v1/health` every
 *    `LIMITS.healthPollMs` (each bounded to `LIMITS.healthProbeMs`) until a
 *    2xx or `LIMITS.healthMs`, with `docker inspect` each round. Exited first
 *    → `boot`; no 2xx in time → `health`. `servingState()` asks again later:
 *    whether the container is still running, exited, or vanished.
 * 4. `stop()` / `dispose()` — `rm -f` and proof of removal.
 *
 * Every container — venv, install, probe, freeze, serving — is named
 * `agrav-backend-<attempt>-<pid>-<n>`, labelled with its role, attempt and
 * owner pid, and registered BEFORE its `docker run`. None is `--rm` (a crashed
 * backend's log is its `boot` detail), so each one is removed on every path,
 * and only "no such container" proves it gone. A container that cannot be
 * proven gone is infra: it may still hold a port or mount the scratch
 * directory, which is therefore kept. Killing a docker client does not stop
 * its container, and a detached server never exits on its own.
 *
 * Signals: this module installs no process handler. An entry script passes
 * `stopAllBackends` to `installInterruptHandlers`' cleanups and
 * `stopAllBackendsSync` to its `exitCleanups`; both reach every backend
 * through a module-level registry that a backend joins in its constructor —
 * before it owns anything — and leaves only once shut down with nothing left
 * to remove. A backend that has been stopped that way, or disposed, starts no
 * container again, and every step re-checks that after each thing it awaits
 * and before it classifies anything, so a caller still running when the
 * signal lands can neither leak a container nor turn the shutdown into a
 * model stop. A SIGKILLed owner leaves containers and a scratch directory
 * behind that `sweepDeadOwners({role: "backend"})` removes on the next run.
 *
 * The container's environment is fixed: the five PYTHON/PIP variables below
 * and `HOME`, nothing passed through. No credentials volume, never `~/.gemini`.
 * The attempt is mounted read-only; the default bridge network gives `pip`
 * egress.
 *
 * Classification is harness code: gate 3a covers it, the rubric id does not.
 * The numbers that decide a score (`pipInstallMs`, `healthMs`,
 * `healthProbeMs`, `healthPollMs`, `pypiProbeMs`) come from `rubric.ts`'s
 * `LIMITS`, which the rubric id does cover. Every model stop's detail goes
 * through `contract-results.ts`'s `stoppedBoot`, so none is ever empty.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { ATTEMPT_DIR_RE } from "./attempts";
import { stoppedBoot, type BootStage } from "./contract-results";
import {
  CONTAINER_NAME_RE,
  type ContainerRemoval,
  DOCKER_CLI_TIMEOUT_MS,
  defaultDockerRun,
  describeCall,
  ensureContainerRemoved,
  LABEL_ATTEMPT,
  LABEL_OWNER,
  LABEL_ROLE,
  saysNoSuchContainer,
  scratchDirPrefix,
  succeeded,
  userSpec,
} from "./docker";
import { detectInterrupt, type InterruptSignal } from "./interrupt";
import { parsePytestSummary, type ParsedPytestSummary } from "./pytest-summary";
import { LIMITS, type Limits } from "./rubric";
import { stderrTail } from "./run-json";

export type { ContainerRemoval } from "./docker";

/** `ephemeral` publishes `127.0.0.1::5100` (contract-tests); `5100` publishes `127.0.0.1:5100:5100`. */
export type HostPort = "ephemeral" | 5100;

/** Which container a name was registered for. */
export type ContainerPurpose = "venv" | "install" | "probe" | "freeze" | "serve" | "pytest";

export interface BackendOptions {
  /** The attempt directory on the host; mounted read-only at `/workspace`. */
  attemptDir: string;
  /** Its name, `<id>-attempt-<n>`: the `agrav.attempt` label and part of every container name. */
  attemptName: string;
  /**
   * The harness image, by its bare Id (`sha256:…`): callers resolve
   * `readScoringImage`'s tag with `resolveImageRef` once and pass the Id, so a
   * retag during a run cannot change what later containers run. Never pulled
   * (`--pull never`).
   */
  image: string;
  hostPort: HostPort;
  /** Where the scratch directory is created. Default `os.tmpdir()`, as `sweepDeadOwners` assumes. */
  tmpRoot?: string;
  /** Tests only: shorter limits. Production always uses rubric.ts's LIMITS. No CLI exposes this. */
  limits?: Partial<Limits>;
  /**
   * Called with each container's name after it is registered and before its
   * `docker run` — so a caller can record a name before the container can
   * exist. A throw propagates out of the step that was starting it.
   * `scratchDir` is the backend's scratch directory, which exists by then and
   * which the container mounts.
   */
  onContainer?: (name: string, purpose: ContainerPurpose, scratchDir: string) => void;
}

export type StepResult = { kind: "ok" } | { kind: "stop"; stage: BootStage; detail: string } | { kind: "infra"; detail: string };

export type StartResult =
  | { kind: "ready"; baseUrl: string; container: string }
  | { kind: "stop"; stage: BootStage; detail: string }
  | { kind: "infra"; detail: string };

export interface PytestResult {
  ran: boolean;
  timedOut: boolean;
  exitCode: number | null;
  passed: number;
  failed: number;
  errors: number;
  durationMs: number;
  outputTail: string;
  notRunReason: string | null;
}

export type PytestStepResult =
  | { kind: "complete"; result: PytestResult }
  | { kind: "infra"; detail: string }
  | { kind: "interrupted"; signal: InterruptSignal };

export type { ParsedPytestSummary };
export { parsePytestSummary };

/** A harness fault outside the `StepResult` methods (`pipFreeze`). Nothing about it is the model's. */
export class BackendInfraError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackendInfraError";
  }
}

// ---------------------------------------------------------------------------
// constants

/** The `agrav.role` label value; what `sweepDeadOwners({role})` selects on. */
export const BACKEND_ROLE = "backend";

const SCORING_MOUNT = "/scoring";
const VENV = `${SCORING_MOUNT}/venv`;
const PIP = `${VENV}/bin/pip`;
const UVICORN = `${VENV}/bin/uvicorn`;
const PYTEST = `${VENV}/bin/pytest`;
export const PYTEST_TIMEOUT_MS = 300_000;
export const PYTEST_OUTPUT_TAIL_LIMIT = 2000;
/** `HOME` in every container: beside the venv, on a tmpfs when serving. */
export const CONTAINER_HOME = `${SCORING_MOUNT}/home`;
const WORKSPACE = "/workspace";
const BACKEND_WORKDIR = `${WORKSPACE}/backend`;

/** The whole environment of every container, in order. There is no pass-through. */
export const BACKEND_ENV: readonly string[] = Object.freeze([
  "PYTHONDONTWRITEBYTECODE=1",
  "PYTHONUNBUFFERED=1",
  "PIP_NO_CACHE_DIR=1",
  "PIP_DISABLE_PIP_VERSION_CHECK=1",
  "PIP_NO_INPUT=1",
  `HOME=${CONTAINER_HOME}`,
]);

/** Arguments to the serving container's `uvicorn`, as the run contract states them. */
export const SERVE_COMMAND: readonly string[] = Object.freeze(["app.main:app", "--host", "0.0.0.0", "--port", "5100"]);
/** The PyPI probe fetches this one wheel: it touches pypi.org and files.pythonhosted.org both. */
export const PROBE_REQUIREMENT = "fastapi==0.115.14";
/** A fork-bomb guard on the serving container, far above what uvicorn needs. No memory limit. */
export const SERVE_PIDS_LIMIT = 512;

export const HEALTH_PATH = "/api/v1/health";
/** `python3 -m venv`; harness-owned, so reaching it is infra, not a score. */
export const VENV_TIMEOUT_MS = 120_000;
/** `pip freeze`; harness-owned, likewise. */
export const FREEZE_TIMEOUT_MS = 60_000;
/** `docker logs --tail` for a `boot` detail, then bounded like `stderrTail`. */
export const LOG_TAIL_LINES = 50;
export const LOG_TAIL_BYTES = 4096;
/** How much of a foreground container's stdout and stderr is kept, each. */
const OUTPUT_KEEP_BYTES = 256 * 1024;
/** How many trailing lines of pip's output go into an `install` detail. */
const PIP_DETAIL_LINES = 20;
/** How long `dispose()` waits for a killed docker client to exit. */
const CLIENT_EXIT_WAIT_MS = 5_000;
/** docker's own failures: 125 daemon/CLI error, 126 cannot invoke, 127 not found. */
const DOCKER_ERROR_EXITS: ReadonlySet<number> = new Set([125, 126, 127]);
/**
 * What pip prints when the disk under the scratch directory is full. That disk
 * is the host's (the venv is written through the `/scoring` bind mount), so it
 * is the harness's fault whatever the requirements were — and the PyPI probe,
 * which downloads one small wheel into the container's own /tmp, can succeed
 * all the same.
 */
const DISK_FULL_RE = /\[Errno 28\]|No space left on device/;
/**
 * What pip and its vendored urllib3 / requests print on network faults:
 * timeouts, resets, incomplete reads, DNS failures. When this appears in the
 * output of a failed `pip install`, the install is retried once (in a fresh
 * container, the same venv). The signature triggers only a retry, never an
 * infra classification on its own: an attempt whose requirements.txt points to
 * an unresolvable or non-existent host also produces these errors, but that is
 * the model's fault (decided by the PyPI probe). The pattern has priority over
 * messages like "No matching distribution found", which pip also emits after
 * its own internal retries even when the initial cause was a network blip.
 */
const NETWORK_ERROR_RE =
  /ReadTimeoutError|ConnectTimeoutError|Read timed out|ProtocolError|IncompleteRead|Connection reset by peer|Connection aborted|Temporary failure in name resolution|NewConnectionError/;

/** Whether `output` contains a pip / urllib3 network-error signature. */
export function hasNetworkError(output: string): boolean {
  return NETWORK_ERROR_RE.test(output);
}

// ---------------------------------------------------------------------------
// argv builders — pure, exported for tests

export interface ArgvBase {
  /** The container's unique name. */
  name: string;
  image: string;
  /** Host path of the attempt directory. */
  attemptDir: string;
  attemptName: string;
  /** Host path of this backend's scratch directory: `/scoring` in the container. */
  scratchDir: string;
  /** The owner's pid: the `agrav.owner` label. */
  owner: number;
  /** `--user`, `<uid>:<gid>`. */
  user: string;
}

/** A host path for `-v`, which splits on `:`. */
function hostPath(path: string, what: string): string {
  if (!path.startsWith("/") || path.includes(":") || path.includes("\n")) {
    throw new Error(`${what} must be an absolute host path without ':' for docker -v, got ${JSON.stringify(path)}`);
  }
  return path;
}

function commonArgs(b: ArgvBase): string[] {
  if (!CONTAINER_NAME_RE.test(b.name)) throw new Error(`not a container name: ${JSON.stringify(b.name)}`);
  if (b.image === "" || b.image.startsWith("-") || /\s/.test(b.image)) throw new Error(`not an image reference: ${JSON.stringify(b.image)}`);
  if (!ATTEMPT_DIR_RE.test(b.attemptName)) throw new Error(`not an attempt directory name: ${JSON.stringify(b.attemptName)}`);
  if (!Number.isInteger(b.owner) || b.owner <= 0) throw new Error(`not an owner pid: ${b.owner}`);
  if (!/^\d+:\d+$/.test(b.user)) throw new Error(`--user must be <uid>:<gid>, got ${JSON.stringify(b.user)}`);
  return [
    "--init",
    "--pull",
    "never",
    "--name",
    b.name,
    "--label",
    `${LABEL_ROLE}=${BACKEND_ROLE}`,
    "--label",
    `${LABEL_ATTEMPT}=${b.attemptName}`,
    "--label",
    `${LABEL_OWNER}=${b.owner}`,
    "--user",
    b.user,
    ...BACKEND_ENV.flatMap((variable) => ["-e", variable]),
  ];
}

/** The scratch directory, writable, at `/scoring`; working directory `/scoring`. For the harness-owned steps. */
function scratchMount(b: ArgvBase): string[] {
  return ["-v", `${hostPath(b.scratchDir, "scratchDir")}:${SCORING_MOUNT}`, "-w", SCORING_MOUNT];
}

/** `python3 -m venv /scoring/venv`. Does not mount the attempt: it never reads it. */
export function venvArgs(b: ArgvBase): string[] {
  return ["run", ...commonArgs(b), ...scratchMount(b), "--entrypoint", "python3", b.image, "-m", "venv", VENV];
}

/** `pip install -r requirements.txt` from `/workspace/backend`, the attempt read-only. */
export function installArgs(b: ArgvBase): string[] {
  return [
    "run",
    ...commonArgs(b),
    "-v",
    `${hostPath(b.attemptDir, "attemptDir")}:${WORKSPACE}:ro`,
    "-v",
    `${hostPath(b.scratchDir, "scratchDir")}:${SCORING_MOUNT}`,
    "-w",
    BACKEND_WORKDIR,
    "--entrypoint",
    PIP,
    b.image,
    "install",
    "-r",
    "requirements.txt",
  ];
}

/** The PyPI probe: one pinned wheel, no deps, no cache, into the container's /tmp. */
export function probeArgs(b: ArgvBase): string[] {
  return [
    "run",
    ...commonArgs(b),
    ...scratchMount(b),
    "--entrypoint",
    PIP,
    b.image,
    "download",
    "--no-deps",
    "--no-cache-dir",
    "-d",
    "/tmp/agrav-probe",
    PROBE_REQUIREMENT,
  ];
}

/** `pip freeze` of the installed venv. */
export function freezeArgs(b: ArgvBase): string[] {
  return ["run", ...commonArgs(b), ...scratchMount(b), "--entrypoint", PIP, b.image, "freeze"];
}

/** `127.0.0.1::5100` (a port docker picks) or `127.0.0.1:5100:5100`. Always loopback. */
export function publishSpec(hostPort: HostPort): string {
  if (hostPort === "ephemeral") return "127.0.0.1::5100";
  if (hostPort === 5100) return "127.0.0.1:5100:5100";
  throw new Error(`hostPort must be "ephemeral" or 5100, got ${JSON.stringify(hostPort)}`);
}

/**
 * The detached serving container: the venv read-only, `HOME` on a tmpfs — so
 * nothing the backend writes survives a restart, which really returns it to
 * the seed — the attempt read-only, and `--pids-limit`.
 */
export function serveArgs(b: ArgvBase & { hostPort: HostPort }): string[] {
  return [
    "run",
    "-d",
    ...commonArgs(b),
    "--pids-limit",
    String(SERVE_PIDS_LIMIT),
    "--tmpfs",
    `${CONTAINER_HOME}:mode=1777`,
    "-v",
    `${hostPath(b.attemptDir, "attemptDir")}:${WORKSPACE}:ro`,
    "-v",
    `${hostPath(b.scratchDir, "scratchDir")}/venv:${VENV}:ro`,
    "-w",
    BACKEND_WORKDIR,
    "-p",
    publishSpec(b.hostPort),
    "--entrypoint",
    UVICORN,
    b.image,
    ...SERVE_COMMAND,
  ];
}

/** `pytest -q -p no:cacheprovider --color=no tests` from `/workspace/backend`, the attempt read-only. */
export function pytestArgs(b: ArgvBase): string[] {
  return [
    "run",
    ...commonArgs(b),
    "-v",
    `${hostPath(b.attemptDir, "attemptDir")}:${WORKSPACE}:ro`,
    "-v",
    `${hostPath(b.scratchDir, "scratchDir")}:${SCORING_MOUNT}`,
    "-w",
    BACKEND_WORKDIR,
    "--entrypoint",
    PYTEST,
    b.image,
    "-q",
    "-p",
    "no:cacheprovider",
    "--color=no",
    "tests",
  ];
}

/**
 * The host port from `docker port <name> 5100/tcp`: the first `127.0.0.1:<port>`
 * line, or `null`. Only a loopback mapping is accepted, since only one was asked for.
 */
export function parsePortMapping(stdout: string): number | null {
  for (const line of stdout.split("\n")) {
    const match = /^127\.0\.0\.1:(\d{1,5})$/.exec(line.trim());
    if (match === null) continue;
    const port = Number(match[1]);
    if (port >= 1 && port <= 65535) return port;
  }
  return null;
}

// ---------------------------------------------------------------------------
// helpers

function seconds(ms: number): string {
  return `${Math.round(ms / 100) / 10} s`;
}

/** The last `lines` non-empty lines of `text`, bounded to `LOG_TAIL_BYTES`. */
function lastLines(text: string, lines: number): string {
  const kept = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");
  return stderrTail(kept.slice(-lines).join("\n"), LOG_TAIL_BYTES);
}

/** Output first, the harness's own sentence last: Notes keep a detail's end. */
function withSummary(output: string, summary: string): string {
  return output === "" ? summary : `${output}\n${summary}`;
}

/** A model stop. Its detail is built by `stoppedBoot`, the one builder of a stop, so it is never empty. */
function modelStop(stage: BootStage, detail: string): { kind: "stop"; stage: BootStage; detail: string } {
  const boot = stoppedBoot(stage, detail);
  return { kind: "stop", stage: boot.stage, detail: boot.detail };
}

/** The last `max` bytes of a stream, without holding all of it. */
class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  constructor(private readonly max: number) {}
  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    if (this.size > 2 * this.max) {
      const all = Buffer.concat(this.chunks);
      const kept = all.subarray(all.length - this.max);
      this.chunks = [kept];
      this.size = kept.length;
    }
  }
  text(): string {
    const all = Buffer.concat(this.chunks);
    return (all.length > this.max ? all.subarray(all.length - this.max) : all).toString("utf8");
  }
}

interface ForegroundOutcome {
  /** Set when nothing was started because the backend had been shut down. */
  refused: boolean;
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError: Error | null;
  /** The container's removal, always attempted after the client exits. */
  removal: ContainerRemoval;
}

function outcomeOk(o: ForegroundOutcome): boolean {
  return !o.refused && o.spawnError === null && !o.timedOut && o.status === 0;
}

/** How a foreground container ended, for a detail. */
function describeOutcome(o: ForegroundOutcome, timeoutMs: number): string {
  if (o.refused) return "not started: the backend had been shut down";
  if (o.spawnError !== null) return `docker could not be started: ${o.spawnError.message}`;
  if (o.timedOut) return `did not finish within ${seconds(timeoutMs)}`;
  if (o.signal !== null) return `its docker client was killed by ${o.signal}`;
  return `exited ${o.status}`;
}

/**
 * A problem that is the harness's whatever the model did: refused, interrupted,
 * a client killed by a signal the harness did not send, docker's own error, an
 * unproven removal.
 */
function harnessFault(o: ForegroundOutcome, what: string, timeoutMs: number): string | null {
  if (!o.removal.removed) return `${what}: ${o.removal.detail}`;
  if (o.refused || o.spawnError !== null) return `${what} ${describeOutcome(o, timeoutMs)}`;
  const interrupt = o.timedOut ? null : detectInterrupt({ signal: o.signal, status: o.status });
  if (interrupt !== null) return `${what} was interrupted (${interrupt})`;
  // The client is always the harness's own process, and the harness kills it
  // only on a timeout (`timedOut`) or a shutdown (`closed`, checked by every
  // caller first): any other signal — the host's OOM killer, a stray kill, a
  // crash — is not the model's.
  if (!o.timedOut && o.signal !== null) return `${what}: its docker client was killed by ${o.signal}, which the harness did not send`;
  if (!o.timedOut && o.status !== null && DOCKER_ERROR_EXITS.has(o.status)) {
    return `docker could not run ${what} (exit ${o.status}): ${lastLines(o.stderr, 5) || "no message"}`;
  }
  return null;
}

type HealthAnswer = { ok: boolean; detail: string };

/**
 * One `GET /api/v1/health`, bounded to `timeoutMs` (`LIMITS.healthProbeMs`).
 * Redirects are followed, as the hidden tests' `call()` follows them: a
 * backend is ready when what the tests will see answers 2xx.
 */
async function probeHealth(baseUrl: string, timeoutMs: number): Promise<HealthAnswer> {
  try {
    const response = await fetch(`${baseUrl}${HEALTH_PATH}`, { signal: AbortSignal.timeout(timeoutMs) });
    try {
      await response.body?.cancel();
    } catch {
      // the answer's status is all that matters
    }
    return { ok: response.status >= 200 && response.status < 300, detail: `HTTP ${response.status}` };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    const cause = (err as { cause?: unknown }).cause;
    const message = cause instanceof Error ? `${(cause as NodeJS.ErrnoException).code ?? cause.name} ${cause.message}` : err.message;
    return { ok: false, detail: `${err.name}: ${message}` };
  }
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** `unknown` covers a container the daemon no longer knows (`missing`) and a daemon that could not say. */
type ContainerState = { kind: "running" } | { kind: "exited"; exitCode: number } | { kind: "unknown"; detail: string; missing: boolean };

/**
 * What became of the serving container while a caller used it (`servingState()`):
 * still running, exited — the backend's own crash, or the host's OOM killer —
 * or `vanished`, gone from the daemon, which only something outside the
 * harness does (`docker rm -f`, a daemon that lost it). `unknown` when there is
 * no serving container or docker could not say.
 */
export type ServingState =
  | { kind: "running" }
  | { kind: "exited"; exitCode: number }
  | { kind: "vanished" }
  | { kind: "unknown"; detail: string };

// ---------------------------------------------------------------------------
// the registry behind stopAllBackends / stopAllBackendsSync

interface RegistryEntry {
  closeSync(): void;
  dispose(): Promise<ContainerRemoval[]>;
}

/**
 * Every backend from its constructor until it is shut down with nothing left
 * to remove: no registered container, no in-flight docker client, no scratch
 * directory.
 */
const liveBackends = new Set<RegistryEntry>();
/** `<n>` in container names: unique within this process, across backends. */
let containerSequence = 0;

/**
 * For an `exit` listener: shut every backend down synchronously — kill any
 * in-flight docker client, `rm -f` and verify every registered container,
 * and remove each scratch directory whose containers are all proven gone. It
 * never throws; what it could not remove the next run's dead-owner sweep does.
 */
export function stopAllBackendsSync(): void {
  for (const entry of [...liveBackends]) {
    try {
      entry.closeSync();
    } catch {
      // each backend individually: one failure must not strand the rest
    }
  }
}

/** For a signal cleanup: `dispose()` every live backend, one after another. Never rejects. */
export async function stopAllBackends(): Promise<void> {
  for (const entry of [...liveBackends]) {
    try {
      await entry.dispose();
    } catch {
      // each backend individually
    }
  }
}

// ---------------------------------------------------------------------------
// the backend

export class AttemptBackend {
  private readonly attemptDir: string;
  private readonly attemptName: string;
  private readonly image: string;
  private readonly hostPort: HostPort;
  private readonly tmpRoot: string;
  private readonly limits: Limits;
  private readonly onContainer: BackendOptions["onContainer"];
  private readonly owner = process.pid;
  private readonly user = userSpec();

  private scratchDir: string | null = null;
  private installRun: Promise<StepResult> | null = null;
  private installed = false;
  /** Set by `dispose()` and the stop-all functions: no container is started after it. */
  private closed = false;
  /** Names registered before their `docker run` and not yet proven removed. */
  private readonly registered = new Set<string>();
  private readonly inflight = new Map<string, ChildProcess>();
  private serving: string | null = null;
  private readonly entry: RegistryEntry;

  constructor(options: BackendOptions) {
    if (!ATTEMPT_DIR_RE.test(options.attemptName)) {
      throw new Error(`attemptName must match ${ATTEMPT_DIR_RE}, got ${JSON.stringify(options.attemptName)}`);
    }
    if (options.image === "" || options.image.startsWith("-") || /\s/.test(options.image)) {
      throw new Error(`not an image reference: ${JSON.stringify(options.image)}`);
    }
    publishSpec(options.hostPort); // validates
    this.attemptDir = hostPath(resolve(options.attemptDir), "attemptDir");
    this.attemptName = options.attemptName;
    this.image = options.image;
    this.hostPort = options.hostPort;
    this.tmpRoot = resolve(options.tmpRoot ?? tmpdir());
    const limits: Limits = { ...LIMITS, ...(options.limits ?? {}) };
    for (const [key, value] of Object.entries(limits)) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`limits.${key} must be a non-negative number, got ${JSON.stringify(value)}`);
      }
    }
    this.limits = limits;
    this.onContainer = options.onContainer;
    this.entry = { closeSync: () => this.closeSync(), dispose: () => this.dispose() };
    // Registered before it owns anything, so a stop-all that lands before
    // install() still closes it, and install() then starts nothing.
    liveBackends.add(this.entry);
  }

  /** The host check of the run contract's backend layout. Starts nothing. */
  checkLayout(): StepResult {
    let root;
    try {
      root = statSync(this.attemptDir);
    } catch {
      return { kind: "infra", detail: `attempt directory ${this.attemptDir} does not exist` };
    }
    if (!root.isDirectory()) return { kind: "infra", detail: `${this.attemptDir} is not a directory` };

    const backend = join(this.attemptDir, "backend");
    let backendStat;
    try {
      backendStat = lstatSync(backend);
    } catch {
      return modelStop("layout", "backend/ is missing (the run contract needs backend/requirements.txt and backend/app/main.py)");
    }
    // A symlink would be followed on the host but resolved inside the container,
    // where `-w /workspace/backend` may then not exist: a docker error, which
    // would read as infra. The contract asks for a directory.
    if (backendStat.isSymbolicLink()) {
      return modelStop("layout", "backend/ is a symbolic link; the run contract needs a directory");
    }
    if (!backendStat.isDirectory()) return modelStop("layout", "backend is not a directory");

    const missing = ["backend/requirements.txt", "backend/app/main.py"].filter((relative) => {
      try {
        return !statSync(join(this.attemptDir, relative)).isFile();
      } catch {
        return true;
      }
    });
    if (missing.length > 0) {
      return modelStop("layout", `missing: ${missing.join(", ")} (the run contract needs backend/requirements.txt and backend/app/main.py)`);
    }
    return { kind: "ok" };
  }

  /** The layout check, the venv, `pip install -r requirements.txt` and the uvicorn check. Runs once. */
  install(): Promise<StepResult> {
    this.installRun ??= this.runInstall();
    return this.installRun;
  }

  private async runInstall(): Promise<StepResult> {
    const layout = this.checkLayout();
    if (layout.kind !== "ok") return layout;
    if (this.closed) return this.shutDown("installing");

    let scratch: string;
    try {
      scratch = this.ensureScratch();
    } catch (error) {
      return { kind: "infra", detail: `could not create the scratch directory under ${this.tmpRoot}: ${(error as Error).message}` };
    }

    // After every await below, `closed` first: a shutdown that landed while
    // the step ran may have removed its container and the scratch directory,
    // and what is left of the step's outcome must not be read as the model's.

    // The venv: a harness-owned directory, so any failure is infra.
    const venv = await this.runForeground("venv", venvArgs, VENV_TIMEOUT_MS);
    if (this.closed) return this.shutDown("installing");
    const venvFault = harnessFault(venv, "python3 -m venv", VENV_TIMEOUT_MS);
    if (venvFault !== null) return { kind: "infra", detail: venvFault };
    if (!outcomeOk(venv) || !isFile(join(scratch, "venv", "bin", "pip"))) {
      return {
        kind: "infra",
        detail: withSummary(
          lastLines(`${venv.stdout}\n${venv.stderr}`, 10),
          `python3 -m venv ${describeOutcome(venv, VENV_TIMEOUT_MS)}${outcomeOk(venv) ? " but left no bin/pip" : ""}; the venv is the harness's, not the model's`,
        ),
      };
    }

    // pip install: the model's requirements.txt, with the PyPI probe deciding a failure.
    const budget = this.limits.pipInstallMs;
    const pip = await this.runForeground("install", installArgs, budget);
    if (this.closed) return this.shutDown("installing");
    const pipFault = harnessFault(pip, "pip install", budget);
    if (pipFault !== null) return { kind: "infra", detail: pipFault };

    if (outcomeOk(pip)) {
      if (!isFile(join(scratch, "venv", "bin", "uvicorn"))) {
        return modelStop("install", "pip install -r requirements.txt succeeded, but the venv has no bin/uvicorn: requirements.txt does not install uvicorn");
      }
      this.installed = true;
      return { kind: "ok" };
    }

    const what = `pip install -r requirements.txt ${describeOutcome(pip, budget)}`;
    // Before the probe, whatever it would say: a full host disk is not the model's.
    const diskFull = `${pip.stdout}\n${pip.stderr}`.split("\n").find((line) => DISK_FULL_RE.test(line));
    if (diskFull !== undefined) {
      return {
        kind: "infra",
        detail: `${what}: the disk the venv is written to is full (${JSON.stringify(diskFull.trim())}); the scratch directory under ${this.tmpRoot} is the host's, so this is not the model's failure`,
      };
    }
    // Before the probe: a network error (timeout, reset, DNS) is retried once
    // in a fresh container but the same venv. A momentary blip that clears on
    // retry is not the model's fault. The same venv is reused because pip
    // handles partial installs safely (it downloads before it writes), the
    // harness-owned venv was already verified, and creating a new one would
    // add latency and complexity.
    const pipCombined = `${pip.stdout}\n${pip.stderr}`;
    if (hasNetworkError(pipCombined)) {
      const retry = await this.runForeground("install", installArgs, budget);
      if (this.closed) return this.shutDown("installing");
      const retryFault = harnessFault(retry, "pip install (retry)", budget);
      if (retryFault !== null) return { kind: "infra", detail: retryFault };
      if (outcomeOk(retry)) {
        if (!isFile(join(scratch, "venv", "bin", "uvicorn"))) {
          return modelStop("install", "pip install -r requirements.txt succeeded on retry, but the venv has no bin/uvicorn: requirements.txt does not install uvicorn");
        }
        this.installed = true;
        return { kind: "ok" };
      }
      // On retry failure, classify with the standard logic: first disk full,
      // then the PyPI probe. Network errors never decide blame on their own.
      const retryDiskFull = `${retry.stdout}\n${retry.stderr}`.split("\n").find((line) => DISK_FULL_RE.test(line));
      if (retryDiskFull !== undefined) {
        const retryWhat = `pip install -r requirements.txt ${describeOutcome(retry, budget)}`;
        return {
          kind: "infra",
          detail: `${retryWhat}: the disk the venv is written to is full (${JSON.stringify(retryDiskFull.trim())}); the scratch directory under ${this.tmpRoot} is the host's, so this is not the model's failure`,
        };
      }
      return this.classifyPipFailure(retry, budget);
    }
    return this.classifyPipFailure(pip, budget);
  }

  /**
   * The PyPI-probe-based classification of a failed `pip install`: the model's
   * if PyPI answers, infra if it does not. Shared by the first attempt (when no
   * retry ran) and a failed retry.
   */
  private async classifyPipFailure(pip: ForegroundOutcome, budget: number): Promise<StepResult> {
    const pipOutput = lastLines(`${pip.stdout}\n${pip.stderr}`, PIP_DETAIL_LINES);
    const what = `pip install -r requirements.txt ${describeOutcome(pip, budget)}`;
    const probeBudget = this.limits.pypiProbeMs;
    const probe = await this.runForeground("probe", probeArgs, probeBudget);
    if (this.closed) return this.shutDown("installing");
    const probeFault = harnessFault(probe, "the PyPI probe", probeBudget);
    if (probeFault !== null) return { kind: "infra", detail: `${what}, and then ${probeFault}` };
    if (outcomeOk(probe)) {
      return modelStop("install", withSummary(pipOutput, `(${what}; the PyPI probe then succeeded, so the index was reachable)`));
    }
    return {
      kind: "infra",
      detail: withSummary(
        lastLines(`${probe.stdout}\n${probe.stderr}`, 5),
        `${what}, and the PyPI probe (pip download ${PROBE_REQUIREMENT}) ${describeOutcome(probe, probeBudget)} too: PyPI looks unreachable from the container, so this is not the model's failure`,
      ),
    };
  }

  /** `pip freeze` of the installed venv, one requirement per line. Throws `BackendInfraError`. */
  async pipFreeze(): Promise<string[]> {
    if (!this.installed) throw new BackendInfraError("pipFreeze() needs a successful install()");
    const freeze = await this.runForeground("freeze", freezeArgs, FREEZE_TIMEOUT_MS);
    if (this.closed) throw new BackendInfraError(this.shutDown("running pip freeze").detail);
    const fault = harnessFault(freeze, "pip freeze", FREEZE_TIMEOUT_MS);
    if (fault !== null) throw new BackendInfraError(fault);
    if (!outcomeOk(freeze)) {
      throw new BackendInfraError(`pip freeze ${describeOutcome(freeze, FREEZE_TIMEOUT_MS)}: ${lastLines(freeze.stderr, 5)}`);
    }
    return freeze.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
  }

  /**
   * Start one serving container and wait for `/api/v1/health`. A serving
   * container this backend already runs is removed first. Only a `ready`
   * result leaves a container running; after a stop or infra, the container
   * has been removed — or, if it could not be proven gone, the result is infra.
   */
  async start(): Promise<StartResult> {
    if (this.closed) return this.shutDown("starting");
    if (!this.installed || this.scratchDir === null) return { kind: "infra", detail: "start() needs a successful install()" };
    if (this.serving !== null) {
      const previous = this.removeContainer(this.serving);
      if (!previous.removed) return { kind: "infra", detail: previous.detail };
    }

    const name = this.register("serve");
    const run = defaultDockerRun(serveArgs({ ...this.base(name), hostPort: this.hostPort }), DOCKER_CLI_TIMEOUT_MS);
    if (!succeeded(run)) {
      const busy = /port is already allocated|address already in use/i.test(run.stderr ?? "");
      return this.infraRemoving(
        name,
        `docker run -d ${describeCall(run, DOCKER_CLI_TIMEOUT_MS)}${busy ? ` — host port ${this.hostPort === 5100 ? "5100" : "for 5100/tcp"} is taken` : ""}`,
      );
    }
    this.serving = name;

    // Always ask docker: `-p 127.0.0.1:5100:5100` is not proof that 5100 is ours.
    const mapping = defaultDockerRun(["port", name, "5100/tcp"], DOCKER_CLI_TIMEOUT_MS);
    const port = succeeded(mapping) ? parsePortMapping(mapping.stdout ?? "") : null;
    if (port === null) {
      // A container that already exited has no mapping: that is a boot failure.
      const state = this.inspectState(name);
      if (state.kind === "exited") return this.bootStop(name, state.exitCode);
      const said = succeeded(mapping) ? `answered ${JSON.stringify((mapping.stdout ?? "").trim())}` : describeCall(mapping, DOCKER_CLI_TIMEOUT_MS);
      return this.infraRemoving(name, `docker port ${name} 5100/tcp ${said}, not a 127.0.0.1:<port> mapping`);
    }
    const baseUrl = `http://127.0.0.1:${port}`;

    const budget = this.limits.healthMs;
    const deadline = performance.now() + budget;
    let last = "no answer";
    for (;;) {
      if (this.closed) return this.shutDown("waiting for /api/v1/health");
      const state = this.inspectState(name);
      if (state.kind === "exited") return this.bootStop(name, state.exitCode);
      if (state.kind === "unknown") return this.infraRemoving(name, `docker inspect ${name} ${state.detail}`);
      const answer = await probeHealth(baseUrl, this.limits.healthProbeMs);
      if (this.closed) return this.shutDown("waiting for /api/v1/health");
      if (answer.ok) return { kind: "ready", baseUrl, container: name };
      last = answer.detail;
      const left = deadline - performance.now();
      if (left <= 0) break;
      await sleep(Math.min(this.limits.healthPollMs, left));
    }
    // Judged as every round of the loop is: docker failing to answer is not a stop.
    const final = this.inspectState(name);
    if (final.kind === "exited") return this.bootStop(name, final.exitCode);
    if (final.kind === "unknown") return this.infraRemoving(name, `docker inspect ${name} ${final.detail}`);
    const removal = this.removeContainer(name);
    if (!removal.removed) return { kind: "infra", detail: removal.detail };
    return modelStop("health", `no 2xx from GET ${HEALTH_PATH} within ${seconds(budget)}; last answer: ${last}`);
  }

  /** Remove the serving container, if any, and prove it. `removed: false` is infra for the caller. */
  async stop(): Promise<ContainerRemoval> {
    if (this.serving === null) return { removed: true, detail: "no serving container was running" };
    return this.removeContainer(this.serving);
  }

  /**
   * The serving container's state, asked of the daemon: for a caller to check
   * after using it — a hidden-test file, say — and before `stop()`, which
   * cannot tell a container it removed from one that was already gone.
   */
  async servingState(): Promise<ServingState> {
    if (this.serving === null) return { kind: "unknown", detail: "no serving container was running" };
    const name = this.serving;
    const state = this.inspectState(name);
    if (state.kind === "unknown") return state.missing ? { kind: "vanished" } : { kind: "unknown", detail: `docker inspect ${name} ${state.detail}` };
    return state;
  }

  /** Runs the attempt's own tests (`pytest tests`) in the backend container. */
  async runPytest(timeoutMs: number = PYTEST_TIMEOUT_MS): Promise<PytestStepResult> {
    const testsDir = join(this.attemptDir, "backend", "tests");
    let hasTestsDir = false;
    try {
      hasTestsDir = statSync(testsDir).isDirectory();
    } catch {
      hasTestsDir = false;
    }
    if (!hasTestsDir) {
      return {
        kind: "complete",
        result: {
          ran: false,
          timedOut: false,
          exitCode: null,
          passed: 0,
          failed: 0,
          errors: 0,
          durationMs: 0,
          outputTail: "",
          notRunReason: "no backend/tests",
        },
      };
    }

    if (this.scratchDir === null) {
      return { kind: "infra", detail: "backend was not installed (no scratch directory)" };
    }

    const pytestBin = join(this.scratchDir, "venv", "bin", "pytest");
    if (!isFile(pytestBin)) {
      return {
        kind: "complete",
        result: {
          ran: false,
          timedOut: false,
          exitCode: null,
          passed: 0,
          failed: 0,
          errors: 0,
          durationMs: 0,
          outputTail: "",
          notRunReason: "pytest not installed in the attempt's venv",
        },
      };
    }

    const start = performance.now();
    const outcome = await this.runForeground("pytest", pytestArgs, timeoutMs);
    const durationMs = Math.round(performance.now() - start);

    if (this.closed) return { kind: "infra", detail: this.shutDown("running pytest").detail };

    const interrupt = outcome.timedOut ? null : detectInterrupt({ signal: outcome.signal, status: outcome.status });
    if (interrupt !== null) return { kind: "interrupted", signal: interrupt };

    if (!outcome.removal.removed) return { kind: "infra", detail: outcome.removal.detail };
    if (outcome.refused) return { kind: "infra", detail: "the backend was shut down while running pytest" };
    if (outcome.spawnError !== null) return { kind: "infra", detail: `docker could not be started: ${outcome.spawnError.message}` };
    if (!outcome.timedOut && outcome.status !== null && DOCKER_ERROR_EXITS.has(outcome.status)) {
      return { kind: "infra", detail: `docker could not run pytest (exit ${outcome.status}): ${lastLines(outcome.stderr, 5) || "no message"}` };
    }
    if (!outcome.timedOut && outcome.signal !== null) {
      return { kind: "infra", detail: `pytest: its docker client was killed by ${outcome.signal}, which the harness did not send` };
    }

    const rawOutput = `${outcome.stdout}\n${outcome.stderr}`.trim();
    const outputTail = rawOutput.length > PYTEST_OUTPUT_TAIL_LIMIT ? rawOutput.slice(-PYTEST_OUTPUT_TAIL_LIMIT) : rawOutput;
    const summary = parsePytestSummary(rawOutput);

    let errors = summary.errors;
    if (outcome.status !== null && (outcome.status === 2 || outcome.status === 3 || outcome.status === 4) && errors === 0) {
      errors = 1;
    }

    return {
      kind: "complete",
      result: {
        ran: true,
        timedOut: outcome.timedOut,
        exitCode: outcome.timedOut ? null : outcome.status,
        passed: summary.passed,
        failed: summary.failed,
        errors,
        durationMs,
        outputTail,
        notRunReason: null,
      },
    };
  }

  /**
   * Shut down: no container is started after this. In-flight docker clients
   * are killed and awaited, every registered container is removed and
   * verified, and then — only if all of them are proven gone — the scratch
   * directory is deleted. Returns one removal per container that was still
   * registered; any `removed: false` is infra for the caller.
   */
  async dispose(): Promise<ContainerRemoval[]> {
    this.closed = true;
    await this.killInflight();
    return this.releaseAll();
  }

  // -------------------------------------------------------------------------

  private closeSync(): void {
    this.closed = true;
    for (const child of this.inflight.values()) {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
    this.releaseAll();
  }

  private releaseAll(): ContainerRemoval[] {
    const removals: ContainerRemoval[] = [];
    for (const name of [...this.registered]) {
      try {
        removals.push(this.removeContainer(name));
      } catch (error) {
        removals.push({ removed: false, detail: `removing ${name} threw: ${(error as Error).message}` });
      }
    }
    if (this.registered.size === 0 && this.scratchDir !== null) {
      try {
        rmSync(this.scratchDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        this.scratchDir = null;
      } catch {
        // left for the dead-owner sweep; no container can mount it any more
      }
    }
    this.forgetIfDone();
    return removals;
  }

  /** Leave the registry once shut down with nothing left to remove; until then a stop-all retries it. */
  private forgetIfDone(): void {
    if (this.closed && this.registered.size === 0 && this.inflight.size === 0 && this.scratchDir === null) {
      liveBackends.delete(this.entry);
    }
  }

  private async killInflight(): Promise<void> {
    await Promise.all(
      [...this.inflight.values()].map(
        (child) =>
          new Promise<void>((done) => {
            if (child.exitCode !== null || child.signalCode !== null) return done();
            const timer = setTimeout(done, CLIENT_EXIT_WAIT_MS);
            child.once("close", () => {
              clearTimeout(timer);
              done();
            });
            try {
              child.kill("SIGKILL");
            } catch {
              clearTimeout(timer);
              done();
            }
          }),
      ),
    );
  }

  private shutDown(while_: string): { kind: "infra"; detail: string } {
    return { kind: "infra", detail: `the backend was shut down while ${while_} (interrupted?)` };
  }

  private ensureScratch(): string {
    if (this.scratchDir !== null) return this.scratchDir;
    // `<tmpRoot>/agrav-backend-<owner pid>-XXXXXX` (never `agrav-creds-`): the
    // only shape `sweepDeadOwners` recognises.
    const dir = mkdtempSync(join(this.tmpRoot, scratchDirPrefix(this.owner)));
    this.scratchDir = dir;
    hostPath(dir, "the scratch directory");
    mkdirSync(join(dir, "home"));
    return dir;
  }

  private base(name: string): ArgvBase {
    if (this.scratchDir === null) throw new Error("no scratch directory");
    return {
      name,
      image: this.image,
      attemptDir: this.attemptDir,
      attemptName: this.attemptName,
      scratchDir: this.scratchDir,
      owner: this.owner,
      user: this.user,
    };
  }

  /** A fresh name, registered — so every cleanup path knows it — before anything can create it. */
  private register(purpose: ContainerPurpose): string {
    if (this.scratchDir === null) throw new Error("no scratch directory");
    containerSequence += 1;
    const name = `agrav-backend-${this.attemptName}-${this.owner}-${containerSequence}`;
    this.registered.add(name);
    this.onContainer?.(name, purpose, this.scratchDir);
    return name;
  }

  /** `rm -f` and proof; the name is forgotten only once the daemon says it is gone. */
  private removeContainer(name: string): ContainerRemoval {
    const removal = ensureContainerRemoved(name, {
      consequence:
        "A backend container that may still run can hold its host port and mounts the scratch directory, " +
        `so this is a harness fault, not the model's; remove it with \`docker rm -f ${name}\`.`,
      notRunningCountsAsRemoved: false,
    });
    if (removal.removed) {
      this.registered.delete(name);
      if (this.serving === name) this.serving = null;
    }
    return removal;
  }

  /**
   * One foreground container with an async client and a timer, so a signal is
   * acted on at once. On a timeout the client is killed — which leaves the
   * container running — and the removal that always follows stops it.
   */
  private runForeground(purpose: ContainerPurpose, build: (b: ArgvBase) => string[], timeoutMs: number): Promise<ForegroundOutcome> {
    const blank = { status: null, signal: null, stdout: "", stderr: "", timedOut: false, spawnError: null };
    if (this.closed) {
      return Promise.resolve({ ...blank, refused: true, removal: { removed: true, detail: "nothing was started" } });
    }
    const name = this.register(purpose);
    const args = build(this.base(name));
    return new Promise((done) => {
      const stdout = new TailBuffer(OUTPUT_KEEP_BYTES);
      const stderr = new TailBuffer(OUTPUT_KEEP_BYTES);
      let timedOut = false;
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (status: number | null, signal: NodeJS.Signals | null, spawnError: Error | null): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        this.inflight.delete(name);
        const removal = this.removeContainer(name);
        // A client whose close came after a shutdown: nothing may be left for the registry.
        this.forgetIfDone();
        done({
          refused: false,
          status,
          signal,
          stdout: stdout.text(),
          stderr: stderr.text(),
          timedOut,
          spawnError,
          removal,
        });
      };
      let child: ChildProcess;
      try {
        child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        finish(null, null, error as Error);
        return;
      }
      this.inflight.set(name, child);
      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      // `on`, not `once`: a second "error" with no listener would throw.
      child.on("error", (error) => {
        if (child.pid === undefined) finish(null, null, error);
      });
      child.once("close", (status, signal) => finish(status, signal, null));
    });
  }

  private inspectState(name: string): ContainerState {
    const result = defaultDockerRun(["inspect", "-f", "{{.State.Running}} {{.State.ExitCode}}", name], DOCKER_CLI_TIMEOUT_MS);
    if (!succeeded(result)) return { kind: "unknown", detail: describeCall(result, DOCKER_CLI_TIMEOUT_MS), missing: saysNoSuchContainer(result) };
    const match = /^(true|false) (-?\d+)$/.exec((result.stdout ?? "").trim());
    if (match === null) return { kind: "unknown", detail: `answered ${JSON.stringify((result.stdout ?? "").trim())}`, missing: false };
    return match[1] === "true" ? { kind: "running" } : { kind: "exited", exitCode: Number(match[2]) };
  }

  /** `docker logs --tail 50`, stdout then stderr, bounded: a `boot` stop's detail. */
  private readLogs(name: string): string {
    const result = defaultDockerRun(["logs", "--tail", String(LOG_TAIL_LINES), name], DOCKER_CLI_TIMEOUT_MS);
    return succeeded(result)
      ? stderrTail(
          [result.stdout ?? "", result.stderr ?? ""]
            .map((part) => part.trimEnd())
            .filter((part) => part !== "")
            .join("\n"),
          LOG_TAIL_BYTES,
        )
      : `(docker logs ${describeCall(result, DOCKER_CLI_TIMEOUT_MS)})`;
  }

  private bootStop(name: string, exitCode: number): StartResult {
    const tail = this.readLogs(name);
    const removal = this.removeContainer(name);
    if (!removal.removed) return { kind: "infra", detail: removal.detail };
    return modelStop("boot", withSummary(tail, `(the container exited with code ${exitCode} before GET ${HEALTH_PATH} answered)`));
  }

  private infraRemoving(name: string, detail: string): { kind: "infra"; detail: string } {
    const removal = this.removeContainer(name);
    return { kind: "infra", detail: removal.removed ? detail : `${detail}; ${removal.detail}` };
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
