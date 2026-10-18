/**
 * Not part of `npm test` (not a `*.test.ts`): `test/take-screenshots-processes.test.ts`
 * runs it as its own process, with the fake `docker` and the fake `npm` first
 * on the PATH it starts from and TMPDIR pointing at a fresh directory.
 *
 *   node --import tsx test/fixtures/take-screenshots-live.fixture.ts --root <root> [more take-screenshots arguments]
 *
 * It is take-screenshots' `main` — its real interrupt handlers, dead-owner
 * sweep, serve-attempt check, image lookup, `AttemptBackend`,
 * `ensureNodeModules`, `probeRegistry` and `startVite` — with two dependencies
 * replaced: the port check, since a test never probes the real 5100 and 5173,
 * and the browser, since no test launches Chromium. The fakes never bind those
 * ports either: their servers listen on random ones.
 *
 * The fake browser "photographs" a URL by fetching it and writing what came
 * back, so a PNG proves the dev server answered. Steered by the environment:
 *   FAKE_BROWSER_STATE  a directory; `goto` writes `goto` there when it starts
 *   FAKE_BROWSER_GOTO   ok | hang — `hang` never settles until the browser is
 *                       closed, as a page that never loads would not
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { main, type BrowserLike, type PageLike } from "../../scripts/take-screenshots";

class FakeBrowser implements BrowserLike {
  closed = false;
  private readonly onClose = new Set<() => void>();

  async newPage(): Promise<PageLike> {
    if (this.closed) throw new Error("fake browser: newPage after close");
    let html: string | null = null;
    let body: string | null = null;
    const browser = this;
    return {
      async goto(url: string): Promise<unknown> {
        const state = process.env.FAKE_BROWSER_STATE;
        if (state !== undefined) writeFileSync(join(state, "goto"), `${url}\n`);
        if (process.env.FAKE_BROWSER_GOTO === "hang") {
          await new Promise<never>((_, reject) => {
            browser.onClose.add(() => reject(new Error("fake browser: the browser was closed during goto")));
          });
        }
        const response = await fetch(url);
        body = `${response.status} ${await response.text()}`;
        return null;
      },
      async setContent(content: string): Promise<void> {
        html = content;
      },
      async screenshot(options: { path: string }): Promise<unknown> {
        if (browser.closed) throw new Error("fake browser: screenshot after close");
        writeFileSync(options.path, html !== null ? `card ${html}` : `picture ${body ?? ""}`);
        return null;
      },
      async close(): Promise<void> {},
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const listener of this.onClose) listener();
    this.onClose.clear();
  }
}

process.exitCode = await main(process.argv.slice(2), {
  busyPorts: async () => [],
  launchBrowser: async () => new FakeBrowser(),
});
