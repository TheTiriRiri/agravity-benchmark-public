# Cloudflare Pages Deployment

The dashboard is a static Astro build. `.github/workflows/publish.yml` can
deploy it to Cloudflare Pages; until you configure that, the workflow builds
and tests everything and skips the deploy.

## Deploying your own copy

1. **Pick a project name.** The repository uses `agrav-bench`. A Pages project
   name is global to `*.pages.dev`, so a fork usually needs its own. Put it in
   all of these places:
   - `website/wrangler.toml`: `name`;
   - `.github/workflows/publish.yml`: `--project-name=` on the deploy step;
   - `website/astro.config.mjs`: `site` (`https://<name>.pages.dev`, or your
     own domain);
   - `website/public/robots.txt` and `website/public/sitemap.xml`, which
     hard-code the origin.

2. **Create the project, naming the production branch explicitly:**

   ```bash
   cd website
   npx wrangler pages project create <name> --production-branch main
   ```

   Without `--production-branch`, `wrangler` reads the branch you happen to be
   standing on (`git rev-parse --abbrev-ref HEAD`), and falls back to the
   literal `production` when it cannot tell. Create the project from a feature
   branch, and every CI deploy from `main` lands as a *preview* at a hashed URL
   while `<name>.pages.dev` stays empty. **The workflow stays green the whole
   time**, so nothing tells you. You can fix it afterwards in the Pages
   dashboard (Settings → Builds & deployments → production branch).

3. **Add two repository secrets** (Settings → Secrets and variables → Actions):
   - `CLOUDFLARE_API_TOKEN`: a token with the *Cloudflare Pages: Edit*
     permission;
   - `CLOUDFLARE_ACCOUNT_ID`: the account holding the Pages project.

   With both set, the workflow's last step deploys. Without either, the step
   is skipped.

## The forbidden-term scan in CI

`test/confidentiality.test.ts` scans tracked files and the whole git history
for secret-shaped tokens. It also scans for a list of forbidden terms, if you
give it one. Locally the list is the gitignored `.confidential-terms` at the
repository root; in CI it is the `CONFIDENTIAL_TERMS` secret.

**Format.** One term per line. Blank lines and lines starting with `#` are
skipped, and a term shorter than 3 characters is refused.

**What matches.**
- A term matches at the start of a word, in any case.
- The words of a multi-word term may be run together or joined by spaces,
  `_`, `-` or `.`: `Zebra Widget` also finds `zebra_widget`, `zebra-widget`,
  `zebra.widget` and `zebraWidget`.
- A term inside a longer run of letters and digits is not a finding (a base64
  hash, `myzebrawidget`).
- A different *spelling* of a name (an abbreviation, a translation) needs its
  own line.

**What it covers.** Tracked files, the content of every blob reachable from
any ref, every path any commit recorded (both sides of a rename), commit
messages, author and committer identity, and every ref's name, tagger and
message. Binary files are outside it.

**Without a list,** the test warns and scans for secrets only. To make a
missing list fail the build instead, set the repository **variable**
`REQUIRE_CONFIDENTIAL_TERMS` to `true`.

## What the workflow runs

It runs on every push to `main`, and on demand from the Actions tab. In order:
1. `npm ci`;
2. `npm run typecheck`;
3. `npm test`;
4. a check that no tracked website file fetches the spec files from GitHub at
   build time;
5. `eslint src/`;
6. the build;
7. the deploy, if the credentials are set.

A red test suite stops a publish. The wrangler the deploy uses is pinned on
the action (`wranglerVersion`), and a test keeps it equal to the one in
`website/package-lock.json`.

It never runs the benchmark matrix and never takes screenshots: both need
things a runner does not have. It never commits anything back either.
`npm run build` regenerates `src/data/results.json` and
`public/api/leaderboard.json` with a fresh `generatedAt` on every run, so CI's
checkout is always dirtier than `HEAD` by those timestamp lines. That copy is
deployed and thrown away with the runner.

## Build

```bash
npm run build                 # from the repo root: process-results, then astro build
cd website && npm run build   # website only, against the committed results.json
```

The build reads `website/src/data/results.json`, written by
`scripts/process-results.ts`. The file is committed, including in its empty
(`totalAttempts: 0`) state, so the site builds before the first benchmark run.

Nothing is fetched over the network at build time: `benchmark.astro` reads this
repository's `prompt.md` and `benchmark/criteria.md` off disk.

## Local deployment

```bash
cd website
npm run deploy         # astro build && wrangler pages deploy dist
```

This needs a Cloudflare API token with Pages permissions in the environment
(`CLOUDFLARE_API_TOKEN`), and an existing Pages project with the name in
`wrangler.toml`.

## Placeholder assets

`public/favicon.*`, `public/apple-touch-icon.png` and `public/og.png` are
neutral placeholders: three bars on the dashboard's slate background. Replace
them before publishing anywhere public.
