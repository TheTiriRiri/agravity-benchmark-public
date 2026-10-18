/**
 * The reference backend as a child process: a cached venv, a free port, uvicorn
 * started with `REFERENCE_MUTANT` and `REFERENCE_SEED_PATH`, and a health poll.
 * Extracted from `scripts/reference-gate.ts` so `scripts/fuzz-gate.ts` can start
 * the same server the same way instead of keeping a second copy to drift.
 *
 * Runs on the host's python3, in a cached venv. It is our own code, so it needs
 * no container; attempts never run this way.
 *
 * Nothing here installs a process handler: the caller owns interrupt handling.
 * `startReference` returns its own `stop` rather than mutating a module-level
 * child, so two callers cannot clobber each other's process handle.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BACKEND_DIR = join(ROOT, "test", "fixtures", "reference-backend");
export const SEED_PATH = join(ROOT, "benchmark", "context", "seed.json");
export const VENV_DIR = join(ROOT, ".cache", "reference-venv");
const HEALTH_TIMEOUT_MS = 30_000;

export function ensureVenv(venvDir: string = VENV_DIR, backendDir: string = BACKEND_DIR): void {
  if (existsSync(join(venvDir, "bin", "uvicorn"))) return;
  mkdirSync(dirname(venvDir), { recursive: true });
  for (const [command, args] of [
    ["python3", ["-m", "venv", venvDir]],
    [join(venvDir, "bin", "pip"), ["install", "--quiet", "-r", join(backendDir, "requirements.txt")]],
  ] as const) {
    const done = spawnSync(command, args, { stdio: "inherit" });
    if (done.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${done.status}`);
  }
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (address && typeof address === "object" ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

export interface StartOptions {
  /** A name from mutants.json, or "" for the reference itself. */
  mutant: string;
  venvDir?: string;
  backendDir?: string;
  seedPath?: string;
  healthTimeoutMs?: number;
  /**
   * Called with the stop handle as soon as the child exists, before the health
   * poll. A caller that must kill the child on SIGINT needs it that early: the
   * poll can take up to `healthTimeoutMs`, and the promise below has not
   * resolved to hand one over yet.
   */
  onSpawn?: (stop: () => void) => void;
}

export async function startReference(options: StartOptions): Promise<{ baseUrl: string; stop: () => void }> {
  const {
    mutant,
    venvDir = VENV_DIR,
    backendDir = BACKEND_DIR,
    seedPath = SEED_PATH,
    healthTimeoutMs = HEALTH_TIMEOUT_MS,
  } = options;
  const port = await freePort();
  const child = spawn(join(venvDir, "bin", "uvicorn"), ["app.main:app", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: backendDir,
    env: { ...process.env, REFERENCE_MUTANT: mutant, REFERENCE_SEED_PATH: seedPath, PYTHONDONTWRITEBYTECODE: "1" },
    stdio: "ignore",
  });
  const stop = (): void => {
    try {
      if (child.exitCode === null) child.kill("SIGKILL");
    } catch {
      // Already gone. Nothing else to clean up depends on this.
    }
  };
  options.onSpawn?.(stop);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + healthTimeoutMs;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`the reference backend exited ${child.exitCode} (mutant: ${mutant || "none"})`);
      try {
        const reply = await fetch(`${baseUrl}/api/v1/health`, { signal: AbortSignal.timeout(1_000) });
        if (reply.ok) return { baseUrl, stop };
      } catch {
        // Not listening yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error("the reference backend never answered /health");
  } catch (error) {
    // The caller gets no handle from a promise that rejects, so a start that
    // fails cleans up after itself; reference-gate did this through its
    // module-level `child`.
    stop();
    throw error;
  }
}
