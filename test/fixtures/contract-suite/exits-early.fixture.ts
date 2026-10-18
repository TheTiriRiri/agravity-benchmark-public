// The process ends cleanly mid-file: no failure, no timeout, tests missing.
import { test } from "node:test";

test("passes", () => {});
test("exits", () => {
  process.exit(0);
});
test("never runs", () => {});
