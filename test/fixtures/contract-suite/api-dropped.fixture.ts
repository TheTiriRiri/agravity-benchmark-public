// The hidden tests' own `reset`, against a server that accepts each connection
// and destroys it at once: a transport error, with no answer to read.
import { beforeEach, test } from "node:test";

import { reset } from "../../../benchmark/contract-tests/api";

beforeEach(reset);

test("reaches the backend", () => {});
