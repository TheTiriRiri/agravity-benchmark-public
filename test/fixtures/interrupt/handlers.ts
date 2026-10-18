/**
 * A stand-in entry script for `test/interrupt.test.ts`: installs the handlers
 * the way `contract-tests` or `serve-attempt` would, prints `ready`, and idles
 * until a signal. Everything it does is appended, one line per event, to
 * `$MARKER_DIR/log`, so the test can see what ran and in which order.
 *
 * The default exit cleanup logs `exit-cleanup code=<process.exitCode>`. Exit
 * cleanups run before the `exit` listener's 128+N override, so the value is the
 * code actually passed to `process.exit` (`undefined` on a natural exit).
 *
 *   node --import tsx test/fixtures/interrupt/handlers.ts <mode>
 *
 * Modes:
 * - `slow-cleanup`: one async cleanup that takes `$CLEANUP_MS` (default 300).
 * - `throwing`: cleanups and exit cleanups that throw, sync and async, each
 *   followed by one that must still run.
 * - `exit-race`: `main` calls `process.exit(1)` while the cleanup is running,
 *   as a `main` would when its backend is removed from under it.
 * - `normal`: no signal expected; exits by itself after a short timer.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { installInterruptHandlers, type InterruptHooks } from "../../../scripts/lib/interrupt";

const markerDir = process.env.MARKER_DIR;
if (markerDir === undefined) throw new Error("MARKER_DIR is not set");
const mark = (event: string): void => appendFileSync(join(markerDir, "log"), `${event}\n`);

const mode = process.argv[2];
const cleanupMs = Number(process.env.CLEANUP_MS ?? "300");

const hooks: InterruptHooks = {
  cleanups: [],
  exitCleanups: [() => mark(`exit-cleanup code=${process.exitCode}`)],
};

switch (mode) {
  case "slow-cleanup":
    hooks.cleanups.push(async () => {
      mark("cleanup-start");
      await sleep(cleanupMs);
      mark("cleanup-done");
    });
    break;
  case "throwing":
    hooks.cleanups.push(
      () => {
        throw new Error("sync cleanup failure");
      },
      async () => {
        await sleep(10);
        throw new Error("async cleanup failure");
      },
      () => mark("cleanup-after-throws"),
    );
    hooks.exitCleanups = [
      () => {
        throw new Error("exit cleanup failure");
      },
      () => mark("exit-cleanup-after-throw"),
    ];
    break;
  case "exit-race":
    hooks.cleanups.push(async () => {
      mark("cleanup-start");
      setTimeout(() => {
        mark("main-exit-1");
        process.exit(1);
      }, 100);
      await sleep(60_000);
      mark("cleanup-done");
    });
    break;
  case "normal":
    hooks.cleanups.push(() => mark("cleanup-start"));
    break;
  default:
    throw new Error(`unknown mode ${JSON.stringify(mode)}`);
}

const handlers = installInterruptHandlers(hooks);
mark("installed");
process.stdout.write("ready\n");

if (mode === "normal") {
  setTimeout(() => mark(`interrupted=${handlers.interrupted()}`), 100);
} else {
  // Idle until a signal; the test kills the group if it never comes.
  setInterval(() => {}, 1_000);
}
