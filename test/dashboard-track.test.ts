/**
 * Tests for dashboard track switch (P4d Task 4).
 *
 * Tests the TrackSelector component exists and ResultCard track-aware paths.
 * Tests are structural (file existence, export presence) since JSX rendering
 * requires a DOM environment that node:test doesn't provide.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  computeRubricStats,
  countLines,
  parseRunnerMeta,
  requiredYamlScalar,
  yamlScalar,
} from "../website/src/components/benchmarkStats";
import { RUBRIC_ROWS } from "../scripts/lib/rubric";
import { HARD_RUBRIC_ROWS } from "../scripts/lib/hard-rubric";
import { BROWNFIELD_RUBRIC_ROWS } from "../scripts/lib/brownfield-rubric";

const ROOT = join(import.meta.dirname!, "..");
const WEBSITE = join(ROOT, "website", "src");

describe("dashboard track switch", () => {
  it("TrackSelector component exists", () => {
    assert.ok(
      existsSync(join(WEBSITE, "components", "TrackSelector.tsx")),
      "website/src/components/TrackSelector.tsx must exist",
    );
  });

  it("TrackSelector exports a default function", () => {
    const content = readFileSync(join(WEBSITE, "components", "TrackSelector.tsx"), "utf8");
    assert.match(content, /export default function TrackSelector/);
  });

  it("TrackSelector has role='tablist' for accessibility", () => {
    const content = readFileSync(join(WEBSITE, "components", "TrackSelector.tsx"), "utf8");
    assert.match(content, /role=["']tablist["']/);
  });

  it("TrackSelector has role='tab' for each button", () => {
    const content = readFileSync(join(WEBSITE, "components", "TrackSelector.tsx"), "utf8");
    assert.match(content, /role=["']tab["']/);
  });

  it("TrackSelector has aria-selected", () => {
    const content = readFileSync(join(WEBSITE, "components", "TrackSelector.tsx"), "utf8");
    assert.match(content, /aria-selected/);
  });

  it("ResultCard accepts optional track prop", () => {
    const content = readFileSync(join(WEBSITE, "components", "ResultCard.tsx"), "utf8");
    assert.match(content, /track\??\s*:/);
  });

  it("ResultCard uses screenshots/hard/ path when track is hard", () => {
    const content = readFileSync(join(WEBSITE, "components", "ResultCard.tsx"), "utf8");
    assert.match(content, /screenshots\/hard\//);
  });

  it("ResultsDashboard imports TrackSelector", () => {
    const content = readFileSync(join(WEBSITE, "components", "ResultsDashboard.tsx"), "utf8");
    assert.match(content, /TrackSelector/);
  });

  it("ResultsDashboard has track state", () => {
    const content = readFileSync(join(WEBSITE, "components", "ResultsDashboard.tsx"), "utf8");
    assert.match(content, /useState.*['"]classic['"]/);
  });

  it("index.astro passes track-related data to ResultsDashboard", () => {
    const content = readFileSync(join(ROOT, "website", "src", "pages", "index.astro"), "utf8");
    // Should either import results-hard.json or have a hard results reference
    assert.match(content, /results-hard/);
    // Should also import results-brownfield.json and pass brownfield data
    assert.match(content, /results-brownfield/);
    assert.match(content, /brownfieldModelAverages/);
  });

  it("TrackSelector supports brownfield track", () => {
    const content = readFileSync(join(WEBSITE, "components", "TrackSelector.tsx"), "utf8");
    assert.match(content, /"brownfield"/);
    assert.match(content, />\s*Brownfield\s*</);
  });

  it("ResultCard uses screenshots/brownfield/ path when track is brownfield", () => {
    const content = readFileSync(join(WEBSITE, "components", "ResultCard.tsx"), "utf8");
    assert.match(content, /screenshots\/brownfield\//);
  });

  it("ResultsDashboard supports brownfield track data", () => {
    const content = readFileSync(join(WEBSITE, "components", "ResultsDashboard.tsx"), "utf8");
    assert.match(content, /brownfieldModelAverages/);
    assert.match(content, /brownfieldSortedResults/);
  });

  it("benchmark.astro reads prompt and criteria for brownfield off disk", () => {
    const content = readFileSync(join(ROOT, "website", "src", "pages", "benchmark.astro"), "utf8");
    assert.match(content, /tracks\/brownfield\/prompt\.md/);
    assert.match(content, /tracks\/brownfield\/benchmark\/criteria\.md/);
  });

  it("countLines matches wc -l on prompt and criteria files", () => {
    const promptClassic = readFileSync(join(ROOT, "prompt.md"), "utf8");
    assert.equal(countLines(promptClassic), 209);

    const criteriaClassic = readFileSync(join(ROOT, "benchmark/criteria.md"), "utf8");
    assert.equal(countLines(criteriaClassic), 353);

    const promptHard = readFileSync(join(ROOT, "tracks/console-hard/prompt.md"), "utf8");
    assert.equal(countLines(promptHard), 1044);

    const criteriaHard = readFileSync(join(ROOT, "tracks/console-hard/benchmark/criteria.md"), "utf8");
    assert.equal(countLines(criteriaHard), 238);

    const promptBrownfield = readFileSync(join(ROOT, "tracks/brownfield/prompt.md"), "utf8");
    assert.equal(countLines(promptBrownfield), 60);

    const criteriaBrownfield = readFileSync(join(ROOT, "tracks/brownfield/benchmark/criteria.md"), "utf8");
    assert.equal(countLines(criteriaBrownfield), 135);
  });

  it("computeRubricStats matches rubric rows breakdown for all tracks", () => {
    const classic = computeRubricStats(RUBRIC_ROWS);
    assert.equal(classic.max, 14);
    assert.equal(classic.hidden, 7);
    assert.equal(classic.auto, 1);
    assert.equal(classic.agent, 3);
    assert.equal(classic.human, 3);
    assert.equal(classic.judgeManual, 6);

    const hard = computeRubricStats(HARD_RUBRIC_ROWS);
    assert.equal(hard.max, 19);
    assert.equal(hard.hidden, 14);
    assert.equal(hard.auto, 1);
    assert.equal(hard.agent, 3);
    assert.equal(hard.human, 1);
    assert.equal(hard.judgeManual, 4);

    const brownfield = computeRubricStats(BROWNFIELD_RUBRIC_ROWS);
    assert.equal(brownfield.max, 12);
    assert.equal(brownfield.hidden, 7);
    assert.equal(brownfield.auto, 2);
    assert.equal(brownfield.agent, 2);
    assert.equal(brownfield.human, 1);
    assert.equal(brownfield.judgeManual, 3);
  });

  it("built benchmark page contains correct scoring numbers and breakdown for all tracks", () => {
    const tmp = mkdtempSync(join(tmpdir(), "astro-benchmark-test-"));
    try {
      execFileSync("npx", ["astro", "build", "--outDir", tmp], {
        cwd: join(ROOT, "website"),
        stdio: "pipe",
      });

      const htmlPath = join(tmp, "benchmark", "index.html");
      assert.ok(existsSync(htmlPath), "built benchmark/index.html must exist");
      const html = readFileSync(htmlPath, "utf8");

      // Classic track: 14.0 max, 7 hidden, 1 auto, 6 judge/manual
      assert.ok(html.includes("14.0 Punktów Max"), "Classic must show 14.0 Punktów Max");
      assert.match(
        html,
        /7 pkt z ukrytych testów automatycznych \+ 1 pkt auto \+ 6 pkt z weryfikacji sędziego i testów manualnych człowieka/,
      );

      // Hard track: 19.0 max, 14 hidden, 1 auto, 4 judge/manual
      assert.ok(html.includes("19.0 Punktów Max"), "Hard must show 19.0 Punktów Max");
      assert.match(
        html,
        /14 pkt z ukrytych testów automatycznych i E2E \+ 1 pkt auto \+ 4 pkt sędzia\/człowiek/,
      );

      // Brownfield track: 12.0 max, 7 hidden, 2 auto, 3 judge/manual
      assert.ok(html.includes("12.0 Punktów Max"), "Brownfield must show 12.0 Punktów Max");
      assert.match(
        html,
        /7 pkt z testów ukrytych \(Regression 4, Change suite 3\) \+ 2 pkt auto \(Local build 1, Diff locality 1\) \+ 3 pkt agent\/człowiek \(Code structure, Self-verification, Visual design\)/,
      );

      // Line counters (wc -l)
      assert.ok(html.includes("prompt.md • 209 linii"), "prompt.md must show 209 linii");
      assert.ok(html.includes("criteria.md • 353 linii"), "criteria.md must show 353 linii");
      assert.ok(
        html.includes("tracks/brownfield/prompt.md • 60 linii"),
        "tracks/brownfield/prompt.md must show 60 linii",
      );
      assert.ok(
        html.includes("tracks/brownfield/benchmark/criteria.md • 135 linii"),
        "criteria.md must show 135 linii",
      );

      // Hard judge section: 14 automated points, not 12
      assert.ok(
        html.includes("14 punktów testów automatycznych daje sześć plików ukrytych testów kontraktowych"),
        "Hard judge section must state 14 points, not 12",
      );
      // The fuzz oracle backs the gates and scores no row.
      assert.ok(!html.includes("differential fuzzing"), "Hard judge section must not credit the fuzz oracle with points");
      assert.ok(
        !html.includes("12 punktów testów automatycznych"),
        "Hard judge section must not contain '12 punktów testów automatycznych'",
      );

      // Brownfield judge section: tool-computed rows
      assert.ok(
        html.includes("3 wiersze liczone przez narzędzie (contract-results-brownfield)"),
        "Brownfield judge section must state tool-computed rows",
      );
      assert.ok(
        !html.includes("3 wiersze automatyczne (Regression: 4 pkt"),
        "Brownfield judge section must not say '3 wiersze automatyczne'",
      );

      // Dynamic row counts from rubric definitions
      const classicHiddenCount = RUBRIC_ROWS.filter((r) => r.scoredBy === "hidden").length;
      const classicHumanCount = RUBRIC_ROWS.filter((r) => r.scoredBy === "human").length;
      assert.ok(
        html.includes(`${BROWNFIELD_RUBRIC_ROWS.length} wierszy`),
        `Brownfield section must state ${BROWNFIELD_RUBRIC_ROWS.length} wierszy`,
      );
      assert.ok(
        html.includes(`${classicHiddenCount} wiersze testów ukrytych`),
        `Classic must show dynamic count of hidden rows (${classicHiddenCount})`,
      );
      assert.ok(
        html.includes(`${classicHumanCount} wiersze interfejsu`),
        `Classic must show dynamic count of human rows (${classicHumanCount})`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("parseRunnerMeta enforces required fields (judge and rubric)", () => {
    const valid = "judge: claude-3-5-sonnet\nrubric: maintenance-console-hard@123\n";
    const parsed = parseRunnerMeta(valid, "benchmark/runner-hard.yaml");
    assert.equal(parsed.judge, "claude-3-5-sonnet");
    assert.equal(parsed.rubric, "maintenance-console-hard@123");

    // Missing judge
    assert.throws(
      () => parseRunnerMeta("rubric: some-rubric\n", "test.yaml"),
      /benchmark\.astro: missing required field "judge" in test\.yaml/,
    );

    // Missing rubric
    assert.throws(
      () => parseRunnerMeta("judge: some-judge\n", "test.yaml"),
      /benchmark\.astro: missing required field "rubric" in test\.yaml/,
    );
  });
});
