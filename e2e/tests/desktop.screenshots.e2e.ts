import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { signedSeed } from "../support/fixtures";

// Desktop visual-regression + axe floor. Mirrors the phone spec's
// screenshot + axe checks (mobile.mobile.e2e.ts) at the desktop viewport,
// in both themes, so a layout change in light or dark is caught on every
// page — not just on phones.
//
// Baselines mint per-platform in CI (the -linux baselines are font-bound to
// the runner); refresh them the same way as the phone spec:
//   pnpm --filter e2e exec playwright test desktop.screenshots --update-snapshots
//
// The Designer is not here: "/" rewrites to "/print" at boot, and reaching
// the real editor needs the templates -> Edit flow. Add it beside the phone
// designer test when a desktop designer baseline is wanted.

const ROUTES = [
  "/templates",
  "/print",
  "/printers",
  "/history",
  "/automation",
  "/devices",
  "/settings",
] as const;

for (const theme of ["light", "dark"] as const) {
  for (const route of ROUTES) {
    test(`${theme} desktop ${route}: screenshot and axe`, async ({
      browser,
    }) => {
      const seeded = await signedSeed(browser, `shots-${theme}`, {
        settings: { ui_theme: theme },
        printers: [{ name: "Desktop Zebra" }],
        templates: [
          {
            name: "Desktop Label",
            server_id: crypto.randomUUID(),
            html: "<p>desktop</p>",
            sync_state: "synced",
          },
        ],
      });
      const page = await seeded.context.newPage();
      await page.goto(route);
      await expect(page.getByRole("main")).toBeVisible({ timeout: 15_000 });
      // The theme lands on <html> asynchronously (PrefsProvider resolves the
      // ui_theme setting); wait for it so the screenshot is deterministic.
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme, {
        timeout: 15_000,
      });
      // Let debounced previews and share polling settle before measuring.
      await page.waitForTimeout(1000);

      // Review screenshot (Playwright appends project and platform).
      await expect(page).toHaveScreenshot(`${route.slice(1)}-${theme}.png`, {
        animations: "disabled",
        caret: "initial",
        scale: "css",
        maxDiffPixelRatio: 0.02,
      });

      // Axe at the desktop viewport (same rule disables as the phone pass).
      // The sandboxed preview iframes hold generated template output, not
      // app chrome; axe cannot message into the opaque origin, so they are
      // excluded.
      const results = await new AxeBuilder({ page })
        .disableRules(["color-contrast", "region"])
        .exclude("iframe[title='Canvas preview']")
        .exclude("iframe[title='Print preview']")
        .exclude("iframe[title='Template preview']")
        .analyze();
      expect(
        results.violations.flatMap((v) =>
          v.nodes.map(
            (n) => `${v.id} @ ${n.target.join(" ")} :: ${n.html.slice(0, 500)}`,
          ),
        ),
        `axe violations on ${theme} ${route}`,
      ).toEqual([]);

      await seeded.context.close();
    });
  }
}
