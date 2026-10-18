// beforeEach waits on a server that accepts the connection and never answers.
// The fetch's DOMException crosses the process boundary with an empty message.
import { beforeEach, test } from "node:test";

beforeEach(async () => {
  await fetch(`${process.env.CONTRACT_BASE_URL}/api/v1/reset`, { method: "POST", signal: AbortSignal.timeout(300) });
});

test("first", () => {});
test("second", () => {});
