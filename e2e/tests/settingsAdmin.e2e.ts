import { expect, test } from "@playwright/test";
import { PAIRED_PC_SETTINGS, signedSeed } from "../support/fixtures";
import { testids } from "../support/testids";

// Settings administration through the real UI: onboarding, branding,
// density, the API port field, trusted sources and logo validation.
// Account sync of these values is covered by library.e2e (F9-F11);
// this spec pins the admin interactions themselves.

test("onboarding welcomes a fresh install and routes onward", async ({
  browser,
}) => {
  const fresh = await signedSeed(browser, "onboard", {
    settings: { onboarding_done: null },
  });
  const page = await fresh.context.newPage();
  await page.goto("/");
  await expect(page.getByText("Welcome to PrintNinja")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Printing takes three steps:")).toBeVisible();
  await page.getByRole("button", { name: "Start printing" }).click();
  await expect(page).toHaveURL(/\/print$/);
});

test("settings admin: brand, density, API port, trusted sources, logo", async ({
  browser,
}) => {
  const seeded = await signedSeed(browser, "admin", {});
  const page = await seeded.context.newPage();
  await page.goto("/settings?section=general");
  await expect(page.getByTestId(testids.shellApp)).toBeVisible({
    timeout: 15_000,
  });

  // Brand name persists across reloads.
  await page.getByTestId(testids.settingsBrandName).fill("E2E Print Shop");
  await page.getByTestId(testids.settingsBrandName).press("Enter");
  await expect(page.getByText("Name saved")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId(testids.settingsBrandName)).toHaveValue(
    "E2E Print Shop",
  );

  // Density switches.
  const density = page.getByTestId(testids.settingsDensity);
  await density.getByRole("radio", { name: /Compact/ }).click();
  await expect(density.getByRole("radio", { name: /Compact/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );

  // Invalid logos are refused with a reason, not stored.
  await page.goto("/settings?section=general");
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByTestId(testids.settingsLogoUpload).click(),
  ]);
  await chooser.setFiles({
    name: "logo.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not an image"),
  });
  await expect(page.getByRole("alert")).toHaveText(
    "Use a PNG, JPEG, WebP, or SVG image.",
  );

  // API port through the UI, not raw invoke.
  await page.goto("/automation");
  await page.getByTestId(testids.settingsApiPort).fill("17799");
  await expect(page.getByTestId(testids.settingsApiPort)).toHaveValue("17799");

  // Desktop shows tray toggles instead of the Android service card.
  await page.goto("/settings?section=background");
  await expect(page.getByTestId(testids.settingsCloseToTray)).toBeVisible();
  await expect(page.getByTestId(testids.settingsBatteryExemption)).toHaveCount(
    0,
  );

  // Trusted sources add and remove.
  await page.goto("/automation?tab=links");
  await page.getByLabel("Trusted source").fill("pos.local");
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.getByText("pos.local")).toBeVisible();
  await page.getByRole("button", { name: "Remove pos.local" }).click();
  await expect(page.getByText("pos.local")).toBeHidden();
});

test("settings admin: shared-rendering phone pairs by code, tests, removes", async ({
  browser,
}) => {
  // A phone that is already paired reaches the shell; an unpaired one
  // can browse but printing redirects to /pair. Studio PC is a second pair.
  const seeded = await signedSeed(browser, "devices", {
    settings: PAIRED_PC_SETTINGS,
  });
  const page = await seeded.context.newPage();
  // The pair form is the phone half of Automation → PC, shown only on
  // Android; a PC shows the "Share this PC" half instead.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "userAgent", {
      get: () => "Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile",
    });
  });
  await page.goto("/automation?tab=phones");
  await expect(page.getByTestId(testids.shellApp)).toBeVisible({
    timeout: 15_000,
  });

  // A short code is refused before the backend is asked.
  await page.getByTestId(testids.devicesCodeInput).fill("K7Q");
  await expect(page.getByTestId(testids.devicesCodeSubmit)).toBeDisabled();

  // Characters outside the alphabet never reach the field.
  await page.getByTestId(testids.devicesCodeInput).fill("01oi");
  await expect(page.getByTestId(testids.devicesCodeInput)).toHaveValue("");
  await page.getByTestId(testids.devicesCodeInput).fill("k7qm-4xpd!!01");
  await expect(page.getByTestId(testids.devicesCodeInput)).toHaveValue(
    "K7QM4XPD",
  );

  // The e2e code pairs, and the canned provider proves it straight away.
  await page.getByTestId(testids.devicesCodeSubmit).click();
  const row = page.locator(`[data-testid^="${testids.devicesPairPrefix}"]`, {
    hasText: "Studio PC",
  });
  await expect(row).toBeVisible();
  await expect(row.getByText(/Score 800/)).toBeVisible();

  // A wrong code surfaces the backend's reason.
  await page.getByTestId(testids.devicesCodeInput).fill("AAAAAAAA");
  await page.getByTestId(testids.devicesCodeSubmit).click();
  await expect(page.getByRole("alert")).toContainText("Wrong code");

  // Test can be run again by hand.
  await row.getByRole("button", { name: "Test" }).click();
  await expect(row.getByText(/Score 800/)).toBeVisible();

  // Remove drops the pair. Scoped to the row: the Test button's
  // success toast still names the PC for a few seconds, which is
  // intended — it must not count as the pair surviving.
  await row.getByRole("button", { name: "Remove Studio PC" }).click();
  await expect(row).toBeHidden();
});

test("settings admin: shared-rendering manual address is tucked away but works", async ({
  browser,
}) => {
  const seeded = await signedSeed(browser, "devices-manual", {
    settings: PAIRED_PC_SETTINGS,
  });
  const page = await seeded.context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "userAgent", {
      get: () => "Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile",
    });
  });
  await page.goto("/automation?tab=phones");
  await expect(page.getByTestId(testids.shellApp)).toBeVisible({
    timeout: 15_000,
  });

  // Collapsed by default: the pairing path is the code search.
  await expect(page.getByTestId(testids.devicesAddrInput)).toBeHidden();
  await page.getByTestId(testids.devicesAdvanced).locator("summary").click();
  await page.getByTestId(testids.devicesAddrInput).fill("192.168.1.20:17717");
  await page.getByTestId(testids.devicesCodeInput).fill("K7QM4XPD");
  await page.getByTestId(testids.devicesCodeSubmit).click();
  await expect(
    page.locator(`[data-testid^="${testids.devicesPairPrefix}"]`, {
      hasText: "Studio PC",
    }),
  ).toBeVisible();
});
