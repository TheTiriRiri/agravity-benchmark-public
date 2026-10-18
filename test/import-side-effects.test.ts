/**
 * Spec §5: libraries install no process handler at import; entry scripts do it
 * from `main` (`installInterruptHandlers`). Each module is imported in a fresh
 * process, and the listener counts before and after must match.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EVENTS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "exit", "uncaughtException", "unhandledRejection"];

const MODULES = [
  ...readdirSync(join(ROOT, "scripts", "lib"))
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => join("scripts", "lib", name)),
  // Entry scripts whose main is guarded: importing them must not run it.
  join("scripts", "run-matrix.ts"),
  join("scripts", "contract-tests.ts"),
  join("scripts", "contract-results.ts"),
  join("scripts", "serve-attempt.ts"),
  join("scripts", "take-screenshots.ts"),
  join("scripts", "process-results.ts"),
  join("scripts", "score-hard.ts"),
  join("scripts", "backend-gate.ts"),
  // scripts/reference-gate.ts is deliberately absent: it has no main guard, runs
  // its main at import, and is a gate-2 input no task in this plan edits.
];

test("importing a library or a guarded entry script installs no process handler", () => {
  const probe = [
    `const events = ${JSON.stringify(EVENTS)};`,
    "const count = () => events.map((e) => process.listenerCount(e)).join(',');",
    "const before = count();",
    "await import(process.env.MODULE_URL);",
    "console.log(before === count() ? 'none' : `before ${before}, after ${count()}`);",
  ].join("\n");
  const found: string[] = [];
  for (const module of MODULES) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", probe], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, MODULE_URL: new URL(module, `file://${ROOT}`).href },
      timeout: 30_000,
    });
    const said = result.status === 0 ? result.stdout.trim() : `exit ${result.status}: ${result.stderr.trim().split("\n").pop()}`;
    if (said !== "none") found.push(`${module}: ${said}`);
  }
  assert.deepEqual(found, []);
});
