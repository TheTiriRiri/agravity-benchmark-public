/**
 * Not part of `npm test` (not a `*.test.ts`): `test/attempt-backend.test.ts`
 * runs it as its own `node --test` process, with a stand-in for the machine's
 * real `docker` first on the PATH it starts from.
 *
 * It is a suite with the fake-docker hooks and one test that leaves work
 * pending past them, as a failing lifecycle test leaves a backend's steps:
 *
 * - a fake `pip install` that hangs, whose client is still polling for its
 *   container record when the `after` hook removes the state directory;
 * - `docker` by name, once through `spawnSync` and once through `spawn`,
 *   called only once every `after` hook has finished.
 *
 * What that work met goes to `$LEAK_REPORT` as JSON.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { FAKE_DOCKER, useFakeDockerBackend } from "./fake-docker-backend-hooks";

// First: its `after` hook must run before this file's own.
const hooks = useFakeDockerBackend();

const IMAGE = "agrav-bench/harness:2026-09-18";
const NAME = "agrav-backend-leak-attempt-1-1-1";

let hooksDone!: () => void;
const allHooksDone = new Promise<void>((resolve) => (hooksDone = resolve));
// `after` hooks run in the order they were registered: this one runs last.
after(() => hooksDone());

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function dockerByName(args: string[]): Promise<{ code: number | null; stderr: string; error: string | null }> {
  return new Promise((resolve) => {
    const child = spawn("docker", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => resolve({ code: null, stderr, error: error.message }));
    child.on("close", (code) => resolve({ code, stderr, error: null }));
  });
}

test("docker work left pending past the fake-docker hooks", async () => {
  const report = process.env.LEAK_REPORT;
  if (!report) throw new Error("LEAK_REPORT is not set");
  const root = hooks.newRoot("attempt-backend-leak-");
  const state = join(root, "state");
  const scratch = join(root, "tmp", "agrav-backend-1-leak00");
  mkdirSync(state, { recursive: true });
  mkdirSync(join(scratch, "venv", "bin"), { recursive: true });
  writeFileSync(join(scratch, "venv", "bin", "pip"), "#!/bin/sh\n", { mode: 0o755 });

  // A hung pip install, by the fake's own path: set-up, not the pending work.
  const client = spawn(
    FAKE_DOCKER,
    ["run", "--name", NAME, "-v", `${scratch}:/scoring`, "--entrypoint", "/scoring/venv/bin/pip", IMAGE, "install", "-r", "requirements.txt"],
    { env: { ...process.env, FAKE_DOCKER_STATE: state, FAKE_INSTALL: "hang" }, stdio: "ignore" },
  );
  const clientExit = new Promise<number | string | null>((resolve) => {
    client.on("error", (error) => resolve(error.message));
    client.on("exit", (code, signal) => resolve(code ?? signal));
  });
  // Its "container" is up once the record names the sleeper rather than the
  // client itself: the client is then in its poll.
  const record = join(state, "containers", `${NAME}.json`);
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const pid = (JSON.parse(readFileSync(record, "utf8")) as { pid: number | null }).pid;
      if (pid !== null && pid !== client.pid) break;
    } catch {
      // not written yet
    }
    if (Date.now() > deadline) throw new Error("the hung install never started");
    await pause(20);
  }

  // Pending, as a failing test's backend steps are; resumes after every hook.
  void (async () => {
    let result: unknown;
    try {
      await allHooksDone;
      const rootAfterHooks = existsSync(root);
      const sync = spawnSync("docker", ["rm", "-f", NAME], { encoding: "utf8", timeout: 10_000 });
      const later = await dockerByName(["inspect", NAME]);
      let giveUp: NodeJS.Timeout | undefined;
      const clientCode = await Promise.race([clientExit, new Promise<string>((done) => (giveUp = setTimeout(done, 5_000, "still running")))]);
      clearTimeout(giveUp);
      await pause(500); // five of the hung client's polls, had it gone on
      result = {
        rootAfterHooks,
        sync: { code: sync.status, stderr: sync.stderr ?? "", error: sync.error?.message ?? null },
        async: later,
        client: clientCode,
        rootRecreated: existsSync(root),
      };
    } catch (error) {
      result = { error: String(error) };
    }
    writeFileSync(report, JSON.stringify(result));
  })();
});
