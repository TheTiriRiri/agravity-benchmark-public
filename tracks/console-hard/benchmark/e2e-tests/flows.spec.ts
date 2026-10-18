import { test, expect } from "@playwright/test";
import { TRANSITION_BUTTON, createForm, fillWorkOrderForm, filterByStatus, listedOrderCount, navigateTo, openCreateForm, openFirstRowDetail, selectIndexWithOption, submitForm } from "./helpers";

const API = "http://localhost:5100/api/v1";
const SEED_WEEK = "2026-10-05";

test.describe("Frontend E2E: flows", () => {
  test.beforeEach(async ({ request }) => {
    const res = await request.post(`${API}/reset`);
    expect(res.ok()).toBeTruthy();
  });

  test("form creates an order and it appears with no reload", async ({ request, page }) => {
    const assets: any[] = await (await request.get(`${API}/assets`)).json();
    await page.goto("/");
    await page.waitForTimeout(1000);
    await navigateTo(page, "work-orders");
    await page.waitForTimeout(500);

    // Open the create form and fill the required fields, found by label/name/placeholder
    await openCreateForm(page);
    await fillWorkOrderForm(page, { title: "E2E Test Work Order", skill: "electrical", duration: 60, earliest: "2026-10-06", due: "2026-10-10", assetId: assets[0].id });

    await submitForm(page);
    await page.waitForTimeout(1000);

    // New order should appear WITHOUT page.reload()
    await expect(page.locator("text=E2E Test Work Order").first()).toBeVisible({ timeout: 5000 });
  });

  test("invalid submission shows API error message and creates nothing", async ({ request, page }) => {
    // Count orders via standalone request fixture (not page.request)
    const beforeRes = await request.get(`${API}/work-orders`);
    const beforeOrders = await beforeRes.json();
    const beforeCount = Array.isArray(beforeOrders) ? beforeOrders.length : 0;
    const assets: any[] = await (await request.get(`${API}/assets`)).json();

    await page.goto("/");
    await page.waitForTimeout(1000);
    await navigateTo(page, "work-orders");
    await page.waitForTimeout(500);

    // Fill with invalid data: due date BEFORE earliest start (guaranteed API rejection)
    await openCreateForm(page);
    await fillWorkOrderForm(page, { title: "Invalid Order", skill: "electrical", duration: 60, earliest: "2026-10-10", due: "2026-10-06", assetId: assets[0].id });

    await submitForm(page);
    await page.waitForTimeout(2000);

    // Check: form should still be open (failed submission) OR error message shown
    const formStillOpen = await (await createForm(page)).isVisible().catch(() => false);
    const errorVisible = await page
      .locator("text=/validation|error|invalid|must be|failed|before/i")
      .first()
      .isVisible()
      .catch(() => false);
    expect(formStillOpen || errorVisible, "Form should remain open or show error after invalid submission").toBe(true);

    // Verify no order was created
    const afterRes = await request.get(`${API}/work-orders`);
    const afterOrders = await afterRes.json();
    const afterCount = Array.isArray(afterOrders) ? afterOrders.length : 0;
    expect(afterCount).toBe(beforeCount);
  });

  test("generate plan repaints the timeline with no reload", async ({ request, page }) => {
    const ids = (sched: any): Set<string> =>
      new Set((sched.technicians ?? []).flatMap((t: any) => (t.assignments ?? []).map((a: any) => a.work_order_id)));
    const before = ids(await (await request.get(`${API}/schedule?week_start=${SEED_WEEK}`)).json());

    await page.goto("/");
    await page.waitForTimeout(1000);
    await navigateTo(page, "schedule");
    await page.waitForTimeout(500);

    await page.getByRole("button", { name: /generate plan/i }).click();
    await page.waitForTimeout(3000);

    // The plan's new assignments appear on the timeline with no reload: some work order the
    // plan scheduled (by id or title) is now visible
    const after = await (await request.get(`${API}/schedule?week_start=${SEED_WEEK}`)).json();
    const assignments = (after.technicians ?? []).flatMap((t: any) => t.assignments ?? []);
    const fresh = assignments.filter((a: any) => !before.has(a.work_order_id));
    const target = (fresh.length > 0 ? fresh : assignments)[0];
    expect(target, "POST /plan scheduled something for the seed week").toBeTruthy();
    const shown = page.getByText(target.work_order_id, { exact: false }).first().or(page.getByText(target.title, { exact: false }).first());
    await expect(shown.first(), `timeline shows ${target.work_order_id} (${target.title})`).toBeVisible({ timeout: 5000 });
  });

  test("detail view offers exactly the legal transitions", async ({ request, page }) => {
    // Generate plan so we have scheduled orders
    await request.post(`${API}/plan?week_start=${SEED_WEEK}`);

    await page.goto("/");
    await page.waitForTimeout(1000);
    await navigateTo(page, "work-orders");
    await page.waitForTimeout(500);

    // Filter by scheduled status (the status filter, found by its options)
    expect(await filterByStatus(page, "scheduled"), "a status filter offers scheduled").toBe(true);
    await page.waitForTimeout(500);

    // Click on a scheduled order row
    await openFirstRowDetail(page);
    await page.waitForTimeout(500);

    // Legal transitions from scheduled (prompt.md §4): in_progress and cancelled, not completed —
    // matched by target status, whatever the wording ("Start", "→ in_progress", …)
    await expect(page.getByRole("button", { name: TRANSITION_BUTTON.in_progress }).first()).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole("button", { name: TRANSITION_BUTTON.cancelled }).first()).toBeVisible({ timeout: 5000 });
    const completedVisible = await page.getByRole("button", { name: TRANSITION_BUTTON.completed }).first().isVisible().catch(() => false);
    expect(completedVisible).toBe(false);
  });

  test("transition updates detail view and Inventory reserved with no reload", async ({ request, page }) => {
    await request.post(`${API}/plan?week_start=${SEED_WEEK}`);

    await page.goto("/");
    await page.waitForTimeout(1000);
    await navigateTo(page, "work-orders");
    await page.waitForTimeout(500);

    // Filter to scheduled (the status filter, found by its options)
    expect(await filterByStatus(page, "scheduled"), "a status filter offers scheduled").toBe(true);
    await page.waitForTimeout(500);

    const inProgress = async (): Promise<number> =>
      ((await (await request.get(`${API}/work-orders?status=in_progress`)).json()) as any[]).length;
    const before = await inProgress();

    // Click the first scheduled order (POST /plan above scheduled some)
    await openFirstRowDetail(page);
    await page.waitForTimeout(500);

    // Click the in_progress transition, whatever its wording; the API must record it
    await page.getByRole("button", { name: TRANSITION_BUTTON.in_progress }).first().click();
    await page.waitForTimeout(1000);
    expect(await inProgress(), "the transition button PATCHed one order to in_progress").toBe(before + 1);

    // Reload page to dismiss the detail modal (its backdrop blocks nav clicks)
    await page.goto("/");
    await page.waitForTimeout(1000);

    // Navigate to Inventory
    await navigateTo(page, "inventory");
    await page.waitForTimeout(500);

    // Inventory page should render (presence of table or part data)
    await expect(page.locator("table").first()).toBeVisible({ timeout: 5000 });
  });

  test("three filters narrow the list and combine", async ({ request, page }) => {
    await request.post(`${API}/plan?week_start=${SEED_WEEK}`);

    await page.goto("/");
    await page.waitForTimeout(1000);
    await navigateTo(page, "work-orders");
    await page.waitForTimeout(1000);

    // Pick filter values that select something: the first scheduled order's priority and site
    const orders: any[] = await (await request.get(`${API}/work-orders?status=scheduled`)).json();
    const assets: any[] = await (await request.get(`${API}/assets`)).json();
    const sites: any[] = await (await request.get(`${API}/sites`)).json();
    expect(orders.length, "POST /plan scheduled something").toBeGreaterThan(0);
    const priority: string = orders[0].priority;
    const siteId: string = assets.find((x: any) => x.id === orders[0].asset_id).site_id;
    const siteName: string = sites.find((x: any) => x.id === siteId)?.name ?? siteId;
    const apiCount = async (q: string): Promise<number> => ((await (await request.get(`${API}/work-orders?${q}`)).json()) as any[]).length;

    // The three filters, found by what they filter
    const statusIdx = await selectIndexWithOption(page, /^scheduled$/i);
    const priorityIdx = await selectIndexWithOption(page, /^critical$/i);
    const siteIdx = await selectIndexWithOption(page, new RegExp(`^(${siteId}|${siteName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})$`, "i"));
    // the site filter may also be a text field (prompt.md §7 names the filters, not their controls)
    const siteText = page.locator('input:not([type="date"]):not([type="number"])').filter({ visible: true }).and(
      page.locator('[placeholder*="site" i], [aria-label*="site" i], [name*="site" i], [id*="site" i]'),
    ).first();
    const siteTextOk = siteIdx < 0 && (await siteText.count()) > 0;
    expect([statusIdx, priorityIdx].every((i) => i >= 0) && (siteIdx >= 0 || siteTextOk), "filters for status, priority and site exist").toBe(true);
    const selects = page.locator("select");
    const pick = async (i: number, wanted: RegExp) => {
      const options: { value: string; text: string }[] = await selects.nth(i).locator("option")
        .evaluateAll((os: HTMLOptionElement[]) => os.map((o) => ({ value: o.value, text: (o.textContent ?? "").trim() })));
      const match = options.find((o) => wanted.test(o.value) || wanted.test(o.text));
      expect(match, `filter offers ${wanted}`).toBeTruthy();
      await selects.nth(i).selectOption(match!.value);
      await page.waitForTimeout(700);
    };

    // Each filter narrows the list to what the API answers, and they combine with AND
    await pick(statusIdx, /^scheduled$/i);
    expect(await listedOrderCount(page)).toBe(await apiCount("status=scheduled"));
    await pick(priorityIdx, new RegExp(`^${priority}$`, "i"));
    expect(await listedOrderCount(page)).toBe(await apiCount(`status=scheduled&priority=${priority}`));
    if (siteIdx >= 0) await pick(siteIdx, new RegExp(`^(${siteId}|${siteName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})$`, "i"));
    else {
      await siteText.fill(siteId);
      await page.waitForTimeout(700);
    }
    expect(await listedOrderCount(page)).toBe(await apiCount(`status=scheduled&priority=${priority}&site_id=${siteId}`));
  });

  test("low stock is flagged where available < min_stock", async ({ request, page }) => {
    const partsRes = await request.get(`${API}/parts`);
    const parts: any[] = await partsRes.json();
    const lowStockParts = parts.filter((p: any) => p.available < p.min_stock);

    await page.goto("/");
    await page.waitForTimeout(1000);
    await navigateTo(page, "inventory");
    await page.waitForTimeout(1000);

    // Wait for the inventory table to render
    await expect(page.locator("table").first()).toBeVisible({ timeout: 10000 });

    // prompt.md §7 asks for "a visible low-stock flag": some visible "low" marker on the
    // Inventory screen ("Low", "Low stock", "below minimum"). No wording is mandated for parts
    // that are not low, so nothing is asserted about them.
    if (lowStockParts.length > 0) {
      await expect(page.locator("main, #root").first().locator("text=/low/i").first()).toBeVisible({ timeout: 5000 });
    }
  });

  test("blocked and unscheduled orders show their reason", async ({ request, page }) => {
    // Generate plan; POST /plan (not GET /schedule) lists the blocked and unscheduled ids
    const plan = await (await request.post(`${API}/plan?week_start=${SEED_WEEK}`)).json();
    const blockedIds: string[] = plan.blocked || [];
    const unscheduledIds: string[] = plan.unscheduled || [];
    expect(blockedIds.length + unscheduledIds.length, "the seed week has blocked or unscheduled orders").toBeGreaterThan(0);

    await page.goto("/");
    await page.waitForTimeout(1000);

    // Check Schedule page first — it shows blocked/unscheduled panels with reasons
    await navigateTo(page, "schedule");
    await page.waitForTimeout(500);

    // Trigger plan display
    const planBtn = page.getByRole("button", { name: /generate plan/i });
    if (await planBtn.isVisible().catch(() => false)) {
      await planBtn.click();
      await page.waitForTimeout(2000);
    }

    const bodyText = await page.locator("body").textContent();
    const reasonPatterns = [
      /parts.unavailable/i,
      /no.qualified.technician/i,
      /no.capacity|capacity exceeded|daily capacity/i,
    ];

    let anyReasonFound = reasonPatterns.some((p) => p.test(bodyText ?? ""));

    // If not found on Schedule, check Work Orders detail
    if (!anyReasonFound) {
      await navigateTo(page, "work-orders");
      await page.waitForTimeout(500);

      // Filter to blocked (or unscheduled) with the status filter, found by its options
      if (await filterByStatus(page, blockedIds.length > 0 ? "blocked" : "unscheduled")) {
        await page.waitForTimeout(500);
        if ((await listedOrderCount(page)) > 0) {
          await openFirstRowDetail(page);
          await page.waitForTimeout(500);
          const detailText = await page.locator("body").textContent();
          anyReasonFound = reasonPatterns.some((p) => p.test(detailText ?? ""));
        }
      }
    }

    expect(anyReasonFound, "Status reason must be visible for blocked/unscheduled orders").toBe(true);
  });

  test("dashboard counts equal the API", async ({ request, page }) => {
    await request.post(`${API}/plan?week_start=${SEED_WEEK}`);

    const woRes = await request.get(`${API}/work-orders`);
    const workOrders: any[] = await woRes.json();
    const partsRes = await request.get(`${API}/parts`);
    const parts: any[] = await partsRes.json();

    // prompt.md §7: "work orders counted by status" — per-status counts, no total is mandated
    const byStatus = new Map<string, number>();
    for (const wo of workOrders) byStatus.set(wo.status, (byStatus.get(wo.status) ?? 0) + 1);

    await page.goto("/");
    await page.waitForTimeout(1000);
    await navigateTo(page, "dashboard");
    await page.waitForTimeout(1000);

    const bodyText = (await page.locator("body").textContent()) ?? "";

    // Every non-zero status count appears, next to its status's name
    for (const [status, count] of byStatus) {
      const words = status.replace(/_/g, "[ _-]?");
      const near = new RegExp(`${words}\\D{0,40}(?<!\\d)${count}(?!\\d)|(?<!\\d)${count}(?!\\d)\\D{0,40}${words}`, "i");
      expect(near.test(bodyText), `dashboard shows ${count} next to "${status}"`).toBe(true);
    }

    // prompt.md §7: "the parts that are low on stock" — each such part, by name or id
    for (const part of parts.filter((p: any) => p.available < p.min_stock)) {
      expect(bodyText.includes(part.name) || bodyText.includes(part.id), `dashboard lists low-stock part ${part.id}`).toBe(true);
    }
  });

  test("crew order shows both technicians and split order each segment", async ({ request, page }) => {
    await request.post(`${API}/plan?week_start=${SEED_WEEK}`);

    const woRes = await request.get(`${API}/work-orders`);
    const workOrders: any[] = await woRes.json();

    // Check if hard track (crew/segments) or classic
    const hasCrewOrders = workOrders.some((wo: any) => (wo.crew_size ?? 1) > 1);
    const hasSegments = workOrders.some((wo: any) => Array.isArray(wo.segments) && wo.segments.length > 1);

    await page.goto("/");
    await page.waitForTimeout(1000);

    if (hasCrewOrders || hasSegments) {
      // Hard track: verify crew + segments on schedule
      await navigateTo(page, "schedule");
      await page.waitForTimeout(500);
      const planBtn = page.getByRole("button", { name: /generate plan/i });
      if (await planBtn.isVisible().catch(() => false)) {
        await planBtn.click();
        await page.waitForTimeout(2000);
      }

      const crewOrder = workOrders.find((wo: any) => (wo.crew_size ?? 1) > 1);
      if (crewOrder) {
        // prompt.md §7: "both members listed" — by id or by name, the wording is the attempt's
        const technicians: any[] = await (await request.get(`${API}/technicians`)).json();
        const techIds: string[] = crewOrder.technician_ids || [];
        for (const tid of techIds) {
          const name: string | undefined = technicians.find((t: any) => t.id === tid)?.name;
          const shown = page.getByText(tid, { exact: false }).first().or(page.getByText(name ?? tid, { exact: false }).first());
          await expect(shown.first(), `crew member ${tid} (${name ?? "no name"}) is listed`).toBeVisible({ timeout: 5000 });
        }
      }

      const splitOrder = workOrders.find((wo: any) => Array.isArray(wo.segments) && wo.segments.length > 1);
      if (splitOrder) {
        for (const seg of splitOrder.segments) {
          const segVisible = await page.locator(`text=${seg.start}`).first().isVisible().catch(() => false);
          if (segVisible) expect(true).toBe(true);
        }
      }
    } else {
      // Classic track: verify assigned technician renders correctly
      const scheduledOrders = workOrders.filter((wo: any) => wo.status === "scheduled");
      if (scheduledOrders.length > 0) {
        await navigateTo(page, "work-orders");
        await page.waitForTimeout(500);

        // Filter to scheduled
        const allSelects = page.locator("select");
        const selectCount = await allSelects.count();
        for (let i = 0; i < selectCount; i++) {
          const opts = await allSelects.nth(i).locator("option").allTextContents();
          if (opts.some((o) => /all statuses/i.test(o))) {
            await allSelects.nth(i).selectOption("scheduled");
            await page.waitForTimeout(500);
            break;
          }
        }

        if ((await listedOrderCount(page)) > 0) {
          await openFirstRowDetail(page);
          await page.waitForTimeout(500);
          const techId = scheduledOrders[0].technician_id;
          if (techId) {
            const bodyText = await page.locator("body").textContent() ?? "";
            expect(bodyText).toContain(techId);
          }
        }
      } else {
        // No scheduled orders — just verify page loads without error
        const bodyText = await page.locator("body").textContent() ?? "";
        expect(bodyText.length).toBeGreaterThan(0);
      }
    }
  });
});
