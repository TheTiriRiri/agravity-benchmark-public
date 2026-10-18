import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { loadRunnerConfig, parseDurationMs, readScoringImage, selectMatrixRows } from "../scripts/lib/runner-config";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * The config as it shipped before Phase 0, except its rubric id, which takes
 * today's `maintenance-console@<hash>` shape: placeholder model ids and a
 * placeholder token filename, real everything else. Phase 0 has since filled
 * `benchmark/runner.yaml` in for real, but this fixture keeps the placeholders
 * on purpose — the three guards below exist to reject exactly this shape, and
 * they are what stops a matrix from running against `TODO-cli-id`.
 */
const SHIPPED_YAML = `
image: agrav-bench/harness:2026-09-05
agyVersion: 1.1.26
judge: claude-opus-5
rubric: maintenance-console@0123456789ab
timeoutMs: 1020000
printTimeout: 15m
attempts: 5
quotaFloor: null
credentialFiles:
  - .gemini/antigravity-cli/TODO-token-file
  - .gemini/antigravity-cli/installation_id
matrix:
  - { id: gemini-38-flash-high, model: TODO-cli-id, effort: high,   family: gemini-38-flash }
  - { id: gemini-38-flash-low,  model: TODO-cli-id, effort: low,    family: gemini-38-flash }
  - { id: gpt-oss-120b-med,     model: TODO-cli-id, effort: medium, family: gpt-oss-120b }
`;

/** The same config as it will look once Phase 0 has filled the real values in. */
const FILLED_YAML = SHIPPED_YAML.replace(/TODO-cli-id/g, "gemini-3.8-flash").replace(
  "TODO-token-file",
  "antigravity-oauth-token",
);

let tempDir: string | undefined;

function configFile(yaml: string, name = "runner.yaml"): string {
  tempDir ??= mkdtempSync(join(tmpdir(), "agrav-runner-config-test-"));
  const path = join(tempDir, name);
  writeFileSync(path, yaml, "utf8");
  return path;
}

/** A repository root holding only `benchmark/runner.yaml`, as `readScoringImage` reads it. */
function repoRootWith(yaml: string, name: string): string {
  tempDir ??= mkdtempSync(join(tmpdir(), "agrav-runner-config-test-"));
  const root = join(tempDir, name);
  mkdirSync(join(root, "benchmark"), { recursive: true });
  writeFileSync(join(root, "benchmark", "runner.yaml"), yaml, "utf8");
  return root;
}

after(() => {
  if (tempDir !== undefined) rmSync(tempDir, { recursive: true, force: true });
});

test("loadRunnerConfig accepts a fully filled config", () => {
  const config = loadRunnerConfig(configFile(FILLED_YAML, "filled.yaml"));
  assert.equal(config.image, "agrav-bench/harness:2026-09-05");
  assert.equal(config.agyVersion, "1.1.26");
  assert.equal(config.judge, "claude-opus-5");
  assert.equal(config.rubric, "maintenance-console@0123456789ab");
  assert.equal(config.timeoutMs, 1020000);
  assert.equal(config.printTimeout, "15m");
  assert.equal(config.attempts, 5);
  assert.equal(config.quotaFloor, null);
  assert.deepEqual(config.credentialFiles, [
    ".gemini/antigravity-cli/antigravity-oauth-token",
    ".gemini/antigravity-cli/installation_id",
  ]);
  assert.equal(config.matrix.length, 3);
  assert.deepEqual(config.matrix[2], {
    id: "gpt-oss-120b-med",
    model: "gemini-3.8-flash",
    effort: "medium",
    family: "gpt-oss-120b",
    usageLabel: null,
  });
});

test("loadRunnerConfig rejects a TODO model id in a selected row, naming Phase 0", () => {
  const path = configFile(SHIPPED_YAML, "shipped.yaml");
  assert.throws(() => loadRunnerConfig(path), /placeholder model id "TODO-cli-id"/);
  assert.throws(() => loadRunnerConfig(path), /Phase 0/);
  assert.throws(() => loadRunnerConfig(path, { only: ["gemini-38-flash-low"] }), /"gemini-38-flash-low"/);
});

test("loadRunnerConfig ignores a TODO in a row that is not selected", () => {
  const oneFilled = SHIPPED_YAML.replace(
    "{ id: gemini-38-flash-low,  model: TODO-cli-id,",
    "{ id: gemini-38-flash-low,  model: gemini-3.8-flash,",
  ).replace("TODO-token-file", "antigravity-oauth-token");
  const config = loadRunnerConfig(configFile(oneFilled, "one-filled.yaml"), { only: ["gemini-38-flash-low"] });
  assert.equal(config.matrix.length, 3);
});

test("loadRunnerConfig rejects a TODO credential filename", () => {
  const modelsFilled = SHIPPED_YAML.replace(/TODO-cli-id/g, "gemini-3.8-flash");
  assert.throws(
    () => loadRunnerConfig(configFile(modelsFilled, "creds-todo.yaml")),
    /credentialFiles still has the placeholder entry "\.gemini\/antigravity-cli\/TODO-token-file"/,
  );
});

test("--dry-run tolerates every placeholder", () => {
  const config = loadRunnerConfig(configFile(SHIPPED_YAML, "dry.yaml"), {
    only: ["gemini-38-flash-low"],
    allowPlaceholders: true,
  });
  assert.equal(config.matrix[1].model, "TODO-cli-id");
  assert.deepEqual(config.credentialFiles, [
    ".gemini/antigravity-cli/TODO-token-file",
    ".gemini/antigravity-cli/installation_id",
  ]);
});

test("loadRunnerConfig rejects timeoutMs <= printTimeout", () => {
  const equal = FILLED_YAML.replace("timeoutMs: 1020000", "timeoutMs: 900000");
  assert.throws(() => loadRunnerConfig(configFile(equal, "equal.yaml")), /must exceed printTimeout/);

  const shorter = FILLED_YAML.replace("timeoutMs: 1020000", "timeoutMs: 600000");
  assert.throws(() => loadRunnerConfig(configFile(shorter, "shorter.yaml")), /must exceed printTimeout/);

  const longer = FILLED_YAML.replace("printTimeout: 15m", "printTimeout: 900s");
  assert.equal(loadRunnerConfig(configFile(longer, "longer.yaml")).printTimeout, "900s");
});

test("loadRunnerConfig reports the file path on every validation error", () => {
  const path = configFile(FILLED_YAML.replace("attempts: 5", "attempts: 0"), "attempts-zero.yaml");
  assert.throws(() => loadRunnerConfig(path), (error: Error) => error.message.startsWith(`${path}: `));
});

test("loadRunnerConfig rejects malformed scalars", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["image: agrav-bench/harness:2026-09-05", "image: ''", /image must be a non-empty string/],
    ["attempts: 5", "attempts: 2.5", /attempts must be a positive integer/],
    ["timeoutMs: 1020000", "timeoutMs: -1", /timeoutMs must be a positive integer/],
    ["printTimeout: 15m", "printTimeout: fifteen", /cannot parse duration/],
    ["quotaFloor: null", "quotaFloor: plenty", /quotaFloor must be a number or null/],
  ];
  for (const [from, to, expected] of cases) {
    const path = configFile(FILLED_YAML.replace(from, to), `scalar-${expected.source.slice(0, 8)}.yaml`);
    assert.throws(() => loadRunnerConfig(path), expected);
  }
});

test("loadRunnerConfig refuses more attempts than a filmstrip can hold", () => {
  const path = configFile(FILLED_YAML.replace("attempts: 5", "attempts: 13"), "attempts-13.yaml");
  assert.throws(() => loadRunnerConfig(path), /above the 12-attempt ceiling/);
  assert.equal(loadRunnerConfig(configFile(FILLED_YAML.replace("attempts: 5", "attempts: 12"), "a12.yaml")).attempts, 12);
});

test("loadRunnerConfig requires quotaFloor to be present", () => {
  const path = configFile(FILLED_YAML.replace("quotaFloor: null\n", ""), "no-quota-floor.yaml");
  assert.throws(() => loadRunnerConfig(path), /quotaFloor is required/);
});

/** FILLED_YAML with a `usageLabel` on every row, as a numeric quotaFloor requires. */
const LABELLED_YAML = FILLED_YAML.replace(/family: (\S+) \}/g, 'family: $1, usageLabel: "Gemini 3.8 Flash (High)" }');

test("loadRunnerConfig accepts a numeric quotaFloor when every row has a usageLabel", () => {
  const path = configFile(LABELLED_YAML.replace("quotaFloor: null", "quotaFloor: 20"), "quota-20.yaml");
  const config = loadRunnerConfig(path);
  assert.equal(config.quotaFloor, 20);
  assert.ok(config.matrix.every((row) => row.usageLabel === "Gemini 3.8 Flash (High)"));
});

test("loadRunnerConfig refuses a numeric quotaFloor on a row without a usageLabel", () => {
  const yaml = LABELLED_YAML.replace("quotaFloor: null", "quotaFloor: 20").replace(
    /(id: gpt-oss-120b-med,[^}]*), usageLabel: "[^"]*"/,
    "$1",
  );
  assert.throws(() => loadRunnerConfig(configFile(yaml, "quota-unlabelled.yaml")), /usageLabel.*missing on gpt-oss-120b-med/);
});

test("loadRunnerConfig treats quotaFloor as a percentage", () => {
  for (const floor of ["-1", "101"]) {
    const path = configFile(LABELLED_YAML.replace("quotaFloor: null", `quotaFloor: ${floor}`), `quota-${floor}.yaml`);
    assert.throws(() => loadRunnerConfig(path), /between 0 and 100/);
  }
});

test("loadRunnerConfig leaves usageLabel null when a row has none", () => {
  assert.ok(loadRunnerConfig(configFile(FILLED_YAML, "unlabelled.yaml")).matrix.every((row) => row.usageLabel === null));
});

test("loadRunnerConfig rejects matrix ids that would not survive a directory name", () => {
  const underscored = FILLED_YAML.replace("id: gemini-38-flash-low", "id: gemini_36_flash_low");
  assert.throws(() => loadRunnerConfig(configFile(underscored, "underscore.yaml")), /matrix\[1\]\.id must match/);

  const upper = FILLED_YAML.replace("id: gpt-oss-120b-med", "id: GPT-OSS-120B-MED");
  assert.throws(() => loadRunnerConfig(configFile(upper, "upper.yaml")), /matrix\[2\]\.id must match/);

  const duplicate = FILLED_YAML.replace("id: gpt-oss-120b-med", "id: gemini-38-flash-low");
  assert.throws(() => loadRunnerConfig(configFile(duplicate, "duplicate.yaml")), /is a duplicate/);
});

test("loadRunnerConfig accepts effort: null for a model that rejects the flag", () => {
  // claude-sonnet-4-6, claude-opus-4-6-thinking and gpt-oss-120b-medium have no
  // effort levels and agy 1.1.26 fails the run when --effort is passed at all.
  const nulled = FILLED_YAML.replace("effort: medium, family: gpt-oss-120b", "effort: null, family: gpt-oss-120b");
  const config = loadRunnerConfig(configFile(nulled, "effort-null.yaml"));
  assert.equal(config.matrix[2].effort, null);
});

test("loadRunnerConfig rejects an unknown effort", () => {
  const path = configFile(FILLED_YAML.replace("effort: medium", "effort: extreme"), "effort.yaml");
  assert.throws(() => loadRunnerConfig(path), /effort must be one of low, medium, high/);
});

test("loadRunnerConfig keeps credential paths inside the volume", () => {
  // A relative path with subdirectories is required — agy's file store is
  // .gemini/antigravity-cli/ — so "contains a slash" can no longer be the
  // check. These are the shapes that could still reach outside it, or be read
  // by `cp` as something other than a source file.
  const rejected: Array<[string, RegExp]> = [
    ["- ../../etc/passwd", /must be a path inside the agy-creds volume/],
    ["- /etc/passwd", /must be a path inside the agy-creds volume/],
    ["- .gemini/../../etc/passwd", /must be a path inside the agy-creds volume/],
    ["- .gemini//installation_id", /must be a path inside the agy-creds volume/],
    ["- ./installation_id", /must be a path inside the agy-creds volume/],
    ["- --preserve=all", /must be a path inside the agy-creds volume/],
  ];
  for (const [entry, expected] of rejected) {
    const yaml = FILLED_YAML.replace("- .gemini/antigravity-cli/installation_id", entry);
    const path = configFile(yaml, `escape-${entry.replace(/\W+/g, "-")}.yaml`);
    assert.throws(() => loadRunnerConfig(path), expected, `expected ${entry} to be refused`);
  }

  const empty = FILLED_YAML.replace(
    "credentialFiles:\n  - .gemini/antigravity-cli/antigravity-oauth-token\n  - .gemini/antigravity-cli/installation_id\n",
    "credentialFiles: []\n",
  );
  assert.throws(() => loadRunnerConfig(configFile(empty, "empty-creds.yaml")), /must be a non-empty array/);
});

test("loadRunnerConfig rejects an --only id that is not in the matrix", () => {
  const path = configFile(FILLED_YAML, "only-unknown.yaml");
  assert.throws(() => loadRunnerConfig(path, { only: ["gemini-99-pro-high"] }), /is not a matrix id/);
});

test("selectMatrixRows returns the whole matrix when nothing is selected", () => {
  const config = loadRunnerConfig(configFile(FILLED_YAML, "select.yaml"));
  assert.equal(selectMatrixRows(config).length, 3);
  assert.equal(selectMatrixRows(config, []).length, 3);
});

test("selectMatrixRows preserves --only order and de-duplicates", () => {
  const config = loadRunnerConfig(configFile(FILLED_YAML, "select-order.yaml"));
  const rows = selectMatrixRows(config, ["gpt-oss-120b-med", "gemini-38-flash-high", "gpt-oss-120b-med"]);
  assert.deepEqual(
    rows.map((row) => row.id),
    ["gpt-oss-120b-med", "gemini-38-flash-high"],
  );
});

test("parseDurationMs handles the forms agy accepts", () => {
  assert.equal(parseDurationMs("15m"), 900_000);
  assert.equal(parseDurationMs("900s"), 900_000);
  assert.equal(parseDurationMs("1h"), 3_600_000);
  assert.equal(parseDurationMs("1h30m"), 5_400_000);
  assert.equal(parseDurationMs("1500ms"), 1500);
  assert.equal(parseDurationMs(" 15m "), 900_000);
  assert.equal(parseDurationMs("0.5m"), 30_000);
});

test("parseDurationMs rejects anything it cannot read", () => {
  for (const spec of ["", "15", "15 m", "fifteen", "15x", "m15", "15m junk"]) {
    assert.throws(() => parseDurationMs(spec), /cannot parse duration/, `expected ${JSON.stringify(spec)} to throw`);
  }
});

test("loadRunnerConfig refuses a config that is on hold, and says why — never that removing the key releases it", () => {
  const held = `${FILLED_YAML}hold: "the task changed and the image has no Python yet."\n`;
  assert.throws(
    () => loadRunnerConfig(configFile(held, "held.yaml")),
    (error: Error) => {
      // The reason is the whole story: the plan that resolves it removes the key.
      assert.match(error.message, /held\.yaml: the matrix is on hold: the task changed and the image has no Python yet\. `--dry-run` still works\.$/);
      assert.doesNotMatch(error.message, /[Rr]emove/);
      return true;
    },
  );
});

test("a YAML syntax error names the file, for loadRunnerConfig and readScoringImage alike", () => {
  const broken = "image: [unclosed\n";
  const path = configFile(broken, "syntax.yaml");
  assert.throws(() => loadRunnerConfig(path), (error: Error) => error.message.includes(`in "${path}"`));
  const root = repoRootWith(broken, "scoring-syntax");
  const runnerYaml = join(root, "benchmark", "runner.yaml");
  assert.throws(() => readScoringImage(root), (error: Error) => error.message.includes(`in "${runnerYaml}"`));
});

test("a held config still loads for --dry-run, and an absent hold is null", () => {
  const held = `${FILLED_YAML}hold: "the task changed."\n`;
  assert.equal(loadRunnerConfig(configFile(held, "held-dry.yaml"), { allowPlaceholders: true }).hold, "the task changed.");
  assert.equal(loadRunnerConfig(configFile(FILLED_YAML, "unheld.yaml")).hold, null);
});

test("hold: null and a bare `hold:` load as no hold, releasing the matrix like a deleted key; an empty string is refused", () => {
  // An explicit YAML null is no hold, as documented (`hold: string | null`), so
  // an operator who empties the value to null instead of deleting the key
  // silently un-holds the matrix. An empty string fails closed: it is refused
  // at load, even for --dry-run. Pinned so neither can change unnoticed.
  assert.equal(loadRunnerConfig(configFile(`${FILLED_YAML}hold: null\n`, "hold-null.yaml")).hold, null);
  assert.equal(loadRunnerConfig(configFile(`${FILLED_YAML}hold:\n`, "hold-bare.yaml")).hold, null);
  const empty = configFile(`${FILLED_YAML}hold: ""\n`, "hold-empty.yaml");
  assert.throws(() => loadRunnerConfig(empty), /hold must be a non-empty string/);
  assert.throws(() => loadRunnerConfig(empty, { allowPlaceholders: true }), /hold must be a non-empty string/);
});

// --- readScoringImage: the scoring tools' one read of runner.yaml --------------

test("readScoringImage returns image from <repoRoot>/benchmark/runner.yaml", () => {
  const root = repoRootWith(FILLED_YAML.replace("harness:2026-09-05", "harness:2031-01-02"), "scoring-filled");
  assert.equal(readScoringImage(root), "agrav-bench/harness:2031-01-02");
});

test("readScoringImage works while the matrix is held, where loadRunnerConfig refuses", () => {
  const root = repoRootWith(`${FILLED_YAML}hold: "the scenario is being rebuilt."\n`, "scoring-held");
  assert.equal(readScoringImage(root), "agrav-bench/harness:2026-09-05");
  assert.throws(() => loadRunnerConfig(join(root, "benchmark", "runner.yaml")), /the matrix is on hold/);
});

test("readScoringImage ignores every other key, placeholders and malformed values included", () => {
  // Only `image` is read: a config loadRunnerConfig rejects outright (TODO model
  // ids, a timeout shorter than printTimeout) still yields its image, and so
  // does a file holding nothing but `image` and `hold`.
  const broken = SHIPPED_YAML.replace("timeoutMs: 1020000", "timeoutMs: 1");
  assert.equal(readScoringImage(repoRootWith(broken, "scoring-broken")), "agrav-bench/harness:2026-09-05");
  const bare = 'image: agrav-bench/harness:2031-01-02\nhold: "held."\n';
  assert.equal(readScoringImage(repoRootWith(bare, "scoring-bare")), "agrav-bench/harness:2031-01-02");
});

test("readScoringImage throws, naming the file, on a missing or empty image", () => {
  const OLD = "image: agrav-bench/harness:2026-09-05";
  const cases: Array<[string, string]> = [
    ["scoring-missing", FILLED_YAML.replace(`${OLD}\n`, "")],
    ["scoring-empty", FILLED_YAML.replace(OLD, "image: ''")],
    ["scoring-blank", FILLED_YAML.replace(OLD, 'image: "   "')],
    ["scoring-null", FILLED_YAML.replace(OLD, "image: null")],
    ["scoring-number", FILLED_YAML.replace(OLD, "image: 20260918")],
  ];
  for (const [name, yaml] of cases) {
    assert.notEqual(yaml, FILLED_YAML, `${name}: the fixture edit did not apply`);
    const root = repoRootWith(yaml, name);
    const path = join(root, "benchmark", "runner.yaml");
    assert.throws(
      () => readScoringImage(root),
      (error: Error) => error.message === `${path}: image must be a non-empty string`,
      `${name} should be refused`,
    );
  }

  const listRoot = repoRootWith(`- ${OLD}\n`, "scoring-list");
  const listPath = join(listRoot, "benchmark", "runner.yaml");
  assert.throws(
    () => readScoringImage(listRoot),
    (error: Error) => error.message === `${listPath}: expected a YAML mapping at the top level`,
  );
});

test("readScoringImage reads the repository's own runner.yaml, agreeing with loadRunnerConfig", () => {
  const image = readScoringImage(REPO_ROOT);
  assert.equal(image, loadRunnerConfig(join(REPO_ROOT, "benchmark", "runner.yaml"), { allowPlaceholders: true }).image);
  // A dated local tag (images/harness/IMAGE.md), never a registry reference.
  assert.match(image, /^agrav-bench\/harness:\d{4}-\d{2}-\d{2}$/);
});

test("images/harness/IMAGE.md records the tag runner.yaml configures, and its recipe never pulls it", () => {
  // Task 12 checks the local image Id against IMAGE.md: a retag in runner.yaml
  // alone would have it compare against another image's record.
  const doc = readFileSync(join(REPO_ROOT, "images", "harness", "IMAGE.md"), "utf8");
  const tag = /^- \*\*Tag:\*\* `([^`]+)`$/m.exec(doc);
  assert.ok(tag !== null, "IMAGE.md has a `- **Tag:** `<tag>`` line");
  assert.equal(tag[1], readScoringImage(REPO_ROOT));
  // The tag is local: missing (after a prune), a plain `docker run` would pull
  // whatever a registry serves under that name, in a namespace anyone can register.
  const runs = doc.split("\n").filter((line) => (/docker run\b/.test(line) && line.includes('"$TAG"')) || /^RUN=\(docker run\b/.test(line));
  assert.ok(runs.length >= 6, `IMAGE.md's recipe runs the tag: ${runs.length} lines`);
  for (const line of runs) assert.ok(line.includes("--pull never"), `IMAGE.md: ${line}`);
});
