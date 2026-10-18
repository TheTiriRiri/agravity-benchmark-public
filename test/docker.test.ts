/**
 * `scripts/lib/docker.ts`: proving a container is gone, resolving the image,
 * and sweeping what a dead run left behind.
 *
 * No daemon: every docker call goes through an injected `DockerRun`, and the
 * one test of the default runner puts a stand-in `docker` script first on PATH.
 */
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  CONTAINER_NAME_RE,
  defaultDockerRun,
  describeCall,
  DOCKER_CLI_TIMEOUT_MS,
  ensureContainerRemoved,
  imageIdOf,
  LABEL_ATTEMPT,
  LABEL_OWNER,
  LABEL_ROLE,
  pidIsAlive,
  resolveImageId,
  resolveImageRef,
  saysNoSuchContainer,
  SCRATCH_DIR_RE,
  scratchDirPrefix,
  scratchDirsOwnedBy,
  sweepDeadOwners,
  userSpec,
  type DockerRun,
} from "../scripts/lib/docker";

const scratchDirs: string[] = [];

after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

type Response = Partial<SpawnSyncReturns<string>>;

/** A `DockerRun` that answers from `respond` and records every call with its timeout. */
function fakeDocker(respond: (args: string[]) => Response) {
  const calls: { args: string[]; timeoutMs: number }[] = [];
  const run: DockerRun = (args, timeoutMs) => {
    calls.push({ args, timeoutMs });
    return { pid: 1, output: [], stdout: "", stderr: "", status: 0, signal: null, ...respond(args) } as SpawnSyncReturns<string>;
  };
  return { run, calls, argv: () => calls.map((call) => call.args) };
}

/** Answers keyed by the docker subcommand, as `run-matrix`'s tests did. */
function bySubcommand(responses: Record<string, Response>) {
  return fakeDocker((args) => responses[args[0]] ?? {});
}

/** What `spawnSync` returns when its `timeout` fires. */
const TIMED_OUT: Response = {
  error: Object.assign(new Error("spawnSync docker ETIMEDOUT"), { code: "ETIMEDOUT" }),
  status: null,
  signal: "SIGKILL",
};

const NAME = "agrav-backend-x-attempt-1-4242-1";
const CONSEQUENCE = "The run stops here; remove it by hand.";

// --- small helpers ----------------------------------------------------------------

test("labels and the CLI budget are the contract's", () => {
  assert.equal(LABEL_ROLE, "agrav.role");
  assert.equal(LABEL_ATTEMPT, "agrav.attempt");
  assert.equal(LABEL_OWNER, "agrav.owner");
  assert.equal(DOCKER_CLI_TIMEOUT_MS, 30_000);
});

test("userSpec is the host uid and gid", () => {
  assert.equal(userSpec(), `${process.getuid!()}:${process.getgid!()}`);
});

test("pidIsAlive: this process and somebody else's are alive; a reaped child and non-pids are not", () => {
  assert.equal(pidIsAlive(process.pid), true);
  // pid 1 always exists; unless the tests run as root, kill(1, 0) is EPERM.
  assert.equal(pidIsAlive(1), true);
  const child = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(pidIsAlive(child.pid), false);
  // 0 and negative numbers address process groups, not a process.
  for (const notAPid of [0, -1, 1.5, Number.NaN]) assert.equal(pidIsAlive(notAPid), false, String(notAPid));
});

// --- the default runner -------------------------------------------------------------

test("defaultDockerRun runs `docker` from PATH, returns strings, and is bounded by its timeout", () => {
  const bin = scratch("agrav-fake-docker-bin-");
  const fake = join(bin, "docker");
  writeFileSync(fake, '#!/bin/sh\nif [ "$1" = hang ]; then exec sleep 10; fi\necho "args:$*"\n');
  chmodSync(fake, 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath ?? ""}`;
  try {
    const ok = defaultDockerRun(["ps", "-a"], 5_000);
    assert.equal(ok.status, 0);
    assert.equal(ok.stdout, "args:ps -a\n");

    const startedAt = Date.now();
    const hung = defaultDockerRun(["hang"], 200);
    assert.equal((hung.error as NodeJS.ErrnoException | undefined)?.code, "ETIMEDOUT");
    assert.ok(Date.now() - startedAt < 5_000, "the timeout bounds the call");
  } finally {
    process.env.PATH = savedPath;
  }
});

// --- resolveImageRef ----------------------------------------------------------------

test("resolveImageRef pins the tag to the local image Id", () => {
  const docker = bySubcommand({ image: { stdout: "sha256:0123abcd\n" } });
  assert.equal(resolveImageRef("agrav-bench/harness:2026-09-18", docker.run), "agrav-bench/harness:2026-09-18@sha256:0123abcd");
  assert.deepEqual(docker.calls, [
    { args: ["image", "inspect", "-f", "{{.Id}}", "agrav-bench/harness:2026-09-18"], timeoutMs: DOCKER_CLI_TIMEOUT_MS },
  ]);
});

test("resolveImageRef throws for a missing image, a daemon that times out, or a non-reference", () => {
  const missing = bySubcommand({ image: { status: 1, stderr: "Error: No such image: agrav-bench/harness:nope\n" } });
  assert.throws(
    () => resolveImageRef("agrav-bench/harness:nope", missing.run),
    /could not resolve image agrav-bench\/harness:nope.*No such image[\s\S]*docker build -t agrav-bench\/harness:nope images\/harness/,
  );

  const hung = bySubcommand({ image: TIMED_OUT });
  assert.throws(() => resolveImageRef("agrav-bench/harness:2026-09-18", hung.run), /timed out after 30000 ms/);

  const never = bySubcommand({});
  assert.throws(() => resolveImageRef("--help", never.run), /not an image reference/);
  assert.throws(() => resolveImageRef("", never.run), /not an image reference/);
  assert.equal(never.calls.length, 0);
});

// --- the bare image Id ----------------------------------------------------------------

const TAG = "agrav-bench/harness:2026-09-18";
const IMAGE_ID = `sha256:${"a".repeat(64)}`;

test("imageIdOf takes the bare Id from <tag>@<Id>, and nothing that is not one", () => {
  assert.equal(imageIdOf(`${TAG}@${IMAGE_ID}`), IMAGE_ID);
  for (const bad of [TAG, `${TAG}@`, `${TAG}@sha256:${"a".repeat(63)}`, `${TAG}@sha256:${"A".repeat(64)}`, IMAGE_ID]) {
    assert.throws(() => imageIdOf(bad), /does not end in @sha256:<64 hex>/, bad);
  }
});

test("resolveImageId: the tag's <tag>@<Id> and the bare Id, or resolveImageRef's error, or a refusal of an Id that is not sha256:<64 hex>", () => {
  const docker = bySubcommand({ image: { stdout: `${IMAGE_ID}\n` } });
  assert.deepEqual(resolveImageId(TAG, docker.run), { ref: `${TAG}@${IMAGE_ID}`, id: IMAGE_ID });
  assert.equal(docker.calls.length, 1, "one docker call");

  const missing = bySubcommand({ image: { status: 1, stderr: `Error: No such image: ${TAG}\n` } });
  assert.throws(() => resolveImageId(TAG, missing.run), /could not resolve image .*No such image/);
  const short = bySubcommand({ image: { stdout: "sha256:0123abcd\n" } });
  assert.throws(() => resolveImageId(TAG, short.run), new RegExp(`the image resolved to "${TAG}@sha256:0123abcd", which does not end in @sha256:<64 hex>`));
});

test("the helpers the other docker callers share: the name grammar, success, a call's description, and 'no such container'", () => {
  assert.ok(CONTAINER_NAME_RE.test(NAME));
  assert.ok(!CONTAINER_NAME_RE.test("--privileged"));
  const result = (r: Response): SpawnSyncReturns<string> => ({ pid: 1, output: [], stdout: "", stderr: "", status: 0, signal: null, ...r }) as SpawnSyncReturns<string>;
  assert.equal(describeCall(result(TIMED_OUT), 30_000), "timed out after 30000 ms");
  assert.equal(describeCall(result({ status: null, signal: "SIGKILL" }), 1), "killed by SIGKILL");
  assert.equal(describeCall(result({ status: 1, stderr: `${"x".repeat(600)}\n` }), 1), `exit 1: ${"x".repeat(500)}…`);
  assert.equal(saysNoSuchContainer(result({ status: 1, stderr: `Error response from daemon: No such container: ${NAME}\n` })), true);
  assert.equal(saysNoSuchContainer(result({ status: 1, stderr: "Cannot connect to the Docker daemon\n" })), false);
  assert.equal(saysNoSuchContainer(result({ ...TIMED_OUT, stderr: "No such container" })), false, "a timed-out call proves nothing");
  assert.equal(saysNoSuchContainer(result({ status: 0, stderr: "No such container" })), false);
});

// --- ensureContainerRemoved -------------------------------------------------------------

test("for a --rm container, a successful `docker rm -f` is proof enough, and nothing else is asked", () => {
  const docker = bySubcommand({ rm: { status: 0 } });
  const result = ensureContainerRemoved(NAME, { consequence: CONSEQUENCE, notRunningCountsAsRemoved: true, run: docker.run });
  assert.equal(result.removed, true);
  assert.deepEqual(docker.argv(), [["rm", "-f", NAME]]);
});

test("otherwise a successful `docker rm -f` is confirmed: only 'no such container' proves removal", () => {
  const gone = bySubcommand({
    rm: { status: 0 },
    inspect: { status: 1, stderr: `Error response from daemon: No such container: ${NAME}\n` },
  });
  assert.equal(ensureContainerRemoved(NAME, { consequence: CONSEQUENCE, run: gone.run }).removed, true);
  assert.deepEqual(gone.argv(), [
    ["rm", "-f", NAME],
    ["inspect", "-f", "{{.State.Running}}", NAME],
  ]);

  // rm -f said yes, but the daemon still knows the name: not proof.
  const lingering = bySubcommand({ rm: { status: 0 }, inspect: { status: 0, stdout: "false\n" } });
  const result = ensureContainerRemoved(NAME, { consequence: CONSEQUENCE, run: lingering.run });
  assert.equal(result.removed, false);
  assert.ok(result.detail.endsWith(CONSEQUENCE), result.detail);
});

test("a container the daemon says is already gone counts as removed; a stopped one only for --rm containers", () => {
  const goneResponses = {
    rm: { status: 1, stderr: `Error response from daemon: No such container: ${NAME}` },
    inspect: { status: 1, stderr: `Error: No such object: ${NAME}` },
  };
  for (const notRunningCountsAsRemoved of [false, true]) {
    const gone = bySubcommand(goneResponses);
    assert.equal(
      ensureContainerRemoved(NAME, { consequence: CONSEQUENCE, notRunningCountsAsRemoved, run: gone.run }).removed,
      true,
    );
  }

  const stoppedResponses = { rm: { status: 1, stderr: "daemon busy" }, inspect: { status: 0, stdout: "false\n" } };
  const allowed = bySubcommand(stoppedResponses);
  assert.equal(
    ensureContainerRemoved(NAME, { consequence: CONSEQUENCE, notRunningCountsAsRemoved: true, run: allowed.run }).removed,
    true,
  );
  // Without the allowance a stopped container still exists — its name, its
  // mounts — so it is not removed.
  const strict = bySubcommand(stoppedResponses);
  const result = ensureContainerRemoved(NAME, { consequence: CONSEQUENCE, run: strict.run });
  assert.equal(result.removed, false);
  assert.match(result.detail, /daemon busy/);
});

test("a container still running, or a daemon that will not answer, is not removed, and the detail says what that means", () => {
  const running = bySubcommand({ rm: { status: 1, stderr: "daemon busy" }, inspect: { status: 0, stdout: "true\n" } });
  const stillThere = ensureContainerRemoved(NAME, { consequence: CONSEQUENCE, notRunningCountsAsRemoved: true, run: running.run });
  assert.equal(stillThere.removed, false);
  assert.ok(stillThere.detail.endsWith(CONSEQUENCE), stillThere.detail);

  // "Cannot tell" has to read as "still there".
  const unreachable = bySubcommand({
    rm: { status: 1, stderr: "Cannot connect to the Docker daemon" },
    inspect: { status: 1, stderr: "Cannot connect to the Docker daemon" },
  });
  assert.equal(ensureContainerRemoved(NAME, { consequence: CONSEQUENCE, run: unreachable.run }).removed, false);

  const noDocker = bySubcommand({
    rm: { error: Object.assign(new Error("spawnSync docker ENOENT"), { code: "ENOENT" }), status: null },
    inspect: { error: Object.assign(new Error("spawnSync docker ENOENT"), { code: "ENOENT" }), status: null },
  });
  assert.equal(ensureContainerRemoved(NAME, { consequence: CONSEQUENCE, run: noDocker.run }).removed, false);
});

test("a docker call that times out means not removed", () => {
  // rm -f timed out: the daemon did not answer within the budget and is not
  // asked again.
  const rmHung = bySubcommand({ rm: TIMED_OUT, inspect: { status: 1, stderr: "No such container" } });
  const first = ensureContainerRemoved(NAME, { consequence: CONSEQUENCE, notRunningCountsAsRemoved: true, run: rmHung.run });
  assert.equal(first.removed, false);
  assert.match(first.detail, /timed out/);
  assert.deepEqual(rmHung.argv(), [["rm", "-f", NAME]]);

  for (const rm of [{ status: 0 }, { status: 1, stderr: "daemon busy" }]) {
    const inspectHung = bySubcommand({ rm, inspect: TIMED_OUT });
    const result = ensureContainerRemoved(NAME, { consequence: CONSEQUENCE, run: inspectHung.run });
    assert.equal(result.removed, false);
    assert.match(result.detail, /timed out/);
  }
});

test("every call carries the timeout, DOCKER_CLI_TIMEOUT_MS unless given", () => {
  const byDefault = bySubcommand({ rm: { status: 0 }, inspect: { status: 1, stderr: "No such container" } });
  ensureContainerRemoved(NAME, { consequence: CONSEQUENCE, run: byDefault.run });
  assert.deepEqual(
    byDefault.calls.map((call) => call.timeoutMs),
    [DOCKER_CLI_TIMEOUT_MS, DOCKER_CLI_TIMEOUT_MS],
  );

  const given = bySubcommand({ rm: { status: 0 }, inspect: { status: 1, stderr: "No such container" } });
  ensureContainerRemoved(NAME, { consequence: CONSEQUENCE, timeoutMs: 1234, run: given.run });
  assert.deepEqual(
    given.calls.map((call) => call.timeoutMs),
    [1234, 1234],
  );
});

test("something that is not a container name is never passed to docker", () => {
  const docker = bySubcommand({});
  for (const name of ["", "-f", "--all", "a b"]) {
    const result = ensureContainerRemoved(name, { consequence: CONSEQUENCE, run: docker.run });
    assert.equal(result.removed, false, JSON.stringify(name));
  }
  assert.equal(docker.calls.length, 0);
});

// --- sweepDeadOwners ------------------------------------------------------------------

const PS_ARGV = ["ps", "-a", "--filter", "label=agrav.role=backend", "--format", '{{.Names}} {{.Label "agrav.owner"}}'];

const DEAD = 4101;
const ALIVE = 4202;
const DEAD_WITH_SURVIVOR = 4303;

/** A tmpRoot holding every kind of entry the sweep must, and must not, touch. */
function sweepFixture() {
  const tmpRoot = scratch("agrav-sweep-test-");
  const deadDir = mkdtempSync(join(tmpRoot, `agrav-backend-${DEAD}-`));
  writeFileSync(join(deadDir, "pip-freeze.txt"), "fastapi==0.115.14\n");
  mkdirSync(join(deadDir, "venv", "bin"), { recursive: true });
  const aliveDir = mkdtempSync(join(tmpRoot, `agrav-backend-${ALIVE}-`));
  const survivorDir = mkdtempSync(join(tmpRoot, `agrav-backend-${DEAD_WITH_SURVIVOR}-`));

  const outside = scratch("agrav-sweep-outside-");
  writeFileSync(join(outside, "keep.txt"), "not ours to delete\n");
  const untouched = [
    aliveDir,
    survivorDir,
    // a file, not a directory
    join(tmpRoot, "agrav-backend-4404-abcdef"),
    // a symlink to a directory: never followed, never removed
    join(tmpRoot, "agrav-backend-4505-ghijkl"),
    // not `agrav-backend-<pid>-XXXXXX`
    join(tmpRoot, "agrav-backend-gemini-4606-abcdef"),
    join(tmpRoot, `agrav-backend-${DEAD}-toolong7`),
    join(tmpRoot, "agrav-backend-0-abcdef"),
    join(tmpRoot, `agrav-creds-${DEAD}-abcdef`),
    join(tmpRoot, `other-${DEAD}-abcdef`),
  ];
  writeFileSync(untouched[2], "");
  symlinkSync(outside, untouched[3]);
  for (const dir of untouched.slice(4)) mkdirSync(dir);
  return { tmpRoot, deadDir, survivorDir, outside, untouched };
}

const PS_OUTPUT = [
  `agrav-backend-a-attempt-1-${DEAD}-1 ${DEAD}`,
  `agrav-backend-b-attempt-1-${ALIVE}-1 ${ALIVE}`,
  `agrav-backend-c-attempt-1-${DEAD_WITH_SURVIVOR}-1 ${DEAD_WITH_SURVIVOR}`,
  // Owners that cannot be parsed are never touched.
  "agrav-backend-d-attempt-1-x-1 ",
  "agrav-backend-e-attempt-1-x-1 notapid",
  "agrav-backend-f-attempt-1-x-1 -5",
  "agrav-backend-g-attempt-1-x-1 0",
  "",
].join("\n");

function sweepDocker() {
  return fakeDocker((args) => {
    if (args[0] === "ps") return { stdout: PS_OUTPUT };
    const name = args[args.length - 1];
    if (name.includes(`-${DEAD_WITH_SURVIVOR}-`)) {
      return args[0] === "rm" ? { status: 1, stderr: "daemon busy" } : { stdout: "true\n" };
    }
    return args[0] === "rm" ? { status: 0 } : { status: 1, stderr: `Error: No such object: ${name}` };
  });
}

test("the sweep removes dead owners' containers and scratch directories, and nothing else", () => {
  const fixture = sweepFixture();
  const docker = sweepDocker();
  const asked: number[] = [];
  const result = sweepDeadOwners({
    role: "backend",
    tmpRoot: fixture.tmpRoot,
    run: docker.run,
    isAlive: (pid) => {
      asked.push(pid);
      return pid === ALIVE;
    },
  });

  assert.deepEqual(docker.argv()[0], PS_ARGV);
  // Only the dead owners' containers are asked about — the survivor included.
  assert.deepEqual(
    docker.argv().filter((args) => args[0] === "rm"),
    [
      ["rm", "-f", `agrav-backend-a-attempt-1-${DEAD}-1`],
      ["rm", "-f", `agrav-backend-c-attempt-1-${DEAD_WITH_SURVIVOR}-1`],
    ],
  );
  assert.deepEqual(result.removedContainers, [`agrav-backend-a-attempt-1-${DEAD}-1`]);
  assert.deepEqual(result.removedDirs, [fixture.deadDir]);
  assert.equal(existsSync(fixture.deadDir), false);

  // The container that would not go is reported, and its owner's directory is
  // kept, because the container may still mount it.
  assert.equal(result.failed.length, 2, result.failed.join("\n"));
  assert.match(result.failed[0], new RegExp(`container agrav-backend-c-attempt-1-${DEAD_WITH_SURVIVOR}-1: .*daemon busy`));
  assert.ok(result.failed[1].startsWith(`${fixture.survivorDir}: kept`), result.failed[1]);

  for (const path of fixture.untouched) assert.ok(existsSync(path), `${path} was removed`);
  assert.ok(existsSync(join(fixture.outside, "keep.txt")), "the symlink was followed");

  // One liveness answer per pid, and none for an owner that cannot be parsed.
  assert.deepEqual([...asked].sort((a, b) => a - b), [DEAD, ALIVE, DEAD_WITH_SURVIVOR]);
});

test("when the containers cannot be listed, nothing is swept — not even a dead owner's directory", () => {
  const fixture = sweepFixture();
  const docker = bySubcommand({ ps: { status: 1, stderr: "Cannot connect to the Docker daemon" } });
  const result = sweepDeadOwners({ role: "backend", tmpRoot: fixture.tmpRoot, run: docker.run, isAlive: () => false });
  assert.deepEqual(result.removedContainers, []);
  assert.deepEqual(result.removedDirs, []);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0], /Cannot connect to the Docker daemon/);
  assert.ok(existsSync(fixture.deadDir));
  assert.deepEqual(docker.argv(), [PS_ARGV]);
});

test("the sweep's defaults: this process is alive, so nothing of its own is swept", () => {
  const tmpRoot = scratch("agrav-sweep-self-");
  const own = mkdtempSync(join(tmpRoot, `agrav-backend-${process.pid}-`));
  const docker = fakeDocker((args) => (args[0] === "ps" ? { stdout: `agrav-backend-own-${process.pid}-1 ${process.pid}\n` } : {}));
  const result = sweepDeadOwners({ role: "backend", tmpRoot, run: docker.run });
  assert.deepEqual(result, { removedContainers: [], removedDirs: [], failed: [] });
  assert.ok(existsSync(own));
  assert.deepEqual(docker.argv(), [PS_ARGV]);
});

test("scratchDirPrefix names what SCRATCH_DIR_RE matches, pid included, and refuses what is not a pid", () => {
  assert.equal(scratchDirPrefix(4101), "agrav-backend-4101-");
  const tmpRoot = scratch("agrav-sweep-prefix-");
  for (let i = 0; i < 20; i++) {
    const name = mkdtempSync(join(tmpRoot, scratchDirPrefix(process.pid))).slice(tmpRoot.length + 1);
    const match = SCRATCH_DIR_RE.exec(name);
    assert.ok(match !== null, name);
    assert.equal(Number(match[1]), process.pid);
  }
  for (const bad of [0, -1, 1.5, Number.NaN]) assert.throws(() => scratchDirPrefix(bad), /not a pid/, String(bad));
  // Nothing else a scoring tool makes under the temp directory looks like one.
  for (const other of ["agrav-backend-4101-venv-abcdef", "agrav-backend-4101-", "agrav-creds-4101-abcdef", "agrav-backend-demo-attempt-1-4101-1"]) {
    assert.equal(SCRATCH_DIR_RE.test(other), false, other);
  }
});

test("scratchDirsOwnedBy: real directories of this uid named for an owner — no symlink, no file, no bad pid, no other owner", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "agrav-scratch-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const owner = 4_200_001;
  const ours = `${scratchDirPrefix(owner)}abc123`;
  const theirs = `${scratchDirPrefix(4_200_002)}xyz789`;
  mkdirSync(join(tmp, ours));
  mkdirSync(join(tmp, theirs));
  mkdirSync(join(tmp, "elsewhere"));
  symlinkSync(join(tmp, "elsewhere"), join(tmp, `${scratchDirPrefix(owner)}link01`));
  writeFileSync(join(tmp, `${scratchDirPrefix(owner)}file01`), "");
  mkdirSync(join(tmp, `${scratchDirPrefix(owner)}toolong1`));
  mkdirSync(join(tmp, "agrav-backend-0-abc123"));
  mkdirSync(join(tmp, "agrav-backend-99999999999-abc123"));

  assert.deepEqual(scratchDirsOwnedBy(tmp, new Set([owner])), [{ path: join(tmp, ours), entry: ours, owner }]);
  assert.deepEqual(scratchDirsOwnedBy(tmp, new Set([4_200_003])), []);
  assert.deepEqual(
    scratchDirsOwnedBy(tmp).map((d) => d.entry),
    [ours, theirs].sort(),
  );
  assert.throws(() => scratchDirsOwnedBy(join(tmp, "missing")), /ENOENT/);
});

test("the sweep refuses a role that is not a plain label value", () => {
  const docker = bySubcommand({});
  for (const role of ["", "backend,label=x", "Backend", "a b"]) {
    assert.throws(() => sweepDeadOwners({ role, run: docker.run }), /not a role label value/, role);
  }
  assert.equal(docker.calls.length, 0);
});
