import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface ResetClient {
  post: (url: string) => Promise<{ ok: () => boolean; status: () => number }>;
}

export type ScreenName = "dashboard" | "schedule" | "work-orders" | "inventory";

const SCREEN_PATTERNS: Record<ScreenName, { label: RegExp; path: string }> = {
  dashboard: { label: /dashboard/i, path: "/" },
  schedule: { label: /schedule/i, path: "/schedule" },
  "work-orders": { label: /work[- ]?orders/i, path: "/work-orders" },
  inventory: { label: /inventory/i, path: "/inventory" },
};

/**
 * Resets the application state to the seed data by invoking POST /api/v1/reset.
 */
export async function resetDatabase(request?: ResetClient | { post: (url: string) => Promise<any> }) {
  if (request && typeof request.post === "function") {
    const response = await request.post("http://localhost:5100/api/v1/reset");
    const isOk = typeof response.ok === "function" ? response.ok() : response.status < 400;
    if (!isOk) {
      const status = typeof response.status === "function" ? response.status() : response.status;
      throw new Error(`resetDatabase failed with status ${status}`);
    }
    return response;
  }

  const response = await fetch("http://localhost:5100/api/v1/reset", { method: "POST" });
  if (!response.ok) {
    throw new Error(`resetDatabase failed with status ${response.status}`);
  }
  return response;
}

/**
 * Resolves the path to the tracks/console-hard/package.json from this file's location.
 */
function resolvePackageJson(): string {
  // This file is at tracks/console-hard/benchmark/e2e-tests/helpers.ts
  // We need tracks/console-hard/package.json which is ../../package.json
  return resolve(__dirname, "..", "..", "package.json");
}

/**
 * Asserts exact library versions declared in tracks/console-hard/package.json per Ruling H3.
 */
export function assertPinnedVersions() {
  const pkgPath = resolvePackageJson();
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const deps = pkg.dependencies ?? {};

  if (deps["playwright"] !== "1.62.1") {
    throw new Error(`Ruling H3 violation: Expected playwright 1.62.1, got ${deps["playwright"]}`);
  }
  if (deps["@playwright/test"] !== "1.62.1") {
    throw new Error(`Ruling H3 violation: Expected @playwright/test 1.62.1, got ${deps["@playwright/test"]}`);
  }
  if (deps["@axe-core/playwright"] !== "4.13.0") {
    throw new Error(`Ruling H3 violation: Expected @axe-core/playwright 4.13.0, got ${deps["@axe-core/playwright"]}`);
  }
  if (deps["axe-core"] !== "4.13.0") {
    throw new Error(`Ruling H3 violation: Expected axe-core 4.13.0, got ${deps["axe-core"]}`);
  }
}

/**
 * Navigates to the designated screen, opening the hamburger drawer if necessary on mobile.
 */
export async function navigateTo(page: any, screen: ScreenName) {
  const targetConfig = SCREEN_PATTERNS[screen];
  if (!targetConfig) {
    throw new Error(`Unknown screen: ${screen}`);
  }

  // Human-readable labels that match known nav button text
  const LABELS: Record<ScreenName, string> = {
    dashboard: "Dashboard",
    schedule: "Schedule",
    "work-orders": "Work Orders",
    inventory: "Inventory",
  };
  const label = LABELS[screen];

  const viewport = page.viewportSize();
  const isMobile = viewport && viewport.width < 768;

  // Helper: find the nav button/link by text
  const findNavTarget = () =>
    page
      .locator(`nav button:has-text("${label}"), nav a:has-text("${label}")`)
      .first()
      .or(page.getByRole("button", { name: targetConfig.label }).first())
      .or(page.getByRole("link", { name: targetConfig.label }).first())
      .or(page.locator(`button:has-text("${label}"), a:has-text("${label}")`).first());

  if (isMobile) {
    // Check if target is already visible
    let navTarget = findNavTarget();
    let isDirectVisible = await navTarget.isVisible().catch(() => false);

    if (!isDirectVisible) {
      // Try to open mobile menu via hamburger
      const toggleCandidates = [
        page.locator('button[aria-label="Toggle menu"]'),
        page.locator('button[aria-label*="menu" i]'),
        page.locator('button[aria-label*="toggle" i]'),
        page.locator('button[aria-label*="navigation" i]'),
      ];

      for (const toggle of toggleCandidates) {
        if (await toggle.isVisible().catch(() => false)) {
          await toggle.click();
          await page.waitForTimeout(200);
          navTarget = findNavTarget();
          isDirectVisible = await navTarget.isVisible().catch(() => false);
          if (isDirectVisible) break;
        }
      }
    }

    if (isDirectVisible) {
      await navTarget.click();
      await page.waitForTimeout(200);
      return;
    }
  }

  // Desktop: nav buttons should be visible
  const target = findNavTarget();
  if (await target.isVisible().catch(() => false)) {
    await target.click();
    await page.waitForTimeout(200);
    return;
  }

  // Last resort: try clicking any element containing the label text
  const fallback = page.locator(`text="${label}"`).first();
  if (await fallback.isVisible().catch(() => false)) {
    await fallback.click();
    await page.waitForTimeout(200);
    return;
  }

  // Final fallback: URL navigation (SPA may not support this, but worth trying)
  await page.goto(targetConfig.path, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(200);
}

/**
 * Sequentially visits /, /schedule, /work-orders, /inventory to warm up Vite JIT compilation
 * per Ruling H12.
 */
export async function warmupRoutes(page: any) {
  await page.goto("/", { waitUntil: "load" });
  await page.waitForTimeout(500);

  const screens: ScreenName[] = ["schedule", "work-orders", "inventory", "dashboard"];
  for (const screen of screens) {
    await navigateTo(page, screen).catch(() => {});
    await page.waitForTimeout(300);
  }
}

/**
 * Opens the create-work-order form. prompt.md §7 asks for "a form that creates a work order"
 * but mandates no label, so any button whose name says new/create/add (an order) opens it.
 * A form already on the page (an inline form) needs no opener.
 */
export async function openCreateForm(page: any) {
  // a button or a link (a route such as /work-orders/new); "order" in the name first, then any
  // new/create/add control that is not a parts row's "Add"
  for (const name of [/\b(new|create|add)\b.*\border\b/i, /^\s*\+\s*$|^\s*\+?\s*(new|add|create)\b(?!.*\bparts?\b).*$/i]) {
    const opener = page.getByRole("button", { name }).or(page.getByRole("link", { name })).first();
    if (await opener.isVisible().catch(() => false)) {
      await opener.click();
      await page.waitForTimeout(300);
      return;
    }
  }
  if ((await page.locator("form").count()) > 0) return;
  throw new Error("no button or link opens a create-work-order form, and no form is on the page");
}

/** Index, among the form's input/textarea/select fields, of the one whose label, name, id, placeholder or aria-label matches `hint`. */
async function fieldIndex(form: any, hint: RegExp, exclude: RegExp | null = null): Promise<number> {
  return form.evaluate(
    (el: Element, arg: { source: string; flags: string; ex: { source: string; flags: string } | null }) => {
      const re = new RegExp(arg.source, arg.flags);
      const ex = arg.ex ? new RegExp(arg.ex.source, arg.ex.flags) : null;
      const fields = Array.from(el.querySelectorAll("input, textarea, select"));
      return fields.findIndex((f) => {
        const id = f.getAttribute("id");
        const forLabel = id ? el.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent : null;
        // a sibling <label> only: the parent's whole subtree can hold every other field's label
        // (a form container whose title input sits beside the duration field's labelled <div>)
        const sibling = Array.from(f.parentElement?.children ?? []).find((c) => c.tagName === "LABEL");
        const label = forLabel ?? f.closest("label")?.textContent ?? sibling?.textContent ?? "";
        const hints = [label, f.getAttribute("name"), id, f.getAttribute("placeholder"), f.getAttribute("aria-label")];
        return hints.some((s) => s != null && re.test(s)) && !(ex && hints.some((s) => s != null && ex.test(s)));
      });
    },
    { source: hint.source, flags: hint.flags, ex: exclude ? { source: exclude.source, flags: exclude.flags } : null },
  );
}

/**
 * The create form: the last <form> on the page (a modal renders after the list). An attempt
 * whose form is a plain container (prompt.md §7 asks for a form, not a <form> element) gets the
 * deepest element holding a field, a button and the title, duration and due-date fields' text.
 */
export async function createForm(page: any) {
  const forms = page.locator("form");
  if ((await forms.count()) > 0) return forms.last();
  // No <form> (a modal of inputs and a button is just as legal, prompt.md §7): start from the
  // title field and take its nearest ancestor that holds a create/save/submit/add button. Matching
  // by visible text alone can settle on the whole page when the title field has only a
  // placeholder, and the page also holds the list's filter selects, which must not be touched.
  const titleField = page
    .locator("input, textarea")
    .and(page.locator('[placeholder*="title" i], [name*="title" i], [id*="title" i], [aria-label*="title" i]'))
    .filter({ visible: true })
    .last();
  if ((await titleField.count()) > 0) {
    const lower = "translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')";
    const submitLike = ["create", "save", "submit", "add"].map((w) => `contains(${lower}, '${w}')`).join(" or ");
    const container = titleField.locator(`xpath=ancestor::*[.//button[${submitLike}]][1]`);
    if ((await container.count()) > 0) return container;
  }
  return page
    .locator("div, section, dialog, aside")
    .filter({ has: page.locator("input, textarea, select") })
    .filter({ has: page.getByRole("button") })
    .filter({ hasText: /title/i })
    .filter({ hasText: /duration/i })
    .filter({ hasText: /due/i })
    .last();
}

/**
 * Fills the create form with POST /work-orders' required fields (prompt.md §4): title,
 * required_skill, duration_minutes, earliest_start, due_date, asset_id (a text field or a
 * select); any select still empty (priority, …) gets its first real option. Fields are found by
 * label, name, id, placeholder or aria-label — never by one attempt's wording.
 */
export async function fillWorkOrderForm(
  page: any,
  v: { title: string; skill: string; duration: number; earliest: string; due: string; assetId: string },
) {
  const form = await createForm(page);
  const fields = form.locator("input, textarea, select");
  const set = async (hint: RegExp, value: string, exclude: RegExp | null = null) => {
    const i = await fieldIndex(form, hint, exclude);
    if (i < 0) throw new Error(`the create form has no field matching ${hint}`);
    const field = fields.nth(i);
    if ((await field.evaluate((el: Element) => el.tagName.toLowerCase())) !== "select") {
      await field.fill(value);
      return;
    }
    // a select (e.g. required_skill offered as a list): the option whose value or text is `value`
    const options: { value: string; text: string }[] = await field
      .locator("option")
      .evaluateAll((os: HTMLOptionElement[]) => os.map((o) => ({ value: o.value, text: (o.textContent ?? "").trim() })));
    const match = options.find((o) => o.value.toLowerCase() === value.toLowerCase() || o.text.toLowerCase() === value.toLowerCase());
    if (!match) throw new Error(`the create form's ${hint} select has no option ${JSON.stringify(value)}`);
    await field.selectOption(match.value);
  };
  await set(/title/i, v.title);
  await set(/skill/i, v.skill);
  await set(/duration/i, String(v.duration));
  // the two dates: by label, name, id, placeholder or aria-label; failing that, the form's
  // unlabelled date inputs in the prompt's order (earliest_start, then due_date)
  const earliestAt = await fieldIndex(form, /earliest|start/i, /due/i);
  const dueAt = await fieldIndex(form, /due/i);
  if (earliestAt >= 0 && dueAt >= 0) {
    await set(/earliest|start/i, v.earliest, /due/i);
    await set(/due/i, v.due);
  } else {
    const dates = form.locator('input[type="date"]');
    if ((await dates.count()) !== 2) throw new Error("the create form has no fields for earliest_start and due_date");
    await dates.nth(0).fill(v.earliest);
    await dates.nth(1).fill(v.due);
  }
  // asset_id is required (prompt.md §4): a text field gets a seed asset's id, a select that asset's option
  const assetIndex = await fieldIndex(form, /asset/i);
  if (assetIndex >= 0) {
    const asset = fields.nth(assetIndex);
    const tag: string = await asset.evaluate((el: Element) => el.tagName.toLowerCase());
    if (tag === "select") {
      const values: string[] = await asset.locator("option").evaluateAll((os: HTMLOptionElement[]) => os.map((o) => o.value));
      if (values.includes(v.assetId)) await asset.selectOption(v.assetId);
    } else {
      await asset.fill(v.assetId);
    }
  }
  const selects = form.locator("select");
  for (let i = 0; i < (await selects.count()); i++) {
    const select = selects.nth(i);
    if ((await select.inputValue()) !== "") continue;
    const values: string[] = await select
      .locator("option")
      .evaluateAll((options: HTMLOptionElement[]) => options.map((o) => o.value).filter((value) => value !== ""));
    if (values.length > 0) await select.selectOption(values[0]);
  }
}

/** Submits the create form through its submit button. */
export async function submitForm(page: any) {
  const form = await createForm(page);
  const typed = form.locator('button[type="submit"], input[type="submit"]').first();
  if (await typed.isVisible().catch(() => false)) {
    await typed.click();
    return;
  }
  // "Add" last: a form's parts row often has an "Add" button before the form's own submit
  const primary = form.getByRole("button", { name: /create|save|submit/i });
  if ((await primary.count()) > 0) await primary.last().click();
  else await form.getByRole("button", { name: /add/i }).last().click();
}

/**
 * Status-transition buttons, found by their target status (prompt.md §7 asks for "buttons for
 * the status transitions that are legal", no wording): in_progress, completed, cancelled.
 */
export const TRANSITION_BUTTON: Record<"in_progress" | "completed" | "cancelled", RegExp> = {
  in_progress: /start|in[ _-]?progress/i,
  completed: /complet/i,
  cancelled: /cancel/i,
};

/**
 * Index of the first <select> on the page with an option whose value or text matches `option`
 * (e.g. /^scheduled$/ for the status filter), or -1. Filters are found by what they filter,
 * not by their placeholder wording ("All statuses", "Any status", …).
 */
export async function selectIndexWithOption(page: any, option: RegExp): Promise<number> {
  return page.evaluate(
    (src: { source: string; flags: string }) => {
      const re = new RegExp(src.source, src.flags);
      return Array.from(document.querySelectorAll("select")).findIndex((s) =>
        Array.from(s.options).some((o) => re.test(o.value) || re.test((o.textContent ?? "").trim())),
      );
    },
    { source: option.source, flags: option.flags },
  );
}

/** Selects, in the status filter, the option for `status` (by value, or by its words in the text). */
export async function filterByStatus(page: any, status: string): Promise<boolean> {
  const words = new RegExp(`^${status.replace(/_/g, "[ _-]?")}$`, "i");
  const i = await selectIndexWithOption(page, /^(scheduled|blocked|unscheduled)$/i);
  if (i < 0) return false;
  const select = page.locator("select").nth(i);
  const options: { value: string; text: string }[] = await select
    .locator("option")
    .evaluateAll((os: HTMLOptionElement[]) => os.map((o) => ({ value: o.value, text: (o.textContent ?? "").trim() })));
  const match = options.find((o) => words.test(o.value) || words.test(o.text));
  if (match === undefined) return false;
  await select.selectOption(match.value);
  return true;
}

/** Work order ids have a fixed shape (prompt.md §1): `WO-` and three digits. */
const ORDER_ID = /\bWO-\d{3}\b/g;

/**
 * How many orders the list shows: its table rows when the list is a table, else the distinct
 * work order ids on the page (prompt.md §7 asks for "the list", not for a table).
 */
export async function listedOrderCount(page: any): Promise<number> {
  const rows = page.locator("table tbody tr");
  const n = await rows.count();
  if (n > 0) return n;
  const text: string = await page.locator("main, #root").first().innerText();
  return new Set(text.match(ORDER_ID) ?? []).size;
}

/**
 * Opens the first listed order's detail view. A table row: through a Details/View/Open button or
 * link in it when it has one, else the row. A list that is not a table: its first order id.
 */
export async function openFirstRowDetail(page: any) {
  const row = page.locator("table tbody tr").first();
  if ((await row.count()) > 0) {
    const opener = row.getByRole("button", { name: /detail|view|open|show/i }).or(row.getByRole("link", { name: /detail|view|open|show/i }));
    if ((await opener.count()) > 0) await opener.first().click();
    else await row.click();
    return;
  }
  const root = page.locator("main, #root").first();
  const exact = root.getByText(/^\s*WO-\d{3}\s*$/);
  if ((await exact.count()) > 0) await exact.first().click();
  else await root.getByText(/WO-\d{3}/).first().click();
}
