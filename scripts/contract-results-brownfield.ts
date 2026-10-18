/**
 * Prints the three tool-provided rows of one brownfield attempt's eval-results.csv from its
 * contract-results-brownfield.json, for the scoring skill to paste verbatim:
 *
 *   node --import tsx scripts/contract-results-brownfield.ts --rows <dir> [--root <path>]
 *
 * `<dir>` is the attempt directory's name (`<id>-attempt-<n>`); the file is
 * `<root>/eval-results/<dir>/contract-results-brownfield.json`.
 *
 * Exit 0: three lines on stdout. Exit 1: the file is missing, invalid or
 * belongs to another attempt (a message on stderr, nothing on stdout).
 * Exit 2: usage. Starts nothing, so it is not signal-sensitive.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BROWNFIELD_RESULTS_FILE,
  brownfieldHiddenRowLines,
  readBrownfieldContractResults,
} from "./lib/brownfield-contract-results";
import { ATTEMPT_DIR_RE } from "./lib/attempts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_TRACK_ROOT = join(REPO_ROOT, "tracks", "brownfield");

const USAGE = `Usage: node --import tsx scripts/contract-results-brownfield.ts --rows <dir> [--root <path>]

  --rows <dir>    Attempt directory name, <id>-attempt-<n>. Prints the three
                  tool-provided CSV lines from
                  <root>/eval-results/<dir>/${BROWNFIELD_RESULTS_FILE}.
  --root <path>   Holds eval-results/. Default: tracks/brownfield.
  --help          Print this message.
`;

class UsageError extends Error {}

interface Args {
  rows: string | null;
  root: string;
  help: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { rows: null, root: DEFAULT_TRACK_ROOT, help: false };
  let rootGiven = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const eq = token.startsWith("--") ? token.indexOf("=") : -1;
    const name = eq === -1 ? token : token.slice(0, eq);
    const value = (): string => {
      const next = eq === -1 ? argv[++i] : token.slice(eq + 1);
      if (next === undefined || next === "" || next.startsWith("--")) throw new UsageError(`${name} needs a value`);
      return next;
    };
    switch (name) {
      case "--rows":
        if (args.rows !== null) throw new UsageError("--rows given twice");
        args.rows = value();
        break;
      case "--root":
        if (rootGiven) throw new UsageError("--root given twice");
        rootGiven = true;
        args.root = resolve(value());
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        throw new UsageError(`unknown argument ${JSON.stringify(token)}`);
    }
  }
  if (!args.help && args.rows === null) throw new UsageError("--rows <dir> is required");
  if (args.rows !== null && !ATTEMPT_DIR_RE.test(args.rows)) {
    throw new UsageError(`--rows takes an attempt directory name like gemini-38-flash-high-attempt-1, got ${JSON.stringify(args.rows)}`);
  }
  return args;
}

export interface Output {
  out: (text: string) => void;
  err: (text: string) => void;
}

const STDIO: Output = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

export function main(argv: string[], io: Output = STDIO): number {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.err(`contract-results-brownfield: ${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    io.out(USAGE);
    return 0;
  }
  const dir = args.rows as string;
  const path = join(args.root, "eval-results", dir, BROWNFIELD_RESULTS_FILE);

  let lines: string[];
  try {
    const results = readBrownfieldContractResults(path);
    if (results.attempt !== dir) {
      throw new Error(`${path} is for attempt ${JSON.stringify(results.attempt)}, not ${JSON.stringify(dir)}`);
    }
    lines = brownfieldHiddenRowLines(results);
  } catch (error) {
    io.err(`contract-results-brownfield: ${(error as Error).message}\n`);
    return 1;
  }
  io.out(lines.map((line) => `${line}\n`).join(""));
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
