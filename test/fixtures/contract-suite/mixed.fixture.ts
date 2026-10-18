import assert from "node:assert/strict";
import { test } from "node:test";

test("passes one", () => {});
test("fails in the middle", () => assert.equal(1, 2));
test("passes two", () => {});
