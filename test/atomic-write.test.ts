import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, test } from "node:test";

import { tempFileOwner, tempPathFor, writeFileAtomic } from "../scripts/lib/atomic-write";
import { CONTRACT_RESULTS_FILE } from "../scripts/lib/contract-results";

const ATTEMPT = "gemini-38-flash-high-attempt-1";
const scratch: string[] = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agrav-atomic-"));
  scratch.push(dir);
  return dir;
}

test("tempFileOwner recognises exactly the temp files tempPathFor makes, and reads their pid", () => {
  const path = join("/results", ATTEMPT, CONTRACT_RESULTS_FILE);
  const made = basename(tempPathFor(path, 4242));
  assert.match(made, /^\.contract-results\.json\.4242\.[0-9a-f]{8}\.tmp$/);
  assert.equal(dirname(tempPathFor(path)), dirname(path), "beside the file, so the rename stays on one filesystem");
  assert.equal(tempFileOwner(CONTRACT_RESULTS_FILE, made), 4242);
  assert.equal(tempFileOwner(CONTRACT_RESULTS_FILE, basename(tempPathFor(path))), process.pid);
  for (const other of [
    CONTRACT_RESULTS_FILE,
    ".contract-results.json.tmp",
    ".contract-results.json.4242.tmp",
    ".contract-results.json.4242.abcdef0.tmp",
    ".contract-results.json.4242.ABCDEF01.tmp",
    ".contract-results.json.0.abcdef01.tmp",
    ".contract-results.json.x.abcdef01.tmp",
    ".contract-results.json.4242.abcdef01.tmp.bak",
    "contract-results.json.4242.abcdef01.tmp",
    ".contract-resultsXjson.4242.abcdef01.tmp",
    ".run.json.4242.abcdef01.tmp",
    ".eval-results.csv.4242.abcdef01.tmp",
  ]) {
    assert.equal(tempFileOwner(CONTRACT_RESULTS_FILE, other), null, other);
  }
});

test("writeFileAtomic writes and replaces a file, creating its directory, and leaves no temp file", () => {
  const dir = join(tempDir(), "a", "b");
  const path = join(dir, "out.json");
  writeFileAtomic(path, "first\n");
  writeFileAtomic(path, "second\n");
  assert.equal(readFileSync(path, "utf8"), "second\n");
  assert.deepEqual(readdirSync(dir), ["out.json"]);
});

test("writeFileAtomic's failure keeps what was there and removes its temp file", () => {
  // The target is a non-empty directory, so the rename fails after the temp
  // file was written: the error propagates, and the temp file is gone.
  const dir = tempDir();
  const path = join(dir, "out.json");
  mkdirSync(path);
  writeFileSync(join(path, "keep"), "kept\n");
  assert.throws(() => writeFileAtomic(path, "never\n"), /EISDIR|ENOTEMPTY|EEXIST/);
  assert.deepEqual(readdirSync(dir), ["out.json"]);
  assert.equal(readFileSync(join(path, "keep"), "utf8"), "kept\n");
});
