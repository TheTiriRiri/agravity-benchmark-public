/**
 * run-matrix — run the benchmark matrix, one attempt at a time.
 *
 *   npm run run-matrix -- [--only <id>]... [--attempts <n>] [--dry-run]
 *
 * For each (model, effort, attempt) it seeds a throwaway HOME from the
 * `agy-creds` volume, checks the account's remaining quota, runs one harness
 * container against `eval-attempts/<id>-attempt-<n>/`, and writes the harness
 * metadata to `eval-results/<id>-attempt-<n>/run.json`.
 *
 * These properties are deliberate and load-bearing:
 *
 * - **Sequential.** One shared OAuth session and a weekly quota; two concurrent
 *   attempts would race on both. A lock file in `$TMPDIR`, named after the
 *   credentials volume, extends that to whole processes and to every checkout on
 *   the machine: a second `run-matrix` refuses to start rather than sharing the
 *   session and deleting the first one's live workspace.
 * - **Resumable.** An attempt with a `run.json` is skipped, so Ctrl-C and rerun
 *   is safe. The key is `run.json`, never `package.json` in the attempt
 *   directory — models often nest the project one level down. The one exception
 *   is a `run.json` recording an `infra` failure: that is not a data point, so
 *   the attempt is run again rather than stranded at the failure that stopped
 *   the matrix.
 * - **An `infra` failure stops the matrix.** A quota or auth failure is not a
 *   data point; continuing would turn the remaining runs into zeros that look
 *   like model failures.
 * - **A stop signal stops the matrix, and costs no data.** An interrupted
 *   attempt is not a model failure and not a data point: no `run.json` is
 *   written, so the resume rule re-runs it. A signal that reaches the docker
 *   child too (a terminal Ctrl-C, `kill %1`) is read out of the `spawnSync`
 *   result; one that reaches the runner alone runs its handler at the next
 *   event-loop turn — before each attempt, and again before its container
 *   starts. See `MatrixInterrupted`.
 *
 * No secret is ever passed in argv, and the host's `~/.gemini` is never mounted:
 * credentials reach the container only as files in the mounted HOME, copied out
 * of the `agy-creds` volume and deleted after the attempt. Every container the
 * runner starts — the credential copy included — is the one pinned harness image
 * from `runner.yaml`, so nothing is pulled from a registry mid-matrix.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { attemptDirName, MAX_ATTEMPTS_PER_CONFIG } from "./lib/attempts";
import { BASE_EXCLUDES, copyBaseToWorkspace, hasBaseDiff } from "./lib/base-diff";
import { checkQuotaFloor, classifyFailure, detectEnvelopeInterrupt, type Classification } from "./lib/classify";
import { ensureContainerRemoved, pidIsAlive, userSpec, type ContainerRemoval, type DockerRun } from "./lib/docker";
import {
  INTERRUPT_EXIT_CODES,
  detectInterrupt,
  installInterruptHandlers,
  type InterruptHandlers,
  type InterruptSignal,
} from "./lib/interrupt";
import { loadRunnerConfig, selectMatrixRows, type MatrixRow, type RunnerConfig } from "./lib/runner-config";
import { parseEnvelope, readRunJson, stderrTail, writeRunJson, type RunJson } from "./lib/run-json";
import { isWorkspaceEmpty } from "./lib/workspace";

/** Where `benchmark/`, `prompt.md`, `eval-attempts/` and `eval-results/` live. */
const DEFAULT_ROOT = fileURLToPath(new URL("..", import.meta.url));

function configPath(root: string, custom?: string): string {
  if (custom !== undefined) {
    return resolve(DEFAULT_ROOT, custom.startsWith("benchmark/") ? custom : join("benchmark", custom));
  }
  return join(root, "benchmark", "runner.yaml");
}

function promptPath(root: string, rubric?: string): string {
  if (rubric?.startsWith("maintenance-console-hard")) {
    const hardPrompt = join(root, "tracks", "console-hard", "prompt.md");
    if (existsSync(hardPrompt)) return hardPrompt;
  }
  return join(root, "prompt.md");
}

/** The named Docker volume the agy sign-in writes to. */
const CREDENTIALS_VOLUME = "agy-creds";
/** agy's OAuth token, relative to `$HOME` and to the volume root. */
const TOKEN_FILE = join(".gemini", "antigravity-cli", "antigravity-oauth-token");
/** Prefix of every throwaway HOME, so a survivor of a `SIGKILL` is recognisable. */
const CREDENTIALS_DIR_PREFIX = "agrav-creds-";
/** How long to wait before the single retry a rate limit gets. */
const RATE_LIMIT_RETRY_DELAY_MS = 60_000;
/** `/usage` is a print-mode query; anything longer than this is a hang. */
const QUOTA_GATE_TIMEOUT_MS = 120_000;
/** docker run captures a whole envelope plus logs; the 1 MB default is too small. */
const CAPTURE_BUFFER_BYTES = 64 * 1024 * 1024;
/** Placeholder printed in place of the real credential directory under --dry-run. */
const ELIDED_CREDS = "<creds>";

const USAGE = `Usage: npm run run-matrix -- [options]

Options:
  --only <id>       Run only this matrix id. Repeatable. Default: the whole matrix.
  --skip <id>       Leave this matrix id out. Repeatable; must be a matrix id.
  --exclude <id>    Alias for --skip.
  --attempts <n>    Attempts per id, overriding runner.yaml's \`attempts\`.
                    At most ${MAX_ATTEMPTS_PER_CONFIG}: past that the screenshot script cannot
                    compose the configuration's filmstrip.
  --config <path>   Runner configuration YAML file.
                    Default: <root>/benchmark/runner.yaml.
  --root <path>     Repo root holding benchmark/, prompt.md, eval-attempts/ and
                    eval-results/. Default: the repo this script lives in.
  --base <path>     Base directory to seed each attempt's workspace with (brownfield mode).
  --dry-run         Print the docker commands that would run; write nothing.
  --help            Print this message.
`;

export interface CliArgs {
  only: string[];
  skip: string[];
  attempts?: number;
  root?: string;
  config?: string;
  base?: string;
  dryRun: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { only: [], skip: [], dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const eq = token.indexOf("=");
    const name = token.startsWith("--") && eq !== -1 ? token.slice(0, eq) : token;
    const inlineValue = token.startsWith("--") && eq !== -1 ? token.slice(eq + 1) : undefined;
    const takeValue = (): string => {
      const value = inlineValue ?? argv[++i];
      if (value === undefined) throw new Error(`${name} needs a value`);
      // `--skip --dry-run` would otherwise skip an id named "--dry-run" and start a live run.
      if (value.startsWith("--")) throw new Error(`${name} needs a value, not the flag ${JSON.stringify(value)}`);
      return value;
    };
    switch (name) {
      case "--only":
        args.only.push(takeValue());
        break;
      case "--skip":
      case "--exclude":
        args.skip.push(takeValue());
        break;
      case "--attempts": {
        const raw = takeValue();
        const value = Number(raw);
        if (!Number.isSafeInteger(value) || value < 1) {
          throw new Error(`--attempts ${JSON.stringify(raw)} must be a positive integer`);
        }
        if (value > MAX_ATTEMPTS_PER_CONFIG) {
          throw new Error(
            `--attempts ${value} is above the ${MAX_ATTEMPTS_PER_CONFIG}-attempt ceiling. ` +
              "`npm run screenshots` composes each configuration's filmstrip as one Chromium page " +
              `${MAX_ATTEMPTS_PER_CONFIG + 1} x 1280 = ${(MAX_ATTEMPTS_PER_CONFIG + 1) * 1280}px wide at that ` +
              "count, past what it will render — so the runs would happen and then not be picturable.",
          );
        }
        args.attempts = value;
        break;
      }
      case "--root":
        args.root = resolve(takeValue());
        break;
      case "--base": {
        const raw = takeValue();
        const resolved = resolve(raw);
        if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
          throw new Error(`--base ${JSON.stringify(raw)} is not a directory`);
        }
        args.base = resolved;
        break;
      }
      case "--config":
        args.config = takeValue();
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        throw new Error(`unknown argument ${JSON.stringify(token)}\n\n${USAGE}`);
    }
  }
  return args;
}

// --- interruption -----------------------------------------------------------

/**
 * Thrown when an attempt was interrupted. Nothing is recorded for it: the
 * attempt keeps no `run.json`, so `resumeDecision` runs it again next time.
 *
 * A signal that reached the docker child too — a terminal Ctrl-C, `kill %1` —
 * is read out of each `spawnSync` result (`detectInterrupt`), not from a flag
 * the signal handler sets: every step of `runOneAttempt` on the happy path is
 * synchronous, so `await runOneAttempt(...)` resolves into a microtask, and the
 * microtask queue drains before the event loop reaches the queued signal
 * callback — the loop would start the next container.
 *
 * A signal that reached the runner alone (`kill <pid>`, a supervisor's SIGTERM,
 * a Ctrl-C landing in a JS gap) is not in any `spawnSync` result, so the
 * handler is the only thing that can act on it. `main` and `runOneAttempt`
 * therefore yield to the event loop once per attempt and once more before the
 * container starts, which is where it runs. The window that remains is a signal
 * to the runner alone while a container is running: it acts when that attempt
 * ends.
 */
export class MatrixInterrupted extends Error {
  readonly signal: InterruptSignal;
  readonly exitCode: number;

  constructor(signal: InterruptSignal, where: string, detail = "") {
    super(
      `${signal} — ${where} was interrupted. No run.json was written, so it is not a data point ` +
        `and rerunning resumes from it.${detail === "" ? "" : `\n${detail}`}`,
    );
    this.name = "MatrixInterrupted";
    this.signal = signal;
    this.exitCode = INTERRUPT_EXIT_CODES[signal];
  }
}

/** Set once an interruption has been reported, so the handler does not repeat it. */
let interruptReported = false;

/** The handle `main` installs, so a yield can see a signal that reached the runner alone. */
let interruptHandlers: InterruptHandlers | null = null;

/**
 * Give libuv a turn, then stop the matrix if a signal arrived.
 *
 * `await` on the happy path only drains microtasks — every promise here is
 * already settled — so a queued signal callback never runs; `setImmediate`
 * reaches the check phase, where it does. Today every cleanup is synchronous,
 * so the handler's own `process.exit` wins the race that follows and `main`
 * never resumes. The moment one cleanup awaits anything — a `docker rm` of a
 * stray container is the obvious candidate — the drain ends at that await, the
 * `setImmediate` resolves, and without this check `main` would run on past the
 * yield: reset the workspace and start a container with credentials that are
 * already being removed. The invariant is meant to be "a signal seen at a yield
 * stops the matrix", not "`process.exit` wins".
 */
async function yieldToSignals(where: string): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  const signal = interruptHandlers?.interrupted() ?? null;
  if (signal !== null) throw new MatrixInterrupted(signal, where);
}

// --- credential seeding -----------------------------------------------------
//
// Every throwaway HOME the runner creates is registered here so that a crash or
// a Ctrl-C still deletes it. The directory holds the account's OAuth token.

const pendingCredentialDirs = new Set<string>();

function cleanupCredentialDirs(): void {
  // Never throw. `main` runs this on a signal and from the `exit` listener,
  // before `releaseMatrixLock`, so each directory is tried on its own and one
  // that will not go is named here, by path, without stopping the rest. `force`
  // swallows only ENOENT; the container writes a whole HOME into this directory
  // (.npm/, .cache/, .config/), so ENOTEMPTY from a still-dying container is the
  // realistic failure, hence the retries.
  for (const dir of pendingCredentialDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      pendingCredentialDirs.delete(dir);
    } catch (error) {
      console.error(
        `warning: could not remove the throwaway HOME ${dir} (${(error as Error).message}). ` +
          "It holds the account's OAuth token — delete it by hand.",
      );
    }
  }
}

/**
 * Credential directories a *previous* run left behind.
 *
 * Only `SIGKILL` and a hard power loss can get past the handlers `main`
 * installs, and neither can be caught — so the best that can be done is to name
 * the survivors, because a real run never prints the path and the operator
 * would otherwise have no way to find them.
 *
 * **`SIGKILL` is not hypothetical, and it is not the operator.** A real Ctrl-C
 * on 2026-09-05 leaked a live OAuth token here. The cause was the `tsx` CLI:
 * `npm run run-matrix` used to invoke `tsx scripts/run-matrix.ts`, and that bin
 * is a wrapper that forks a second node process. Ctrl-C reaches the whole
 * foreground group; the runner is blocked inside `spawnSync("docker", …)` for the
 * length of the attempt and cannot run a line of JS, so it never acknowledges
 * the signal over tsx's IPC pipe. The wrapper waits 30 ms, re-sends SIGINT,
 * waits 30 ms more, and sends `SIGKILL` — measured at 61 ms from Ctrl-C to an
 * uncatchable death — then exits 130, the exact code a clean Ctrl-C produces, so
 * the terminal shows nothing wrong.
 *
 * `package.json` therefore invokes `node --import tsx scripts/run-matrix.ts`,
 * which is a single process and the invocation every test already uses; measured
 * on the same probe, its handlers run and the directory is removed. Do not change
 * it back to the bare `tsx` bin — `test/package-scripts.test.ts` fails if you do.
 */
function warnAboutLeftoverCredentialDirs(): void {
  let entries: string[];
  try {
    entries = readdirSync(tmpdir());
  } catch {
    return;
  }
  const leftovers = entries.filter((entry) => entry.startsWith(CREDENTIALS_DIR_PREFIX)).sort();
  if (leftovers.length === 0) return;
  console.warn(
    `warning: ${leftovers.length} credential director(ies) from an earlier run are still in ${tmpdir()}:\n` +
      leftovers.map((entry) => `  ${join(tmpdir(), entry)}`).join("\n") +
      "\nOnly a SIGKILL or a crash can leave these. Each may hold the account's OAuth token — delete them.",
  );
}

// --- single-instance lock ----------------------------------------------------
//
// Two `run-matrix` processes on one machine are never what anybody meant. They
// would share one OAuth session (the reason the matrix is sequential in the
// first place), drain the same weekly quota twice as fast, and — when both
// resolve the same `eval-attempts/<id>-attempt-<n>/` — the second one's
// `resetWorkspace` would delete the first one's live workspace out from under a
// running container. `resumeDecision` cannot catch it: `run.json` is written at
// the *end* of an attempt, so an attempt in flight looks exactly like one that
// was never started.

/** Held only for a real run: `--help` and `--dry-run` write nothing and take no lock. */
let heldLockPath: string | null = null;

/**
 * One lock per machine, not per checkout: what it protects is the `agy-creds`
 * volume's single OAuth session and the weekly quota behind it, and those are
 * machine-wide. Two checkouts each holding their own repo-root lock would run
 * two matrices on one token. Hence `$TMPDIR` and a name keyed on the volume.
 */
export function matrixLockPath(): string {
  return join(tmpdir(), `agrav-bench-run-matrix-${CREDENTIALS_VOLUME}.lock`);
}

interface MatrixLockHolder {
  pid: number;
  startedAt: string;
  argv: string[];
  /** The other matrix's repo root, so an operator can find it in another checkout. */
  root: string;
}

function readLockHolder(path: string): MatrixLockHolder | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as MatrixLockHolder;
  } catch {
    return null;
  }
}

function lockHeldError(path: string, previous: MatrixLockHolder | null): Error {
  const who =
    previous === null
      ? "holder unreadable"
      : `pid ${previous.pid}, started ${previous.startedAt}, root ${previous.root ?? "unrecorded"}, ` +
        `args ${previous.argv.join(" ") || "none"}`;
  return new Error(
    `another run-matrix is already running (${who}).\n` +
      "Two matrices share one OAuth session and one weekly quota, and the second one would delete the\n" +
      `first one's live workspace. Wait for it, or stop it and delete ${path}.`,
  );
}

/**
 * Take the lock, or explain who holds it.
 *
 * `wx` is the whole mutual exclusion: `open(O_CREAT|O_EXCL)` is atomic, so two
 * processes racing here cannot both succeed. A stale file — the holder died to a
 * `SIGKILL`, which no handler can intercept — is taken over rather than becoming
 * a permanent block, since the alternative is an operator deleting lock files by
 * hand and learning to do it reflexively.
 *
 * The takeover unlinks before it creates, and creates with `wx` again. The lock
 * now lives in a shared, world-writable `$TMPDIR`: a symlink planted at this
 * name makes `wx` fail with EEXIST and makes the holder unreadable, so a plain
 * write would "take over the stale lock" by truncating whatever the link points
 * at. `unlinkSync` removes the link itself, never its target. If the second
 * create loses to another process, that process is the holder and is reported
 * as one — the lock is never overwritten.
 */
function acquireMatrixLock(root: string): void {
  const path = matrixLockPath();
  const holder: MatrixLockHolder = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    argv: process.argv.slice(2),
    root,
  };
  const payload = `${JSON.stringify(holder, null, 2)}\n`;
  const create = (): boolean => {
    try {
      writeFileSync(path, payload, { flag: "wx" });
      heldLockPath = path;
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return false;
    }
  };

  if (create()) return;

  const previous = readLockHolder(path);
  if (previous !== null && Number.isInteger(previous.pid) && pidIsAlive(previous.pid)) {
    throw lockHeldError(path, previous);
  }

  const why =
    previous === null
      ? "it is unreadable"
      : `pid ${previous.pid} (started ${previous.startedAt}) is gone`;
  console.warn(`warning: taking over a stale lock at ${path} — ${why}. Only a SIGKILL or a crash leaves one.`);
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!create()) throw lockHeldError(path, readLockHolder(path));
}

/**
 * Release the lock, but only if the file still names this process.
 *
 * A takeover can hand the path to another matrix while this one is alive: a
 * long `SIGSTOP` or a recycled pid makes the liveness check call us dead, and a
 * `$TMPDIR` reaper can remove the file outright. Unlinking whatever is there
 * would then delete the new holder's lock, leaving it unprotected and letting a
 * third matrix start — two live matrices on one OAuth session and no lock at
 * all, which is worse than the state the lock exists to prevent.
 */
function releaseMatrixLock(): void {
  if (heldLockPath === null) return;
  const path = heldLockPath;
  heldLockPath = null;
  try {
    const holder = readLockHolder(path);
    if (holder !== null && holder.pid !== process.pid) {
      console.error(
        `warning: the matrix lock ${path} now records pid ${holder.pid}, not this run's ${process.pid}; ` +
          "leaving it alone. Another matrix took it over while this one was still running.",
      );
      return;
    }
    rmSync(path, { force: true });
  } catch (error) {
    console.error(`warning: could not release the matrix lock ${path} (${(error as Error).message}).`);
  }
}

/**
 * The copy runs in the pinned harness image with `cp` as the entrypoint, not in
 * a `docker.io/alpine` pulled at run time (Ruling R4). The one step in the
 * pipeline that handles the OAuth token should not depend on an unpinned image
 * fetched from a registry, and a matrix on an offline machine would otherwise
 * fail here rather than at a preflight check.
 *
 * `cp` as the entrypoint rather than `sh -c` keeps the filenames in an argv
 * array: nothing from `runner.yaml` is ever parsed by a shell.
 *
 * `-w /src` plus `--parents` is what makes the copy usable rather than merely
 * successful. agy keeps its credentials in `$HOME/.gemini/antigravity-cli/`, not
 * at the top of `$HOME` — verified on the volume, where `installation_id` sits
 * three levels down — so a flat copy into `/dst/` would put the files somewhere
 * agy never looks. `--parents` recreates each source's directories under `/dst`,
 * and the relative sources (`-w /src`) are what keeps `/src` itself out of the
 * reproduced path. `runner-config.ts` refuses any entry that could escape.
 *
 * Every `docker run` in this file passes `--pull never`: the image is a local dated
 * tag, the start-of-run check cannot stop a later pull if it disappears mid-run, and
 * a pull would fetch the name from a registry namespace anyone can register.
 */
export function credentialCopyArgs(image: string, credsDir: string, files: string[]): string[] {
  return [
    "run",
    "--rm",
    "--pull",
    "never",
    "--user",
    userSpec(),
    "-w",
    "/src",
    "-v",
    `${CREDENTIALS_VOLUME}:/src:ro`,
    "-v",
    `${credsDir}:/dst`,
    "--entrypoint",
    "cp",
    image,
    "--parents",
    ...files,
    "/dst/",
  ];
}

/**
 * Copy only the token file and `installation_id` into a fresh directory. The
 * rest of the volume — conversation history, knowledge, logs — is noise that has
 * no business in a benchmark container.
 */
function seedCredentials(image: string, files: string[], where: string): string {
  const credsDir = mkdtempSync(join(tmpdir(), CREDENTIALS_DIR_PREFIX));
  pendingCredentialDirs.add(credsDir);
  const result = spawnSync("docker", credentialCopyArgs(image, credsDir, files), {
    encoding: "utf8",
    maxBuffer: CAPTURE_BUFFER_BYTES,
  });
  const interrupt = detectInterrupt(result);
  if (interrupt !== null) {
    discardCredentials(credsDir);
    throw new MatrixInterrupted(interrupt, `${where} (seeding credentials)`);
  }
  if (result.error !== undefined || result.status !== 0) {
    discardCredentials(credsDir);
    const detail = result.error !== undefined ? result.error.message : (result.stderr ?? "").trim();
    throw new Error(
      `could not seed credentials from the ${CREDENTIALS_VOLUME} volume: ${detail}\n` +
        "The agy sign-in (docs/INSTRUKCJA-UZYTKOWNIKA.md §7) creates that volume; check `docker volume ls` and runner.yaml's credentialFiles.",
    );
  }
  return credsDir;
}

/** sha256 of the throwaway HOME's token file, or null when it cannot be read. */
function tokenHash(credsDir: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(join(credsDir, TOKEN_FILE))).digest("hex");
  } catch {
    return null;
  }
}

/** Whether agy replaced the token it was seeded with (gate 0: its first call in the throwaway HOME does). */
export function tokenChanged(credsDir: string, seeded: string | null): boolean {
  const now = tokenHash(credsDir);
  return now !== null && seeded !== null && now !== seeded;
}

/** Copy the token, and only the token, back onto the volume, from a read-only mount of the throwaway HOME. */
export function tokenPersistArgs(image: string, credsDir: string): string[] {
  return [
    "run", "--rm", "--pull", "never", "--user", userSpec(),
    "-w", "/src",
    "-v", `${credsDir}:/src:ro`,
    "-v", `${CREDENTIALS_VOLUME}:/dst`,
    "--entrypoint", "cp",
    image,
    TOKEN_FILE,
    `/dst/${TOKEN_FILE}`,
  ];
}

/**
 * Gate 0 measured that agy refreshes its OAuth token on its first call in a throwaway
 * HOME, which in a run is the /usage gate (docs/DECISIONS.md, R46). The next attempt is
 * seeded from the volume, so a refreshed token left in the throwaway HOME would leave
 * the volume with the older one. Copy it back only after a recorded result that is not
 * an infra failure, and only when its hash changed, and say so. A failed copy is a
 * warning, since the volume still holds a token the next attempt can try.
 */
function persistRefreshedToken(image: string, credsDir: string, seeded: string | null, dirName: string): void {
  if (!tokenChanged(credsDir, seeded)) return;
  const result = spawnSync("docker", tokenPersistArgs(image, credsDir), { encoding: "utf8", timeout: 60_000 });
  if (result.error === undefined && result.status === 0) {
    console.log(`[${dirName}] agy refreshed the OAuth token; copied it back to the ${CREDENTIALS_VOLUME} volume.`);
  } else {
    const detail = result.error !== undefined ? result.error.message : (result.stderr ?? "").trim();
    console.error(
      `warning: [${dirName}] agy refreshed the OAuth token, but copying it back to ${CREDENTIALS_VOLUME} failed ` +
        `(exit ${result.status}: ${detail}). The next attempt starts from the old one.`,
    );
  }
}

function discardCredentials(credsDir: string): void {
  // Called from `runOneAttempt`'s `finally`. A throw here would replace whatever
  // brought us into the `finally` — a MatrixInterrupted, say — with an rmSync
  // error, turning a clean interrupt into an unexplained crash.
  try {
    rmSync(credsDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    pendingCredentialDirs.delete(credsDir);
  } catch (error) {
    console.error(
      `warning: could not remove the throwaway HOME ${credsDir} (${(error as Error).message}). ` +
        "It holds the account's OAuth token — delete it by hand.",
    );
  }
}

// --- docker -----------------------------------------------------------------

/**
 * `-w /home/agy` is not optional. The image's `WORKDIR /workspace` is created
 * root-owned 0755 at build time and only the *attempt* container bind-mounts
 * over it; this one does not, so as the host uid its cwd would be unwritable —
 * and agy drops a `.antigravitycli/<uuid>.json` stub into every workspace it
 * touches. The mounted HOME is the one directory this container can write.
 */
export function usageGateArgs(config: RunnerConfig, credsDir: string): string[] {
  return [
    "run",
    "--rm",
    "--pull",
    "never",
    "--user",
    userSpec(),
    "-e",
    "HOME=/home/agy",
    "-w",
    "/home/agy",
    "-v",
    `${credsDir}:/home/agy`,
    config.image,
    "--usage",
  ];
}

export interface AttemptCommand {
  config: RunnerConfig;
  row: MatrixRow;
  /** Host directory bind-mounted as `/workspace`; the model's only output. */
  attemptDir: string;
  /** Host directory bind-mounted as `HOME`; holds the seeded credentials. */
  credsDir: string;
  containerName: string;
  /** Host path of the task prompt, mounted read-only *outside* `/workspace`. */
  promptPath: string;
  noNewProject?: boolean;
}

export function attemptArgs(cmd: AttemptCommand): string[] {
  return [
    "run",
    "--rm",
    "--pull",
    "never",
    "--name",
    cmd.containerName,
    "--user",
    userSpec(),
    "-e",
    "HOME=/home/agy",
    "-e",
    `TIMEOUT=${cmd.config.printTimeout}`,
    "-v",
    `${cmd.attemptDir}:/workspace`,
    "-v",
    `${cmd.credsDir}:/home/agy`,
    "-v",
    `${cmd.promptPath}:/prompt.md:ro`,
    cmd.config.image,
    "--model",
    cmd.row.model,
    // agy 1.1.26 rejects --effort outright for a model that has no effort
    // levels, and rejects an --effort that disagrees with an effort-suffixed
    // model id. A `null` row means "omit the flag", not "use the default".
    ...(cmd.row.effort === null ? [] : ["--effort", cmd.row.effort]),
    "--prompt-file",
    "/prompt.md",
    ...(cmd.noNewProject ? ["--no-new-project"] : []),
  ];
}

/** `<tag>@<image Id>`. A locally built image has no registry digest to pin. */
function resolveImageRef(tag: string, dryRun: boolean): string {
  const result = spawnSync("docker", ["image", "inspect", "-f", "{{.Id}}", tag], { encoding: "utf8" });
  const id = result.status === 0 ? (result.stdout ?? "").trim() : "";
  if (id !== "") return `${tag}@${id}`;
  if (dryRun) {
    console.warn(`warning: could not resolve the image Id for ${tag}; a real run would stop here.`);
    return `${tag}@<unresolved>`;
  }
  throw new Error(
    `image ${tag} is not available locally: ${(result.stderr ?? result.error?.message ?? "").trim()}\n` +
      "Build it with `docker build -t " +
      tag +
      " images/harness` (see images/harness/IMAGE.md).",
  );
}

function requireCredentialsVolume(image: string): void {
  const result = spawnSync("docker", ["volume", "inspect", CREDENTIALS_VOLUME], { encoding: "utf8" });
  if (result.status === 0) return;
  throw new Error(
    `the ${CREDENTIALS_VOLUME} docker volume does not exist. ` +
      "The agy sign-in (docs/INSTRUKCJA-UZYTKOWNIKA.md §7) creates it, inside the harness container:\n" +
      `  docker run -it --pull never --user ${userSpec()} -e HOME=/home/agy -w /home/agy` +
      ` -v ${CREDENTIALS_VOLUME}:/home/agy ${image} --login`,
  );
}

function formatCommand(args: string[]): string {
  return ["docker", ...args].map(shellQuote).join(" ");
}

function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

// --- the matrix -------------------------------------------------------------

function attemptRunJsonPath(root: string, dirName: string): string {
  return join(root, "eval-results", dirName, "run.json");
}

interface ResumeDecision {
  skip: boolean;
  /** What to log about the decision, or `null` when there is nothing to say. */
  message: string | null;
}

/**
 * Whether a previously written `run.json` means this attempt is done.
 *
 * A clean or `model` outcome is a data point and is kept. An `infra` outcome is
 * not — it is the failure that stopped the matrix — so the attempt runs again
 * once the cause is fixed, and the stale file is overwritten.
 */
function resumeDecision(runJsonPath: string): ResumeDecision {
  if (!existsSync(runJsonPath)) return { skip: false, message: null };
  let failureKind: RunJson["failureKind"];
  try {
    failureKind = readRunJson(runJsonPath).failureKind;
  } catch (error) {
    return {
      skip: false,
      message: `re-running: ${runJsonPath} is unreadable and will be overwritten (${(error as Error).message})`,
    };
  }
  if (failureKind === "infra") {
    return { skip: false, message: `re-running: ${runJsonPath} records an infra failure, which is not a data point` };
  }
  return { skip: true, message: `skipped: ${runJsonPath} already exists` };
}

export interface AttemptContext {
  config: RunnerConfig;
  imageRef: string;
  /** Repo root the attempt and result directories hang off. */
  root: string;
  dryRun: boolean;
  baseDir?: string;
}

export { BASE_EXCLUDES, copyBaseToWorkspace, hasBaseDiff };

/**
 * Make sure the attempt's container is really gone, and prove it
 * (`ensureContainerRemoved` in `docker.ts`).
 *
 * `spawnSync`'s `timeout` kills the docker **client**; `docker run` without
 * `-t` leaves the container running when its client dies, so the `rm -f` is
 * load-bearing. The container runs with `--rm`, so a successful `rm -f`, or a
 * daemon that says it exists but is not running, is proof enough. Anything
 * the daemon cannot answer counts as not removed: an orphan would be a second
 * `agy` session on the same OAuth token and weekly quota.
 */
export function ensureAttemptContainerRemoved(name: string, run?: DockerRun): ContainerRemoval {
  return ensureContainerRemoved(name, {
    consequence:
      "A container still holding this attempt's credentials would be a second agy session on the same " +
      "OAuth token, so the matrix stops here. Check `docker ps` and remove it by hand.",
    notRunningCountsAsRemoved: true,
    ...(run === undefined ? {} : { run }),
  });
}

export interface AttemptContainerRun {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  dockerError: boolean;
  outerTimeout: boolean;
  /** Non-null when the operator stopped the run rather than the attempt failing. */
  interrupted: InterruptSignal | null;
  /** True when the container could not be confirmed gone after a kill. */
  containerOrphaned: boolean;
  /** What the removal attempt found, or `null` when no kill was needed. */
  removalDetail: string | null;
  startedAt: string;
  durationMs: number;
}

function runAttemptContainer(cmd: AttemptCommand): AttemptContainerRun {
  const args = attemptArgs(cmd);
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    maxBuffer: CAPTURE_BUFFER_BYTES,
    timeout: cmd.config.timeoutMs,
    killSignal: "SIGKILL",
  });
  const durationMs = Date.now() - start;
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  const outerTimeout = errorCode === "ETIMEDOUT";
  const interrupted = detectInterrupt(result);
  let removal: ContainerRemoval | null = null;
  if (outerTimeout || result.signal !== null || interrupted !== null) {
    // spawnSync only kills the docker client; make sure the container goes too,
    // and do not take its word for it.
    removal = ensureAttemptContainerRemoved(cmd.containerName);
    if (!removal.removed) console.error(`[${cmd.containerName}] ${removal.detail}`);
  }
  const dockerError = !outerTimeout && result.error !== undefined;
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error !== undefined ? result.error.message : ""),
    exitCode: result.status,
    dockerError,
    outerTimeout,
    interrupted,
    containerOrphaned: removal !== null && !removal.removed,
    removalDetail: removal?.detail ?? null,
    startedAt,
    durationMs,
  };
}

export function evaluateRun(
  ctx: AttemptContext,
  row: MatrixRow,
  run: AttemptContainerRun,
  attemptDir: string,
): { runJson: RunJson; classification: Classification } {
  const envelope = parseEnvelope(run.stdout);
  const noDiffFromBase = ctx.baseDir !== undefined ? !hasBaseDiff(attemptDir, ctx.baseDir) : undefined;
  const classification = classifyFailure({
    exitCode: run.exitCode,
    stdout: run.stdout,
    stderr: run.stderr,
    envelope,
    workspaceEmpty: isWorkspaceEmpty(attemptDir),
    noDiffFromBase,
    dockerError: run.dockerError,
    outerTimeout: run.outerTimeout,
    containerOrphaned: run.containerOrphaned,
  });
  const runJson: RunJson = {
    id: row.id,
    model: row.model,
    effort: row.effort,
    agyVersion: ctx.config.agyVersion,
    image: ctx.imageRef,
    startedAt: run.startedAt,
    durationMs: run.durationMs,
    exitCode: run.exitCode,
    envelope,
    stderrTail: stderrTail(run.stderr),
    softDenied: classification.softDenied,
    failureKind: classification.failureKind,
    ...(noDiffFromBase !== undefined ? { noDiffFromBase } : {}),
  };
  return { runJson, classification };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Start every run in an empty workspace.
 *
 * The runner re-runs an attempt in two cases — an `infra` `run.json`, and no
 * `run.json` at all after a kill or an interruption — and in both the directory
 * can already hold what the discarded run wrote. `mkdirSync` alone is a no-op
 * on an existing directory, so the container would bind-mount the dirty tree as
 * `/workspace`: the model is then no longer doing a one-shot build, it starts
 * from a partial site it did not write in this attempt, and nothing downstream
 * flags it. Worse, a second run that produces nothing at all still looks
 * non-empty to `isWorkspaceEmpty`, so it classifies as a clean success — a data
 * point assembled entirely from a run that was thrown away.
 */
function resetWorkspace(attemptDir: string): void {
  rmSync(attemptDir, { recursive: true, force: true });
  mkdirSync(attemptDir, { recursive: true });
}

/**
 * Get the workspace out of the way without destroying it, for the one retry a
 * rate limit gets.
 *
 * The retry has to start clean, but `rateLimited` is only as sharp as the text
 * detectors: a good run whose envelope did not parse and whose stderr mentions a
 * `429` it recovered from lands in the same branch, and deleting that workspace
 * would throw away a completed site and spend a second run of the quota
 * reproducing it. So a workspace with real output is moved aside and its path
 * printed; only an empty one is removed. The `.rate-limited-<n>` suffix cannot
 * parse as an attempt directory (`ATTEMPT_DIR_RE` anchors on the attempt
 * number), so neither `process-results.ts` nor `take-screenshots.ts` will read
 * it, and `.gitignore` keeps it out of the checkout.
 */
function setAsideWorkspace(attemptDir: string, dirName: string): void {
  if (isWorkspaceEmpty(attemptDir)) {
    resetWorkspace(attemptDir);
    return;
  }
  const aside = `${attemptDir}.rate-limited-${Date.now()}`;
  renameSync(attemptDir, aside);
  console.warn(
    `[${dirName}] the rate-limited run had written files; kept them at ${aside} rather than deleting them. ` +
      "If the retry looks worse than what is there, that directory is the run that was set aside.",
  );
  mkdirSync(attemptDir, { recursive: true });
}

/**
 * Run one attempt end to end. Returns the classification reason alongside the
 * `run.json` it wrote, or `null` under `--dry-run`.
 */
async function runOneAttempt(
  ctx: AttemptContext,
  row: MatrixRow,
  attempt: number,
): Promise<{ runJson: RunJson; reason: string } | null> {
  const dirName = attemptDirName(row.id, attempt);
  const attemptDir = join(ctx.root, "eval-attempts", dirName);
  const runJsonPath = attemptRunJsonPath(ctx.root, dirName);
  const command = (credsDir: string): AttemptCommand => ({
    config: ctx.config,
    row,
    attemptDir,
    credsDir,
    containerName: `agrav-${dirName}`,
    promptPath: promptPath(ctx.root, ctx.config.rubric),
    noNewProject: ctx.baseDir !== undefined,
  });

  if (ctx.dryRun) {
    console.log(`\n[${dirName}] would run:`);
    console.log(`  ${formatCommand(credentialCopyArgs(ctx.config.image, ELIDED_CREDS, ctx.config.credentialFiles))}`);
    console.log(`  ${formatCommand(usageGateArgs(ctx.config, ELIDED_CREDS))}`);
    if (ctx.baseDir) {
      console.log(`  copy base from ${ctx.baseDir} to ${attemptDir}`);
    }
    console.log(`  ${formatCommand(attemptArgs(command(ELIDED_CREDS)))}`);
    console.log(`  then write ${runJsonPath}`);
    console.log("  then, only if agy refreshed the token and the result is not an infra failure:");
    console.log(`  ${formatCommand(tokenPersistArgs(ctx.config.image, ELIDED_CREDS))}`);
    return null;
  }

  const credsDir = seedCredentials(ctx.config.image, ctx.config.credentialFiles, dirName);
  const seededToken = tokenHash(credsDir);
  try {
    let usage = spawnSync("docker", usageGateArgs(ctx.config, credsDir), {
      encoding: "utf8",
      maxBuffer: CAPTURE_BUFFER_BYTES,
      timeout: QUOTA_GATE_TIMEOUT_MS,
    });
    let usageInterrupt = detectInterrupt(usage);
    if (usageInterrupt !== null) throw new MatrixInterrupted(usageInterrupt, `${dirName} (quota gate)`);
    let usageOutput = `${usage.stdout ?? ""}\n${usage.stderr ?? ""}`;

    // Retry transient failures (e.g. 503 UNAVAILABLE from Google quota endpoint) up to 3 times
    const MAX_USAGE_RETRIES = 3;
    for (let uAttempt = 2; uAttempt <= MAX_USAGE_RETRIES && (usage.error !== undefined || usage.status !== 0); uAttempt++) {
      console.warn(`[${dirName}] /usage exited with ${usage.status} (transient error), retrying in 5s (${uAttempt}/${MAX_USAGE_RETRIES})...`);
      const sleepRes = spawnSync("sleep", ["5"]);
      const sleepInterrupt = detectInterrupt(sleepRes);
      if (sleepInterrupt !== null) throw new MatrixInterrupted(sleepInterrupt, `${dirName} (quota gate retry sleep)`);
      usage = spawnSync("docker", usageGateArgs(ctx.config, credsDir), {
        encoding: "utf8",
        maxBuffer: CAPTURE_BUFFER_BYTES,
        timeout: QUOTA_GATE_TIMEOUT_MS,
      });
      usageInterrupt = detectInterrupt(usage);
      if (usageInterrupt !== null) throw new MatrixInterrupted(usageInterrupt, `${dirName} (quota gate)`);
      usageOutput = `${usage.stdout ?? ""}\n${usage.stderr ?? ""}`;
    }

    console.log(`[${dirName}] /usage:\n${usageOutput.trim()}`);
    if (usage.error !== undefined || usage.status !== 0) {
      throw new Error(
        `the /usage quota gate failed (exit ${usage.status}); not starting the attempt.\n${usageOutput.trim()}`,
      );
    }
    const quota = checkQuotaFloor(usageOutput, ctx.config.quotaFloor, row.usageLabel ?? undefined);
    console.log(`[${dirName}] quota gate: ${quota.reason}`);
    if (!quota.ok) throw new Error(`quota gate stopped the matrix: ${quota.reason}`);

    // A signal queued during the seed or the quota gate stops the matrix here,
    // before a container starts.
    await yieldToSignals(`${dirName} (before the container)`);

    resetWorkspace(attemptDir);
    if (ctx.baseDir !== undefined) {
      copyBaseToWorkspace(ctx.baseDir, attemptDir);
    }
    const firstRun = runAttemptContainer(command(credsDir));
    if (firstRun.interrupted !== null) {
      throw new MatrixInterrupted(firstRun.interrupted, dirName, firstRun.removalDetail ?? "");
    }
    let evaluated = evaluateRun(ctx, row, firstRun, attemptDir);

    // An envelope whose `error` says "interrupted" is a forwarded SIGINT that
    // agy caught internally: it exited cleanly, so `detectInterrupt` saw
    // nothing. Without this check the attempt is classified as `model` and a
    // permanent zero is written. The same applies when the orchestrator's own
    // handler has recorded a signal that reached the runner alone — it has not
    // been dispatched yet because the event loop had no turn, but writing a
    // `run.json` now would fabricate a data point the operator meant to discard.
    const throwIfInterrupted = (where: string): void => {
      if (detectEnvelopeInterrupt(evaluated.runJson.envelope)) {
        throw new MatrixInterrupted("SIGINT", dirName, `agy envelope reported an interrupted run${where ? ` (${where})` : ""}`);
      }
      const pending = interruptHandlers?.interrupted() ?? null;
      if (pending !== null) {
        throw new MatrixInterrupted(pending, dirName, `orchestrator received signal during the ${where || "attempt"}`);
      }
    };

    throwIfInterrupted("");

    if (evaluated.classification.rateLimited) {
      console.warn(
        `[${dirName}] rate limited (${evaluated.classification.reason}); ` +
          `sleeping ${RATE_LIMIT_RETRY_DELAY_MS / 1000}s and retrying once.`,
      );
      await sleep(RATE_LIMIT_RETRY_DELAY_MS);
      // The retry must not be judged on the first run's half-written files, but
      // the first run may also have been misclassified — see setAsideWorkspace.
      setAsideWorkspace(attemptDir, dirName);
      if (ctx.baseDir !== undefined) {
        copyBaseToWorkspace(ctx.baseDir, attemptDir);
      }
      const retry = runAttemptContainer(command(credsDir));
      if (retry.interrupted !== null) {
        throw new MatrixInterrupted(retry.interrupted, dirName, retry.removalDetail ?? "");
      }
      evaluated = evaluateRun(ctx, row, retry, attemptDir);

      throwIfInterrupted("retry");
    }

    writeRunJson(runJsonPath, evaluated.runJson);
    if (evaluated.runJson.failureKind !== "infra") {
      persistRefreshedToken(ctx.config.image, credsDir, seededToken, dirName);
    }
    return { runJson: evaluated.runJson, reason: evaluated.classification.reason };
  } finally {
    discardCredentials(credsDir);
  }
}

export function validateBaseWithRubric(rubric: string, baseDir?: string, cfgPath?: string): void {
  const isBrownfield = rubric.startsWith("maintenance-console-brownfield@");
  if (isBrownfield && !baseDir) {
    throw new Error(
      `${cfgPath ?? "runner config"} has brownfield rubric (${rubric}), but --base was not provided. ` +
        "Brownfield runs require --base pointing to the base project directory.",
    );
  }
  if (!isBrownfield && baseDir) {
    throw new Error(
      `--base was provided (${baseDir}), but ${cfgPath ?? "runner config"} has non-brownfield rubric (${rubric}). ` +
        "--base is only supported for brownfield runs.",
    );
  }
}

async function main(argv: string[]): Promise<number> {
  // Credentials first, then the lock: releasing the lock is what lets another
  // matrix start, and it must not start while a container might still hold
  // the token. Both are synchronous and never throw, so the `exit` listener
  // runs them too — on a normal return, a thrown error, and a second signal.
  interruptHandlers = installInterruptHandlers({
    cleanups: [
      cleanupCredentialDirs,
      releaseMatrixLock,
      () => {
        if (!interruptReported) {
          interruptReported = true;
          console.error("credential directory removed; rerun to resume.");
        }
      },
    ],
    exitCleanups: [cleanupCredentialDirs, releaseMatrixLock],
  });
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const root = args.root ?? DEFAULT_ROOT;
  const cfgPath = configPath(root, args.config);
  const config = loadRunnerConfig(cfgPath, { only: args.only, allowPlaceholders: args.dryRun });
  validateBaseWithRubric(config.rubric, args.base, cfgPath);
  if (!config.credentialFiles.includes(TOKEN_FILE)) {
    // Otherwise seeding still works, `tokenHash` reads nothing, and every token
    // agy refreshes is thrown away with the throwaway HOME — silently.
    throw new Error(
      `${cfgPath}: credentialFiles does not list ${TOKEN_FILE}, which this script also names as the ` +
        "OAuth token it hashes and copies back onto the " +
        `${CREDENTIALS_VOLUME} volume.\nThe two must agree: add it to credentialFiles, or update TOKEN_FILE in ` +
        "scripts/run-matrix.ts if agy renamed the token.",
    );
  }
  const known = new Set(config.matrix.map((row) => row.id));
  for (const id of args.skip) {
    if (!known.has(id)) {
      throw new Error(`--skip ${JSON.stringify(id)} is not a matrix id. Known ids: ${[...known].join(", ")}`);
    }
  }
  const rows = selectMatrixRows(config, args.only).filter((row) => !args.skip.includes(row.id));
  if (rows.length === 0) {
    throw new Error("--only and --skip leave nothing to run; nothing was started.");
  }
  const attempts = args.attempts ?? config.attempts;
  const activePromptPath = promptPath(root, config.rubric);
  if (!existsSync(activePromptPath)) {
    // Docker would silently create a root-owned directory at this mount point.
    throw new Error(`${activePromptPath} is missing; it is the vendored task prompt every attempt mounts read-only.`);
  }
  if (!args.dryRun) {
    // Before anything starts a container, and after the config has been proven
    // loadable — a run that is going to die on a bad runner.yaml should not
    // first tell somebody else's matrix to wait.
    acquireMatrixLock(root);
    requireCredentialsVolume(config.image);
    warnAboutLeftoverCredentialDirs();
  }
  const imageRef = resolveImageRef(config.image, args.dryRun);
  const ctx: AttemptContext = { config, imageRef, root, dryRun: args.dryRun, baseDir: args.base };

  console.log(
    `${args.dryRun ? "dry run: " : ""}${rows.length} config(s) x ${attempts} attempt(s) ` +
      `on ${imageRef}, judge ${config.judge}, rubric ${config.rubric}`,
  );

  for (const row of rows) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const dirName = attemptDirName(row.id, attempt);
      const resume = resumeDecision(attemptRunJsonPath(root, dirName));
      if (resume.message !== null) console.log(`[${dirName}] ${resume.message}`);
      if (resume.skip) continue;
      let outcome: { runJson: RunJson; reason: string } | null;
      try {
        // Same reason as in `runOneAttempt`: a signal that reached only the
        // runner stops the matrix here rather than after the last attempt.
        await yieldToSignals(`${dirName} (before the attempt)`);
        outcome = await runOneAttempt(ctx, row, attempt);
      } catch (error) {
        // Not a failure of the attempt and not a data point: stop here rather
        // than starting the next container. This is the signal the docker child
        // got too, recognised synchronously from its result; one that reached
        // the runner alone exits from its own handler — see `MatrixInterrupted`.
        if (error instanceof MatrixInterrupted) {
          interruptReported = true;
          console.error(`\n${error.message}`);
          return error.exitCode;
        }
        throw error;
      }
      if (outcome === null) continue;
      const { runJson, reason } = outcome;
      console.log(
        `[${dirName}] ${runJson.failureKind ?? "ok"}: ${reason} ` +
          `(${Math.round(runJson.durationMs / 1000)}s, exit ${runJson.exitCode})`,
      );
      if (runJson.failureKind === "infra") {
        console.error(
          `\nStopping the matrix: ${dirName} failed for infrastructure reasons (${reason}).\n` +
            "This is not a data point — fix the cause and rerun; the attempt will be retried.\n" +
            `stderr tail:\n${runJson.stderrTail}`,
        );
        return 1;
      }
    }
  }

  console.log(args.dryRun ? "\ndry run complete — nothing was written." : "\nmatrix complete.");
  return 0;
}

// Only run the matrix when this file is the process entry point, so a test can
// import the argument builders above and assert on the argv arrays themselves
// rather than on how they happen to be logged.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`run-matrix: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
