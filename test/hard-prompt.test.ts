import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { BACKEND_PORT, FRONTEND_PORT } from "../scripts/serve-attempt";

const promptPath = new URL("../tracks/console-hard/prompt.md", import.meta.url);
const seedPath = new URL("../tracks/console-hard/benchmark/context/seed.json", import.meta.url);

const prompt = readFileSync(promptPath, "utf8");
const seed = JSON.parse(readFileSync(seedPath, "utf8"));

test("the seed embedded in the prompt is the hard seed without schema: console-hard/1", () => {
  const match = prompt.match(/```json seed\n([\s\S]*?)\n```/);
  assert.ok(match, "tracks/console-hard/prompt.md must carry one ```json seed block");
  const parsed = JSON.parse(match[1]);
  const { schema: _schema, ...expectedSeed } = seed;
  assert.deepEqual(parsed, expectedSeed);
  assert.equal(parsed.schema, undefined, "schema key must not be present in prompt seed");
});

test("the prompt states the run contract literally", () => {
  for (const line of [
    "python3 -m venv .venv",
    ".venv/bin/pip install -r requirements.txt",
    `.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port ${BACKEND_PORT}`,
    "npm install && npm run build",
    `port ${FRONTEND_PORT}, proxies /api to http://localhost:${BACKEND_PORT}`,
  ]) {
    assert.ok(prompt.includes(line), `missing run contract line: ${line}`);
  }
});

test("the prompt names the expected backend and frontend ports", () => {
  assert.ok(prompt.includes(`--port ${BACKEND_PORT}`));
  assert.ok(prompt.includes(`http://localhost:${BACKEND_PORT}`));
  assert.ok(prompt.includes(`port ${FRONTEND_PORT}`));

  const ports = new Set([BACKEND_PORT, FRONTEND_PORT]);
  for (const match of prompt.matchAll(/(--port[ =]|\bports?\s+|localhost:|127\.0\.0\.1:|0\.0\.0\.0:)(\d+)(?:\s+and\s+(\d+))?/g)) {
    if (match[1].startsWith("--port")) {
      assert.equal(Number(match[2]), BACKEND_PORT, `uvicorn port mismatch: ${match[0]}`);
    }
    for (const port of [match[2], match[3]]) {
      if (port !== undefined) {
        assert.ok(ports.has(Number(port)), `prompt mentions unexpected port: ${match[0]}`);
      }
    }
  }
});

test("the prompt keeps requirements.txt to PyPI packages", () => {
  assert.ok(prompt.includes("It lists only packages from PyPI, no local paths (such as `.` or `-e .`)."));
});

test("the prompt names every error code, status reason, and HTTP status code", () => {
  for (const token of [
    "not_found", "invalid_transition", "validation_error",
    "parts_unavailable", "no_qualified_technician", "no_capacity",
  ]) {
    assert.ok(prompt.includes(token), `missing error code or status reason: ${token}`);
  }
  for (const status of ["200", "201", "404", "409", "422"]) {
    assert.ok(prompt.includes(status), `missing HTTP status: ${status}`);
  }
});

test("the prompt explicitly states the array vs null convention", () => {
  const phrase = "Both `technician_ids` and `segments` are `[]` when there is no slot, never `null`. This is the one exception to the convention that a missing value is `null`.";
  assert.ok(prompt.includes(phrase), `missing array vs null rule: ${phrase}`);
});

test("every endpoint the hard contract tests call is specified in the prompt", () => {
  const dir = new URL("../tracks/console-hard/benchmark/contract-tests/", import.meta.url);
  const source = readdirSync(dir).filter((name) => name.endsWith(".ts")).map((name) => readFileSync(new URL(name, dir), "utf8")).join("\n");
  const paths = new Set<string>();
  for (const match of source.matchAll(/[`"](\/[a-z][a-z-]*)/g)) paths.add(match[1]);
  assert.ok(paths.size >= 9, `expected >= 9 API paths, found ${[...paths].join(", ")}`);
  for (const path of paths) {
    assert.ok(prompt.includes(path), `contract tests call ${path}, which prompt never mentions`);
  }
});

test("every field, status, priority and hard addition in the seed is named in the prompt", () => {
  const words = new Set<string>();
  const { schema: _, ...cleanSeed } = seed;
  for (const rows of Object.values(cleanSeed) as Record<string, unknown>[][]) {
    for (const row of rows) for (const key of Object.keys(row)) words.add(key);
  }
  for (const word of [
    "available", "low_stock", "part_id", "quantity",
    "open", "scheduled", "blocked", "unscheduled", "in_progress", "completed", "cancelled",
    "critical", "high", "medium", "low",
    "holidays", "travel_minutes", "site_ids", "absences",
    "crew_size", "splittable", "min_segment_minutes", "technician_ids", "segments",
  ]) {
    words.add(word);
  }
  for (const word of words) {
    assert.ok(prompt.includes(word), `the prompt never mentions ${word}`);
  }
});

test("the prompt specifies strictly typed fields, validation rules and planner rules", () => {
  for (const phrase of [
    "StrictInt", "StrictBool", "crew_size", "splittable", "min_segment_minutes",
    "clipped window", "EDF", "preemption",
  ]) {
    assert.ok(prompt.includes(phrase), `missing phrase: ${phrase}`);
  }
});

test("the prompt fits in one argv string", () => {
  assert.ok(Buffer.byteLength(prompt) < 100_000, `prompt size ${Buffer.byteLength(prompt)} bytes >= 100,000`);
});
