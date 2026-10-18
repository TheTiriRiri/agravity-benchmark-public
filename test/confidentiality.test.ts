/**
 * Spec §2: no real project, client, service name, identifier, schema, datum or
 * credential in this repository — in its files or in its commit messages.
 *
 * The forbidden terms are never written here. They come from the gitignored
 * `.confidential-terms` or from `CONFIDENTIAL_TERMS` (a CI secret). With
 * neither, the scan still looks for secrets, and fails only when
 * `REQUIRE_CONFIDENTIAL_TERMS=true`.
 * A finding names where it is and the terms file's line — never the term, so a
 * red test cannot leak what it guards.
 *
 * Every sample secret below is assembled from pieces, so this file does not
 * match its own patterns.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  GIT_ENV_TO_STRIP,
  MIN_TERM_LENGTH,
  SECRET_PATTERNS,
  TERMS_FILE,
  TERMS_VARIABLE,
  loadTerms,
  looksBinary,
  parseTerms,
  scanGitHistory,
  scanPathForTerms,
  scanText,
} from "../scripts/lib/confidentiality";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const scratch: string[] = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function gitIn(cwd: string, args: string[]): string {
  const env = { ...process.env };
  for (const name of GIT_ENV_TO_STRIP) delete env[name];
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env, maxBuffer: 256 * 1024 * 1024 });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

function git(args: string[]): string {
  return gitIn(ROOT, args);
}

/** Like `git`, but returns raw bytes — for a blob that may be binary. */
function gitBytes(args: string[]): Buffer {
  const env = { ...process.env };
  for (const name of GIT_ENV_TO_STRIP) delete env[name];
  const result = spawnSync("git", args, { cwd: ROOT, env, maxBuffer: 256 * 1024 * 1024 });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr?.toString() ?? ""}`);
  return result.stdout as Buffer;
}

/**
 * Identity passed per command, never written: these tests must not touch any
 * git config, not even a throwaway repository's, and signing would need a key.
 */
function identity(name = "Ordinary Committer", email = "ordinary@example.invalid"): string[] {
  return [
    "-c", `user.name=${name}`,
    "-c", `user.email=${email}`,
    "-c", "commit.gpgsign=false",
    "-c", "tag.gpgsign=false",
  ];
}

/** An empty git repository under `os.tmpdir()`, removed by the `after` hook. */
function throwawayRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "agrav-confidential-repo-"));
  scratch.push(dir);
  gitIn(dir, ["init", "-q", "-b", "main"]);
  return dir;
}

function commit(repo: string, paths: string[], message: string, who: string[] = identity()): void {
  if (paths.length > 0) gitIn(repo, ["add", "--", ...paths]);
  gitIn(repo, [...who, "commit", "-q", "--no-gpg-sign", "-m", message]);
}

const glue = (...parts: string[]): string => parts.join("");

/** One sample per pattern, in SECRET_PATTERNS' order. */
const SAMPLES: readonly string[] = [
  glue("s", "k-", "A1b2C3d4E5f6G7h8I9j0K1"),
  glue("AI", "za", "B".repeat(35)),
  glue("gh", "p_", "c".repeat(36)),
  glue("github", "_pat_", "d".repeat(22)),
  glue("gl", "pat-", "e".repeat(20)),
  glue("xo", "xb-", "1234567890"),
  glue("ya", "29.", "f".repeat(20)),
  glue("1/", "/0", "g".repeat(20)),
  glue("-----BEGIN RSA PRIV", "ATE KEY-----"),
];

test("every secret pattern matches a sample of its own shape", () => {
  assert.equal(SAMPLES.length, SECRET_PATTERNS.length);
  SECRET_PATTERNS.forEach((pattern, i) => {
    assert.deepEqual(scanText(`x ${SAMPLES[i]} y`, "f", []), [{ where: "f:1", what: pattern.name }], pattern.name);
  });
  // A key glued to a word that ends in a digit still matches: \b would miss it.
  assert.equal(scanText(glue("ctx7", "s", "k-", "A1b2C3d4E5f6G7h8I9j0K1"), "f", []).length, 1);
});

test("ordinary words and look-alikes are not secrets", () => {
  for (const text of [
    "task-by-task",
    "desk-top-level-a-long-word-here",
    glue("s", "k-", "short"),
    glue("AI", "za", "tooShort"),
    glue("1/", "/0", "short"),
    "BEGIN PUBLIC KEY",
  ]) {
    assert.deepEqual(scanText(text, "f", []), [], text);
  }
});

test("parseTerms: one term per line, case folded, comments and blanks skipped", () => {
  const terms = parseTerms("# a comment\n\n  Zebra Widget  \nQuokka-Works\r\n", "the file");
  assert.deepEqual(terms, [
    { source: "the file", line: 3, lower: "zebra widget" },
    { source: "the file", line: 4, lower: "quokka-works" },
  ]);
});

test("parseTerms refuses a term that is too short, by its line number and never its text", () => {
  assert.equal(MIN_TERM_LENGTH, 3);
  assert.throws(
    () => parseTerms("zebra widget\nqx\n", "the file"),
    (error: Error) => {
      assert.match(error.message, /line 2 of the file/);
      assert.equal(error.message.includes("qx"), false, error.message);
      return true;
    },
  );
});

test("a finding names the term's source and line, never the term", () => {
  const terms = parseTerms("quokka-works\nZebra Widget\n", "the file");
  const findings = scanText("nothing here\nsee the ZEBRA widget page\n", "docs/x.md", terms);
  assert.deepEqual(findings, [{ where: "docs/x.md:2", what: "forbidden term on line 2 of the file" }]);
  assert.equal(JSON.stringify(findings).toLowerCase().includes("zebra"), false);
});

test("scanText: a term matches wrapped across a line break, reported at its starting line", () => {
  const terms = parseTerms("Big Bad Wolf\n", "the file");
  const findings = scanText("intro\nthe Big\nBad Wolf story\nBig Bad Wolf again on one line\n", "f", terms);
  assert.deepEqual(findings, [
    { where: "f:2", what: "forbidden term on line 1 of the file" },
    { where: "f:4", what: "forbidden term on line 1 of the file" },
  ]);
});

test("scanText: a term matches regardless of how many spaces separate its words", () => {
  const terms = parseTerms("Special Sausages Formula\n", "the file");
  const findings = scanText("no match here\nSpecial   Sausages    Formula\n", "f", terms);
  assert.deepEqual(findings, [{ where: "f:2", what: "forbidden term on line 1 of the file" }]);
});

test("scanText: the same term twice on one line is one finding, not two", () => {
  const terms = parseTerms("Zebra Widget\n", "the file");
  const findings = scanText("Zebra Widget and another Zebra Widget on the same line\n", "f", terms);
  assert.deepEqual(findings, [{ where: "f:1", what: "forbidden term on line 1 of the file" }]);
});

test("scanPathForTerms: a term in a path is reported by the given label, never the path", () => {
  const terms = parseTerms("Quokka-Works\n", "the file");
  const findings = scanPathForTerms("src/quokka-works/config.ts", "tracked path #7", terms);
  assert.deepEqual(findings, [{ where: "tracked path #7", what: "forbidden term on line 1 of the file" }]);
  assert.equal(JSON.stringify(findings).toLowerCase().includes("quokka"), false);
  assert.equal(JSON.stringify(findings).includes("src/"), false);
});

test("scanPathForTerms: no term in the path yields nothing", () => {
  const terms = parseTerms("Quokka-Works\n", "the file");
  assert.deepEqual(scanPathForTerms("src/ordinary/config.ts", "tracked path #7", terms), []);
});

test("a multi-word term matches however its words are run together", () => {
  // A name reaches code as an identifier, a filename and a slug long before it
  // reaches prose. Joining the words on spaces alone found none of these.
  const terms = parseTerms("Zebra Widget\n", "the file");
  for (const spelling of [
    "zebra widget",
    "zebra_widget",
    "zebra-widget",
    "zebra.widget",
    "zebraWidget",
    "ZEBRA.WIDGET",
    "Zebra   Widget",
    "zebra__widget",
  ]) {
    assert.deepEqual(
      scanText(`see the ${spelling} here\n`, "f", terms),
      [{ where: "f:1", what: "forbidden term on line 1 of the file" }],
      spelling,
    );
    assert.deepEqual(
      scanPathForTerms(`src/${spelling}/config.ts`, "tracked path #7", terms),
      [{ where: "tracked path #7", what: "forbidden term on line 1 of the file" }],
      spelling,
    );
  }
});

test("a term matches at the start of a word, never inside a longer run of letters and digits", () => {
  const twoWords = parseTerms("Zebra Widget\n", "the file");
  assert.deepEqual(scanText("a zebra in a field\n", "f", twoWords), [], "one word of the term is not the term");
  assert.deepEqual(scanText("widgets everywhere\n", "f", twoWords), []);

  const oneWord = parseTerms("Quokka\n", "the file");
  const hit = [{ where: "f:1", what: "forbidden term on line 1 of the file" }];
  for (const text of ["the quokkaWorks build", "mail ops@quokka.example", "QUOKKA-2 ticket", "see /quokka/", "x_quokka"]) {
    assert.deepEqual(scanText(`${text}\n`, "f", oneWord), hit, text);
  }
  for (const text of ["the myquokka build", "sha512-Ab3QuOkKa9==", "2quokka", "nothing to see"]) {
    assert.deepEqual(scanText(`${text}\n`, "f", oneWord), [], text);
  }
  assert.deepEqual(scanPathForTerms("src/quokka-works/config.ts", "tracked path #1", oneWord), [
    { where: "tracked path #1", what: "forbidden term on line 1 of the file" },
  ]);
  assert.deepEqual(scanPathForTerms("src/myquokka/config.ts", "tracked path #1", oneWord), []);
});

test("a term matches the same text in NFC and in NFD", () => {
  const composed = "Zèbre Wîdget";
  const decomposed = composed.normalize("NFD");
  assert.notEqual(composed, decomposed);
  for (const written of [composed, decomposed]) {
    const terms = parseTerms(`${written}\n`, "the file");
    for (const text of [composed, decomposed]) {
      assert.deepEqual(
        scanText(`line one\nthe ${text} page\n`, "f", terms),
        [{ where: "f:2", what: "forbidden term on line 1 of the file" }],
        `${written === composed ? "NFC" : "NFD"} term vs ${text === composed ? "NFC" : "NFD"} text`,
      );
      assert.deepEqual(scanPathForTerms(`docs/${text}.md`, "tracked path #1", terms), [
        { where: "tracked path #1", what: "forbidden term on line 1 of the file" },
      ]);
    }
  }
});

test("MIN_TERM_LENGTH still guards the pattern that optional separators could collapse", () => {
  // Every separator between a term's words is optional now, so nothing but this
  // guard keeps a term from becoming a pattern short enough to hit inside
  // ordinary words — or, for a term of separators alone, an empty one.
  assert.equal(MIN_TERM_LENGTH, 3);
  for (const tooShort of ["xy", "a", "-"]) {
    assert.throws(() => parseTerms(`${tooShort}\n`, "the file"), /shorter than 3 characters/, tooShort);
  }
  // Three characters of separators is the shortest thing that gets through, and
  // it is still a pattern with something in it.
  assert.deepEqual(scanText("a-b\n", "f", parseTerms("- -\n", "the file")), []);
  assert.deepEqual(scanText("x - - y\n", "f", parseTerms("- -\n", "the file")), [
    { where: "f:1", what: "forbidden term on line 1 of the file" },
  ]);
});

// --- the history, not only the working tree ----------------------------------

test("scanGitHistory finds a term in a file that was later removed", () => {
  const repo = throwawayRepo();
  writeFileSync(join(repo, "notes.md"), "intro\nthe Zebra Widget rollout\n");
  commit(repo, ["notes.md"], "add notes");
  gitIn(repo, ["rm", "-q", "--", "notes.md"]);
  commit(repo, [], "remove the notes again");

  const terms = parseTerms("Zebra Widget\n", "the file");
  assert.equal(existsSync(join(repo, "notes.md")), false, "the working tree keeps nothing to find");

  const findings = scanGitHistory(repo, terms);
  assert.ok(
    findings.some((f) => /^blob [0-9a-f]{12}:2$/.test(f.where) && f.what === "forbidden term on line 1 of the file"),
    JSON.stringify(findings),
  );
  assert.equal(JSON.stringify(findings).toLowerCase().includes("zebra"), false);
  assert.equal(JSON.stringify(findings).includes("notes.md"), false);
});

test("scanGitHistory finds a term in a historical file or directory name", () => {
  const repo = throwawayRepo();
  mkdirSync(join(repo, "quokka-works"), { recursive: true });
  writeFileSync(join(repo, "quokka-works", "config.ts"), "export const ordinary = 1;\n");
  commit(repo, ["quokka-works/config.ts"], "add a configuration");
  gitIn(repo, ["rm", "-q", "-r", "--", "quokka-works"]);
  commit(repo, [], "take it out again");

  const findings = scanGitHistory(repo, parseTerms("Quokka Works\n", "the file"));
  assert.ok(findings.some((f) => /^historical path #\d+$/.test(f.where)), JSON.stringify(findings));
  assert.equal(JSON.stringify(findings).toLowerCase().includes("quokka"), false);
});

test("scanGitHistory finds the old name of a file renamed without a content change", () => {
  const repo = throwawayRepo();
  writeFileSync(join(repo, "quokka-works-notes.md"), "an ordinary note\n");
  commit(repo, ["quokka-works-notes.md"], "add a note");
  // What someone actually does on spotting a name in a path — and after it the
  // old name is in no listing of today's objects, only in the commits.
  gitIn(repo, ["mv", "quokka-works-notes.md", "boring-notes.md"]);
  commit(repo, [], "rename the note");

  const findings = scanGitHistory(repo, parseTerms("Quokka Works\n", "the file"));
  assert.ok(findings.some((f) => /^historical path #\d+$/.test(f.where)), JSON.stringify(findings));
  assert.equal(JSON.stringify(findings).toLowerCase().includes("quokka"), false);
});

test("scanGitHistory finds the old name of a renamed directory", () => {
  const repo = throwawayRepo();
  mkdirSync(join(repo, "quokka-works"), { recursive: true });
  writeFileSync(join(repo, "quokka-works", "config.ts"), "export const ordinary = 1;\n");
  commit(repo, ["quokka-works/config.ts"], "add a configuration");
  gitIn(repo, ["mv", "quokka-works", "boring-stuff"]);
  commit(repo, [], "rename the directory");

  const findings = scanGitHistory(repo, parseTerms("Quokka Works\n", "the file"));
  assert.ok(findings.some((f) => /^historical path #\d+$/.test(f.where)), JSON.stringify(findings));
  assert.equal(JSON.stringify(findings).toLowerCase().includes("quokka"), false);
});

test("scanGitHistory finds a term committed on a branch that is not checked out", () => {
  const repo = throwawayRepo();
  writeFileSync(join(repo, "README.md"), "an ordinary readme\n");
  commit(repo, ["README.md"], "first");
  gitIn(repo, ["checkout", "-q", "-b", "side"]);
  writeFileSync(join(repo, "notes.md"), "the Zebra Widget rollout\n");
  commit(repo, ["notes.md"], "add notes on the side branch");
  gitIn(repo, ["checkout", "-q", "main"]);

  const findings = scanGitHistory(repo, parseTerms("Zebra Widget\n", "the file"));
  assert.ok(findings.some((f) => /^blob [0-9a-f]{12}:1$/.test(f.where)), JSON.stringify(findings));
  assert.equal(JSON.stringify(findings).toLowerCase().includes("zebra"), false);
});

test("scanGitHistory finds a term in a commit's author, in a ref name and in a tag message", () => {
  const repo = throwawayRepo();
  writeFileSync(join(repo, "README.md"), "nothing to see here\n");
  commit(repo, ["README.md"], "first", identity("Zebra Widget Bot", "bot@example.invalid"));
  gitIn(repo, ["branch", "release/zebra-widget"]);
  gitIn(repo, [
    ...identity(),
    "tag",
    "-a",
    "quokka-works-1.0",
    "-m",
    "cut for the Quokka Works launch",
  ]);

  const terms = parseTerms("Zebra Widget\nQuokka Works\n", "the file");
  const findings = scanGitHistory(repo, terms);
  const where = findings.map((f) => f.where);

  assert.ok(where.some((w) => /^commit [0-9a-f]{12}:1$/.test(w)), `no author finding in ${JSON.stringify(findings)}`);
  assert.ok(where.some((w) => /^ref #\d+ name:/.test(w)), `no ref-name finding in ${JSON.stringify(findings)}`);
  // The field boundaries hold: the tag's own name and its message are separate
  // fields of one record, so they are two findings under one ref number —
  // which the glued single-line record they used to arrive as could not show.
  const tagRef = where
    .filter((w) => /^ref #\d+ message:/.test(w))
    .map((w) => w.slice(0, w.indexOf(" ", "ref #".length)));
  assert.equal(tagRef.length, 1, `expected exactly one tag-message finding: ${JSON.stringify(findings)}`);
  assert.ok(
    where.includes(`${tagRef[0]} name:1`),
    `the tag's name and message must be found separately: ${JSON.stringify(findings)}`,
  );
  const printed = JSON.stringify(findings).toLowerCase();
  assert.equal(printed.includes("zebra"), false);
  assert.equal(printed.includes("quokka"), false);
  assert.equal(printed.includes("release/"), false);
});

test("scanGitHistory finds nothing in a repository that never held the term", () => {
  const repo = throwawayRepo();
  writeFileSync(join(repo, "README.md"), "an ordinary readme\n");
  commit(repo, ["README.md"], "ordinary commit on an ordinary branch");
  gitIn(repo, [...identity(), "tag", "-a", "v1.0", "-m", "an ordinary release"]);

  assert.deepEqual(scanGitHistory(repo, parseTerms("Zebra Widget\nQuokka Works\n", "the file")), []);
});

test("scanGitHistory asserts on a git failure rather than reporting a clean history", () => {
  const notARepo = mkdtempSync(join(tmpdir(), "agrav-confidential-norepo-"));
  scratch.push(notARepo);
  assert.throws(() => scanGitHistory(notARepo, parseTerms("Zebra Widget\n", "the file")), /git rev-list/);
});

test("loadTerms reads the file and the variable, and says when there is neither", () => {
  const root = mkdtempSync(join(tmpdir(), "agrav-confidential-"));
  scratch.push(root);
  assert.deepEqual(loadTerms(root, {}), { terms: null, sources: [] });
  assert.deepEqual(loadTerms(root, { [TERMS_VARIABLE]: "  \n" }), { terms: null, sources: [] });

  writeFileSync(join(root, TERMS_FILE), "zebra widget\n");
  const both = loadTerms(root, { [TERMS_VARIABLE]: "quokka-works\n" });
  assert.deepEqual(both.sources, [TERMS_FILE, TERMS_VARIABLE]);
  assert.deepEqual(
    both.terms?.map((t) => `${t.source}:${t.line}`),
    [`${TERMS_FILE}:1`, `${TERMS_VARIABLE}:1`],
  );
});

test("loadTerms treats an empty or comments-only source as missing, not as zero terms", () => {
  const root = mkdtempSync(join(tmpdir(), "agrav-confidential-"));
  scratch.push(root);

  writeFileSync(join(root, TERMS_FILE), "");
  assert.deepEqual(loadTerms(root, {}), { terms: null, sources: [] });

  writeFileSync(join(root, TERMS_FILE), "# just a comment\n\n");
  assert.deepEqual(loadTerms(root, {}), { terms: null, sources: [] });

  rmSync(join(root, TERMS_FILE));
  assert.deepEqual(loadTerms(root, { [TERMS_VARIABLE]: "# just a comment\n" }), { terms: null, sources: [] });
});

test("looksBinary: a NUL in the first 8000 bytes", () => {
  assert.equal(looksBinary(Buffer.from("plain text\n")), false);
  assert.equal(looksBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])), true);
  const late = Buffer.alloc(9000, 0x61);
  late[8500] = 0;
  assert.equal(looksBinary(late), false);
});

test("tracked files, every reachable blob, commit and ref hold no secret and no forbidden term", (t) => {
  const loaded = loadTerms(ROOT, process.env);
  if (loaded.terms === null) {
    assert.notEqual(
      process.env.REQUIRE_CONFIDENTIAL_TERMS,
      "true",
      `REQUIRE_CONFIDENTIAL_TERMS is true, but neither ${TERMS_FILE} nor ${TERMS_VARIABLE} is set: the forbidden-term scan cannot run`,
    );
    t.diagnostic(`warning: no ${TERMS_FILE} and no ${TERMS_VARIABLE}; scanning for secrets only`);
  }
  const terms = loaded.terms ?? [];

  const findings: string[] = [];
  const paths = git(["ls-files", "-z"]).split("\0").filter((p) => p !== "");
  paths.forEach((path, index) => {
    // A term in the path itself (a file or directory name) is reported by an
    // index label, never by the path, which could echo the term right back.
    const label = `tracked path #${index}`;
    const pathFindings = scanPathForTerms(path, label, terms);
    for (const f of pathFindings) findings.push(`${f.where} — ${f.what}`);
    const where = pathFindings.length > 0 ? label : path;

    const full = join(ROOT, path);
    let content: string;
    try {
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) {
        // A symlink's content is its target text, not the file it points at;
        // git tracks the link itself, so that is what gets scanned.
        content = readlinkSync(full);
      } else {
        const bytes = readFileSync(full);
        if (looksBinary(bytes)) return;
        content = bytes.toString("utf8");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Tracked but missing from the working tree: fall back to the index blob
      // rather than silently skipping a file the scan is supposed to cover.
      const bytes = gitBytes(["cat-file", "blob", `:${path}`]);
      if (looksBinary(bytes)) return;
      content = bytes.toString("utf8");
    }
    for (const f of scanText(content, where, terms)) findings.push(`${f.where} — ${f.what}`);
  });
  // The working tree is only what the repository says today. A push sends the
  // history too: every blob reachable from HEAD by content and by the path it
  // was committed at, every commit's message and identities, and every branch
  // and tag.
  for (const f of scanGitHistory(ROOT, terms)) findings.push(`${f.where} — ${f.what}`);

  assert.deepEqual(findings, [], `found in the repository:\n${findings.join("\n")}`);
});
