import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { signedSeed } from "../support/fixtures";

// Desktop layout + axe floor. Mirrors the phone spec's structural checks
// (mobile.mobile.e2e.ts) at the desktop viewport, in both themes, so a
// broken layout in light or dark is caught on every page — not just on
// phones. Checks are DOM- and metric-based, never pixel baselines: they
// run identically on every runner and need no refresh dance.
//
// The Designer is not here: "/" rewrites to "/print" at boot, and reaching
// the real editor needs the templates -> Edit flow. Add it beside the phone
// designer test when a desktop designer check is wanted.

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
    test(`${theme} desktop ${route}: layout and axe`, async ({ browser }) => {
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
      // ui_theme setting); assert it so both palettes are really exercised.
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme, {
        timeout: 15_000,
      });
      // Data-driven pages mount their h1 after the first load; wait for it
      // so axe sees the same settled DOM the user sees.
      await expect(page.locator("h1")).toBeVisible({ timeout: 15_000 });

      // Layout floor instead of a pixel baseline: a sideways scroll catches
      // a blown-wide page without depending on the runner's fonts.
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(
        overflow.scrollWidth,
        `sideways scroll on desktop ${theme} ${route}: ${overflow.scrollWidth} > ${overflow.innerWidth}`,
      ).toBeLessThanOrEqual(overflow.innerWidth + 1);

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
