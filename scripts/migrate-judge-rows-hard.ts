/**
 * migrate-judge-rows-hard.ts — carry every judge-rows-hard.json across a hard
 * rubric id change that touched only the hidden contract tests.
 *
 * A file is restamped only when its rubric equals the id that today's rubric
 * inputs give with contract-tests/ taken from `--from-rev`: that proves nothing
 * the judged rows depend on changed. One file that matches neither that id nor
 * the current one refuses the whole run, and nothing is written. Without
 * `--write` it only reports.
 *
 * Usage:
 *   node --import tsx scripts/migrate-judge-rows-hard.ts --from-rev <git-rev> [--write]
 */
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { hardRubricId } from "./lib/hard-rubric";
import { JUDGE_ROWS_FILE, readJudgeRowsHard, writeJudgeRowsHard, type JudgeRowsHard } from "./lib/judge-rows-hard";
import { hardRubricIdWithContractTestsAt, migrateJudgeRows } from "./lib/judge-rows-migrate";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS_DIR = join(ROOT, "tracks", "console-hard", "eval-results");

function parseArgs(argv: string[]): { fromRev: string; write: boolean } {
  let fromRev: string | null = null;
  let write = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--from-rev") fromRev = argv[++i] ?? null;
    else if (argv[i] === "--write") write = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!fromRev) throw new Error("--from-rev is required");
  return { fromRev, write };
}

function main(): void {
  let args: { fromRev: string; write: boolean };
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }

  const current = hardRubricId(ROOT);
  const old = hardRubricIdWithContractTestsAt(ROOT, args.fromRev);
  console.log(`current rubric: ${current}`);
  console.log(`rubric with contract-tests/ at ${args.fromRev}: ${old}`);
  if (old === current) {
    console.error(`contract-tests/ at ${args.fromRev} equals today's; nothing to migrate`);
    process.exit(1);
  }

  const plan: { path: string; data: JudgeRowsHard }[] = [];
  const refused: string[] = [];
  let alreadyCurrent = 0;
  for (const attempt of readdirSync(RESULTS_DIR).sort()) {
    const path = join(RESULTS_DIR, attempt, JUDGE_ROWS_FILE);
    if (!existsSync(path)) continue;
    const data = readJudgeRowsHard(path);
    if (data.rubric === current) alreadyCurrent++;
    else if (data.rubric === old) plan.push({ path, data });
    else refused.push(`${attempt}: judged under ${data.rubric}, which is neither ${old} nor ${current}`);
  }

  if (refused.length > 0) {
    for (const line of refused) console.error(`refused — ${line}`);
    console.error("Nothing written.");
    process.exit(1);
  }

  const at = new Date().toISOString();
  for (const { path, data } of plan) {
    console.log(`${args.write ? "migrated" : "would migrate"}: ${data.attempt}`);
    if (args.write) writeJudgeRowsHard(path, migrateJudgeRows(data, { toRubric: current, rev: args.fromRev, at }));
  }
  console.log(`${plan.length} to migrate, ${alreadyCurrent} already current${args.write ? "" : " (dry run; pass --write)"}`);
}

main();
