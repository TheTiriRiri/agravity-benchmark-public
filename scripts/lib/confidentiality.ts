/**
 * What `test/confidentiality.test.ts` looks for (spec §2): secret-shaped
 * tokens, and the terms the operator keeps out of this repository.
 *
 * The terms are never written here. They come, at test time, from the
 * gitignored `.confidential-terms` or from the `CONFIDENTIAL_TERMS` variable (a
 * CI secret), one per line. A finding says where it is and which pattern, or
 * which line of which terms source, matched — never the matched text, so a hit
 * cannot carry a term or a secret into a test log, a commit message or an
 * agent's context.
 *
 * Each secret pattern is assembled from pieces, so this file does not match it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SecretPattern {
  readonly name: string;
  readonly re: RegExp;
}

const glue = (...parts: string[]): string => parts.join("");

/**
 * Anchored, not bare prefixes: `sk-` alone matches ordinary words such as
 * "task-by-task". The first uses a letter lookbehind rather than `\b`, so a key
 * glued to a word ending in a digit (a `ctx7`-style prefix) still matches.
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = Object.freeze([
  { name: "an sk- API key", re: new RegExp(glue("(?<![A-Za-z])s", "k-[A-Za-z0-9_-]{20,}")) },
  { name: "a Google API key", re: new RegExp(glue("AI", "za[0-9A-Za-z_-]{35}")) },
  { name: "a GitHub personal access token", re: new RegExp(glue("gh", "p_[A-Za-z0-9]{36}")) },
  { name: "a GitHub fine-grained token", re: new RegExp(glue("github", "_pat_[A-Za-z0-9_]{22,}")) },
  { name: "a GitLab token", re: new RegExp(glue("gl", "pat-[A-Za-z0-9_-]{20,}")) },
  { name: "a Slack token", re: new RegExp(glue("xo", "x[bp]-[A-Za-z0-9-]{10,}")) },
  { name: "a Google OAuth access token", re: new RegExp(glue("ya", "29\\.[0-9A-Za-z_-]{20,}")) },
  { name: "a Google OAuth refresh token", re: new RegExp(glue("1/", "/0[0-9A-Za-z_-]{20,}")) },
  { name: "a private key", re: new RegExp(glue("-----BEGIN [A-Z ]*PRIV", "ATE KEY-----")) },
]);

/** The gitignored file the operator keeps the terms in, at the repository root. */
export const TERMS_FILE = ".confidential-terms";
/** The same list, newline-separated, as a CI secret. */
export const TERMS_VARIABLE = "CONFIDENTIAL_TERMS";
/** Shorter than this, a term would hit inside ordinary words. */
export const MIN_TERM_LENGTH = 3;

export interface Term {
  /** Where the term came from: `TERMS_FILE` or `TERMS_VARIABLE`. */
  readonly source: string;
  /** Its 1-based line there — what a finding names instead of the term. */
  readonly line: number;
  /** Lower-cased: matching ignores case. */
  readonly lower: string;
}

/**
 * One term per line, surrounding whitespace ignored; blank lines and lines
 * starting with `#` skipped. Throws, naming the line and never the term, on a
 * term shorter than `MIN_TERM_LENGTH`.
 */
export function parseTerms(text: string, source: string): Term[] {
  const terms: Term[] = [];
  text.split(/\r\n|\r|\n/).forEach((raw, i) => {
    const term = raw.trim();
    if (term === "" || term.startsWith("#")) return;
    if (term.length < MIN_TERM_LENGTH) {
      throw new Error(
        `line ${i + 1} of ${source} holds a term shorter than ${MIN_TERM_LENGTH} characters, ` +
          "which would match inside ordinary words; lengthen it",
      );
    }
    // NFC here and on every scanned string: the same name written with a
    // precomposed é and with e + U+0301 is one name, and only one of the two
    // spellings would otherwise ever match.
    terms.push({ source, line: i + 1, lower: term.normalize("NFC").toLowerCase() });
  });
  return terms;
}

export interface Finding {
  /** `<where>:<line>`. */
  readonly where: string;
  /** A pattern's name, or `forbidden term on line <n> of <source>` — never the matched text. */
  readonly what: string;
}

/** Escapes a literal string for use inside a `RegExp` source. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A term's words, escaped and joined on `[\s._-]*`, so a term matches however
 * its words are run together: extra spaces, a line break (`\s` includes
 * newlines), `zebra_widget`, `zebra-widget`, `zebra.widget`, `zebraWidget`. A
 * literal substring check only matches the exact spacing the term was written
 * with, and a name reaches code and paths in all of those spellings.
 *
 * The term must start a word: a letter or a digit right before it (the regex
 * runs case-insensitively, so `[a-z0-9]` covers capitals) means it sits inside
 * a longer run, such as a base64 integrity hash or a camelCase identifier, and
 * is no finding. Anything else before it counts: the start of the text, a
 * space, `/`, `@`, `.`, `_`, `-`. The cost is a term glued onto the end of
 * another word, which this scan misses and a plain substring search does not.
 *
 * `MIN_TERM_LENGTH` is what keeps the separators optional from being dangerous:
 * the pattern can never be empty, because `parseTerms` refuses a term that
 * short. A *different* spelling of the name — an abbreviation, a translation —
 * is not a separator variant and has to be its own line in the terms source.
 */
function termPattern(term: Term): string {
  const words = term.lower
    .split(/\s+/)
    .filter((word) => word !== "")
    .map(escapeRegExp)
    .join("[\\s._-]*");
  return `(?<![a-z0-9])${words}`;
}

/** The 1-based line containing offset `index` into `text`. */
function lineAt(text: string, index: number): number {
  return 1 + (text.slice(0, index).match(/\r\n|\r|\n/g)?.length ?? 0);
}

/**
 * Every secret pattern, checked line by line, and every term, matched across
 * the whole text so a wrapped or differently-spaced occurrence is still
 * found. A term matching more than once on the same starting line is one
 * finding, not one per occurrence.
 */
export function scanText(raw: string, where: string, terms: readonly Term[]): Finding[] {
  const findings: { line: number; what: string }[] = [];
  // Normalised before matching, and line numbers counted on the same string:
  // NFC composes combining marks onto the character before them and never
  // touches CR or LF, so no line boundary moves.
  const text = raw.normalize("NFC");

  text.split(/\r\n|\r|\n/).forEach((line, i) => {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.re.test(line)) findings.push({ line: i + 1, what: pattern.name });
    }
  });

  for (const term of terms) {
    const re = new RegExp(termPattern(term), "gi");
    const linesSeen = new Set<number>();
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const line = lineAt(text, match.index);
      if (!linesSeen.has(line)) {
        linesSeen.add(line);
        findings.push({ line, what: `forbidden term on line ${term.line} of ${term.source}` });
      }
    }
  }

  findings.sort((a, b) => a.line - b.line);
  return findings.map((f) => ({ where: `${where}:${f.line}`, what: f.what }));
}

/**
 * Terms found in `path` itself — a tracked file or directory name — reported
 * under `label` instead of the path, so a term embedded in a name is never
 * echoed by a finding.
 */
export function scanPathForTerms(path: string, label: string, terms: readonly Term[]): Finding[] {
  const findings: Finding[] = [];
  const normalised = path.normalize("NFC");
  for (const term of terms) {
    if (new RegExp(termPattern(term), "i").test(normalised)) {
      findings.push({ where: label, what: `forbidden term on line ${term.line} of ${term.source}` });
    }
  }
  return findings;
}

/**
 * Variables that would point a `git` child at another repository than the one
 * it was given. Every scan strips them before shelling out, so a caller cannot
 * be pointed at a repository it is not scanning — and so a scan of a throwaway
 * repository in a test cannot accidentally read this one.
 */
export const GIT_ENV_TO_STRIP: readonly string[] = Object.freeze([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_COMMON_DIR",
  "GIT_PREFIX",
]);

/** A whole repository's blob contents come back in one buffer; the 1 MB default is far too small. */
const GIT_BUFFER_BYTES = 512 * 1024 * 1024;

/** Run git in `repoDir` and return its raw stdout. Any failure throws: an empty scan is not a clean one. */
function gitBytes(repoDir: string, args: string[], input?: string): Buffer {
  const env = { ...process.env };
  for (const name of GIT_ENV_TO_STRIP) delete env[name];
  const result = spawnSync("git", args, {
    cwd: repoDir,
    env,
    maxBuffer: GIT_BUFFER_BYTES,
    ...(input === undefined ? {} : { input }),
  });
  if (result.error !== undefined) {
    if ((result.error as NodeJS.ErrnoException).code === "ENOBUFS") {
      throw new Error(
        `the confidentiality scan reads git's output into a single ${GIT_BUFFER_BYTES / (1024 * 1024)} MB buffer ` +
          "and this repository has outgrown it. The scan has to read that output in chunks before it can pass " +
          "again; widening the buffer only moves the ceiling.",
      );
    }
    throw new Error(`git ${args.join(" ")} in ${repoDir} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr as Buffer | null)?.toString("utf8").trim() ?? "";
    throw new Error(`git ${args.join(" ")} in ${repoDir} exited ${String(result.status)}: ${stderr}`);
  }
  return result.stdout as Buffer;
}

/** The first 12 hex digits of an object id — enough to find it, and never a term. */
function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

/**
 * The content of every blob reachable from any ref.
 *
 * The scan of the working tree only sees what a file holds *today*. A term in a
 * file that was later edited out, or in one that was `git rm`'d, is invisible
 * there and still published with the history — which is the whole point of the
 * rule. So: `rev-list --objects --all` for the reachable objects, then one
 * `cat-file --batch` for their bytes.
 *
 * Only the leading object id of each line is read. The rest is a path, and
 * `rev-list` names an object once, under the path it was *first* reached by, so
 * that listing misses a renamed file's old name; `scanHistoricalPaths` takes
 * the paths from the commit walk instead. Ignoring the tail also means a path
 * holding a newline cannot corrupt a record.
 *
 * A location names an object, never a path and never the matched text: a
 * historical file or directory name can itself be the term.
 */
function scanReachableObjects(repoDir: string, terms: readonly Term[]): Finding[] {
  const listing = gitBytes(repoDir, ["rev-list", "--objects", "--all"]).toString("utf8");
  const shas: string[] = [];
  for (const line of listing.split("\n")) {
    const space = line.indexOf(" ");
    const sha = space === -1 ? line : line.slice(0, space);
    if (!/^[0-9a-f]{40,64}$/.test(sha)) continue;
    shas.push(sha);
  }
  if (shas.length === 0) return [];

  const findings: Finding[] = [];
  const batch = gitBytes(repoDir, ["cat-file", "--batch"], `${shas.join("\n")}\n`);
  // `<sha> SP <type> SP <size> LF <bytes> LF`, object after object. A
  // desynchronised stream is reported by offset and length only: the bytes at
  // that offset would be blob content, which no finding may ever echo.
  let offset = 0;
  while (offset < batch.length) {
    const eol = batch.indexOf(0x0a, offset);
    if (eol === -1) break;
    const header = batch.toString("utf8", offset, eol).split(" ");
    if (header.length !== 3) {
      throw new Error(
        `git cat-file --batch in ${repoDir}: the ${eol - offset} bytes at offset ${offset} are not an ` +
          "`<sha> <type> <size>` header, so the stream desynchronised (the bytes are withheld: they may be " +
          "blob content)",
      );
    }
    const [sha, kind, sizeText] = header;
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(
        `git cat-file --batch in ${repoDir}: the header at offset ${offset} declares an unusable object size, ` +
          "so the stream desynchronised (the bytes are withheld: they may be blob content)",
      );
    }
    const start = eol + 1;
    if (kind === "blob") {
      const bytes = batch.subarray(start, start + size);
      if (!looksBinary(bytes)) {
        findings.push(...scanText(bytes.toString("utf8"), `blob ${shortSha(sha)}`, terms));
      }
    }
    offset = start + size + 1;
  }
  return findings;
}

/**
 * Every path any commit ever recorded, both sides of a rename included.
 *
 * Renaming a file is exactly what someone does on noticing a name in a path,
 * and after it the old name is in no listing of today's objects — only in the
 * commits. `--no-renames` keeps a rename as a delete plus an add so both names
 * appear, `-m` makes a merge report its own paths instead of none, and `-z`
 * separates paths by NUL so one holding a newline stays whole.
 *
 * A finding is labelled by the path's position in this listing and never by the
 * path: the name itself can be the term.
 */
function scanHistoricalPaths(repoDir: string, terms: readonly Term[]): Finding[] {
  const args = ["log", "--all", "--no-renames", "-m", "--name-only", "--format=", "-z"];
  const listing = gitBytes(repoDir, args).toString("utf8");
  const findings: Finding[] = [];
  let index = 0;
  for (const path of new Set(listing.split("\0"))) {
    if (path === "") continue;
    index += 1;
    findings.push(...scanPathForTerms(path, `historical path #${index}`, terms));
  }
  return findings;
}

/** Every commit reachable from any ref: its message, and the author and committer it names. */
function scanCommits(repoDir: string, terms: readonly Term[]): Finding[] {
  const findings: Finding[] = [];
  // Identity as well as message: a name is a name wherever git keeps it, and
  // `git log --format` is the only place that shows the trailers git writes.
  const records = gitBytes(repoDir, ["log", "--all", "-z", "--format=%H%n%an%n%ae%n%cn%n%ce%n%B"]).toString("utf8");
  for (const record of records.split("\0")) {
    if (record === "") continue;
    const newline = record.indexOf("\n");
    const sha = (newline === -1 ? record : record.slice(0, newline)).trim();
    const rest = newline === -1 ? "" : record.slice(newline + 1);
    findings.push(...scanText(rest, `commit ${shortSha(sha)}`, terms));
  }
  return findings;
}

/** The fields `scanRefs` asks `for-each-ref` for: its atom, and what a finding calls it. */
const REF_FIELDS: readonly { readonly atom: string; readonly label: string }[] = Object.freeze([
  { atom: "%(refname)", label: "name" },
  { atom: "%(taggername)", label: "tagger" },
  { atom: "%(taggeremail)", label: "tagger email" },
  { atom: "%(contents)", label: "message" },
]);

/**
 * Every ref — branches, tags, remote-tracking refs, the stash — by name, by an
 * annotated tag's tagger, and by its message.
 *
 * `%n` is a `git log --format` escape that `for-each-ref` prints literally, so
 * the fields have to be separated by `%00`: NUL is the one byte git guarantees
 * cannot occur in a ref name, an identity or a message. Each record opens with
 * the separator, so splitting on NUL yields one empty field and then exactly
 * `REF_FIELDS.length` per ref.
 *
 * A ref name can hold the term itself, so a finding is labelled by the ref's
 * position in this listing and the field that matched, never by its name.
 */
function scanRefs(repoDir: string, terms: readonly Term[]): Finding[] {
  const format = `%00${REF_FIELDS.map((field) => field.atom).join("%00")}`;
  const listing = gitBytes(repoDir, ["for-each-ref", `--format=${format}`]).toString("utf8");
  const fields = listing.split("\0");
  const first = fields.shift();
  if (first !== undefined && first !== "") {
    throw new Error(
      `git for-each-ref in ${repoDir}: the output did not start with the record separator, so the fields ` +
        "cannot be told apart (the bytes are withheld: they may be a ref name or a tag message)",
    );
  }
  const findings: Finding[] = [];
  for (let i = 0; i < fields.length; i += REF_FIELDS.length) {
    const ref = i / REF_FIELDS.length + 1;
    REF_FIELDS.forEach((field, offset) => {
      const value = fields[i + offset] ?? "";
      if (value.trim() === "") return;
      findings.push(...scanText(value, `ref #${ref} ${field.label}`, terms));
    });
  }
  return findings;
}

/**
 * Everything git would publish along with the working tree: the content of
 * every blob reachable from any ref, every path any commit ever recorded, every
 * commit's message and its author and committer, and every ref's name, tagger
 * and message.
 *
 * The premise of the rule is that the name is not in this repository *or its
 * history*, and the history is what a push sends — all of it, not only the
 * branch that happens to be checked out. No location here carries a term, a
 * path or a ref name.
 */
export function scanGitHistory(repoDir: string, terms: readonly Term[]): Finding[] {
  return [
    ...scanReachableObjects(repoDir, terms),
    ...scanHistoricalPaths(repoDir, terms),
    ...scanCommits(repoDir, terms),
    ...scanRefs(repoDir, terms),
  ];
}

/** A NUL in the first 8000 bytes: binary, as git decides it, and not scanned. */
export function looksBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 8000).includes(0);
}

/**
 * The terms from `<repoRoot>/.confidential-terms` and from `CONFIDENTIAL_TERMS`,
 * both when both are set. `terms` is `null` when neither is — and also when a
 * source exists but holds no usable terms (empty, or comments and blank lines
 * only), which is treated exactly like a missing source so the caller's
 * null check and the rule that fails without terms when
 * `REQUIRE_CONFIDENTIAL_TERMS=true` still apply.
 */
export function loadTerms(repoRoot: string, env: NodeJS.ProcessEnv): { terms: Term[] | null; sources: string[] } {
  const terms: Term[] = [];
  const sources: string[] = [];
  const path = join(repoRoot, TERMS_FILE);
  if (existsSync(path)) {
    terms.push(...parseTerms(readFileSync(path, "utf8"), TERMS_FILE));
    sources.push(TERMS_FILE);
  }
  const fromEnv = env[TERMS_VARIABLE];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    terms.push(...parseTerms(fromEnv, TERMS_VARIABLE));
    sources.push(TERMS_VARIABLE);
  }
  if (terms.length === 0) return { terms: null, sources: [] };
  return { terms, sources };
}
