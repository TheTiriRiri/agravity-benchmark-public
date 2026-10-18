/**
 * Tests for `--track classic|hard` flag in take-screenshots.ts
 *
 * Validates that:
 * - `--track hard` writes to screenshots/hard/ directory
 * - No flag defaults to classic (screenshots/)
 * - `repoPaths` returns correct paths per track
 * - Attempt ID filenames remain ${attemptId}.png
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseArgs, repoPaths, screenshotFileName } from "../scripts/take-screenshots";

describe("take-screenshots --track flag", () => {
  it("parseArgs defaults to classic track", () => {
    const args = parseArgs(["--help"]);
    assert.equal(args.track, "classic");
  });

  it("parseArgs accepts --track hard", () => {
    const args = parseArgs(["--track", "hard", "--help"]);
    assert.equal(args.track, "hard");
  });

  it("parseArgs accepts --track classic", () => {
    const args = parseArgs(["--track", "classic", "--help"]);
    assert.equal(args.track, "classic");
  });

  it("parseArgs accepts --track brownfield", () => {
    const args = parseArgs(["--track", "brownfield", "--help"]);
    assert.equal(args.track, "brownfield");
  });

  it("parseArgs rejects invalid track value", () => {
    assert.throws(
      () => parseArgs(["--track", "invalid"]),
      /--track must be "classic", "hard" or "brownfield"/,
    );
  });

  it("parseArgs accepts the npm -- separator (bare)", () => {
    const args = parseArgs(["--", "--track", "hard"]);
    assert.equal(args.track, "hard");
    assert.equal(args.force, false);
  });

  it("parseArgs accepts -- between flags", () => {
    const args = parseArgs(["--force", "--", "--track", "brownfield"]);
    assert.equal(args.force, true);
    assert.equal(args.track, "brownfield");
  });

  it("parseArgs accepts -- as npm passes it for screenshots:hard -- --force", () => {
    // npm run screenshots:hard -- --force  →  argv = ["--", "--track", "hard", "--force"]
    const args = parseArgs(["--", "--track", "hard", "--force"]);
    assert.equal(args.track, "hard");
    assert.equal(args.force, true);
  });

  it("parseArgs rejects --root pointing to track directory (tracks/console-hard)", () => {
    assert.throws(
      () => parseArgs(["--root", "tracks/console-hard", "--track", "hard"]),
      /--root must be the repository root, not a track directory/,
    );
  });

  it("parseArgs rejects --root pointing to track directory (tracks/brownfield)", () => {
    assert.throws(
      () => parseArgs(["--root", "tracks/brownfield", "--track", "brownfield"]),
      /--root must be the repository root, not a track directory/,
    );
  });

  it("parseArgs structural root validation with temp directories", () => {
    const tmp = mkdtempSync(join(tmpdir(), "screenshots-root-test-"));
    try {
      // (a) <tmp>/repo with package.json and tracks/console-hard
      const repoDir = join(tmp, "repo");
      const tracksDir = join(repoDir, "tracks");
      const trackSubdir = join(tracksDir, "console-hard");
      mkdirSync(trackSubdir, { recursive: true });
      writeFileSync(join(repoDir, "package.json"), "{}");

      assert.throws(
        () => parseArgs(["--root", trackSubdir]),
        /--root must be the repository root, not a track directory/,
      );
      assert.throws(
        () => parseArgs(["--root", tracksDir]),
        /--root must be the repository root, not a track directory/,
      );
      assert.doesNotThrow(() => {
        const parsed = parseArgs(["--root", repoDir]);
        assert.equal(parsed.root, repoDir);
      });

      // (b) <tmp>/x/tracks/agrav where <tmp>/x has NO package.json
      const nestedRepo = join(tmp, "x", "tracks", "agrav");
      mkdirSync(nestedRepo, { recursive: true });

      assert.doesNotThrow(() => {
        const parsed = parseArgs(["--root", nestedRepo]);
        assert.equal(parsed.root, nestedRepo);
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("repoPaths defaults to classic screenshots dir", () => {
    const paths = repoPaths("/repo");
    assert.equal(paths.screenshotsDir, "/repo/website/public/screenshots");
    assert.equal(paths.attemptsDir, "/repo/eval-attempts");
    assert.equal(paths.resultsDir, "/repo/eval-results");
    assert.equal(paths.hashManifestPath, "/repo/website/src/data/screenshot-hashes.json");
  });

  it("repoPaths with hard track uses tracks/console-hard for attempts/results and website/public/screenshots/hard", () => {
    const paths = repoPaths("/repo", "hard");
    assert.equal(paths.attemptsDir, "/repo/tracks/console-hard/eval-attempts");
    assert.equal(paths.resultsDir, "/repo/tracks/console-hard/eval-results");
    assert.equal(paths.screenshotsDir, "/repo/website/public/screenshots/hard");
    assert.equal(paths.hashManifestPath, "/repo/website/src/data/screenshot-hashes-hard.json");
  });

  it("repoPaths with brownfield track uses tracks/brownfield for attempts/results and website/public/screenshots/brownfield", () => {
    const paths = repoPaths("/repo", "brownfield");
    assert.equal(paths.attemptsDir, "/repo/tracks/brownfield/eval-attempts");
    assert.equal(paths.resultsDir, "/repo/tracks/brownfield/eval-results");
    assert.equal(paths.screenshotsDir, "/repo/website/public/screenshots/brownfield");
    assert.equal(paths.hashManifestPath, "/repo/website/src/data/screenshot-hashes-brownfield.json");
  });

  it("repoPaths with classic track is unchanged from default", () => {
    const classic = repoPaths("/repo", "classic");
    const defaultPaths = repoPaths("/repo");
    assert.deepEqual(classic, defaultPaths);
  });

  it("attempt ID filenames remain ${attemptId}.png regardless of track", () => {
    assert.equal(screenshotFileName("gemini-38-flash-high-attempt-1"), "gemini-38-flash-high-attempt-1.png");
    assert.equal(screenshotFileName("claude-opus-46-high-attempt-3"), "claude-opus-46-high-attempt-3.png");
  });
});
