/**
 * Serves one attempt for the human and live rows of the rubric — the backend
 * on 127.0.0.1:5100, the frontend's dev server on 5173 — until a signal
 * (spec §5, "Scoring topology — scripts/serve-attempt.ts"):
 *
 *   node --import tsx scripts/serve-attempt.ts --attempt <dir> [--root <path>] [--ignore-run-json]
 *   node --import tsx scripts/serve-attempt.ts --stop [--root <path>]
 *
 * `eval-attempts/` and `eval-results/` come from `--root` (the repository by
 * default), and so does the state file, `<root>/.cache/serve-attempt.json`;
 * the image always comes from this repository's `benchmark/runner.yaml`.
 *
 * Serving, in order:
 *
 * 1. the `run.json` checks `contract-tests` makes: `infra`, `softDenied` or
 *    `model` is refused (`--ignore-run-json` for a synthetic attempt);
 * 2. the dead-owner sweep, so a SIGKILLed run's container does not keep 5100;
 * 3. the state file, created exclusively (`wx`) — the lock. A file naming a
 *    live process with the same start time means another serve-attempt runs;
 *    one naming a dead process means it died without cleaning up, and the
 *    operator is told to run `--stop`. Nothing recorded is killed at start;
 * 4. only then ports 5100 and 5173: either one taken → exit 1, nothing started;
 * 5. the backend through `attempt-backend.ts` on 127.0.0.1:5100, by the
 *    resolved image Id. A stop (`layout`, `install`, `boot`, `health`) is
 *    recorded and serving goes on without data; a harness fault ends the run;
 * 6. `frontend/package.json`, `npm install` (`LIMITS.npmInstallMs`), and after a
 *    failed install `npm ping`: the registry answering makes it a frontend
 *    stop, not answering makes it infra — as does an install ended by a
 *    signal the harness did not send; then `npm run dev` through
 *    `startVite`, whose failure after its retry is a frontend stop;
 * 7. the ports again, where their holder now decides a score: 5173 when the
 *    dev server did not get it (it served on another port, or not at all), and
 *    5100 after a backend stop, once the dev server serves. Step 4 ran before
 *    the installs, minutes earlier, and take-screenshots or a serve-attempt
 *    under another `--root` takes no lock this one sees: held by something
 *    else now, either is a harness fault, not a port warning or a stop;
 * 8. `status: "ready"`, the URL and a one-line status on stdout, and then it
 *    waits for a signal.
 *
 * The state file is rewritten atomically as each part comes up — a
 * container's name (and the backend's scratch directory) before its `docker
 * run`, the Vite group right after its spawn — and at the end holds the URL,
 * the backend's `pip freeze`, the warnings (a dev-server port other than 5173,
 * and a dev server that exits after it was ready) and each half's status:
 * `ok`, or the stop and its reason.
 *
 * Teardown runs on every path: the Vite group and every other process group
 * `dev-server.ts` still tracks (a `startVite` try being aborted included),
 * the verified removal of every container, the scratch directory, and the
 * state file — which is deleted only while it names this process (pid and
 * start time), and kept, for `--stop`, if anything could not be proven gone or
 * a second signal cut the teardown short.
 *
 * `--stop` works in any phase and is idempotent: a live owner is sent SIGTERM
 * and waited for (it tears itself down); for a dead one, its containers are
 * removed by label, then its recorded scratch directories, and its recorded
 * Vite group is killed — only once proven to be the group it started — and
 * then its state file is deleted, if it still names that owner. With no state
 * file it still runs the dead-owner sweep, says nothing runs, and exits 0.
 *
 * Exit: 0 — `--stop` left nothing running. 1 — refused, a harness fault, or a
 * `--stop` that could not finish. 2 — usage. 128+N — stopped by a signal, the
 * normal end of serving.
 *
 * Signal-sensitive: invoke it as `node --import tsx scripts/serve-attempt.ts`,
 * never through the `tsx` bin, and — from the scoring skill — not through
 * `npm run`, which does not reliably forward signals. Importing this module
 * installs nothing; `runServe` installs the handlers.
 */
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AttemptBackend,
  BACKEND_ROLE,
  stopAllBackends,
  stopAllBackendsSync,
  type BackendOptions,
  type ContainerRemoval,
} from "./lib/attempt-backend";
import { ATTEMPT_DIR_RE } from "./lib/attempts";
import {
  busyPorts,
  DevServerError,
  ensureNodeModules,
  groupAlive,
  InstallKilledError,
  isSameProcess,
  KILL_WAIT_MS,
  killAllProcessesSync,
  killAndWait,
  killGroupAndWait,
  pidStartTime,
  probeRegistry,
  readProcStat,
  startVite,
  stopAllProcesses,
  survivingGroups,
  type StartViteOptions,
  type ViteServer,
} from "./lib/dev-server";
import {
  DOCKER_CLI_TIMEOUT_MS,
  defaultDockerRun,
  ensureContainerRemoved,
  LABEL_ATTEMPT,
  LABEL_OWNER,
  LABEL_ROLE,
  resolveImageId,
  SCRATCH_DIR_RE,
  sweepDeadOwners,
  type DockerRun,
  type SweepResult,
} from "./lib/docker";
import { installInterruptHandlers, type InterruptSignal } from "./lib/interrupt";
import { LIMITS } from "./lib/rubric";
import { runJsonRefusal } from "./lib/run-json";
import { readScoringImage } from "./lib/runner-config";

export { pidStartTime } from "./lib/dev-server";

/** This repository: `benchmark/runner.yaml`, and the default `--root`. Resolved, so no trailing slash. */
export const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
/** The state file — also the lock — relative to `--root`. */
export const SERVE_STATE_FILE = ".cache/serve-attempt.json";
/** The run contract's ports: the backend (published on 127.0.0.1) and the dev server. */
export const BACKEND_PORT = 5100;
export const FRONTEND_PORT = 5173;
/**
 * How long `--stop` waits for a live owner to tear itself down: its worst
 * correct teardown, and a margin. That is the Vite group and one more tracked
 * group (an install, a probe, a try being aborted), killed and waited for in
 * turn, and the one container it runs at a time — the serving one, or an
 * install's — removed and proven gone by an `rm -f` and an `inspect`, each
 * bounded by the docker CLI timeout. About 90 s; a slow daemon must not read
 * as a teardown that failed.
 */
export const STOP_WAIT_MS = 2 * KILL_WAIT_MS + 2 * DOCKER_CLI_TIMEOUT_MS + 18_000;
/** How long an unreadable state file is re-read: a writer's `wx` open precedes its write by microseconds. */
const UNREADABLE_RETRY_MS = 1000;
/** How long the CLI waits before exiting 1, so a signal that made a blocking call fail is reported as the interruption. */
const SIGNAL_SETTLE_MS = 200;

// ---------------------------------------------------------------------------
// the state file

/**
 * `<root>/.cache/serve-attempt.json`. `backend` and `frontend` are `"pending"`
 * until that half is decided, then `"ok"`, or `"stop:<stage>: <detail>"`
 * (backend) and `"stop: <reason>"` (frontend). Only a half that never served
 * is a stop: a dev server that exits after it was ready leaves `frontend` at
 * `"ok"` and adds a warning — the rubric has no stop for it, and the judge asks
 * the user instead (operator decision S2).
 */
export interface ServeState {
  pid: number;
  /** Field 22 of `/proc/<pid>/stat`: with `pid`, names one process. */
  pidStart: string;
  attempt: string;
  /** `ready` once both halves are decided, stops included. */
  status: "starting" | "ready";
  /** `<tag>@<Id>` the backend runs in, once resolved. */
  image: string | null;
  /** The latest backend container registered; at `ready`, the serving one, or `null` after a backend stop. */
  container: string | null;
  /** The pid — and so the process group id — of the latest `npm run dev`. */
  viteGroup: number | null;
  /** That leader's start time, so `--stop` can prove the group is the one it started. */
  viteStart: string | null;
  /** The dev server's `Local:` URL once it serves. */
  url: string | null;
  /**
   * The backend's scratch directories (`scratchDirPrefix(pid)` under the temp
   * directory), recorded as each container is registered. `--stop` removes
   * exactly these for a dead owner: the sweep skips them when the owner's pid
   * has since been reused, and a prefix match could then reach another tool's.
   */
  scratchDirs: string[];
  pipFreeze: string[];
  /** A dev-server port other than 5173; a dev server that exited after it was ready. */
  warnings: string[];
  backend: string;
  frontend: string;
}

export function statePath(root: string): string {
  return join(root, SERVE_STATE_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function nullable<T>(value: unknown, check: (v: unknown) => v is T): value is T | null {
  return value === null || check(value);
}

const isString = (v: unknown): v is string => typeof v === "string";
const isDigits = (v: unknown): v is string => typeof v === "string" && /^\d+$/.test(v);
const isPid = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

/** An absolute path to a scratch directory of `pid`, exactly as `scratchDirPrefix` and `mkdtemp` name one. */
function isScratchDirOf(path: unknown, pid: number): path is string {
  if (typeof path !== "string" || !isAbsolute(path)) return false;
  const match = SCRATCH_DIR_RE.exec(basename(path));
  return match !== null && Number(match[1]) === pid && resolve(path) === path;
}

/** A validated state file, or a reason it is not one. */
export function parseServeState(json: string): ServeState {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw new Error(`not JSON: ${(error as Error).message}`);
  }
  if (!isRecord(raw)) throw new Error("not a JSON object");
  const fail = (key: string): never => {
    throw new Error(`${key} is missing or malformed`);
  };
  if (!isPid(raw.pid)) fail("pid");
  if (!isDigits(raw.pidStart)) fail("pidStart");
  if (!isString(raw.attempt) || !ATTEMPT_DIR_RE.test(raw.attempt)) fail("attempt");
  if (raw.status !== "starting" && raw.status !== "ready") fail("status");
  if (!nullable(raw.image, isString)) fail("image");
  if (!nullable(raw.container, isString)) fail("container");
  if (!nullable(raw.viteGroup, isPid)) fail("viteGroup");
  if (!nullable(raw.viteStart, isDigits)) fail("viteStart");
  if (!nullable(raw.url, isString)) fail("url");
  if (!Array.isArray(raw.scratchDirs) || !raw.scratchDirs.every((dir) => isScratchDirOf(dir, raw.pid as number))) fail("scratchDirs");
  if (!isStringArray(raw.pipFreeze)) fail("pipFreeze");
  if (!isStringArray(raw.warnings)) fail("warnings");
  if (!isString(raw.backend)) fail("backend");
  if (!isString(raw.frontend)) fail("frontend");
  return {
    pid: raw.pid as number,
    pidStart: raw.pidStart as string,
    attempt: raw.attempt as string,
    status: raw.status as ServeState["status"],
    image: raw.image as string | null,
    container: raw.container as string | null,
    viteGroup: raw.viteGroup as number | null,
    viteStart: raw.viteStart as string | null,
    url: raw.url as string | null,
    scratchDirs: raw.scratchDirs as string[],
    pipFreeze: raw.pipFreeze as string[],
    warnings: raw.warnings as string[],
    backend: raw.backend as string,
    frontend: raw.frontend as string,
  };
}

type LoadedState = { kind: "missing" } | { kind: "invalid"; reason: string } | { kind: "ok"; state: ServeState };

function loadStateOnce(path: string): LoadedState {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "invalid", reason: (error as Error).message };
  }
  try {
    return { kind: "ok", state: parseServeState(text) };
  } catch (error) {
    return { kind: "invalid", reason: (error as Error).message };
  }
}

/** The state file, re-read for up to a second while it cannot be parsed — a `wx` create is followed by its write. */
async function loadState(path: string): Promise<LoadedState> {
  const deadline = performance.now() + UNREADABLE_RETRY_MS;
  for (;;) {
    const loaded = loadStateOnce(path);
    if (loaded.kind !== "invalid" || performance.now() >= deadline) return loaded;
    await new Promise((done) => setTimeout(done, 50));
  }
}

/**
 * The state file under `root`, or `null` when there is none — or none that
 * parses, since an unreadable file names no process anyone could prove is
 * running. For `take-screenshots` and the scoring skill.
 */
export function readServeState(root: string): ServeState | null {
  const loaded = loadStateOnce(statePath(root));
  return loaded.kind === "ok" ? loaded.state : null;
}

/** Whether the process a state file names is still running: same pid, same start time, not a zombie. */
export function isServeOwnerLive(state: Pick<ServeState, "pid" | "pidStart">): boolean {
  return isSameProcess(state.pid, state.pidStart);
}

/**
 * This process's state file: created exclusively, rewritten atomically, and
 * deleted — only while the file on disk still names this process.
 */
class StateFile {
  private lostReported = false;
  private kept = false;

  private constructor(
    readonly path: string,
    private state: ServeState,
    private readonly out: (line: string) => void,
  ) {}

  /** `wx`: the lock. `null` when a state file already exists. */
  static create(path: string, initial: ServeState, out: (line: string) => void): StateFile | null {
    mkdirSync(dirname(path), { recursive: true });
    try {
      writeFileSync(path, `${JSON.stringify(initial, null, 2)}\n`, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw error;
    }
    return new StateFile(path, { ...initial }, out);
  }

  get current(): ServeState {
    return {
      ...this.state,
      scratchDirs: [...this.state.scratchDirs],
      pipFreeze: [...this.state.pipFreeze],
      warnings: [...this.state.warnings],
    };
  }

  /** Whether the file on disk still names this process. */
  namesUs(): boolean {
    const loaded = loadStateOnce(this.path);
    return loaded.kind === "ok" && loaded.state.pid === this.state.pid && loaded.state.pidStart === this.state.pidStart;
  }

  /**
   * Merge `patch` and rewrite the file through a temporary file and a rename,
   * so a reader never sees half of it. A file that no longer names this
   * process — removed or replaced by hand — is left alone, and said so once.
   */
  update(patch: Partial<Omit<ServeState, "pid" | "pidStart" | "attempt">>): void {
    this.state = { ...this.state, ...patch };
    if (!this.namesUs()) {
      if (!this.lostReported) {
        this.lostReported = true;
        this.out(`warning: ${this.path} no longer names this process (pid ${this.state.pid}); it is not updated any more`);
      }
      return;
    }
    const tmp = join(dirname(this.path), `.serve-attempt.json.${this.state.pid}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`);
    renameSync(tmp, this.path);
  }

  /** Keep the file on every later `release`: something it records could not be proven gone. */
  keep(): void {
    this.kept = true;
  }

  /** Delete the file if it still names this process and nothing asked to keep it. True when deleted. */
  release(): boolean {
    if (this.kept || !this.namesUs()) return false;
    try {
      unlinkSync(this.path);
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// types

export interface ServeOptions {
  /** The attempt directory's name, `<id>-attempt-<n>`. */
  attempt: string;
  /** Holds `eval-attempts/`, `eval-results/` and `.cache/`. Absolute. */
  root: string;
  /** Serve without reading `run.json`: synthetic attempts only. */
  ignoreRunJson: boolean;
}

/** What `serveAttempt` needs of a backend; `AttemptBackend` is one. */
export type ServeBackend = Pick<AttemptBackend, "checkLayout" | "install" | "pipFreeze" | "start" | "stop" | "dispose">;

export interface ServeDeps {
  /** The dead-owner sweep; runs first, before the lock. */
  sweep: () => SweepResult;
  /** The ports of `ports` something holds. Tests never probe the real 5100 and 5173. */
  busyPorts: (ports: number[]) => Promise<number[]>;
  /**
   * The image tag from runner.yaml, its `<tag>@<Id>` and the bare Id
   * (`resolveImageId`). Throws when it cannot be resolved to a `sha256:<64 hex>` Id.
   */
  image: () => { tag: string; ref: string; id: string };
  /** Given the bare image Id (`sha256:…`), never the tag, `hostPort: 5100` and `tmpRoot()`. */
  createBackend: (options: BackendOptions) => ServeBackend;
  /** Where the backend's scratch directories go, and are looked for to record them. Default `os.tmpdir()`. */
  tmpRoot: () => string;
  ensureNodeModules: (frontendDir: string, timeoutMs: number) => Promise<void>;
  probeRegistry: () => Promise<boolean>;
  startVite: (frontendDir: string, options: StartViteOptions) => Promise<ViteServer>;
  /** This process — the identity the lock records. `start` is `null` when it cannot be read. */
  self: () => { pid: number; start: string | null };
  /** Whether a recorded owner is still that very process. */
  ownerLive: (pid: number, start: string) => boolean;
  /** The signal that interrupted the run, or `null`. Checked after every step. */
  interrupted: () => InterruptSignal | null;
  /** Called with the session as soon as the lock is held, so a signal cleanup can tear it down. */
  onSession: (session: ServeSession) => void;
  /** The session's check, after its frontend kill, for a tracked process group still alive. */
  survivingGroups: () => number[];
  /** Resolves when serving should end. The CLI's never does: a signal ends it. */
  untilStopped: () => Promise<void>;
  out: (line: string) => void;
}

export type ServeOutcome =
  /** Served until `untilStopped`, then torn down; `problems` lists what could not be proven gone. */
  | { kind: "stopped"; state: ServeState; problems: string[] }
  /** Refused: nothing is left started, and no state file of this process. */
  | { kind: "refused"; message: string }
  /** A harness fault: torn down. */
  | { kind: "infra"; message: string }
  | { kind: "interrupted"; signal: InterruptSignal };

// ---------------------------------------------------------------------------
// the session: what a teardown has to undo

export interface ServeSessionOptions {
  /** The `--stop` command a kept state file's message names: `stopCommand(root)`. */
  stopCommand?: string;
  /** The tracked process groups still alive; tests inject it. Default: `dev-server.ts`'s. */
  survivingGroups?: () => number[];
}

/**
 * The `--stop` command for `root`, in backticks: ` --root <root>` whenever
 * `root` is not this repository, so following it stops what runs there.
 */
export function stopCommand(root: string): string {
  return "`node --import tsx scripts/serve-attempt.ts --stop" + (resolve(root) === REPO_ROOT ? "" : ` --root ${root}`) + "`";
}

/**
 * Everything one serving run started, and its teardown: the Vite group (and
 * anything else `dev-server.ts` tracks), the backend's containers and scratch
 * directory, and the state file. Each part runs once; a second caller — a
 * signal arriving during a teardown already under way — joins it.
 */
export class ServeSession {
  backend: ServeBackend | null = null;
  vite: ViteServer | null = null;
  /** Aborted first thing in a teardown: `startVite` starts no try after it. */
  readonly abort = new AbortController();
  /** Set once a teardown has begun: a dev server exiting now is being stopped, not crashing. */
  stopping = false;
  readonly problems: string[] = [];
  private frontendRun: Promise<void> | null = null;
  private backendRun: Promise<void> | null = null;
  private stateRun: Promise<void> | null = null;
  /** Set once `releaseState` has deleted or kept the file: the teardown finished. */
  private stateDecided = false;

  private readonly stopHint: string;
  private readonly survivingGroups: () => number[];

  constructor(
    readonly file: StateFile,
    private readonly out: (line: string) => void,
    options: ServeSessionOptions = {},
  ) {
    this.stopHint = options.stopCommand ?? stopCommand(REPO_ROOT);
    this.survivingGroups = options.survivingGroups ?? survivingGroups;
  }

  /**
   * The Vite group, killed and waited for, then every other process
   * `dev-server.ts` tracks — an aborted `startVite` try whose kill is still in
   * flight included: `stopAllProcesses` waits for it. A group still alive
   * after that is a problem, so the state file is kept.
   */
  stopFrontend(): Promise<void> {
    this.stopping = true;
    this.abort.abort();
    this.frontendRun ??= (async () => {
      try {
        const vite = this.vite;
        if (vite !== null) await killAndWait(vite.proc);
        await stopAllProcesses();
        for (const pgid of this.survivingGroups()) {
          this.problems.push(`the dev server's (or its install's) process group ${pgid} is still alive after SIGKILL`);
        }
      } catch (error) {
        this.problems.push(`stopping the frontend threw: ${message(error)}`);
      }
    })();
    return this.frontendRun;
  }

  /** The serving container removed and proven gone, then every other container and the scratch directory. */
  stopBackend(): Promise<void> {
    this.stopping = true;
    this.backendRun ??= (async () => {
      try {
        const backend = this.backend;
        if (backend !== null) {
          const removals: ContainerRemoval[] = [];
          try {
            removals.push(await backend.stop());
          } catch (error) {
            removals.push({ removed: false, detail: `stopping the backend threw: ${message(error)}` });
          }
          try {
            removals.push(...(await backend.dispose()));
          } catch (error) {
            removals.push({ removed: false, detail: `disposing the backend threw: ${message(error)}` });
          }
          for (const removal of removals) if (!removal.removed) this.problems.push(removal.detail);
        }
        await stopAllBackends();
      } catch (error) {
        this.problems.push(`stopping the backend threw: ${message(error)}`);
      }
    })();
    return this.backendRun;
  }

  /** Delete the state file — unless something it records could not be proven gone; `--stop` finishes that. */
  releaseState(): Promise<void> {
    this.stopping = true;
    this.stateRun ??= (async () => {
      if (this.problems.length > 0) {
        this.file.keep();
        this.out(
          `serve-attempt: ${this.file.path} is kept, because not everything could be proven gone:\n` +
            this.problems.map((p) => `  - ${p}`).join("\n") +
            `\nRun ${this.stopHint} once the cause is fixed.`,
        );
      } else {
        this.file.release();
      }
      this.stateDecided = true;
    })();
    return this.stateRun;
  }

  /** All three, in order. */
  async teardown(): Promise<string[]> {
    for (const part of [() => this.stopFrontend(), () => this.stopBackend(), () => this.releaseState()]) {
      try {
        await part();
      } catch (error) {
        this.problems.push(`teardown: ${(error as Error).message}`);
      }
    }
    return [...this.problems];
  }

  /**
   * For an `exit` listener. After `releaseState` there is nothing left to
   * decide. Before it — a second signal cut the teardown short, or the process
   * is dying without one — the exit listener's SIGKILL and `docker rm -f` are
   * all that ran, and neither is verified: so the file is deleted only when
   * nothing it records was ever started and nothing went wrong, and otherwise
   * kept for `--stop`, which proves each part gone.
   */
  releaseStateSync(): void {
    if (this.stateDecided) return;
    const recorded = this.file.current;
    const started = this.backend !== null || this.vite !== null || recorded.viteGroup !== null || recorded.container !== null;
    if (this.problems.length > 0 || started) {
      if (this.file.namesUs()) {
        console.error(
          `serve-attempt: ${this.file.path} is kept: the teardown did not finish, so what it records is not proven gone. ` +
            `Run ${this.stopHint} to finish it.`,
        );
      }
      return;
    }
    this.file.release();
  }
}

// ---------------------------------------------------------------------------
// the defaults

function defaultImage(): { tag: string; ref: string; id: string } {
  const tag = readScoringImage(REPO_ROOT);
  return { tag, ...resolveImageId(tag) };
}

/** Never resolves; keeps the event loop alive while nothing else would (a stopped frontend, a detached container). */
function forever(): Promise<void> {
  return new Promise(() => {
    setInterval(() => {}, 1 << 30);
  });
}

const DEFAULT_SERVE_DEPS: ServeDeps = {
  sweep: () => sweepDeadOwners({ role: BACKEND_ROLE }),
  busyPorts,
  image: defaultImage,
  createBackend: (options) => new AttemptBackend(options),
  tmpRoot: () => tmpdir(),
  ensureNodeModules,
  probeRegistry: () => probeRegistry(),
  startVite,
  self: () => ({ pid: process.pid, start: pidStartTime(process.pid) }),
  ownerLive: isSameProcess,
  interrupted: () => null,
  onSession: () => {},
  survivingGroups,
  untilStopped: forever,
  out: (line) => console.log(line),
};

// ---------------------------------------------------------------------------
// serving

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** One line, at most `max` characters — for stdout, never for the state file. */
function brief(text: string, max = 200): string {
  const flat = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" / ");
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** Run the dead-owner sweep and say what it did; a sweep that throws is a warning, never a stop. */
function sweepAndReport(sweep: () => SweepResult, out: (line: string) => void): void {
  let result: SweepResult;
  try {
    result = sweep();
  } catch (error) {
    out(`warning: dead-owner sweep failed: ${message(error)}`);
    return;
  }
  for (const name of result.removedContainers) out(`removed ${name}, a backend container whose owner is gone`);
  for (const dir of result.removedDirs) out(`removed ${dir}, a scratch directory whose owner is gone`);
  for (const failure of result.failed) out(`warning: dead-owner sweep: ${failure}`);
}

type BackendPart =
  | { kind: "ok"; container: string; baseUrl: string; pipFreeze: string[] }
  /** `pipFreeze` is empty unless the install succeeded before the stop. */
  | { kind: "stop"; status: string; stage: string; detail: string; pipFreeze: string[] }
  | { kind: "infra"; message: string }
  | { kind: "interrupted"; signal: InterruptSignal };

async function runBackend(backend: ServeBackend, d: ServeDeps): Promise<BackendPart> {
  const interrupted = (): BackendPart | null => {
    const signal = d.interrupted();
    return signal === null ? null : { kind: "interrupted", signal };
  };
  const stop = (stage: string, detail: string, pipFreeze: string[] = []): BackendPart => ({
    kind: "stop",
    status: `stop:${stage}: ${detail}`,
    stage,
    detail,
    pipFreeze,
  });

  const layout = backend.checkLayout();
  if (layout.kind === "infra") return { kind: "infra", message: layout.detail };
  if (layout.kind === "stop") return stop(layout.stage, layout.detail);

  d.out("installing the backend (a fresh venv, pip install -r requirements.txt)…");
  const install = await backend.install();
  const afterInstall = interrupted();
  if (afterInstall !== null) return afterInstall;
  if (install.kind === "infra") return { kind: "infra", message: install.detail };
  if (install.kind === "stop") return stop(install.stage, install.detail);

  let pipFreeze: string[];
  try {
    pipFreeze = await backend.pipFreeze();
  } catch (error) {
    return interrupted() ?? { kind: "infra", message: message(error) };
  }
  const afterFreeze = interrupted();
  if (afterFreeze !== null) return afterFreeze;

  d.out(`starting the backend on 127.0.0.1:${BACKEND_PORT}…`);
  const started = await backend.start();
  const afterStart = interrupted();
  if (afterStart !== null) return afterStart;
  if (started.kind === "infra") return { kind: "infra", message: started.detail };
  if (started.kind === "stop") return stop(started.stage, started.detail, pipFreeze);
  return { kind: "ok", container: started.container, baseUrl: started.baseUrl, pipFreeze };
}

/**
 * The whole of serving except argument parsing and signal handling: checks,
 * sweep, lock, ports, backend, frontend, the state file, and — once
 * `untilStopped` resolves — the teardown. A signal's teardown is the caller's
 * (`runServe` wires `onSession` to its handlers); after one, this returns
 * `interrupted` without taking another step.
 */
export async function serveAttempt(options: ServeOptions, deps: Partial<ServeDeps> = {}): Promise<ServeOutcome> {
  const d: ServeDeps = { ...DEFAULT_SERVE_DEPS, ...deps };
  const refused = (text: string): ServeOutcome => ({ kind: "refused", message: text });
  const signalled = (): ServeOutcome | null => {
    const signal = d.interrupted();
    return signal === null ? null : { kind: "interrupted", signal };
  };

  // --- checks: nothing is started -----------------------------------------
  if (!ATTEMPT_DIR_RE.test(options.attempt)) {
    return refused(`--attempt takes an attempt directory name like gemini-38-flash-high-attempt-1, got ${JSON.stringify(options.attempt)}`);
  }
  const attemptDir = join(options.root, "eval-attempts", options.attempt);
  if (!isDirectory(attemptDir)) return refused(`no attempt directory at ${attemptDir}`);
  if (!options.ignoreRunJson) {
    const admitted = runJsonRefusal(join(options.root, "eval-results", options.attempt), "serving it");
    if ("refusal" in admitted) return refused(admitted.refusal);
  }

  // --- the dead-owner sweep, before the lock ------------------------------
  sweepAndReport(d.sweep, d.out);
  const afterSweep = signalled();
  if (afterSweep !== null) return afterSweep;

  // --- the lock -------------------------------------------------------------
  const self = d.self();
  if (self.start === null) {
    return { kind: "infra", message: `cannot read this process's start time from /proc/${self.pid}/stat; serve-attempt's lock needs Linux /proc` };
  }
  const path = statePath(options.root);
  const initial: ServeState = {
    pid: self.pid,
    pidStart: self.start,
    attempt: options.attempt,
    status: "starting",
    image: null,
    container: null,
    viteGroup: null,
    viteStart: null,
    url: null,
    scratchDirs: [],
    pipFreeze: [],
    warnings: [],
    backend: "pending",
    frontend: "pending",
  };
  let file: StateFile | null;
  try {
    file = StateFile.create(path, initial, d.out);
  } catch (error) {
    return { kind: "infra", message: `could not create ${path}: ${message(error)}` };
  }
  if (file === null) {
    const loaded = await loadState(path);
    const stopHint = stopCommand(options.root);
    if (loaded.kind === "missing") return refused(`${path} existed a moment ago and is gone now: another serve-attempt may be starting or stopping. Try again.`);
    if (loaded.kind === "invalid") {
      return refused(`${path} exists but cannot be read (${loaded.reason}). It names no process that can be proven running, so it is left alone: look at it, and delete it by hand if nothing is serving.`);
    }
    const other = loaded.state;
    if (d.ownerLive(other.pid, other.pidStart)) {
      return refused(`already serving ${other.attempt} (pid ${other.pid}${other.url === null ? "" : `, ${other.url}`}). Stop it first with ${stopHint}.`);
    }
    return refused(
      `${path} names pid ${other.pid}, serving ${other.attempt}, which is no longer running: it died without cleaning up. ` +
        `Nothing it recorded is touched here; run ${stopHint} to remove what it left, then start again.`,
    );
  }
  const session = new ServeSession(file, d.out, { stopCommand: stopCommand(options.root), survivingGroups: d.survivingGroups });
  d.onSession(session);

  // Any way out from here that is not serving tears down what was started.
  const infra = async (text: string): Promise<ServeOutcome> => {
    const problems = await session.teardown();
    return { kind: "infra", message: [text, ...problems].join("\n") };
  };

  // --- ports ----------------------------------------------------------------
  const busy = await d.busyPorts([BACKEND_PORT, FRONTEND_PORT]);
  const afterPorts = signalled();
  if (afterPorts !== null) return afterPorts;
  if (busy.length > 0) {
    file.release();
    return refused(
      `${plural(busy.length, "port", "ports")} ${busy.join(" and ")} ${plural(busy.length, "is", "are")} already in use. ` +
        `serve-attempt serves the backend on 127.0.0.1:${BACKEND_PORT} and the dev server on ${FRONTEND_PORT} and shares neither: ` +
        "another serve-attempt, take-screenshots, a leftover dev server or container may hold them. Nothing was started.",
    );
  }

  // --- the backend ----------------------------------------------------------
  let image: { tag: string; ref: string; id: string };
  try {
    image = d.image();
  } catch (error) {
    return infra(`serve-attempt: ${message(error)}`);
  }
  file.update({ image: image.ref });
  d.out(`serve-attempt: ${options.attempt} in ${image.ref}`);

  let backendPart: BackendPart;
  const tmpRoot = d.tmpRoot();
  try {
    const backend = d.createBackend({
      attemptDir,
      attemptName: options.attempt,
      // By Id: a retag during the run cannot change what later containers run.
      image: image.id,
      hostPort: BACKEND_PORT,
      tmpRoot,
      // Recorded before its `docker run`, so a crash can never leave an unnamed
      // container — and with it the scratch directory, which exists by then.
      onContainer: (name, _purpose, scratchDir) => {
        const scratchDirs = [...new Set([...file.current.scratchDirs, scratchDir])];
        file.update({ container: name, scratchDirs });
      },
    });
    session.backend = backend;
    backendPart = await runBackend(backend, d);
  } catch (error) {
    backendPart = { kind: "infra", message: message(error) };
  }
  if (backendPart.kind === "interrupted") return backendPart;
  const afterBackend = signalled();
  if (afterBackend !== null) return afterBackend;
  if (backendPart.kind === "infra") return infra(`serve-attempt: the backend could not be served (a harness fault, not the model's): ${backendPart.message}`);
  if (backendPart.kind === "ok") {
    file.update({ backend: "ok", container: backendPart.container, pipFreeze: backendPart.pipFreeze });
    d.out(`backend: ok at ${backendPart.baseUrl}`);
  } else {
    file.update({ backend: backendPart.status, container: null, pipFreeze: backendPart.pipFreeze });
    d.out(`backend stop (${backendPart.stage}): ${brief(backendPart.detail)} — serving the frontend without data`);
  }

  // --- the frontend ---------------------------------------------------------
  const frontendDir = join(attemptDir, "frontend");
  const warnings: string[] = [];
  let frontend: string;
  let url: string | null = null;
  if (!isFile(join(frontendDir, "package.json"))) {
    frontend = "stop: frontend/package.json is missing";
  } else {
    let installFailure: string | null = null;
    try {
      await d.ensureNodeModules(frontendDir, LIMITS.npmInstallMs);
    } catch (error) {
      const afterKill = signalled();
      if (afterKill !== null) return afterKill;
      // Whatever the registry would say: something outside the harness ended it.
      if (error instanceof InstallKilledError) return infra(`serve-attempt: ${error.message}. A harness fault, not the model's: serve it again.`);
      installFailure = message(error);
    }
    const afterInstall = signalled();
    if (afterInstall !== null) return afterInstall;
    if (installFailure !== null) {
      d.out(`npm install failed; asking the registry (npm ping) whose failure it was…`);
      const reachable = await d.probeRegistry();
      const afterProbe = signalled();
      if (afterProbe !== null) return afterProbe;
      if (!reachable) {
        return infra(
          `serve-attempt: npm install failed (${brief(installFailure, 500)}), and npm ping could not reach the registry either. ` +
            "That says nothing about the model: a harness fault. Fix the network and serve it again.",
        );
      }
      frontend = `stop: npm install failed, and the registry answered npm ping: ${installFailure}`;
    } else {
      /** How the dev server missed 5173, if it did: then 5173's holder is asked about below. */
      let offContract: { kind: "shifted"; port: number } | { kind: "failed"; account: string } | null = null;
      try {
        const vite = await d.startVite(frontendDir, {
          signal: session.abort.signal,
          onSpawn: (pid) => file.update({ viteGroup: pid, viteStart: pidStartTime(pid) }),
        });
        session.vite = vite;
        url = vite.url;
        frontend = "ok";
        if (vite.port !== FRONTEND_PORT) {
          warnings.push(`the dev server serves on port ${vite.port}, not the run contract's ${FRONTEND_PORT}`);
          offContract = { kind: "shifted", port: vite.port };
        }
      } catch (error) {
        const afterVite = signalled();
        if (afterVite !== null) return afterVite;
        if (!(error instanceof DevServerError)) return infra(`serve-attempt: ${message(error)}`);
        // Every try was killed; the record goes only once its group is seen
        // gone, so a group that outlived SIGKILL is still `--stop`'s to find.
        const recordedGroup = file.current.viteGroup;
        if (recordedGroup === null || !groupAlive(recordedGroup)) file.update({ viteGroup: null, viteStart: null });
        frontend = `stop: ${error.message}${error.outputTail === "" ? "" : `\n${error.outputTail}`}`;
        offContract = { kind: "failed", account: brief(`${error.message}\n${error.outputTail}`, 500) };
      }
      const afterFrontend = signalled();
      if (afterFrontend !== null) return afterFrontend;

      // --- the ports again, where their holder now decides a score ----------
      // The check above ran before both installs, minutes ago, and neither
      // take-screenshots nor a serve-attempt under another --root holds a lock
      // this one sees. Our own tries are dead or on another port by now.
      const missed = offContract;
      const collision =
        missed === null
          ? null
          : await heldBy(d, FRONTEND_PORT, (why) =>
              missed.kind === "failed"
                ? `npm run dev did not serve, and port ${FRONTEND_PORT} ${why} — or by a process of this dev server that outlived SIGKILL. ` +
                  `The failure may be the collision's, not the model's. The dev server's own account: ${missed.account}.`
                : `port ${FRONTEND_PORT} ${why}, and the dev server serves on ${missed.port}: the shift may be the collision's, not the model's.`,
            );
      if (collision !== null) return collision.kind === "interrupted" ? collision : infra(collision.message);
      // After a backend stop nothing of ours answers on 5100, so whatever does
      // would be judged, through the dev server's proxy, as this attempt's data.
      if (session.vite !== null && backendPart.kind !== "ok") {
        const foreign = await heldBy(d, BACKEND_PORT, (why) => `after the backend stop, port ${BACKEND_PORT} ${why}: the dev server's /api proxy would show another backend's data as this attempt's.`);
        if (foreign !== null) return foreign.kind === "interrupted" ? foreign : infra(foreign.message);
      }
    }
  }

  // --- ready ----------------------------------------------------------------
  file.update({ status: "ready", frontend, url, warnings });
  for (const warning of warnings) d.out(`warning: ${warning}`);
  if (frontend !== "ok") d.out(`frontend ${brief(frontend)}`);
  const backendStatus = backendPart.kind === "ok" ? "backend ok" : `backend stop (${backendPart.stage})`;
  const frontendStatus = frontend === "ok" ? "frontend ok" : "frontend stop";
  d.out(`ready: ${url ?? "no dev server"} (${backendStatus}; ${frontendStatus}) — stop it with SIGTERM or --stop`);

  // A warning, never a stop (operator decision S2): the rubric has no stop for
  // a dev server that served and then exited, so the judge finds this line in
  // serve.log — SKILL.md greps for it — and asks the user.
  const vite = session.vite;
  vite?.proc.once("close", (code, signal) => {
    if (session.stopping) return;
    const reason = `the dev server exited after it was ready (${code === null ? signal : `code ${code}`})`;
    d.out(`warning: ${reason}`);
    try {
      file.update({ warnings: [...file.current.warnings, reason] });
    } catch (error) {
      d.out(`warning: could not record it in ${file.path}: ${message(error)}`);
    }
  });

  await d.untilStopped();
  const afterServing = signalled();
  if (afterServing !== null) return afterServing;
  const state = file.current;
  const problems = await session.teardown();
  return { kind: "stopped", state, problems };
}

/**
 * `port` asked again, late in serving: `null` when it is free, the signal when
 * one arrived meanwhile, and otherwise the harness fault `describe` words —
 * given "is held by something else", it says what that does to the attempt.
 */
async function heldBy(
  d: ServeDeps,
  port: number,
  describe: (why: string) => string,
): Promise<{ kind: "interrupted"; signal: InterruptSignal } | { kind: "infra"; message: string } | null> {
  const held = await d.busyPorts([port]);
  const signal = d.interrupted();
  if (signal !== null) return { kind: "interrupted", signal };
  if (held.length === 0) return null;
  return {
    kind: "infra",
    message:
      `serve-attempt: ${describe("is held by something else")} ` +
      `It was free at serve-attempt's port check, before the installs: another serve-attempt (under another --root), ` +
      "take-screenshots, or a dev server or container started meanwhile holds it. A harness fault, not the model's: free the port and serve it again.",
  };
}

// ---------------------------------------------------------------------------
// --stop

export interface StopDeps {
  sweep: () => SweepResult;
  /** For listing and removing the dead owner's containers. */
  dockerRun: DockerRun;
  /** Whether a recorded owner is still that very process. */
  ownerLive: (pid: number, start: string) => boolean;
  sendSignal: (pid: number, signal: NodeJS.Signals) => void;
  /** A monotonic clock in ms, and a sleep: the wait for a live owner. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** How long a live owner gets to tear itself down. */
  waitMs: number;
  out: (line: string) => void;
}

export type StopOutcome =
  /** No state file: nothing runs. */
  | { kind: "nothing" }
  /** A live owner was signalled and tore itself down. */
  | { kind: "stopped"; pid: number }
  /** A dead owner's containers and Vite group were removed, and its state file deleted. */
  | { kind: "cleaned"; pid: number }
  /** Something could not be stopped or proven gone; the state file, if any, is kept. */
  | { kind: "failed"; message: string };

const DEFAULT_STOP_DEPS: StopDeps = {
  sweep: () => sweepDeadOwners({ role: BACKEND_ROLE }),
  dockerRun: defaultDockerRun,
  ownerLive: isSameProcess,
  sendSignal: (pid, signal) => process.kill(pid, signal),
  now: () => performance.now(),
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  waitMs: STOP_WAIT_MS,
  out: (line) => console.log(line),
};

export type GroupProof = { kind: "gone" } | { kind: "ours" } | { kind: "unproven"; detail: string };

/** Within `dir`, or `dir` itself. */
function within(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

/**
 * Whether process group `pgid` is still the `npm run dev` group a serve-attempt
 * recorded, which started at `start` in `frontendDir`. Never guessed:
 *
 * - no member alive → `gone`;
 * - the leader still exists → `ours` only if its start time is the recorded one
 *   (a different one means the pid was reused and this group is someone else's);
 * - the leader is gone but members live on → while any member lives the group
 *   id cannot be handed out again, but a group that died entirely could have
 *   been re-created under the same id — so every member must also have started
 *   no earlier than the recorded leader and run in `frontendDir`.
 */
export function proveViteGroup(pgid: number, start: string | null, frontendDir: string): GroupProof {
  if (!groupAlive(pgid)) return { kind: "gone" };
  if (start === null) return { kind: "unproven", detail: `process group ${pgid} is alive, but its leader's start time was never recorded` };
  const leader = readProcStat(pgid);
  if (leader !== null) {
    return leader.start === start
      ? { kind: "ours" }
      : { kind: "unproven", detail: `pid ${pgid} now names a process that started at ${leader.start}, not the recorded ${start}: the pid was reused` };
  }
  let realDir: string;
  try {
    realDir = realpathSync(frontendDir);
  } catch (error) {
    return { kind: "unproven", detail: `process group ${pgid} lives on without its leader, and ${frontendDir} cannot be resolved (${message(error)})` };
  }
  const recorded = BigInt(start);
  const members: number[] = [];
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch (error) {
    return { kind: "unproven", detail: `cannot list /proc: ${message(error)}` };
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    const stat = readProcStat(pid);
    if (stat === null || stat.pgrp !== pgid || stat.state === "Z") continue;
    let cwd = "";
    try {
      cwd = readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      // unreadable: not provably ours
    }
    if (BigInt(stat.start) < recorded || !within(cwd, realDir)) {
      return { kind: "unproven", detail: `process group ${pgid} lives on without its leader, and member ${pid} (cwd ${JSON.stringify(cwd)}) cannot be proven to be the dev server's` };
    }
    members.push(pid);
  }
  return members.length === 0 ? { kind: "gone" } : { kind: "ours" };
}

/**
 * Remove a dead owner's recorded scratch directory: `"removed"`, `null` when
 * it is already gone, or why it was left.
 */
function removeScratchDir(dir: string): "removed" | string | null {
  let stat;
  try {
    stat = lstatSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return `${dir}: ${message(error)}`;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!stat.isDirectory() || (uid !== null && stat.uid !== uid)) {
    return `${dir} is no longer a directory this user owns; it was left alone`;
  }
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    return "removed";
  } catch (error) {
    return `could not remove ${dir}: ${message(error)}`;
  }
}

/** A dead owner's leftovers: its containers by label, its scratch directories, its proven Vite group, and — only if all went — its state file. */
async function cleanUpAfter(state: ServeState, root: string, path: string, d: StopDeps): Promise<StopOutcome> {
  const problems: string[] = [];

  const list = d.dockerRun(
    [
      "ps",
      "-a",
      "--filter",
      `label=${LABEL_ROLE}=${BACKEND_ROLE}`,
      "--filter",
      `label=${LABEL_ATTEMPT}=${state.attempt}`,
      "--filter",
      `label=${LABEL_OWNER}=${state.pid}`,
      "--format",
      "{{.Names}}",
    ],
    DOCKER_CLI_TIMEOUT_MS,
  );
  if (list.error !== undefined || list.status !== 0) {
    const why = list.error?.message ?? `exit ${list.status}: ${(list.stderr ?? "").trim()}`;
    problems.push(`could not list pid ${state.pid}'s backend containers (docker ps ${why})`);
  } else {
    const names = (list.stdout ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    for (const name of names) {
      const removal = ensureContainerRemoved(name, {
        consequence: `It may still hold port ${BACKEND_PORT}; remove it with \`docker rm -f ${name}\`.`,
        run: d.dockerRun,
      });
      if (removal.removed) d.out(`removed ${name}`);
      else problems.push(removal.detail);
    }
  }

  // Its recorded scratch directories, only once every container is proven gone
  // (one might still mount them). The sweep below cannot be relied on for
  // them: it keeps any directory whose pid is alive, and a dead owner's pid may
  // since have been reused. A recorded path is exact — `mkdtemp` never hands out
  // a name that exists — so it cannot reach the reusing process's own.
  if (problems.length === 0) {
    for (const dir of state.scratchDirs) {
      const problem = removeScratchDir(dir);
      if (problem === null) continue;
      if (problem === "removed") d.out(`removed ${dir}`);
      else problems.push(problem);
    }
  }

  if (state.viteGroup !== null) {
    const frontendDir = join(root, "eval-attempts", state.attempt, "frontend");
    const proof = proveViteGroup(state.viteGroup, state.viteStart, frontendDir);
    if (proof.kind === "ours") {
      if (await killGroupAndWait(state.viteGroup)) d.out(`killed the dev server's process group ${state.viteGroup}`);
      else problems.push(`the dev server's process group ${state.viteGroup} is still alive after SIGKILL`);
    } else if (proof.kind === "unproven") {
      problems.push(`${proof.detail}; it was not signalled — look at it by hand`);
    }
  }

  sweepAndReport(d.sweep, d.out);

  if (problems.length > 0) {
    return { kind: "failed", message: `${problems.join("\n")}\n${path} is kept; run --stop again once that is fixed.` };
  }
  // Only the file that names that run: a new serve-attempt may have started meanwhile.
  const now = loadStateOnce(path);
  if (now.kind === "ok" && now.state.pid === state.pid && now.state.pidStart === state.pidStart) {
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { kind: "failed", message: `could not delete ${path}: ${message(error)}` };
    }
    d.out(`deleted ${path}`);
  }
  return { kind: "cleaned", pid: state.pid };
}

/**
 * `--stop`: idempotent, in any phase. A live owner (same pid, same start time)
 * gets SIGTERM and up to `waitMs` to tear itself down; a dead one — or one
 * that exited leaving its state file — has its leftovers removed here.
 */
export async function stopServe(root: string, deps: Partial<StopDeps> = {}): Promise<StopOutcome> {
  const d: StopDeps = { ...DEFAULT_STOP_DEPS, ...deps };
  const path = statePath(root);
  const loaded = await loadState(path);

  if (loaded.kind === "missing") {
    sweepAndReport(d.sweep, d.out);
    d.out("nothing is running");
    return { kind: "nothing" };
  }
  if (loaded.kind === "invalid") {
    return {
      kind: "failed",
      message: `${path} cannot be read (${loaded.reason}). It names no process that can be proven running, so it is left alone: look at it, and delete it by hand if nothing is serving.`,
    };
  }

  const state = loaded.state;
  if (d.ownerLive(state.pid, state.pidStart)) {
    d.out(`sending SIGTERM to pid ${state.pid} (serving ${state.attempt}) and waiting for its teardown…`);
    try {
      d.sendSignal(state.pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return { kind: "failed", message: `could not signal pid ${state.pid}: ${message(error)}` };
    }
    const deadline = d.now() + d.waitMs;
    while (d.ownerLive(state.pid, state.pidStart)) {
      if (d.now() >= deadline) {
        return {
          kind: "failed",
          message:
            `pid ${state.pid} is still running ${Math.round(d.waitMs / 1000)} s after SIGTERM; its teardown may be stuck on docker. ` +
            "Run --stop again: a second signal makes it exit at once, removing its containers from its exit handler.",
        };
      }
      await d.sleep(100);
    }
    const after = loadStateOnce(path);
    if (after.kind !== "ok" || after.state.pid !== state.pid || after.state.pidStart !== state.pidStart) {
      d.out(`stopped pid ${state.pid}`);
      return { kind: "stopped", pid: state.pid };
    }
    d.out(`pid ${state.pid} exited but left ${path}: removing what it recorded`);
    // The file as the owner left it, not as it was read before the signal: it
    // may have recorded another Vite try or container since, and that is the
    // part most likely to have outlived its teardown.
    return cleanUpAfter(after.state, root, path, d);
  }
  d.out(`pid ${state.pid} (serving ${state.attempt}) is no longer running: removing what it left`);
  return cleanUpAfter(state, root, path, d);
}

// ---------------------------------------------------------------------------
// CLI

const USAGE = `Usage: node --import tsx scripts/serve-attempt.ts --attempt <dir> [--root <path>] [--ignore-run-json]
       node --import tsx scripts/serve-attempt.ts --stop [--root <path>]

  --attempt <dir>     Attempt directory name, <id>-attempt-<n>: serves the
                      backend of <root>/eval-attempts/<dir> on 127.0.0.1:${BACKEND_PORT}
                      and its frontend's dev server on ${FRONTEND_PORT}, until a signal.
  --root <path>       Holds eval-attempts/, eval-results/ and the state file
                      .cache/serve-attempt.json. Default: this repository.
  --ignore-run-json   Serve without run.json (synthetic attempts only).
  --stop              Stop whatever serve-attempt runs under --root, in any
                      phase; with nothing running, remove what dead ones left.
  --help              Print this message.

Exit 0: --stop left nothing running. 1: refused, a harness fault, or a --stop
that could not finish. 2: usage. 128+N: stopped by a signal.
`;

class UsageError extends Error {}

export type ParsedArgs =
  | { mode: "help" }
  | { mode: "serve"; options: ServeOptions }
  | { mode: "stop"; root: string };

export function parseArgs(argv: string[]): ParsedArgs {
  let attempt: string | null = null;
  let root = REPO_ROOT;
  let ignoreRunJson = false;
  let stop = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const eq = token.startsWith("--") ? token.indexOf("=") : -1;
    const name = eq === -1 ? token : token.slice(0, eq);
    const value = (): string => {
      const next = eq === -1 ? argv[++i] : token.slice(eq + 1);
      if (next === undefined || next === "" || next.startsWith("--")) throw new UsageError(`${name} needs a value`);
      return next;
    };
    const flag = (): true => {
      if (eq !== -1) throw new UsageError(`${name} takes no value`);
      return true;
    };
    switch (name) {
      case "--attempt":
        if (attempt !== null) throw new UsageError("--attempt given twice");
        attempt = value();
        break;
      case "--root":
        root = resolve(value());
        break;
      case "--ignore-run-json":
        ignoreRunJson = flag();
        break;
      case "--stop":
        stop = flag();
        break;
      case "-h":
      case "--help":
        help = true;
        break;
      default:
        throw new UsageError(`unknown argument ${JSON.stringify(token)}`);
    }
  }
  if (help) return { mode: "help" };
  if (stop) {
    if (attempt !== null || ignoreRunJson) throw new UsageError("--stop takes only --root");
    return { mode: "stop", root };
  }
  if (attempt === null) throw new UsageError("--attempt <dir> (or --stop) is required");
  if (!ATTEMPT_DIR_RE.test(attempt)) {
    throw new UsageError(`--attempt takes an attempt directory name like gemini-38-flash-high-attempt-1, not a path; got ${JSON.stringify(attempt)}`);
  }
  return { mode: "serve", options: { attempt, root, ignoreRunJson } };
}

/**
 * Serve with the real signal handlers: the CLI, and the fixture a test drives
 * `--stop` against. Never returns once serving; exits the process on every
 * other path.
 */
export async function runServe(options: ServeOptions, deps: Partial<ServeDeps> = {}): Promise<void> {
  let session: ServeSession | null = null;
  const handlers = installInterruptHandlers({
    cleanups: [
      async () => {
        await session?.stopFrontend();
        await stopAllProcesses();
      },
      async () => {
        await session?.stopBackend();
        await stopAllBackends();
      },
      async () => {
        await session?.releaseState();
      },
    ],
    exitCleanups: [killAllProcessesSync, stopAllBackendsSync, () => session?.releaseStateSync()],
  });

  let outcome: ServeOutcome;
  try {
    outcome = await serveAttempt(options, {
      ...deps,
      interrupted: handlers.interrupted,
      onSession: (s) => {
        session = s;
        deps.onSession?.(s);
      },
    });
  } catch (error) {
    const problems = session === null ? [] : await (session as ServeSession).teardown();
    outcome = {
      kind: "infra",
      message: [`serve-attempt failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`, ...problems].join("\n"),
    };
  }

  if (outcome.kind === "stopped") process.exit(outcome.problems.length === 0 ? 0 : 1);
  if (outcome.kind !== "interrupted") {
    await new Promise((done) => setTimeout(done, SIGNAL_SETTLE_MS));
    if (handlers.interrupted() === null) {
      process.stderr.write(`serve-attempt: ${outcome.message}\n`);
      process.exit(1);
    }
  }
  // Interrupted: the handler finishes its cleanups and exits 128+N.
}

async function main(argv: string[]): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`serve-attempt: ${error.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (args.mode === "help") {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (args.mode === "stop") {
    const outcome = await stopServe(args.root);
    if (outcome.kind === "failed") {
      process.stderr.write(`serve-attempt --stop: ${outcome.message}\n`);
      process.exit(1);
    }
    process.exit(0);
  }
  await runServe(args.options);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`serve-attempt: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  });
}

