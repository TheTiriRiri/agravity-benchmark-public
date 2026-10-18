/**
 * Writing a result file so that a reader never sees half of it: a temporary
 * file beside the target, fsynced, then renamed over it. Moved out of
 * `contract-results.ts`, which keeps only what decides a score.
 *
 * `contract-tests` sweeps temporary files that a killed writer left behind, by
 * the pid in their name (`tempFileOwner`).
 */
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** `.<name>.<pid>.<8 hex>.tmp` beside `path`: where `writeFileAtomic(path)` writes before its rename. */
export function tempPathFor(path: string, pid: number = process.pid): string {
  return join(dirname(path), `.${basename(path)}.${pid}.${randomBytes(4).toString("hex")}.tmp`);
}

/**
 * The pid in `entry`, a bare file name, when it is a temporary file that
 * `tempPathFor(<dir>/<name>)` could have made; otherwise `null`. Only a
 * process killed between the write and the rename leaves one behind.
 */
export function tempFileOwner(name: string, entry: string): number | null {
  const prefix = `.${name}.`;
  if (!entry.startsWith(prefix)) return null;
  const match = /^([1-9]\d{0,9})\.[0-9a-f]{8}\.tmp$/.exec(entry.slice(prefix.length));
  return match === null ? null : Number(match[1]);
}

/**
 * `text` at `path`, through a temporary file in the same directory and a
 * rename, creating the directory if needed. On any failure the temporary file
 * is removed, the error propagates, and whatever was at `path` is untouched.
 */
export function writeFileAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = tempPathFor(path);
  let fd: number | null = null;
  try {
    fd = openSync(tmp, "wx");
    writeSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
  } catch (error) {
    try {
      if (fd !== null) closeSync(fd);
    } catch {
      // Already closed or never usable; the unlink below still runs.
    }
    try {
      unlinkSync(tmp);
    } catch {
      // Never created, or already renamed.
    }
    throw error;
  }
}
