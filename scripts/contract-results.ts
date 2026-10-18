/**
 * Prints the four hidden-test rows of one attempt's eval-results.csv from its
 * contract-results.json, for the scoring skill to paste verbatim:
 *
 *   node --import tsx scripts/contract-results.ts --rows <dir> [--root <path>]
 *
 * `<dir>` is the attempt directory's name (`<id>-attempt-<n>`); the file is
 * `<root>/eval-results/<dir>/contract-results.json`, `<root>` the repository
 * by default. A thin wrapper: the formatting lives in
 * `scripts/lib/contract-results.ts`, which the rubric id covers.
 *
 * Exit 0: four lines on stdout. Exit 1: the file is missing, invalid or
 * belongs to another attempt (a message on stderr, nothing on stdout).
 * Exit 2: usage. Starts nothing, so it is not signal-sensitive.
 */
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CONTRACT_RESULTS_FILE, hiddenRowLines, readContractResults } from "./lib/contract-results";
import { ATTEMPT_DIR_RE } from "./lib/attempts";

const DEFAULT_ROOT = fileURLToPath(new URL("..", import.meta.url));

const USAGE = `Usage: node --import tsx scripts/contract-results.ts --rows <dir> [--root <path>]

  --rows <dir>    Attempt directory name, <id>-attempt-<n>. Prints the four
                  hidden-test CSV lines from
                  <root>/eval-results/<dir>/${CONTRACT_RESULTS_FILE}.
  --root <path>   Holds eval-results/. Default: this repository.
  --help          Print this message.
`;

class UsageError extends Error {}

interface Args {
  rows: string | null;
  root: string;
  help: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { rows: null, root: DEFAULT_ROOT, help: false };
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
    io.err(`contract-results: ${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    io.out(USAGE);
    return 0;
  }
  const dir = args.rows as string;
  const path = join(args.root, "eval-results", dir, CONTRACT_RESULTS_FILE);
  let lines: string[];
  try {
    const results = readContractResults(path);
    if (results.attempt !== dir) {
      throw new Error(`${path} is for attempt ${JSON.stringify(results.attempt)}, not ${JSON.stringify(dir)}`);
    }
    lines = hiddenRowLines(results);
  } catch (error) {
    io.err(`contract-results: ${(error as Error).message}\n`);
    return 1;
  }
  io.out(lines.map((line) => `${line}\n`).join(""));
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
