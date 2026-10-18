/**
 * The docker CLI helpers the scoring tools share: `contract-tests`,
 * `serve-attempt`, `take-screenshots` and the backend gate all start containers
 * from the harness image, and all of them must be able to prove those containers
 * are gone.
 *
 * Ported from `scripts/run-matrix.ts`, which imports this module too,
 * alongside `contract-tests`, `serve-attempt`, `take-screenshots` and the
 * backend gate. No library installs a process handler at import, and no entry
 * script with a guarded `main` does either (`run-matrix` included); each
 * installs its own from its `main`. This module has no side effect at
 * import — no process handler, no docker call.
 *
 * Every docker call goes through a `DockerRun`, a bounded `spawnSync`, so tests
 * inject a fake and no call can block a signal handler for longer than its
 * timeout. A call that times out never counts as success.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { lstatSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** One docker CLI invocation, bounded by `timeoutMs`. Injectable for tests. */
export type DockerRun = (args: string[], timeoutMs: number) => SpawnSyncReturns<string>;

/**
 * `docker <args>`, killed after `timeoutMs`. `SIGKILL` rather than the default
 * `SIGTERM`: `spawnSync` waits for the child to die after the timeout, so a
 * client that handled `SIGTERM` slowly would stretch the bound it exists to
 * enforce. Killing a client never loses anything the caller relies on — a
 * timed-out call is read as a failure either way.
 */
export const defaultDockerRun: DockerRun = (args, timeoutMs) =>
  spawnSync("docker", args, { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL" });

/** Budget for one short docker CLI call: `rm -f`, `inspect`, `ps`, `port`, `logs`. */
export const DOCKER_CLI_TIMEOUT_MS = 30_000;

/** What the container is for (`backend`, …). The sweep selects on it. */
export const LABEL_ROLE = "agrav.role";
/** The attempt directory name the container serves. */
export const LABEL_ATTEMPT = "agrav.attempt";
/** The host pid of the process that started it. A dead owner makes it sweepable. */
export const LABEL_OWNER = "agrav.owner";

/** docker's own container-name grammar; also keeps a name from reading as a flag. */
export const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
/** What the daemon says about a container it does not know. */
const NO_SUCH_CONTAINER_RE = /no such (?:object|container)/i;
/** docker's messages are one line; a runaway stderr must not swamp a detail. */
const DETAIL_STDERR_CHARS = 500;

/** `--user` for every container: the host uid and gid, so bind mounts stay host-owned. */
export function userSpec(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const gid = typeof process.getgid === "function" ? process.getgid() : 0;
  return `${uid}:${gid}`;
}

function timedOut(result: SpawnSyncReturns<string>): boolean {
  return (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
}

/** The call ran to completion and exited 0. A timed-out call never counts. */
export function succeeded(result: SpawnSyncReturns<string>): boolean {
  return result.error === undefined && result.status === 0;
}

/**
 * The daemon answered, and what it said is that it does not know the
 * container. Only this proves a container gone; any other failure proves nothing.
 */
export function saysNoSuchContainer(result: SpawnSyncReturns<string>): boolean {
  return result.error === undefined && result.status !== null && result.status !== 0 && NO_SUCH_CONTAINER_RE.test(result.stderr ?? "");
}

/** One line on how a docker call ended, for error messages and `detail`. */
export function describeCall(result: SpawnSyncReturns<string>, timeoutMs: number): string {
  if (timedOut(result)) return `timed out after ${timeoutMs} ms`;
  if (result.error !== undefined) return result.error.message;
  if (result.signal !== null && result.signal !== undefined) return `killed by ${result.signal}`;
  const stderr = (result.stderr ?? "").trim();
  const shown = stderr.length > DETAIL_STDERR_CHARS ? `${stderr.slice(0, DETAIL_STDERR_CHARS)}…` : stderr;
  return `exit ${result.status}${shown === "" ? "" : `: ${shown}`}`;
}

/**
 * `<tag>@<image Id>`. A locally built image has no registry digest to pin, so
 * the Id is what identifies the bytes a result was produced with. Throws when
 * the image is not available locally — or when the daemon cannot say.
 */
export function resolveImageRef(image: string, run: DockerRun = defaultDockerRun): string {
  if (image === "" || image.startsWith("-")) {
    throw new Error(`not an image reference: ${JSON.stringify(image)}`);
  }
  const result = run(["image", "inspect", "-f", "{{.Id}}", image], DOCKER_CLI_TIMEOUT_MS);
  const id = succeeded(result) ? (result.stdout ?? "").trim() : "";
  if (id !== "" && !/\s/.test(id)) return `${image}@${id}`;
  throw new Error(
    `could not resolve image ${image} to an image Id ` +
      `(docker image inspect ${describeCall(result, DOCKER_CLI_TIMEOUT_MS)}${id === "" ? "" : `, stdout ${JSON.stringify(id)}`}).\n` +
      `If it is missing, build it with \`docker build -t ${image} images/harness\` (see images/harness/IMAGE.md).`,
  );
}

/** The bare Id every container runs by must be this: what `imageIdOf` and `resolveImageId` accept. */
const IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/;

/** The bare `sha256:<64 hex>` Id at the end of a `<tag>@<Id>` reference. Throws on anything else. */
export function imageIdOf(ref: string): string {
  const id = ref.slice(ref.lastIndexOf("@") + 1);
  if (!ref.includes("@") || !IMAGE_ID_RE.test(id)) {
    throw new Error(`the image resolved to ${JSON.stringify(ref)}, which does not end in @sha256:<64 hex>`);
  }
  return id;
}

/**
 * `resolveImageRef`, and the bare Id the scoring tools run every container by:
 * `ref` is `<tag>@<Id>`, what a result records; `id` is `sha256:<64 hex>`, so a
 * retag during a run cannot change what later containers run. Throws when the
 * image cannot be resolved, or its Id is not `sha256:<64 hex>`.
 */
export function resolveImageId(image: string, run: DockerRun = defaultDockerRun): { ref: string; id: string } {
  const ref = resolveImageRef(image, run);
  return { ref, id: imageIdOf(ref) };
}

export interface ContainerRemoval {
  /**
   * By default, true only when the daemon has confirmed the container is gone
   * ("no such container" after the `rm -f`). With `notRunningCountsAsRemoved`,
   * also when the daemon says it exists but is not running, or when `rm -f`
   * itself exited 0 — which is taken on trust, with no `inspect` after it.
   */
  removed: boolean;
  detail: string;
}

export interface EnsureContainerRemovedOptions {
  /** What an unremoved container means for the caller; appended to `detail` when not removed. */
  consequence: string;
  /** Per docker call. A call that times out means "not removed". Default `DOCKER_CLI_TIMEOUT_MS`. */
  timeoutMs?: number;
  /**
   * Accept "exists but not running" — and a plain successful `rm -f` — as
   * removal. Right only for `--rm` containers, whose daemon reaps them on
   * exit. Default false: only "no such container" proves removal.
   */
  notRunningCountsAsRemoved?: boolean;
  run?: DockerRun;
}

/**
 * Make sure a container is really gone, and *prove* it.
 *
 * Killing a docker client does not stop its container, and a detached server
 * never exits on its own, so the `docker rm -f` is load-bearing and its result
 * cannot be discarded. It is not proof on its own either way:
 *
 * - a non-zero `rm -f` may just mean the daemon already reaped the container,
 *   so the daemon is asked before concluding anything;
 * - a zero `rm -f` is still followed by `docker inspect`, unless
 *   `notRunningCountsAsRemoved` is set: only "no such container" proves that
 *   nothing with this name holds a port, a mount or a pid any more.
 *
 * Anything the daemon cannot answer counts as **not** removed — an unreachable
 * daemon is where a survivor is most likely, not least. A timed-out `rm -f`
 * ends the check at once, as not removed: a daemon that did not answer within
 * the budget is not asked again, which keeps the worst case of a cleanup run
 * from a signal handler at one timeout per container.
 *
 * Every call is bounded, and the consequence text is the caller's.
 * "Exists but not running" is accepted only when asked for: for a named
 * container that is not `--rm`, it means the container, and its name, are
 * still there.
 */
export function ensureContainerRemoved(name: string, options: EnsureContainerRemovedOptions): ContainerRemoval {
  const timeoutMs = options.timeoutMs ?? DOCKER_CLI_TIMEOUT_MS;
  const run = options.run ?? defaultDockerRun;
  const notRunningCountsAsRemoved = options.notRunningCountsAsRemoved ?? false;
  const notRemoved = (what: string): ContainerRemoval => ({
    removed: false,
    detail: `${what}. ${options.consequence}`,
  });

  if (!CONTAINER_NAME_RE.test(name)) {
    return notRemoved(`${JSON.stringify(name)} is not a container name, so docker was not asked to remove it`);
  }

  const removal = run(["rm", "-f", name], timeoutMs);
  if (timedOut(removal)) {
    return notRemoved(`docker rm -f ${name} timed out after ${timeoutMs} ms, so the daemon may still hold it`);
  }
  if (succeeded(removal) && notRunningCountsAsRemoved) {
    return { removed: true, detail: `docker rm -f ${name} succeeded` };
  }
  const rmSaid = succeeded(removal)
    ? `docker rm -f ${name} succeeded`
    : `docker rm -f ${name} failed (${describeCall(removal, timeoutMs)})`;

  const inspect = run(["inspect", "-f", "{{.State.Running}}", name], timeoutMs);
  const running = (inspect.stdout ?? "").trim();
  if (saysNoSuchContainer(inspect)) {
    return { removed: true, detail: `${rmSaid}; the daemon no longer knows container ${name}` };
  }
  if (notRunningCountsAsRemoved && succeeded(inspect) && running === "false") {
    return { removed: true, detail: `${rmSaid}; container ${name} exists but is not running` };
  }
  return notRemoved(
    `${rmSaid}, and the daemon would not confirm that container ${name} is gone ` +
      `(docker inspect ${describeCall(inspect, timeoutMs)}, stdout ${JSON.stringify(running)})`,
  );
}

/** True when a process with this pid exists — `EPERM` (somebody else's) included. */
export function pidIsAlive(pid: number): boolean {
  // 0 and negative pids address process groups, not a process.
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface SweepResult {
  removedContainers: string[];
  removedDirs: string[];
  /** One human-readable line per container or directory that should have gone and did not. */
  failed: string[];
}

export interface SweepOptions {
  /** The `agrav.role` label value to sweep, e.g. `backend`. */
  role: string;
  /** Where scratch directories live. Default `os.tmpdir()`, as for `mkdtemp`. */
  tmpRoot?: string;
  run?: DockerRun;
  isAlive?: (pid: number) => boolean;
}

const ROLE_RE = /^[a-z0-9][a-z0-9_.-]*$/;

/**
 * The `mkdtemp` prefix of every scratch directory a scoring tool creates for
 * the process `pid`: `agrav-backend-<pid>-`. Create them only through this, so
 * `sweepDeadOwners` can find what a dead owner left.
 */
export function scratchDirPrefix(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`not a pid: ${pid}`);
  return `agrav-backend-${pid}-`;
}

/**
 * What `mkdtemp(join(<tmpRoot>, scratchDirPrefix(<pid>)))` names a directory:
 * the prefix, then exactly six `[A-Za-z0-9]`. Group 1 is the pid. Exactly the
 * names the sweep will consider.
 */
export const SCRATCH_DIR_RE = /^agrav-backend-(\d+)-[A-Za-z0-9]{6}$/;

/** A pid label or name segment, or `null` when it is not one — which is never swept. */
function parseOwner(text: string): number | null {
  if (!/^[1-9]\d{0,9}$/.test(text)) return null;
  const pid = Number(text);
  return pid <= 0x7fffffff ? pid : null;
}

/** A scratch directory and the pid its name says owns it. */
export interface ScratchDir {
  /** `join(tmpRoot, entry)`. */
  path: string;
  entry: string;
  owner: number;
}

/**
 * The scratch directories under `tmpRoot` (`SCRATCH_DIR_RE`, with a valid
 * owner pid) that are real directories, not symlinks, owned by this uid —
 * of the pids in `owners`, or of any pid when it is left out. Sorted by name.
 * Throws when `tmpRoot` cannot be listed; a directory that vanishes meanwhile
 * is skipped. The one scan the sweep, `serve-attempt` and gate 3a share.
 */
export function scratchDirsOwnedBy(tmpRoot: string, owners?: ReadonlySet<number>): ScratchDir[] {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const dirs: ScratchDir[] = [];
  for (const entry of readdirSync(tmpRoot).sort()) {
    const match = SCRATCH_DIR_RE.exec(entry);
    const owner = match === null ? null : parseOwner(match[1]);
    if (owner === null || (owners !== undefined && !owners.has(owner))) continue;
    const path = join(tmpRoot, entry);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      continue; // gone in the meantime
    }
    if (!stat.isDirectory() || (uid !== null && stat.uid !== uid)) continue;
    dirs.push({ path, entry, owner });
  }
  return dirs;
}

/**
 * Remove what a run that died without cleaning up left behind: containers
 * labelled `agrav.role=<role>` whose `agrav.owner` pid is dead, and scratch
 * directories `<tmpRoot>/agrav-backend-<pid>-XXXXXX` (`SCRATCH_DIR_RE`, made
 * through `scratchDirPrefix`) whose pid is dead.
 *
 * Two assumptions, neither checked:
 *
 * - **One pid namespace.** "Dead" is `kill(pid, 0)` in the sweeper's own pid
 *   namespace. A tool running in another one — a sandboxed shell that unshares
 *   pids, a containerised tool — sees a live owner's pid as dead (or as some
 *   other process), and would `rm -f` that owner's running containers. Every
 *   tool that starts or sweeps these containers must run in the same pid
 *   namespace, against the same daemon.
 * - **One temp directory.** Directories are looked for under `tmpRoot`,
 *   default `os.tmpdir()`, i.e. the sweeper's `TMPDIR`. A leftover created by
 *   a process with a different `TMPDIR` (an agent shell versus an operator
 *   shell, say) is never seen, so never swept; it only costs disk.
 *
 * Only `SIGKILL` (an agent tool's timeout, the `tsx` bin wrapper) or a crash can
 * leave these, and a leftover serving container keeps its host port — 5100 for
 * `serve-attempt` — so the next run cannot start. Unlike the credential
 * directories `run-matrix` can only warn about, nothing here holds a secret, so
 * the sweep removes rather than names.
 *
 * It never touches anything whose owner is alive or cannot be parsed. A reused
 * pid reads as alive, which keeps a leftover rather than removing a live run's.
 * A directory is kept when its owner still has a container of this role that
 * would not go, because that container may still mount it; and all directories
 * are kept when the containers could not be listed at all, for the same
 * reason. (Scratch directories belong to `backend` containers, so that guard is
 * complete for `role: "backend"` only.) Directories
 * are matched by lstat — never through a symlink — and only when owned by this
 * uid, since the temp directory is shared.
 */
export function sweepDeadOwners(options: SweepOptions): SweepResult {
  const run = options.run ?? defaultDockerRun;
  const tmpRoot = options.tmpRoot ?? tmpdir();
  const isAliveRaw = options.isAlive ?? pidIsAlive;
  if (!ROLE_RE.test(options.role)) throw new Error(`not a role label value: ${JSON.stringify(options.role)}`);

  // One answer per pid for the whole sweep, so a container and a directory of
  // the same owner are never judged differently.
  const liveness = new Map<number, boolean>();
  const isAlive = (pid: number): boolean => {
    let alive = liveness.get(pid);
    if (alive === undefined) {
      alive = isAliveRaw(pid);
      liveness.set(pid, alive);
    }
    return alive;
  };

  const result: SweepResult = { removedContainers: [], removedDirs: [], failed: [] };
  const ownersWithSurvivors = new Set<number>();

  const list = run(
    ["ps", "-a", "--filter", `label=${LABEL_ROLE}=${options.role}`, "--format", `{{.Names}} {{.Label "${LABEL_OWNER}"}}`],
    DOCKER_CLI_TIMEOUT_MS,
  );
  if (!succeeded(list)) {
    result.failed.push(
      `docker ps for ${LABEL_ROLE}=${options.role} ${describeCall(list, DOCKER_CLI_TIMEOUT_MS)}; ` +
        "no container was swept, and no scratch directory either, since a container might still mount one",
    );
    return result;
  }

  for (const line of (list.stdout ?? "").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const space = trimmed.search(/\s/);
    const name = space === -1 ? trimmed : trimmed.slice(0, space);
    const owner = parseOwner(space === -1 ? "" : trimmed.slice(space).trim());
    if (owner === null || isAlive(owner)) continue;
    const removal = ensureContainerRemoved(name, {
      consequence: `It was left by pid ${owner}, which is gone; remove it by hand with \`docker rm -f ${name}\`.`,
      run,
    });
    if (removal.removed) {
      result.removedContainers.push(name);
    } else {
      result.failed.push(`container ${name}: ${removal.detail}`);
      ownersWithSurvivors.add(owner);
    }
  }

  let dirs: ScratchDir[];
  try {
    dirs = scratchDirsOwnedBy(tmpRoot);
  } catch (error) {
    result.failed.push(`could not list ${tmpRoot}: ${(error as Error).message}`);
    return result;
  }
  for (const { path, owner } of dirs) {
    if (isAlive(owner)) continue;
    if (ownersWithSurvivors.has(owner)) {
      result.failed.push(`${path}: kept, because a container left by pid ${owner} could not be removed and may still mount it`);
      continue;
    }
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      result.removedDirs.push(path);
    } catch (error) {
      result.failed.push(`${path}: ${(error as Error).message}`);
    }
  }
  return result;
}
