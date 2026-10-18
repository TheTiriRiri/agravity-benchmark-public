// The first beforeEach fails the way `reset()` does on a non-200 answer; the
// later ones pass. One test then fails in its own body.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

let calls = 0;
beforeEach(() => {
  calls += 1;
  assert.equal(calls === 1 ? 500 : 200, 200, "POST /reset must answer 200");
});

test("hook fails before this one", () => {});
test("passes once the hook recovers", () => {});
test("fails in its own body", () => assert.equal(1, 2, "body failure"));
