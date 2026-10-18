/**
 * take-screenshots — one 1280x720 picture of every attempt's app, a filmstrip
 * per configuration, and a content-hash manifest for cache busting.
 *
 *   npm run screenshots -- [--only <id>]... [--force] [--install-timeout <d>] [--root <path>]
 *
 * Per attempt, one at a time, in the order spec §5 fixes: the attempt's backend
 * in the harness image through `scripts/lib/attempt-backend.ts`, published on
 * 127.0.0.1:5100; then `npm install` and `npm run dev` in `<attempt>/frontend`
 * on the host through `scripts/lib/dev-server.ts` — port 5173 by the run
 * contract, whose dev-server proxy sends `/api` to localhost:5100; then a
 * Playwright screenshot of the dev server's `/`, written to
 * `website/public/screenshots/<id>-attempt-<n>.png`. Then one
 * `<id>_filmstrip.png` per benchmark id, and
 * `website/src/data/screenshot-hashes.json` — which `index.astro` imports at
 * build time and the cards append as `?v=<hash>`.
 *
 * This runs **out of band and locally**: it needs Docker and the harness image,
 * a browser, a dependency install per attempt and tens of minutes. Its output is
 * committed, and CI only serves it. Nothing here talks to `agy` or spends quota.
 * The image is this repository's `benchmark/runner.yaml` `image`
 * (`readScoringImage`, never one under `--root`), resolved to its Id only when
 * the first backend is about to start, and every backend of the run runs by that
 * Id: a run that serves nothing needs no Docker, and a retag mid-run changes
 * nothing.
 *
 * The server half is built for attempts that are a Vite SPA in `frontend/` over
 * a Python backend in `backend/`. The choices the script makes, and why:
 *
 * 1. Attempt directory names are parsed with `scripts/lib/attempts.ts` rather
 *    than `name.includes("-attempt-")` plus a local `/-attempt-\d+$/`, so the
 *    filmstrip's grouping key is the same benchmark id `process-results.ts`
 *    publishes as `modelBaseId`. A filmstrip is per **(model, effort)**, never
 *    per family — `FamilyGroupCard.tsx` passes `filmstrip={false}` for family
 *    rows precisely because none exists.
 * 2. An attempt whose `eval-results/<dir>/run.json` records
 *    `failureKind: "infra"` is skipped. That run says nothing about a model and
 *    is due to be re-run; picturing it would put a tile on the dashboard for a
 *    row `process-results.ts` deliberately drops. One recording `"model"` — the
 *    run timed out or crashed — keeps its tile but starts nothing and gets a
 *    "Model Failure" card: the rubric scores it 0 whatever is on disk (spec §4),
 *    and a picture of a half-built app beside that zero would contradict it.
 * 3. With nothing to capture, every filmstrip matching the PNGs behind it and
 *    the manifest already current, the script returns before launching anything
 *    — no browser, no container, no dev server, no `npm install`, no directory
 *    created. The empty repo is the normal state until the matrix has run, and
 *    a second run in a row is free. A filmstrip is stale when the *set*
 *    of PNGs behind it stopped matching the set the manifest recorded — never an
 *    mtime, which git would reset on every checkout.
 * 4. The frontend is where the run contract puts it, `<attempt>/frontend`. No
 *    `frontend/package.json` is a frontend stop — an error card, with no backend
 *    started — rather than a silent exclusion, so the "every attempt always has
 *    an image" property still holds.
 * 5. One attempt at a time, on fixed ports. The model's dev-server proxy pins
 *    the backend to localhost:5100, so two attempts cannot be served at once,
 *    and there is no `--concurrency`. Before Chromium starts, and only when some
 *    attempt is going to be served, the run removes what dead owners left behind
 *    (`sweepDeadOwners`), refuses while `serve-attempt`'s state file names a
 *    live owner, and refuses while 5100 or 5173 is taken — with a message and
 *    exit 1, never an error card: a card is sticky (below), and it would blame
 *    every attempt for a port some other process held. take-screenshots holds
 *    no lock of its own, so the same check runs again before every later
 *    attempt that serves: a serve-attempt or a second take-screenshots started
 *    between two captures stops the run as an infra fault rather than sharing
 *    the ports unseen. That check comes minutes before the ports are bound —
 *    the backend's install precedes its `docker run`, the frontend's `npm
 *    install` precedes Vite's bind — and a serve-attempt under another
 *    `--root` writes a state file this run never reads. So a port whose holder
 *    decides the picture is asked again: 5173 when the dev server did not get
 *    it (it served on another port, or not at all), and 5100 after a backend
 *    stop, right before the page loads, since whatever answers there would be
 *    photographed as this attempt's data. Held by something else, either is
 *    infra, not a port warning, a card or a picture; a collision at the
 *    backend's own bind is Docker's "port is already allocated", infra too.
 *    What stays open is a holder that binds after those checks — closed only
 *    by a serving lock both tools take, whatever their roots.
 * 6. Whose failure it is decides what is written (spec §4 and §5):
 *    - a **backend stop** (`layout`, `install`, `boot`, `health`) is warned
 *      about, and the frontend is photographed without data — which is how §4
 *      judges `Consistent UI` and `Responsive design` for such an attempt;
 *    - a **frontend stop** gets an error card: no `frontend/package.json`, an
 *      `npm install` that fails or times out while the registry still answers
 *      `npm ping` (Ruling R23 as amended), an `npm run dev` that does not serve
 *      after one retry, or a page that does not load;
 *    - an **infra fault** — Docker or the image, a backend install PyPI could
 *      not be reached for, an `npm install` with the registry unreachable or
 *      ended by a signal the harness did not send, a port taken by something
 *      else after the attempt's check (item 5), a container whose removal
 *      cannot be verified, a dev server that outlives SIGKILL, a browser that
 *      cannot open a page, a harness step that throws instead of answering —
 *      stops the run with exit 1 and writes no card for that attempt: a
 *      harness fault must not become a tile that blames the model. A
 *      frontend `npm install` that did not finish, for whatever reason, has
 *      the `node_modules` it created removed again, so the next run installs
 *      afresh instead of serving a half-built tree.
 * 7. `page.goto` waits for `load`, not `networkidle`, and a 2 s
 *    settle follows (Ruling R19). The SPA asks `/api` for its data after
 *    `load`, through the dev server's proxy, and the settle is what lets that
 *    data render; an app that polls its API often enough never goes idle, and
 *    `networkidle` would then fail an app that renders fine. Only `/` is
 *    photographed.
 * 8. A dev server is only believed once its `Local:` banner names a URL that
 *    answers HTTP (`startVite`), and a port other than the run contract's 5173
 *    is photographed but warned about — once 5173 is found free (item 5): the
 *    picture is still this attempt's, since the page loads the URL its own
 *    banner named.
 * 9. A run in which every attempt it tried to picture failed exits 1. Some
 *    failing is a result; all of them failing is a broken environment. A
 *    model-failure card is neither, and does not count.
 * 10. The frontend's `npm install` has a deadline, the rubric's
 *    (`LIMITS.npmInstallMs`), which `--install-timeout` overrides for capture
 *    only: an install that never finishes would otherwise hang the whole run.
 * 11. Ruling R26: nothing started here may outlive the function that started
 *    it, on any path. The page is closed in a `finally`; the dev server's
 *    process group is killed and waited for; the backend's containers are
 *    removed and their removal verified before its scratch directory goes. A
 *    signal (`installInterruptHandlers`) aborts a dev server still starting,
 *    closes the browser, stops every process group and every backend, removes
 *    a `node_modules` an interrupted install left, and waits for all of that
 *    before the process exits; only a second signal exits at once, after a
 *    synchronous `docker rm -f` of every registered container and a SIGKILL of
 *    every tracked process group, and with a warning naming each unfinished
 *    install's `node_modules` still there — it may be partly deleted, and the
 *    next run would take it for installed. Chromium is launched without
 *    Playwright's own signal handlers (`CHROMIUM_LAUNCH_OPTIONS`): its SIGINT
 *    one would otherwise exit 130 the moment the browser closed, before any
 *    of this.
 *
 * Re-capturing: an existing PNG is left alone — an error card is a PNG, so a
 * failed capture would otherwise be permanent. `--force` re-captures the
 * selected attempts, and `--only <id>` selects one configuration, so
 * `--force --only <id>` retries one broken configuration rather than all of
 * them. Deleting `website/public/screenshots/<id>-attempt-<n>.png` re-captures
 * just that one attempt. Either way the affected filmstrips are rebuilt.
 */

import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type LaunchOptions } from "playwright";

import { AGENT_NAMES, DISABLED_MODELS, isModelId } from "../eval-attempts/metadata";
import {
  AttemptBackend,
  BACKEND_ROLE,
  stopAllBackends,
  stopAllBackendsSync,
  type BackendOptions,
  type ContainerRemoval,
} from "./lib/attempt-backend";
import { MAX_ATTEMPTS_PER_CONFIG, parseAttemptDirName } from "./lib/attempts";
import {
  busyPorts,
  DevServerError,
  ensureNodeModules,
  groupAlive,
  InstallKilledError,
  killAllProcessesSync,
  killAndWait,
  probeRegistry,
  startVite,
  stopAllProcesses,
  type StartViteOptions,
  type ViteServer,
} from "./lib/dev-server";
import { resolveImageId, sweepDeadOwners, type SweepResult } from "./lib/docker";
import {
  INTERRUPT_EXIT_CODES,
  installInterruptHandlers,
  type InterruptHandlers,
  type InterruptHooks,
  type InterruptSignal,
} from "./lib/interrupt";
import { LIMITS } from "./lib/rubric";
import { readRunJson } from "./lib/run-json";
import { parseDurationMs, readScoringImage } from "./lib/runner-config";
import { BACKEND_PORT, FRONTEND_PORT, isServeOwnerLive, readServeState, statePath, stopCommand, type ServeState } from "./serve-attempt";

/**
 * Where `eval-attempts/`, `eval-results/` and `website/` live unless `--root`
 * says otherwise — and, whatever `--root` says, where `benchmark/runner.yaml`
 * (the image) is read from.
 */
const DEFAULT_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Ruling R19: how long after `load` the page is left to fetch and render its data. */
const SCREENSHOT_DELAY_MS = 2000;
const PAGE_LOAD_TIMEOUT_MS = 30_000;
/** How long to wait for the page to render non-empty body content before capturing. */
const CONTENT_RENDER_TIMEOUT_MS = 20_000;
/** How many page events a blank-page warning carries, and how long each one may be. */
const PAGE_EVENTS_MAX = 10;
const PAGE_EVENT_MAX_CHARS = 200;

const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 720;
const VIEWPORT = { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT };

/** Suffix that marks a filmstrip, so it is never mistaken for an attempt tile. */
const FILMSTRIP_SUFFIX = "_filmstrip.png";

export interface RepoPaths {
  attemptsDir: string;
  resultsDir: string;
  screenshotsDir: string;
  hashManifestPath: string;
}

/** The four paths this script reads and writes, relative to a repo root. */
export function repoPaths(root: string, track: "classic" | "hard" | "brownfield" = "classic"): RepoPaths {
  const trackSubdir = track === "classic" ? undefined : track === "hard" ? "console-hard" : "brownfield";
  return {
    attemptsDir: trackSubdir ? join(root, "tracks", trackSubdir, "eval-attempts") : join(root, "eval-attempts"),
    resultsDir: trackSubdir ? join(root, "tracks", trackSubdir, "eval-results") : join(root, "eval-results"),
    screenshotsDir:
      track === "classic"
        ? join(root, "website", "public", "screenshots")
        : join(root, "website", "public", "screenshots", track),
    hashManifestPath:
      track === "classic"
        ? join(root, "website", "src", "data", "screenshot-hashes.json")
        : join(root, "website", "src", "data", `screenshot-hashes-${track}.json`),
  };
}

// --- naming -----------------------------------------------------------------
//
// Both names are manifest keys, and the manifest is keyed by **bare filename**:
// `ResultCard.tsx` looks up `${attempt.id}.png` and `ModelAveragesCard.tsx`
// `${average.modelBaseId}_filmstrip.png`. A manifest keyed by path would find
// nothing and silently disable cache busting without failing anything.

/** `gemini-38-flash-low-attempt-1` → `gemini-38-flash-low-attempt-1.png`. */
export function screenshotFileName(dirName: string): string {
  return `${dirName}.png`;
}

/** `gemini-38-flash-low` → `gemini-38-flash-low_filmstrip.png`. */
export function filmstripFileName(benchmarkId: string): string {
  return `${benchmarkId}${FILMSTRIP_SUFFIX}`;
}

// --- discovery ---------------------------------------------------------------

export interface AttemptInfo {
  /** The attempt directory name, e.g. `gemini-38-flash-low-attempt-1`. */
  dirName: string;
  /** The benchmark id — effort suffix included. */
  benchmarkId: string;
  attempt: number;
  /** `<root>/eval-attempts/<dirName>`, which the backend's containers mount read-only. */
  attemptDir: string;
  /**
   * `<attempt>/frontend`, where the run contract puts the SPA and where `npm
   * run dev` runs. `null` when it holds no `package.json`: a frontend stop — an
   * error card, and no backend started — rather than a reason to leave the
   * attempt out.
   */
  frontendRoot: string | null;
  /**
   * `run.json` records `failureKind: "model"`: the attempt scores 0 whatever is
   * on disk, so it gets a "Model Failure" card and nothing is started for it.
   */
  modelFailure: boolean;
}

/**
 * `<attemptDir>/frontend` when it holds a `package.json` (a file), else `null`.
 *
 * The run contract pins the layout, so this is a lookup, not a search: a
 * frontend anywhere else is not where the contract says, and the scoring skill
 * reads the same directory, so the picture and the score always come from one
 * place.
 */
export function frontendRootOf(attemptDir: string): string | null {
  const frontend = join(attemptDir, "frontend");
  try {
    return statSync(join(frontend, "package.json")).isFile() ? frontend : null;
  } catch {
    return null;
  }
}

/**
 * Every attempt worth picturing, in directory-name order.
 *
 * Two exclusions, and both exist to keep this side of the seam agreeing with
 * `process-results.ts`:
 *
 * - an attempt whose `run.json` records an infrastructure failure, which that
 *   script drops from the dashboard, so a tile for it would point at a row that
 *   is not there;
 * - every attempt of a `DISABLED_MODELS` id, which it drops for the same reason.
 *   Without this the disabled configuration is still installed, served,
 *   photographed and hashed into the manifest — minutes of work per attempt, and
 *   a filmstrip for a family the dashboard does not show.
 *
 * Neither exclusion deletes a PNG that already exists. A disabled id keeps its
 * pictures (re-enabling it should not mean re-capturing), which is why the
 * warning names the directory to delete rather than deleting it.
 */
export function discoverAttempts(
  root: string,
  warn: (message: string) => void = console.warn,
  track: "classic" | "hard" | "brownfield" = "classic",
): AttemptInfo[] {
  const paths = repoPaths(root, track);
  if (!existsSync(paths.attemptsDir)) return [];

  const attempts: AttemptInfo[] = [];
  const disabledSeen = new Set<string>();
  for (const entry of readdirSync(paths.attemptsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const parsed = parseAttemptDirName(entry.name);
    if (parsed === null) {
      warn(
        `warning: ignoring ${join(paths.attemptsDir, entry.name)} — not an attempt directory name ` +
          "(expected <id>-attempt-<n>, lowercase, no underscores).",
      );
      continue;
    }
    if (DISABLED_MODELS.has(parsed.modelId)) {
      // Once per id, not once per attempt: five identical lines say no more
      // than one, and this is a deliberate operator action, not a surprise.
      if (!disabledSeen.has(parsed.modelId)) {
        disabledSeen.add(parsed.modelId);
        warn(
          `warning: skipping every attempt of "${parsed.modelId}" — it is in DISABLED_MODELS ` +
            "(eval-attempts/metadata.ts), so process-results.ts leaves it off the dashboard too. " +
            `Any ${parsed.modelId}-attempt-*.png already in website/public/screenshots/ is left alone; ` +
            "delete those by hand if the configuration is gone for good.",
        );
      }
      continue;
    }
    const failureKind = recordedFailureKind(paths.resultsDir, entry.name, warn);
    if (failureKind === "infra") continue;
    if (!isModelId(parsed.modelId)) {
      warn(
        `warning: ${entry.name} — "${parsed.modelId}" is not a known benchmark id. Capturing it anyway; ` +
          "add it to eval-attempts/metadata.ts and benchmark/runner.yaml, or remove the directory.",
      );
    }
    const attemptDir = join(paths.attemptsDir, entry.name);
    attempts.push({
      dirName: entry.name,
      benchmarkId: parsed.modelId,
      attempt: parsed.attempt,
      attemptDir,
      frontendRoot: frontendRootOf(attemptDir),
      modelFailure: failureKind === "model",
    });
  }

  return attempts.sort((a, b) => a.dirName.localeCompare(b.dirName));
}

/**
 * The `failureKind` this attempt's `run.json` records — `null` for a clean run,
 * no `run.json`, or one that cannot be read. An `infra` one is announced here,
 * since the caller then leaves the attempt out.
 */
function recordedFailureKind(
  resultsDir: string,
  dirName: string,
  warn: (message: string) => void,
): "infra" | "model" | null {
  const runJsonPath = join(resultsDir, dirName, "run.json");
  if (!existsSync(runJsonPath)) return null;
  let failureKind;
  try {
    failureKind = readRunJson(runJsonPath).failureKind;
  } catch (error) {
    // Malformed metadata is a reason to look at the file, not to drop a
    // capture: the attempt directory may still hold a perfectly good app.
    warn(`warning: ${(error as Error).message}; capturing ${dirName} anyway.`);
    return null;
  }
  if (failureKind !== "infra") return failureKind;
  // Same wording as process-results.ts, which drops the attempt for the same
  // reason — the two skips should read as one decision, not two coincidences.
  warn(`warning: skipping ${dirName} — run.json records an infrastructure failure, not a data point.`);
  return "infra";
}

/** Attempt ids that already have a screenshot; filmstrips are not attempts. */
export function getExistingScreenshots(screenshotsDir: string): Set<string> {
  if (!existsSync(screenshotsDir)) return new Set();
  return new Set(
    readdirSync(screenshotsDir)
      .filter((file) => file.endsWith(".png") && !file.endsWith(FILMSTRIP_SUFFIX))
      .map((file) => file.replace(/\.png$/, "")),
  );
}

/** The display name for a benchmark id, or the raw id when it is not a known one. */
function displayName(benchmarkId: string): string {
  return isModelId(benchmarkId) ? AGENT_NAMES[benchmarkId] : benchmarkId;
}

// --- the server half and the capture ------------------------------------------
//
// Everything that starts something lives in the libraries: the backend's
// containers in `scripts/lib/attempt-backend.ts`, the frontend's `npm install`,
// dev server and process groups in `scripts/lib/dev-server.ts`, both shared
// with `serve-attempt`. This section decides the order, whose failure a
// failure is, and what — if anything — is written for it.

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** How long each navigation step in `prepareView` waits. */
const PREPARE_VIEW_STEP_MS = 5_000;
/** How long `prepareView` waits for the initial Schedule navigation step. */
const PREPARE_VIEW_SCHEDULE_MS = 15_000;
/** How long `prepareView` waits for the POST /plan response. */
const PREPARE_VIEW_PLAN_MS = 30_000;
/** Settle after an API response before the next interaction (React re-render). */
const PREPARE_VIEW_SETTLE_MS = 1_000;

/** What `prepareView` reads of a Playwright `Response`. */
export interface ResponseLike {
  url(): string;
  request(): { method(): string };
}

/**
 * Whether `response` answers the plan request Generate Plan sends: a POST whose
 * path ends in `/api/v1/plan`. Matching the method and the path, not a
 * substring, keeps a GET or a Vite module URL with `/plan` in it from ending
 * the wait early.
 */
export function isPlanResponse(response: ResponseLike): boolean {
  if (response.request().method() !== "POST") return false;
  try {
    return new URL(response.url()).pathname.replace(/\/+$/, "").endsWith("/api/v1/plan");
  } catch {
    return false;
  }
}

/**
 * Navigate the page to the view that should be photographed for a given track.
 *
 * - **classic / hard**: no-op — the default `/` (Executive Dashboard) is what
 *   the rubric scores.
 * - **brownfield**: the Schedule view, with the Balanced strategy selected (if
 *   the toggle exists) and a generated plan. The steps that change the view are
 *   stateful navigation inside `App.tsx`, not URL routes, so they cannot be
 *   reached with a `page.goto`.
 *
 * Every step is bounded by a timeout. When an element is missing or a click
 * fails, a warning is logged and the screenshot is taken of whatever is on
 * screen — the run is never interrupted. A step that fails this way appends
 * `pageEvents`' account (`watchPageEvents`) to its warning; the optional
 * Balanced toggle's absence does not.
 */
export async function prepareView(
  track: "classic" | "hard" | "brownfield" | undefined,
  page: PageLike,
  warn: (line: string) => void,
  attemptName?: string,
  settle: (ms: number) => Promise<void> = sleep,
  pageEvents: () => string | null = () => null,
): Promise<void> {
  if (track !== "brownfield") return;
  if (page.click === undefined || page.waitForSelector === undefined || page.waitForResponse === undefined) {
    warn(`  ! prepareView(brownfield): page does not support click/waitForSelector/waitForResponse; photographing the default view`);
    return;
  }
  const label = attemptName ? `${attemptName}: ` : "";
  const stuck = (line: string): void => warn(line + pageEventsTail(pageEvents()));

  // Step 1: click the "Schedule" navigation button (exact match to avoid
  // hitting "Scheduled" or similar substrings).
  try {
    await page.click('text="Schedule"', { timeout: PREPARE_VIEW_SCHEDULE_MS });
  } catch {
    stuck(`  ! ${label}prepareView: could not click "Schedule" navigation — photographing the current view`);
    return;
  }

  // Step 2: wait for the ScheduleView to finish its initial data load. The
  // component renders a loading spinner until loadData() completes; once it
  // does, the "Generate Plan" button appears. Waiting for that button ensures
  // the strategy toggle is mounted and won't be reset by a re-render.
  try {
    await page.waitForSelector('text=/generate plan/i', { timeout: PREPARE_VIEW_STEP_MS });
  } catch {
    stuck(`  ! ${label}prepareView: "Generate Plan" button did not appear after navigating to Schedule — photographing the current view`);
    return;
  }
  await settle(PREPARE_VIEW_SETTLE_MS);

  // Step 3: if a "Balanced" button/toggle exists, click it. This is done
  // AFTER the view has loaded, so the React state is stable.
  try {
    await page.click('text=/balanced/i', { timeout: PREPARE_VIEW_STEP_MS });
  } catch {
    // Not an error: the toggle is optional UI.
    warn(`  ! ${label}prepareView: no "Balanced" button found (optional) — continuing`);
  }

  // Step 4: arm a listener for the POST /plan response BEFORE clicking
  // "Generate Plan", then click. This ensures we catch the response even if
  // it arrives before the next await.
  try {
    const responsePromise = page.waitForResponse(isPlanResponse, { timeout: PREPARE_VIEW_PLAN_MS });
    await page.click('text=/generate plan/i', { timeout: PREPARE_VIEW_STEP_MS });
    await responsePromise;
  } catch {
    stuck(`  ! ${label}prepareView: Generate Plan did not complete — photographing the current view`);
    return;
  }

  // Step 5: after the POST response, the view reloads data (loadData) and
  // React re-renders. Wait for the button text to return to "Generate Plan"
  // (it shows "Optimizing Schedule…" while planning), then settle.
  try {
    await page.waitForSelector('text=/generate plan/i', { timeout: PREPARE_VIEW_STEP_MS });
  } catch {
    stuck(`  ! ${label}prepareView: view did not settle after planning — photographing anyway`);
  }
  await settle(PREPARE_VIEW_SETTLE_MS);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One line, at most `max` characters, for the run log. */
function brief(text: string, max = 200): string {
  const flat = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" / ");
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/**
 * A harness fault: nothing about it is the model's. The run stops, exits 1, and
 * writes no card for the attempt — an error card is sticky, so one written for
 * a fault would go on blaming the model after the fault is fixed.
 */
export class InfraError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InfraError";
  }
}

/** A signal arrived while an attempt was being captured: nothing more is written for it. */
export class CaptureInterrupted extends Error {
  readonly signal: InterruptSignal;
  constructor(signal: InterruptSignal) {
    super(`interrupted by ${signal}`);
    this.name = "CaptureInterrupted";
    this.signal = signal;
  }
}

/** What a capture needs of a Playwright page; a `Page` is one. */
export interface PageLike {
  goto(url: string, options: { waitUntil: "load"; timeout: number }): Promise<unknown>;
  setContent(html: string): Promise<void>;
  screenshot(options: { path: string }): Promise<unknown>;
  close(): Promise<void>;
  /**
   * Wait until `pageFunction` returns a truthy value in the page context.
   * Playwright's `page.waitForFunction` is one; its second parameter is the
   * argument passed to `pageFunction`, so the options come third. Used before
   * taking a screenshot (on all tracks) to ensure the SPA has rendered
   * non-empty body content.
   */
  waitForFunction?(pageFunction: (() => boolean) | string, arg?: unknown, options?: { timeout?: number }): Promise<unknown>;
  /**
   * Click an element matching `selector`. Playwright's `page.click` is one.
   * Only needed by `prepareView` for the brownfield track; classic and hard
   * never call it.
   */
  click?(selector: string, options?: { timeout?: number }): Promise<void>;
  /**
   * Wait for an element matching `selector` to appear. Playwright's
   * `page.waitForSelector` is one. Used by `prepareView` to know when the
   * Schedule view has finished its initial data load (the "Generate Plan"
   * button becomes visible).
   */
  waitForSelector?(selector: string, options?: { timeout?: number }): Promise<unknown>;
  /**
   * Arm a response listener that resolves when a matching response arrives.
   * Playwright's `page.waitForResponse` is one; `prepareView` always passes
   * `isPlanResponse`.
   */
  waitForResponse?(predicate: (response: ResponseLike) => boolean, options?: { timeout?: number }): Promise<unknown>;
  /**
   * Reload the page. Playwright's `page.reload` is one. Used once, when the
   * page is still blank after `CONTENT_RENDER_TIMEOUT_MS`.
   */
  reload?(options: { waitUntil: "load"; timeout: number }): Promise<unknown>;
  /**
   * Subscribe to a page event. Playwright's `page.on` is one. Only the four
   * events `watchPageEvents` reports are typed; without it the blank-page
   * warnings carry no page events.
   */
  on?(event: "console", listener: (message: ConsoleMessageLike) => void): unknown;
  on?(event: "pageerror", listener: (error: Error) => void): unknown;
  on?(event: "requestfailed", listener: (request: FailedRequestLike) => void): unknown;
  on?(event: "response", listener: (response: StatusResponseLike) => void): unknown;
}

/** What `watchPageEvents` reads of a Playwright `ConsoleMessage`. */
export interface ConsoleMessageLike {
  type(): string;
  text(): string;
}

/** What `watchPageEvents` reads of a Playwright `Request` that failed. */
export interface FailedRequestLike {
  url(): string;
  failure(): { errorText: string } | null;
}

/** What `watchPageEvents` reads of a Playwright `Response`. */
export interface StatusResponseLike {
  url(): string;
  status(): number;
}

/**
 * Record what a blank page would explain itself with: console errors and
 * warnings, uncaught exceptions, failed requests and HTTP responses of 400 or
 * more — at most `PAGE_EVENTS_MAX` of them, each cut to `PAGE_EVENT_MAX_CHARS`.
 * Returns the account so far: `"none"` when nothing was recorded, or `null`
 * when the page cannot be listened to (no `on`), so a warning never claims
 * "none" for events nobody collected.
 */
export function watchPageEvents(page: PageLike): () => string | null {
  if (page.on === undefined) return () => null;
  const events: string[] = [];
  let dropped = 0;
  const record = (line: string): void => {
    if (events.length < PAGE_EVENTS_MAX) events.push(brief(line, PAGE_EVENT_MAX_CHARS));
    else dropped += 1;
  };
  page.on("console", (consoleMessage) => {
    const type = consoleMessage.type();
    if (type === "error" || type === "warning") record(`console ${type}: ${consoleMessage.text()}`);
  });
  page.on("pageerror", (error) => record(`pageerror: ${message(error)}`));
  page.on("requestfailed", (request) => record(`requestfailed ${request.url()}: ${request.failure()?.errorText ?? "unknown error"}`));
  page.on("response", (response) => {
    const status = response.status();
    if (status >= 400) record(`HTTP ${status} ${response.url()}`);
  });
  return () => {
    if (events.length === 0) return "none";
    return events.join("; ") + (dropped === 0 ? "" : `; …and ${dropped} more`);
  };
}

/** The `; page events: …` tail of a blank-page warning, or nothing when none were collected. */
function pageEventsTail(account: string | null): string {
  return account === null ? "" : `; page events: ${account}`;
}

/** What a capture needs of a Playwright browser; a `Browser` is one. */
export interface BrowserLike {
  newPage(options: { viewport: { width: number; height: number } }): Promise<PageLike>;
  close(): Promise<void>;
}

/** What a capture needs of a backend; `AttemptBackend` is one. */
export type CaptureBackend = Pick<AttemptBackend, "checkLayout" | "install" | "start" | "stop" | "dispose">;

export interface CaptureDeps {
  screenshotsDir: string;
  /** Which track is being captured; brownfield gets extra navigation steps. */
  track?: "classic" | "hard" | "brownfield";
  /** The frontend's `npm install` budget: the rubric's, or `--install-timeout`'s. */
  installTimeoutMs: number;
  /**
   * The harness image: `ref` as `<tag>@<Id>`, and the bare `id` every backend
   * runs by (`resolveImageId`). Called only once a backend is about to start;
   * `main` memoises it.
   */
  image: () => { ref: string; id: string };
  /** Given the bare image Id and `hostPort: 5100`. */
  createBackend: (options: BackendOptions) => CaptureBackend;
  ensureNodeModules: (frontendRoot: string, timeoutMs: number, timeoutHint?: string) => Promise<void>;
  /** `npm ping`, asked only after a failed or timed-out `npm install`. */
  probeRegistry: () => Promise<boolean>;
  startVite: (frontendRoot: string, options: StartViteOptions) => Promise<ViteServer>;
  /**
   * The ports of `ports` something holds: 5173 once the dev server missed it,
   * 5100 after a backend stop. `main` passes its own. Tests never probe the
   * real ports.
   */
  busyPorts: (ports: number[]) => Promise<number[]>;
  /** Kill the dev server's process group and wait; resolves to whether the group is gone. */
  stopVite: (proc: ChildProcess) => Promise<boolean>;
  /** The settle after `load` (Ruling R19). */
  sleep: (ms: number) => Promise<void>;
  /** The signal that interrupted the run, or `null`. Checked between steps and before anything is written. */
  interrupted: () => InterruptSignal | null;
  /** Aborted by a signal's cleanup, so `startVite` starts no further try. */
  signal?: AbortSignal;
  log: (line: string) => void;
  warn: (line: string) => void;
}

export type CaptureResult =
  /** A screenshot of the app; `warnings` holds a backend stop or a port other than 5173. */
  | { kind: "pictured"; warnings: string[] }
  /** An error card: a frontend stop, or a page that would not load or photograph. */
  | { kind: "card"; error: string; warnings: string[] }
  /** A "Model Failure" card; nothing was started. */
  | { kind: "model-failure" };

/**
 * `resolveImage` on the first call, and that same answer on every call after, so
 * every backend of a run runs one image. By default it reads this repository's
 * `benchmark/runner.yaml` — never one under `--root` — and asks Docker for the
 * tag's Id (`resolveImageId`): nothing reads the config or calls Docker until a
 * backend is about to start. A failure is not remembered; the run stops on it
 * anyway.
 */
export function lazyImage(
  resolveImage: () => { ref: string; id: string } = () => resolveImageId(readScoringImage(DEFAULT_ROOT)),
  onResolved?: (ref: string) => void,
): () => { ref: string; id: string } {
  let image: { ref: string; id: string } | null = null;
  return () => {
    if (image === null) {
      image = resolveImage();
      onResolved?.(image.ref);
    }
    return image;
  };
}

/**
 * `killAndWait`, then whether the group is really gone: one that outlived
 * SIGKILL may still hold its port. `kill` and `alive` are seams for tests — a
 * group that survives SIGKILL cannot be made on purpose.
 */
export async function stopViteGroup(
  proc: ChildProcess,
  kill: (proc: ChildProcess) => Promise<void> = killAndWait,
  alive: (pgid: number) => boolean = groupAlive,
): Promise<boolean> {
  await kill(proc);
  return proc.pid === undefined || !alive(proc.pid);
}

/**
 * The `node_modules` directories a frontend `npm install` of this run is
 * creating: absent before the install, and not yet known to be complete.
 *
 * `ensureNodeModules` skips any project that has a `node_modules`, so one an
 * install left half-built — it failed, it timed out, or a signal stopped it —
 * would make the next run skip the install and photograph a dev server that
 * cannot start: a sticky frontend-stop card for what may have been a network
 * fault or the operator's Ctrl-C. So a failed install's tree is removed again,
 * by the capture that ran it or, after a signal, by `removePartialInstalls`.
 * One that existed before the install is never touched: it is not this run's.
 * A second signal exits without waiting for either — during the install or
 * during the delete — so `warnPartialInstallsSync` names what is left.
 */
const partialInstalls = new Set<string>();
/** Removals under way: a second caller for the same tree (a signal during a failed install's) joins the first. */
const partialRemovals = new Map<string, Promise<string | null>>();

/** Whether anything is at `path`, a dangling symlink included. */
function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove `modulesDir` if an unfinished install of this run created it. Returns
 * why it could not be, or `null`. Asynchronous: a half-built tree can hold tens
 * of thousands of files, and a synchronous delete would block the event loop —
 * and with it a second signal's exit at once — until it finished.
 */
function removePartialInstall(modulesDir: string): Promise<string | null> {
  if (!partialInstalls.has(modulesDir)) return Promise.resolve(null);
  let removal = partialRemovals.get(modulesDir);
  if (removal === undefined) {
    removal = (async () => {
      try {
        await rm(modulesDir, { recursive: true, force: true });
        partialInstalls.delete(modulesDir);
        return null;
      } catch (error) {
        return (
          `${modulesDir}, left by an npm install that did not finish, could not be removed (${message(error)}). ` +
          "Delete it by hand: while it is there, the next run skips the install."
        );
      } finally {
        partialRemovals.delete(modulesDir);
      }
    })();
    partialRemovals.set(modulesDir, removal);
  }
  return removal;
}

/**
 * For a signal's cleanups, after `stopAllProcesses` has stopped every install:
 * remove each `node_modules` an install still running at the signal created.
 * Resolves once each is gone or reported.
 */
export async function removePartialInstalls(): Promise<void> {
  for (const modulesDir of [...partialInstalls]) {
    const problem = await removePartialInstall(modulesDir);
    if (problem !== null) console.warn(`warning: ${problem}`);
  }
}

/**
 * For the `exit` listener, after every process group and container is gone:
 * name each `node_modules` an unfinished install created that is still there.
 * A second signal exits during the install or during `removePartialInstalls`'
 * asynchronous delete, and either can leave a partly deleted tree that the
 * next run takes for an installed one: `ensureNodeModules` skips it, and the
 * dev server fails on it. A path the install never got to create is not
 * named: there is nothing to delete. Synchronous, as an `exit` listener must
 * be; `warn` is a seam for tests.
 */
export function warnPartialInstallsSync(warn: (line: string) => void = console.warn): void {
  for (const modulesDir of partialInstalls) {
    if (!pathExists(modulesDir)) continue;
    warn(`warning: ${modulesDir}, left by an npm install that did not finish, may be partly deleted: delete it by hand before the next run`);
  }
}

function defaultCaptureDeps(): Omit<CaptureDeps, "screenshotsDir"> {
  return {
    installTimeoutMs: LIMITS.npmInstallMs,
    image: lazyImage(),
    createBackend: (options) => new AttemptBackend(options),
    ensureNodeModules,
    probeRegistry: () => probeRegistry(),
    startVite,
    busyPorts,
    stopVite: (proc) => stopViteGroup(proc),
    sleep,
    interrupted: () => null,
    log: (line) => console.log(line),
    warn: (line) => console.warn(line),
  };
}

const INSTALL_TIMEOUT_HINT =
  "A dependency tree that never resolves would otherwise hang the whole run; " +
  "raise the bound with --install-timeout if the project is genuinely that large.";

/**
 * The tile shown for an attempt that could not be rendered.
 *
 * Every attempt on the dashboard then has an image, and a broken build reads
 * as a broken build rather than as a missing screenshot that could equally
 * mean the capture was never run.
 */
async function createErrorPlaceholder(
  browser: BrowserLike,
  screenshotPath: string,
  dirName: string,
  errorMsg: string,
  title = "Rendering Issue",
): Promise<void> {
  const page = await browser.newPage({ viewport: VIEWPORT });
  try {
    await page.setContent(`
    <html>
    <body style="margin:0;width:${VIEWPORT_WIDTH}px;height:${VIEWPORT_HEIGHT}px;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#1a1a2e;color:#e0e0e0;font-family:system-ui,sans-serif;text-align:center;padding:48px;box-sizing:border-box;">
      <div style="font-size:64px;margin-bottom:24px;">&#9888;</div>
      <div style="font-size:32px;font-weight:700;margin-bottom:16px;color:#ff6b6b;">${escapeHtml(title)}</div>
      <div style="font-size:18px;color:#a0a0a0;margin-bottom:32px;">${escapeHtml(dirName)}</div>
      <div style="font-size:14px;color:#666;max-width:700px;word-break:break-word;line-height:1.5;">${escapeHtml(errorMsg).slice(0, 300)}</div>
    </body>
    </html>
  `);
    await page.screenshot({ path: screenshotPath });
  } finally {
    await page.close();
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Title and text of the card a `failureKind: "model"` attempt gets. */
const MODEL_FAILURE_TITLE = "Model Failure";
const MODEL_FAILURE_TEXT =
  'run.json records failureKind "model": the run itself timed out or crashed, so the attempt scores 0 ' +
  "whatever it left on disk, and nothing was served.";

/**
 * Bring up the backend: layout, install, start. `null` when it serves; the
 * stop when a model-owned stage failed. Throws `InfraError` on a harness fault
 * and `CaptureInterrupted` after a signal — a backend closed by the signal's
 * cleanup reports infra, which must not be read as the harness failing.
 */
async function bringUpBackend(
  backend: CaptureBackend,
  d: CaptureDeps,
  checkInterrupt: () => void,
): Promise<{ stage: string; detail: string } | null> {
  const layout = backend.checkLayout();
  if (layout.kind === "infra") throw new InfraError(`the backend could not be checked: ${layout.detail}`);
  if (layout.kind === "stop") return layout;

  d.log("  Installing the backend (a fresh venv, pip install -r requirements.txt)...");
  const install = await backend.install();
  checkInterrupt();
  if (install.kind === "infra") throw new InfraError(`the backend could not be installed: ${install.detail}`);
  if (install.kind === "stop") return install;

  d.log(`  Starting the backend on 127.0.0.1:${BACKEND_PORT}...`);
  const started = await backend.start();
  checkInterrupt();
  if (started.kind === "infra") throw new InfraError(`the backend could not be started: ${started.detail}`);
  if (started.kind === "stop") return started;
  return null;
}

/**
 * Picture one attempt: a "Model Failure" card for a `failureKind: "model"`
 * run, which starts nothing; otherwise the backend on 127.0.0.1:5100, the
 * frontend's `npm install`, `npm run dev`, and a screenshot of `/` — or an
 * error card for a frontend stop.
 *
 * Teardown runs on every path, before anything is written: the dev server's
 * process group is killed and waited for, and the backend's containers are
 * removed and their removal verified (`stop` and `dispose`). What a teardown
 * cannot prove gone is an `InfraError`, as is any harness fault on the way;
 * neither writes a card. After a signal, `CaptureInterrupted` is thrown and
 * nothing is written either.
 */
export async function processAttempt(
  attempt: AttemptInfo,
  browser: BrowserLike,
  deps: Partial<CaptureDeps> & Pick<CaptureDeps, "screenshotsDir">,
): Promise<CaptureResult> {
  const d: CaptureDeps = { ...defaultCaptureDeps(), ...deps };
  const screenshotPath = join(d.screenshotsDir, screenshotFileName(attempt.dirName));
  const checkInterrupt = (): void => {
    const signal = d.interrupted();
    if (signal !== null) throw new CaptureInterrupted(signal);
  };

  /** Writes a card unless a signal has arrived; a card that cannot be written is logged, not thrown. */
  const writeCard = async (text: string, title?: string): Promise<void> => {
    checkInterrupt();
    try {
      await createErrorPlaceholder(browser, screenshotPath, attempt.dirName, text, title);
      d.log(`  Placeholder saved: ${screenshotFileName(attempt.dirName)}`);
    } catch (error) {
      checkInterrupt();
      d.warn(`  Could not create placeholder: ${message(error)}`);
    }
  };

  /**
   * A harness step, with whatever it throws — other than a signal or an
   * `InfraError` — made an `InfraError`: a step that throws instead of
   * answering is a harness fault, and must not become a card.
   */
  const harnessStep = async <T>(what: string, step: () => Promise<T>): Promise<T> => {
    try {
      return await step();
    } catch (error) {
      checkInterrupt();
      if (error instanceof InfraError || error instanceof CaptureInterrupted) throw error;
      throw new InfraError(`${what}: ${message(error)}`);
    }
  };

  /**
   * `port` asked again, late in the capture (header, item 5): held by
   * something else, `consequence` — given "is held by something else" — is an
   * `InfraError`, never a card or a picture.
   */
  const refuseIfHeld = async (port: number, consequence: (why: string) => string): Promise<void> => {
    const held = await harnessStep(`port ${port} could not be checked`, () => d.busyPorts([port]));
    checkInterrupt();
    if (held.length === 0) return;
    throw new InfraError(
      `${consequence("is held by something else")} It was free when this attempt started: a serve-attempt (under another ` +
        "--root), another take-screenshots, or a dev server or container started meanwhile holds it. Free it and re-run.",
    );
  };

  if (attempt.modelFailure) {
    d.log('  run.json records failureKind "model": a model-failure card, nothing started.');
    await writeCard(MODEL_FAILURE_TEXT, MODEL_FAILURE_TITLE);
    return { kind: "model-failure" };
  }

  const warnings: string[] = [];
  // A holder rather than two `let`s: they are assigned inside `capture` and read
  // by the teardown, which control-flow narrowing would not see.
  const started: { backend: CaptureBackend | null; vite: ViteServer | null } = { backend: null, vite: null };
  const frontendStop = (reason: string): CaptureResult => ({ kind: "card", error: `frontend stop: ${reason}`, warnings });

  const capture = async (): Promise<CaptureResult> => {
    if (attempt.frontendRoot === null) {
      return frontendStop("frontend/package.json is missing — the run contract puts the SPA in frontend/, so nothing was served");
    }
    const frontendRoot = attempt.frontendRoot;

    // The backend first (spec §5): a stop is known before a long install, and
    // the frontend then comes up against whatever answers on 5100.
    let imageId: string;
    try {
      imageId = d.image().id;
    } catch (error) {
      throw new InfraError(`the harness image could not be resolved: ${message(error)}`);
    }
    let backend: CaptureBackend;
    try {
      backend = d.createBackend({
        attemptDir: attempt.attemptDir,
        attemptName: attempt.dirName,
        // By Id: a retag during the run cannot change what later containers run.
        image: imageId,
        hostPort: BACKEND_PORT,
      });
    } catch (error) {
      throw new InfraError(`the backend could not be set up: ${message(error)}`);
    }
    started.backend = backend;
    const stop = await harnessStep("the backend failed unexpectedly", () => bringUpBackend(backend, d, checkInterrupt));
    if (stop !== null) {
      const warning = `backend stop (${stop.stage}): ${brief(stop.detail)} — photographing the frontend without data`;
      warnings.push(warning);
      d.warn(`  ! ${warning}`);
    }

    // The frontend's install: its failure is the model's only if the registry
    // answers (Ruling R23 as amended). Whatever it was, a `node_modules` the
    // failed install created goes first — before a signal is honoured — so
    // the next run installs again rather than serving a half-built tree.
    const modulesDir = join(frontendRoot, "node_modules");
    if (!pathExists(modulesDir)) partialInstalls.add(modulesDir);
    try {
      await d.ensureNodeModules(frontendRoot, d.installTimeoutMs, INSTALL_TIMEOUT_HINT);
      partialInstalls.delete(modulesDir);
    } catch (error) {
      const leftover = await removePartialInstall(modulesDir);
      if (leftover !== null) d.warn(`  ! ${leftover}`);
      checkInterrupt();
      // Whatever the registry would say: something outside the harness ended it.
      if (error instanceof InstallKilledError) throw new InfraError(error.message + (leftover === null ? "" : ` ${leftover}`));
      const failure = message(error);
      d.log("  npm install failed; asking the registry (npm ping) whose failure it was...");
      const reachable = await harnessStep("npm ping could not be asked", () => d.probeRegistry());
      checkInterrupt();
      if (!reachable) {
        throw new InfraError(
          `npm install failed (${brief(failure, 500)}), and npm ping could not reach the registry either. ` +
            "That says nothing about the model; fix the network and re-run." +
            (leftover === null ? "" : ` ${leftover}`),
        );
      }
      return frontendStop(`npm install failed, and the registry answered npm ping: ${failure}`);
    }
    checkInterrupt();

    d.log("  Starting the dev server (npm run dev)...");
    try {
      started.vite = await d.startVite(frontendRoot, { signal: d.signal });
    } catch (error) {
      checkInterrupt();
      if (!(error instanceof DevServerError)) throw new InfraError(`the dev server could not be started: ${message(error)}`);
      const account = `${error.message}${error.outputTail === "" ? "" : `\n${error.outputTail}`}`;
      // Every try is dead by now; something else on 5173 may be why none served.
      await refuseIfHeld(
        FRONTEND_PORT,
        (why) =>
          `npm run dev did not serve, and port ${FRONTEND_PORT} ${why} — or by a process of this dev server that outlived SIGKILL. ` +
          `The failure may be the collision's, not the model's. The dev server's own account: ${brief(account, 500)}.`,
      );
      return frontendStop(account);
    }
    checkInterrupt();
    const vite = started.vite;
    if (vite.port !== FRONTEND_PORT) {
      await refuseIfHeld(FRONTEND_PORT, (why) => `port ${FRONTEND_PORT} ${why}, and the dev server serves on ${vite.port}: the shift may be the collision's, not the model's.`);
      const warning = `the dev server serves on port ${vite.port}, not the run contract's ${FRONTEND_PORT}`;
      warnings.push(warning);
      d.warn(`  ! ${warning}`);
    }
    d.log(`  Dev server ready at ${vite.url}`);

    // A page that cannot even be opened is the browser's fault: no app code has run yet.
    const page = await harnessStep("the browser could not open a page", () => browser.newPage({ viewport: VIEWPORT }));
    try {
      // After a backend stop nothing of ours answers on 5100, and whatever does
      // would be photographed, through the dev server's proxy, as this attempt's data.
      if (stop !== null) {
        await refuseIfHeld(BACKEND_PORT, (why) => `after the backend stop, port ${BACKEND_PORT} ${why}: the page would show another backend's data as this attempt's.`);
      }
      // What the page reports from here to the capture, for a blank page's warning.
      const pageEvents = watchPageEvents(page);
      // `load`, then a settle (Ruling R19): the SPA fetches `/api` after `load`.
      await page.goto(vite.url, { waitUntil: "load", timeout: PAGE_LOAD_TIMEOUT_MS });
      await d.sleep(SCREENSHOT_DELAY_MS);
      // Wait for the page to render non-empty body content, framework-independent.
      // Vite dev may optimize dependencies on first access and reload the page.
      // A page still blank after the timeout is reloaded once — a blank capture
      // has been seen once and never reproduced, so the reload is what mends it
      // and the page events are what explain it — then warned about either way.
      if (page.waitForFunction !== undefined) {
        const waitForFunction = page.waitForFunction.bind(page);
        const rendered = async (): Promise<boolean> => {
          try {
            await waitForFunction(
              () => document.body !== null && document.body.innerText.trim().length > 0,
              undefined,
              { timeout: CONTENT_RENDER_TIMEOUT_MS },
            );
            return true;
          } catch {
            return false;
          }
        };
        if (!(await rendered())) {
          const blankFor = `${CONTENT_RENDER_TIMEOUT_MS / 1000} s`;
          let warning = `page still blank after ${blankFor} — photographing anyway`;
          if (page.reload !== undefined) {
            checkInterrupt();
            let reloadFailure: string | null = null;
            try {
              await page.reload({ waitUntil: "load", timeout: PAGE_LOAD_TIMEOUT_MS });
            } catch (error) {
              reloadFailure = brief(message(error));
            }
            if (reloadFailure !== null) {
              warning = `page still blank after ${blankFor}, and the reload failed (${reloadFailure}) — photographing anyway`;
            } else {
              await d.sleep(SCREENSHOT_DELAY_MS);
              warning = (await rendered())
                ? `page was blank after ${blankFor}, rendered after one reload`
                : `page still blank after ${blankFor} and one reload — photographing anyway`;
            }
          }
          warning += pageEventsTail(pageEvents());
          warnings.push(warning);
          d.warn(`  ! ${warning}`);
        }
      }
      // Brownfield: navigate to the Schedule view so the screenshot shows
      // the plan the attempt generated, not the identical dashboard.
      await prepareView(d.track, page, d.warn, attempt.dirName, d.sleep, pageEvents);
      checkInterrupt();
      await page.screenshot({ path: screenshotPath });
    } finally {
      // A page left open sits on a dead dev server's reconnect loop until the
      // browser closes; closed here on every path.
      try {
        await page.close();
      } catch {
        // the browser went first (a signal's cleanup closes it)
      }
    }
    return { kind: "pictured", warnings };
  };

  let result: CaptureResult | null = null;
  let failure: unknown = null;
  try {
    result = await capture();
  } catch (error) {
    failure = error;
  }

  // Teardown, on every path, before anything is written or thrown.
  const problems: string[] = [];
  if (started.vite !== null) {
    const { proc, port } = started.vite;
    try {
      if (!(await d.stopVite(proc))) {
        problems.push(`the dev server's process group ${proc.pid} outlived SIGKILL and may still hold port ${port}`);
      }
    } catch (error) {
      problems.push(`stopping the dev server failed: ${message(error)}`);
    }
  }
  if (started.backend !== null) {
    const removals: ContainerRemoval[] = [];
    try {
      removals.push(await started.backend.stop());
    } catch (error) {
      problems.push(`stopping the backend failed: ${message(error)}`);
    }
    try {
      removals.push(...(await started.backend.dispose()));
    } catch (error) {
      problems.push(`disposing of the backend failed: ${message(error)}`);
    }
    for (const removal of removals) if (!removal.removed) problems.push(removal.detail);
  }

  checkInterrupt();
  if (problems.length > 0) {
    const first = failure instanceof InfraError ? [failure.message] : [];
    throw new InfraError([...first, ...new Set(problems)].join("\n"));
  }
  if (failure instanceof InfraError || failure instanceof CaptureInterrupted) throw failure;
  if (failure !== null) result = { kind: "card", error: message(failure), warnings };
  if (result === null) throw new Error("unreachable: a capture ended with neither a result nor a failure");

  if (result.kind === "card") {
    d.warn(`  ✗ FAILED: ${result.error}`);
    await writeCard(result.error);
  } else {
    d.log(`  ✓ Screenshot saved: ${screenshotFileName(attempt.dirName)}`);
  }
  return result;
}

interface CaptureSummary {
  successes: string[];
  /** Attempts pictured with a warning (a backend stop, a port other than 5173). */
  warned: { name: string; warnings: string[] }[];
  failures: { name: string; error: string }[];
  modelFailures: string[];
}

// --- filmstrips and the hash manifest ----------------------------------------

/**
 * Group screenshot filenames by benchmark id, each group in attempt order.
 *
 * The key is the benchmark id — one group per **(model, effort)** pair, which is
 * this benchmark's unit of comparison. Grouping by family instead would emit
 * filmstrips nothing on the dashboard asks for: `FamilyGroupCard.tsx` renders
 * family rows with `filmstrip={false}`.
 *
 * Sorting is by attempt number, not lexicographic, so a tenth attempt does not
 * land between the first and the second.
 */
export function groupByBenchmarkId(files: string[]): Map<string, string[]> {
  const groups = new Map<string, { file: string; attempt: number }[]>();
  for (const file of files) {
    const parsed = parseAttemptDirName(file.replace(/\.png$/, ""));
    if (parsed === null) continue;
    const group = groups.get(parsed.modelId) ?? [];
    group.push({ file, attempt: parsed.attempt });
    groups.set(parsed.modelId, group);
  }
  return new Map(
    [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, entries]) => [id, entries.sort((a, b) => a.attempt - b.attempt).map((entry) => entry.file)]),
  );
}

/** Every PNG in `screenshotsDir` that is an attempt tile rather than a filmstrip. */
function attemptScreenshots(screenshotsDir: string): string[] {
  if (!existsSync(screenshotsDir)) return [];
  return readdirSync(screenshotsDir).filter((file) => file.endsWith(".png") && !file.endsWith(FILMSTRIP_SUFFIX));
}

/**
 * Benchmark ids whose filmstrip has to be built or rebuilt.
 *
 * Two ways a filmstrip needs work, and only the first one used to be checked:
 *
 * 1. **It is absent.** A run interrupted between the captures and the
 *    filmstrips leaves the files missing, and the next run sees exactly those
 *    and self-heals.
 * 2. **The PNGs behind it changed without a capture in this run.** An attempt
 *    re-run and reclassified `failureKind: "infra"` is dropped by
 *    `discoverAttempts` and its stale tile deleted; the group's filmstrip then
 *    still shows an attempt that is no longer on the dashboard, forever,
 *    because nothing is missing and nothing is pending. That was silent: the
 *    manifest resynced and the run exited 0.
 *
 * Two baselines answer (2), and the first is the one that matters:
 *
 * - **The filmstrip itself.** It is composed at `panels × 1280` pixels wide, so
 *   its own header says how many screenshots went into it. Nothing else has to
 *   record that, which means nothing else can lose it — and something did: the
 *   manifest is rewritten whole-directory at the end of *every* run, so a
 *   `--only` run used to resync the baseline for groups it had deliberately not
 *   repaired, making exactly this staleness permanent and invisible. A baseline
 *   carried by the artefact cannot be erased by a run that never touched it.
 * - **The hash manifest**, secondarily, for the one case a count cannot see: a
 *   group that lost one attempt and gained another between runs. Only the *key
 *   sets* are compared, never the hashes — a manifest whose contents drifted
 *   while the files did not is a manifest problem, fixed by rewriting it, and
 *   must not cost a browser launch. A group the manifest says nothing about is
 *   left alone: no baseline means "unknown", not "stale".
 *
 * Neither is an mtime comparison, which is the rule that matters most here: git
 * stamps every file with the checkout time, so mtimes would make a fresh clone
 * rebuild at random.
 */
export function filmstripsToRebuild(screenshotsDir: string, hashManifestPath: string): string[] {
  const onDisk = groupByBenchmarkId(attemptScreenshots(screenshotsDir));
  const manifest = readHashManifest(hashManifestPath);
  const recorded =
    manifest === null
      ? null
      : groupByBenchmarkId(Object.keys(manifest).filter((file) => !file.endsWith(FILMSTRIP_SUFFIX)));

  const rebuild: string[] = [];
  for (const [benchmarkId, files] of onDisk) {
    const filmstripPath = join(screenshotsDir, filmstripFileName(benchmarkId));
    if (!existsSync(filmstripPath)) {
      rebuild.push(benchmarkId);
      continue;
    }
    const panels = filmstripPanels(filmstripPath);
    if (panels !== null && panels !== files.length) {
      rebuild.push(benchmarkId);
      continue;
    }
    if (manifest === null || recorded === null) continue; // unreadable: no baseline
    const before = recorded.get(benchmarkId);
    const knownToManifest = before !== undefined || manifest[filmstripFileName(benchmarkId)] !== undefined;
    if (!knownToManifest) continue;
    if ((before ?? []).join("|") !== files.join("|")) rebuild.push(benchmarkId);
  }
  return rebuild;
}

/** The first eight bytes of every PNG. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * How many screenshots a filmstrip was composed from, read out of its own
 * header — or `null` when the file cannot be measured.
 *
 * `generateFilmstrips` renders each group at `panels × VIEWPORT_WIDTH` by
 * `VIEWPORT_HEIGHT`, with the viewport set to exactly that and no scrollbar, so
 * the width divided by the tile width *is* the panel count. A PNG's width lives
 * in the IHDR chunk, which is always the first chunk: bytes 16-19, big-endian.
 *
 * `null` — not a PNG, truncated, unreadable, or a width that is not a whole
 * number of tiles — means "cannot tell", never "stale". A file this cannot
 * measure is not evidence of anything, and treating it as stale would launch a
 * browser over a fixture or a half-written file.
 */
export function filmstripPanels(path: string): number | null {
  let header: Buffer;
  try {
    header = readFileSync(path).subarray(0, 24);
  } catch {
    return null;
  }
  if (header.length < 24) return null;
  if (!header.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (header.subarray(12, 16).toString("latin1") !== "IHDR") return null;
  const width = header.readUInt32BE(16);
  if (width === 0 || width % VIEWPORT_WIDTH !== 0) return null;
  return width / VIEWPORT_WIDTH;
}

/**
 * Filmstrips whose group has no attempt screenshots left at all.
 *
 * The one shape of staleness that cannot be repaired by rebuilding — a
 * filmstrip of zero attempts is not an image — so this is reported rather than
 * acted on. It happens when every attempt of a configuration is removed or
 * reclassified as an infrastructure failure, and the dashboard would otherwise
 * keep serving a strip of attempts that no longer exist.
 */
export function orphanFilmstrips(screenshotsDir: string): string[] {
  if (!existsSync(screenshotsDir)) return [];
  const groups = groupByBenchmarkId(attemptScreenshots(screenshotsDir));
  return readdirSync(screenshotsDir)
    .filter((file) => file.endsWith(FILMSTRIP_SUFFIX))
    .filter((file) => !groups.has(file.slice(0, -FILMSTRIP_SUFFIX.length)))
    .sort();
}

/**
 * Rebuild the filmstrips for `rebuild` only.
 *
 * A filmstrip is a function of its group's PNGs, so a group nothing touched
 * this run does not need re-rendering — and re-rendering it would mean
 * launching Chromium on a run where nothing changed, and dirtying every
 * filmstrip in the repo the first time Chromium's encoder output shifts.
 */
async function generateFilmstrips(browser: BrowserLike, screenshotsDir: string, rebuild: Set<string>): Promise<void> {
  const files = attemptScreenshots(screenshotsDir);
  const groups = groupByBenchmarkId(files);
  const grouped = [...groups.values()].reduce((count, group) => count + group.length, 0);
  if (grouped < files.length) {
    console.warn(
      `warning: ${files.length - grouped} file(s) in ${screenshotsDir} are not named ` +
        "<id>-attempt-<n>.png and were left out of the filmstrips.",
    );
  }

  const wanted = [...groups].filter(([benchmarkId]) => rebuild.has(benchmarkId));
  console.log(`Generating filmstrips for ${wanted.length} configuration(s)...`);
  for (const [benchmarkId, screenshots] of wanted) {
    // `run-matrix.ts` refuses to produce this many attempts, so reaching it
    // means the PNGs came from somewhere else. Skip the one group rather than
    // throwing: the other configurations' strips are still worth rebuilding,
    // and a Chromium page this wide fails in a way that says nothing useful.
    if (screenshots.length > MAX_ATTEMPTS_PER_CONFIG) {
      console.warn(
        `warning: ${benchmarkId} has ${screenshots.length} screenshots; a filmstrip of more than ` +
          `${MAX_ATTEMPTS_PER_CONFIG} does not render (${screenshots.length} x ${VIEWPORT_WIDTH} = ` +
          `${screenshots.length * VIEWPORT_WIDTH}px, past Chromium's ceiling). Leaving its filmstrip as it is.`,
      );
      continue;
    }
    const totalWidth = screenshots.length * VIEWPORT_WIDTH;
    const imgTags = screenshots
      .map((file, i) => {
        const b64 = readFileSync(join(screenshotsDir, file)).toString("base64");
        return `<img src="data:image/png;base64,${b64}" style="position:absolute;left:${i * VIEWPORT_WIDTH}px;top:0;width:${VIEWPORT_WIDTH}px;height:${VIEWPORT_HEIGHT}px;" />`;
      })
      .join("\n");

    const page = await browser.newPage({ viewport: { width: totalWidth, height: VIEWPORT_HEIGHT } });
    await page.setContent(`
      <html>
      <body style="margin:0;padding:0;width:${totalWidth}px;height:${VIEWPORT_HEIGHT}px;position:relative;overflow:hidden;">
        ${imgTags}
      </body>
      </html>
    `);
    await page.screenshot({ path: join(screenshotsDir, filmstripFileName(benchmarkId)) });
    await page.close();
    console.log(`  ✓ ${filmstripFileName(benchmarkId)} (${screenshots.length} attempts)`);
  }
}

/**
 * md5-prefix of every PNG, keyed by **bare filename** — the key the dashboard
 * looks up. Filmstrips are included; `ModelAveragesCard.tsx` busts their cache
 * the same way.
 */
export function buildHashManifest(screenshotsDir: string): Record<string, string> {
  if (!existsSync(screenshotsDir)) return {};
  const hashes: Record<string, string> = {};
  for (const file of readdirSync(screenshotsDir).filter((name) => name.endsWith(".png")).sort()) {
    const content = readFileSync(join(screenshotsDir, file));
    hashes[file] = createHash("md5").update(content).digest("hex").slice(0, 8);
  }
  return hashes;
}

export function writeHashManifest(path: string, hashes: Record<string, string>): void {
  // The default root's `website/src/data/` is committed, but a `--root` one need
  // not exist — and this is the last line of a run that has already paid for
  // every install, dev server and capture, so an ENOENT here is the most
  // expensive possible place to fail.
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(hashes, null, 2)}\n`, "utf8");
}

/**
 * The manifest on disk: `{}` when there is none, `null` when the file is there
 * but is not a readable manifest — which counts as stale, so it is rewritten.
 */
export function readHashManifest(path: string): Record<string, string> | null {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, string>;
  } catch {
    return null;
  }
}

/** Whether the manifest on disk already says what a fresh one would say. */
export function hashManifestIsCurrent(path: string, hashes: Record<string, string>): boolean {
  const onDisk = readHashManifest(path);
  if (onDisk === null) return false;
  const keys = Object.keys(hashes);
  if (keys.length !== Object.keys(onDisk).length) return false;
  return keys.every((key) => onDisk[key] === hashes[key]);
}

// --- what a run has to do ----------------------------------------------------

/**
 * Narrow the attempts to the configurations named by `--only`.
 *
 * The shape is `selectMatrixRows`'s in `scripts/lib/runner-config.ts`, so the
 * two scripts read as a pair: `--only` takes a *benchmark id* (not a directory
 * name), is repeatable, keeps the order it was given, de-duplicates, and refuses
 * an id it does not recognise — a typo that silently captured nothing would be
 * indistinguishable from a run that had nothing to do.
 *
 * An id counts as known if the catalogue has it *or* an attempt directory
 * carries it. The catalogue half means `--only` works before the first attempt
 * of a configuration exists; the on-disk half means it still works for an id
 * `discoverAttempts` warned about but captured anyway.
 */
export function selectAttempts(
  attempts: AttemptInfo[],
  only?: string[],
  fail: (message: string) => never = (message) => {
    throw new Error(message);
  },
): AttemptInfo[] {
  if (only === undefined || only.length === 0) return attempts;

  const onDisk = new Set(attempts.map((attempt) => attempt.benchmarkId));
  const known = new Set([...Object.keys(AGENT_NAMES), ...onDisk]);
  const selected: AttemptInfo[] = [];
  for (const id of only) {
    if (!known.has(id)) {
      fail(
        `--only ${JSON.stringify(id)} is not a benchmark id and matches no attempt directory. ` +
          `Known ids: ${[...known].sort().join(", ")}`,
      );
    }
    for (const attempt of attempts) {
      if (attempt.benchmarkId === id && !selected.includes(attempt)) selected.push(attempt);
    }
  }
  return selected;
}

export interface WorkPlan {
  /** Attempts to capture — all of them under `--force`. */
  pending: AttemptInfo[];
  /** Benchmark ids whose filmstrip is absent, or no longer matches its PNGs. */
  stripsToRebuild: string[];
  /** Ids that needed a rebuild but fell outside `--only`'s scope. */
  deferredStrips: string[];
  /** Whether the manifest on disk already says what a fresh one would. */
  manifestCurrent: boolean;
  /** Selected attempts that already have a screenshot (an error card counts). */
  alreadyPictured: number;
  /** Attempts in scope — every discovered one unless `--only` narrowed it. */
  total: number;
  /** Whether Chromium has to be launched at all. */
  needsBrowser: boolean;
  /** Whether the run has nothing to do and can return without side effects. */
  isNoOp: boolean;
}

/**
 * Configurations whose filmstrip will show more panels than their card claims
 * attempts.
 *
 * The two scripts discover from different places on purpose: this one pictures
 * whatever is in `eval-attempts/`, `process-results.ts` publishes only what has
 * an `eval-results.csv`. Run 5, score 3, capture, and the dashboard shows a card
 * reading "3 attempts" beside a 5-panel strip. Nothing else notices —
 * `filmstripsToRebuild` compares the strip against its PNGs, and by that measure
 * it is perfectly current.
 *
 * A warning rather than an exclusion, because capturing before scoring is a
 * legitimate order to work in; what is not legitimate is publishing in that
 * state without knowing.
 *
 * Nothing is said about a configuration with **no** scored attempt: that one has
 * no card on the dashboard at all, so there is no claim for its filmstrip to
 * contradict. It is the ordinary state of a freshly captured run, and warning
 * about it would bury the case that matters.
 */
function unscoredButPictured(paths: RepoPaths, selected: AttemptInfo[]): string[] {
  const byConfig = new Map<string, { pictured: number; scored: number }>();
  for (const attempt of selected) {
    const counts = byConfig.get(attempt.benchmarkId) ?? { pictured: 0, scored: 0 };
    counts.pictured += 1;
    if (existsSync(join(paths.resultsDir, attempt.dirName, "eval-results.csv"))) counts.scored += 1;
    byConfig.set(attempt.benchmarkId, counts);
  }
  const messages: string[] = [];
  for (const [benchmarkId, { pictured, scored }] of [...byConfig].sort()) {
    if (pictured === scored || scored === 0) continue;
    messages.push(
      `warning: ${benchmarkId} has ${pictured} attempt(s) to picture but only ${scored} with an ` +
        `eval-results.csv. Publish now and the card reads "${scored} attempts" beside a ${pictured}-panel ` +
        "filmstrip. Score the rest with the agrav-score-attempt skill, or accept the mismatch knowingly.",
    );
  }
  return messages;
}

/**
 * Decide what a run has to do, without doing any of it.
 *
 * Every question here is answered from the filesystem alone, so the decision to
 * launch a browser — the one expensive, side-effecting step — is made before
 * anything is started and can be asserted in a test that never launches one.
 */
export function planWork(
  root: string,
  options: {
    force?: boolean;
    only?: string[];
    warn?: (message: string) => void;
    track?: "classic" | "hard" | "brownfield";
  } = {},
): WorkPlan {
  const paths = repoPaths(root, options.track);
  const selected = selectAttempts(discoverAttempts(root, options.warn, options.track), options.only);
  const existing = getExistingScreenshots(paths.screenshotsDir);
  const pending = options.force === true ? selected : selected.filter((attempt) => !existing.has(attempt.dirName));
  // `--only` scopes the repairs too: asking for one configuration should not
  // quietly rebuild another one's filmstrip.
  const scope = options.only !== undefined && options.only.length > 0 ? new Set(options.only) : null;
  const inScope = (id: string): boolean => scope === null || scope.has(id);
  const needed = filmstripsToRebuild(paths.screenshotsDir, paths.hashManifestPath);
  const stripsToRebuild = needed.filter(inScope);
  // A repair `--only` declined to make is said out loud. The staleness itself
  // survives the run either way — a filmstrip's panel count is carried by the
  // file, not by anything this run rewrites — but a silent decline is how the
  // dashboard ends up quietly wrong for as long as nobody runs unscoped.
  const deferredStrips = needed.filter((id) => !inScope(id));
  for (const id of deferredStrips) {
    (options.warn ?? console.warn)(
      `warning: ${filmstripFileName(id)} no longer matches the screenshots behind it, and --only ` +
        `excluded it from this run. It stays stale until a run that includes it: ` +
        `npm run screenshots -- --only ${id}`,
    );
  }
  // Reported, not repaired: rebuilding a filmstrip of zero attempts is not a
  // thing that can be done, and leaving it unsaid would let the dashboard keep
  // serving a strip of attempts nothing else on the page still shows.
  for (const file of orphanFilmstrips(paths.screenshotsDir)) {
    (options.warn ?? console.warn)(
      `warning: ${file} has no attempt screenshots behind it any more. ` +
        "Delete it — nothing can rebuild a filmstrip with no attempts in it.",
    );
  }
  for (const message of unscoredButPictured(paths, selected)) (options.warn ?? console.warn)(message);
  const manifestCurrent = hashManifestIsCurrent(paths.hashManifestPath, buildHashManifest(paths.screenshotsDir));
  const needsBrowser = pending.length > 0 || stripsToRebuild.length > 0;
  return {
    pending,
    stripsToRebuild,
    deferredStrips,
    manifestCurrent,
    // Both counters describe the selected scope, so the "Found N; M already
    // pictured" line stays arithmetically honest under `--only`.
    alreadyPictured: selected.filter((attempt) => existing.has(attempt.dirName)).length,
    total: selected.length,
    needsBrowser,
    isNoOp: !needsBrowser && manifestCurrent,
  };
}

// --- CLI ---------------------------------------------------------------------

/** `600000` → `10m`, `90000` → `90s`: how USAGE prints a default. */
function formatDuration(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

const USAGE = `Usage: npm run screenshots -- [options]

Pictures one attempt at a time: its backend in the harness image on
127.0.0.1:${BACKEND_PORT}, its frontend's npm run dev (${FRONTEND_PORT} by the run contract), and a
1280x720 screenshot of /. Then the filmstrips and the hash manifest.

Options:
  --only <id>            Capture only this benchmark id. Repeatable. Default:
                         every attempt. Scopes the filmstrip repairs too.
  --force                Re-capture every selected attempt, including ones that
                         already have a screenshot. An error card is a
                         screenshot, so this is how a failed run is retried
                         without deleting PNGs by hand. Combine with --only to
                         retry one configuration rather than all of them.
  --install-timeout <d>  How long one attempt's frontend npm install may take. A
                         unit is required: 10m, 900s, 1h30m, 500ms. A bare
                         number is refused. Default: ${formatDuration(LIMITS.npmInstallMs)}, the rubric's
                         (LIMITS.npmInstallMs); this changes it for capture only.
  --root <path>          Repo root holding eval-attempts/, eval-results/,
                         website/ and .cache/serve-attempt.json. Default: the
                         repo this script lives in. The image always comes from
                         this repo's benchmark/runner.yaml.
  --track <track>        Which track to picture: "classic", "hard" or "brownfield".
                         Default: "classic".
  --help                 Print this message.

When anything is to be served, it needs Docker with the harness image built
(images/harness/IMAGE.md), ports ${BACKEND_PORT} and ${FRONTEND_PORT} free, and no serve-attempt
running. It also needs a Chromium binary: playwright declares no install
script, so \`npm install\` downloads no browser. Run
\`npx playwright install chromium\` once before the first capture. A run with
nothing to capture never launches a browser and needs none of this.
`;

interface CliArgs {
  force: boolean;
  only: string[];
  installTimeoutMs: number;
  root?: string;
  track: "classic" | "hard" | "brownfield";
  help: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    force: false,
    only: [],
    installTimeoutMs: LIMITS.npmInstallMs,
    track: "classic",
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const eq = token.indexOf("=");
    const name = token.startsWith("--") && eq !== -1 ? token.slice(0, eq) : token;
    const inlineValue = token.startsWith("--") && eq !== -1 ? token.slice(eq + 1) : undefined;
    const takeValue = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[++i];
      if (next === undefined) throw new Error(`${name} needs a value`);
      return next;
    };
    switch (name) {
      case "--only":
        args.only.push(takeValue());
        break;
      case "--force":
        args.force = true;
        break;
      case "--install-timeout": {
        const raw = takeValue();
        const value = parseDurationMs(raw);
        if (value <= 0) throw new Error(`--install-timeout ${JSON.stringify(raw)} must be greater than zero`);
        args.installTimeoutMs = value;
        break;
      }
      case "--root": {
        const raw = takeValue();
        const r = resolve(raw);
        if (
          (basename(r) === "tracks" && existsSync(join(dirname(r), "package.json"))) ||
          (basename(dirname(r)) === "tracks" && existsSync(join(dirname(dirname(r)), "package.json")))
        ) {
          throw new Error(`--root must be the repository root, not a track directory: got ${JSON.stringify(raw)}`);
        }
        args.root = r;
        break;
      }
      case "--track": {
        const v = takeValue();
        if (v !== "classic" && v !== "hard" && v !== "brownfield") {
          throw new Error(`--track must be "classic", "hard" or "brownfield"; got ${JSON.stringify(v)}`);
        }
        args.track = v;
        break;
      }
      case "--":
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        // `--concurrency` included: the fixed ports allow one attempt at a time.
        throw new Error(`unknown argument ${JSON.stringify(token)}\n\n${USAGE}`);
    }
  }
  return args;
}

export interface MainDeps {
  /** The dead-owner sweep (`sweepDeadOwners({role: "backend"})`). */
  sweep: () => SweepResult;
  /** `serve-attempt`'s state file under `root`, or `null` when there is none that parses. */
  serveState: (root: string) => ServeState | null;
  /** Whether the process a state file names is still that process. */
  ownerLive: (state: ServeState) => boolean;
  /** The ports of `ports` something holds, before and during every capture. Tests never probe the real 5100 and 5173. */
  busyPorts: (ports: number[]) => Promise<number[]>;
  launchBrowser: () => Promise<BrowserLike>;
  installHandlers: (hooks: InterruptHooks) => InterruptHandlers;
  /** Passed to every `processAttempt`; `main` supplies the rest (and `image`, `log`, `warn`, `busyPorts` unless given here). */
  capture: Partial<Omit<CaptureDeps, "screenshotsDir" | "installTimeoutMs" | "interrupted" | "signal">>;
  log: (line: string) => void;
  warn: (line: string) => void;
}

/**
 * Chromium without Playwright's own signal handlers. By default Playwright
 * installs one per signal when it launches a browser, and its SIGINT one
 * closes the browser and then calls `process.exit(130)` without waiting for
 * anything else: a first Ctrl-C would end the run before
 * `installInterruptHandlers`' cleanups had stopped the dev server with SIGTERM
 * first, removed the backend and verified it, or let a failed `npm install`
 * clean up after itself. Its SIGTERM and SIGHUP ones close the browser behind
 * those cleanups' backs. The cleanups close the browser themselves, in their
 * order.
 */
export const CHROMIUM_LAUNCH_OPTIONS = Object.freeze({
  handleSIGINT: false,
  handleSIGTERM: false,
  handleSIGHUP: false,
} satisfies LaunchOptions);

/** What `launchChromium` needs of Playwright's `chromium`. */
export interface BrowserLauncher {
  launch(options: LaunchOptions): Promise<BrowserLike>;
}

/** Chromium, launched with `CHROMIUM_LAUNCH_OPTIONS`; `launcher` is a seam for tests, which never launch it. */
export function launchChromium(launcher: BrowserLauncher = chromium): Promise<BrowserLike> {
  return launcher.launch({ ...CHROMIUM_LAUNCH_OPTIONS });
}

/** What `main` uses for every dependency a caller does not inject. `launchBrowser` is `launchChromium` itself. */
export const DEFAULT_MAIN_DEPS: Readonly<MainDeps> = Object.freeze({
  sweep: () => sweepDeadOwners({ role: BACKEND_ROLE }),
  serveState: readServeState,
  ownerLive: isServeOwnerLive,
  busyPorts,
  launchBrowser: launchChromium,
  installHandlers: installInterruptHandlers,
  capture: {},
  log: (line) => console.log(line),
  warn: (line) => console.warn(line),
} satisfies MainDeps);

/** An attempt whose capture starts a backend: not a model failure, and a frontend to serve. */
function willServe(attempt: AttemptInfo): boolean {
  return !attempt.modelFailure && attempt.frontendRoot !== null;
}

/**
 * Why nothing may be served right now, or `null`: a live `serve-attempt` for
 * this root, or 5100 or 5173 taken. With `warnDead`, a state file whose owner
 * is gone, or that cannot be read, is also warned about — once per run, from
 * the pre-flight, not before every attempt.
 */
async function servingConflict(root: string, d: MainDeps, warnDead: boolean): Promise<string | null> {
  const path = statePath(root);
  const stopHint = stopCommand(root);
  const state = d.serveState(root);
  if (state !== null) {
    if (d.ownerLive(state)) {
      return (
        `serve-attempt is serving ${state.attempt} (pid ${state.pid}${state.url === null ? "" : `, ${state.url}`}), ` +
        `according to ${path}. It holds ports ${BACKEND_PORT} and ${FRONTEND_PORT}, which every capture needs. ` +
        `Stop it first with ${stopHint}.`
      );
    }
    if (warnDead) {
      d.warn(
        `warning: ${path} names pid ${state.pid}, serving ${state.attempt}, which is no longer running: it died ` +
          `without cleaning up. Run ${stopHint} to remove what it left. Going on; the port check decides.`,
      );
    }
  } else if (warnDead && existsSync(path)) {
    d.warn(`warning: ${path} exists but cannot be read, so it names no process that can be proven running. Going on; the port check decides.`);
  }

  const busy = await d.busyPorts([BACKEND_PORT, FRONTEND_PORT]);
  if (busy.length > 0) {
    const ports = busy.length === 1 ? `port ${busy[0]} is` : `ports ${busy.join(" and ")} are`;
    return (
      `${ports} already in use. Each capture serves the attempt's backend on 127.0.0.1:${BACKEND_PORT} and its dev ` +
      `server on ${FRONTEND_PORT}, and shares neither: a serve-attempt, another take-screenshots, or a leftover dev ` +
      "server or container may hold them. Free the port and re-run."
    );
  }
  return null;
}

/**
 * What must hold before anything is served, checked before Chromium starts:
 * the dead-owner sweep first (it may free 5100 from a SIGKILLed run), then no
 * live `serve-attempt` for this root, then 5100 and 5173 free. Returns why the
 * run must not start, or `null`. Nothing is started, and nothing written.
 */
async function preflight(root: string, d: MainDeps): Promise<string | null> {
  try {
    const swept = d.sweep();
    for (const name of swept.removedContainers) d.log(`Removed ${name}, a backend container whose owner is gone.`);
    for (const dir of swept.removedDirs) d.log(`Removed ${dir}, a scratch directory whose owner is gone.`);
    for (const failed of swept.failed) d.warn(`warning: dead-owner sweep: ${failed}`);
  } catch (error) {
    d.warn(`warning: the dead-owner sweep failed: ${message(error)}`);
  }
  const conflict = await servingConflict(root, d, true);
  return conflict === null ? null : `${conflict} Nothing was started and no screenshot was written.`;
}

export async function main(argv: string[], deps: Partial<MainDeps> = {}): Promise<number> {
  const d: MainDeps = { ...DEFAULT_MAIN_DEPS, ...deps };
  const args = parseArgs(argv);
  if (args.help) {
    d.log(USAGE);
    return 0;
  }

  const root = args.root ?? DEFAULT_ROOT;
  const paths = repoPaths(root, args.track);

  d.log(`Discovering attempts under ${paths.attemptsDir} ...`);
  const { pending, stripsToRebuild, deferredStrips, isNoOp, needsBrowser, alreadyPictured, total } = planWork(root, {
    force: args.force,
    only: args.only,
    warn: d.warn,
    track: args.track,
  });
  // An unattended run's log should say which bounds were in effect, so a
  // non-default install timeout is echoed alongside the selection flags.
  const flags = [
    args.force ? "--force" : null,
    args.only.length > 0 ? `--only ${args.only.join(", ")}` : null,
    args.installTimeoutMs === LIMITS.npmInstallMs ? null : `--install-timeout ${Math.round(args.installTimeoutMs / 1000)}s`,
  ]
    .filter((flag) => flag !== null)
    .join("; ");
  d.log(
    `Found ${total} attempt(s); ${alreadyPictured} already pictured; ` +
      `${pending.length} to capture${flags === "" ? "" : ` (${flags})`}.`,
  );

  // Three questions, none of which needs a browser to answer: is there anything
  // to capture, is any filmstrip missing, and does the manifest already say what
  // a fresh one would? When all three say no, doing nothing means *nothing*: no
  // browser, no container, no dev server, no `npm install`, no directory
  // created (Ruling P3). That covers the empty repo — the normal state until the
  // matrix has run — and equally a fully captured one, so a second run in a row
  // is free.
  if (isNoOp) {
    // "Every filmstrip matches" is a claim about the whole directory, and a
    // scoped run is not entitled to make it: `--only` can leave a filmstrip it
    // knows to be stale, warned about a few lines above. Printing both put a
    // flat contradiction on screen — and the first metered capture is a scoped
    // run someone is watching, who would reasonably read it as a broken tool and
    // abort a run that was fine. So the summary says what this run actually
    // established, and repeats what it left behind rather than talking over it.
    d.log(
      deferredStrips.length === 0
        ? "Nothing to do: nothing to capture, every filmstrip matches the PNGs behind it and the hash " +
            "manifest is current. " +
            "No browser, backend, dev server or npm install was started. (--force re-captures everything.)"
        : `Nothing to do in scope: nothing to capture and the hash manifest is current, but ` +
            `${deferredStrips.length} filmstrip(s) outside --only's scope are still stale ` +
            `(${deferredStrips.join(", ")}) — see the warning(s) above. ` +
            "No browser, backend, dev server or npm install was started.",
    );
    return 0;
  }

  const summary: CaptureSummary = { successes: [], warned: [], failures: [], modelFailures: [] };
  /** Set when a harness fault stopped the run: the attempt and the fault. */
  let stoppedBy: string | null = null;
  if (needsBrowser) {
    // A signal: stop a dev server that is still starting, close the browser
    // (so no page goes on to write a card), then every process group and every
    // backend — each awaited, so the process exits only once they are gone. A
    // second signal exits at once, and the exit cleanups kill and remove
    // synchronously whatever is left.
    const abort = new AbortController();
    let browser: BrowserLike | null = null;
    const handlers = d.installHandlers({
      cleanups: [
        () => abort.abort(),
        async () => {
          if (browser !== null) await browser.close();
        },
        () => stopAllProcesses(),
        () => stopAllBackends(),
        // Last: it may be a long `rm -rf`, and the containers matter more. It
        // is asynchronous, so a second signal during it still exits at once.
        removePartialInstalls,
      ],
      // The warning last: it names what the two before it could not make safe.
      exitCleanups: [killAllProcessesSync, stopAllBackendsSync, warnPartialInstallsSync],
    });
    const interruptedCode = (): number | null => {
      const signal = handlers.interrupted();
      return signal === null ? null : INTERRUPT_EXIT_CODES[signal];
    };

    // Only when something will be served: a run that only writes model-failure
    // cards, error cards for missing frontends, or filmstrips needs neither the
    // ports nor Docker, and must not be refused because serve-attempt runs.
    if (pending.some(willServe)) {
      const refusal = await preflight(root, d);
      const code = interruptedCode();
      if (code !== null) return code;
      if (refusal !== null) {
        d.warn(`take-screenshots: ${refusal}`);
        return 1;
      }
    }

    mkdirSync(paths.screenshotsDir, { recursive: true });
    d.log("Launching Chromium...");
    browser = await d.launchBrowser();
    const captured = new Set<string>();
    try {
      if (pending.length > 0) {
        d.log(`${pending.length} screenshot(s) to take, one at a time.\n`);
        const log = d.capture.log ?? d.log;
        const image = d.capture.image ?? lazyImage(undefined, (ref) => log(`  Harness image: ${ref}`));
        // The pre-flight's port and serve-attempt check covers the first
        // attempt that serves. Every later one is checked again: a
        // serve-attempt or a second take-screenshots can start between two
        // captures, while both ports are briefly free, and would otherwise
        // share them with this run without anyone being told.
        let checkedByPreflight = true;
        for (const [index, attempt] of pending.entries()) {
          if (handlers.interrupted() !== null) break;
          d.log(`[${index + 1}/${pending.length}] ${attempt.dirName} — ${displayName(attempt.benchmarkId)}`);
          if (willServe(attempt)) {
            if (!checkedByPreflight) {
              const conflict = await servingConflict(root, d, false);
              if (handlers.interrupted() !== null) break;
              if (conflict !== null) {
                // A harness fault: nothing about it is this attempt's, so no card.
                stoppedBy = `${attempt.dirName}: ${conflict} It appeared after the pre-flight, between two captures; nothing was started for this attempt.`;
                break;
              }
            }
            checkedByPreflight = false;
          }
          let result: CaptureResult;
          try {
            result = await processAttempt(attempt, browser, {
              log,
              warn: d.warn,
              busyPorts: d.busyPorts,
              ...d.capture,
              image,
              screenshotsDir: paths.screenshotsDir,
              track: args.track,
              installTimeoutMs: args.installTimeoutMs,
              interrupted: () => handlers.interrupted(),
              signal: abort.signal,
            });
          } catch (error) {
            if (error instanceof CaptureInterrupted || handlers.interrupted() !== null) break;
            if (error instanceof InfraError) {
              stoppedBy = `${attempt.dirName}: ${error.message}`;
              break;
            }
            throw error;
          }
          captured.add(attempt.benchmarkId);
          if (result.kind === "model-failure") summary.modelFailures.push(attempt.dirName);
          else if (result.kind === "card") summary.failures.push({ name: attempt.dirName, error: result.error });
          else {
            summary.successes.push(attempt.dirName);
            if (result.warnings.length > 0) summary.warned.push({ name: attempt.dirName, warnings: result.warnings });
          }
        }
      }
      // Everything pictured this run — a card is as much a new PNG as a
      // screenshot — plus any filmstrip that was missing. A run stopped by a
      // harness fault still leaves consistent filmstrips for what it did picture.
      if (handlers.interrupted() === null) {
        const rebuild = new Set([...stripsToRebuild, ...captured]);
        d.log("\nGenerating filmstrips...");
        await generateFilmstrips(browser, paths.screenshotsDir, rebuild);
      }
    } finally {
      try {
        await browser.close();
      } catch (error) {
        d.warn(`warning: closing the browser failed: ${message(error)}`);
      }
      // Each capture tore itself down; these only matter on a path that threw.
      await stopAllProcesses();
      await stopAllBackends();
    }
    const code = interruptedCode();
    if (code !== null) return code;
  }

  const hashes = buildHashManifest(paths.screenshotsDir);
  writeHashManifest(paths.hashManifestPath, hashes);
  d.log(`Screenshot hash manifest written (${Object.keys(hashes).length} files).`);

  d.log("\n--- Summary ---");
  d.log(`Successes: ${summary.successes.length}`);
  for (const { name, warnings } of summary.warned) {
    for (const warning of warnings) d.log(`  ! ${name}: ${warning}`);
  }
  if (summary.modelFailures.length > 0) {
    d.log(`Model failures (pictured as model-failure cards): ${summary.modelFailures.length}`);
  }
  if (summary.failures.length > 0) {
    d.log(`Failures (pictured as error cards): ${summary.failures.length}`);
    for (const failure of summary.failures) d.log(`  - ${failure.name}: ${brief(failure.error, 500)}`);
  }

  if (stoppedBy !== null) {
    d.warn(
      `\nStopped by a harness fault, not the model's: no card was written for that attempt, and the ` +
        `attempts after it were not captured. Fix the cause and re-run; nothing already pictured is redone.\n  ${stoppedBy}`,
    );
    return 1;
  }

  // An error card is a legitimate outcome, so a run that captured *something*
  // succeeded. A run where every single capture failed is not a result — it is
  // an environment that is broken in the same way every time, and exiting 0
  // would let it pass the Phase 7 gate ("a PNG and a filmstrip exist and are
  // non-blank") with a row of identical pictures of an error message.
  if (summary.successes.length === 0 && summary.failures.length > 0) {
    d.warn(
      `\nEvery capture failed (${summary.failures.length}/${summary.failures.length}). ` +
        "The error cards were written, but nothing here is a picture of an app — " +
        "fix the cause and re-run with --force.",
    );
    return 1;
  }
  return 0;
}

// Guarded so a test can import the helpers above without the script launching a
// browser, starting a backend, installing dependencies or writing to the checkout.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`take-screenshots: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
