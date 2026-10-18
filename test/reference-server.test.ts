import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { GATE_2_INPUTS } from "../scripts/lib/gate-fingerprint";
import { freePort, startReference } from "../scripts/lib/reference-server";

test("freePort returns a port nothing is listening on, twice in a row", async () => {
  const a = await freePort();
  const b = await freePort();
  for (const port of [a, b]) {
    assert.ok(Number.isInteger(port) && port > 1024 && port < 65_536, `${port} is not a usable port`);
  }
});

test("the extracted module installs no process handler at import", () => {
  // test/import-side-effects.test.ts enforces this repo-wide; asserted here
  // too because this module owns a child process and is the obvious place to
  // reach for process.on("exit").
  const source = readFileSync(
    fileURLToPath(new URL("../scripts/lib/reference-server.ts", import.meta.url)),
    "utf8",
  );
  assert.ok(!/^\s*process\.on\(/m.test(source), "handlers belong to the caller, not to the library");
});

test("reference-gate imports the helpers rather than keeping copies", () => {
  const source = readFileSync(fileURLToPath(new URL("../scripts/reference-gate.ts", import.meta.url)), "utf8");
  assert.match(source, /from "\.\/lib\/reference-server"/);
  assert.ok(!/function\s+startBackend/.test(source), "startBackend must live in the library now");
  assert.ok(!/function\s+ensureVenv/.test(source), "ensureVenv must live in the library now");
});

test("gate 2 still vouches for the code that starts the reference", () => {
  // The extraction moved that code out of reference-gate.ts, itself a gate-2
  // input. Without this entry gate 2 would stop covering the venv, the
  // REFERENCE_MUTANT and REFERENCE_SEED_PATH environment and the health poll —
  // the extraction would have quietly shrunk what gate 2 proves.
  assert.ok(GATE_2_INPUTS.includes(join("scripts", "lib", "reference-server.ts")));
});

// ---------------------------------------------------------------------------
// What the plan asks the extraction to preserve, checked without Python: a fake
// `uvicorn` (a node script in a scratch venv) stands where the real one does.

const scratch: string[] = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const FAKE_UVICORN = `#!/usr/bin/env node
const http = require("node:http");
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
if (process.env.FAKE_PIDFILE) writeFileSync(process.env.FAKE_PIDFILE, String(process.pid));
if (process.env.FAKE_MODE === "exit") process.exit(3);
if (process.env.FAKE_MODE === "silent") {
  setInterval(() => {}, 1000);
} else {
  http
    .createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/v1/health") return response.end('{"status":"ok"}');
      response.end(
        JSON.stringify({
          mutant: process.env.REFERENCE_MUTANT,
          seed: process.env.REFERENCE_SEED_PATH,
          bytecode: process.env.PYTHONDONTWRITEBYTECODE,
          cwd: process.cwd(),
          args,
        }),
      );
    })
    .listen(port, "127.0.0.1");
}
`;

function fakeReference(): { venvDir: string; backendDir: string; dir: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "reference-server-")));
  scratch.push(dir);
  const venvDir = join(dir, "venv");
  const backendDir = join(dir, "backend");
  mkdirSync(join(venvDir, "bin"), { recursive: true });
  mkdirSync(backendDir);
  writeFileSync(join(venvDir, "bin", "uvicorn"), FAKE_UVICORN);
  chmodSync(join(venvDir, "bin", "uvicorn"), 0o755);
  return { venvDir, backendDir, dir };
}

async function withEnv<T>(env: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    return await body();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function eventually(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`${what} did not happen within 5 s`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("the backend is started in its own directory with the mutant, the seed and no bytecode cache", async () => {
  const { venvDir, backendDir } = fakeReference();
  const { baseUrl, stop } = await startReference({ mutant: "cap_off", venvDir, backendDir, seedPath: "/seed/seed.json" });
  try {
    const seen = (await (await fetch(`${baseUrl}/echo`)).json()) as {
      mutant: string; seed: string; bytecode: string; cwd: string; args: string[];
    };
    assert.equal(seen.mutant, "cap_off");
    assert.equal(seen.seed, "/seed/seed.json");
    // Without it the reference leaves __pycache__ inside a gate-2 input.
    assert.equal(seen.bytecode, "1");
    assert.equal(realpathSync(seen.cwd), backendDir);
    assert.deepEqual(seen.args.slice(0, 5), ["app.main:app", "--host", "127.0.0.1", "--port", baseUrl.split(":").pop()]);
  } finally {
    stop();
  }
});

test("the reference itself is the empty mutant, set rather than absent", async () => {
  const { venvDir, backendDir } = fakeReference();
  const { baseUrl, stop } = await startReference({ mutant: "", venvDir, backendDir, seedPath: "/seed/seed.json" });
  try {
    const seen = (await (await fetch(`${baseUrl}/echo`)).json()) as { mutant: string | undefined };
    assert.equal(seen.mutant, "");
  } finally {
    stop();
  }
});

test("stop ends the backend", async () => {
  const { venvDir, backendDir } = fakeReference();
  const { baseUrl, stop } = await startReference({ mutant: "", venvDir, backendDir, seedPath: "/seed/seed.json" });
  stop();
  let answered = true;
  for (let i = 0; i < 100 && answered; i += 1) {
    answered = await fetch(`${baseUrl}/api/v1/health`, { signal: AbortSignal.timeout(500) }).then(() => true, () => false);
    if (answered) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(answered, false, "the backend still answers after stop()");
  stop(); // a second stop is harmless
});

test("a backend that dies at import is a clear error, not a 30 s timeout", async () => {
  const { venvDir, backendDir } = fakeReference();
  const started = Date.now();
  await withEnv({ FAKE_MODE: "exit" }, () =>
    assert.rejects(
      startReference({ mutant: "cap_off", venvDir, backendDir, seedPath: "/seed/seed.json" }),
      /the reference backend exited 3 \(mutant: cap_off\)/,
    ),
  );
  assert.ok(Date.now() - started < 10_000, "it waited for the health timeout instead of noticing the exit");
});

test("a start that fails kills its own child and hands the stop handle over before it does", async () => {
  // The caller never receives a handle from a promise that rejects, so the
  // library has to clean up itself; and a signal that arrives during the poll
  // has to find something to kill, which is what onSpawn is for.
  const { venvDir, backendDir, dir } = fakeReference();
  const pidFile = join(dir, "pid");
  let handedOver = false;
  await withEnv({ FAKE_MODE: "silent", FAKE_PIDFILE: pidFile }, () =>
    assert.rejects(
      startReference({
        mutant: "",
        venvDir,
        backendDir,
        seedPath: "/seed/seed.json",
        healthTimeoutMs: 600,
        onSpawn: () => {
          handedOver = true;
        },
      }),
      /never answered \/health/,
    ),
  );
  assert.ok(handedOver, "onSpawn was not called");
  const pid = Number(readFileSync(pidFile, "utf8"));
  await eventually(() => !alive(pid), "the child of a failed start to die");
});
