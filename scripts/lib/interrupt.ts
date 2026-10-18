/**
 * What an operator's signal means to a scoring tool, and the one place its
 * handlers are installed.
 *
 * Ported from `scripts/run-matrix.ts`, which imports this module too and
 * installs its handlers from `main`, as every entry script with a guarded
 * `main` does. No library registers a handler at import, and neither does any
 * such entry script (`run-matrix` included); this module registers nothing at
 * import, and libraries only export the cleanups `installInterruptHandlers`
 * is given.
 */

/**
 * Signals that mean "stop this run" rather than "this attempt failed".
 *
 * `SIGHUP` and `SIGQUIT` are here for the same reason as `SIGINT`: a closed
 * terminal or a dropped ssh session delivers `SIGHUP`, and Node's default action
 * for an unhandled `SIGHUP` or `SIGQUIT` terminates the process *without*
 * running `exit` listeners. A detached backend container, a Vite process group
 * or a scratch directory would then outlive the run, holding its port.
 *
 * `SIGKILL` cannot be handled; `sweepDeadOwners` in `docker.ts` is the answer to
 * what it leaves behind.
 */
export const INTERRUPT_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const;

export type InterruptSignal = (typeof INTERRUPT_SIGNALS)[number];

/** The shell's 128+N convention. */
export const INTERRUPT_EXIT_CODES: Record<InterruptSignal, number> = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
  SIGQUIT: 131,
};

const SIGNAL_BY_EXIT_CODE = new Map<number, InterruptSignal>(
  INTERRUPT_SIGNALS.map((signal) => [INTERRUPT_EXIT_CODES[signal], signal]),
);

/**
 * Whether a child died because the operator stopped the run, read from a
 * `spawnSync` (or `spawn` close) result.
 *
 * A caller blocked in `spawnSync` runs no JS until it returns, so its signal
 * handler only fires afterwards — possibly after the caller has already acted
 * on the result as if it were the child's own failure. Checking the result
 * closes that gap. Both shapes occur: the child got the signal through the
 * process group (`signal` set), or it forwarded the signal and exited 128+N
 * itself (`status` set).
 *
 * `SIGKILL` is deliberately not an interruption: it is what a timeout sends.
 */
export function detectInterrupt(result: {
  signal: NodeJS.Signals | null;
  status: number | null;
}): InterruptSignal | null {
  const signal = result.signal;
  if (signal !== null && (INTERRUPT_SIGNALS as readonly string[]).includes(signal)) {
    return signal as InterruptSignal;
  }
  if (result.status !== null) return SIGNAL_BY_EXIT_CODE.get(result.status) ?? null;
  return null;
}

export interface InterruptHooks {
  /**
   * Run in order on the first signal, each awaited and individually
   * try/caught, before the process exits. Read when the signal arrives, so a
   * cleanup pushed after installation still runs.
   */
  cleanups: Array<() => void | Promise<void>>;
  /**
   * Run once from an `exit` listener — on every exit, not only a signal — in
   * order, each individually try/caught. They must be synchronous: nothing an
   * `exit` listener starts is waited for. This is where a second signal's
   * cleanup happens.
   */
  exitCleanups?: Array<() => void>;
}

export interface InterruptHandlers {
  /** Remove every listener this call added. */
  uninstall(): void;
  /** The first signal received, or `null`. Check it before writing anything a signal must not leave behind. */
  interrupted(): InterruptSignal | null;
}

function warn(what: string, error: unknown): void {
  // console, not process.stderr.write: after a SIGHUP the terminal is gone, and
  // the console swallows the resulting write error instead of throwing it.
  const message = error instanceof Error ? error.message : String(error);
  console.error(`warning: ${what} failed: ${message}`);
}

/**
 * Install handlers for `INTERRUPT_SIGNALS` and an `exit` listener.
 *
 * - First signal: run `cleanups`, then `process.exit(128+N)`.
 * - A second signal (any of the four) while they run: exit at once with the
 *   first signal's code. The `exit` listener still runs `exitCleanups`, so a
 *   synchronous last resort — `docker rm -f` of every registered container —
 *   happens even when the operator will not wait.
 * - Once a signal has arrived, the process exits 128+N of that first signal
 *   whatever else ends it: the `exit` listener overrides `process.exitCode`,
 *   so a `main` that fails because its backend was just removed, and calls
 *   `process.exit(1)` mid-cleanup, still reports the interruption.
 *
 * Nothing here stops `main` from running on while the cleanups run; a caller
 * that writes results checks `interrupted()` first.
 *
 * Install once per process, from the entry script: two installations would
 * each exit as soon as their own cleanups finish, cutting the other's short.
 */
export function installInterruptHandlers(hooks: InterruptHooks): InterruptHandlers {
  let first: InterruptSignal | null = null;
  let exitCleanupsRan = false;

  const onExit = (): void => {
    if (!exitCleanupsRan) {
      exitCleanupsRan = true;
      for (const cleanup of [...(hooks.exitCleanups ?? [])]) {
        try {
          cleanup();
        } catch (error) {
          warn("an exit cleanup", error);
        }
      }
    }
    if (first !== null) process.exitCode = INTERRUPT_EXIT_CODES[first];
  };

  const runCleanups = async (signal: InterruptSignal): Promise<void> => {
    for (const cleanup of [...hooks.cleanups]) {
      try {
        await cleanup();
      } catch (error) {
        warn("a cleanup", error);
      }
    }
    process.exit(INTERRUPT_EXIT_CODES[signal]);
  };

  const onSignal = (signal: InterruptSignal): void => {
    if (first !== null) {
      console.error(`\n${signal} again — exiting now without waiting for the cleanup.`);
      process.exit(INTERRUPT_EXIT_CODES[first]);
    }
    first = signal;
    console.error(`\n${signal} — cleaning up before exiting; send it again to exit at once.`);
    void runCleanups(signal);
  };

  const listeners = INTERRUPT_SIGNALS.map((signal) => {
    const listener = (): void => onSignal(signal);
    process.on(signal, listener);
    return [signal, listener] as const;
  });
  process.on("exit", onExit);

  return {
    uninstall(): void {
      for (const [signal, listener] of listeners) process.off(signal, listener);
      process.off("exit", onExit);
    },
    interrupted(): InterruptSignal | null {
      return first;
    },
  };
}
