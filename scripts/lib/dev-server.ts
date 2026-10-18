/**
 * The host-side frontend of an attempt, shared by `serve-attempt` and
 * `take-screenshots` (spec §5, "scripts/lib/dev-server.ts"): the frontend's
 * `npm install`, `npm run dev` on the host (Ruling R7), the registry probe
 * that tells a model's broken install from an unreachable registry, the port
 * checks, and the process-group plumbing that makes sure nothing spawned here
 * outlives the function that spawned it (Ruling R26).
 *
 * `ensureNodeModules` and the process-group helpers moved here from
 * `take-screenshots.ts`, less the Astro daemon handling, which the
 * maintenance-console task has no use for: the model's frontend is Vite, and
 * `npm run dev` stays in the foreground of the group it leads. Two changes
 * since: the install timeout's advice to the operator is the caller's to give,
 * and a process stays tracked until its group is proven gone (below).
 *
 * No side effect at import: no process handler, no spawn. An entry script
 * wires `stopAllProcesses` into `installInterruptHandlers`' cleanups and
 * `killAllProcessesSync` into its `exitCleanups`.
 *
 * A process stays tracked until its group is *proven* gone — not merely until
 * someone has started to kill it — so a stop, or an exit listener's SIGKILL,
 * always reaches a group whose kill is still in flight.
 *
 * Every child is spawned `detached`, so it leads a process group of its own,
 * and is killed and waited for by group (`-pid`), never by leader: `npm run
 * dev` is `npm` → `sh -c vite` → `node`, and killing only the leader leaves the
 * server holding its port. POSIX only.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { LIMITS } from "./rubric";

/** This repository, where `npm ping` runs: it has no `.npmrc`, so the probe asks the default registry. */
const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const CLEANUP_WAIT_MS = 3000;
/** The longest one `killAndWait` (or `killGroupAndWait`) takes: SIGTERM and its grace, then SIGKILL and its grace. */
export const KILL_WAIT_MS = 2 * CLEANUP_WAIT_MS;

/**
 * Every child spawned here (or handed to `trackProcess` or `killAndWait`)
 * whose process group has not been proven gone. A kill in flight does not
 * untrack it; only `killAndWait` seeing the group gone — or the leader's
 * `close` with no member left — does.
 */
const activeProcesses = new Set<ChildProcess>();
/** The `killAndWait` in flight for a process, which a second caller joins. */
const inflightKills = new Map<ChildProcess, Promise<void>>();
/** The stop in flight, if any: a second caller joins it rather than returning early. */
let stopping: Promise<void> | null = null;
/**
 * Every child this module has signalled. A child that ended by a signal and is
 * not in here was ended by something outside the harness (`ensureNodeModules`).
 */
const signalledHere = new WeakSet<ChildProcess>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Track `proc` until its group is proven gone. Idempotent. */
function track(proc: ChildProcess): void {
  if (activeProcesses.has(proc)) return;
  activeProcesses.add(proc);
  // A group that dies on its own is untracked with its leader, so an exit
  // listener's SIGKILL never goes to a group id that may since have been reused.
  proc.once("close", () => {
    if (proc.pid === undefined || !groupAlive(proc.pid)) activeProcesses.delete(proc);
  });
}

/** Put a detached child a caller spawned itself under `stopAllProcesses` and `killAllProcessesSync`. */
export function trackProcess(proc: ChildProcess): void {
  track(proc);
}

/**
 * The process groups of tracked children still alive — after a stop, the ones
 * that outlived SIGKILL. A teardown that finds any cannot claim it left
 * nothing running.
 */
export function survivingGroups(): number[] {
  const groups: number[] = [];
  for (const proc of activeProcesses) {
    if (proc.pid !== undefined && groupAlive(proc.pid)) groups.push(proc.pid);
  }
  return groups;
}

/** Listen on `port` (on `host`, or the unspecified address) and close again; false when the bind fails. */
function canListen(port: number, host?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    // Resolve only once the socket is closed, so the next bind in this process
    // cannot collide with this probe.
    server.once("listening", () => server.close(() => resolve(true)));
    if (host === undefined) server.listen(port);
    else server.listen(port, host);
  });
}

/**
 * The ports in `ports` that something already holds, in the order given.
 *
 * Each is bound twice, on `127.0.0.1` and on the unspecified address, and is
 * busy when either bind fails: a docker-proxy on `127.0.0.1:5100` does not stop
 * an IPv6-only bind, and a dev server on `[::1]:5173` does not stop a
 * `127.0.0.1` one, but each of them breaks one of the two.
 */
export async function busyPorts(ports: number[]): Promise<number[]> {
  const busy: number[] = [];
  for (const port of ports) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError(`not a TCP port: ${port}`);
    if (!(await canListen(port, "127.0.0.1")) || !(await canListen(port))) busy.push(port);
  }
  return busy;
}

/**
 * Kill the process and everything it started. `-pid` is its process group,
 * which is why every child here is spawned detached; the single-process
 * fallback is for a child that died before it could lead a group.
 *
 * This only *asks*. Where the answer matters, use `killAndWait`.
 */
function killProcess(proc: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  if (proc.pid !== undefined) {
    signalledHere.add(proc);
    try {
      process.kill(-proc.pid, signal);
    } catch {
      try {
        proc.kill(signal);
      } catch {
        /* already gone */
      }
    }
  }
}

/**
 * Whether any member of the process group `pgid` is still alive.
 *
 * The question `killAndWait` actually has to answer. `proc.exitCode` answers a
 * narrower one — whether the *direct child* is gone — and the two come apart
 * exactly when it matters: a shell that exec'd, crashed or exited while the
 * server it started kept the port.
 */
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll until the group is gone, up to `ms`. Resolves to whether it went. */
async function groupGoneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (groupAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
  return true;
}

/**
 * Kill a spawned process group and do not return until it is actually gone.
 *
 * **Ruling R26: nothing spawned here may outlive the function that spawned
 * it, on any path.** `killProcess` alone cannot promise that. Three separate
 * failures needed this:
 *
 * - a dev server that never satisfied the readiness test was dropped from
 *   `activeProcesses` and *not* killed, so it survived the run, was invisible to
 *   the cleanup, and — being detached — was out of reach of Ctrl-C;
 * - `ensureNodeModules` removed an install-created `package-lock.json` on the
 *   same tick as the SIGTERM, while npm was still shutting down. A lockfile
 *   written during that shutdown landed *after* the cleanup and survived, in a
 *   directory that is supposed to hold model output only;
 * - and this function's own first version short-circuited on "the direct child
 *   has already exited", which is **not** evidence that its group is dead.
 *
 * So the whole thing is asked of the *group*, never of the leader. SIGTERM
 * first, because npm and Vite both clean up on it — the install's lockfile
 * write happens inside that window and has to be allowed to finish — then
 * SIGKILL if anything is still there after `CLEANUP_WAIT_MS`, because a child
 * that traps SIGTERM must not be able to make this wait forever. Both waits are
 * bounded, so the worst case is `2 × CLEANUP_WAIT_MS` and never a hang, and the
 * common case costs one `kill(pgid, 0)` and no waiting at all.
 *
 * One accepted window: signalling `-pid` after the leader has been reaped could
 * in principle reach a recycled pgid. It needs the whole pid space to wrap
 * inside a teardown, and the alternative is leaving live processes behind,
 * which is the failure this exists to prevent.
 *
 * The process stays tracked while this runs, and is untracked only once its
 * group is seen gone: a `stopAllProcesses` started meanwhile waits for this
 * kill instead of returning past it, and an exit listener's
 * `killAllProcessesSync` still SIGKILLs the group. A group that outlives
 * SIGKILL stays tracked (`survivingGroups` names it). A second call for the
 * same process while one is in flight joins it.
 */
export function killAndWait(proc: ChildProcess): Promise<void> {
  const pid = proc.pid;
  if (pid === undefined) {
    // never spawned; there is no group to signal
    activeProcesses.delete(proc);
    return Promise.resolve();
  }
  const inflight = inflightKills.get(proc);
  if (inflight !== undefined) return inflight;

  track(proc);
  const run = (async () => {
    // Nothing to signal once every member is gone; the check is `kill(-pid, 0)`.
    if (groupAlive(pid)) {
      killProcess(proc, "SIGTERM");
      if (!(await groupGoneWithin(pid, CLEANUP_WAIT_MS))) {
        killProcess(proc, "SIGKILL");
        await groupGoneWithin(pid, CLEANUP_WAIT_MS);
      }
    }
    if (!groupAlive(pid)) activeProcesses.delete(proc);
  })();
  inflightKills.set(proc, run);
  // Cleared once settled — after the assignment above, even when `run` settled
  // at once — so a later call for the same process starts afresh.
  const clear = (): void => {
    if (inflightKills.get(proc) === run) inflightKills.delete(proc);
  };
  run.then(clear, clear);
  return run;
}

/**
 * `killAndWait`'s semantics for a process group known only by its id — one
 * another process started (`serve-attempt --stop` for a dead owner's Vite).
 * The caller must have proven the group is the one it means: this signals
 * `-pgid` as it is. Resolves to whether the group is gone.
 */
export async function killGroupAndWait(pgid: number): Promise<boolean> {
  if (!Number.isInteger(pgid) || pgid <= 1) throw new RangeError(`not a process group id: ${pgid}`);
  const signal = (sig: NodeJS.Signals): void => {
    try {
      process.kill(-pgid, sig);
    } catch {
      /* gone */
    }
  };
  signal("SIGTERM");
  if (await groupGoneWithin(pgid, CLEANUP_WAIT_MS)) return true;
  signal("SIGKILL");
  return groupGoneWithin(pgid, CLEANUP_WAIT_MS);
}

/**
 * Kill and wait for every tracked process group, all at once, so the whole
 * cleanup is bounded by one child's grace period and not by their number.
 *
 * A group whose kill is already in flight — a `startVite` try being aborted,
 * an install being cut short — is still tracked, so this joins that kill and
 * waits for it rather than returning past it. Children tracked while it runs
 * are caught too; each is tried once per call, so a group that outlives
 * SIGKILL ends the call (and stays tracked) instead of spinning it.
 *
 * A second call while one is in flight joins it — it never returns before the
 * first has finished, which is what lets a signal handler wait for a teardown
 * already under way instead of exiting in the middle of it.
 */
export function stopAllProcesses(): Promise<void> {
  if (stopping !== null) return stopping;
  const run = (async () => {
    if (activeProcesses.size === 0) return;
    console.log("\nStopping tracked processes...");
    const tried = new Set<ChildProcess>();
    for (;;) {
      const batch = [...activeProcesses].filter((proc) => !tried.has(proc));
      if (batch.length === 0) return;
      for (const proc of batch) tried.add(proc);
      await Promise.all(batch.map((proc) => killAndWait(proc)));
    }
  })();
  stopping = run;
  // Cleared once settled — after the assignment above, even when `run` had
  // nothing to do and settled at once — so the next call stops afresh.
  const clear = (): void => {
    if (stopping === run) stopping = null;
  };
  run.then(clear, clear);
  return run;
}

/**
 * For an `exit` listener: SIGKILL every tracked process group, without
 * waiting — those whose `killAndWait` is still in its SIGTERM grace included.
 * The last resort when a second signal cuts the real cleanup short; SIGKILL
 * cannot be trapped, so the groups die even though nothing here waits. Nothing
 * is untracked: none of them is proven gone yet.
 */
export function killAllProcessesSync(): void {
  for (const proc of [...activeProcesses]) {
    try {
      killProcess(proc, "SIGKILL");
    } catch {
      // each one individually
    }
  }
}

// --- /proc: which process a pid names ------------------------------------------

export interface ProcStat {
  /** Field 3: `R`, `S`, `Z`, … */
  state: string;
  /** Field 5. */
  pgrp: number;
  /** Field 22, clock ticks after boot, as the kernel prints it. */
  start: string;
}

/** Fields 3, 5 and 22 of `/proc/<pid>/stat`, or `null` when there is no such process (or no `/proc`). */
export function readProcStat(pid: number): ProcStat | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name may hold spaces and parentheses; everything after the last ")" is fixed.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const start = fields[19];
    if (start === undefined || !/^\d+$/.test(start)) return null;
    return { state: fields[0], pgrp: Number(fields[2]), start };
  } catch {
    return null;
  }
}

/**
 * The start time of `pid` — field 22 of `/proc/<pid>/stat` — or `null` when it
 * cannot be read. With the pid, it names one process: a recycled pid has
 * another start time.
 */
export function pidStartTime(pid: number): string | null {
  return readProcStat(pid)?.start ?? null;
}

/** Whether `pid` is still the process that started at `start`, and not a zombie. */
export function isSameProcess(pid: number, start: string | null): boolean {
  if (start === null) return false;
  const stat = readProcStat(pid);
  return stat !== null && stat.state !== "Z" && stat.start === start;
}

// --- npm ------------------------------------------------------------------------

/**
 * `npm install` ended by a signal the harness did not send — the kernel's OOM
 * killer, an operator's `kill`: something outside it stopped the install, so
 * its failure says nothing about the model. A harness fault, whatever the
 * registry answers. An exit *code* of 128+N is not this: npm returns 137 or 134
 * for a lifecycle script of the model's own that crashed.
 *
 * One edge makes the model's own crash look like this. The install runs in the
 * attempt directory, so a model's `.npmrc` there can set
 * `foreground-scripts=true`; npm then re-raises a lifecycle script's
 * terminating signal on itself, and a postinstall of the model's that dies by
 * SIGSEGV or SIGKILL ends npm by that signal. It is conservative — re-run as
 * infra, never a false zero — but a judge who sees one attempt come back infra
 * every time should check that attempt's `.npmrc`.
 */
export class InstallKilledError extends Error {
  readonly signal: NodeJS.Signals;
  constructor(signal: NodeJS.Signals) {
    super(`npm install was killed by ${signal}, which the harness did not send: something outside it ended the install, so it says nothing about the model`);
    this.name = "InstallKilledError";
    this.signal = signal;
  }
}

/** How much of `npm install`'s stderr is kept while it runs; its last 500 characters go into the error. */
const STDERR_KEEP_CHARS = 8 * 1024;

/**
 * `npm install`, plainly — the same command the scoring skill runs, so the tree
 * served or photographed is the tree that was scored. Neither `--ignore-scripts`
 * nor a sandbox (Ruling R7), and no `--no-package-lock`: that flag makes npm
 * ignore an existing lockfile and resolve afresh, which would let the picture
 * and the score disagree about which versions were installed.
 *
 * A lockfile npm wrote is removed again afterwards. `eval-attempts/` holds model
 * output only, and a `package-lock.json` this function created is not that; one
 * the model wrote is left exactly as it was found. `node_modules/` stays — it is
 * gitignored, and re-installing it for every later run would cost hours.
 *
 * In the normal pipeline order (score, then serve or photograph) this whole
 * function is a no-op: the scoring skill has already installed, so
 * `node_modules` exists. The lockfile in an attempt directory will usually be
 * that install's, not this one's.
 *
 * `timeoutHint` is appended to the timeout's message: what the caller's
 * operator can do about it (take-screenshots has `--install-timeout`;
 * serve-attempt's bound is the rubric's and has no flag).
 *
 * npm's stdout goes nowhere: nothing reads it, and a pipe nobody reads fills
 * and blocks npm — a chatty lifecycle script would then run into the timeout,
 * a frontend stop for a harness fault. Its stderr is kept, its tail quoted in
 * the error. npm ended by a signal this module did not send rejects with
 * `InstallKilledError`.
 */
export async function ensureNodeModules(projectRoot: string, timeoutMs: number, timeoutHint?: string): Promise<void> {
  if (existsSync(join(projectRoot, "node_modules"))) return;

  const lockPath = join(projectRoot, "package-lock.json");
  const lockExisted = existsSync(lockPath);

  console.log("  Installing dependencies...");
  // Spawned outside the promise so the `finally` below owns it on every path —
  // resolve, reject, timeout and throw alike (Ruling R26). No shell: npm leads
  // the group itself, so the signal that ended it is the one it reports.
  const proc = spawn("npm", ["install"], {
    cwd: projectRoot,
    stdio: ["ignore", "ignore", "pipe"],
    // Its own group, so the timeout below and a Ctrl-C can take npm's whole
    // tree of children down with it.
    detached: true,
  });
  track(proc);

  try {
    await new Promise<void>((resolve, reject) => {
      let stderr = "";
      let timedOut = false;
      // The timeout only *decides*; killing is the `finally`'s job, so the
      // cleanup below cannot run while npm is still dying.
      const timer = setTimeout(() => {
        timedOut = true;
        reject(
          new Error(
            `npm install did not finish within ${Math.round(timeoutMs / 1000)}s.` + (timeoutHint === undefined ? "" : ` ${timeoutHint}`),
          ),
        );
      }, timeoutMs);

      proc.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-STDERR_KEEP_CHARS);
      });

      proc.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      proc.on("close", (code, signal) => {
        clearTimeout(timer);
        if (timedOut) return; // already rejected; this is the kill landing
        if (code === 0) resolve();
        else if (signal !== null && !signalledHere.has(proc)) reject(new InstallKilledError(signal));
        else reject(new Error(`npm install failed (${code === null ? `ended by ${signal}` : `exit ${code}`}): ${stderr.slice(-500)}`));
      });
    });
  } finally {
    // Order matters. npm writes `package-lock.json` as part of shutting down, so
    // removing the file before the child is gone removes nothing and the file
    // lands a moment later — an install artefact left in a directory that holds
    // model output only, un-gitignored, ready to be committed as the model's.
    // On the success and failure paths this is a no-op: npm has already exited.
    await killAndWait(proc);
    // Also on failure or timeout: a half-finished install still leaves the file
    // behind.
    if (!lockExisted && existsSync(lockPath)) rmSync(lockPath, { force: true });
  }
}

/**
 * `npm ping`, bounded: true only when it exits 0 within `timeoutMs`.
 *
 * Asked after a frontend `npm install` failed or timed out, to decide whose
 * failure it was (spec §4, Ruling R23 as amended): the registry answering
 * means the install failed on its own — the model's; the registry not
 * answering means nothing about the model — infra. `npm ping` goes to the
 * configured registry every time, where `npm view` would answer a stale
 * cached entry while the registry is unreachable.
 *
 * It runs from this repository's root, whoever calls it and from wherever: a
 * probe run in the attempt would read the model's `.npmrc`, and an install
 * broken by the model's own registry setting would then be excused as infra.
 */
export function probeRegistry(timeoutMs: number = LIMITS.registryProbeMs): Promise<boolean> {
  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn("npm", ["ping"], { cwd: REPO_ROOT, stdio: "ignore", detached: true });
    } catch {
      resolve(false);
      return;
    }
    track(proc);
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // The group is gone before the answer is given, on every path.
      void killAndWait(proc).then(() => resolve(ok));
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    proc.on("error", () => finish(false));
    proc.on("close", (code) => finish(code === 0));
  });
}

// --- the dev server -------------------------------------------------------------

export interface ViteServer {
  /** `npm run dev`, the leader of its own process group. Stop it with `killAndWait`. */
  proc: ChildProcess;
  /** The port the banner named, which answered HTTP. The run contract's is 5173; the caller warns on any other. */
  port: number;
  /** The `Local:` URL as the banner printed it, e.g. `http://localhost:5173/`. */
  url: string;
}

export interface StartViteOptions {
  /** One try's budget, from spawn to an HTTP answer. Default `LIMITS.devServerStartMs`. */
  timeoutMs?: number;
  /** Tries after the first. Default `LIMITS.devServerRetries`. */
  retries?: number;
  /** Aborting it kills the try in flight and starts no other; `startVite` then rejects with a plain `Error`. */
  signal?: AbortSignal;
  /** Called with each spawned leader's pid — the process group's id — right after the spawn. */
  onSpawn?: (pid: number) => void;
}

/**
 * `npm run dev` never served: every try exited, printed no `Local:` URL, or
 * printed one that did not answer HTTP in time. A frontend stop (spec §4).
 */
export class DevServerError extends Error {
  /** The last lines of the last try's output, ANSI stripped; may be empty. */
  readonly outputTail: string;
  constructor(message: string, outputTail: string) {
    super(message);
    this.name = "DevServerError";
    this.outputTail = outputTail;
  }
}

/** CSI sequences, OSC strings and two-byte escapes: what a coloured or TTY-minded dev server prints. */
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/**
 * Vite's banner line, ANSI stripped: `➜  Local:   http://localhost:5173/`.
 * Group 1 is the URL, 2 the host, 3 the port.
 */
export const LOCAL_BANNER_RE = /Local:\s+(http:\/\/(localhost|127\.0\.0\.1|\[::1\]):(\d{1,5})(?:\/\S*)?)/;

/** How much of a try's raw output is kept: the banner is searched in it and the error's tail comes from it. */
const OUTPUT_KEEP_CHARS = 64 * 1024;

/** The URL from a `Local:` banner in `output` (ANSI stripped first), or `null`. */
export function parseLocalBanner(output: string): { url: string; port: number } | null {
  const match = LOCAL_BANNER_RE.exec(stripAnsi(output));
  if (match === null) return null;
  const port = Number(match[3]);
  if (port < 1 || port > 65535) return null;
  const url = match[1].slice(match[1].indexOf("//") + 2).includes("/") ? match[1] : `${match[1]}/`;
  return { url, port };
}

/** One readiness request, bounded to `LIMITS.devServerProbeMs`; any HTTP answer counts. */
async function answersHttp(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(LIMITS.devServerProbeMs) });
    try {
      await response.body?.cancel();
    } catch {
      // any status will do; the body is not needed
    }
    return true;
  } catch {
    return false;
  }
}

function lastLines(text: string, lines: number, maxChars = 2000): string {
  const kept = stripAnsi(text)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "")
    .slice(-lines)
    .join("\n");
  return kept.length <= maxChars ? kept : `…${kept.slice(-maxChars)}`;
}

type TryResult =
  | { kind: "ready"; server: ViteServer }
  | { kind: "failed"; reason: string; output: string }
  | { kind: "aborted" }
  | { kind: "spawn-error"; error: Error };

/** One `npm run dev`: spawned, read, probed, and killed on every path but `ready`. */
function tryOnce(frontendDir: string, timeoutMs: number, signal: AbortSignal | undefined, onSpawn: ((pid: number) => void) | undefined): Promise<TryResult> {
  const proc = spawn("npm", ["run", "dev"], {
    cwd: frontendDir,
    stdio: ["ignore", "pipe", "pipe"],
    // Its own group: `npm` → `sh -c vite` → `node`, all killed together.
    detached: true,
    // No colour, so the banner is plain text (Vite bolds the port otherwise,
    // and colours even a pipe under CI or FORCE_COLOR) — it is stripped anyway.
    // No browser: a model's `server.open` would open one on the operator's desktop.
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", BROWSER: "none" },
  });
  track(proc);

  return new Promise<TryResult>((resolve) => {
    let output = "";
    let url: string | null = null;
    let settled = false;
    const seconds = `${Math.round(timeoutMs / 100) / 10}s`;

    const finish = (result: TryResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (result.kind === "ready") {
        resolve(result);
        return;
      }
      // Ruling R26: a try that did not serve leaves nothing running.
      void killAndWait(proc).then(() => resolve(result));
    };
    const onAbort = (): void => finish({ kind: "aborted" });

    const timer = setTimeout(() => {
      finish({
        kind: "failed",
        reason: url === null ? `printed no Local: URL within ${seconds}` : `printed ${url} but it did not answer HTTP within ${seconds}`,
        output,
      });
    }, timeoutMs);

    const probe = async (target: string, port: number): Promise<void> => {
      while (!settled) {
        if (await answersHttp(target)) {
          finish({ kind: "ready", server: { proc, port, url: target } });
          return;
        }
        if (!settled) await sleep(LIMITS.devServerPollMs);
      }
    };

    // The listener stays after `ready`: a pipe nobody reads fills up and stalls
    // the dev server mid-session, so its output keeps being drained.
    const onData = (chunk: Buffer): void => {
      output = (output + chunk.toString()).slice(-OUTPUT_KEEP_CHARS);
      if (url !== null || settled) return;
      const banner = parseLocalBanner(output);
      if (banner === null) return;
      url = banner.url;
      void probe(banner.url, banner.port);
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);

    proc.on("error", (error) => {
      if (proc.pid === undefined) finish({ kind: "spawn-error", error });
    });
    proc.on("close", (code, sig) => {
      finish({ kind: "failed", reason: `exited (${code === null ? sig : `code ${code}`}) before it served`, output });
    });

    if (signal?.aborted) {
      finish({ kind: "aborted" });
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    if (proc.pid !== undefined && onSpawn !== undefined) {
      try {
        onSpawn(proc.pid);
      } catch (error) {
        finish({ kind: "spawn-error", error: error instanceof Error ? error : new Error(String(error)) });
      }
    }
  });
}

/**
 * `npm run dev` in `frontendDir`, until it serves: the port is read from the
 * `Local:` banner (ANSI stripped), and the URL must then answer HTTP — any
 * status — within the same budget. A try that exits first, prints no URL, or
 * whose URL does not answer, is killed with its whole group and retried, up to
 * `retries` more times; after the last, `DevServerError` (a frontend stop).
 *
 * A port other than 5173 is returned, not refused: the caller records it as a
 * warning for `Tech stack & run contract` — once it has found 5173 free, since
 * something else on 5173 makes the shift a collision, not the model's doing
 * (the same question follows a `DevServerError`). `npm` that cannot be started
 * at all, or an `onSpawn` that throws, rejects with a plain `Error` — the
 * harness's fault, not the model's. Nothing this spawns outlives a rejection.
 */
export async function startVite(frontendDir: string, options: StartViteOptions = {}): Promise<ViteServer> {
  const timeoutMs = options.timeoutMs ?? LIMITS.devServerStartMs;
  const retries = options.retries ?? LIMITS.devServerRetries;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError(`timeoutMs must be positive, got ${timeoutMs}`);
  if (!Number.isInteger(retries) || retries < 0) throw new RangeError(`retries must be a non-negative integer, got ${retries}`);

  const reasons: string[] = [];
  let lastOutput = "";
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    if (options.signal?.aborted) throw new Error("startVite was aborted");
    const result = await tryOnce(frontendDir, timeoutMs, options.signal, options.onSpawn);
    if (result.kind === "ready") return result.server;
    if (result.kind === "aborted") throw new Error("startVite was aborted");
    if (result.kind === "spawn-error") throw new Error(`npm run dev could not be started in ${frontendDir}: ${result.error.message}`);
    reasons.push(`try ${attempt}: ${result.reason}`);
    lastOutput = result.output;
  }
  const tries = retries + 1;
  throw new DevServerError(
    `npm run dev did not serve${tries === 1 ? "" : ` after ${tries} tries`} (${reasons.join("; ")})`,
    lastLines(lastOutput, 10),
  );
}
