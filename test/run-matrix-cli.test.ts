/**
 * The runner's container contract and CLI surface.
 *
 * Two halves. The argument builders are imported and asserted as argv arrays —
 * they encode the whole container contract, so pinning them to the arrays rather
 * than to how they happen to be logged is the point. The CLI behaviour is driven
 * by spawning the real script.
 *
 * Importing `scripts/run-matrix.ts` at all is itself a check: its entry point is
 * guarded, so if that guard ever broke, the import would start the matrix, hit
 * the `TODO-cli-id` placeholders and fail this whole file loudly.
 *
 * Every subprocess run here is `--dry-run` or an argument error, and every one
 * of them points `--root` at a temp directory, so no container starts, no quota
 * is spent, and the checkout is never written to.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { attemptArgs, credentialCopyArgs, tokenChanged, tokenPersistArgs, usageGateArgs } from "../scripts/run-matrix";
import { loadRunnerConfig, parseDurationMs, type MatrixRow } from "../scripts/lib/runner-config";
import { writeRunJson, type RunJson } from "../scripts/lib/run-json";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../scripts/run-matrix.ts", import.meta.url));
const USER_SPEC = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;

const CONFIG = loadRunnerConfig(join(REPO_ROOT, "benchmark", "runner.yaml"), { allowPlaceholders: true });
const ROW: MatrixRow = CONFIG.matrix.find((row) => row.id === "gemini-38-flash-high")!;
/** The real config's image tag, escaped for use inside a RegExp. */
const IMAGE_RE = CONFIG.image.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const tempRoots: string[] = [];

/**
 * A repo root holding only what the runner reads: the real `runner.yaml` and the
 * real `prompt.md`. `eval-attempts/` and `eval-results/` are deliberately absent,
 * so any write the runner makes shows up as a directory that should not exist.
 */
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agrav-root-"));
  tempRoots.push(root);
  mkdirSync(join(root, "benchmark"), { recursive: true });
  copyFileSync(join(REPO_ROOT, "benchmark", "runner.yaml"), join(root, "benchmark", "runner.yaml"));
  copyFileSync(join(REPO_ROOT, "prompt.md"), join(root, "prompt.md"));
  return root;
}

after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

function runMatrix(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// --- the container contract, as argv arrays ---------------------------------

test("credentialCopyArgs copies only the named files, from the pinned image", () => {
  assert.deepEqual(credentialCopyArgs(CONFIG.image, "/tmp/creds", CONFIG.credentialFiles), [
    "run",
    "--rm",
    // Ruling R4 continued: never let this pull the image from a public
    // registry namespace anyone can register, with the OAuth token mounted.
    "--pull",
    "never",
    "--user",
    USER_SPEC,
    // Relative sources resolved from the volume root, so `--parents` reproduces
    // `.gemini/antigravity-cli/…` under /dst and not `src/.gemini/…`.
    "-w",
    "/src",
    "-v",
    "agy-creds:/src:ro",
    "-v",
    "/tmp/creds:/dst",
    // Ruling R4/R5: the pinned harness image, not a registry pull, and `cp` as
    // the entrypoint so no shell parses the configured filenames.
    "--entrypoint",
    "cp",
    CONFIG.image,
    "--parents",
    ".gemini/antigravity-cli/antigravity-oauth-token",
    ".gemini/antigravity-cli/installation_id",
    "/dst/",
  ]);
});

test("the copy reproduces agy's own directory layout, not a flat HOME", () => {
  // agy's file store is $HOME/.gemini/antigravity-cli/ — verified on the volume,
  // where installation_id sits three levels down. A flat `cp … /dst/` succeeds
  // and leaves the token at $HOME/<file>, which agy never reads: every attempt
  // would then run unauthenticated and the matrix would stop on the first one.
  const args = credentialCopyArgs(CONFIG.image, "/tmp/creds", CONFIG.credentialFiles);
  assert.ok(args.includes("--parents"), `no --parents in: ${args.join(" ")}`);
  assert.equal(args[args.indexOf("-w") + 1], "/src");
  for (const file of CONFIG.credentialFiles) {
    assert.ok(
      args.includes(file) && !args.includes(`/src/${file}`),
      `${file} must be passed relative to /src, or --parents reproduces "src/" too`,
    );
  }
});

test("tokenPersistArgs copies only the token back, from a read-only HOME, in the pinned image", () => {
  assert.deepEqual(tokenPersistArgs(CONFIG.image, "/tmp/creds"), [
    "run", "--rm", "--pull", "never", "--user", USER_SPEC,
    "-w", "/src",
    "-v", "/tmp/creds:/src:ro",
    "-v", "agy-creds:/dst",
    "--entrypoint", "cp",
    CONFIG.image,
    ".gemini/antigravity-cli/antigravity-oauth-token",
    "/dst/.gemini/antigravity-cli/antigravity-oauth-token",
  ]);
});

test("tokenChanged: only a readable token whose hash differs from the seeded one", () => {
  const dir = mkdtempSync(join(tmpdir(), "agrav-token-"));
  tempRoots.push(dir);
  const token = join(dir, ".gemini", "antigravity-cli", "antigravity-oauth-token");
  assert.equal(tokenChanged(dir, "0".repeat(64)), false, "no token file");
  mkdirSync(dirname(token), { recursive: true });
  writeFileSync(token, "seeded");
  const seeded = createHash("sha256").update("seeded").digest("hex");
  assert.equal(tokenChanged(dir, seeded), false);
  assert.equal(tokenChanged(dir, null), false, "a token that could not be read when seeded is never a change");
  writeFileSync(token, "refreshed");
  assert.equal(tokenChanged(dir, seeded), true);
});

test("usageGateArgs gives the gate container a writable working directory", () => {
  const args = usageGateArgs(CONFIG, "/tmp/creds");
  assert.deepEqual(args, [
    "run",
    "--rm",
    "--pull",
    "never",
    "--user",
    USER_SPEC,
    "-e",
    "HOME=/home/agy",
    // The image's WORKDIR /workspace is root-owned 0755 and this container does
    // not bind-mount over it, so without -w agy has no writable cwd.
    "-w",
    "/home/agy",
    "-v",
    "/tmp/creds:/home/agy",
    CONFIG.image,
    "--usage",
  ]);
  assert.equal(args.indexOf("-w") < args.indexOf(CONFIG.image), true);
});

test("runner.yaml gives agy 30 minutes and docker two more", () => {
  // Spec §5: the maintenance-console task needs 30m; the outer docker timeout
  // stays longer, so agy's own timeout status is what gets recorded.
  assert.equal(CONFIG.printTimeout, "30m");
  assert.equal(CONFIG.timeoutMs, 1_920_000);
  assert.equal(CONFIG.timeoutMs - parseDurationMs(CONFIG.printTimeout), 120_000);
});

test("attemptArgs matches the harness contract", () => {
  assert.deepEqual(
    attemptArgs({
      config: CONFIG,
      row: ROW,
      attemptDir: "/repo/eval-attempts/gemini-38-flash-high-attempt-1",
      credsDir: "/tmp/creds",
      containerName: "agrav-gemini-38-flash-high-attempt-1",
      promptPath: "/repo/prompt.md",
    }),
    [
      "run",
      "--rm",
      "--pull",
      "never",
      "--name",
      "agrav-gemini-38-flash-high-attempt-1",
      "--user",
      USER_SPEC,
      "-e",
      "HOME=/home/agy",
      "-e",
      `TIMEOUT=${CONFIG.printTimeout}`,
      "-v",
      "/repo/eval-attempts/gemini-38-flash-high-attempt-1:/workspace",
      "-v",
      "/tmp/creds:/home/agy",
      // The prompt is mounted outside /workspace so it never lands in the
      // model's output.
      "-v",
      "/repo/prompt.md:/prompt.md:ro",
      CONFIG.image,
      "--model",
      "gemini-3.8-flash-high",
      "--effort",
      "high",
      "--prompt-file",
      "/prompt.md",
    ],
  );
});

test("a model that rejects --effort is invoked without the flag", () => {
  // agy 1.1.26 fails the run outright rather than ignoring the flag:
  //   --effort is not supported for model "claude-sonnet-4-6"   (exit 1)
  // Requiring --effort here is what made all three no-effort models
  // unrunnable before Phase 0, and it would have looked like a model failure.
  const row = CONFIG.matrix.find((candidate) => candidate.id === "claude-sonnet-46-high")!;
  assert.equal(row.effort, null);
  const args = attemptArgs({
    config: CONFIG,
    row,
    attemptDir: "/repo/eval-attempts/claude-sonnet-46-high-attempt-1",
    credsDir: "/tmp/creds",
    containerName: "agrav-claude-sonnet-46-high-attempt-1",
    promptPath: "/repo/prompt.md",
  });
  assert.equal(args.includes("--effort"), false);
  assert.deepEqual(args.slice(-4), ["--model", "claude-sonnet-4-6", "--prompt-file", "/prompt.md"]);
});

/**
 * The models agy 1.1.26 offers with no effort levels at all, verified in Phase 0
 * by running each one. `gpt-oss-120b-medium` is the trap: it *ends* in
 * `-medium`, but that is part of the model's name, not a level agy will accept
 * as `--effort` — it is refused exactly like the two Claude ids.
 */
const NO_EFFORT_MODELS = new Set(["claude-sonnet-4-6", "claude-opus-4-6-thinking", "gpt-oss-120b-medium"]);

test("every matrix row's effort agrees with the CLI model id it is paired with", () => {
  // The two ways agy rejects a mismatch, from Phase 0:
  //   --model gemini-3.8-flash-low conflicts with --effort=high
  //   --effort is not supported for model "claude-sonnet-4-6"
  // Both are exit 1 with an ERROR envelope, i.e. an attempt that never runs.
  for (const row of CONFIG.matrix) {
    if (NO_EFFORT_MODELS.has(row.model)) {
      assert.equal(row.effort, null, `${row.id}: agy refuses --effort for ${row.model}`);
      continue;
    }
    assert.notEqual(row.effort, null, `${row.id}: ${row.model} takes an effort level, so name it`);
    assert.ok(
      row.model.endsWith(`-${row.effort}`),
      `${row.id}: model ${row.model} and effort ${String(row.effort)} disagree; agy would refuse the run`,
    );
  }
});

/**
 * The three exported docker-run builders, named and built against one fixed
 * sample attempt. Shared by the tests below that check something true of all
 * three at once rather than pinning one argv array at a time.
 */
function builtCommands(): Array<[name: string, argv: string[]]> {
  return [
    ["credentialCopyArgs", credentialCopyArgs(CONFIG.image, "/tmp/creds", CONFIG.credentialFiles)],
    ["usageGateArgs", usageGateArgs(CONFIG, "/tmp/creds")],
    [
      "attemptArgs",
      attemptArgs({
        config: CONFIG,
        row: ROW,
        attemptDir: "/repo/eval-attempts/gemini-38-flash-high-attempt-1",
        credsDir: "/tmp/creds",
        containerName: "agrav-gemini-38-flash-high-attempt-1",
        promptPath: "/repo/prompt.md",
      }),
    ],
  ];
}

test("no container restricts networking or mounts the host's ~/.gemini", () => {
  for (const [, args] of builtCommands()) {
    // The model installs npm and PyPI packages while it works, and the task
    // lets it look things up, so full egress is required.
    assert.equal(args.includes("--network"), false, args.join(" "));
    assert.equal(args.includes("--sandbox"), false, args.join(" "));

    // The host's ~/.gemini holds a plaintext context7 API key on top of history
    // and project state, and is never mounted. `.gemini/antigravity-cli/…` does
    // now appear in the credential copy, but only as a path relative to the
    // credential volume — so the check is on absolute paths and on every mount
    // source, rather than on the substring.
    for (const arg of args) {
      assert.equal(/^[~/].*\.gemini/.test(arg), false, `absolute .gemini path in: ${args.join(" ")}`);
    }
    const mountSources = args.filter((_, i) => args[i - 1] === "-v").map((mount) => mount.split(":")[0]);
    for (const source of mountSources) {
      assert.equal(source.includes(".gemini"), false, `.gemini mounted in: ${args.join(" ")}`);
    }
  }
});

test("run-matrix never lets docker pull the harness image", () => {
  // (a) the three exported builders.
  for (const [name, args] of builtCommands()) {
    assert.deepEqual(args.slice(0, 4), ["run", "--rm", "--pull", "never"], `${name}: ${args.join(" ")}`);
  }

  // (b) the source itself, for the two sites `builtCommands()` doesn't reach:
  // `tokenPersistArgs` is not in it (its `/dst/.gemini/…` destination is inside
  // the container, which the absolute-path check above would misread as a host
  // mount), so only the source shows its argv, and the sign-in hint is built
  // from concatenated literals, not an argv array.
  const source = readFileSync(fileURLToPath(new URL("../scripts/run-matrix.ts", import.meta.url)), "utf8");
  const lineOf = (offset: number): number => source.slice(0, offset).split("\n").length;

  // Every `"run"` (or `'run'`) opening a docker argv array — followed by a
  // comma or a closing bracket either way — must be immediately followed by
  // "--rm", "--pull", "never", in the same quote style, whatever the
  // indentation between them. A sticky regex anchored at each match's offset
  // means indentation depth can never cause a false failure.
  const runLiterals = [...source.matchAll(/["']run["']\s*[,\]]/g)];
  const missingPullNever: string[] = [];
  for (const literal of runLiterals) {
    const offset = literal.index ?? 0;
    const quote = literal[0][0];
    const contract = new RegExp(
      `${quote}run${quote}\\s*,\\s*${quote}--rm${quote}\\s*,\\s*${quote}--pull${quote}\\s*,\\s*${quote}never${quote}\\s*,`,
      "y",
    );
    contract.lastIndex = offset;
    if (!contract.test(source)) missingPullNever.push(`scripts/run-matrix.ts:${lineOf(offset)}`);
  }
  assert.deepEqual(
    missingPullNever,
    [],
    `docker argv missing "--rm", "--pull", "never", right after "run" at: ${missingPullNever.join(", ")}`,
  );
  // Checked after the per-site failures above, so a fifth docker run added
  // later without the flag is reported by site rather than as a bare count
  // mismatch.
  assert.equal(
    runLiterals.length,
    4,
    `expected exactly 4 docker argv arrays in scripts/run-matrix.ts, found ${runLiterals.length} at lines ` +
      runLiterals.map((literal) => lineOf(literal.index ?? 0)).join(", "),
  );

  // The sign-in hint printed by requireCredentialsVolume: the one literal
  // `docker run` command outside an argv array. Pinning the count exactly, as
  // the argv half does, means a hint that disappears — or a second one —
  // fails the test instead of being silently skipped.
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const hints = [...withoutComments.matchAll(/docker run[^`'"]*/g)];
  assert.equal(
    hints.length,
    1,
    `expected exactly 1 literal \`docker run\` command in scripts/run-matrix.ts, found ${hints.length}`,
  );
  for (const hint of hints) {
    assert.match(hint[0], /--pull never/, `docker run command missing --pull never: ${hint[0]}`);
  }
});

// --- the CLI ----------------------------------------------------------------

test("--help prints the usage and exits 0", () => {
  const result = runMatrix("--help");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--only <id>/);
  assert.match(result.stdout, /--dry-run/);
  assert.match(result.stdout, /--root <path>/);
  assert.equal(result.stderr, "");
});

test("an unknown flag is refused", () => {
  const result = runMatrix("--parallel");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown argument "--parallel"/);
});

test("--attempts refuses a value that is not a positive integer", () => {
  for (const value of ["0", "-3", "2.5", "five"]) {
    const result = runMatrix("--attempts", value, "--dry-run");
    assert.equal(result.status, 1, `--attempts ${value}`);
    assert.match(result.stderr, /must be a positive integer/);
  }
});

test("--attempts refuses a count no filmstrip could be composed from", () => {
  // The bound comes from the far end of the pipeline: take-screenshots composes
  // a configuration's filmstrip as one Chromium page `panels x 1280` wide, and
  // 13 panels is 16640px, past what it renders. Refusing at the flag costs a
  // typo; discovering it after the runs costs the quota they spent.
  const result = runMatrix("--attempts", "13", "--dry-run");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--attempts 13 is above the 12-attempt ceiling/);
  assert.match(result.stderr, /16640px/);

  // The ceiling itself is allowed.
  assert.equal(runMatrix("--root", makeRoot(), "--only", "claude-opus-46-high", "--attempts", "12", "--dry-run").status, 0);
});

test("--only refuses an id that is not in the matrix", () => {
  const result = runMatrix("--root", makeRoot(), "--only", "gemini-99-pro-high", "--dry-run");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /is not a matrix id/);
});

test("--skip and its alias --exclude leave an id out", () => {
  for (const flag of ["--skip", "--exclude"]) {
    const result = runMatrix("--root", makeRoot(), flag, "gemini-38-flash-high", "--attempts", "1", "--dry-run");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`^dry run: ${CONFIG.matrix.length - 1} config\\(s\\) x 1 attempt\\(s\\)`, "m"));
    assert.equal(result.stdout.includes("gemini-38-flash-high-attempt-1"), false, result.stdout);
  }
});

test("--skip refuses an id that is not in the matrix", () => {
  const result = runMatrix("--root", makeRoot(), "--skip", "gemini-99-pro-high", "--dry-run");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--skip "gemini-99-pro-high" is not a matrix id/);
});

test("a flag's value is never the next flag", () => {
  // `--skip --dry-run` would otherwise skip an id named "--dry-run" and start a live run.
  for (const flag of ["--skip", "--exclude", "--only", "--attempts", "--root"]) {
    const result = runMatrix("--root", makeRoot(), flag, "--dry-run");
    assert.equal(result.status, 1, `${flag}: ${result.stdout}`);
    assert.match(result.stderr, new RegExp(`${flag} needs a value, not the flag "--dry-run"`));
  }
});

test("--only and --skip that leave nothing to run are refused", () => {
  const result = runMatrix("--root", makeRoot(), "--only", "gemini-38-flash-high", "--skip", "gemini-38-flash-high", "--dry-run");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /leave nothing to run/);
});

test("a runner.yaml whose credentialFiles omits the token file is refused", () => {
  // TOKEN_FILE is hard-coded here and declared there. If they drift, seeding
  // still works, the token hash reads nothing, and every token agy refreshes is
  // thrown away with the throwaway HOME — with no sign that anything is wrong.
  const root = makeRoot();
  const configFile = join(root, "benchmark", "runner.yaml");
  writeFileSync(
    configFile,
    readFileSync(configFile, "utf8").replace(/^ *- \.gemini\/antigravity-cli\/antigravity-oauth-token *$/m, ""),
  );
  const result = runMatrix("--root", root, "--only", "gemini-38-flash-high", "--attempts", "1", "--dry-run");
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /credentialFiles does not list \.gemini\/antigravity-cli\/antigravity-oauth-token/);
});

test("a root without prompt.md is refused before any container starts", () => {
  const root = makeRoot();
  rmSync(join(root, "prompt.md"));
  const result = runMatrix("--root", root, "--only", "gemini-38-flash-high", "--attempts", "1", "--dry-run");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /prompt\.md is missing/);
});

test("--dry-run prints the four docker commands and writes nothing", () => {
  const root = makeRoot();
  const result = runMatrix("--root", root, "--only", "gemini-38-flash-high", "--attempts", "1", "--dry-run");

  assert.equal(result.status, 0, result.stderr);
  const dockerLines = result.stdout.split("\n").filter((line) => line.trim().startsWith("docker run"));
  assert.equal(dockerLines.length, 4, result.stdout);

  // The printed forms of the four argv arrays asserted above, against this root.
  assert.match(
    dockerLines[0],
    new RegExp(`--entrypoint cp ${IMAGE_RE} --parents \\.gemini/antigravity-cli/antigravity-oauth-token`),
  );
  assert.match(dockerLines[1], new RegExp(`-w /home/agy .*${IMAGE_RE} --usage$`));
  assert.match(dockerLines[2], new RegExp(`${root}/eval-attempts/gemini-38-flash-high-attempt-1:/workspace`));
  assert.match(dockerLines[2], new RegExp(`${root}/prompt\\.md:/prompt\\.md:ro`));
  assert.match(dockerLines[2], /--model gemini-3\.8-flash-high --effort high --prompt-file \/prompt\.md$/);
  // The copy-back, the one container that mounts the credentials volume read-write, is listed too.
  assert.match(
    dockerLines[3],
    /docker run --rm --pull never .* -v '<creds>:\/src:ro' -v agy-creds:\/dst --entrypoint cp /,
  );

  // The real credential directory never reaches the log.
  for (const line of dockerLines) {
    assert.equal(/agrav-creds-/.test(line), false, `credential path leaked: ${line}`);
    assert.match(line, /<creds>/);
  }

  assert.match(result.stdout, /dry run complete — nothing was written\./);
  assert.equal(existsSync(join(root, "eval-attempts")), false);
  assert.equal(existsSync(join(root, "eval-results")), false);
});

const RESUME_SAMPLE: RunJson = {
  id: "gemini-31-pro-high",
  model: "gemini-3.1-pro-high",
  effort: "high",
  agyVersion: "1.1.26",
  image: "agrav-bench/harness:2026-09-05@sha256:0",
  startedAt: "2026-09-04T18:00:00.000Z",
  durationMs: 1000,
  exitCode: 0,
  envelope: null,
  stderrTail: "",
  softDenied: false,
  failureKind: null,
};

test("resume skips a finished attempt but re-runs one that failed on infra", () => {
  const root = makeRoot();
  const runJsonPath = join(root, "eval-results", "gemini-31-pro-high-attempt-1", "run.json");

  writeRunJson(runJsonPath, RESUME_SAMPLE);
  const done = runMatrix("--root", root, "--only", "gemini-31-pro-high", "--attempts", "1", "--dry-run");
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /skipped: .*run\.json already exists/);
  assert.equal(done.stdout.includes("would run:"), false, done.stdout);

  writeRunJson(runJsonPath, { ...RESUME_SAMPLE, failureKind: "infra" });
  const retried = runMatrix("--root", root, "--only", "gemini-31-pro-high", "--attempts", "1", "--dry-run");
  assert.equal(retried.status, 0, retried.stderr);
  assert.match(retried.stdout, /re-running: .*records an infra failure/);
  assert.match(retried.stdout, /would run:/);
});

test("--dry-run covers every attempt of every selected id", () => {
  const result = runMatrix(
    "--root",
    makeRoot(),
    "--only",
    "gemini-31-pro-high",
    "--only",
    "claude-opus-46-high",
    "--attempts",
    "2",
    "--dry-run",
  );
  assert.equal(result.status, 0, result.stderr);
  for (const dirName of [
    "gemini-31-pro-high-attempt-1",
    "gemini-31-pro-high-attempt-2",
    "claude-opus-46-high-attempt-1",
    "claude-opus-46-high-attempt-2",
  ]) {
    assert.match(result.stdout, new RegExp(`\\[${dirName}\\] would run:`));
  }
  assert.equal(result.stdout.split("\n").filter((line) => line.trim().startsWith("docker run")).length, 16);
});
