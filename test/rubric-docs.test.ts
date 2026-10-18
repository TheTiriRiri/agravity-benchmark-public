/**
 * The rubric's prose against its code: `benchmark/criteria.md`'s rows table
 * and the CSV template in the scoring skill must list exactly the rows of
 * `scripts/lib/rubric.ts` (spec §5, "scripts/lib/rubric.ts"), and nothing the
 * repository ships may still point at the old task's dossier (spec §5, "Spec
 * files").
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "csv-parse/sync";

import { HIDDEN_ROWS, LIMITS, RUBRIC_ROWS } from "../scripts/lib/rubric";
import { pidStartTime } from "../scripts/serve-attempt";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CRITERIA = "benchmark/criteria.md";
const SKILL = ".claude/skills/agrav-score-attempt/SKILL.md";
const EN_DASH = "–";

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

/** A text with every run of whitespace as one space, so a check survives re-wrapping. */
const flatten = (text: string): string => text.replace(/\s+/g, " ");

/** The lines of the first markdown table outside a code fence. */
function firstTable(markdown: string): string[] {
  const table: string[] = [];
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) {
      if (table.length > 0) break;
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (line.startsWith("|")) table.push(line);
    else if (table.length > 0) break;
  }
  return table;
}

/** The body of every ```csv fence, in order, as lines. */
function csvBlocks(markdown: string): string[][] {
  return [...markdown.matchAll(/^```csv\n([\s\S]*?)\n```$/gm)].map((match) => match[1].split("\n"));
}

function maxCell(max: number | null): string {
  return max === null ? "N/A" : String(max);
}

// --- (a) criteria.md ------------------------------------------------------------

test("criteria.md's first table is RUBRIC_ROWS, byte for byte", () => {
  const expected = [
    "| Criterion | Max | Scored by |",
    "|---|---|---|",
    ...RUBRIC_ROWS.map((r) => `| ${r.name} | ${maxCell(r.max)} | ${r.scoredBy} |`),
  ];
  assert.deepEqual(firstTable(read(CRITERIA)), expected);
});

test("criteria.md states the total max that RUBRIC_ROWS sums to", () => {
  const total = RUBRIC_ROWS.reduce((sum, r) => sum + (r.max ?? 0), 0);
  assert.ok(read(CRITERIA).includes(`**The total max score is ${total} points**`));
});

test("criteria.md words the Notes and the stop rules as the formatter and the harness apply them", () => {
  const criteria = flatten(read(CRITERIA));
  for (const phrase of [
    // diagnose(): every file must have run a test, or it is not one /reset defect.
    "every test that ran failed in its `POST /reset`, and every file ran at least one",
    // sharedEndpoint() keys on the literal request, not on a route template.
    "at the same method and path, query string and ids included",
    // detailForNotes() keeps the tail of a long detail, not its first error line.
    "the hidden-test rows quote the end of the stop's detail instead, as `--rows` prints it",
    // An OOM kill or the operator's Ctrl-C says nothing about the model.
    "a step killed from outside the attempt (the kernel's OOM killer, the operator)",
    // Every human row matches exactly one band, read from the top.
    "or the screens look like different applications, or lapses on most screens",
    "at either width the navigation or content is cut off or unreachable",
  ]) {
    assert.ok(criteria.includes(phrase), `criteria.md says \`${phrase}\``);
  }
});

test("criteria.md's stop rules and Notes quote rubric.ts's LIMITS", () => {
  const criteria = flatten(read(CRITERIA));
  const retries = (n: number): string => (n === 1 ? "one retry" : `${n} retries`);
  for (const phrase of [
    `takes over ${LIMITS.pipInstallMs / 60_000} minutes while PyPI is reachable`,
    `no 2xx from \`/api/v1/health\` within ${LIMITS.healthMs / 1000} s, each request answering within ${LIMITS.healthProbeMs / 1000} s`,
    `taking over ${LIMITS.npmInstallMs / 60_000} minutes while the registry answers`,
    `did not come back up for it after ${retries(LIMITS.restartRetries)}`,
    `\`npm run dev\` not answering HTTP at its \`Local:\` URL within ${LIMITS.devServerStartMs / 1000} s ` +
      `(each request within ${LIMITS.devServerProbeMs / 1000} s), after ${retries(LIMITS.devServerRetries)}`,
  ]) {
    assert.ok(criteria.includes(phrase), `criteria.md says \`${phrase}\``);
  }
});

// --- (b) SKILL.md ---------------------------------------------------------------

test("SKILL.md's first csv block is the header and the 14 rows of RUBRIC_ROWS, in order", () => {
  const [template] = csvBlocks(read(SKILL));
  assert.ok(template, "SKILL.md has a ```csv block");
  assert.equal(template[0], "Criterion,Score,Max,Notes");
  assert.equal(template.length, 1 + RUBRIC_ROWS.length, "exactly 14 rows after the header");
  RUBRIC_ROWS.forEach((r, i) => {
    const line = template[i + 1];
    assert.ok(line.startsWith(`${r.name},`), `line ${i + 2} starts with ${JSON.stringify(`${r.name},`)}: ${line}`);
  });
});

test("the template prints rubric.ts's Max on every row it does not paste from --rows", () => {
  const [template] = csvBlocks(read(SKILL));
  RUBRIC_ROWS.forEach((r, i) => {
    const line = template[i + 1];
    if (r.scoredBy === "hidden") {
      // --rows prints whole lines that start with the name: the whole template line is replaced.
      const n = HIDDEN_ROWS.indexOf(r) + 1;
      assert.equal(line, `${r.name},<replace this whole line with line ${n} of --rows>`, `${r.name} is replaced by --rows' line ${n}`);
      return;
    }
    const cells = line.slice(r.name.length + 1).split(",");
    assert.equal(cells[1], maxCell(r.max), `${r.name}'s Max`);
  });
});

test("every other csv block in SKILL.md is a complete CSV of zeros with rubric.ts's rows and maxima", () => {
  const blocks = csvBlocks(read(SKILL)).slice(1);
  assert.ok(blocks.length >= 1, "SKILL.md shows the all-zero CSV");
  for (const lines of blocks) {
    const rows = parse(`${lines.join("\n")}\n`, { columns: true }) as Array<Record<string, string>>;
    assert.deepEqual(rows.map((row) => row.Criterion), RUBRIC_ROWS.map((r) => r.name));
    RUBRIC_ROWS.forEach((r, i) => {
      assert.equal(rows[i].Max, maxCell(r.max), `${r.name}'s Max`);
      if (r.max !== null || r.scoredBy === "penalty") assert.equal(rows[i].Score, "0", `${r.name} scores 0`);
    });
  }
});

test("SKILL.md bounds npm install and npm ping by rubric.ts's LIMITS", () => {
  const skill = read(SKILL);
  for (const command of [
    // -v: the limit leaves a `timeout: sending signal` line, the only way to tell
    // its 137 (TERM ignored, then KILL) from a signal the skill did not send.
    `timeout -v -k 10 ${LIMITS.npmInstallMs / 1000} npm install`,
    `timeout -k 5 ${LIMITS.registryProbeMs / 1000} npm ping`,
  ]) {
    assert.ok(skill.includes(command), `SKILL.md runs \`${command}\``);
  }
  assert.ok(skill.includes("a `timeout: sending signal` line"), "SKILL.md reads the limit's own line, not the exit code");
  const flatSkill = flatten(skill);
  // `timeout -v` prints the line too when it passes on a signal sent to it from
  // outside (exit 143): only 124 or 137 with the line is the limit running out.
  assert.ok(
    flatSkill.includes("a `timeout: sending signal` line and an exit of 124 or 137: the 10-minute limit ran out"),
    "SKILL.md takes the line for the limit only with an exit of 124 or 137",
  );
  assert.ok(
    flatSkill.includes("such a line with any exit other than 124 or 137"),
    "a line with any other exit falls into the ask-the-user case",
  );
  assert.ok(!skill.includes("124 is the timeout"), "124 is not the only exit the limit gives");
  assert.ok(flatSkill.includes("ask the user whether something outside the attempt killed it"), "SKILL.md asks before scoring an exit of 128 or above as a stop");
});

test("SKILL.md's past-the-lock line is the one serve-attempt prints, and it prints it only once past its lock and its port check", () => {
  // After an interruption the skill runs --stop only when the state file names
  // the attempt or serve.log has this line: a misquoted line would never match.
  const serve = read("scripts/serve-attempt.ts");
  const printed = serve.indexOf("d.out(`serve-attempt: ${options.attempt} in ${image.ref}`)");
  assert.ok(printed !== -1, "serve-attempt no longer prints `serve-attempt: <dir> in <image>`: update SKILL.md's exit=128 rule");
  const lock = serve.indexOf("StateFile.create(path, initial, d.out)");
  assert.ok(lock !== -1 && lock < printed, "serve-attempt prints the line after it takes its lock");
  // SKILL.md's Phase 2 begins past the port check, and a busy-port refusal owes no --stop.
  const ports = serve.indexOf("d.busyPorts(");
  assert.ok(ports !== -1 && lock < ports && ports < printed, "serve-attempt checks the ports after its lock and before it prints the line");
  const refusal = serve.slice(ports, printed);
  assert.ok(refusal.includes("file.release();"), "a busy-port refusal releases the lock itself, so it owes no --stop");
  assert.ok(refusal.includes("already in use."), "the busy-port refusal says `already in use`, as SKILL.md quotes it");
  const skill = read(SKILL);
  assert.ok(skill.includes("`serve-attempt: <dir> in <image>`"), "SKILL.md quotes the line");
  assert.ok(skill.includes('grep "^serve-attempt: <dir> in " <log>/serve.log'), "SKILL.md looks for it in serve.log");
});

test("SKILL.md's dev-server-exited grep is the prefix of the warning serve-attempt prints", () => {
  // The only way the judge learns the dev server died while serving: a
  // reworded warning would make the grep match nothing, and the live-app rows
  // would be scored on a dead app without asking.
  const serve = read("scripts/serve-attempt.ts");
  const built = serve.indexOf("const reason = `the dev server exited after it was ready (${");
  assert.ok(built !== -1, "serve-attempt no longer builds `the dev server exited after it was ready (…)`: update SKILL.md's grep");
  const printed = serve.indexOf("d.out(`warning: ${reason}`)", built);
  assert.ok(printed !== -1 && printed - built < 200, "serve-attempt prints it as `warning: <reason>`, right where it builds it");
  const line = "warning: the dev server exited after it was ready (code 0)";
  const grep = /grep "\^(warning: the dev server exited after it was ready[^"]*)" <log>\/serve\.log/.exec(read(SKILL));
  assert.ok(grep !== null, "SKILL.md greps serve.log for the warning");
  assert.ok(line.startsWith(grep[1]), `SKILL.md's pattern ${JSON.stringify(grep[1])} is not a prefix of ${JSON.stringify(line)}`);
});

// --- (c) the en dash ------------------------------------------------------------

test("the integration row's dash is U+2013 in criteria.md and SKILL.md", () => {
  const name = RUBRIC_ROWS.find((r) => r.scoredBy === "agent")?.name;
  assert.equal(name, `Frontend${EN_DASH}API integration`);
  for (const path of [CRITERIA, SKILL]) {
    const text = read(path);
    const spellings = [...text.matchAll(/Frontend(.)API integration/gu)].map((match) => match[1]);
    assert.ok(spellings.length > 0, `${path} names the row`);
    for (const dash of spellings) {
      assert.equal(dash, EN_DASH, `${path} spells it with U+${dash.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0")}`);
    }
  }
});

// --- (d) the old dossier --------------------------------------------------------

/** Built from parts, so this file does not match itself. */
const DOSSIER = ["przeprog", "ramowani", ".md"].join("");
const SHIPPED = ["benchmark", "scripts", "test", "website", ".claude", "prompt.md", "package.json", "CLAUDE.md"];

/** Git's own variables that would point `git -C ROOT` at another repository (set inside hooks). */
const GIT_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR", "GIT_PREFIX"];

function trackedFiles(paths: string[]): string[] {
  const env = { ...process.env };
  for (const key of GIT_ENV) delete env[key];
  const result = spawnSync("git", ["-C", ROOT, "ls-files", "-z", "--", ...paths], { encoding: "utf8", env, timeout: 30_000 });
  assert.equal(result.status, 0, `git ls-files failed: ${result.stderr}`);
  return result.stdout.split("\0").filter((path) => path !== "");
}

test("the old task's dossier is gone", () => {
  assert.equal(existsSync(join(ROOT, "benchmark", "context", DOSSIER)), false);
});

test("nothing the repository ships refers to the old task's dossier", () => {
  const files = trackedFiles(SHIPPED);
  assert.ok(files.includes(CRITERIA) && files.includes(SKILL) && files.includes("CLAUDE.md"), "the scan sees the tracked files");
  const hits: string[] = [];
  for (const file of files) {
    const path = join(ROOT, file);
    if (!existsSync(path) || !statSync(path).isFile()) continue;
    const bytes = readFileSync(path);
    if (bytes.subarray(0, 8000).includes(0)) continue; // binary
    if (bytes.toString("utf8").toLowerCase().includes(DOSSIER)) hits.push(file);
  }
  assert.deepEqual(hits, [], `still naming ${DOSSIER}`);
});

// --- the fixes plan 3 made ------------------------------------------------------

const scratch: string[] = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

test("SKILL.md no longer confines itself to synthetic attempts", () => {
  const skill = read(SKILL);
  assert.equal(skill.includes("Until plan 3"), false);
  assert.equal(skill.includes("only on synthetic attempts"), false);
});

test("the exit=128 rule tells another run's live owner by pid and start time, not by pid alone", () => {
  const skill = read(SKILL);
  const section = skill.slice(skill.indexOf("- **`exit=128` or above**"), skill.indexOf("- **`ready: <url>"));
  assert.equal(section.includes("ps -p"), false, "a reused pid would pass ps -p");
  assert.ok(section.includes('import { isServeOwnerLive } from "./scripts/serve-attempt";'), "the rule runs isServeOwnerLive");

  // Run the owner one-liner itself, the way "Before you report"'s check one-liner is run below:
  // a wrong argv index, a lost --input-type=module or a changed state-file shape must fail this.
  const match = /node --import tsx --input-type=module -e '\n([\s\S]*?)\n\s*' <r>\/\.cache\/serve-attempt\.json/.exec(section);
  assert.ok(match !== null, "the owner one-liner under the exit=128 rule");
  const run = (contents: string): { status: number | null; stdout: string } => {
    const dir = mkdtempSync(join(tmpdir(), "agrav-skill-owner-"));
    scratch.push(dir);
    const path = join(dir, "serve-attempt.json");
    writeFileSync(path, contents);
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", match[1], path], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 30_000,
    });
    return { status: result.status, stdout: result.stdout.trim() };
  };
  const start = pidStartTime(process.pid);
  assert.ok(start !== null, "this test's own pid has a start time");
  assert.deepEqual(run(JSON.stringify({ pid: process.pid, pidStart: start })), { status: 0, stdout: "owner live" });
  assert.deepEqual(
    run(JSON.stringify({ pid: process.pid, pidStart: String(BigInt(start) + 1n) })),
    { status: 0, stdout: "owner gone" },
    "a pid reused by an unrelated process has another start time",
  );
  const unreadable = run("not json");
  assert.notEqual(unreadable.status, 0, "an unparseable state file throws rather than printing owner live or gone");
});

test("Before you report's item 3 owes a --stop exactly when the exit=128 rule does", () => {
  const flat = flatten(read(SKILL));
  assert.ok(flat.includes("3. If a `--stop` was owed — Phase 2 began and no signal ended it"), "item 3's first sentence");
});

test("the check one-liner passes a good CSV and prints WRONG, not a stack trace, for a column-count error", () => {
  // Only the section: the exit=128 rule has a node -e block of its own, earlier in the file.
  const section = read(SKILL).slice(read(SKILL).indexOf("## Before you report"));
  const match = /node --import tsx --input-type=module -e '\n([\s\S]*?)\n\s*' <r>\/eval-results\/<dir>\/eval-results\.csv/.exec(section);
  assert.ok(match !== null, "the one-liner under Before you report");
  const check = (csv: string): { status: number | null; stdout: string } => {
    const dir = mkdtempSync(join(tmpdir(), "agrav-skill-check-"));
    scratch.push(dir);
    writeFileSync(join(dir, "eval-results.csv"), csv);
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", match[1], join(dir, "eval-results.csv")], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 30_000,
    });
    return { status: result.status, stdout: result.stdout.trim() };
  };
  const good = read("test/fixtures/eval-results/gemini-38-flash-low-attempt-1/eval-results.csv");
  assert.deepEqual(check(good), { status: 0, stdout: "15 lines, 14 rows; names, order, Max and Score cells match rubric.ts" });

  const extraColumn = good.replace('Code structure,1,1,"', 'Code structure,1,1,extra,"');
  const bad = check(extraColumn);
  assert.equal(bad.status, 0);
  assert.match(bad.stdout, /^WRONG: not a CSV of the four columns: /);
});
