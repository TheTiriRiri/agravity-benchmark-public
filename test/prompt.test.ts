import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { publishSpec, SERVE_COMMAND } from "../scripts/lib/attempt-backend";
import { BACKEND_PORT, FRONTEND_PORT } from "../scripts/serve-attempt";

const prompt = readFileSync(new URL("../prompt.md", import.meta.url), "utf8");
const criteria = readFileSync(new URL("../benchmark/criteria.md", import.meta.url), "utf8");
const skill = readFileSync(new URL("../.claude/skills/agrav-score-attempt/SKILL.md", import.meta.url), "utf8");
const seed = JSON.parse(readFileSync(new URL("../benchmark/context/seed.json", import.meta.url), "utf8"));

test("the seed embedded in the prompt is the seed the hidden tests use", () => {
  const match = prompt.match(/```json seed\n([\s\S]*?)\n```/);
  assert.ok(match, "prompt.md must carry one ```json seed block");
  assert.deepEqual(JSON.parse(match[1]), seed);
});

test("the prompt states the run contract literally", () => {
  for (const line of [
    "python3 -m venv .venv",
    ".venv/bin/pip install -r requirements.txt",
    `.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port ${BACKEND_PORT}`,
    "npm install && npm run build",
    `port ${FRONTEND_PORT}, proxies /api to http://localhost:${BACKEND_PORT}`,
  ]) {
    assert.ok(prompt.includes(line), `missing: ${line}`);
  }
});

test("the prompt, the rubric docs, the skill and the tools name the same backend and frontend ports", () => {
  // Each is its own literal, and a mismatch would otherwise surface only in the
  // live gate or on a scored attempt: a proxy aimed at one port, a container
  // published on another.
  assert.deepEqual(SERVE_COMMAND.slice(-2), ["--port", String(BACKEND_PORT)]);
  assert.equal(publishSpec(BACKEND_PORT), `127.0.0.1:${BACKEND_PORT}:${BACKEND_PORT}`);
  assert.equal(publishSpec("ephemeral"), `127.0.0.1::${BACKEND_PORT}`);
  for (const [name, text] of [["prompt.md", prompt], ["criteria.md", criteria]] as const) {
    for (const literal of [`--port ${BACKEND_PORT}`, `http://localhost:${BACKEND_PORT}`, `port ${FRONTEND_PORT}`]) {
      assert.ok(text.includes(literal), `${name} is missing: ${literal}`);
    }
  }
  assert.ok(skill.includes(`http://127.0.0.1:${BACKEND_PORT}/api/v1/`), "SKILL.md's curl URL names another backend port");
  const ports = new Set([BACKEND_PORT, FRONTEND_PORT]);
  for (const [name, text] of [["prompt.md", prompt], ["criteria.md", criteria], ["SKILL.md", skill]] as const) {
    for (const match of text.matchAll(/(--port[ =]|\bports?\s+|localhost:|127\.0\.0\.1:|0\.0\.0\.0:)(\d+)(?:\s+and\s+(\d+))?/g)) {
      if (match[1].startsWith("--port")) assert.equal(Number(match[2]), BACKEND_PORT, `${name}: ${match[0]} is uvicorn's port`);
      for (const port of [match[2], match[3]]) {
        if (port !== undefined) assert.ok(ports.has(Number(port)), `${name}: ${JSON.stringify(match[0])} names neither ${BACKEND_PORT} nor ${FRONTEND_PORT}`);
      }
    }
  }
});

test("the prompt keeps requirements.txt to PyPI packages", () => {
  // Scoring installs it with backend/ mounted read-only: a local project (`.`,
  // `-e .`) that pip builds in-tree would fail there with EROFS and read as the
  // model's install stop, though it installed in the model's writable session.
  assert.ok(prompt.includes("It lists only packages from PyPI, no local paths (such as `.` or `-e .`)."));
});

test("the prompt names every error code and status reason the tests assert", () => {
  for (const token of ["not_found", "invalid_transition", "validation_error", "parts_unavailable", "no_qualified_technician", "no_capacity"]) {
    assert.ok(prompt.includes(token), `missing: ${token}`);
  }
});

test("every endpoint the hidden tests call is specified in the prompt", () => {
  const dir = new URL("../benchmark/contract-tests/", import.meta.url);
  const source = readdirSync(dir).filter((name) => name.endsWith(".ts")).map((name) => readFileSync(new URL(name, dir), "utf8")).join("\n");
  const paths = new Set<string>();
  for (const match of source.matchAll(/[`"](\/[a-z][a-z-]*)/g)) paths.add(match[1]);
  assert.ok(paths.size >= 9, `expected to find the API paths in the tests, found ${[...paths].join(", ")}`);
  for (const path of paths) assert.ok(prompt.includes(`${path}`), `the tests call ${path}, which the prompt never mentions`);
});

test("every field, status and priority in the seed is named in the prompt", () => {
  const words = new Set<string>();
  for (const rows of Object.values(seed) as Record<string, unknown>[][]) {
    for (const row of rows) for (const key of Object.keys(row)) words.add(key);
  }
  for (const word of ["available", "low_stock", "part_id", "quantity", "open", "scheduled", "blocked", "unscheduled", "in_progress", "completed", "cancelled", "critical", "high", "medium", "low"]) words.add(word);
  for (const word of words) assert.ok(prompt.includes(word), `the prompt never mentions ${word}`);
});

test("every validation rule the hidden tests exercise is stated in the prompt", () => {
  for (const phrase of [
    "missing or has the wrong type", "is empty", "below 30, above 480 or not a multiple of 30", "a date is malformed",
    "`due_date` is before `earliest_start`", "`priority` is not one of the four", "`quantity` is below 1",
    "the same `part_id` appears twice", "does not exist", "exactly** the fields", "nothing else", "not a Monday",
  ]) {
    assert.ok(prompt.includes(phrase), `missing: ${phrase}`);
  }
});

test("the prompt fits in one argv string", () => {
  // run-attempt passes it as `agy -p "$PROMPT"`; Linux caps one argument at 128 KiB.
  assert.ok(Buffer.byteLength(prompt) < 100_000);
});
