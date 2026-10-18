import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { Rng } from "../tracks/console-fuzz/benchmark/fuzz/rng";

test("the same seed replays the same stream, and a different seed does not", () => {
  const a = new Rng(20260921);
  const b = new Rng(20260921);
  const c = new Rng(20260922);
  const first = Array.from({ length: 64 }, () => a.u32());
  assert.deepEqual(Array.from({ length: 64 }, () => b.u32()), first);
  assert.notDeepEqual(Array.from({ length: 64 }, () => c.u32()), first);
});

test("u32 stays a 32-bit unsigned integer", () => {
  const rng = new Rng(1);
  for (let i = 0; i < 10_000; i += 1) {
    const value = rng.u32();
    assert.ok(Number.isInteger(value), `${value} is not an integer`);
    assert.ok(value >= 0 && value <= 0xffff_ffff, `${value} is out of range`);
  }
});

test("int is inclusive at both ends and covers them", () => {
  const rng = new Rng(7);
  const seen = new Set<number>();
  for (let i = 0; i < 5_000; i += 1) {
    const value = rng.int(3, 7);
    assert.ok(value >= 3 && value <= 7, `${value} escaped [3, 7]`);
    seen.add(value);
  }
  assert.deepEqual([...seen].sort((x, y) => x - y), [3, 4, 5, 6, 7]);
  assert.equal(rng.int(4, 4), 4, "a degenerate range is the value itself");
});

test("shuffled returns a permutation and leaves its input alone", () => {
  const input = Object.freeze(["a", "b", "c", "d", "e"]);
  const rng = new Rng(11);
  const out = rng.shuffled(input);
  assert.deepEqual([...out].sort(), [...input].sort());
  assert.deepEqual(input, ["a", "b", "c", "d", "e"]);
});

test("pick and chance are drawn from the same stream, so nothing is unseeded", () => {
  const a = new Rng(99);
  const b = new Rng(99);
  assert.equal(a.pick(["x", "y", "z"]), b.pick(["x", "y", "z"]));
  assert.equal(a.chance(0.5), b.chance(0.5));
});

test("the generator never reaches the platform's random source", () => {
  // The whole oracle is worthless if one draw is unseeded: cases.json would
  // differ on every run and gate:fuzz's byte-identity check would fail with no
  // explanation. Cheaper to assert on the source than to debug that later.
  //
  // The check is on the raw text, comments included, and that is deliberate:
  // it is the cheapest rule that cannot be worked around, and it costs only
  // that rng.ts must describe the ban without spelling the name. Revision 1 of
  // this plan shipped an implementation whose header comment said the name,
  // so the test caught its own documentation — 5 pass, 1 fail.
  const source = readFileSync(
    fileURLToPath(new URL("../tracks/console-fuzz/benchmark/fuzz/rng.ts", import.meta.url)),
    "utf8",
  );
  assert.ok(!/Math\.random/.test(source), "rng.ts must not use Math.random");
});
