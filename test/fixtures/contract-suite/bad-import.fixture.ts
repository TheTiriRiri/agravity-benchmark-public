// A test file whose import fails before any test is registered.
// @ts-expect-error -- the module is missing on purpose
import { missing } from "./no-such-module";
import { test } from "node:test";

test("never registered", () => {
  void missing;
});
