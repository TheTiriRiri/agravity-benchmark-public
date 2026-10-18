/**
 * The one value in `.github/workflows/publish.yml` that duplicates a fact
 * living somewhere else.
 *
 * `cloudflare/wrangler-action` declares `wranglerVersion` with no default, so
 * without it the deploy runs whatever wrangler the action happens to resolve —
 * not the one this repo pins and whose `pages deploy` / `pages_build_output_dir`
 * behaviour was checked. Pinning it fixes that and creates a second place to
 * bump: nobody editing `website/package-lock.json` will think to open a
 * workflow, and a mismatch produces no error at all, just a deploy running a
 * wrangler nobody chose.
 *
 * The YAML is parsed, never regexed: a `wranglerVersion` moved to another step,
 * re-indented, or quoted differently should still be found — and a workflow that
 * stops parsing should fail here rather than on a push to `main`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { load as loadYaml } from "js-yaml";

const WORKFLOW = fileURLToPath(new URL("../.github/workflows/publish.yml", import.meta.url));
const WEBSITE_LOCKFILE = fileURLToPath(new URL("../website/package-lock.json", import.meta.url));

interface WorkflowStep {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}

function workflowSteps(): WorkflowStep[] {
  const doc = loadYaml(readFileSync(WORKFLOW, "utf8")) as {
    jobs?: Record<string, { steps?: WorkflowStep[] }>;
  };
  const steps = Object.values(doc.jobs ?? {}).flatMap((job) => job.steps ?? []);
  assert.ok(steps.length > 0, `${WORKFLOW}: parsed, but no job step was found`);
  return steps;
}

function onlyStep(steps: WorkflowStep[], what: string): WorkflowStep {
  assert.equal(steps.length, 1, `${WORKFLOW}: expected exactly one step ${what}, found ${steps.length}`);
  return steps[0];
}

function stepNamed(name: string): WorkflowStep {
  return onlyStep(workflowSteps().filter((step) => step.name === name), `named "${name}"`);
}

function stepWithId(id: string): WorkflowStep {
  return onlyStep(workflowSteps().filter((step) => step.id === id), `with id "${id}"`);
}

/** The wrangler `npm ci` would install in website/. */
function lockedWranglerVersion(): string {
  const lock = JSON.parse(readFileSync(WEBSITE_LOCKFILE, "utf8")) as {
    packages?: Record<string, { version?: string }>;
  };
  const version = lock.packages?.["node_modules/wrangler"]?.version;
  assert.equal(typeof version, "string", `${WEBSITE_LOCKFILE}: no resolved version for node_modules/wrangler`);
  return version as string;
}

test("every third-party action is pinned by commit SHA, not by a movable tag", () => {
  // The deploy step is the only one that sees CLOUDFLARE_API_TOKEN (Pages:
  // Edit), and `cloudflare/wrangler-action@v3` is a tag its owner can move —
  // which makes it a path to that token. GitHub's own hardening guidance is to
  // pin third-party actions to a full commit SHA. `actions/*` is first-party
  // and conventionally left on a major tag.
  const thirdParty = workflowSteps()
    .map((step) => step.uses)
    .filter((uses): uses is string => typeof uses === "string")
    .filter((uses) => !uses.startsWith("actions/"));

  assert.ok(thirdParty.length > 0, `${WORKFLOW}: expected at least the wrangler deploy action`);
  for (const uses of thirdParty) {
    assert.match(
      uses,
      /@[0-9a-f]{40}$/,
      `${WORKFLOW}: ${uses} is a third-party action pinned by tag. A tag can be moved by whoever owns ` +
        "that repository, and this job holds CLOUDFLARE_API_TOKEN — pin it to a full commit SHA and keep " +
        "the version in a trailing comment.",
    );
  }
});

test("the deploy step pins the wrangler that website/package-lock.json resolves", () => {
  const pinned = workflowSteps()
    .map((step) => step.with?.wranglerVersion)
    .filter((version): version is string => typeof version === "string");

  assert.equal(
    pinned.length,
    1,
    `${WORKFLOW}: expected exactly one step to pin wranglerVersion, found ${pinned.length}. ` +
      "wrangler-action has no default, so an unpinned deploy runs whatever it resolves at run time.",
  );

  const locked = lockedWranglerVersion();
  assert.equal(
    pinned[0],
    locked,
    `wranglerVersion drift: ${WORKFLOW} pins ${pinned[0]}, but ${WEBSITE_LOCKFILE} resolves ` +
      `wrangler ${locked}. Update the workflow's wranglerVersion to ${locked} — the deploy would ` +
      "otherwise run a different wrangler than the one this repo installs and tests against.",
  );
});

test("the deploy step runs only when both Cloudflare secrets are set", () => {
  const check = stepWithId("cloudflare");
  assert.equal(check.env?.HAS_CREDENTIALS, "${{ secrets.CLOUDFLARE_API_TOKEN != '' && secrets.CLOUDFLARE_ACCOUNT_ID != '' }}");
  assert.equal(check.run?.trim(), 'echo "deploy=$HAS_CREDENTIALS" >> "$GITHUB_OUTPUT"');
  assert.equal(stepNamed("Deploy to Cloudflare Pages").if, "steps.cloudflare.outputs.deploy == 'true'");
});

test("the test step demands the term list only when the repository asks for it", () => {
  const step = stepNamed("Test");
  assert.equal(step.env?.CONFIDENTIAL_TERMS, "${{ secrets.CONFIDENTIAL_TERMS }}");
  assert.equal(step.env?.REQUIRE_CONFIDENTIAL_TERMS, "${{ vars.REQUIRE_CONFIDENTIAL_TERMS }}");
});
