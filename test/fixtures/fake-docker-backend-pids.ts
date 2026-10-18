/**
 * The processes `test/fixtures/fake-docker-backend/docker` recorded in
 * `<state>/pids.log`, one `<pid> <start time>` line each. A test counts or
 * kills one only while `/proc/<pid>/stat` still shows the same start time
 * (field 22): a pid the kernel has since handed to another process is never
 * signalled, and never mistaken for a survivor.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface RecordedPid {
  pid: number;
  /** Field 22 of `/proc/<pid>/stat` when the fake recorded it; `null` if it could not read it. */
  start: string | null;
}

/** Each process once: the fake records a process from both sides of its spawn. */
export function recordedPids(stateDir: string): RecordedPid[] {
  const log = join(stateDir, "pids.log");
  if (!existsSync(log)) return [];
  const seen = new Map<string, RecordedPid>();
  for (const line of readFileSync(log, "utf8").split("\n")) {
    const [pidText, startText] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const start = startText === undefined || startText === "?" ? null : startText;
    const key = `${pid} ${start}`;
    if (!seen.has(key)) seen.set(key, { pid, start });
  }
  return [...seen.values()];
}

/** State and start time from `/proc/<pid>/stat`, or `null` when there is no such process. */
function procStat(pid: number): { state: string; start: string } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name may hold spaces and parentheses; everything after the last ")" is fixed.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { state: fields[0], start: fields[19] };
  } catch {
    return null;
  }
}

/**
 * Still the very process the fake started, and not a zombie. One whose start
 * time was never recorded cannot be proven ours, so it never counts.
 */
export function isStillRunning(rec: RecordedPid): boolean {
  if (rec.start === null) return false;
  const now = procStat(rec.pid);
  return now !== null && now.state !== "Z" && now.start === rec.start;
}

/** The recorded processes that are provably still running. */
export function survivors(stateDir: string): RecordedPid[] {
  return recordedPids(stateDir).filter(isStillRunning);
}

/** SIGKILL every recorded process that is provably still the one the fake started. */
export function killSurvivors(stateDir: string): void {
  for (const rec of survivors(stateDir)) {
    try {
      process.kill(rec.pid, "SIGKILL");
    } catch {
      // gone in the meantime
    }
  }
}
