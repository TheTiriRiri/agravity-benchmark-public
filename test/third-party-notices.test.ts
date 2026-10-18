/**
 * The MIT notice ships twice: `THIRD_PARTY_NOTICES.md` in the repository, and
 * `website/public/THIRD_PARTY_NOTICES.txt` on the published dashboard, whose
 * built code derives from the same software. Astro copies `public/` as-is, so
 * the site's copy is a byte copy, and an edit to one without the other fails here.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the dashboard ships the repository's third-party notice unchanged", () => {
  assert.equal(read("website/public/THIRD_PARTY_NOTICES.txt"), read("THIRD_PARTY_NOTICES.md"));
});

test("every page's footer links the notice", () => {
  assert.match(read("website/src/layouts/Layout.astro"), /href="\/THIRD_PARTY_NOTICES\.txt"/);
});

test("the repository's own LICENSE is the MIT licence package.json declares", () => {
  const pkg = JSON.parse(read("package.json")) as { license?: string };
  assert.equal(pkg.license, "MIT");
  assert.match(read("LICENSE"), /^MIT License\n\nCopyright \(c\) \d{4} \S/);
});
