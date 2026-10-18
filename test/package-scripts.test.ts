import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const PACKAGE_JSON = new URL("../package.json", import.meta.url);
const scripts: Record<string, string> = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")).scripts;

/**
 * The scripts whose correctness depends on their signal handlers running.
 *
 * `run-matrix` removes a throwaway HOME holding the account's OAuth token and
 * releases the single-instance lock; `screenshots` kills dev-server process
 * groups and removes lockfiles it created. Both do that work from
 * `process.on(signal)` / `process.on("exit")` handlers. `gate:reference` owns
 * a live uvicorn child that must die with it. `contract-tests` owns detached
 * backend containers and a scratch directory, which only its cleanup removes:
 * killing a docker client does not stop a detached container. `serve-attempt`
 * owns the same, plus a detached Vite process group on 5173 and its state
 * file, and runs until a signal — its handlers are its only way out.
 * `gate:backend` owns those CLIs as children, containers of its own and a
 * temporary root: its handlers stop the children, which then remove theirs.
 * `gate:fuzz` owns a live uvicorn child, like `gate:reference`;
 * `contract-tests-hard` owns what `contract-tests` does.
 */
const SIGNAL_SENSITIVE = ["run-matrix", "screenshots", "screenshots:hard", "screenshots:brownfield", "gate:reference", "contract-tests", "serve-attempt", "gate:backend", "gate:fuzz", "contract-tests-hard", "contract-tests-brownfield", "gate:hard-reference", "gate:h-freeze"];

test("no npm script invokes the bare tsx CLI", () => {
  // The `tsx` bin is a wrapper that forks a second node process and relays
  // signals over an IPC pipe. A script blocked in spawnSync cannot answer that
  // relay, so the wrapper escalates to SIGKILL ~61ms after Ctrl-C and no
  // handler, `finally` or `exit` listener ever runs. That is not theoretical:
  // on 2026-09-05 it leaked a live OAuth token into /tmp and left the matrix
  // lock behind, silently, with exit code 130.
  //
  // `node --import tsx <script>` is a single process, is what every test in this
  // suite already spawns, and its handlers demonstrably run.
  for (const [name, command] of Object.entries(scripts)) {
    // `--import tsx` is the loader form and is fine; what must not appear is
    // `tsx` in command position, which resolves to the forking bin.
    const withoutLoader = command.replace(/--import\s+tsx\b/g, "");
    assert.ok(
      !/(?:^|&&|;|\|)\s*tsx\s/.test(withoutLoader),
      `script "${name}" runs the tsx CLI wrapper (${command}); use "node --import tsx <script>" instead`,
    );
  }
});

test("the signal-sensitive scripts run in a single node process", () => {
  for (const name of SIGNAL_SENSITIVE) {
    const command = scripts[name];
    assert.ok(command !== undefined, `package.json lost the "${name}" script`);
    assert.match(
      command,
      /^node --import tsx scripts\/[\w-]+\.ts(?: -- .+)?$/,
      `script "${name}" must be invoked as \`node --import tsx …\` so its cleanup handlers can run`,
    );
  }
});

test("the test script drives the same invocation the shipped scripts use", () => {
  // If these ever diverge again, the suite goes back to testing a process tree
  // the operator never runs.
  assert.match(scripts.test, /--import tsx/);
});
