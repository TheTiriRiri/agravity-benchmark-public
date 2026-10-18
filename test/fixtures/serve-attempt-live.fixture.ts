/**
 * Not part of `npm test` (not a `*.test.ts`): `test/serve-attempt.test.ts`
 * runs it as its own process, the way the scoring skill runs serve-attempt,
 * with the fake `docker` and the fake `npm` first on the PATH it starts from.
 *
 *   node --import tsx test/fixtures/serve-attempt-live.fixture.ts <root> <attempt>
 *
 * It is `runServe` — the CLI's real handlers, sweep, lock, image lookup,
 * `AttemptBackend`, `ensureNodeModules` and `startVite` — with one dependency
 * replaced: the port check, since a test never probes the real 5100 and 5173.
 * The fakes never bind those either: their servers listen on random ports.
 */
import { runServe } from "../../scripts/serve-attempt";

const [root, attempt] = process.argv.slice(2);
if (root === undefined || attempt === undefined) {
  process.stderr.write("usage: serve-attempt-live.fixture.ts <root> <attempt>\n");
  process.exit(2);
}

await runServe({ attempt, root, ignoreRunJson: true }, { busyPorts: async () => [] });
