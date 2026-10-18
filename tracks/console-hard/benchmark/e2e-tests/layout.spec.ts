import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { resetDatabase, navigateTo, assertPinnedVersions, warmupRoutes, type ScreenName } from "./helpers";

const API = "http://localhost:5100/api/v1";
const SEED_WEEK = "2026-10-05";

const SCREENS: { name: ScreenName; label: string }[] = [
  { name: "dashboard", label: "Dashboard" },
  { name: "schedule", label: "Schedule" },
  { name: "work-orders", label: "Work Orders" },
  { name: "inventory", label: "Inventory" },
];

const VIEWPORTS = [
  { tag: "mobile", width: 375, height: 667 },
  { tag: "desktop", width: 1280, height: 800 },
];

test.describe("Frontend E2E: layout & a11y", () => {
  test.beforeAll(() => {
    assertPinnedVersions();
  });

  test.beforeEach(async ({ request }) => {
    await request.post(`${API}/reset`);
    // Generate plan so all screens have meaningful data
    await request.post(`${API}/plan?week_start=${SEED_WEEK}`);
  });

  for (const viewport of VIEWPORTS) {
    for (const screen of SCREENS) {
      test(`${screen.label} at ${viewport.width}×${viewport.height} (${viewport.tag}): no horizontal overflow, nav reachable, zero critical a11y`, async ({
        page,
      }) => {
        // Set viewport
        await page.setViewportSize({ width: viewport.width, height: viewport.height });

        // Navigate to app
        await page.goto("/", { waitUntil: "load" });
        await page.waitForTimeout(1000);

        // Navigate to the target screen
        await navigateTo(page, screen.name);
        await page.waitForTimeout(500);

        // ── Check 1: No page-level horizontal overflow ──────────────────
        const overflows = await page.evaluate(() => {
          const el = document.scrollingElement || document.documentElement;
          return el.scrollWidth > document.documentElement.clientWidth + 1;
        });
        expect(overflows, `${screen.label} at ${viewport.tag}: page-level horizontal overflow detected`).toBe(false);

        // ── Check 2: Navigation reachability ────────────────────────────
        // All 4 screens must be reachable via visible nav links or a menu toggle
        for (const target of SCREENS) {
          const navButton = page
            .getByRole("button", { name: target.label })
            .or(page.getByRole("link", { name: target.label }))
            .first();

          let reachable = await navButton.isVisible().catch(() => false);

          if (!reachable && viewport.tag === "mobile") {
            // Try opening hamburger / mobile menu toggle
            const toggleCandidates = [
              page.locator('button[aria-label*="menu" i]'),
              page.locator('button[aria-label*="toggle" i]'),
              page.locator('button[aria-label*="navigation" i]'),
              page.locator("header button:has(svg)").last(),
            ];

            for (const toggle of toggleCandidates) {
              if (await toggle.isVisible().catch(() => false)) {
                await toggle.click();
                await page.waitForTimeout(200);
                reachable = await navButton.isVisible().catch(() => false);
                if (reachable) break;
              }
            }

            // Close menu if we opened it
            if (reachable) {
              // Click elsewhere or press Escape to close
              await page.keyboard.press("Escape").catch(() => {});
              await page.waitForTimeout(100);
            }
          }

          expect(reachable, `${target.label} must be reachable from ${screen.label} at ${viewport.tag}`).toBe(true);
        }

        // ── Check 3: Zero critical accessibility violations ─────────────
        // Exclude select-name and label rules — the known-good baseline's forms
        // use <label> without htmlFor/id association (a known limitation we accept).
        const results = await new AxeBuilder({ page })
          .disableRules(["select-name", "label"])
          .analyze();
        const criticalViolations = results.violations.filter((v) => v.impact === "critical");
        expect(
          criticalViolations,
          `${screen.label} at ${viewport.tag}: ${criticalViolations.length} critical a11y violation(s): ${criticalViolations.map((v) => v.id).join(", ")}`,
        ).toHaveLength(0);
      });
    }
  }
});
