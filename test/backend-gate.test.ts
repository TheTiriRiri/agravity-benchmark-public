/**
 * Gate 3a's script, without Docker, Python or the network: its argument
 * parsing, the staging of synthetic attempts (the `__init__.py` it writes into
 * a copy of the reference, never into the fixture), the PNG size reader, the
 * ownership walk, and the shape of the fixtures the live gate runs. The gate
 * itself runs only as `npm run gate:backend`; `test/gate-result.test.ts`
 * checks its record against the files.
 *
 * The frontend fixture's server is started here on an ephemeral loopback
 * port, never on 5173, and its `/api` proxy — which would reach 5100 — is
 * never asked. The names the gate reads back from a sweep line are made by a
 * real `AttemptBackend`, through the stateful fake docker.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import type { CliRun } from "../scripts/backend-gate";
import { AttemptBackend, FREEZE_TIMEOUT_MS, VENV_TIMEOUT_MS } from "../scripts/lib/attempt-backend";
import { ATTEMPT_DIR_RE, parseAttemptDirName } from "../scripts/lib/attempts";
import { loadManifest } from "../scripts/lib/contract-results";
import { KILL_WAIT_MS, parseLocalBanner } from "../scripts/lib/dev-server";
import { DOCKER_CLI_TIMEOUT_MS, scratchDirPrefix } from "../scripts/lib/docker";
import { HARD_LIMITS } from "../scripts/lib/hard-contract-results";
import { HIDDEN_ROWS, LIMITS, roundScore } from "../scripts/lib/rubric";
import { loadRunnerConfig } from "../scripts/lib/runner-config";
import { STOP_WAIT_MS } from "../scripts/serve-attempt";
import { useFakeDockerBackend } from "./fixtures/fake-docker-backend-hooks";

const WATCHED = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "exit"] as const;
const listenerCounts = (): number[] => WATCHED.map((event) => process.listenerCount(event));
const LISTENERS_BEFORE = listenerCounts();
const gate = await import("../scripts/backend-gate");
const LISTENERS_AFTER = listenerCounts();

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURES = join(ROOT, "test", "fixtures", "backend-gate");
const REFERENCE = join(ROOT, "test", "fixtures", "reference-backend");
const SEED = join(ROOT, "benchmark", "context", "seed.json");

const scratch: string[] = [];
const children = new Set<ChildProcess>();
after(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "backend-gate-test-"));
  scratch.push(dir);
  return dir;
}

/** Every file under `dir`, relative, sorted. */
function filesUnder(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory() ? filesUnder(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`],
    )
    .sort();
}

test("importing backend-gate installs no signal or exit handler", () => {
  assert.deepEqual(LISTENERS_AFTER, LISTENERS_BEFORE);
});

// --- arguments ---------------------------------------------------------------

test("parseArgs: no argument runs every part, in order, and records", () => {
  assert.deepEqual(gate.parseArgs([]), { only: [], help: false });
  assert.deepEqual(gate.selectedParts([]), ["image", "contract", "stops", "serve", "screenshots", "fuzz"]);
  assert.deepEqual([...gate.PARTS], ["image", "contract", "stops", "serve", "screenshots", "fuzz"]);
});

test("parseArgs: --only is repeatable, takes both forms, de-duplicates, and keeps the parts' order", () => {
  const args = gate.parseArgs(["--only", "stops", "--only=image", "--only", "stops"]);
  assert.deepEqual(args, { only: ["image", "stops"], help: false });
  assert.deepEqual(gate.selectedParts(args.only), ["image", "stops"]);
  assert.deepEqual(gate.parseArgs(["--only", "screenshots", "--only", "serve"]).only, ["serve", "screenshots"]);
});

test("parseArgs: refuses an unknown part, a missing value, a stray argument, and a valued --help", () => {
  assert.throws(() => gate.parseArgs(["--only", "nope"]), (error: Error) => error instanceof gate.UsageError && /image, contract, stops, serve, screenshots/.test(error.message));
  assert.throws(() => gate.parseArgs(["--only"]), gate.UsageError);
  assert.throws(() => gate.parseArgs(["--only="]), gate.UsageError);
  assert.throws(() => gate.parseArgs(["--only", "--help"]), gate.UsageError);
  assert.throws(() => gate.parseArgs(["image"]), gate.UsageError);
  assert.throws(() => gate.parseArgs(["--root", "/tmp"]), gate.UsageError);
  assert.throws(() => gate.parseArgs(["--help=1"]), gate.UsageError);
  assert.deepEqual(gate.parseArgs(["--help"]), { only: [], help: true });
  assert.deepEqual(gate.parseArgs(["-h"]), { only: [], help: true });
});

// --- the agy pin ---------------------------------------------------------------

test("pinnedAgyVersion: reads the Dockerfile's pin, which is runner.yaml's agyVersion", () => {
  const pinned = gate.pinnedAgyVersion(ROOT);
  assert.match(pinned, /^\d+\.\d+\.\d+$/);
  // An image bump that moves one and not the other turns this red.
  const config = loadRunnerConfig(join(ROOT, "benchmark", "runner.yaml"), { allowPlaceholders: true });
  assert.equal(pinned, config.agyVersion, "images/harness/Dockerfile and benchmark/runner.yaml pin different agy versions");
});

test("pinnedAgyVersion: refuses a Dockerfile with no pin, or with two", () => {
  const dockerfile = (lines: string[]): string => {
    const root = tempDir();
    mkdirSync(join(root, "images", "harness"), { recursive: true });
    writeFileSync(join(root, "images", "harness", "Dockerfile"), ["FROM debian:bookworm-slim", ...lines, ""].join("\n"));
    return root;
  };
  assert.equal(gate.pinnedAgyVersion(dockerfile(["ARG AGY_BUILD=1", "ARG AGY_VERSION=9.8.7"])), "9.8.7");
  assert.throws(() => gate.pinnedAgyVersion(dockerfile(["ARG AGY_BUILD=1"])), /no `ARG AGY_VERSION=/);
  assert.throws(() => gate.pinnedAgyVersion(dockerfile(["ARG AGY_VERSION=", "ARG AGY_BUILD=1"])), /no `ARG AGY_VERSION=/);
  assert.throws(() => gate.pinnedAgyVersion(dockerfile(["ARG AGY_VERSION=1.2.7", "ARG AGY_VERSION=1.2.8"])), /2 `ARG AGY_VERSION=/);
  assert.throws(() => gate.pinnedAgyVersion(tempDir()), /ENOENT/);
});

// --- the staged __init__.py ----------------------------------------------------

const SEED_LINE =
  'os.environ["REFERENCE_SEED_PATH"] = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "seed.json")';

test("initPyText: the reference sets only the seed path, resolved from __file__ to backend/seed.json", () => {
  const text = gate.initPyText(null);
  const code = text.split('"""')[2].trim().split("\n");
  assert.deepEqual(code, ["import os", "", SEED_LINE]);
  assert.ok(!text.includes("REFERENCE_MUTANT"), "the reference must not set a mutant");
  assert.ok(text.endsWith("\n"));
  // What the expression resolves to where the backend runner mounts the attempt.
  const file = "/workspace/backend/app/__init__.py";
  assert.equal(posix.join(posix.dirname(posix.dirname(file)), "seed.json"), "/workspace/backend/seed.json");
});

test("initPyText: the mutant sets REFERENCE_MUTANT too, after the seed path", () => {
  const code = gate.initPyText("hardcoded_plan").split('"""')[2].trim().split("\n");
  assert.deepEqual(code, ["import os", "", SEED_LINE, 'os.environ["REFERENCE_MUTANT"] = "hardcoded_plan"']);
});

test("initPyText: refuses anything but a plain mutant name, so nothing can escape the Python string", () => {
  for (const bad of ['x"; import os; "', "Hardcoded", "hard-coded", "", "_x", "a b"]) {
    assert.throws(() => gate.initPyText(bad), /not a mutant name/, JSON.stringify(bad));
  }
});

// --- staging -------------------------------------------------------------------

test("stageReference: app/ and requirements.txt copied, seed.json beside them, only __init__.py replaced", () => {
  const attempt = join(tempDir(), "gate-reference-attempt-1");
  gate.stageReference(ROOT, attempt, null);
  const backend = join(attempt, "backend");
  const fixtureApp = filesUnder(join(REFERENCE, "app")).filter((file) => !file.startsWith("__pycache__/"));
  assert.deepEqual(filesUnder(join(backend, "app")), fixtureApp);
  for (const file of fixtureApp) {
    const staged = readFileSync(join(backend, "app", file), "utf8");
    if (file === "__init__.py") assert.equal(staged, gate.initPyText(null));
    else assert.equal(staged, readFileSync(join(REFERENCE, "app", file), "utf8"), file);
  }
  assert.equal(readFileSync(join(backend, "requirements.txt"), "utf8"), readFileSync(join(REFERENCE, "requirements.txt"), "utf8"));
  assert.equal(readFileSync(join(backend, "seed.json"), "utf8"), readFileSync(SEED, "utf8"));
  assert.deepEqual(filesUnder(attempt).filter((file) => !file.startsWith("backend/app/")), ["backend/requirements.txt", "backend/seed.json"]);
  // The fixture is a gate-2 input and is never edited.
  assert.equal(statSync(join(REFERENCE, "app", "__init__.py")).size, 0);
});

test("stageReference: the mutant's copy names it; an unknown mutant is refused before anything is written", () => {
  const attempt = join(tempDir(), "gate-hardcoded-plan-attempt-1");
  gate.stageReference(ROOT, attempt, gate.MUTANT);
  assert.equal(readFileSync(join(attempt, "backend", "app", "__init__.py"), "utf8"), gate.initPyText("hardcoded_plan"));
  const other = join(tempDir(), "gate-x-attempt-1");
  assert.throws(() => gate.stageReference(ROOT, other, "no_such_mutant"), /no_such_mutant is not a mutant in .*mutants\.json/);
  assert.ok(!existsSync(other));
});

test("stageReference: leaves out a __pycache__ a local run of the fixture could have left", () => {
  const fakeRepo = tempDir();
  const app = join(fakeRepo, "test", "fixtures", "reference-backend", "app");
  mkdirSync(join(app, "__pycache__"), { recursive: true });
  writeFileSync(join(app, "__init__.py"), "");
  writeFileSync(join(app, "main.py"), "app = None\n");
  writeFileSync(join(app, "__pycache__", "main.cpython-311.pyc"), "bytecode");
  writeFileSync(join(fakeRepo, "test", "fixtures", "reference-backend", "requirements.txt"), "fastapi==0.115.14\n");
  mkdirSync(join(fakeRepo, "benchmark", "context"), { recursive: true });
  writeFileSync(join(fakeRepo, "benchmark", "context", "seed.json"), "{}\n");
  const attempt = join(tempDir(), "gate-reference-attempt-1");
  gate.stageReference(fakeRepo, attempt, null);
  assert.deepEqual(filesUnder(attempt), ["backend/app/__init__.py", "backend/app/main.py", "backend/requirements.txt", "backend/seed.json"]);
});

test("stageFixture and stageServeAttempt: each case's tree, and the frontend beside the reference", () => {
  for (const stop of gate.STOP_CASES) {
    const attempt = join(tempDir(), stop.attempt);
    gate.stageFixture(ROOT, stop.fixture, attempt);
    assert.deepEqual(filesUnder(attempt), filesUnder(join(FIXTURES, stop.fixture)), stop.fixture);
    assert.ok(existsSync(join(attempt, "backend", "requirements.txt")), `${stop.fixture}: requirements.txt, so the layout check reaches main.py`);
    assert.equal(existsSync(join(attempt, "backend", "app", "main.py")), stop.stage !== "layout", stop.fixture);
  }
  const serve = join(tempDir(), gate.SERVE_ATTEMPT);
  gate.stageServeAttempt(ROOT, serve);
  assert.equal(readFileSync(join(serve, "backend", "app", "__init__.py"), "utf8"), gate.initPyText(null));
  assert.deepEqual(filesUnder(join(serve, "frontend")), filesUnder(join(FIXTURES, "frontend")));
  assert.throws(() => gate.stageFixture(ROOT, "../reference-backend", join(tempDir(), "x")), /not a fixture name/);
});

// --- the PNG reader ------------------------------------------------------------

/** A PNG's first 33 bytes: signature, then an IHDR chunk (the CRC is not checked, so zeros). */
function pngHeader(width: number, height: number, type = "IHDR", length = 13): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(length, 8);
  buf.write(type, 12, "latin1");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf.writeUInt8(8, 24); // bit depth
  buf.writeUInt8(6, 25); // RGBA
  return buf;
}

test("pngDimensions: reads width and height from the IHDR chunk", () => {
  assert.deepEqual(gate.pngDimensions(pngHeader(1280, 720)), { width: 1280, height: 720 });
  assert.deepEqual(gate.pngDimensions(Buffer.concat([pngHeader(640, 360), Buffer.alloc(100)])), { width: 640, height: 360 });
  // A view into a larger buffer is read at its own offset.
  const outer = Buffer.concat([Buffer.alloc(7, 0xff), pngHeader(1280, 720)]);
  assert.deepEqual(gate.pngDimensions(outer.subarray(7)), { width: 1280, height: 720 });
});

test("pngDimensions: refuses a wrong signature, a short file, a first chunk that is not a 13-byte IHDR, a zero size", () => {
  const wrong = pngHeader(1280, 720);
  wrong[1] = 0x51;
  assert.throws(() => gate.pngDimensions(wrong), /signature/);
  assert.throws(() => gate.pngDimensions(pngHeader(1280, 720).subarray(0, 32)), /too short/);
  assert.throws(() => gate.pngDimensions(Buffer.alloc(0)), /too short/);
  assert.throws(() => gate.pngDimensions(pngHeader(1280, 720, "IDAT")), /not a 13-byte IHDR/);
  assert.throws(() => gate.pngDimensions(pngHeader(1280, 720, "IHDR", 14)), /not a 13-byte IHDR/);
  assert.throws(() => gate.pngDimensions(pngHeader(0, 720)), /0x720/);
  assert.throws(() => gate.pngDimensions(Buffer.from("<html>an error page, not a picture</html>".padEnd(64))), /signature/);
});

// --- the ownership walk ----------------------------------------------------------

test("walkOwnership: visits every path by lstat, the root included, and never follows a symlink", () => {
  const root = tempDir();
  mkdirSync(join(root, "venv", "lib"), { recursive: true });
  writeFileSync(join(root, "venv", "lib", "six.py"), "");
  writeFileSync(join(root, "a.txt"), "");
  // A link to a root-owned directory: judged as the link (ours), not as its target.
  symlinkSync("/", join(root, "venv", "root-link"));
  symlinkSync(join(root, "missing"), join(root, "dangling"));
  const uid = process.getuid?.() ?? 0;
  const walk = gate.walkOwnership(root, uid);
  assert.equal(walk.entries, 7); // root, venv, venv/lib, six.py, root-link, a.txt, dangling
  assert.deepEqual(walk.foreign, []);
  const other = gate.walkOwnership(root, uid + 1);
  assert.equal(other.foreign.length, 7);
  assert.equal(other.foreign[0], root);
});

// --- --rows -----------------------------------------------------------------------

test("parseRows: reads the quoted Notes back whole, commas and doubled quotes included", () => {
  const stdout = 'API contract,2,2,"24/24 passed"\nPlanner: parts & blocking,0.36,2,"2/11 passed; failed: a, b | say ""hi"""\n';
  assert.deepEqual(gate.parseRows(stdout), [
    ["API contract", "2", "2", "24/24 passed"],
    ["Planner: parts & blocking", "0.36", "2", '2/11 passed; failed: a, b | say "hi"'],
  ]);
});

// --- leftovers: the gate's containers, and what a child's sweep removed ------------------

test("parseOwnedContainers: keeps only the owners asked for, and never an owner label that is not a pid", () => {
  const stdout = [
    "agrav-backend-gate-reference-attempt-1-4242-1\t4242\tgate-reference-attempt-1",
    "agrav-gate-image-100-3\t100\t",
    "someone-elses-backend\t999\tother-attempt-1",
    "no-owner-label\t\t",
    "odd-owner\t4242x\tgate-reference-attempt-1",
    "leading-zero\t0100\t",
    "",
  ].join("\n");
  assert.deepEqual(gate.parseOwnedContainers(stdout, new Set([100, 4242])), [
    { name: "agrav-backend-gate-reference-attempt-1-4242-1", owner: 4242, attempt: "gate-reference-attempt-1" },
    { name: "agrav-gate-image-100-3", owner: 100, attempt: "" },
  ]);
  assert.deepEqual(gate.parseOwnedContainers(stdout, new Set([7])), []);
  assert.deepEqual(gate.parseOwnedContainers("", new Set([100])), []);
  // The docker format it parses: name, owner, attempt, tab-separated.
  assert.equal(gate.OWNED_CONTAINERS_FORMAT, '{{.Names}}\t{{.Label "agrav.owner"}}\t{{.Label "agrav.attempt"}}');
});

test("sweptThing: reads the owner from a swept container's name or a swept scratch directory's", () => {
  const dir = join(tmpdir(), `${scratchDirPrefix(4242)}AbC123`);
  // serve-attempt's lines, then take-screenshots' (capitalised, with a full stop).
  assert.deepEqual(gate.sweptThing("removed agrav-backend-gate-reference-attempt-1-4242-2, a backend container whose owner is gone"), {
    kind: "container",
    name: "agrav-backend-gate-reference-attempt-1-4242-2",
    owner: 4242,
  });
  assert.deepEqual(gate.sweptThing(`removed ${dir}, a scratch directory whose owner is gone`), { kind: "scratch directory", name: dir, owner: 4242 });
  assert.deepEqual(gate.sweptThing("Removed agrav-gate-image-100-3, a backend container whose owner is gone."), {
    kind: "container",
    name: "agrav-gate-image-100-3",
    owner: 100,
  });
  assert.deepEqual(gate.sweptThing(`Removed ${dir}, a scratch directory whose owner is gone.`), { kind: "scratch directory", name: dir, owner: 4242 });
  for (const other of [
    "removed agrav-backend-gate-serve-attempt-1-4242-1", // --stop's own clean-up of a recorded container, not a sweep
    `removed ${dir}`,
    "warning: dead-owner sweep: container x: …",
    "removed no-pid-here, a backend container whose owner is gone",
    `removed ${join(tmpdir(), "agrav-gate-3a-AbC123")}, a scratch directory whose owner is gone`,
    "stopped pid 4242",
  ]) {
    assert.equal(gate.sweptThing(other), null, other);
  }
});

// The fake first on PATH for the one case below that makes real names; once
// the suite is over, a `docker` that refuses everything (see the hooks module).
const hooks = useFakeDockerBackend();

test("sweptThing reads the owner back from the names AttemptBackend really gives its containers", { timeout: 30_000 }, async () => {
  // The gate counts a child's sweep line as a leak it repaired only when it can
  // read an owner out of the name: a change to the names that sweptThing did
  // not follow would let every such leak pass unreported.
  const root = hooks.newRoot("backend-gate-names-");
  const stateDir = join(root, "state");
  const tmpRoot = join(root, "tmp");
  const attemptDir = join(root, "eval-attempts", gate.REFERENCE_ATTEMPT);
  mkdirSync(stateDir);
  mkdirSync(tmpRoot);
  mkdirSync(join(attemptDir, "backend", "app"), { recursive: true });
  writeFileSync(join(attemptDir, "backend", "requirements.txt"), "fastapi==0.115.14\nuvicorn==0.30.6\n");
  writeFileSync(join(attemptDir, "backend", "app", "main.py"), "app = None\n");
  process.env.FAKE_DOCKER_STATE = stateDir;
  const names: string[] = [];
  const backend = new AttemptBackend({
    attemptDir,
    attemptName: gate.REFERENCE_ATTEMPT,
    image: `sha256:${"f".repeat(64)}`,
    hostPort: "ephemeral",
    tmpRoot,
    onContainer: (name) => names.push(name),
  });
  try {
    assert.deepEqual(await backend.install(), { kind: "ok" });
    const started = await backend.start();
    assert.equal(started.kind, "ready", JSON.stringify(started));
  } finally {
    await backend.dispose();
  }
  assert.equal(names.length, 3, `venv, install, serve: ${names.join(", ")}`);
  for (const name of names) {
    // serve-attempt's line, then take-screenshots'.
    for (const line of [`removed ${name}, a backend container whose owner is gone`, `Removed ${name}, a backend container whose owner is gone.`]) {
      assert.deepEqual(gate.sweptThing(line), { kind: "container", name, owner: process.pid }, line);
    }
  }
});

test("the sweep lines sweptThing reads are the ones serve-attempt and take-screenshots print", () => {
  const serve = readFileSync(join(ROOT, "scripts", "serve-attempt.ts"), "utf8");
  const shots = readFileSync(join(ROOT, "scripts", "take-screenshots.ts"), "utf8");
  for (const [source, template] of [
    [serve, "`removed ${name}, a backend container whose owner is gone`"],
    [serve, "`removed ${dir}, a scratch directory whose owner is gone`"],
    [shots, "`Removed ${name}, a backend container whose owner is gone.`"],
    [shots, "`Removed ${dir}, a scratch directory whose owner is gone.`"],
  ]) {
    assert.ok(source.includes(template), `${template} is no longer printed; update SWEEP_LINE_RE in scripts/backend-gate.ts`);
  }
  // And the line --stop prints when the owner tore itself down, which the serve part looks for.
  assert.ok(serve.includes("d.out(`stopped pid ${state.pid}`)"), "serve-attempt --stop's \"stopped pid <pid>\" line changed");
});

// --- the leak check's verdict --------------------------------------------------------

const NOTHING_LEFT_2 = "nothing left by the gate or the 2 child processes it has started: no container, no scratch directory, nothing swept";

/** A container, a scratch directory and a swept container, as leakCheck describes them. */
const LEFT_CONTAINER = { key: gate.leftoverKey("container", "agrav-backend-gate-serve-attempt-1-4242-1"), what: "container agrav-backend-gate-serve-attempt-1-4242-1 of serve-attempt (pid 4242)" };
const LEFT_DIR = {
  key: gate.leftoverKey("scratch directory", `${scratchDirPrefix(4343)}AbC123`),
  what: `scratch directory ${join(tmpdir(), `${scratchDirPrefix(4343)}AbC123`)} of contract-tests (pid 4343)`,
};
const SWEPT_DIR = {
  key: gate.leftoverKey("scratch directory", join(tmpdir(), `${scratchDirPrefix(4343)}AbC123`)),
  what: `scratch directory ${join(tmpdir(), `${scratchDirPrefix(4343)}AbC123`)} of contract-tests (pid 4343), removed by serve-attempt's dead-owner sweep`,
};

test("leakVerdict: ok only when both listings answered and nothing at all was listed or swept", () => {
  assert.deepEqual(gate.leakVerdict({ children: 2, containers: [], dirs: [], swept: [], reported: new Set() }), {
    fail: null,
    alreadyReported: null,
    ok: NOTHING_LEFT_2,
    newlyReported: [],
  });
  assert.equal(
    gate.leakVerdict({ children: 1, containers: [], dirs: [], swept: [], reported: new Set() }).ok,
    "nothing left by the gate or the 1 child process it has started: no container, no scratch directory, nothing swept",
  );
  // A listing that failed is a FAIL of its own (leakCheck's), and proves nothing either way.
  for (const [containers, dirs] of [
    [null, []],
    [[], null],
    [null, null],
  ] as const) {
    assert.deepEqual(gate.leakVerdict({ children: 2, containers, dirs, swept: [], reported: new Set() }), {
      fail: null,
      alreadyReported: null,
      ok: null,
      newlyReported: [],
    });
  }
});

test("leakVerdict: a leftover the part already reported is named as such — never 'nothing left' — and not counted again", () => {
  // The serve part's own check FAILed on its container and added it to g.reported:
  // the leakCheck right after it must not call the same container absent.
  const reported = new Set([LEFT_CONTAINER.key]);
  assert.deepEqual(gate.leakVerdict({ children: 2, containers: [LEFT_CONTAINER], dirs: [], swept: [], reported }), {
    fail: null,
    alreadyReported: `already reported: ${LEFT_CONTAINER.what}`,
    ok: null,
    newlyReported: [],
  });
  // The same for a scratch directory kept for inspection, and for one a later sweep removed.
  const dirReported = new Set([LEFT_DIR.key]);
  assert.equal(gate.leakVerdict({ children: 2, containers: [], dirs: [LEFT_DIR], swept: [], reported: dirReported }).ok, null);
  assert.deepEqual(gate.leakVerdict({ children: 2, containers: [], dirs: [], swept: [SWEPT_DIR], reported: dirReported }), {
    fail: null,
    alreadyReported: `already reported: ${SWEPT_DIR.what}`,
    ok: null,
    newlyReported: [],
  });
  // Even with a listing failed: what was seen is still named.
  assert.equal(
    gate.leakVerdict({ children: 2, containers: [LEFT_CONTAINER], dirs: null, swept: [], reported }).alreadyReported,
    `already reported: ${LEFT_CONTAINER.what}`,
  );
});

test("leakVerdict: a new leftover is a FAIL, once; the already reported ones beside it are named, not counted", () => {
  const verdict = gate.leakVerdict({
    children: 2,
    containers: [LEFT_CONTAINER],
    dirs: [LEFT_DIR],
    swept: [SWEPT_DIR],
    reported: new Set([LEFT_CONTAINER.key]),
  });
  // The listed directory and the swept one are the same leftover (keyed by base name): one entry.
  assert.deepEqual(verdict, {
    fail: `${NOTHING_LEFT_2}: left behind: ${LEFT_DIR.what}`,
    alreadyReported: `already reported: ${LEFT_CONTAINER.what}`,
    ok: null,
    newlyReported: [LEFT_DIR.key],
  });
  // Nothing new: the input set is left alone (leakCheck adds newlyReported itself).
  const reported = new Set<string>();
  const first = gate.leakVerdict({ children: 2, containers: [LEFT_CONTAINER], dirs: [], swept: [], reported });
  assert.equal(first.fail, `${NOTHING_LEFT_2}: left behind: ${LEFT_CONTAINER.what}`);
  assert.deepEqual(first.newlyReported, [LEFT_CONTAINER.key]);
  assert.equal(reported.size, 0);
  // The next check, once leakCheck has recorded it: named, not a second FAIL.
  for (const key of first.newlyReported) reported.add(key);
  const second = gate.leakVerdict({ children: 2, containers: [LEFT_CONTAINER], dirs: [], swept: [], reported });
  assert.deepEqual(second, { fail: null, alreadyReported: `already reported: ${LEFT_CONTAINER.what}`, ok: null, newlyReported: [] });
});

test("settleGateContainer: a gate container proven gone is forgotten; one that is not stays, reported once", () => {
  const name = "agrav-gate-image-4242-3";
  const containers = new Set([name]);
  const reported = new Set<string>();
  gate.settleGateContainer(containers, reported, name, false);
  assert.deepEqual([...containers], [name], "kept for the cleanups");
  assert.deepEqual([...reported], [gate.leftoverKey("container", name)]);
  // The leak check after the part names it, and does not FAIL it a second time.
  const verdict = gate.leakVerdict({
    children: 0,
    containers: [{ key: gate.leftoverKey("container", name), what: `container ${name} of the gate (pid 4242)` }],
    dirs: [],
    swept: [],
    reported,
  });
  assert.equal(verdict.fail, null);
  assert.equal(verdict.alreadyReported, `already reported: container ${name} of the gate (pid 4242)`);

  gate.settleGateContainer(containers, reported, name, true);
  assert.deepEqual([...containers], []);
});

// --- a failed child's reason, in its FAIL line ------------------------------------------

function cliRun(overrides: Partial<CliRun>): CliRun {
  return { pid: 4242, code: 1, signal: null, timedOut: false, stdout: "", stderr: "", error: null, ...overrides };
}

test("describeExit quotes the end of a failed child's stderr — where each CLI puts its own reason — and nothing for a clean exit", () => {
  const stderr = [
    "contract-tests: pip install -r requirements.txt exited 1, and the PyPI probe (pip download fastapi==0.115.14) exited 1 too: PyPI looks unreachable",
    "A harness fault, not the model's: nothing was written. Fix it and run contract-tests again.",
    "",
  ].join("\n");
  assert.equal(
    gate.describeExit(cliRun({ stderr })),
    `exit 1; its stderr ends: ${JSON.stringify(`${stderr.split("\n")[0]} / ${stderr.split("\n")[1]}`)}`,
  );
  assert.equal(gate.describeExit(cliRun({ code: 0, stderr: "a warning on the way" })), "exit 0");
  assert.equal(gate.describeExit(cliRun({ stderr: " \n\n" })), "exit 1");
  assert.match(gate.describeExit(cliRun({ code: null, signal: "SIGKILL", stderr: "npm ping could not reach the registry either" })), /^killed by SIGKILL; its stderr ends: "npm ping could not reach the registry either"$/);
  assert.match(gate.describeExit(cliRun({ code: 143, timedOut: true, stderr: "Stopped by a harness fault" })), /^timed out and was stopped \(exit 143\); its stderr ends: "Stopped by a harness fault"$/);
  assert.match(gate.describeExit(cliRun({ code: null, error: "spawn node ENOENT" })), /^could not run \(spawn node ENOENT\)$/);
  // Timed out and SIGKILLed, but its `done` has not settled: no code, no signal yet.
  assert.match(gate.describeExit(cliRun({ code: null, signal: null, timedOut: true, stderr: "still installing" })), /^timed out and was stopped \(still running after SIGKILL\); its stderr ends: "still installing"$/);
});

test("stderrEnd keeps the last five lines and, past 600 characters, their end: a long detail before the reason cannot push the reason out", () => {
  const lines = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`);
  assert.equal(gate.stderrEnd(lines.join("\n")), "line 4 / line 5 / line 6 / line 7 / line 8");
  const long = `serve-attempt: the backend could not be served: ${"x".repeat(900)}; npm ping could not reach the registry either`;
  const end = gate.stderrEnd(long);
  assert.equal(end.length, 601);
  assert.ok(end.startsWith("…"));
  assert.ok(end.endsWith("npm ping could not reach the registry either"));
  assert.equal(gate.stderrEnd(""), "");
});

test("pipInstallFailure: the image part's pip failure says what the PyPI probe after it said", () => {
  const pip = { code: 1, timedOut: false, output: "Collecting six==1.16.0\nWARNING: Retrying (Retry(total=4...))\nERROR: Could not find a version that satisfies the requirement six==1.16.0\nERROR: No matching distribution found for six==1.16.0\n" };
  const head = "exit 1: WARNING: Retrying (Retry(total=4...)) / ERROR: Could not find a version that satisfies the requirement six==1.16.0 / ERROR: No matching distribution found for six==1.16.0";
  assert.equal(gate.pipInstallFailure(pip, null), head);
  assert.equal(
    gate.pipInstallFailure(pip, { code: 1, timedOut: false }),
    `${head}; the PyPI probe (pip download fastapi==0.115.14) then failed too (exit 1): an outage, retry later`,
  );
  assert.equal(
    gate.pipInstallFailure({ ...pip, code: null, timedOut: true }, { code: null, timedOut: true }),
    `exit null (timed out): ${head.slice("exit 1: ".length)}; the PyPI probe (pip download fastapi==0.115.14) then failed too (exit null, timed out): an outage, retry later`,
  );
  assert.equal(gate.pipInstallFailure(pip, { code: 0, timedOut: false }), `${head}; the PyPI probe (pip download fastapi==0.115.14) then succeeded, so PyPI was reachable`);
});

test("serveTeardown: stops the child, then --stop for a state file left; after a signal — one landing during the child's stop included — neither", async () => {
  const run = async (o: { interruptedAt?: "start" | "terminate"; live?: boolean; stateLeft?: boolean }): Promise<string[]> => {
    const seen: string[] = [];
    let interrupted = o.interruptedAt === "start";
    await gate.serveTeardown({
      interrupted: () => interrupted,
      childLive: () => o.live ?? true,
      terminate: async () => {
        seen.push("terminate");
        if (o.interruptedAt === "terminate") interrupted = true;
      },
      stateLeft: () => o.stateLeft ?? true,
      stop: async () => seen.push("--stop"),
    });
    return seen;
  };
  assert.deepEqual(await run({}), ["terminate", "--stop"]);
  assert.deepEqual(await run({ stateLeft: false }), ["terminate"]);
  assert.deepEqual(await run({ live: false }), ["--stop"]);
  assert.deepEqual(await run({ interruptedAt: "start" }), []);
  // The signal's cleanup runs its own --stop; a second one from here would race it.
  assert.deepEqual(await run({ interruptedAt: "terminate" }), ["terminate"]);
});

test("chromiumProblem launches as take-screenshots does and closes again; a failed launch names the install command and says why", async () => {
  let closed = 0;
  assert.equal(await gate.chromiumProblem(async () => ({ close: async () => void (closed += 1) })), null);
  assert.equal(closed, 1);
  // A browser that launched but would not close still proved the launch.
  assert.equal(await gate.chromiumProblem(async () => ({ close: async () => Promise.reject(new Error("already closed")) })), null);
  const missing = await gate.chromiumProblem(async () => {
    throw new Error(
      "browserType.launch: Executable doesn't exist at /home/u/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell\n" +
        "╔═════════════════════════════════════════════════════════════════════════╗\n" +
        "║ Looks like Playwright Test or Playwright was just installed or updated. ║\n" +
        "╚═════════════════════════════════════════════════════════════════════════╝",
    );
  });
  assert.match(missing ?? "", /launching it failed: browserType\.launch: Executable doesn't exist at \S*chromium_headless_shell-1234/);
  assert.match(missing ?? "", /Run `npx playwright install chromium`/);
  assert.doesNotMatch(missing ?? "", /--no-shell|--only-shell/);
});

test("closePreconditionBrowser closes the precondition's browser — one still launching once it is up — and never throws", async () => {
  await gate.closePreconditionBrowser({ launching: null });
  let closed = 0;
  const browser = { close: async () => void (closed += 1) };
  await gate.closePreconditionBrowser({ launching: Promise.resolve(browser) });
  assert.equal(closed, 1);
  // A signal during the launch: the cleanup waits for it, then closes what it started.
  let up!: (b: typeof browser) => void;
  const pending = gate.closePreconditionBrowser({ launching: new Promise((done) => (up = done)) });
  up(browser);
  await pending;
  assert.equal(closed, 2);
  // A launch that failed left nothing open; a close that fails is not the cleanup's failure.
  await gate.closePreconditionBrowser({ launching: Promise.reject(new Error("no chromium")) });
  await gate.closePreconditionBrowser({ launching: Promise.resolve({ close: async () => Promise.reject(new Error("already closed")) }) });
});

test("main installs the interrupt handlers before the preconditions launch Chromium, with the browser's cleanup, and bails after a signal during them", () => {
  // main is not injectable, and its preconditions probe the run contract's
  // ports, which no test may touch: the order is read from the source.
  const source = readFileSync(join(gate.REPO_ROOT, "scripts", "backend-gate.ts"), "utf8");
  const body = source.slice(source.indexOf("async function main("));
  const install = body.indexOf("installInterruptHandlers(");
  const cleanup = body.indexOf("closePreconditionBrowser(");
  const pre = body.indexOf("await preconditions(");
  assert.ok(install !== -1 && cleanup !== -1 && pre !== -1, "main installs handlers, registers the browser cleanup and runs the preconditions");
  assert.ok(cleanup < install && install < pre, "the browser's cleanup is registered, and the handlers installed, before the preconditions run");
  assert.equal(body.indexOf("installInterruptHandlers(", install + 1), -1, "main installs the handlers once");
  const after = body.slice(pre, body.indexOf("new Gate("));
  assert.match(after, /handlers\.interrupted\(\) !== null\) return new Promise<number>\(\(\) => \{\}\)/, "a signal during the preconditions starts no part");
  // The preconditions record the launch where the cleanup looks for it.
  assert.match(source, /pre\.launching = launchChromium\(\)/);
});

test("each child's time bound is above its own worst legitimate run", () => {
  // Counted here from the budgets, as each CLI spends them.
  const install = VENV_TIMEOUT_MS + LIMITS.pipInstallMs + LIMITS.pypiProbeMs + FREEZE_TIMEOUT_MS;
  const frontend = LIMITS.npmInstallMs + LIMITS.registryProbeMs + (LIMITS.devServerRetries + 1) * LIMITS.devServerStartMs;
  assert.ok(gate.CONTRACT_CHILD_MS > install + LIMITS.overallMs, `contract-tests: ${gate.CONTRACT_CHILD_MS}`);
  assert.ok(gate.SERVE_READY_MS > install + LIMITS.healthMs + frontend, `serve-attempt to ready: ${gate.SERVE_READY_MS}`);
  // take-screenshots serves the same way, then loads the page (30 s) and takes the picture.
  assert.ok(gate.SCREENSHOTS_CHILD_MS > install + LIMITS.healthMs + frontend + 30_000, `take-screenshots: ${gate.SCREENSHOTS_CHILD_MS}`);
  // --stop waits for a live owner's teardown, then cleans up after it: the owner's
  // process group killed and waited for, its container removed and inspected.
  assert.ok(gate.STOP_CHILD_MS > STOP_WAIT_MS + KILL_WAIT_MS + 2 * DOCKER_CLI_TIMEOUT_MS, `serve-attempt --stop: ${gate.STOP_CHILD_MS}`);
  // contract-tests-hard: the same install, over the fuzz's own (larger) overall budget.
  assert.ok(gate.HARD_CONTRACT_CHILD_MS > install + HARD_LIMITS.overallMs, `contract-tests-hard: ${gate.HARD_CONTRACT_CHILD_MS}`);
});

// --- the fuzz part's staging and comparison -------------------------------------------

test("stageTrack: copies tracks/console-fuzz/benchmark/fuzz/ into <root>/benchmark/fuzz, byte for byte", () => {
  const root = tempDir();
  const returned = gate.stageTrack(root);
  assert.equal(returned, root);
  const source = join(ROOT, "tracks", "console-fuzz", "benchmark", "fuzz");
  const staged = join(root, "benchmark", "fuzz");
  assert.deepEqual(gate.compareTrees(source, staged), { onlyA: [], onlyB: [], differ: [] });
});

test("stageTrack: a second call is a no-op — it neither re-copies nor throws when the copy already exists", () => {
  const root = tempDir();
  gate.stageTrack(root);
  const staged = join(root, "benchmark", "fuzz");
  const before = filesUnder(staged);
  writeFileSync(join(staged, "manifest.json"), "tampered");
  gate.stageTrack(root);
  // Untouched by the second call: it saw the destination already existed and copied nothing.
  assert.equal(readFileSync(join(staged, "manifest.json"), "utf8"), "tampered");
  assert.deepEqual(filesUnder(staged), before);
});

test("compareTrees: identical trees compare empty; an added, a missing and a differing file are each reported once", () => {
  const a = tempDir();
  const b = tempDir();
  mkdirSync(join(a, "sub"), { recursive: true });
  mkdirSync(join(b, "sub"), { recursive: true });
  writeFileSync(join(a, "same.txt"), "same");
  writeFileSync(join(b, "same.txt"), "same");
  writeFileSync(join(a, "sub", "same.txt"), "same too");
  writeFileSync(join(b, "sub", "same.txt"), "same too");
  assert.deepEqual(gate.compareTrees(a, b), { onlyA: [], onlyB: [], differ: [] });

  writeFileSync(join(a, "only-in-a.txt"), "x");
  writeFileSync(join(b, "only-in-b.txt"), "y");
  writeFileSync(join(a, "sub", "same.txt"), "changed in a");
  assert.deepEqual(gate.compareTrees(a, b), {
    onlyA: ["only-in-a.txt"],
    onlyB: ["only-in-b.txt"],
    differ: ["sub/same.txt"],
  });
});

test("compareTrees: a __pycache__ or node_modules left by a local run is ignored on either side", () => {
  const a = tempDir();
  const b = tempDir();
  writeFileSync(join(a, "kept.txt"), "x");
  writeFileSync(join(b, "kept.txt"), "x");
  mkdirSync(join(a, "__pycache__"), { recursive: true });
  writeFileSync(join(a, "__pycache__", "x.pyc"), "bytecode");
  mkdirSync(join(b, "node_modules", "leftover"), { recursive: true });
  writeFileSync(join(b, "node_modules", "leftover", "index.js"), "");
  assert.deepEqual(gate.compareTrees(a, b), { onlyA: [], onlyB: [], differ: [] });
});

test("pydanticLine: finds the pydantic pin case-insensitively, wherever it sits in the freeze; says so when there is none", () => {
  assert.equal(gate.pydanticLine(["fastapi==0.115.14", "pydantic==2.9.2", "uvicorn==0.30.6"]), "pydantic==2.9.2");
  assert.equal(gate.pydanticLine(["PyDantic==2.9.2"]), "PyDantic==2.9.2");
  assert.equal(gate.pydanticLine(["pydantic-core==2.23.4", "fastapi==0.115.14"]), "pydantic-core==2.23.4");
  assert.match(gate.pydanticLine(["fastapi==0.115.14"]), /no pydantic/);
  assert.match(gate.pydanticLine([]), /no pydantic/);
});

// --- what the gate expects -----------------------------------------------------------

test("the expectations follow the manifest's files and totals, and the rubric's rounding", () => {
  const manifest = loadManifest(ROOT);
  for (const expected of [gate.REFERENCE_EXPECTED, gate.HARDCODED_PLAN_EXPECTED]) {
    assert.deepEqual(
      expected.map((e) => [e.file, e.total]),
      manifest.map((m) => [m.file, m.tests]),
    );
    expected.forEach((e, i) => assert.equal(e.score, roundScore(e.passed, e.total, HIDDEN_ROWS[i].max as number), e.file));
  }
  assert.deepEqual(gate.REFERENCE_EXPECTED.map((e) => e.passed), [24, 12, 11, 11]);
  assert.deepEqual(gate.REFERENCE_EXPECTED.map((e) => e.score), [2, 2, 1, 2]);
  // Spec §7 3a, from plan 1's host measurement: 0.45 of the 5 planner points.
  assert.deepEqual(gate.HARDCODED_PLAN_EXPECTED.map((e) => e.passed), [24, 0, 1, 2]);
  assert.deepEqual(gate.HARDCODED_PLAN_EXPECTED.map((e) => e.score), [2, 0, 0.09, 0.36]);
  assert.equal(gate.HARDCODED_PLAN_EXPECTED.slice(1).reduce((sum, e) => sum + e.score, 0).toFixed(2), "0.45");
});

test("every synthetic attempt name is an attempt directory name, and they are distinct", () => {
  const names = [
    gate.REFERENCE_ATTEMPT,
    gate.MUTANT_ATTEMPT,
    ...gate.STOP_CASES.map((stop) => stop.attempt),
    gate.RESET_BROKEN.attempt,
    gate.SERVE_ATTEMPT,
  ];
  for (const name of names) assert.match(name, ATTEMPT_DIR_RE);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(gate.STOP_CASES.map((stop) => stop.stage), ["layout", "install", "boot", "health"]);
  assert.equal(parseAttemptDirName(gate.SERVE_ATTEMPT)?.modelId, gate.SERVE_BENCHMARK_ID);
  assert.equal(gate.SCREENSHOT_PATH, join("website", "public", "screenshots", `${gate.SERVE_ATTEMPT}.png`));
});

// --- the fixtures --------------------------------------------------------------------

function pins(requirements: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of requirements.split("\n")) {
    const match = /^([A-Za-z0-9._-]+)==(\S+)$/.exec(line.trim());
    if (match !== null) map.set(match[1].toLowerCase(), match[2]);
  }
  return map;
}

test("the stop apps pin fastapi and uvicorn as the reference does; only stop-install names a package PyPI lacks", () => {
  const reference = pins(readFileSync(join(REFERENCE, "requirements.txt"), "utf8"));
  assert.deepEqual([...reference.keys()].sort(), ["fastapi", "uvicorn"]);
  for (const fixture of [...gate.STOP_CASES.map((stop) => stop.fixture), gate.RESET_BROKEN.fixture]) {
    const own = pins(readFileSync(join(FIXTURES, fixture, "backend", "requirements.txt"), "utf8"));
    for (const [name, version] of reference) assert.equal(own.get(name), version, `${fixture}: ${name}`);
    const extra = [...own.keys()].filter((name) => !reference.has(name));
    assert.deepEqual(extra, fixture === "stop-install" ? ["agrav-gate-3a-invented-package-does-not-exist"] : [], fixture);
    // A local version label: PyPI refuses to host one, so a registered name still cannot satisfy the pin.
    for (const name of extra) assert.match(own.get(name) ?? "", /\+/, `${fixture}: ${name} must pin a local version`);
  }
});

test("each stop app is the defect its name says, and nothing else", () => {
  const main = (fixture: string, path = ["backend", "app", "main.py"]): string => readFileSync(join(FIXTURES, fixture, ...path), "utf8");
  assert.ok(!existsSync(join(FIXTURES, "stop-layout", "backend", "app")), "stop-layout: no app/ at all");
  assert.match(main("stop-layout", ["backend", "main.py"]), /@app\.get\("\/api\/v1\/health"\)/);
  assert.match(main("stop-install"), /@app\.get\("\/api\/v1\/health"\)/);
  assert.match(main("stop-boot"), /^raise RuntimeError\(/m);
  assert.doesNotMatch(main("stop-health"), /@app\.\w+\("\/api\/v1\/health"/, "stop-health: no health route");
  assert.match(main("stop-health"), /@app\.get\("\/"\)/);
  const broken = main("reset-broken");
  assert.match(broken, /@app\.get\("\/api\/v1\/health"\)/);
  assert.match(broken, /@app\.post\("\/api\/v1\/reset"\)[\s\S]*status_code=500/);
  for (const fixture of ["stop-install", "stop-boot", "stop-health", "reset-broken"]) {
    assert.equal(statSync(join(FIXTURES, fixture, "backend", "app", "__init__.py")).size, 0, fixture);
  }
});

test("the frontend fixture has no dependency at all, a dev server and a no-op build", () => {
  const pkg = JSON.parse(readFileSync(join(FIXTURES, "frontend", "package.json"), "utf8"));
  for (const key of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    assert.equal(pkg[key], undefined, key);
  }
  assert.equal(pkg.scripts.dev, "node server.mjs");
  assert.equal(pkg.scripts.build, "node -e 0");
});

test("the frontend fixture defaults to the run contract's dev-server port and proxies /api to its backend port", async () => {
  // Imported here, not at the top, so the listener check above still sees serve-attempt's first import.
  const { BACKEND_PORT, FRONTEND_PORT } = await import("../scripts/serve-attempt");
  const source = readFileSync(join(FIXTURES, "frontend", "server.mjs"), "utf8");
  assert.ok(source.includes(`process.argv[2] ?? ${FRONTEND_PORT})`), `the default port is not ${FRONTEND_PORT}`);
  const upstream = [...source.matchAll(/\bport: (\d+)/g)].map((match) => Number(match[1]));
  assert.deepEqual(upstream, [BACKEND_PORT]);
});

test("the frontend fixture prints a banner dev-server.ts reads, and serves its page there", { timeout: 20_000 }, async () => {
  const child = spawn(process.execPath, [join(FIXTURES, "frontend", "server.mjs"), "0"], { stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  try {
    const banner = await new Promise<{ url: string; port: number }>((resolveBanner, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error(`no banner within 10 s: ${JSON.stringify(output)}`)), 10_000);
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const parsed = parseLocalBanner(output);
        if (parsed !== null) {
          clearTimeout(timer);
          resolveBanner(parsed);
        }
      });
      child.on("exit", (code) => reject(new Error(`exited ${code} before its banner: ${JSON.stringify(output)}`)));
    });
    assert.match(banner.url, /^http:\/\/localhost:\d+\/$/);
    assert.ok(banner.port > 0 && banner.port !== 5173, "an ephemeral port, never the run contract's");
    const reply = await fetch(`http://127.0.0.1:${banner.port}/`);
    assert.equal(reply.status, 200);
    assert.match(reply.headers.get("content-type") ?? "", /^text\/html/);
    assert.match(await reply.text(), /<h1>Gate 3a frontend<\/h1>/);
  } finally {
    child.kill("SIGTERM");
    await new Promise((done) => (child.exitCode !== null || child.signalCode !== null ? done(null) : child.once("exit", done)));
  }
});

test("the fixture directory holds only what the gate stages, and its own record", () => {
  const top = readdirSync(FIXTURES).sort();
  const expected = ["frontend", "reset-broken", "stop-boot", "stop-health", "stop-install", "stop-layout"];
  assert.deepEqual(
    top.filter((name) => name !== "gate-3-result.json"),
    expected,
  );
});
