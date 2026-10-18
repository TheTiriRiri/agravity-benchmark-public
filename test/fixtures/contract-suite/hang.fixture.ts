import { test } from "node:test";

test("passes before the hang", () => {});
test("never settles", () => new Promise(() => setInterval(() => {}, 1_000)));
test("never starts", () => {});
