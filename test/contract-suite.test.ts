import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/contract-suite/${name}`, import.meta.url));
const SEED = fileURLToPath(new URL("../benchmark/context/seed.json", import.meta.url));
const WATCHED = ["CONTRACT_BASE_URL", "CONTRACT_SEED_PATH", "NODE_OPTIONS"] as const;

interface Driven {
  status: number | null;
  stderr: string;
  /** The driver's JSON line: `result` or `error`, plus the env around the call. */
  out: any;
}

/**
 * node:test refuses to nest: `run()` called inside a test process is a no-op.
 * So the function under test runs in a child whose environment has forgotten
 * it descends from a test runner. Async, so a server in this process can
 * answer (or refuse to answer) the fixture while it runs.
 */
function drive(
  file: string,
  timeoutMs: number,
  expectedTests: number,
  options: { baseUrl?: string; seedPath?: string; env?: Partial<Record<(typeof WATCHED)[number], string>> } = {},
): Promise<Driven> {
  const { NODE_TEST_CONTEXT: _dropped, ...env } = process.env;
  for (const key of WATCHED) delete env[key];
  Object.assign(env, options.env);
  const args = [fixture("driver.ts"), fixture(file), String(timeoutMs), String(expectedTests)];
  if (options.baseUrl !== undefined) args.push(options.baseUrl, options.seedPath ?? "unused");
  const child = spawn(process.execPath, ["--import", "tsx", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status) => {
      const line = stdout.trim().split("\n").at(-1) ?? "";
      try {
        resolve({ status, stderr, out: JSON.parse(line) });
      } catch {
        reject(new Error(`the driver printed no JSON (exit ${status}):\n${stdout}\n${stderr}`));
      }
    });
  });
}

function listen(onConnection: (socket: Socket) => void): Promise<Server> {
  const server = createServer(onConnection);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const portOf = (server: Server) => (server.address() as { port: number }).port;

test("counts leaf tests and names each failure with its type and message", async () => {
  const { status, out } = await drive("mixed.fixture.ts", 60_000, 3);
  assert.equal(status, 0);
  const { result } = out;
  assert.equal(result.total, 3);
  assert.equal(result.passed, 2);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].name, "fails in the middle");
  assert.equal(result.failed[0].failureType, "testCodeFailure");
  assert.match(result.failed[0].message, /^Expected values to be strictly equal/);
  assert.equal(result.notRun, 0);
  assert.equal(result.hookFailed, 0);
  assert.equal(result.timedOut, false);
});

test("a file that hangs scores out of the manifest's count, not out of what happened to run", async () => {
  const { status, out } = await drive("hang.fixture.ts", 3_000, 3);
  assert.equal(status, 0);
  const { result } = out;
  assert.equal(result.timedOut, true);
  assert.equal(result.total, 3);
  // The in-flight test never reports; the one before it does unless start-up ate the budget.
  assert.ok(result.passed <= 1);
  assert.deepEqual(result.failed, []);
  assert.equal(result.notRun, 3 - result.passed);
  assert.equal(result.passed + result.failed.length + result.notRun, result.total);
});

test("a failing beforeEach is counted as hookFailed, with the cause's message, not node's constant", async () => {
  const { status, out } = await drive("hook-fails.fixture.ts", 60_000, 3);
  assert.equal(status, 0);
  const { result } = out;
  assert.equal(result.total, 3);
  assert.equal(result.passed, 1);
  assert.equal(result.hookFailed, 1);
  assert.equal(result.notRun, 0);
  const byName = Object.fromEntries(result.failed.map((failure: { name: string }) => [failure.name, failure]));
  assert.deepEqual(Object.keys(byName).sort(), ["fails in its own body", "hook fails before this one"]);
  assert.equal(byName["hook fails before this one"].failureType, "hookFailed");
  assert.match(byName["hook fails before this one"].message, /^POST \/reset must answer 200/);
  assert.doesNotMatch(byName["hook fails before this one"].message, /failed running beforeEach hook/);
  assert.equal(byName["fails in its own body"].failureType, "testCodeFailure");
  assert.match(byName["fails in its own body"].message, /^body failure/);
});

test("a beforeEach that times out on a server that never answers still carries a message", async () => {
  const held: Socket[] = [];
  const server = await listen((socket) => {
    socket.on("error", () => {});
    held.push(socket);
  });
  try {
    const { status, out } = await drive("hook-times-out.fixture.ts", 60_000, 2, { baseUrl: `http://127.0.0.1:${portOf(server)}` });
    assert.equal(status, 0);
    const { result } = out;
    assert.ok(held.length >= 1, "the fixture reached the server");
    assert.equal(result.passed, 0);
    assert.equal(result.hookFailed, 2);
    for (const failure of result.failed) {
      assert.equal(failure.failureType, "hookFailed");
      assert.notEqual(failure.message.trim(), "");
      assert.match(failure.message, /aborted due to timeout/);
    }
  } finally {
    for (const socket of held) socket.destroy();
    server.close();
  }
});

test("the hidden tests' call() names the endpoint when the connection fails", async () => {
  // A listener that drops every connection at once: a transport error every
  // time, where a closed port could be taken by another process in between.
  let accepted = 0;
  const server = await listen((socket) => {
    accepted += 1;
    socket.destroy();
  });
  try {
    const { status, out } = await drive("api-dropped.fixture.ts", 60_000, 1, { baseUrl: `http://127.0.0.1:${portOf(server)}`, seedPath: SEED });
    assert.equal(status, 0);
    assert.ok(accepted >= 1, "the fixture reached the server");
    const [failure] = out.result.failed;
    assert.equal(failure.failureType, "hookFailed");
    assert.equal(failure.message, "POST /reset: TypeError fetch failed");
  } finally {
    server.close();
  }
});

test("a throw at module level is a harness error with the file's stderr, not the model's failed tests", async () => {
  const { status, out } = await drive("module-throw.fixture.ts", 60_000, 4);
  assert.equal(status, 1);
  assert.equal(out.result, undefined);
  assert.equal(out.error.harness, true);
  assert.equal(out.error.name, "ContractHarnessError");
  assert.equal(out.error.file, fixture("module-throw.fixture.ts"));
  assert.match(out.error.message, /the test file itself failed \(testCodeFailure, exit code 1\)/);
  assert.match(out.error.stderrTail, /fixture: thrown at module level/);
  assert.match(out.error.message, /fixture: thrown at module level/);
  assert.equal(out.envUnchanged, true, "the environment is restored when the call throws too");
});

test("a failed import is a harness error too", async () => {
  const { status, out } = await drive("bad-import.fixture.ts", 60_000, 1);
  assert.equal(status, 1);
  assert.equal(out.error.harness, true);
  assert.match(out.error.message, /the test file itself failed \(testCodeFailure, exit code 1\)/);
  assert.match(out.error.stderrTail, /no-such-module/);
});

test("tests that vanish without a timeout are a harness error, not tests the model failed", async () => {
  const { status, out } = await drive("exits-early.fixture.ts", 60_000, 3);
  assert.equal(status, 1);
  assert.equal(out.error.harness, true);
  assert.match(out.error.message, /never reported and the file did not time out/);
});

test("a skipped hidden test is a harness error, never a pass", async () => {
  const { status, out } = await drive("skip.fixture.ts", 60_000, 2);
  assert.equal(status, 1);
  assert.equal(out.error.harness, true);
  assert.match(out.error.message, /"skipped" is marked skip or todo/);
});

test("more tests than the manifest promises is a harness error, not a silent re-weighting", async () => {
  const { status, stderr, out } = await drive("mixed.fixture.ts", 60_000, 2);
  assert.equal(status, 1);
  assert.equal(out.error.harness, true);
  assert.match(stderr, /update the manifest/);
});

test("the environment is restored after the call: unset variables are unset again", async () => {
  const { out } = await drive("mixed.fixture.ts", 60_000, 3);
  assert.deepEqual(out.envBefore, { CONTRACT_BASE_URL: null, CONTRACT_SEED_PATH: null, NODE_OPTIONS: null });
  assert.deepEqual(out.envAfter, out.envBefore);
  assert.equal(out.envUnchanged, true);
});

test("the environment is restored after the call: set variables get their old values back", async () => {
  const env = { CONTRACT_BASE_URL: "http://preset.invalid", CONTRACT_SEED_PATH: "/preset/seed.json", NODE_OPTIONS: "--no-deprecation" };
  const held: Socket[] = [];
  const server = await listen((socket) => {
    socket.on("error", () => {});
    held.push(socket);
  });
  try {
    const { status, out } = await drive("hook-times-out.fixture.ts", 60_000, 2, { baseUrl: `http://127.0.0.1:${portOf(server)}`, env });
    assert.equal(status, 0);
    assert.ok(held.length >= 1, "the child used the call's base URL, not the caller's");
    assert.deepEqual(out.envBefore, env);
    assert.deepEqual(out.envAfter, env);
    assert.equal(out.envUnchanged, true);
  } finally {
    for (const socket of held) socket.destroy();
    server.close();
  }
});
