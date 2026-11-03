import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { PAIRED_PC_SETTINGS, installAgent } from "../support/fixtures";
import { apiRegister } from "../support/api";
import { readStackState } from "../support/stack-state";
import { testids } from "../support/testids";

// The phone smoke spec. Runs on the two
// mobile projects (Pixel 7 at 390x844, small at 360x640), where the
// coarse-pointer rules and card layouts apply. Every route gets the same
// six checks: no sideways scrolling, vertical-only layout (no horizontal
// pan strips, no side-by-side form controls), 44px tap targets, a review
// screenshot, and an axe pass.
//
// Refreshing baselines after an intentional visual change:
//   pnpm --filter e2e exec playwright test --project=mobile-pixel7 --update-snapshots

const ROUTES = [
  "/templates",
  "/print",
  "/printers",
  "/history",
  "/automation",
  "/settings",
] as const;
// "/" rewrites to "/print" at boot (see startRoute.ts), so the Designer is
// covered separately below, through the real templates → Edit flow.

test.beforeEach(async ({ context }) => {
  // Same session shape as signedSeed, but on the project context so the
  // device viewport, touch, and mobile flags apply to every page.
  const auth = await apiRegister(
    `mobile-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
    "password123",
  );
  await installAgent(context, {
    settings: {
      onboarding_done: "true",
      share_service_url: readStackState().apiUrl,
      share_session_token: auth.token,
      // The Pixel 7 project reports an Android user agent, which opens
      // on the pairing gate unless a PC is already paired.
      ...PAIRED_PC_SETTINGS,
    },
    templates: [
      {
        name: "Mobile Label",
        server_id: crypto.randomUUID(),
        html: "<p>mobile</p>",
        sync_state: "synced",
      },
    ],
    printers: [{ name: "Mobile Zebra" }],
  });
  // Pin the update check to a newer release: the badge renders
  // deterministically (and gets tap-target/axe/screenshot coverage).
  await context.route("https://api.github.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        tag_name: "v9.9.9",
        html_url: "https://github.com/SAR-dev/PrintNinja/releases/tag/v9.9.9",
      }),
    }),
  );
});

interface SmallTarget {
  tag: string;
  role: string;
  name: string;
  w: number;
  h: number;
  html: string;
}

// Known exceptions to the 44px rule, each with a reason. Everything else
// fails the spec. (Empty by default: prefer fixing the target. Entries
// added only after triage, with the reason recorded here.)
const TAP_ALLOW_LIST: Array<{
  tag: string;
  role: string;
  name: RegExp;
  reason: string;
}> = [
  // The toggle track keeps the platform switch shape (44 wide, 24 tall).
  { tag: "button", role: "switch", name: /.*/, reason: "toggle shape" },
];

async function checkRoute(
  page: import("@playwright/test").Page,
  label: string,
  shotName: string,
) {
  await expect(page.getByRole("main")).toBeVisible({ timeout: 15_000 });
  // The mocked release is newer than the app: the badge links to it.
  const badge = page.getByRole("link", { name: "Update to v9.9.9" });
  await expect(badge).toBeVisible({ timeout: 15_000 });
  await expect(badge).toHaveAttribute(
    "href",
    "https://github.com/SAR-dev/PrintNinja/releases/tag/v9.9.9",
  );
  // Let debounced previews and share polling settle before measuring.
  await page.waitForTimeout(1000);

  // 1. Nothing scrolls sideways.
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(
    overflow.scrollWidth,
    `sideways scroll on ${label}: scrollWidth ${overflow.scrollWidth} > innerWidth ${overflow.innerWidth}`,
  ).toBeLessThanOrEqual(overflow.innerWidth);

  // 2. Vertical-only, part one: no element inside main is a horizontal pan
  //    strip (overflow-x auto/scroll with content wider than itself).
  const panStrips = await page.evaluate(() => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll("main *"))) {
      const style = getComputedStyle(el);
      if (!/^(auto|scroll)$/.test(style.overflowX)) continue;
      if (el.scrollWidth > el.clientWidth + 1) {
        const cls = (el as Element).getAttribute("class") || "";
        out.push(
          `${el.tagName.toLowerCase()}${cls ? ` .${cls.split(/\s+/).join(".")}` : ""} (overflow-x: ${style.overflowX})`,
        );
      }
    }
    return out;
  });
  expect(
    panStrips,
    `horizontal pan strips on ${label}: ${JSON.stringify(panStrips)}`,
  ).toEqual([]);

  // 3. Vertical-only, part two: two visible data-entry controls never
  //    share a row (side-by-side inputs are a desktop layout). One
  //    containing the other is not a row; buttons are excluded so an
  //    input with its own action button stays legal.
  const sideBySide = await page.evaluate(() => {
    const visible = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden")
        return false;
      return typeof el.checkVisibility === "function"
        ? el.checkVisibility()
        : true;
    };
    const controls = Array.from(
      document.querySelectorAll<HTMLElement>("input, select, textarea"),
    ).filter(visible);
    const out: string[] = [];
    for (let i = 0; i < controls.length; i++) {
      for (let j = i + 1; j < controls.length; j++) {
        const a = controls[i];
        const b = controls[j];
        if (a.contains(b) || b.contains(a)) continue;
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        const rowOverlap =
          Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        const gap = Math.max(ra.left, rb.left) - Math.min(ra.right, rb.right);
        if (rowOverlap > 4 && gap > 4) {
          const name = (el: HTMLElement) => el.name || el.id || "";
          out.push(
            `${a.tagName.toLowerCase()} "${name(a)}" beside ${b.tagName.toLowerCase()} "${name(b)}"`,
          );
        }
      }
    }
    return out;
  });
  expect(
    sideBySide,
    `side-by-side form controls on ${label}: ${JSON.stringify(sideBySide)}`,
  ).toEqual([]);

  // 4. Every visible button, link and tab is thumb-sized.
  const small = await page.evaluate((): SmallTarget[] => {
    const out: SmallTarget[] = [];
    for (const el of document.querySelectorAll("button, a, [role='tab']")) {
      const r = el.getBoundingClientRect();
      // Clipped helpers (the 1px skip link) are not tap targets.
      if (r.width < 2 || r.height < 2) continue;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      // Inline prose links are exempt from target size (WCAG 2.2).
      if (el.tagName.toLowerCase() === "a" && style.display === "inline")
        continue;
      if (
        typeof (el as Element).checkVisibility === "function" &&
        !(el as Element).checkVisibility()
      )
        continue;
      if (r.width < 44 || r.height < 44) {
        out.push({
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role") || "",
          name: (el.getAttribute("aria-label") || el.textContent || "")
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 60),
          w: Math.round(r.width),
          h: Math.round(r.height),
          html: el.outerHTML.slice(0, 300),
        });
      }
    }
    return out;
  });
  const unexpected = small.filter(
    (s) =>
      !TAP_ALLOW_LIST.some(
        (a) => s.tag === a.tag && s.role === a.role && a.name.test(s.name),
      ),
  );
  expect(
    unexpected,
    `undersized tap targets on ${label}: ${JSON.stringify(unexpected)}`,
  ).toEqual([]);

  // 5. Review screenshot (Playwright appends project and platform).
  await expect(page).toHaveScreenshot(shotName, {
    animations: "disabled",
    caret: "initial",
    scale: "css",
    maxDiffPixelRatio: 0.02,
  });

  // 6. Axe at the phone viewport (same rule disables as the unit pass).
  // The sandboxed preview iframes hold generated template output, not
  // app chrome; axe cannot message into the opaque origin and hangs,
  // so they are excluded from the run.
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
    `axe violations on ${label}`,
  ).toEqual([]);
}

for (const route of ROUTES) {
  test(`phone checks pass on ${route}`, async ({ page }) => {
    await page.goto(route);
    await checkRoute(page, route, `${route.slice(1)}.png`);
  });
}

test("phone checks pass on the designer", async ({ page }) => {
  // "/" rewrites to "/print", so reach the Designer through the real
  // templates → Edit flow instead.
  await page.goto("/templates");
  await expect(page.getByRole("main")).toBeVisible({ timeout: 15_000 });
  await page
    .getByRole("button", { name: "Actions for Mobile Label" })
    .dispatchEvent("pointerdown");
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await expect(page).toHaveURL(/\/template\/\d+/);

  // The phone Designer is a read-only viewer (PLAN §6, D4): the notice
  // and the section picker are on screen, and none of the editing
  // controls exist — no CodeMirror panes, no textareas.
  await expect(page.getByTestId(testids.designerPhoneNotice)).toBeVisible();
  await expect(page.getByTestId(testids.designerPhoneSections)).toBeVisible();
  await expect(page.locator("div.cm-editor")).toHaveCount(0);
  await expect(page.locator("textarea")).toHaveCount(0);

  await checkRoute(page, "designer", "designer.png");
});

// Phones have no room for the handle in the top bar, so the badge is an
// initial: tapping it opens Profile, and the More sheet names the account.
test("phone shows who is signed in and signs out from Profile", async ({
  page,
}) => {
  await page.goto("/print");
  await expect(page.getByRole("main")).toBeVisible({ timeout: 15_000 });

  // The More sheet names the account.
  await page.getByRole("button", { name: "More" }).click();
  await expect(page.getByTestId(testids.moreAccount)).toContainText(
    /Signed in as/,
    { timeout: 15_000 },
  );
  await page.keyboard.press("Escape");

  // The top-bar badge opens Profile, with sign out one tap away.
  await page.getByTestId(testids.topbarProfile).click();
  await expect(page).toHaveURL(/\/settings\?section=profile/);
  await expect(page.getByTestId(testids.profileHandle)).toBeVisible({
    timeout: 15_000,
  });
  await page.getByTestId(testids.profileSignOut).click();
  await expect(page.getByTestId(testids.signinForm)).toBeVisible({
    timeout: 15_000,
  });
});
