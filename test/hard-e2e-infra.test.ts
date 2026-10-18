import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { HARD_RUBRIC_ROWS } from "../scripts/lib/hard-rubric";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const E2E_DIR = join(ROOT, "tracks", "console-hard", "benchmark", "e2e-tests");
const MANIFEST_PATH = join(E2E_DIR, "manifest.json");
const CONFIG_PATH = join(E2E_DIR, "playwright.config.ts");
const HELPERS_PATH = join(E2E_DIR, "helpers.ts");
const PACKAGE_JSON_PATH = join(ROOT, "tracks", "console-hard", "package.json");

test("manifest.json exists and maps e2e specs to hard rubric rows", () => {
  assert.ok(existsSync(MANIFEST_PATH), "manifest.json must exist");
  const content = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  assert.ok(Array.isArray(content.files), "manifest must have files array");
  assert.equal(content.files.length, 2, "manifest must declare 2 files");

  const expected = [
    { file: "flows.spec.ts", row: "Frontend E2E: flows", max: 2, tests: 10 },
    { file: "layout.spec.ts", row: "Frontend E2E: layout & a11y", max: 1, tests: 8 },
  ];
  assert.deepEqual(content.files, expected);

  for (const entry of content.files) {
    const rubricRow = HARD_RUBRIC_ROWS.find((r) => r.name === entry.row);
    assert.ok(rubricRow, `row ${entry.row} must exist in HARD_RUBRIC_ROWS`);
    assert.equal(rubricRow.max, entry.max, `max for ${entry.row} must match`);
    assert.equal(rubricRow.scoredBy, "hidden", `row ${entry.row} must be hidden`);
  }
});

test("playwright.config.ts specifies retries: 1 per Ruling H12, baseURL and timeouts", async () => {
  assert.ok(existsSync(CONFIG_PATH), "playwright.config.ts must exist");
  const content = readFileSync(CONFIG_PATH, "utf8");

  // Verify key configuration requirements statically
  assert.match(content, /retries:\s*1/, "Ruling H12: retries must be 1");
  assert.match(content, /workers:\s*1/, "workers must be 1 to prevent fixed-port collisions");
  assert.match(content, /baseURL:\s*["']http:\/\/localhost:5173["']/, "baseURL must be http://localhost:5173");
  assert.match(content, /headless:\s*true/, "headless must be true");
  assert.match(content, /trace:\s*["']retain-on-failure["']/, "trace must be retain-on-failure");
  assert.match(content, /timeout:\s*60000/, "timeout must be 60000ms");
  assert.match(content, /expect:\s*\{\s*timeout:\s*5000,?\s*\}/, "expect timeout must be 5000ms");
  assert.match(content, /testDir:\s*["']\.["']/, "testDir must be '.'");

  const configModule = await import(CONFIG_PATH);
  const config = configModule.default ?? configModule;
  assert.equal(config.retries, 1);
  assert.equal(config.workers, 1);
  assert.equal(config.timeout, 60000);
  assert.equal(config.expect?.timeout, 5000);
  assert.equal(config.use?.baseURL, "http://localhost:5173");
  assert.equal(config.use?.headless, true);
  assert.equal(config.use?.trace, "retain-on-failure");
});

test("tracks/console-hard/package.json pins exact versions per Ruling H3", () => {
  assert.ok(existsSync(PACKAGE_JSON_PATH), "tracks/console-hard/package.json must exist");
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));
  assert.equal(pkg.name, "console-hard-e2e");
  assert.equal(pkg.private, true);
  assert.deepEqual(pkg.dependencies, {
    playwright: "1.62.1",
    "@playwright/test": "1.62.1",
    "@axe-core/playwright": "4.13.0",
    "axe-core": "4.13.0",
  });
});

test("helpers.ts exports resetDatabase, warmupRoutes, assertPinnedVersions, navigateTo", async () => {
  assert.ok(existsSync(HELPERS_PATH), "helpers.ts must exist");
  const helpers = await import(HELPERS_PATH);
  assert.equal(typeof helpers.resetDatabase, "function", "resetDatabase must be exported");
  assert.equal(typeof helpers.warmupRoutes, "function", "warmupRoutes must be exported");
  assert.equal(typeof helpers.assertPinnedVersions, "function", "assertPinnedVersions must be exported");
  assert.equal(typeof helpers.navigateTo, "function", "navigateTo must be exported");
});
