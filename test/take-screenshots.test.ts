/**
 * The screenshot script's pure helpers, and its do-nothing path.
 *
 * Nothing here launches a browser, starts a backend or a dev server, or
 * installs anything: the server half is driven with fakes in
 * `test/take-screenshots-processes.test.ts`. What is testable from the
 * filesystem alone is exactly what the dashboard depends on: where the
 * frontend is, which attempts are pictured at all, and the two filenames plus
 * the manifest key the cards look up.
 *
 * Importing `scripts/take-screenshots.ts` is itself a check: its entry point is
 * guarded, so a broken guard would start a capture run on import and fail this
 * whole file loudly.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import {
  buildHashManifest,
  discoverAttempts,
  filmstripFileName,
  filmstripPanels,
  filmstripsToRebuild,
  frontendRootOf,
  getExistingScreenshots,
  groupByBenchmarkId,
  hashManifestIsCurrent,
  orphanFilmstrips,
  parseArgs,
  planWork,
  prepareView,
  processAttempt,
  readHashManifest,
  repoPaths,
  screenshotFileName,
  selectAttempts,
  writeHashManifest,
  isPlanResponse,
  watchPageEvents,
  type AttemptInfo,
  type BrowserLike,
  type CaptureDeps,
  type CaptureResult,
  type PageLike,
  type ResponseLike,
} from "../scripts/take-screenshots";
import { writeRunJson, type RunJson } from "../scripts/lib/run-json";
import { DISABLED_MODELS } from "../eval-attempts/metadata";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../scripts/take-screenshots.ts", import.meta.url));
/** Holds a `docker` that fails every call, first on the CLI's PATH: a no-op run must never reach a real daemon. */
const DOCKER_REFUSED_DIR = fileURLToPath(new URL("./fixtures/docker-refused/", import.meta.url));

const tempRoots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agrav-shots-"));
  tempRoots.push(root);
  return root;
}

after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

/** An attempt directory holding `files` (path → contents), relative to it. */
function makeAttempt(root: string, dirName: string, files: Record<string, string> = {}): string {
  const dir = join(root, "eval-attempts", dirName);
  mkdirSync(dir, { recursive: true });
  for (const [relative, contents] of Object.entries(files)) {
    const path = join(dir, relative);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, contents, "utf8");
  }
  return dir;
}

const RUN_JSON: RunJson = {
  id: "gemini-38-flash-low",
  model: "TODO-cli-id",
  effort: "low",
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

/** Collect diagnostics instead of printing them, so test output stays clean. */
function collector(): { warn: (message: string) => void; messages: string[] } {
  const messages: string[] = [];
  return { warn: (message: string) => messages.push(message), messages };
}

// --- the frontend root ---------------------------------------------------------

test("frontendRootOf is <attempt>/frontend when it holds a package.json", () => {
  const root = makeRoot();
  const dir = makeAttempt(root, "gemini-38-flash-low-attempt-1", {
    "frontend/package.json": "{}",
    "backend/requirements.txt": "fastapi\n",
  });
  assert.equal(frontendRootOf(dir), join(dir, "frontend"));
});

test("frontendRootOf is null without frontend/package.json, wherever else a package.json is", () => {
  const root = makeRoot();
  // The run contract pins the layout: a project at the top, or in any other
  // subdirectory, is not where the contract says, and is not searched for.
  const topLevel = makeAttempt(root, "gemini-38-flash-low-attempt-2", { "package.json": "{}" });
  assert.equal(frontendRootOf(topLevel), null);
  const elsewhere = makeAttempt(root, "gemini-38-flash-low-attempt-3", { "web/package.json": "{}", "frontend/src/main.tsx": "" });
  assert.equal(frontendRootOf(elsewhere), null);
  assert.equal(frontendRootOf(join(root, "eval-attempts", "no-such-attempt-1")), null);
});

test("frontendRootOf does not take a directory named package.json for the file", () => {
  const root = makeRoot();
  const dir = makeAttempt(root, "gemini-38-flash-low-attempt-4", { "frontend/package.json/index.js": "" });
  assert.equal(frontendRootOf(dir), null);
});

// --- discovery ---------------------------------------------------------------

test("discoverAttempts returns nothing for a repo with no eval-attempts directory", () => {
  const { warn, messages } = collector();
  assert.deepEqual(discoverAttempts(makeRoot(), warn), []);
  assert.deepEqual(messages, []);
});

test("discoverAttempts carries the benchmark id, attempt number, directory and frontend root", () => {
  const root = makeRoot();
  makeAttempt(root, "gemini-38-flash-low-attempt-2", { "frontend/package.json": "{}" });
  makeAttempt(root, "claude-opus-46-high-attempt-1", { "frontend/package.json": "{}", "backend/app/main.py": "" });

  const { warn, messages } = collector();
  assert.deepEqual(discoverAttempts(root, warn), [
    {
      dirName: "claude-opus-46-high-attempt-1",
      benchmarkId: "claude-opus-46-high",
      attempt: 1,
      attemptDir: join(root, "eval-attempts", "claude-opus-46-high-attempt-1"),
      frontendRoot: join(root, "eval-attempts", "claude-opus-46-high-attempt-1", "frontend"),
      modelFailure: false,
    },
    {
      dirName: "gemini-38-flash-low-attempt-2",
      benchmarkId: "gemini-38-flash-low",
      attempt: 2,
      attemptDir: join(root, "eval-attempts", "gemini-38-flash-low-attempt-2"),
      frontendRoot: join(root, "eval-attempts", "gemini-38-flash-low-attempt-2", "frontend"),
      modelFailure: false,
    },
  ]);
  assert.deepEqual(messages, []);
});

test("discoverAttempts keeps an attempt with no frontend/package.json, as a frontend stop", () => {
  const root = makeRoot();
  makeAttempt(root, "gemini-38-flash-low-attempt-1", { "notes.txt": "nothing runnable", "package.json": "{}" });

  const { warn } = collector();
  const attempts = discoverAttempts(root, warn);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].frontendRoot, null);
  assert.equal(attempts[0].modelFailure, false);
});

test('discoverAttempts skips an attempt whose run.json records failureKind "infra"', () => {
  const root = makeRoot();
  makeAttempt(root, "gemini-38-flash-low-attempt-1", { "frontend/package.json": "{}" });
  makeAttempt(root, "gemini-38-flash-low-attempt-2", { "frontend/package.json": "{}" });
  makeAttempt(root, "gemini-38-flash-low-attempt-3", { "frontend/package.json": "{}" });
  writeRunJson(join(root, "eval-results", "gemini-38-flash-low-attempt-1", "run.json"), RUN_JSON);
  writeRunJson(join(root, "eval-results", "gemini-38-flash-low-attempt-2", "run.json"), {
    ...RUN_JSON,
    failureKind: "infra",
  });
  writeRunJson(join(root, "eval-results", "gemini-38-flash-low-attempt-3", "run.json"), {
    ...RUN_JSON,
    failureKind: "model",
  });

  const { warn, messages } = collector();
  const attempts = discoverAttempts(root, warn);
  // A clean run and a model failure are both data points and both get a tile;
  // only the infra failure — which process-results.ts also drops — is skipped.
  assert.deepEqual(
    attempts.map((attempt) => attempt.dirName),
    ["gemini-38-flash-low-attempt-1", "gemini-38-flash-low-attempt-3"],
  );
  // The model failure keeps its tile, but as a card: nothing is served for it.
  assert.deepEqual(
    attempts.map((attempt) => attempt.modelFailure),
    [false, true],
  );
  assert.deepEqual(messages, [
    "warning: skipping gemini-38-flash-low-attempt-2 — run.json records an infrastructure failure, not a data point.",
  ]);
});

test("discoverAttempts skips a disabled model, once, without deleting its pictures", () => {
  // The seam these two scripts share: process-results.ts drops every attempt of
  // a DISABLED_MODELS id, and this script did not import the set at all — so a
  // disabled configuration was still installed, dev-served, photographed and
  // hashed, for a family the dashboard does not show.
  const root = makeRoot();
  makeAttempt(root, "gemini-38-flash-low-attempt-1", { "frontend/package.json": "{}" });
  makeAttempt(root, "gemini-38-flash-low-attempt-2", { "frontend/package.json": "{}" });
  makeAttempt(root, "gemini-31-pro-high-attempt-1", { "frontend/package.json": "{}" });
  const png = join(root, "website", "public", "screenshots", "gemini-38-flash-low-attempt-1.png");
  mkdirSync(join(png, ".."), { recursive: true });
  writeFileSync(png, "not really a png", "utf8");

  DISABLED_MODELS.add("gemini-38-flash-low");
  let attempts: ReturnType<typeof discoverAttempts>;
  let messages: string[];
  try {
    const collected = collector();
    attempts = discoverAttempts(root, collected.warn);
    messages = collected.messages;
  } finally {
    DISABLED_MODELS.delete("gemini-38-flash-low");
  }

  assert.deepEqual(
    attempts.map((attempt) => attempt.dirName),
    ["gemini-31-pro-high-attempt-1"],
  );
  // One warning for the id, not one per attempt.
  assert.equal(messages.length, 1, messages.join("\n"));
  assert.match(messages[0], /skipping every attempt of "gemini-38-flash-low"/);
  // Re-enabling a configuration should not mean re-capturing it.
  assert.equal(existsSync(png), true, "a disabled id's screenshots must be left alone, not deleted");
});

test("a configuration pictured more times than it was scored says so before it is published", () => {
  // take-screenshots discovers from eval-attempts/, process-results requires an
  // eval-results.csv. Run 5, score 3, capture, and the card reads "3 attempts"
  // beside a 5-panel filmstrip — and filmstripsToRebuild stays silent, because
  // the strip does match the PNGs behind it.
  const root = makeRoot();
  for (const n of [1, 2, 3]) makeAttempt(root, `gemini-38-flash-low-attempt-${n}`, { "frontend/package.json": "{}" });
  for (const n of [1, 2]) {
    const dir = join(root, "eval-results", `gemini-38-flash-low-attempt-${n}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "eval-results.csv"), "Criterion,Score,Max,Notes\n", "utf8");
  }

  const { warn, messages } = collector();
  planWork(root, { warn });

  const mismatch = messages.filter((message) => message.includes("eval-results.csv"));
  assert.equal(mismatch.length, 1, messages.join("\n"));
  assert.match(mismatch[0], /gemini-38-flash-low has 3 attempt\(s\) to picture but only 2/);
  assert.match(mismatch[0], /"2 attempts" beside a 3-panel filmstrip/);
});

test("a configuration scored as often as it is pictured says nothing, and neither does one not scored at all", () => {
  const root = makeRoot();
  for (const n of [1, 2]) {
    makeAttempt(root, `gemini-38-flash-low-attempt-${n}`, { "frontend/package.json": "{}" });
    const dir = join(root, "eval-results", `gemini-38-flash-low-attempt-${n}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "eval-results.csv"), "Criterion,Score,Max,Notes\n", "utf8");
  }
  // Captured but not yet scored: the ordinary state of a fresh run. It has no
  // card on the dashboard, so there is nothing for its filmstrip to contradict,
  // and warning here would bury the case that matters.
  makeAttempt(root, "gemini-31-pro-high-attempt-1", { "frontend/package.json": "{}" });

  const { warn, messages } = collector();
  planWork(root, { warn });
  assert.deepEqual(
    messages.filter((message) => message.includes("eval-results.csv")),
    [],
  );
});

test("discoverAttempts captures an attempt whose run.json is malformed, and says so", () => {
  const root = makeRoot();
  makeAttempt(root, "gemini-38-flash-low-attempt-1", { "frontend/package.json": "{}" });
  const runJsonPath = join(root, "eval-results", "gemini-38-flash-low-attempt-1", "run.json");
  mkdirSync(join(runJsonPath, ".."), { recursive: true });
  writeFileSync(runJsonPath, "{ not json", "utf8");

  const { warn, messages } = collector();
  assert.equal(discoverAttempts(root, warn).length, 1);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /not valid JSON.*capturing gemini-38-flash-low-attempt-1 anyway/s);
});

test("discoverAttempts ignores a directory that is not an attempt name", () => {
  const root = makeRoot();
  makeAttempt(root, "gemini_36_flash_low-attempt-1", { "frontend/package.json": "{}" });
  makeAttempt(root, "scratch", { "frontend/package.json": "{}" });

  const { warn, messages } = collector();
  assert.deepEqual(discoverAttempts(root, warn), []);
  assert.equal(messages.length, 2);
  for (const message of messages) assert.match(message, /not an attempt directory name/);
});

test("discoverAttempts warns about an id that is not in the model catalogue", () => {
  const root = makeRoot();
  makeAttempt(root, "gemini-99-pro-high-attempt-1", { "frontend/package.json": "{}" });

  const { warn, messages } = collector();
  assert.equal(discoverAttempts(root, warn).length, 1);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /"gemini-99-pro-high" is not a known benchmark id/);
});

// --- names the dashboard looks up --------------------------------------------

test("screenshotFileName is the attempt id the dashboard looks up", () => {
  // ResultCard.tsx: `${attempt.id}.png`, where attempt.id is the directory name.
  assert.equal(screenshotFileName("gemini-38-flash-low-attempt-1"), "gemini-38-flash-low-attempt-1.png");
  assert.equal(screenshotFileName("gpt-oss-120b-med-attempt-12"), "gpt-oss-120b-med-attempt-12.png");
});

test("filmstripFileName is per (model, effort), never per family", () => {
  // ModelAveragesCard.tsx: `${average.modelBaseId}_filmstrip.png`, and in
  // modelAverages modelBaseId is the benchmark id.
  assert.equal(filmstripFileName("gemini-38-flash-low"), "gemini-38-flash-low_filmstrip.png");
  assert.notEqual(filmstripFileName("gemini-38-flash-low"), filmstripFileName("gemini-38-flash-high"));
});

test("groupByBenchmarkId keeps effort levels apart and orders attempts numerically", () => {
  const groups = groupByBenchmarkId([
    "gemini-38-flash-low-attempt-10.png",
    "gemini-38-flash-low-attempt-2.png",
    "gemini-38-flash-low-attempt-1.png",
    "gemini-38-flash-high-attempt-1.png",
    "not-an-attempt.png",
  ]);

  // Two configurations of one family are two filmstrips, not one.
  assert.deepEqual([...groups.keys()], ["gemini-38-flash-high", "gemini-38-flash-low"]);
  assert.deepEqual(groups.get("gemini-38-flash-low"), [
    "gemini-38-flash-low-attempt-1.png",
    "gemini-38-flash-low-attempt-2.png",
    "gemini-38-flash-low-attempt-10.png",
  ]);
});

test("getExistingScreenshots lists attempt ids and never a filmstrip", () => {
  const root = makeRoot();
  const dir = join(root, "website", "public", "screenshots");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "gemini-38-flash-low-attempt-1.png"), "a");
  writeFileSync(join(dir, "gemini-38-flash-low_filmstrip.png"), "b");
  writeFileSync(join(dir, "notes.txt"), "c");

  assert.deepEqual([...getExistingScreenshots(dir)], ["gemini-38-flash-low-attempt-1"]);
  assert.deepEqual([...getExistingScreenshots(join(root, "nope"))], []);
});

// --- the hash manifest --------------------------------------------------------

test("buildHashManifest keys on the bare filename, with an 8-char md5 prefix", () => {
  const root = makeRoot();
  const dir = join(root, "website", "public", "screenshots");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "gemini-38-flash-low-attempt-1.png"), "first");
  writeFileSync(join(dir, "gemini-38-flash-low_filmstrip.png"), "strip");
  writeFileSync(join(dir, "README.md"), "not a png");

  const hashes = buildHashManifest(dir);
  // Bare filenames, not paths: a path-keyed manifest silently disables cache
  // busting without failing anything.
  assert.deepEqual(Object.keys(hashes), [
    "gemini-38-flash-low-attempt-1.png",
    "gemini-38-flash-low_filmstrip.png",
  ]);
  assert.equal(
    hashes["gemini-38-flash-low-attempt-1.png"],
    createHash("md5").update("first").digest("hex").slice(0, 8),
  );
  for (const hash of Object.values(hashes)) assert.match(hash, /^[0-9a-f]{8}$/);
});

test("buildHashManifest is empty when no screenshot has ever been taken", () => {
  assert.deepEqual(buildHashManifest(join(makeRoot(), "website", "public", "screenshots")), {});
});

test("writeHashManifest creates its parent directory", () => {
  // The default root's website/src/data/ is committed, but a --root one is not,
  // and this is the last line of a run that has already paid for every capture.
  const path = join(makeRoot(), "website", "src", "data", "screenshot-hashes.json");
  writeHashManifest(path, { "a.png": "0123abcd" });
  assert.deepEqual(readHashManifest(path), { "a.png": "0123abcd" });
});

test("hashManifestIsCurrent tells a fresh manifest from a stale or broken one", () => {
  const path = join(makeRoot(), "website", "src", "data", "screenshot-hashes.json");
  const hashes = { "a.png": "0123abcd", "b_filmstrip.png": "beefcafe" };

  // No file and nothing to record is current — that is the empty repo, and it
  // must not provoke a write.
  assert.equal(hashManifestIsCurrent(path, {}), true);
  assert.equal(hashManifestIsCurrent(path, hashes), false);

  writeHashManifest(path, hashes);
  assert.equal(hashManifestIsCurrent(path, hashes), true);
  assert.equal(hashManifestIsCurrent(path, { ...hashes, "a.png": "ffffffff" }), false);
  assert.equal(hashManifestIsCurrent(path, { "a.png": "0123abcd" }), false);

  writeFileSync(path, "{ truncated", "utf8");
  assert.equal(readHashManifest(path), null);
  assert.equal(hashManifestIsCurrent(path, hashes), false);
});

// --- filmstrip staleness -------------------------------------------------------

/** A screenshots directory holding the named files, each with unique contents. */
function makeScreenshotsDir(root: string, files: string[]): string {
  const dir = join(root, "website", "public", "screenshots");
  mkdirSync(dir, { recursive: true });
  for (const file of files) writeFileSync(join(dir, file), `bytes of ${file}`, "utf8");
  return dir;
}

test("filmstripsToRebuild names the configurations whose filmstrip is absent", () => {
  const root = makeRoot();
  const dir = makeScreenshotsDir(root, [
    "gemini-38-flash-low-attempt-1.png",
    "gemini-38-flash-low-attempt-2.png",
    "gemini-38-flash-high-attempt-1.png",
    "gemini-38-flash-low_filmstrip.png",
  ]);
  const manifestPath = repoPaths(root).hashManifestPath;
  writeHashManifest(manifestPath, buildHashManifest(dir));

  // One group has its filmstrip, the other does not — and a family filmstrip is
  // never expected, so `gemini-38-flash` is not in the answer.
  assert.deepEqual(filmstripsToRebuild(dir, manifestPath), ["gemini-38-flash-high"]);

  makeScreenshotsDir(root, ["gemini-38-flash-high_filmstrip.png"]);
  writeHashManifest(manifestPath, buildHashManifest(dir));
  assert.deepEqual(filmstripsToRebuild(dir, manifestPath), []);
});

test("filmstripsToRebuild is empty when nothing has been captured", () => {
  const root = makeRoot();
  assert.deepEqual(
    filmstripsToRebuild(join(root, "website", "public", "screenshots"), repoPaths(root).hashManifestPath),
    [],
  );
});

test("filmstripsToRebuild catches a group whose PNG set shrank without a capture", () => {
  const root = makeRoot();
  const dir = makeScreenshotsDir(root, [
    "gemini-38-flash-low-attempt-1.png",
    "gemini-38-flash-low-attempt-2.png",
    "gemini-38-flash-low_filmstrip.png",
  ]);
  const manifestPath = repoPaths(root).hashManifestPath;
  writeHashManifest(manifestPath, buildHashManifest(dir));
  assert.deepEqual(filmstripsToRebuild(dir, manifestPath), []);

  // Attempt 2 was re-run and came back an infrastructure failure, so its tile
  // was deleted. The filmstrip still shows it, and nothing is missing.
  rmSync(join(dir, "gemini-38-flash-low-attempt-2.png"));
  assert.deepEqual(filmstripsToRebuild(dir, manifestPath), ["gemini-38-flash-low"]);
});

test("filmstripsToRebuild catches a group that gained a PNG behind the script's back", () => {
  const root = makeRoot();
  const dir = makeScreenshotsDir(root, [
    "gemini-38-flash-low-attempt-1.png",
    "gemini-38-flash-low_filmstrip.png",
  ]);
  const manifestPath = repoPaths(root).hashManifestPath;
  writeHashManifest(manifestPath, buildHashManifest(dir));

  makeScreenshotsDir(root, ["gemini-38-flash-low-attempt-2.png"]);
  assert.deepEqual(filmstripsToRebuild(dir, manifestPath), ["gemini-38-flash-low"]);
});

test("filmstripsToRebuild treats a manifest that knows nothing as no baseline, not as staleness", () => {
  const root = makeRoot();
  const dir = makeScreenshotsDir(root, [
    "gemini-38-flash-low-attempt-1.png",
    "gemini-38-flash-low_filmstrip.png",
  ]);
  const manifestPath = repoPaths(root).hashManifestPath;

  // Absent, empty, and unreadable all mean "cannot tell" — never "rebuild
  // everything", which would cost a browser launch on a repo that is fine.
  assert.deepEqual(filmstripsToRebuild(dir, manifestPath), []);
  writeHashManifest(manifestPath, {});
  assert.deepEqual(filmstripsToRebuild(dir, manifestPath), []);
  writeFileSync(manifestPath, "not json", "utf8");
  assert.deepEqual(filmstripsToRebuild(dir, manifestPath), []);
});

test("filmstripsToRebuild ignores hash drift — that is a manifest problem, not a filmstrip one", () => {
  const root = makeRoot();
  const dir = makeScreenshotsDir(root, [
    "gemini-38-flash-low-attempt-1.png",
    "gemini-38-flash-low_filmstrip.png",
  ]);
  const manifestPath = repoPaths(root).hashManifestPath;
  writeHashManifest(manifestPath, {
    "gemini-38-flash-low-attempt-1.png": "deadbeef",
    "gemini-38-flash-low_filmstrip.png": "deadbeef",
  });

  assert.deepEqual(filmstripsToRebuild(dir, manifestPath), []);
});

test("filmstripPanels reads the panel count out of a filmstrip's own header", () => {
  const root = makeRoot();
  const dir = makeScreenshotsDir(root, []);
  writeFilmstrip(dir, "gemini-38-flash-low", 5);
  assert.equal(filmstripPanels(join(dir, "gemini-38-flash-low_filmstrip.png")), 5);

  // Anything it cannot measure means "cannot tell", never "stale": a fixture, a
  // half-written file or a foreign PNG must not be able to launch a browser.
  writeFileSync(join(dir, "not-a-png_filmstrip.png"), "bytes of a filmstrip", "utf8");
  assert.equal(filmstripPanels(join(dir, "not-a-png_filmstrip.png")), null);
  assert.equal(filmstripPanels(join(dir, "absent_filmstrip.png")), null);

  // A width that is not a whole number of tiles was not composed by this script.
  const odd = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(odd, 0);
  odd.writeUInt32BE(13, 8);
  odd.write("IHDR", 12, "latin1");
  odd.writeUInt32BE(1000, 16);
  writeFileSync(join(dir, "odd_filmstrip.png"), odd);
  assert.equal(filmstripPanels(join(dir, "odd_filmstrip.png")), null);
});

test("filmstripsToRebuild trusts the filmstrip's own panel count, with no manifest at all", () => {
  const root = makeRoot();
  const dir = makeScreenshotsDir(root, [
    "gemini-38-flash-low-attempt-1.png",
    "gemini-38-flash-low-attempt-2.png",
  ]);
  const manifestPath = repoPaths(root).hashManifestPath;
  writeFilmstrip(dir, "gemini-38-flash-low", 2);
  assert.deepEqual(filmstripsToRebuild(dir, manifestPath), []);

  // The manifest is blind here — this is the per-group "cannot tell" hole — but
  // the filmstrip measures itself, so a shrink is caught anyway.
  rmSync(join(dir, "gemini-38-flash-low-attempt-2.png"));
  assert.deepEqual(filmstripsToRebuild(dir, manifestPath), ["gemini-38-flash-low"]);

  // And a group that gained one, equally.
  makeScreenshotsDir(root, ["gemini-38-flash-low-attempt-2.png", "gemini-38-flash-low-attempt-3.png"]);
  assert.deepEqual(filmstripsToRebuild(dir, manifestPath), ["gemini-38-flash-low"]);
});

test("planWork: a repair --only declined to make is said out loud", () => {
  const root = makeRoot();
  makeAttempt(root, "gemini-38-flash-low-attempt-1", { "frontend/package.json": "{}" });
  makeAttempt(root, "claude-opus-46-high-attempt-1", { "frontend/package.json": "{}" });
  const dir = makeScreenshotsDir(root, [
    "gemini-38-flash-low-attempt-1.png",
    "claude-opus-46-high-attempt-1.png",
  ]);
  writeFilmstrip(dir, "gemini-38-flash-low", 3); // built from attempts that are gone
  writeFilmstrip(dir, "claude-opus-46-high", 1);
  writeHashManifest(repoPaths(root).hashManifestPath, buildHashManifest(dir));

  const { warn, messages } = collector();
  const plan = planWork(root, { only: ["claude-opus-46-high"], warn });
  assert.deepEqual(plan.stripsToRebuild, []);
  assert.deepEqual(plan.deferredStrips, ["gemini-38-flash-low"]);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /gemini-38-flash-low_filmstrip\.png no longer matches/);
  assert.match(messages[0], /--only gemini-38-flash-low/);
});

test("orphanFilmstrips names a filmstrip whose attempts are all gone", () => {
  const root = makeRoot();
  const dir = makeScreenshotsDir(root, [
    "gemini-38-flash-low-attempt-1.png",
    "gemini-38-flash-low_filmstrip.png",
    "gemini-31-pro-low_filmstrip.png",
  ]);

  // A filmstrip of zero attempts cannot be rebuilt, so it is named, not queued.
  assert.deepEqual(orphanFilmstrips(dir), ["gemini-31-pro-low_filmstrip.png"]);
  assert.deepEqual(filmstripsToRebuild(dir, repoPaths(root).hashManifestPath), []);
});

// --- the work plan, decided before anything is launched ------------------------

/** A repo whose attempts are all captured, with filmstrips and a live manifest. */
function makeCapturedRepo(): { root: string; manifestPath: string } {
  const root = makeRoot();
  makeAttempt(root, "gemini-38-flash-low-attempt-1", { "frontend/package.json": "{}" });
  const dir = makeScreenshotsDir(root, [
    "gemini-38-flash-low-attempt-1.png",
    "gemini-38-flash-low_filmstrip.png",
  ]);
  const manifestPath = repoPaths(root).hashManifestPath;
  writeHashManifest(manifestPath, buildHashManifest(dir));
  return { root, manifestPath };
}

test("planWork: a fully captured repo needs no browser and is a no-op", () => {
  const { root } = makeCapturedRepo();
  const plan = planWork(root, { warn: () => {} });
  assert.deepEqual(plan.pending, []);
  assert.deepEqual(plan.stripsToRebuild, []);
  assert.equal(plan.manifestCurrent, true);
  assert.equal(plan.needsBrowser, false);
  assert.equal(plan.isNoOp, true);
});

test("planWork: a new attempt beside captured ones is the only thing captured", () => {
  const { root } = makeCapturedRepo();
  makeAttempt(root, "gemini-38-flash-low-attempt-2", { "frontend/package.json": "{}" });

  const plan = planWork(root, { warn: () => {} });
  assert.deepEqual(
    plan.pending.map((attempt) => attempt.dirName),
    ["gemini-38-flash-low-attempt-2"],
  );
  assert.equal(plan.alreadyPictured, 1);
  assert.equal(plan.total, 2);
  assert.equal(plan.needsBrowser, true);
  assert.equal(plan.isNoOp, false);
});

test("planWork: --force re-captures an attempt that already has a screenshot", () => {
  const { root } = makeCapturedRepo();
  assert.equal(planWork(root, { warn: () => {} }).isNoOp, true);

  const forced = planWork(root, { force: true, warn: () => {} });
  assert.deepEqual(
    forced.pending.map((attempt) => attempt.dirName),
    ["gemini-38-flash-low-attempt-1"],
  );
  assert.equal(forced.needsBrowser, true);
  assert.equal(forced.isNoOp, false);
});

test("planWork: a missing filmstrip alone is enough to need a browser", () => {
  const { root } = makeCapturedRepo();
  rmSync(join(repoPaths(root).screenshotsDir, "gemini-38-flash-low_filmstrip.png"));

  const plan = planWork(root, { warn: () => {} });
  assert.deepEqual(plan.pending, []);
  assert.deepEqual(plan.stripsToRebuild, ["gemini-38-flash-low"]);
  assert.equal(plan.needsBrowser, true);
  assert.equal(plan.isNoOp, false);
});

/**
 * A filmstrip PNG whose header says it was composed from `panels` screenshots.
 *
 * Only the signature and the IHDR chunk matter — the script measures a
 * filmstrip by its width, never by rendering it — so this is a real enough PNG
 * for the check under test and needs no browser to produce.
 */
function writeFilmstrip(screenshotsDir: string, benchmarkId: string, panels: number): void {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(panels * 1280, 8);
  ihdr.writeUInt32BE(720, 12);
  writeFileSync(
    join(screenshotsDir, filmstripFileName(benchmarkId)),
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr]),
  );
}

test("a scoped run does not erase the staleness baseline for groups outside its scope", () => {
  const root = makeRoot();
  makeAttempt(root, "gemini-38-flash-low-attempt-1", { "frontend/package.json": "{}" });
  makeAttempt(root, "gemini-38-flash-low-attempt-2", { "frontend/package.json": "{}" });
  makeAttempt(root, "claude-opus-46-high-attempt-1", { "frontend/package.json": "{}" });
  const dir = makeScreenshotsDir(root, [
    "gemini-38-flash-low-attempt-1.png",
    "gemini-38-flash-low-attempt-2.png",
    "claude-opus-46-high-attempt-1.png",
  ]);
  writeFilmstrip(dir, "gemini-38-flash-low", 2);
  writeFilmstrip(dir, "claude-opus-46-high", 1);
  writeHashManifest(repoPaths(root).hashManifestPath, buildHashManifest(dir));
  assert.equal(planWork(root, { warn: () => {} }).isNoOp, true);

  // Attempt 2 is re-run, comes back an infrastructure failure, and its tile is
  // deleted. The low filmstrip is now a strip of two for a group of one.
  writeRunJson(join(root, "eval-results", "gemini-38-flash-low-attempt-2", "run.json"), {
    ...RUN_JSON,
    failureKind: "infra",
  });
  rmSync(join(dir, "gemini-38-flash-low-attempt-2.png"));
  assert.deepEqual(planWork(root, { warn: () => {} }).stripsToRebuild, ["gemini-38-flash-low"]);

  // A scoped run for the *other* configuration. It captures nothing and rebuilds
  // nothing, but it does resync the hash manifest.
  const result = runScreenshots("--root", root, "--only", "claude-opus-46-high");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes("Launching Chromium"), false, result.stdout);

  // The repair it declined to make must still be visible to the next run.
  assert.deepEqual(planWork(root, { warn: () => {} }).stripsToRebuild, ["gemini-38-flash-low"]);
});

test("planWork: a filmstrip whose group lost an attempt is rebuilt, not left stale", () => {
  const { root } = makeCapturedRepo();
  const dir = repoPaths(root).screenshotsDir;
  // A second captured attempt, in the filmstrip and in the manifest.
  makeAttempt(root, "gemini-38-flash-low-attempt-2", { "frontend/package.json": "{}" });
  makeScreenshotsDir(root, ["gemini-38-flash-low-attempt-2.png"]);
  writeHashManifest(repoPaths(root).hashManifestPath, buildHashManifest(dir));
  assert.equal(planWork(root, { warn: () => {} }).isNoOp, true);

  // Attempt 2 is re-run and comes back an infrastructure failure, so
  // discoverAttempts drops it and its now-stale tile is deleted. Nothing is
  // missing and nothing is pending — but the filmstrip still shows an attempt
  // the dashboard no longer has, which used to go unnoticed forever.
  writeRunJson(join(root, "eval-results", "gemini-38-flash-low-attempt-2", "run.json"), {
    ...RUN_JSON,
    failureKind: "infra",
  });
  rmSync(join(dir, "gemini-38-flash-low-attempt-2.png"));

  const plan = planWork(root, { warn: () => {} });
  assert.deepEqual(plan.pending, []);
  assert.deepEqual(plan.stripsToRebuild, ["gemini-38-flash-low"]);
  assert.equal(plan.needsBrowser, true);
  assert.equal(plan.isNoOp, false);
});

test("planWork: a filmstrip with no attempts left is reported, not queued", () => {
  const { root } = makeCapturedRepo();
  // A configuration whose every attempt is gone. Rebuilding a filmstrip of zero
  // attempts is not a thing that can be done, so it is named instead.
  makeScreenshotsDir(root, ["gemini-31-pro-low_filmstrip.png"]);

  const { warn, messages } = collector();
  const plan = planWork(root, { warn });
  assert.deepEqual(plan.stripsToRebuild, []);
  assert.equal(plan.needsBrowser, false);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /gemini-31-pro-low_filmstrip\.png has no attempt screenshots behind it/);
  assert.match(messages[0], /Delete it/);
});

test("planWork: --only scopes both the captures and the filmstrip repairs", () => {
  const { root } = makeCapturedRepo();
  makeAttempt(root, "claude-opus-46-high-attempt-1", { "frontend/package.json": "{}" });
  // A filmstrip missing for a configuration the run was not asked about.
  makeScreenshotsDir(root, ["gemini-31-pro-low-attempt-1.png"]);

  const scoped = planWork(root, { only: ["claude-opus-46-high"], warn: () => {} });
  assert.deepEqual(
    scoped.pending.map((attempt) => attempt.dirName),
    ["claude-opus-46-high-attempt-1"],
  );
  assert.deepEqual(scoped.stripsToRebuild, []);

  // Unscoped, the same repo has the other configuration's filmstrip to build.
  assert.deepEqual(planWork(root, { warn: () => {} }).stripsToRebuild, ["gemini-31-pro-low"]);
});

test("planWork: --force --only retries one configuration, not all of them", () => {
  const { root } = makeCapturedRepo();
  makeAttempt(root, "claude-opus-46-high-attempt-1", { "frontend/package.json": "{}" });
  makeScreenshotsDir(root, [
    "claude-opus-46-high-attempt-1.png",
    "claude-opus-46-high_filmstrip.png",
  ]);

  assert.equal(planWork(root, { force: true, warn: () => {} }).pending.length, 2);
  assert.deepEqual(
    planWork(root, { force: true, only: ["gemini-38-flash-low"], warn: () => {} }).pending.map((a) => a.dirName),
    ["gemini-38-flash-low-attempt-1"],
  );
});

test("selectAttempts keeps --only order, de-duplicates, and refuses a typo", () => {
  const root = makeRoot();
  makeAttempt(root, "gemini-38-flash-low-attempt-2", { "frontend/package.json": "{}" });
  makeAttempt(root, "gemini-38-flash-low-attempt-1", { "frontend/package.json": "{}" });
  makeAttempt(root, "claude-opus-46-high-attempt-1", { "frontend/package.json": "{}" });
  const attempts = discoverAttempts(root, () => {});

  assert.deepEqual(
    selectAttempts(attempts, ["gemini-38-flash-low", "claude-opus-46-high", "gemini-38-flash-low"]).map(
      (attempt) => attempt.dirName,
    ),
    [
      "gemini-38-flash-low-attempt-1",
      "gemini-38-flash-low-attempt-2",
      "claude-opus-46-high-attempt-1",
    ],
  );
  assert.deepEqual(selectAttempts(attempts, []), attempts);
  assert.deepEqual(selectAttempts(attempts, undefined), attempts);

  // A typo must not read as "nothing to do".
  assert.throws(
    () => selectAttempts(attempts, ["gemini-38-flash-lwo"]),
    /--only "gemini-38-flash-lwo" is not a benchmark id and matches no attempt directory/,
  );
});

test("selectAttempts accepts a catalogue id with no attempts yet, and an on-disk id with no catalogue entry", () => {
  const root = makeRoot();
  makeAttempt(root, "gemini-99-pro-high-attempt-1", { "frontend/package.json": "{}" });
  const attempts = discoverAttempts(root, () => {});

  // In the catalogue, nothing on disk: an empty selection, not an error.
  assert.deepEqual(selectAttempts(attempts, ["claude-opus-46-high"]), []);
  // On disk, not in the catalogue: discoverAttempts warns but still captures it,
  // so --only has to be able to name it.
  assert.deepEqual(
    selectAttempts(attempts, ["gemini-99-pro-high"]).map((attempt) => attempt.dirName),
    ["gemini-99-pro-high-attempt-1"],
  );
});

test("planWork: a stale manifest alone is fixed without a browser", () => {
  const { root, manifestPath } = makeCapturedRepo();
  writeHashManifest(manifestPath, {});

  const plan = planWork(root, { warn: () => {} });
  assert.equal(plan.manifestCurrent, false);
  assert.equal(plan.needsBrowser, false);
  assert.equal(plan.isNoOp, false);
});

test("repoPaths puts the manifest under src/data and the PNGs under public", () => {
  const paths = repoPaths("/repo");
  assert.equal(paths.attemptsDir, "/repo/eval-attempts");
  assert.equal(paths.resultsDir, "/repo/eval-results");
  assert.equal(paths.screenshotsDir, "/repo/website/public/screenshots");
  // index.astro imports this at build time; only the PNGs are served.
  assert.equal(paths.hashManifestPath, "/repo/website/src/data/screenshot-hashes.json");
});

// --- the CLI ------------------------------------------------------------------

test("parseArgs refuses --concurrency: the fixed ports allow one attempt at a time", () => {
  for (const argv of [["--concurrency", "1"], ["--concurrency=3"], ["--concurrency"]]) {
    assert.throws(() => parseArgs(argv), /unknown argument "--concurrency/);
  }
  assert.equal("concurrency" in parseArgs([]), false);
});

test("parseArgs reads --force and repeatable --only", () => {
  assert.equal(parseArgs([]).force, false);
  assert.equal(parseArgs(["--force"]).force, true);
  assert.deepEqual(parseArgs([]).only, []);
  assert.deepEqual(parseArgs(["--only", "a", "--only=b"]).only, ["a", "b"]);
});

test("parseArgs reads --install-timeout in the durations the runner accepts", () => {
  // The same parser benchmark/runner.yaml's printTimeout goes through, so the
  // two scripts take the same spellings.
  assert.equal(parseArgs([]).installTimeoutMs, 600_000);
  assert.equal(parseArgs(["--install-timeout", "15m"]).installTimeoutMs, 900_000);
  assert.equal(parseArgs(["--install-timeout=1h30m"]).installTimeoutMs, 5_400_000);
  assert.equal(parseArgs(["--install-timeout", "500ms"]).installTimeoutMs, 500);
  assert.throws(() => parseArgs(["--install-timeout", "soon"]), /cannot parse duration/);
  assert.throws(() => parseArgs(["--install-timeout", "0s"]), /must be greater than zero/);
  // A unit is required — what --help says, and what the runner's own parser
  // does. Pinned because the two must not drift apart.
  assert.throws(() => parseArgs(["--install-timeout", "600000"]), /cannot parse duration/);
});

/**
 * The CLI, with the refusing `docker` first on its PATH: hermetic by
 * construction, not only because `planWork` found nothing to serve. A run
 * that asked docker anything fails here.
 */
function runScreenshots(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, PATH: `${DOCKER_REFUSED_DIR}${delimiter}${process.env.PATH ?? ""}` },
  });
  const stderr = result.stderr ?? "";
  assert.equal(stderr.includes("docker refused"), false, `take-screenshots called docker:\n${stderr}`);
  return { status: result.status, stdout: result.stdout ?? "", stderr };
}

test("--help prints the usage and exits 0", () => {
  const result = runScreenshots("--help");
  assert.equal(result.status, 0);
  assert.equal(result.stdout.includes("--concurrency"), false, result.stdout);
  assert.match(result.stdout, /--force/);
  assert.match(result.stdout, /--only <id>/);
  assert.match(result.stdout, /--install-timeout <d>/);
  assert.match(result.stdout, /--root <path>/);
  assert.equal(result.stderr, "");
});

test("an unknown flag is refused", () => {
  const result = runScreenshots("--headed");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown argument "--headed"/);
});

test("a repo with no attempts is a clean no-op: nothing launched, nothing written", () => {
  const root = makeRoot();
  const result = runScreenshots("--root", root);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Nothing to do: nothing to capture, every filmstrip matches the PNGs behind it/);
  // The browser is announced before it is launched, so its absence from the log
  // is the assertion that none was started.
  assert.equal(result.stdout.includes("Launching Chromium"), false, result.stdout);
  assert.equal(result.stdout.includes("Installing dependencies"), false, result.stdout);
  assert.equal(existsSync(join(root, "website")), false);
});

test("a fully captured repo is a no-op too, and does not rewrite the manifest", () => {
  const { root, manifestPath } = makeCapturedRepo();
  const before = readFileSync(manifestPath, "utf8");

  const result = runScreenshots("--root", root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 attempt\(s\); 1 already pictured; 0 to capture\./);
  assert.match(result.stdout, /Nothing to do/);
  // A run where nothing changed must not touch anything, not even Chromium.
  assert.equal(result.stdout.includes("Launching Chromium"), false, result.stdout);
  assert.equal(readFileSync(manifestPath, "utf8"), before);
});

test("a stale manifest is brought up to date without launching a browser", () => {
  const { root, manifestPath } = makeCapturedRepo();
  writeHashManifest(manifestPath, {});

  const result = runScreenshots("--root", root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes("Launching Chromium"), false, result.stdout);
  assert.match(result.stdout, /Screenshot hash manifest written \(2 files\)\./);
  assert.deepEqual(
    Object.keys(readHashManifest(manifestPath) ?? {}),
    ["gemini-38-flash-low-attempt-1.png", "gemini-38-flash-low_filmstrip.png"],
  );
});

test("a run that leaves a filmstrip stale never claims every filmstrip matches", () => {
  const root = makeRoot();
  makeAttempt(root, "gemini-38-flash-low-attempt-1", { "frontend/package.json": "{}" });
  makeAttempt(root, "claude-opus-46-high-attempt-1", { "frontend/package.json": "{}" });
  const dir = makeScreenshotsDir(root, [
    "gemini-38-flash-low-attempt-1.png",
    "claude-opus-46-high-attempt-1.png",
  ]);
  writeFilmstrip(dir, "gemini-38-flash-low", 3); // built from attempts that are gone
  writeFilmstrip(dir, "claude-opus-46-high", 1);
  writeHashManifest(repoPaths(root).hashManifestPath, buildHashManifest(dir));

  // The second scoped run: the first one resynced the manifest, so this one has
  // nothing at all to do in scope — and still knows one filmstrip is stale.
  const result = runScreenshots("--root", root, "--only", "claude-opus-46-high");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes("Launching Chromium"), false, result.stdout);

  // The pairing, pinned in both directions: whenever the warning is printed, the
  // summary must not contradict it, and it must repeat what was left behind.
  // These two strings live in different functions and an edit to either one is
  // what re-opens the contradiction, so the test asserts them together.
  const warned = /no longer matches the screenshots behind it/.test(result.stderr);
  assert.equal(warned, true, result.stderr);
  assert.equal(
    result.stdout.includes("every filmstrip matches"),
    false,
    `the run warned a filmstrip is stale and then claimed every filmstrip matches:\n${result.stdout}`,
  );
  assert.match(result.stdout, /Nothing to do in scope/);
  assert.match(result.stdout, /1 filmstrip\(s\) outside --only's scope are still stale \(gemini-38-flash-low\)/);
});

test("a clean scoped run does claim every filmstrip matches", () => {
  const root = makeRoot();
  makeAttempt(root, "gemini-38-flash-low-attempt-1", { "frontend/package.json": "{}" });
  const dir = makeScreenshotsDir(root, ["gemini-38-flash-low-attempt-1.png"]);
  writeFilmstrip(dir, "gemini-38-flash-low", 1);
  writeHashManifest(repoPaths(root).hashManifestPath, buildHashManifest(dir));

  // The other half of the pairing: with nothing deferred, the unqualified claim
  // is the right one, so the conditional above cannot be "always say stale".
  const result = runScreenshots("--root", root, "--only", "gemini-38-flash-low");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /every filmstrip matches the PNGs behind it/);
  assert.equal(result.stdout.includes("Nothing to do in scope"), false, result.stdout);
  assert.equal(result.stderr, "");
});

test("--only on a repo with no attempts is still a clean no-op", () => {
  const root = makeRoot();
  const result = runScreenshots("--root", root, "--only", "gemini-38-flash-high");

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /0 to capture \(--only gemini-38-flash-high\)/);
  assert.match(result.stdout, /Nothing to do/);
  assert.equal(result.stdout.includes("Launching Chromium"), false, result.stdout);
  assert.equal(existsSync(join(root, "website")), false);
});

test("--only refuses an id that is neither in the catalogue nor on disk", () => {
  const result = runScreenshots("--root", makeRoot(), "--only", "gemini-99-pro-hgih");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /is not a benchmark id and matches no attempt directory/);
});

test("attempts that all failed on infra are a no-op too", () => {
  const root = makeRoot();
  makeAttempt(root, "gemini-38-flash-low-attempt-1", { "frontend/package.json": "{}" });
  writeRunJson(join(root, "eval-results", "gemini-38-flash-low-attempt-1", "run.json"), {
    ...RUN_JSON,
    failureKind: "infra",
  });

  const result = runScreenshots("--root", root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Nothing to do/);
  assert.equal(result.stdout.includes("Launching Chromium"), false, result.stdout);
  assert.equal(existsSync(join(root, "website")), false);
  assert.equal(existsSync(join(root, "eval-attempts", "gemini-38-flash-low-attempt-1", "node_modules")), false);
});

// --- prepareView ---------------------------------------------------------------

/** A no-op settle so tests do not sleep for real. */
const noSettle = async () => {};

/** A fake page that records calls and can optionally reject specific steps. */
function fakePage(options: {
  failClick?: RegExp;
  failWaitForSelector?: RegExp;
  failWaitForResponse?: boolean;
  failWaitForFunction?: boolean;
  /** How many waits for rendered content fail before one succeeds (`failWaitForFunction` fails them all). */
  blankWaits?: number;
  /** Give the page a `reload`; `"fail"` makes it reject. */
  reload?: true | "fail";
  /** Give the page an `on`; these events fire on `goto`. */
  pageEvents?: [event: string, payload: unknown][];
} = {}): PageLike & { calls: string[] } {
  const calls: string[] = [];
  const listeners = new Map<string, ((payload: unknown) => void)[]>();
  const emit = (): void => {
    for (const [event, payload] of options.pageEvents ?? []) for (const listener of listeners.get(event) ?? []) listener(payload);
  };
  let blankWaits = options.blankWaits ?? 0;
  const page: PageLike & { calls: string[] } = {
    calls,
    goto: async () => { calls.push("goto"); emit(); },
    setContent: async () => { calls.push("setContent"); },
    screenshot: async () => { calls.push("screenshot"); },
    close: async () => { calls.push("close"); },
    waitForFunction: async (_pageFunction, _arg, waitOptions) => {
      assert.equal(waitOptions?.timeout, 20_000, "the timeout goes in the third parameter, after the page function's argument");
      calls.push("waitForFunction");
      if (options.failWaitForFunction) throw new Error("timeout waiting for rendered content");
      if (blankWaits > 0) {
        blankWaits -= 1;
        throw new Error("timeout waiting for rendered content");
      }
    },
    click: async (selector: string) => {
      if (options.failClick?.test(selector)) throw new Error(`no element matching ${selector}`);
      calls.push(`click:${selector}`);
    },
    waitForSelector: async (selector: string) => {
      if (options.failWaitForSelector?.test(selector)) throw new Error(`timeout waiting for ${selector}`);
      calls.push(`waitForSelector:${selector}`);
    },
    waitForResponse: async (predicate: (response: ResponseLike) => boolean) => {
      if (options.failWaitForResponse) throw new Error("timeout waiting for response");
      assert.equal(predicate, isPlanResponse, "prepareView waits for the plan response through isPlanResponse");
      calls.push(`waitForResponse:armed`);
    },
  };
  if (options.reload !== undefined) {
    const fail = options.reload === "fail";
    page.reload = async (reloadOptions) => {
      assert.deepEqual(reloadOptions, { waitUntil: "load", timeout: 30_000 });
      calls.push("reload");
      if (fail) throw new Error("page.reload: Timeout 30000ms exceeded.");
    };
  }
  if (options.pageEvents !== undefined) {
    page.on = (event: string, listener: (payload: never) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener as (payload: unknown) => void]);
    };
  }
  return page;
}

/** Playwright-shaped payloads for the page events `watchPageEvents` listens to. */
const consoleMessage = (type: string, text: string): [string, unknown] => ["console", { type: () => type, text: () => text }];
const pageError = (text: string): [string, unknown] => ["pageerror", new Error(text)];
const requestFailed = (url: string, errorText: string): [string, unknown] => ["requestfailed", { url: () => url, failure: () => ({ errorText }) }];
const httpResponse = (status: number, url: string): [string, unknown] => ["response", { url: () => url, status: () => status }];

/** A Playwright-shaped response for `isPlanResponse`. */
function response(method: string, url: string): ResponseLike {
  return { url: () => url, request: () => ({ method: () => method }) };
}

test("isPlanResponse: only a POST to /api/v1/plan, whatever the query string", () => {
  assert.equal(isPlanResponse(response("POST", "http://127.0.0.1:5173/api/v1/plan?week_start=2026-10-05&strategy=balanced")), true);
  assert.equal(isPlanResponse(response("POST", "http://127.0.0.1:5100/api/v1/plan")), true);
  assert.equal(isPlanResponse(response("GET", "http://127.0.0.1:5173/api/v1/plan?week_start=2026-10-05")), false);
  assert.equal(isPlanResponse(response("GET", "http://127.0.0.1:5173/src/views/planner/PlanView.tsx")), false);
  assert.equal(isPlanResponse(response("POST", "http://127.0.0.1:5173/api/v1/planner")), false);
  assert.equal(isPlanResponse(response("POST", "http://127.0.0.1:5173/api/v1/schedule")), false);
  assert.equal(isPlanResponse(response("POST", "not a url")), false);
});

test("prepareView(brownfield): full sequence — Schedule, wait for view, Balanced, Generate Plan with response wait", async () => {
  const page = fakePage();
  const warnings: string[] = [];
  await prepareView("brownfield", page, (w) => warnings.push(w), undefined, noSettle);
  assert.deepEqual(page.calls, [
    'click:text="Schedule"',
    "waitForSelector:text=/generate plan/i",
    "click:text=/balanced/i",
    "waitForResponse:armed",
    "click:text=/generate plan/i",
    "waitForSelector:text=/generate plan/i",
  ]);
  assert.equal(warnings.length, 0, `unexpected warnings: ${warnings.join("; ")}`);
});

test("prepareView(brownfield): missing Balanced button is OK — continues without it", async () => {
  const page = fakePage({ failClick: /balanced/i });
  const warnings: string[] = [];
  await prepareView("brownfield", page, (w) => warnings.push(w), undefined, noSettle);
  assert.deepEqual(page.calls, [
    'click:text="Schedule"',
    "waitForSelector:text=/generate plan/i",
    // balanced click failed (warning logged)
    "waitForResponse:armed",
    "click:text=/generate plan/i",
    "waitForSelector:text=/generate plan/i",
  ]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /Balanced.*optional/);
});

test("prepareView(brownfield): missing Schedule aborts with a warning", async () => {
  const page = fakePage({ failClick: /Schedule/ });
  const warnings: string[] = [];
  await prepareView("brownfield", page, (w) => warnings.push(w), undefined, noSettle);
  assert.deepEqual(page.calls, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /could not click.*Schedule/);
});

test("prepareView(brownfield): Generate Plan button never appears after navigation — warns", async () => {
  const page = fakePage({ failWaitForSelector: /generate plan/i });
  const warnings: string[] = [];
  await prepareView("brownfield", page, (w) => warnings.push(w), undefined, noSettle);
  assert.deepEqual(page.calls, [
    'click:text="Schedule"',
    // waitForSelector failed — abort
  ]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /Generate Plan.*did not appear/);
});

test("prepareView(brownfield): Generate Plan response failure warns and returns current view", async () => {
  const page = fakePage({ failWaitForResponse: true });
  const warnings: string[] = [];
  await prepareView("brownfield", page, (w) => warnings.push(w), undefined, noSettle);
  assert.deepEqual(page.calls, [
    'click:text="Schedule"',
    "waitForSelector:text=/generate plan/i",
    "click:text=/balanced/i",
    "click:text=/generate plan/i",
    // waitForResponse failed on await responsePromise, aborts before second waitForSelector
  ]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /Generate Plan did not complete/);
});

test("prepareView(classic): no clicks at all", async () => {
  const page = fakePage();
  await prepareView("classic", page, () => { throw new Error("should not warn"); }, undefined, noSettle);
  assert.deepEqual(page.calls, []);
});

test("prepareView(hard): no clicks at all", async () => {
  const page = fakePage();
  await prepareView("hard", page, () => { throw new Error("should not warn"); }, undefined, noSettle);
  assert.deepEqual(page.calls, []);
});

test("prepareView(undefined): no clicks at all (default track)", async () => {
  const page = fakePage();
  await prepareView(undefined, page, () => { throw new Error("should not warn"); }, undefined, noSettle);
  assert.deepEqual(page.calls, []);
});

test("prepareView(brownfield): page without click/waitForSelector/waitForResponse warns and returns", async () => {
  const calls: string[] = [];
  const minimalPage: PageLike = {
    goto: async () => { calls.push("goto"); },
    setContent: async () => {},
    screenshot: async () => {},
    close: async () => {},
  };
  const warnings: string[] = [];
  await prepareView("brownfield", minimalPage, (w) => warnings.push(w), undefined, noSettle);
  assert.deepEqual(calls, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /does not support click/);
});

// --- processAttempt: capture flow (wait for content across all tracks) -----------

async function runCapture(
  page: PageLike & { calls: string[] },
  options: {
    track?: "classic" | "hard" | "brownfield";
  } = {},
): Promise<{ result: CaptureResult; warnings: string[] }> {
  const warnings: string[] = [];
  const attempt: AttemptInfo = {
    benchmarkId: "claude-sonnet-46-high",
    attempt: 1,
    dirName: "claude-sonnet-46-high-attempt-1",
    attemptDir: "/fake/attempt",
    frontendRoot: "/fake/attempt/frontend",
    modelFailure: false,
  };
  const browser: BrowserLike = {
    newPage: async () => page,
    close: async () => {},
  };
  const deps: Partial<CaptureDeps> & Pick<CaptureDeps, "screenshotsDir"> = {
    screenshotsDir: "/tmp/screenshots",
    image: () => ({ ref: "fake-image", id: "fake-image-id" }),
    busyPorts: async () => [],
    createBackend: () => ({
      checkLayout: () => ({ kind: "ok" } as any),
      install: async () => ({ kind: "ok" }),
      start: async () => ({ kind: "ready", baseUrl: "http://127.0.0.1:5100", container: "fake-container" }),
      stop: async () => ({ removed: true } as any),
      dispose: async () => [{ removed: true } as any],
    }),
    ensureNodeModules: async () => {},
    probeRegistry: async () => true,
    startVite: async () => ({
      proc: { kill: () => true, pid: 12345 } as any,
      port: 5173,
      url: "http://localhost:5173/",
    }),
    stopVite: async () => true,
    sleep: async (ms) => {
      page.calls.push(`sleep:${ms}`);
    },
    interrupted: () => null,
    track: options.track,
    log: () => {},
    warn: (w) => warnings.push(w),
  };
  const result = await processAttempt(attempt, browser, deps);
  return { result, warnings };
}

test("capture order for classic: goto, settle, waitForFunction, screenshot (no clicks)", async () => {
  const page = fakePage();
  const { result, warnings } = await runCapture(page, { track: "classic" });
  assert.equal(result.kind, "pictured");
  assert.deepEqual(page.calls, [
    "goto",
    "sleep:2000",
    "waitForFunction",
    "screenshot",
    "close",
  ]);
  assert.equal(warnings.length, 0);
});

test("capture order for hard: goto, settle, waitForFunction, screenshot (no clicks)", async () => {
  const page = fakePage();
  const { result, warnings } = await runCapture(page, { track: "hard" });
  assert.equal(result.kind, "pictured");
  assert.deepEqual(page.calls, [
    "goto",
    "sleep:2000",
    "waitForFunction",
    "screenshot",
    "close",
  ]);
  assert.equal(warnings.length, 0);
});

test("capture order for brownfield: goto, settle, waitForFunction, prepareView, screenshot", async () => {
  const page = fakePage();
  const { result, warnings } = await runCapture(page, { track: "brownfield" });
  assert.equal(result.kind, "pictured");
  assert.deepEqual(page.calls, [
    "goto",
    "sleep:2000",
    "waitForFunction",
    'click:text="Schedule"',
    "waitForSelector:text=/generate plan/i",
    "sleep:1000",
    "click:text=/balanced/i",
    "waitForResponse:armed",
    "click:text=/generate plan/i",
    "waitForSelector:text=/generate plan/i",
    "sleep:1000",
    "screenshot",
    "close",
  ]);
  assert.equal(warnings.length, 0);
});

test("capture when waitForFunction times out on a page with no reload and no on: warns as before, photographs anyway", async () => {
  const page = fakePage({ failWaitForFunction: true });
  const { result, warnings } = await runCapture(page, { track: "classic" });
  assert.equal(result.kind, "pictured");
  assert.deepEqual(page.calls, [
    "goto",
    "sleep:2000",
    "waitForFunction",
    "screenshot",
    "close",
  ]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /page still blank after 20 s/);
  // The run summary prefixes the attempt's name; the warning itself must not.
  assert.deepEqual(result.kind === "pictured" ? result.warnings : [], ["page still blank after 20 s — photographing anyway"]);
});

// --- a blank page: one reload, and the page's own account of itself ------------

test("a blank page is reloaded once, and a page that renders then is captured with a warning naming its events", async () => {
  const page = fakePage({
    blankWaits: 1,
    reload: true,
    pageEvents: [httpResponse(504, "http://localhost:5173/node_modules/.vite/deps/react-dom_client.js?v=1a2b3c4d")],
  });
  const { result, warnings } = await runCapture(page, { track: "brownfield" });
  assert.equal(result.kind, "pictured");
  assert.deepEqual(page.calls, [
    "goto",
    "sleep:2000",
    "waitForFunction",
    "reload",
    "sleep:2000",
    "waitForFunction",
    'click:text="Schedule"',
    "waitForSelector:text=/generate plan/i",
    "sleep:1000",
    "click:text=/balanced/i",
    "waitForResponse:armed",
    "click:text=/generate plan/i",
    "waitForSelector:text=/generate plan/i",
    "sleep:1000",
    "screenshot",
    "close",
  ]);
  const expected =
    "page was blank after 20 s, rendered after one reload; page events: HTTP 504 http://localhost:5173/node_modules/.vite/deps/react-dom_client.js?v=1a2b3c4d";
  // The run summary prefixes the attempt's name; the warning itself must not.
  assert.deepEqual(result.kind === "pictured" ? result.warnings : [], [expected]);
  assert.deepEqual(warnings, [`  ! ${expected}`]);
});

test("a page still blank after the reload is photographed anyway, and says it heard nothing", async () => {
  const page = fakePage({ failWaitForFunction: true, reload: true, pageEvents: [] });
  const { result, warnings } = await runCapture(page, { track: "classic" });
  assert.equal(result.kind, "pictured");
  assert.deepEqual(page.calls, ["goto", "sleep:2000", "waitForFunction", "reload", "sleep:2000", "waitForFunction", "screenshot", "close"]);
  const expected = "page still blank after 20 s and one reload — photographing anyway; page events: none";
  assert.deepEqual(result.kind === "pictured" ? result.warnings : [], [expected]);
  assert.deepEqual(warnings, [`  ! ${expected}`]);
});

test("a reload that fails is not waited on again: the page is photographed with the reload's error", async () => {
  const page = fakePage({ failWaitForFunction: true, reload: "fail", pageEvents: [pageError("Failed to fetch dynamically imported module")] });
  const { result } = await runCapture(page, { track: "classic" });
  assert.equal(result.kind, "pictured");
  assert.deepEqual(page.calls, ["goto", "sleep:2000", "waitForFunction", "reload", "screenshot", "close"]);
  assert.deepEqual(result.kind === "pictured" ? result.warnings : [], [
    "page still blank after 20 s, and the reload failed (page.reload: Timeout 30000ms exceeded.) — photographing anyway; " +
      "page events: pageerror: Failed to fetch dynamically imported module",
  ]);
});

test("a page that renders at once is never reloaded, and its events are not reported", async () => {
  const page = fakePage({ reload: true, pageEvents: [consoleMessage("error", "Warning: Each child in a list should have a unique key")] });
  const { result, warnings } = await runCapture(page, { track: "classic" });
  assert.deepEqual(page.calls, ["goto", "sleep:2000", "waitForFunction", "screenshot", "close"]);
  assert.deepEqual(result.kind === "pictured" ? result.warnings : null, []);
  assert.deepEqual(warnings, []);
});

test("the blank-page warning carries console errors and warnings, page errors, failed requests and HTTP errors — nothing else", async () => {
  const page = fakePage({
    failWaitForFunction: true,
    reload: true,
    pageEvents: [
      consoleMessage("log", "[vite] connecting..."),
      consoleMessage("info", "Download the React DevTools"),
      consoleMessage("warning", "[vite] new dependencies optimized: react-dom/client"),
      consoleMessage("error", "Failed to load resource: the server responded with a status of 504 (Outdated Optimize Dep)"),
      pageError("Cannot read properties of undefined (reading 'map')"),
      requestFailed("http://localhost:5173/src/main.tsx", "net::ERR_ABORTED"),
      httpResponse(200, "http://localhost:5173/"),
      httpResponse(304, "http://localhost:5173/src/App.tsx"),
      httpResponse(404, "http://localhost:5173/api/v1/technicians"),
    ],
  });
  const { result } = await runCapture(page, { track: "classic" });
  assert.deepEqual(result.kind === "pictured" ? result.warnings : [], [
    "page still blank after 20 s and one reload — photographing anyway; page events: " +
      [
        "console warning: [vite] new dependencies optimized: react-dom/client",
        "console error: Failed to load resource: the server responded with a status of 504 (Outdated Optimize Dep)",
        "pageerror: Cannot read properties of undefined (reading 'map')",
        "requestfailed http://localhost:5173/src/main.tsx: net::ERR_ABORTED",
        "HTTP 404 http://localhost:5173/api/v1/technicians",
      ].join("; "),
  ]);
});

test("watchPageEvents keeps at most 10 events of at most 200 characters, and counts the rest", () => {
  const listeners = new Map<string, (payload: never) => void>();
  const page: PageLike = {
    goto: async () => {},
    setContent: async () => {},
    screenshot: async () => {},
    close: async () => {},
    on: (event: string, listener: (payload: never) => void) => {
      listeners.set(event, listener);
    },
  };
  const account = watchPageEvents(page);
  assert.equal(account(), "none");
  const fire = ([event, payload]: [string, unknown]): void => (listeners.get(event) as (payload: unknown) => void)(payload);
  fire(pageError(`first line\n    at ${"x".repeat(300)}`));
  for (let i = 1; i <= 12; i += 1) fire(httpResponse(500, `http://localhost:5173/api/v1/${i}`));
  const events = account()!.split("; ");
  assert.equal(events.length, 11);
  assert.equal(events[0], `pageerror: first line / at ${"x".repeat(200 - "pageerror: first line / at ".length)}…`);
  assert.deepEqual(events.slice(1, 10), Array.from({ length: 9 }, (_, i) => `HTTP 500 http://localhost:5173/api/v1/${i + 1}`));
  assert.equal(events[10], "…and 3 more");
});

test("watchPageEvents on a page with no on collects nothing, and says so with null rather than none", () => {
  const page: PageLike = { goto: async () => {}, setContent: async () => {}, screenshot: async () => {}, close: async () => {} };
  assert.equal(watchPageEvents(page)(), null);
});

test("a brownfield capture that renders but cannot reach Schedule says what the page reported", async () => {
  const page = fakePage({ failClick: /Schedule/, pageEvents: [pageError("Cannot read properties of undefined (reading 'map')")] });
  const { result, warnings } = await runCapture(page, { track: "brownfield" });
  assert.equal(result.kind, "pictured");
  assert.deepEqual(page.calls, ["goto", "sleep:2000", "waitForFunction", "screenshot", "close"]);
  assert.deepEqual(warnings, [
    '  ! claude-sonnet-46-high-attempt-1: prepareView: could not click "Schedule" navigation — photographing the current view; ' +
      "page events: pageerror: Cannot read properties of undefined (reading 'map')",
  ]);
});

test("prepareView: every step that gives up carries the page events; the optional Balanced toggle does not", async () => {
  const events = () => "HTTP 500 http://localhost:5173/api/v1/plan";
  const run = async (options: Parameters<typeof fakePage>[0]): Promise<string[]> => {
    const warnings: string[] = [];
    await prepareView("brownfield", fakePage(options), (w) => warnings.push(w), undefined, noSettle, events);
    return warnings;
  };
  const tail = "; page events: HTTP 500 http://localhost:5173/api/v1/plan";
  assert.deepEqual(await run({ failClick: /Schedule/ }), [`  ! prepareView: could not click "Schedule" navigation — photographing the current view${tail}`]);
  assert.deepEqual(await run({ failWaitForSelector: /generate plan/i }), [
    `  ! prepareView: "Generate Plan" button did not appear after navigating to Schedule — photographing the current view${tail}`,
  ]);
  assert.deepEqual(await run({ failWaitForResponse: true }), [`  ! prepareView: Generate Plan did not complete — photographing the current view${tail}`]);
  assert.deepEqual(await run({ failClick: /balanced/i }), ['  ! prepareView: no "Balanced" button found (optional) — continuing']);
});
