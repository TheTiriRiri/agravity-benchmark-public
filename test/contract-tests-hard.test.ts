/**
 * The hard track's entry point (`scripts/contract-tests-hard.ts`) and its
 * loader and writer (`scripts/lib/hard-contract-results.ts`).
 *
 * The pure pieces first; then `runHardContractTests` in process, with a scripted
 * fake backend, a fake `runFile` and fake gate, image and git, so the branches
 * that differ from `contract-tests.ts` are exercised without docker or git.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_TRACK_ROOT, hardSummaryLines, parseArgs, runHardContractTests, type HardTestsDeps, type HardTestsOptions } from "../scripts/contract-tests-hard";
import type { ContractBackend } from "../scripts/contract-tests";
import type { BackendOptions, ContainerRemoval, ServingState, StartResult, StepResult } from "../scripts/lib/attempt-backend";
import { parseContractResults, stoppedBoot, stoppedGroups, type ContractResults, type GroupResult } from "../scripts/lib/contract-results";
import type { ContractFileResult, RunContractFileOptions } from "../scripts/lib/contract-suite";
import {
  HARD_LIMITS,
  HARD_RESULTS_FILE,
  buildHardResult,
  entryTimeout,
  loadHardManifest,
  parseHardResult,
  readHardContractResults,
  type HardManifestEntry,
} from "../scripts/lib/hard-contract-results";
import { writeRunJson, type RunJson } from "../scripts/lib/run-json";
import { CASES_PER_STRATUM, STRATA } from "../tracks/console-fuzz/benchmark/fuzz/strata";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TRACK = join(ROOT, "tracks", "console-fuzz");
const MANIFEST = loadHardManifest(TRACK);
const ATTEMPT = "demo-attempt-1";
const REF = `agrav-bench/harness:2026-09-18@sha256:${"a".repeat(64)}`;

const scratch: string[] = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};

const caseName = (stratum: string, n: number): string => `${stratum}/case-${String(n).padStart(4, "0")}`;
const tenIn = (stratum: string): string[] => Array.from({ length: 10 }, (_, i) => caseName(stratum, 150 + i));

const cleanFile: ContractFileResult = { file: "fuzz.test.ts", total: 200, passed: 200, failed: [], notRun: 0, hookFailed: 0, timedOut: false };
const failingFile = (names: string[]): ContractFileResult => ({
  ...cleanFile,
  passed: 200 - names.length,
  failed: names.map((name) => ({ name, failureType: "testCodeFailure", message: "deepEqual" })),
});

/** What `runHardContractTests` builds, for a given file result or stop. */
function contractOf(options: { file?: ContractFileResult; boot?: { stage: "layout" | "install" | "boot" | "health"; detail: string } } = {}): ContractResults {
  const [entry] = MANIFEST;
  const stop = options.boot;
  const groups: GroupResult[] = stop
    ? stoppedGroups(MANIFEST)
    : [
        {
          row: entry.row, file: entry.file, max: entry.max, total: 200, passed: (options.file ?? cleanFile).passed,
          score: Math.round(((options.file ?? cleanFile).passed / 200) * entry.max * 100) / 100,
          timedOut: (options.file ?? cleanFile).timedOut, hookFailed: 0, notRun: (options.file ?? cleanFile).notRun, detail: null,
          failed: (options.file ?? cleanFile).failed,
        },
      ];
  return {
    schemaVersion: 1, attempt: ATTEMPT, image: REF, runImage: null, rubric: "maintenance-console@e4feb1ee979a",
    testsCommit: "c".repeat(40), testsDirty: false, ungated: false, startedAt: "2026-09-21T10:00:00.000Z", durationMs: 1234,
    pipFreeze: [], warnings: [], boot: stop ? stoppedBoot(stop.stage, stop.detail) : { ok: true, stage: null, detail: null },
    diagnosis: null, groups,
  };
}

// ---------------------------------------------------------------------------
// the manifest and the budgets

test("a manifest entry's own timeoutMs wins over the uniform budget", () => {
  const [entry] = MANIFEST;
  assert.equal(entry?.timeoutMs, 300_000);
  assert.equal(entryTimeout(entry, 999_999), 300_000);
});

test("an entry without timeoutMs falls back to the uniform budget", () => {
  assert.equal(entryTimeout({ file: "x.test.ts", row: "X", max: 1, tests: 1 }, 999_999), HARD_LIMITS.fileMs);
});

test("no entry may exceed the remaining overall budget", () => {
  assert.equal(entryTimeout({ file: "x.test.ts", row: "X", max: 1, tests: 1, timeoutMs: 300_000 }, 40_000), 40_000);
});

test("the budgets are the ones the spec fixed", () => {
  assert.equal(HARD_LIMITS.fileMs, 120_000);
  assert.equal(HARD_LIMITS.overallMs, 1_800_000);
});

test("the hard manifest is the fuzz's one file, read by the hard loader", () => {
  assert.equal(MANIFEST.length, 1);
  assert.equal(MANIFEST[0].file, "fuzz.test.ts");
  assert.equal(MANIFEST[0].row, "Differential fuzz");
  assert.equal(MANIFEST[0].tests, 200);
});

test("loadHardManifest refuses what the writer could not have produced", () => {
  const root = tempDir("hard-manifest-");
  mkdirSync(join(root, "benchmark", "fuzz"), { recursive: true });
  const load = (files: unknown): HardManifestEntry[] => {
    writeFileSync(join(root, "benchmark", "fuzz", "manifest.json"), JSON.stringify({ files }));
    return loadHardManifest(root);
  };
  const ok = { file: "a.test.ts", row: "A", max: 3, tests: 5 };
  assert.deepEqual(load([ok]), [ok]);
  assert.deepEqual(load([{ ...ok, timeoutMs: 1000 }]), [{ ...ok, timeoutMs: 1000 }]);
  assert.throws(() => load([]), /at least one/);
  assert.throws(() => load([{ ...ok, file: "../a.test.ts" }]), /base name/);
  assert.throws(() => load([{ ...ok, tests: 0 }]), /tests/);
  assert.throws(() => load([{ ...ok, timeoutMs: 0 }]), /timeoutMs/);
  assert.throws(() => load([ok, ok]), /twice/);
});

// ---------------------------------------------------------------------------
// the envelope

test("the envelope carries the per-stratum tally the frozen shape has no place for", () => {
  // parseContractResults rejects unknown top-level keys and has no field for a
  // per-stratum count, so `fuzz` lives beside `contract`.
  const uneven = buildHardResult(contractOf({ file: failingFile(tenIn("daily-cap-480")) }), "a1b2c3d4e5f6");
  assert.equal(uneven.track, "console-fuzz");
  assert.equal(uneven.oracle, "a1b2c3d4e5f6");
  assert.equal(uneven.fuzz.perStratum.length, 20);
  assert.equal(uneven.fuzz.perStratum.find((s) => s.id === "daily-cap-480")?.passed, 0);
  assert.equal(uneven.fuzz.score, 2.85);
});

test("with twenty strata of ten, the stratum mean IS passed/200, so the two halves' scores agree", () => {
  // Worth pinning rather than assuming: sum over strata of (passed/10) / 20 is
  // exactly passed/200, so the frozen group's roundScore(passed, 200, max) and
  // the envelope's stratum mean cannot differ while every stratum has the same
  // number of cases. `fuzz.score` earns its place as the scorer's own figure
  // and by the day a stratum is resized; today the tally and the note are what
  // the frozen half lacks.
  for (const names of [[], tenIn("daily-cap-480"), STRATA.slice(0, 7).map((s) => caseName(s.id, 3)), [...tenIn("parts-blocked"), ...tenIn("no-capacity")]]) {
    const built = buildHardResult(contractOf({ file: failingFile(names) }), "a1b2c3d4e5f6");
    assert.equal(built.fuzz.score, built.contract.groups[0].score, `${names.length} failures`);
  }
});

test("the envelope's contract half still satisfies every frozen validation", () => {
  const value = buildHardResult(contractOf(), "a1b2c3d4e5f6");
  assert.doesNotThrow(() => parseContractResults(JSON.stringify(value.contract), MANIFEST));
  assert.match(value.contract.rubric, /^maintenance-console@[0-9a-f]{12}$/, "a track-specific id is rejected by the frozen parser");
});

test("a backend stop also survives the frozen parser, and says so in the note", () => {
  // Through parseContractResults itself, never a stand-in: a stopped group is
  // legal only as one combination — notRun at the manifest's count, timedOut
  // false, detail null, boot.ok false.
  const stopped = buildHardResult(contractOf({ boot: { stage: "layout", detail: "no backend/app" } }), "a1b2c3d4e5f6");
  assert.doesNotThrow(() => parseContractResults(JSON.stringify(stopped.contract), MANIFEST));
  assert.equal(stopped.fuzz.score, 0);
  assert.match(stopped.fuzz.note, /^backend stop \(layout\)/, "a stop must not read as a timeout at 200 notRun");
  assert.equal(stopped.contract.groups[0].notRun, 200);
});

test("the envelope's two halves are cross-checked on write and on read", () => {
  const good = buildHardResult(contractOf({ file: failingFile(["parts-blocked/case-0091"]) }), "a1b2c3d4e5f6");
  const text = (mutate: (value: any) => void): string => {
    const copy = JSON.parse(JSON.stringify(good));
    mutate(copy);
    return JSON.stringify(copy);
  };
  assert.doesNotThrow(() => parseHardResult(JSON.stringify(good), MANIFEST));
  assert.throws(() => parseHardResult(text((v) => { v.fuzz.passed -= 1; }), MANIFEST), /fuzz\.passed/);
  assert.throws(() => parseHardResult(text((v) => { v.fuzz.total = 199; }), MANIFEST), /fuzz\.total/);
  assert.throws(() => parseHardResult(text((v) => { v.fuzz.perStratum.pop(); }), MANIFEST), /20 strata/);
  assert.throws(() => parseHardResult(text((v) => { v.fuzz.perStratum[0].passed -= 1; }), MANIFEST), /adds up/);
  assert.throws(() => parseHardResult(text((v) => { v.fuzz.score += 0.01; }), MANIFEST), /stratum mean/);
  assert.throws(() => parseHardResult(text((v) => { v.fuzz.perStratum[0].id = "x"; }), MANIFEST), /perStratum\[0\]\.id/);
  assert.throws(() => parseHardResult(text((v) => { v.extra = 1; }), MANIFEST), /unexpected field "extra"/);
  assert.throws(() => parseHardResult(text((v) => { v.oracle = "xyz"; }), MANIFEST), /12 hex/);
});

test("a hard result is not a published contract-results.json", () => {
  // The frozen parser rejects the envelope (it wants its own fields), so nothing that reads
  // contract-results.json can mistake this file for one.
  const value = buildHardResult(contractOf(), "a1b2c3d4e5f6");
  assert.throws(() => parseContractResults(JSON.stringify(value), MANIFEST), /contract-results\.json is invalid/);
});

test("the hard track writes its own file, never the published one", () => {
  // contract-tests.ts owns contract-results.json for all published attempts.
  // A shared name would overwrite fifteen committed records and stop
  // process-results at requireHiddenRowsAgree.
  assert.equal(HARD_RESULTS_FILE, "contract-results-hard.json");
});

test("the hard manifest is not the frozen loader's business", () => {
  // loadManifest in contract-results.ts validates against HIDDEN_ROWS and reads
  // only benchmark/contract-tests/manifest.json. It is a RUBRIC_ID_INPUT and
  // must stay exactly as it is.
  const frozen = readFileSync(join(ROOT, "scripts", "lib", "contract-results.ts"), "utf8");
  assert.match(frozen, /HIDDEN_ROWS/, "the frozen loader still validates against HIDDEN_ROWS");
  assert.ok(!/console-fuzz|timeoutMs/.test(frozen), "the hard track must not have leaked into a hashed file");
});

test("the hard entry point and its modules are gate-3a inputs", () => {
  const source = readFileSync(join(ROOT, "scripts", "lib", "gate-fingerprint.ts"), "utf8");
  for (const path of ["scripts/contract-tests-hard.ts", "scripts/lib/hard-contract-results.ts", "scripts/lib/fuzz-score.ts"]) {
    assert.ok(source.includes(`"${path}"`), `${path} decides a score and must be a gate-3a input`);
  }
});

test("--root is the only way to name a track (Ruling H2)", () => {
  const source = readFileSync(join(ROOT, "scripts", "contract-tests-hard.ts"), "utf8");
  assert.ok(!/--tests-dir/.test(source), "a second convention for naming a track is forbidden");
  assert.match(source, /--attempts-dir/, "spec §9 assigns --attempts-dir to P2");
  assert.match(source, /--run-json-dir/, "spec §9 assigns --run-json-dir to P2");
});

// ---------------------------------------------------------------------------
// the arguments

test("the defaults follow --root, and a track is named by nothing but --root", () => {
  const defaults = parseArgs(["--attempt", ATTEMPT]);
  assert.equal(defaults.root, DEFAULT_TRACK_ROOT);
  assert.equal(defaults.attemptsDir, join(DEFAULT_TRACK_ROOT, "eval-attempts"));
  assert.equal(defaults.runJsonDir, join(DEFAULT_TRACK_ROOT, "eval-results"));
  const moved = parseArgs(["--attempt", ATTEMPT, "--root", "/somewhere/track"]);
  assert.equal(moved.attemptsDir, "/somewhere/track/eval-attempts");
  const named = parseArgs(["--attempt", ATTEMPT, "--root", "/t", "--attempts-dir", "/a", "--run-json-dir", "/r"]);
  assert.deepEqual([named.attemptsDir, named.runJsonDir], ["/a", "/r"]);
  assert.throws(() => parseArgs(["--attempt", ATTEMPT, "--tests-dir", "/x"]), /unknown argument/);
  assert.throws(() => parseArgs([]), /--attempt/);
  assert.throws(() => parseArgs(["--attempt", "../x"]), /not a path/);
  assert.throws(() => parseArgs(["--attempt", ATTEMPT, "--root", "/a", "--root", "/b"]), /twice/);
});

// ---------------------------------------------------------------------------
// runHardContractTests, in process

const OK: StepResult = { kind: "ok" };
const REMOVED: ContainerRemoval = { removed: true, detail: "removed" };

class FakeBackend implements ContractBackend {
  readonly calls: string[] = [];
  constructor(readonly options: BackendOptions, private readonly layout: StepResult = OK) {}
  checkLayout(): StepResult {
    this.calls.push("checkLayout");
    return this.layout;
  }
  async install(): Promise<StepResult> {
    this.calls.push("install");
    return OK;
  }
  async pipFreeze(): Promise<string[]> {
    return ["fastapi==0.115.14"];
  }
  async start(): Promise<StartResult> {
    this.calls.push("start");
    return { kind: "ready", baseUrl: "http://127.0.0.1:41001", container: "agrav-backend-demo-1" };
  }
  async servingState(): Promise<ServingState> {
    return { kind: "running" };
  }
  async stop(): Promise<ContainerRemoval> {
    this.calls.push("stop");
    return REMOVED;
  }
  async dispose(): Promise<ContainerRemoval[]> {
    this.calls.push("dispose");
    return [];
  }
}

interface Fixture {
  root: string;
  attemptsDir: string;
  runJsonDir: string;
  options: HardTestsOptions;
  backends: FakeBackend[];
  files: RunContractFileOptions[];
  lines: string[];
  deps: (overrides?: Partial<HardTestsDeps>) => Partial<HardTestsDeps>;
}

/**
 * A track root, an attempts directory and a run.json directory that are three
 * different places — as they are when Task 8 scores the published attempts where
 * they lie — with the fuzz's own manifest copied in.
 */
function fixture(options: { file?: ContractFileResult; layout?: StepResult; gate?: { recorded: string | null; current: string }; run?: Partial<RunJson> } = {}): Fixture {
  const base = tempDir("hard-run-");
  const root = join(base, "track");
  const attemptsDir = join(base, "attempts");
  const runJsonDir = join(base, "runs");
  mkdirSync(join(root, "benchmark", "fuzz"), { recursive: true });
  writeFileSync(join(root, "benchmark", "fuzz", "manifest.json"), readFileSync(join(TRACK, "benchmark", "fuzz", "manifest.json")));
  mkdirSync(join(attemptsDir, ATTEMPT), { recursive: true });
  writeRunJson(join(runJsonDir, ATTEMPT, "run.json"), { ...cleanRunJson(), ...options.run });
  const backends: FakeBackend[] = [];
  const files: RunContractFileOptions[] = [];
  const lines: string[] = [];
  const fx: Fixture = {
    root, attemptsDir, runJsonDir, backends, files, lines,
    options: { attempt: ATTEMPT, root, attemptsDir, runJsonDir, ignoreRunJson: false, allowUngated: false },
    deps: (overrides = {}) => ({
      createBackend: (o) => {
        const backend = new FakeBackend(o, options.layout);
        backends.push(backend);
        return backend;
      },
      runFile: async (o) => {
        files.push(o);
        return options.file ?? cleanFile;
      },
      image: () => ({ tag: REF.split("@")[0], ref: REF, id: `sha256:${"a".repeat(64)}` }),
      gate: () => options.gate ?? { recorded: "f".repeat(64), current: "f".repeat(64) },
      provenance: () => ({ testsCommit: "c".repeat(40), testsDirty: false }),
      isAlive: () => false,
      out: (line) => lines.push(line),
      ...overrides,
    }),
  };
  return fx;
}

function cleanRunJson(): RunJson {
  return {
    id: "demo", model: "demo-model", effort: "high", agyVersion: "1.1.26", image: REF,
    startedAt: "2026-09-21T09:00:00.000Z", durationMs: 600_000, exitCode: 0, envelope: null, stderrTail: "",
    softDenied: false, failureKind: null,
  };
}

test("a run reads the tests and the manifest from --root, writes only there, and never touches the published name", async () => {
  const fx = fixture();
  const outcome = await runHardContractTests(fx.options, fx.deps());
  assert.equal(outcome.kind, "written", JSON.stringify(outcome));
  assert.ok(outcome.kind === "written");
  assert.equal(outcome.path, join(fx.root, "eval-results", ATTEMPT, HARD_RESULTS_FILE));
  assert.deepEqual(readdirSync(join(fx.root, "eval-results", ATTEMPT)), [HARD_RESULTS_FILE]);
  assert.equal(fx.files.length, 1);
  assert.equal(fx.files[0].file, join(fx.root, "benchmark", "fuzz", "fuzz.test.ts"));
  assert.equal(fx.files[0].timeoutMs, 300_000, "the fuzz's own budget, not the uniform 120 s");
  assert.equal(fx.files[0].expectedTests, 200);
  assert.equal(fx.backends[0].options.attemptDir, join(fx.attemptsDir, ATTEMPT), "the attempt is read from --attempts-dir");
  assert.ok(!existsSync(join(fx.attemptsDir, ATTEMPT, "eval-results")));
  const written = readHardContractResults(outcome.path, loadHardManifest(fx.root));
  assert.equal(written.oracle, "f".repeat(12));
  assert.equal(written.fuzz.score, 3);
  assert.equal(written.contract.ungated, false);
  assert.match(fx.lines.join("\n"), /Differential fuzz: 200\/200 cases, stratum mean 3\/3/);
});

test("run.json is read from --run-json-dir, not from the track root", async () => {
  const fx = fixture({ run: { failureKind: "infra" } });
  const outcome = await runHardContractTests(fx.options, fx.deps());
  assert.equal(outcome.kind, "refused");
  assert.match((outcome as { message: string }).message, /infra/);
  assert.equal(fx.backends.length, 0, "nothing was started");
  // The same attempt with run.json where the default would look for it: not found there.
  const elsewhere = fixture();
  const found = await runHardContractTests({ ...elsewhere.options, runJsonDir: join(elsewhere.root, "eval-results") }, elsewhere.deps());
  assert.equal(found.kind, "refused");
});

test("hidden tests that differ from gate P2-B's record are refused, and --allow-ungated records it", async () => {
  const gate = { recorded: "a".repeat(64), current: "b".repeat(64) };
  const refused = fixture({ gate });
  const outcome = await runHardContractTests(refused.options, refused.deps());
  assert.equal(outcome.kind, "refused");
  assert.match((outcome as { message: string }).message, /gate P2-B/);
  assert.match((outcome as { message: string }).message, /gate:fuzz/);
  const allowed = fixture({ gate });
  const scored = await runHardContractTests({ ...allowed.options, allowUngated: true }, allowed.deps());
  assert.ok(scored.kind === "written");
  assert.equal(scored.result.contract.ungated, true);
  assert.equal(scored.result.oracle, "b".repeat(12), "the era is the files that actually ran");
  const none = fixture({ gate: { recorded: null, current: "b".repeat(64) } });
  assert.match(((await runHardContractTests(none.options, none.deps())) as { message: string }).message, /no readable record/);
});

test("a backend stop is written, all zero, and says so in the fuzz note", async () => {
  const fx = fixture({ layout: { kind: "stop", stage: "layout", detail: "no backend/app/main.py" } });
  const outcome = await runHardContractTests(fx.options, fx.deps());
  assert.ok(outcome.kind === "written");
  assert.equal(fx.files.length, 0);
  assert.equal(outcome.result.fuzz.score, 0);
  assert.match(outcome.result.fuzz.note, /^backend stop \(layout\): no backend\/app\/main\.py/);
  assert.deepEqual(fx.backends[0].calls, ["checkLayout", "dispose"]);
});

test("a run cut off by the timer is charged from the end of the file", async () => {
  const cut: ContractFileResult = { ...cleanFile, passed: 185, notRun: 15, timedOut: true };
  const fx = fixture({ file: cut });
  const outcome = await runHardContractTests(fx.options, fx.deps());
  assert.ok(outcome.kind === "written");
  assert.equal(outcome.result.fuzz.perStratum.at(-1)?.passed, 0);
  assert.equal(outcome.result.fuzz.perStratum.at(-2)?.passed, CASES_PER_STRATUM - 5);
  assert.match(outcome.result.fuzz.note, /15 did not run/);
});

test("a result whose counts contradict each other is a harness fault: nothing is written", async () => {
  // Not the model's doing: fuzz.test.ts reads only its own files.
  const broken: ContractFileResult = { ...cleanFile, total: 199, passed: 199 };
  const fx = fixture({ file: broken });
  const outcome = await runHardContractTests(fx.options, fx.deps());
  assert.equal(outcome.kind, "infra");
  assert.ok(!existsSync(join(fx.root, "eval-results")));
});

test("the entry point and the frozen entry point do not share a stale-temp-file prefix", async () => {
  // A dead writer's temp file of THIS name is removed; the published track's is left alone.
  const fx = fixture();
  const dir = join(fx.root, "eval-results", ATTEMPT);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `.${HARD_RESULTS_FILE}.999999.deadbeef.tmp`), "");
  writeFileSync(join(dir, ".contract-results.json.999999.deadbeef.tmp"), "");
  const outcome = await runHardContractTests(fx.options, fx.deps());
  assert.equal(outcome.kind, "written");
  assert.deepEqual(readdirSync(dir).sort(), [".contract-results.json.999999.deadbeef.tmp", HARD_RESULTS_FILE]);
});

test("the summary names the stratum mean, not the raw ratio the frozen group carries", () => {
  const spread = buildHardResult(contractOf({ file: failingFile(STRATA.slice(0, 10).map((s) => caseName(s.id, 1))) }), "a1b2c3d4e5f6");
  const [line] = hardSummaryLines(spread);
  assert.match(line, /190\/200 cases, stratum mean 2\.85\/3/);
});
