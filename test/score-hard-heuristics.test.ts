/**
 * Tests for the heuristic scoring functions in scripts/score-hard.ts:
 * evaluateCodeStructure, evaluateTechStack, evaluateSelfVerification.
 *
 * Uses fixture trees under mkdtempSync to validate the recursive module
 * lookup and honest Notes prefixes.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  evaluateCodeStructure,
  evaluateTechStack,
  evaluateSelfVerification,
} from "../scripts/score-hard";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Every fixture tree this file made, removed when it is done: a run leaves nothing in tmpdir. */
const madeDirs: string[] = [];
after(() => {
  for (const dir of madeDirs) rmSync(dir, { recursive: true, force: true });
});

function mkTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "score-hard-heur-"));
  madeDirs.push(dir);
  return dir;
}

/** Create a minimal attempt directory with backend/app (store, planner, routes, schemas). */
function mkAttempt(): string {
  const dir = mkTempDir();
  const app = join(dir, "backend", "app");
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, "store.py"), "# store");
  writeFileSync(join(app, "planner.py"), "# planner\ndef plan(): pass\n");
  writeFileSync(join(app, "routes.py"), "from fastapi import APIRouter\n");
  writeFileSync(join(app, "schemas.py"), "from pydantic import BaseModel\n");
  return dir;
}

/** Add a frontend/src directory with the given file tree (relative paths). */
function addFrontend(dir: string, files: string[]): void {
  for (const f of files) {
    const full = join(dir, "frontend", "src", f);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, `// ${f}\n`);
  }
}

// ---------------------------------------------------------------------------
// evaluateCodeStructure
// ---------------------------------------------------------------------------

describe("evaluateCodeStructure", () => {
  it("finds types and api nested under src/services/ and src/api/", () => {
    const dir = mkAttempt();
    addFrontend(dir, ["App.tsx", "services/api.ts", "api/types.ts"]);
    const result = evaluateCodeStructure(dir);
    assert.equal(result.score, 1, `expected 1, notes: ${result.notes}`);
    assert.match(result.notes, /heuristic \(not judged\):/);
    assert.match(result.notes, /types.*module found|types.*found/i);
    assert.match(result.notes, /api.*module found|api.*found/i);
  });

  it("finds types/api.ts (directory named 'types') as the types module", () => {
    const dir = mkAttempt();
    addFrontend(dir, ["App.tsx", "types/api.ts", "api/client.ts"]);
    const result = evaluateCodeStructure(dir);
    assert.equal(result.score, 1, `expected 1, notes: ${result.notes}`);
  });

  it("finds *.types.ts as the types module", () => {
    const dir = mkAttempt();
    addFrontend(dir, ["App.tsx", "models/work-order.types.ts", "api.ts"]);
    const result = evaluateCodeStructure(dir);
    assert.equal(result.score, 1, `expected 1, notes: ${result.notes}`);
  });

  it("finds services/*api*.ts as the api module", () => {
    const dir = mkAttempt();
    addFrontend(dir, ["App.tsx", "types.ts", "services/workOrderApi.ts"]);
    const result = evaluateCodeStructure(dir);
    assert.equal(result.score, 1, `expected 1, notes: ${result.notes}`);
  });

  it("finds client.ts nested in a subdirectory as the api module", () => {
    const dir = mkAttempt();
    addFrontend(dir, ["App.tsx", "types.ts", "lib/client.ts"]);
    const result = evaluateCodeStructure(dir);
    assert.equal(result.score, 1, `expected 1, notes: ${result.notes}`);
  });

  it("gives 0.5 when types or api is missing", () => {
    const dir = mkAttempt();
    addFrontend(dir, ["App.tsx"]);
    const result = evaluateCodeStructure(dir);
    assert.equal(result.score, 0.5);
    assert.match(result.notes, /heuristic \(not judged\):/);
  });

  it("gives 0 when planner imports FastAPI", () => {
    const dir = mkAttempt();
    writeFileSync(join(dir, "backend", "app", "planner.py"), "from fastapi import APIRouter\n");
    addFrontend(dir, ["App.tsx", "types.ts", "api.ts"]);
    const result = evaluateCodeStructure(dir);
    assert.equal(result.score, 0);
  });

  it("gives 0 when backend/app is missing", () => {
    const dir = mkTempDir();
    const result = evaluateCodeStructure(dir);
    assert.equal(result.score, 0);
  });

  it("skips node_modules during recursive walk", () => {
    const dir = mkAttempt();
    // Only put types/api inside node_modules — should NOT be found
    addFrontend(dir, ["App.tsx"]);
    const nm = join(dir, "frontend", "src", "node_modules", "pkg");
    mkdirSync(nm, { recursive: true });
    writeFileSync(join(nm, "types.ts"), "// types");
    writeFileSync(join(nm, "api.ts"), "// api");
    const result = evaluateCodeStructure(dir);
    // types and api not found (only in node_modules), so score should be 0.5
    assert.equal(result.score, 0.5);
  });
});

// ---------------------------------------------------------------------------
// evaluateTechStack
// ---------------------------------------------------------------------------

describe("evaluateTechStack", () => {
  it("notes say heuristic (not judged)", () => {
    const dir = mkAttempt();
    mkdirSync(join(dir, "frontend"), { recursive: true });
    writeFileSync(join(dir, "README.md"), "# hello");
    writeFileSync(join(dir, "backend", "requirements.txt"), "fastapi\n");
    writeFileSync(join(dir, "frontend", "package.json"), "{}");
    writeFileSync(join(dir, "frontend", "vite.config.ts"), 'proxy: { "/api": "http://localhost:5100" }');
    const result = evaluateTechStack(dir);
    assert.equal(result.score, 1);
    assert.match(result.notes, /heuristic \(not judged\):/);
  });
});

// ---------------------------------------------------------------------------
// evaluateSelfVerification
// ---------------------------------------------------------------------------

describe("evaluateSelfVerification", () => {
  it("notes say heuristic (not judged) when tests are found", () => {
    const dir = mkAttempt();
    const testDir = join(dir, "backend", "tests");
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, "test_plan.py"), "def test_plan():\n  assert plan()\n");
    const result = evaluateSelfVerification(dir);
    assert.equal(result.score, 1);
    assert.match(result.notes, /heuristic \(not judged\):/);
  });

  it("notes say heuristic (not judged) when no tests found", () => {
    const dir = mkAttempt();
    const result = evaluateSelfVerification(dir);
    assert.equal(result.score, 0);
    assert.match(result.notes, /heuristic \(not judged\):/);
  });
});
