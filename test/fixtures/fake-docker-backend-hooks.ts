/**
 * The `node:test` hooks for a suite that drives `AttemptBackend` in process
 * through the stateful fake `docker` (`test/fixtures/fake-docker-backend/docker`).
 *
 * - `before`: the fake goes first on PATH, and the suite refuses to run unless
 *   `docker` then answers as the fake.
 * - `afterEach`: every knob is cleared.
 * - `after`: every backend is closed, and from then on `docker` resolves to
 *   `test/fixtures/docker-refused/docker`, which fails every call. PATH is
 *   never put back as it was. A failing test can leave backend work pending
 *   (a hung install whose timer fires later, say), and that work must never
 *   reach the machine's real client: with this repository's image present,
 *   it would start real containers and have the daemon re-create deleted
 *   mount sources as root. The switch is proven, as `before` proves the
 *   fake: should `docker` not answer as the refuser (it lost its executable
 *   bit, say, so the search fell through to the real client), the fake goes
 *   first again — it refuses every call once `FAKE_DOCKER_STATE` is cleared —
 *   and the hook fails once it has cleaned up. Only then are the fake's
 *   processes killed and the scratch roots removed.
 *
 * A suite calls `useFakeDockerBackend()` once, at module level. Every file
 * runs in its own `node:test` process, so nothing after it needs the old PATH.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, afterEach, before } from "node:test";
import { fileURLToPath } from "node:url";

import { stopAllBackends } from "../../scripts/lib/attempt-backend";
import { killSurvivors } from "./fake-docker-backend-pids";

export const FAKE_DOCKER_DIR = fileURLToPath(new URL("./fake-docker-backend/", import.meta.url));
export const FAKE_DOCKER = join(FAKE_DOCKER_DIR, "docker");
/** Holds a `docker` that fails every call; first on PATH once the suite's `after` hook has begun. */
export const REFUSED_DOCKER_DIR = fileURLToPath(new URL("./docker-refused/", import.meta.url));

/** Every variable the fake reads, cleared after each test. */
export const FAKE_KNOBS = [
  "FAKE_DOCKER_STATE",
  "FAKE_VENV",
  "FAKE_INSTALL",
  "FAKE_PROBE",
  "FAKE_CLIENT_LINGER_MS",
  "FAKE_BACKEND",
  "FAKE_HEALTH_404_FIRST",
  "FAKE_RUN_D",
  "FAKE_RM",
  "FAKE_INSPECT_FAIL_AFTER",
] as const;

/**
 * Put `refusedDir` first on PATH, before `originalPath`, and prove that
 * `docker` now answers as the refuser. When it does not, the fake goes first
 * again and the reason is returned; `null` when the refuser answers.
 */
export function switchToRefusedDocker(originalPath: string, refusedDir: string = REFUSED_DOCKER_DIR): string | null {
  process.env.PATH = `${refusedDir}${delimiter}${originalPath}`;
  const probe = spawnSync("docker", ["--probe"], { encoding: "utf8", timeout: 10_000 });
  if (/^docker refused: /.test(probe.stderr ?? "")) return null;
  process.env.PATH = `${FAKE_DOCKER_DIR}${delimiter}${originalPath}`;
  const answer = probe.error !== undefined ? probe.error.message : `exit ${probe.status}, stderr ${JSON.stringify((probe.stderr ?? "").slice(0, 200))}`;
  return (
    `\`docker\` on PATH did not answer as ${join(refusedDir, "docker")} after the suite (${answer}); ` +
    `${FAKE_DOCKER} is first on PATH again, and it refuses every call with no state directory set`
  );
}

export interface FakeDockerHooks {
  /** PATH as it was before the suite's `before` hook. */
  readonly originalPath: string;
  /**
   * A new scratch root under `os.tmpdir()`. The `after` hook kills every
   * process the fake recorded under `<root>/state` (start-time checked), then
   * removes the root.
   */
  newRoot(prefix?: string): string;
}

export function useFakeDockerBackend(): FakeDockerHooks {
  const originalPath = process.env.PATH ?? "";
  const originalKnobs = FAKE_KNOBS.map((key) => [key, process.env[key]] as const);
  const roots: string[] = [];

  before(() => {
    process.env.PATH = `${FAKE_DOCKER_DIR}${delimiter}${originalPath}`;
    // Fail closed: if `docker` resolved to a real client (the fake not
    // executable, say), these tests would start real containers from an image
    // that may well exist on this machine.
    const identity = spawnSync("docker", ["--fake-identity"], { encoding: "utf8", timeout: 10_000 });
    if (identity.stdout?.trim() !== "fake-docker-backend") {
      throw new Error(`\`docker\` on PATH is not ${FAKE_DOCKER}; refusing to run the lifecycle tests against it`);
    }
  });

  afterEach(() => {
    for (const key of FAKE_KNOBS) delete process.env[key];
  });

  after(async () => {
    // Close every backend, so none of its steps goes on. Its removals meet the
    // fake with no state directory set, which refuses them; the kills below do
    // what they could not.
    await stopAllBackends();
    // From here on, whatever is still pending meets a refusal, never a daemon.
    const unrefused = switchToRefusedDocker(originalPath);
    for (const root of roots) {
      // Only a process whose start time still matches the fake's record: a pid
      // reused by another process is never signalled.
      killSurvivors(join(root, "state"));
      rmSync(root, { recursive: true, force: true });
    }
    for (const [key, value] of originalKnobs) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (unrefused !== null) throw new Error(unrefused);
  });

  return {
    originalPath,
    newRoot(prefix = "attempt-backend-test-") {
      const root = mkdtempSync(join(tmpdir(), prefix));
      roots.push(root);
      return root;
    },
  };
}
