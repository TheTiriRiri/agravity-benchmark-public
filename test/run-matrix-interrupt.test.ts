/**
 * What happens when the operator stops a matrix, and what happens when a
 * container will not die.
 *
 * These are the two paths the runner could not previously survive, and they are
 * also the two nothing tested — the runner is the least-exercised component in
 * the repo precisely because exercising it looked like it needed a real
 * container. It does not: every docker call is `spawnSync("docker", …)`, so
 * `test/fixtures/fake-docker/docker` earlier on `PATH` drives the real script
 * end to end. No daemon, no agy, no quota, and `--root` always points at a temp
 * directory, so the checkout is never written to.
 *
 * The defects these pin, all reproduced against the script before the fix:
 *
 * - One Ctrl-C recorded the interrupted attempt as `failureKind: "model"` (a
 *   permanent 0-scoring data point the resume rule then skipped forever) and
 *   did **not** stop the loop — every remaining attempt ran, the run printed
 *   `matrix complete.`, and only then reported the SIGINT.
 * - `SIGHUP` and `SIGQUIT` terminated Node without running `exit` listeners,
 *   leaving the throwaway HOME — with the account's OAuth token in it — behind.
 * - After the outer timeout the compensating `docker rm -f` had its result
 *   discarded, so a container that survived was never noticed and the next
 *   attempt started alongside it.
 * - Nothing stopped a second `run-matrix` from starting alongside the first:
 *   both drove the same OAuth session and the same quota, and the second one's
 *   workspace reset deleted the first one's live attempt directory.
 * - A signal that reached only the runner — `kill <pid>`, a supervisor's
 *   SIGTERM, a Ctrl-C landing in a JS gap — was queued and not dispatched until
 *   the whole matrix had run, because every `await` on the happy path resolves
 *   an already-settled promise and libuv never gets a turn.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { detectInterrupt } from "../scripts/lib/interrupt";
import { ensureAttemptContainerRemoved, matrixLockPath } from "../scripts/run-matrix";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../scripts/run-matrix.ts", import.meta.url));
const FAKE_DOCKER_DIR = fileURLToPath(new URL("./fixtures/fake-docker", import.meta.url));

const scratchDirs: string[] = [];

after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

/**
 * The lock the runner takes, as it resolves under a child's redirected
 * `TMPDIR`. The lock is machine-wide — it guards one OAuth session and one
 * weekly quota, not one checkout — so it lives in `$TMPDIR`, not at the repo
 * root, and only the basename is this repository's to know.
 */
function lockIn(tempHome: string): string {
  return join(tempHome, basename(matrixLockPath()));
}

/**
 * A repo root the runner will actually run against: the real `runner.yaml` with
 * the Phase 0 placeholders substituted, so `loadRunnerConfig` permits a
 * non-dry-run, plus the real `prompt.md`. Also strips a `hold` key, if the real
 * config carries one — these tests exercise real non-dry-runs and would
 * otherwise be refused by the same check that protects a live matrix.
 */
function makeRoot(edits: Array<[key: string, value: string]> = []): string {
  const root = scratch("agrav-interrupt-root-");
  mkdirSync(join(root, "benchmark"), { recursive: true });
  let yaml = readFileSync(join(REPO_ROOT, "benchmark", "runner.yaml"), "utf8")
    .replaceAll("TODO-cli-id", "fake-model-id")
    .replaceAll("TODO-token-file", "oauth_token.json")
    .replace(/^hold:.*\n?/m, "");
  for (const [key, value] of edits) {
    const line = new RegExp(`^${key}:.*$`, "m");
    assert.ok(line.test(yaml), `runner.yaml no longer has a top-level ${key}`);
    yaml = yaml.replace(line, `${key}: ${value}`);
  }
  writeFileSync(join(root, "benchmark", "runner.yaml"), yaml);
  copyFileSync(join(REPO_ROOT, "prompt.md"), join(root, "prompt.md"));
  return root;
}

interface RunOutcome {
  code: number | null;
  output: string;
  /** Where the runner's throwaway HOMEs were created, for a leak check. */
  tempHome: string;
}

/** How long to wait for the fake attempt container, and how often to look. */
const CONTAINER_START_TIMEOUT_MS = 30_000;
const CONTAINER_POLL_MS = 25;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Start the matrix in its own process group, deliver `signal` once the fake
 * attempt container is running, and wait for it. The group is what makes this
 * faithful: Ctrl-C at a terminal goes to the whole foreground process group, so
 * the docker child gets it too.
 *
 * The wait is on the container's own marker file, not on a clock. A fixed delay
 * assumed the runner had reached the container by then; under CPU load it had
 * not, the signal landed during the credential seed or the quota gate, and the
 * run exited through the handler rather than through `MatrixInterrupted` — a
 * flake that reached a plain `npm test`.
 */
interface RunningMatrix {
  readonly tempHome: string;
  /** Resolves once the fake attempt container is running; throws if the run ended first. */
  reachedContainer(): Promise<void>;
  killGroup(signal: NodeJS.Signals): void;
  finished(): Promise<RunOutcome>;
}

/** Start the matrix in its own process group and let a test act while it runs. */
function startMatrix(root: string, args: string[], attemptSleepSeconds = "5"): RunningMatrix {
  const tempHome = scratch("agrav-interrupt-tmp-");
  const startedMarker = join(tempHome, "attempt-container-started");
  const child = spawn(process.execPath, ["--import", "tsx", SCRIPT, "--root", root, ...args], {
    cwd: REPO_ROOT,
    detached: true,
    env: {
      ...process.env,
      PATH: `${FAKE_DOCKER_DIR}:${process.env.PATH ?? ""}`,
      TMPDIR: tempHome,
      FAKE_ATTEMPT_SLEEP: attemptSleepSeconds,
      FAKE_ATTEMPT_STARTED: startedMarker,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));

  let exited = false;
  const closed = new Promise<number | null>((resolve) => {
    child.on("close", (code) => {
      exited = true;
      resolve(code);
    });
  });

  const killGroup = (which: NodeJS.Signals): void => {
    try {
      process.kill(-(child.pid as number), which);
    } catch {
      /* already gone */
    }
  };

  return {
    tempHome,
    killGroup,
    async reachedContainer(): Promise<void> {
      const deadline = Date.now() + CONTAINER_START_TIMEOUT_MS;
      while (!existsSync(startedMarker)) {
        if (exited || Date.now() >= deadline) {
          killGroup("SIGKILL");
          await closed;
          throw new Error(
            `the fake attempt container never started within ${CONTAINER_START_TIMEOUT_MS}ms ` +
              `(runner ${exited ? "exited first" : "still running"}); it printed:\n${output}`,
          );
        }
        await delay(CONTAINER_POLL_MS);
      }
    },
    async finished(): Promise<RunOutcome> {
      return { code: await closed, output, tempHome };
    },
  };
}

function runAndSignal(root: string, signal: NodeJS.Signals, args: string[]): Promise<RunOutcome> {
  const run = startMatrix(root, args);
  return (async (): Promise<RunOutcome> => {
    await run.reachedContainer();
    // The container is the runner's `spawnSync` child, so the runner is blocked
    // in that call from before the marker exists; this only lets its output land.
    await delay(100);
    run.killGroup(signal);
    return run.finished();
  })();
}

/** Throwaway HOMEs the runner left behind. Each would hold the OAuth token. */
function leakedCredentialDirs(tempHome: string): string[] {
  return readdirSync(tempHome).filter((entry) => entry.startsWith("agrav-creds-"));
}

// --- the synchronous recognition, unit ---------------------------------------

test("detectInterrupt reads both shapes a stopped docker child can take", () => {
  // Ctrl-C reaches the client through the process group.
  assert.equal(detectInterrupt({ signal: "SIGINT", status: null }), "SIGINT");
  assert.equal(detectInterrupt({ signal: "SIGHUP", status: null }), "SIGHUP");
  // …or docker proxies it into the container and exits 128+N itself.
  assert.equal(detectInterrupt({ signal: null, status: 130 }), "SIGINT");
  assert.equal(detectInterrupt({ signal: null, status: 143 }), "SIGTERM");
  assert.equal(detectInterrupt({ signal: null, status: 129 }), "SIGHUP");
  assert.equal(detectInterrupt({ signal: null, status: 131 }), "SIGQUIT");

  // The outer timeout kills with SIGKILL and stays a model failure — a data
  // point. Reading it as an interruption would discard a real result.
  assert.equal(detectInterrupt({ signal: "SIGKILL", status: null }), null);
  assert.equal(detectInterrupt({ signal: null, status: 0 }), null);
  assert.equal(detectInterrupt({ signal: null, status: 1 }), null);
});

// --- proving the container is gone, unit -------------------------------------

function fakeDocker(responses: Record<string, Partial<SpawnSyncReturns<string>>>) {
  const calls: string[][] = [];
  const run = (args: string[]): SpawnSyncReturns<string> => {
    calls.push(args);
    const response = responses[args[0]] ?? {};
    return {
      pid: 1,
      output: [],
      stdout: "",
      stderr: "",
      status: 0,
      signal: null,
      ...response,
    } as SpawnSyncReturns<string>;
  };
  return { run, calls };
}

test("a successful `docker rm -f` is proof enough, and nothing else is asked", () => {
  const { run, calls } = fakeDocker({ rm: { status: 0 } });
  const result = ensureAttemptContainerRemoved("agrav-x-attempt-1", run);
  assert.equal(result.removed, true);
  assert.deepEqual(calls, [["rm", "-f", "agrav-x-attempt-1"]]);
});

test("a container the daemon says is already gone, or stopped, counts as removed", () => {
  const gone = fakeDocker({
    rm: { status: 1, stderr: 'Error response from daemon: No such container: agrav-x-attempt-1' },
    inspect: { status: 1, stderr: "Error: No such object: agrav-x-attempt-1" },
  });
  assert.equal(ensureAttemptContainerRemoved("agrav-x-attempt-1", gone.run).removed, true);

  const stopped = fakeDocker({
    rm: { status: 1, stderr: "daemon busy" },
    inspect: { status: 0, stdout: "false\n" },
  });
  assert.equal(ensureAttemptContainerRemoved("agrav-x-attempt-1", stopped.run).removed, true);
});

test("a container still running, or a daemon that will not answer, is not removed", () => {
  const running = fakeDocker({
    rm: { status: 1, stderr: "daemon busy" },
    inspect: { status: 0, stdout: "true\n" },
  });
  const stillThere = ensureAttemptContainerRemoved("agrav-x-attempt-1", running.run);
  assert.equal(stillThere.removed, false);
  assert.match(stillThere.detail, /second agy session on the same OAuth token/);

  // An unreachable daemon is where a second live session is *most* likely, so
  // "cannot tell" has to read as "still there".
  const unreachable = fakeDocker({
    rm: { status: 1, stderr: "Cannot connect to the Docker daemon" },
    inspect: { status: 1, stderr: "Cannot connect to the Docker daemon" },
  });
  assert.equal(ensureAttemptContainerRemoved("agrav-x-attempt-1", unreachable.run).removed, false);
});

// --- the whole runner, under a signal ----------------------------------------

test("one SIGINT stops the matrix, records nothing, and leaves no credentials behind", async () => {
  const root = makeRoot();
  const outcome = await runAndSignal(root, "SIGINT", ["--only", "gemini-31-pro-high", "--attempts", "3"]);

  assert.equal(outcome.code, 130, outcome.output);
  assert.match(outcome.output, /SIGINT — gemini-31-pro-high-attempt-1 was interrupted/);
  assert.match(outcome.output, /No run\.json was written/);

  // The loop stopped where it was told to: attempt 2 never started. Before the
  // fix all three ran and the script reported "matrix complete."
  assert.equal(outcome.output.includes("gemini-31-pro-high-attempt-2"), false, outcome.output);
  assert.equal(outcome.output.includes("matrix complete"), false, outcome.output);

  // Nothing recorded, so the resume rule runs this attempt again rather than
  // stranding it as a model failure the model never made.
  assert.equal(
    existsSync(join(root, "eval-results", "gemini-31-pro-high-attempt-1", "run.json")),
    false,
    "an interrupted attempt must not be recorded as a data point",
  );

  assert.deepEqual(leakedCredentialDirs(outcome.tempHome), []);
  assert.equal(
    existsSync(lockIn(outcome.tempHome)),
    false,
    "an interrupted run must release its lock, or the rerun it tells you to do is blocked",
  );
});

for (const signal of ["SIGHUP", "SIGQUIT", "SIGTERM"] as const) {
  test(`${signal} removes the throwaway HOME holding the OAuth token`, async () => {
    const outcome = await runAndSignal(makeRoot(), signal, ["--only", "gemini-31-pro-high", "--attempts", "1"]);
    assert.deepEqual(
      leakedCredentialDirs(outcome.tempHome),
      [],
      `${signal} left a credential directory: ${outcome.output}`,
    );
  });
}

// --- a signal that reaches the runner alone ----------------------------------
//
// Ctrl-C at a terminal reaches the whole foreground process group, so the docker
// child gets it too and `detectInterrupt` reads it straight out of the spawnSync
// result — that is what the tests above exercise. `kill <pid>`, a supervisor's
// SIGTERM, or a Ctrl-C landing in a gap between two `spawnSync` calls reach the
// runner alone: no result carries them, so only the handler can act, and the
// handler needs the event loop to turn. Before the fix nothing turned it — every
// `await` on the happy path resolves an already-settled promise — so the whole
// matrix ran, printed `matrix complete.`, and only then reported the signal.

for (const [signal, code] of [
  ["INT", 130],
  ["TERM", 143],
] as const) {
  test(`SIG${signal} to the runner alone stops the matrix at the next attempt`, () => {
    const root = makeRoot();
    const outcome = runMatrix(root, ["--only", "gemini-31-pro-high", "--attempts", "3"], {
      FAKE_SIGNAL_PARENT: signal,
    });

    assert.equal(outcome.status, code, outcome.output);
    assert.match(outcome.output, new RegExp(`SIG${signal} — cleaning up`));
    assert.equal(outcome.output.includes("matrix complete"), false, outcome.output);

    // The attempt that was running when the signal arrived is a real data point
    // and is kept; the two after it never start.
    const recorded = [1, 2, 3].filter((n) =>
      existsSync(join(root, "eval-results", `gemini-31-pro-high-attempt-${n}`, "run.json")),
    );
    assert.deepEqual(recorded, [1], outcome.output);

    assert.deepEqual(leakedCredentialDirs(outcome.tempHome), []);
    assert.equal(existsSync(lockIn(outcome.tempHome)), false);
  });
}

test("a signal to the runner alone during the /usage gate records nothing at all", () => {
  const root = makeRoot();
  const outcome = runMatrix(root, ["--only", "gemini-31-pro-high", "--attempts", "2"], {
    FAKE_SIGNAL_USAGE: "INT",
  });

  assert.equal(outcome.status, 130, outcome.output);
  assert.equal(outcome.output.includes("matrix complete"), false, outcome.output);
  // No container ever started, so there is neither a workspace nor a result.
  assert.equal(existsSync(join(root, "eval-results")), false, outcome.output);
  assert.equal(existsSync(join(root, "eval-attempts")), false, outcome.output);
  assert.deepEqual(leakedCredentialDirs(outcome.tempHome), []);
  assert.equal(existsSync(lockIn(outcome.tempHome)), false);
});

// --- an interrupted envelope from the container ---------------------------------
//
// Docker forwards SIGINT into the container. agy catches it, emits
// `{"status":"ERROR","error":"interrupted"}`, and exits 0. spawnSync returns
// signal: null, exit 0. Before the fix this was classified as `model` and a
// run.json was written — a permanent zero the model never earned. After the fix
// it throws MatrixInterrupted and writes no run.json.

test("an agy envelope with error 'interrupted' is an operator interruption, not a model failure", () => {
  const root = makeRoot();
  const result = runMatrix(root, ["--only", "gemini-31-pro-high", "--attempts", "2"], {
    FAKE_ENVELOPE_INTERRUPTED: "1",
  });

  // MatrixInterrupted exits 130 (SIGINT).
  assert.equal(result.status, 130, result.output);
  assert.match(result.output, /was interrupted/);
  assert.match(result.output, /No run\.json was written/);

  // No run.json — the resume rule re-runs this attempt.
  assert.equal(
    existsSync(join(root, "eval-results", "gemini-31-pro-high-attempt-1", "run.json")),
    false,
    "an interrupted envelope must not be recorded as a data point",
  );

  // The loop stopped: attempt 2 never started.
  assert.equal(result.output.includes("gemini-31-pro-high-attempt-2"), false, result.output);
  assert.equal(result.output.includes("matrix complete"), false, result.output);
});

// --- the workspace a re-run starts in ----------------------------------------

test("a re-run starts in an empty workspace, not the discarded run's output", () => {
  const root = makeRoot();
  const attemptDir = join(root, "eval-attempts", "gemini-31-pro-high-attempt-1");
  mkdirSync(attemptDir, { recursive: true });
  writeFileSync(join(attemptDir, "from-the-discarded-run.txt"), "half a website\n");

  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", SCRIPT, "--root", root, "--only", "gemini-31-pro-high", "--attempts", "1"],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${FAKE_DOCKER_DIR}:${process.env.PATH ?? ""}`,
        TMPDIR: scratch("agrav-interrupt-tmp-"),
        FAKE_ATTEMPT_SLEEP: "0",
      },
    },
  );

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(
    existsSync(join(attemptDir, "from-the-discarded-run.txt")),
    false,
    "the previous run's files must not be part of what this attempt is judged on",
  );
  assert.equal(existsSync(join(attemptDir, "package.json")), true);
});

// --- the container the timeout did not kill ----------------------------------

test("a container that outlived the timeout stops the matrix, not just the attempt", () => {
  // spawnSync's `timeout` kills the *docker client*; `docker run` without -t
  // leaves the container running. Here `docker rm -f` fails and `docker inspect`
  // says the container is still running, which is exactly the state where a
  // second agy session would be live on the same OAuth token and the same weekly
  // quota while the loop starts the next attempt.
  const root = makeRoot([
    ["timeoutMs", "2000"],
    ["printTimeout", "1s"],
  ]);

  const result = runMatrix(root, ["--only", "gemini-31-pro-high", "--attempts", "2"], {
    FAKE_ATTEMPT_SLEEP: "5",
    FAKE_RM_STATUS: "1",
  });

  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /could not be confirmed removed/);
  assert.match(result.output, /Stopping the matrix/);
  assert.equal(
    result.output.includes("gemini-31-pro-high-attempt-2"),
    false,
    `attempt 2 must not start beside a container still holding the session:\n${result.output}`,
  );

  // Infra, not model: the model did not fail, so this must not be recorded as a
  // 0-scoring data point.
  const runJson = JSON.parse(
    readFileSync(join(root, "eval-results", "gemini-31-pro-high-attempt-1", "run.json"), "utf8"),
  ) as { failureKind: string | null };
  assert.equal(runJson.failureKind, "infra");
});

// --- one matrix at a time ----------------------------------------------------

/**
 * Run the matrix to completion against the fake docker.
 *
 * `tempHome` is both the child's `TMPDIR` — where the throwaway HOMEs and the
 * machine-wide lock land — and how a caller reaches either of them. Pass one in
 * to share it between two runs, as the two-checkout test does.
 */
function runMatrix(
  root: string,
  args: string[],
  extraEnv: Record<string, string> = {},
  tempHome: string = scratch("agrav-interrupt-tmp-"),
): { status: number | null; output: string; tempHome: string } {
  const result = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, "--root", root, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${FAKE_DOCKER_DIR}:${process.env.PATH ?? ""}`,
      TMPDIR: tempHome,
      FAKE_ATTEMPT_SLEEP: "0",
      ...extraEnv,
    },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}`, tempHome };
}

test("a second matrix refuses to start while one is running", () => {
  const root = makeRoot();
  const tempHome = scratch("agrav-interrupt-tmp-");
  const lock = lockIn(tempHome);
  // The test runner's own pid: a process that certainly exists, standing in for
  // the matrix that is already running.
  writeFileSync(
    lock,
    JSON.stringify({
      pid: process.pid,
      startedAt: "2026-09-05T00:00:00.000Z",
      argv: ["--only", "gemini-38-flash-high"],
      root: "/checkouts/the-other-one",
    }),
  );

  const result = runMatrix(root, ["--only", "gemini-31-pro-high", "--attempts", "1"], {}, tempHome);

  assert.equal(result.status, 1, result.output);
  assert.match(result.output, new RegExp(`another run-matrix is already running \\(pid ${process.pid}`));
  assert.match(result.output, /--only gemini-38-flash-high/);
  // The holder's root, so an operator who cannot find the other matrix in this
  // checkout is told which one to look in.
  assert.match(result.output, /root \/checkouts\/the-other-one/);

  // Nothing ran: no container, no workspace, and above all the live matrix's
  // lock is still its own.
  assert.equal(existsSync(join(root, "eval-attempts", "gemini-31-pro-high-attempt-1")), false);
  assert.equal(existsSync(lock), true, "the refused run must not delete the holder's lock");
});

test("the lock is machine-wide: a second checkout refuses to start too", () => {
  // What it guards is the agy-creds volume's one OAuth session and the weekly
  // quota behind it, and both are machine-wide. A per-checkout lock let two
  // clones of this repository run two matrices on one token.
  const held = makeRoot();
  const other = makeRoot();
  assert.notEqual(held, other);
  const tempHome = scratch("agrav-interrupt-tmp-");
  writeFileSync(
    lockIn(tempHome),
    JSON.stringify({ pid: process.pid, startedAt: "2026-09-19T00:00:00.000Z", argv: [], root: held }),
  );

  const result = runMatrix(other, ["--only", "gemini-31-pro-high", "--attempts", "1"], {}, tempHome);

  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /another run-matrix is already running/);
  assert.match(result.output, new RegExp(`root ${held.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.equal(existsSync(join(other, "eval-attempts", "gemini-31-pro-high-attempt-1")), false);
});

test("a lock left by a crashed run is taken over, not treated as a permanent block", () => {
  const root = makeRoot();
  const tempHome = scratch("agrav-interrupt-tmp-");
  const lock = lockIn(tempHome);
  // 2147483647 is above Linux's pid_max, so `kill(pid, 0)` is ESRCH forever —
  // no pid reuse can make this flaky.
  writeFileSync(lock, JSON.stringify({ pid: 2147483647, startedAt: "2026-09-04T00:00:00.000Z", argv: [], root }));

  const result = runMatrix(root, ["--only", "gemini-31-pro-high", "--attempts", "1"], {}, tempHome);

  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /taking over a stale lock/);
  assert.equal(existsSync(join(root, "eval-attempts", "gemini-31-pro-high-attempt-1", "package.json")), true);
  assert.equal(existsSync(lock), false, "the lock must be released when the run ends");
});

test("a symlink planted at the lock path is replaced, never written through", () => {
  // The lock lives in a shared, world-writable $TMPDIR now. A plain write over
  // a symlink planted at its name would take over "the stale lock" by
  // truncating whatever the link points at — the repo-root path it replaced was
  // private and could not be set up this way.
  const root = makeRoot();
  const tempHome = scratch("agrav-interrupt-tmp-");
  const target = join(scratch("agrav-interrupt-target-"), "not-the-lock");
  const contents = "a file this run has no business writing\n";
  writeFileSync(target, contents);
  const lock = lockIn(tempHome);
  symlinkSync(target, lock);

  const result = runMatrix(root, ["--only", "gemini-31-pro-high", "--attempts", "1"], {}, tempHome);

  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /taking over a stale lock/);
  assert.equal(readFileSync(target, "utf8"), contents, "the symlink's target must not be written through");
  assert.equal(existsSync(join(root, "eval-attempts", "gemini-31-pro-high-attempt-1", "package.json")), true);
  // lstat, not existsSync: the run must have replaced the link with a regular
  // file of its own and released that, leaving neither behind. A dangling
  // symlink would pass existsSync just as an absent path does.
  assert.throws(() => lstatSync(lock), /ENOENT/, "neither the lock nor the planted symlink may be left behind");
});

test("a lock taken over mid-run is left for its new holder, not deleted on the way out", async () => {
  // The other half of the takeover: a reaper clears the lock, or a SIGSTOP makes
  // this run look dead, and another matrix creates its own at the same path.
  // Unlinking whatever is there on the way out would leave that matrix
  // unprotected and let a third start — no lock at all, which is worse than the
  // state the lock exists to prevent.
  const root = makeRoot();
  const run = startMatrix(root, ["--only", "gemini-31-pro-high", "--attempts", "1"], "2");
  const lock = lockIn(run.tempHome);
  await run.reachedContainer();

  const newHolder = { pid: 999_999, startedAt: "2026-09-19T00:00:00.000Z", argv: [], root: "/somewhere/else" };
  writeFileSync(lock, `${JSON.stringify(newHolder, null, 2)}\n`);
  const result = await run.finished();

  assert.equal(result.code, 0, result.output);
  assert.equal(existsSync(lock), true, "the new holder's lock must survive this run's exit");
  assert.equal(JSON.parse(readFileSync(lock, "utf8")).pid, newHolder.pid);
  assert.match(result.output, /leaving it alone/);
  rmSync(lock, { force: true });
});

test("a lock naming pid 0 is stale, not a live holder", () => {
  // kill(0, 0) signals the caller's own process group, so an unguarded
  // liveness check calls pid 0 alive and blocks every run.
  const root = makeRoot();
  const tempHome = scratch("agrav-interrupt-tmp-");
  const lock = lockIn(tempHome);
  writeFileSync(lock, JSON.stringify({ pid: 0, startedAt: "2026-09-04T00:00:00.000Z", argv: [], root }));

  const result = runMatrix(root, ["--only", "gemini-31-pro-high", "--attempts", "1"], {}, tempHome);

  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /taking over a stale lock/);
  assert.equal(existsSync(lock), false);
});

test("--dry-run takes no lock, and a finished run leaves none", () => {
  const root = makeRoot();
  const tempHome = scratch("agrav-interrupt-tmp-");
  const lock = lockIn(tempHome);

  const dry = runMatrix(root, ["--only", "gemini-31-pro-high", "--attempts", "1", "--dry-run"], {}, tempHome);
  assert.equal(dry.status, 0, dry.output);
  assert.equal(existsSync(lock), false, "a dry run writes nothing and starts no container — it takes no lock");

  const real = runMatrix(root, ["--only", "gemini-31-pro-high", "--attempts", "1"], {}, tempHome);
  assert.equal(real.status, 0, real.output);
  assert.equal(existsSync(lock), false);
});

// --- the token agy refreshed -------------------------------------------------

/**
 * One whole attempt against the fake docker, whose /usage call rewrites the
 * token the way agy's first call in a throwaway HOME does (gate 0).
 */
function runRefreshingAttempt(extraEnv: Record<string, string> = {}) {
  const id = "gemini-31-pro-high";
  const root = makeRoot();
  const log = join(scratch("agrav-interrupt-log-"), "docker.log");
  const runJsonPath = join(root, "eval-results", `${id}-attempt-1`, "run.json");
  const result = runMatrix(root, ["--only", id, "--attempts", "1"], {
    FAKE_REFRESH_TOKEN: "1",
    FAKE_LOG: log,
    FAKE_RUN_JSON: runJsonPath,
    ...extraEnv,
  });
  const dockerCalls = readFileSync(log, "utf8").split("\n");
  const copyBacks = dockerCalls.filter((line) => line.startsWith("docker run") && line.includes("agy-creds:/dst"));
  const runJson = JSON.parse(readFileSync(runJsonPath, "utf8")) as { failureKind: string | null };
  return { result, dockerCalls, copyBacks, runJson };
}

test("a token agy refreshed is copied back once, after the result is recorded", () => {
  const { result, dockerCalls, copyBacks, runJson } = runRefreshingAttempt();

  assert.equal(result.status, 0, result.output);
  assert.notEqual(runJson.failureKind, "infra");
  assert.equal(copyBacks.length, 1, dockerCalls.join("\n"));
  assert.match(result.output, /agy refreshed the OAuth token; copied it back to the agy-creds volume/);
  assert.ok(dockerCalls.includes("token copied back after run.json was written"), dockerCalls.join("\n"));
});

test("a token agy refreshed is not copied back after an infra failure", () => {
  // The container may still hold the session, and the failure is not a data point.
  const { result, copyBacks, runJson } = runRefreshingAttempt({
    FAKE_STDERR: "notice: a tool was soft-denied by settings.json permissions",
  });

  assert.equal(runJson.failureKind, "infra", result.output);
  assert.equal(result.status, 1, result.output);
  assert.deepEqual(copyBacks, []);
  assert.equal(result.output.includes("copied it back"), false, result.output);
});
