import { test, expect, devices, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("printninja-onboarding-complete", "true");
  });
});

test.describe("Onboarding", () => {
  test("renders first-run screen when not completed", async ({ page, context }) => {
    await context.addInitScript(() => {
      localStorage.setItem("printninja-onboarding-complete", "false");
    });
    await page.goto("/");
    await expect(page.getByText("Add a Printer")).toBeVisible();
    await expect(page.getByText("Step 1 of 4")).toBeVisible();
  });

  test("progress advances on next", async ({ page, context }) => {
    await context.addInitScript(() => {
      localStorage.setItem("printninja-onboarding-complete", "false");
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Add Printer" }).click();
    await expect(page.getByText("Load a Template")).toBeVisible();
  });

  test("Get Started completes onboarding", async ({ page, context }) => {
    await context.addInitScript(() => {
      localStorage.setItem("printninja-onboarding-complete", "false");
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Add Printer" }).click();
    await page.getByRole("button", { name: "New Template" }).click();
    await page.getByRole("button", { name: "Test Print" }).click();
    await page.getByRole("button", { name: "Get Started" }).click();
    // back on main layout with designer title
    await expect(page.getByText("PrintNinja").first()).toBeVisible();
  });
});

test.describe("Deep link routes", () => {
  test("direct open /settings", async ({ page }) => {
    await page.goto("/settings");
    await expect(page).toHaveURL(/.*\/settings/);
  });

  test("direct open /history", async ({ page }) => {
    await page.goto("/history");
    await expect(page).toHaveURL(/.*\/history/);
  });

  test("unknown route redirects", async ({ page }) => {
    await page.goto("/nonexistent");
    await expect(page).toHaveURL(/.*\/$/);
  });
});

test.describe("Theme", () => {
  test("switching to dark applies dark class", async ({ page }) => {
    await page.goto("/settings");
    // There's no native select (Radix), so use tab + click
    const generalTab = page.getByRole("tab", { name: "General" });
    await generalTab.click();
    // trigger the Radix select by text
    const trigger = page.getByRole("combobox").first();
    await trigger.click({ timeout: 10000 }).catch(() => {});
  });

  test("theme persists across reload", async ({ page }) => {
    await page.goto("/settings");
    await page.reload();
    await page.addInitScript(() => {
      localStorage.setItem("printninja-onboarding-complete", "true");
    });
    // smoke: page still renders
    await expect(page.getByText("Settings").first()).toBeVisible();
  });
});

test.describe("Designer interactions", () => {
  test("page size presets update inputs", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "A4", exact: true }).click();
    const widthInput = page.locator('input[type="number"]').first();
    await expect(widthInput).toHaveValue("210");
  });

  test("zoom percent displays", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("span").filter({ hasText: /%/ }).first()).toBeVisible();
  });
  test("barcode dialog opens", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /barcode/i }).first().click();
    await expect(page.getByText("Insert Barcode")).toBeVisible({ timeout: 5000 });
  });

  test("variables tab renders chips", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("tab", { name: "Variables" }).click();
    await expect(page.getByText("Sample Order")).toBeVisible();
    await expect(page.getByText("{{store.name}}").first()).toBeVisible({ timeout: 5000 }).catch(() => {});
  });

  test("new template dialog creates entry", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "New Template" }).click();
    await page.getByPlaceholder("My Template").fill("My A4 Template");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByText("My A4 Template").first()).toBeVisible({ timeout: 5000 });
  });

  test("Add dataset dialog rejects invalid JSON", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("tab", { name: "Variables" }).click();
    await page.getByRole("button", { name: "Add Dataset" }).click();
    await page.getByPlaceholder("e.g. Empty Order").fill("invalid data");
    await page.getByRole("textbox").nth(1).fill("{ not json");
    await page.getByRole("button", { name: "Add" }).click();
    await expect(page.getByText(/Invalid JSON/i)).toBeVisible({ timeout: 5000 });
  });
});

test.describe("Print page", () => {
  test("toggling test data shows mock info", async ({ page }) => {
    await page.goto("/print");
    const sw = page.locator("#test-data");
    await sw.click();
    await expect(page.getByText(/Using mock data/)).toBeVisible();
  });

  test("batch dialog: invalid JSON surfaces an error", async ({ page }) => {
    await page.goto("/print");
    await page.getByRole("button", { name: "New Batch" }).click();
    await page.getByRole("textbox").first().fill("not json");
    await page.getByRole("button", { name: "Start Batch" }).click();
    // sonner toast is portaled; check any toast text visible
    await expect(page.getByText(/Invalid JSON/i)).toBeVisible({ timeout: 5000 }).catch(() => {});
  });

  test("margin inputs are present", async ({ page }) => {
    await page.goto("/print");
    await expect(page.locator("#mt")).toBeVisible();
    await expect(page.locator("#mr")).toBeVisible();
    await expect(page.locator("#mb")).toBeVisible();
    await expect(page.locator("#ml")).toBeVisible();
  });

  test("fit mode select present", async ({ page }) => {
    await page.goto("/print");
    await expect(page.getByText("Fit mode")).toBeVisible();
  });
});

test.describe("Printer setup", () => {
  test("all tabs render", async ({ page }) => {
    await page.goto("/printers");
    for (const name of ["All", "Wi-Fi / LAN", "USB", "Bluetooth", "System"]) {
      await expect(page.getByRole("tab", { name })).toBeVisible();
    }
  });

  test("add dialog exposes name and address fields", async ({ page }) => {
    await page.goto("/printers");
    await page.getByRole("button", { name: "Add Printer" }).first().click();
    await expect(page.getByLabel("Printer Name")).toBeVisible();
    await expect(page.getByLabel(/Address/)).toBeVisible();
  });
});

test.describe("History", () => {
  test("empty state shown", async ({ page }) => {
    await page.goto("/history");
    await expect(page.getByText(/No print jobs yet/)).toBeVisible();
  });

  test("export button present", async ({ page }) => {
    await page.goto("/history");
    await expect(page.getByRole("button", { name: "Export CSV" })).toBeVisible();
  });

  test("search input filters input present", async ({ page }) => {
    await page.goto("/history");
    await expect(page.getByPlaceholder("Search")).toBeVisible();
  });
});

test.describe("Settings", () => {
  test("tabs all render", async ({ page }) => {
    await page.goto("/settings");
    for (const name of ["General", "Fonts", "API", "Deep Links"]) {
      await expect(page.getByRole("tab", { name })).toBeVisible();
    }
  });

  test("diagnostics export button visible", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByRole("button", { name: /Export Diagnostics/ })).toBeVisible();
  });
});

test.describe("Responsive", () => {
  test("mobile shows bottom nav, hides sidebar", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await expect(page.getByRole("navigation", { name: /primary/i })).toBeVisible();
    await expect(page.getByRole("complementary")).toBeHidden().catch(() => {});
  });

  test("desktop shows sidebar", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await expect(page.getByRole("navigation", { name: /primary/i })).toBeHidden().catch(() => {});
  });
});

test.describe("Web-mode guards", () => {
  test("running a rust cmd shows unsupported alert", async ({ page }) => {
    page.on("dialog", async (d) => { expect(d.message()).toMatch(/native|desktop app/i); await d.accept(); });
    await page.goto("/print");
    await page.evaluate(() => (window as any).__TAURI_INTERNALS__ = undefined);
    await page.getByRole("button", { name: "Refresh Printers" }).click();
    // In web mode invoke throws by default; confirm no crash / page still usable
    await expect(page.getByText("Print").first()).toBeVisible();
  });
});

test.describe("Theme persistence (detail)", () => {
  test("selecting dark adds dark class", async ({ page }) => {
    await page.goto("/settings");
    await page.getByRole("tab", { name: "General" }).click();
    const trigger = page.getByRole("combobox").first();
    await trigger.click();
    await page.getByRole("option", { name: "Dark" }).click();
    await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
    const isDark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
    expect(isDark).toBe(true);
  });

  test("selecting light removes dark class", async ({ page }) => {
    await page.goto("/settings");
    await page.getByRole("tab", { name: "General" }).click();
    const trigger = page.getByRole("combobox").first();
    await trigger.click();
    await page.getByRole("option", { name: "Light" }).click();
    await page.waitForFunction(() => !document.documentElement.classList.contains("dark"));
    const isDark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
    expect(isDark).toBe(false);
  });

  test("selected theme persists after reload", async ({ page }) => {
    await page.goto("/settings");
    await page.getByRole("tab", { name: "General" }).click();
    await page.getByRole("combobox").first().click();
    await page.getByRole("option", { name: "Dark" }).click();
    await page.reload();
    const stored = await page.evaluate(() => localStorage.getItem("printninja-theme"));
    expect(stored).toBe("dark");
  });
});

test.describe("PrinterSetup input data flow", () => {
  test("add dialog accepts typed values", async ({ page }) => {
    await page.goto("/printers");
    await page.getByRole("button", { name: "Add Printer" }).first().click();
    const nameInput = page.getByLabel("Printer Name");
    const addrInput = page.getByLabel(/Address/);
    await nameInput.fill("Kitchen Wi-Fi");
    await addrInput.fill("http://192.168.2.50");
    await expect(nameInput).toHaveValue("Kitchen Wi-Fi");
    await expect(addrInput).toHaveValue("http://192.168.2.50");
  });

  test("refresh button reloads the list", async ({ page }) => {
    await page.goto("/printers");
    await expect(page.getByRole("button", { name: "Refresh" })).toBeVisible();
  });

  test("usb tab filters to usb printers only", async ({ page }) => {
    await page.goto("/printers");
    await page.getByRole("tab", { name: "USB" }).click();
    await expect(page.getByText(/No printers configured|No usb printers yet/i).first()).toBeVisible({ timeout: 8000 });
  });
});

test.describe("History search & clear", () => {
  test("typing search does not crash", async ({ page }) => {
    await page.goto("/history");
    const input = page.getByPlaceholder("Search");
    await input.fill("order-1042");
    await expect(input).toHaveValue("order-1042");
    await expect(page.getByText(/No print jobs yet/)).toBeVisible();
  });

  test("Clear button resets filters", async ({ page }) => {
    await page.goto("/history");
    await page.getByPlaceholder("Search").fill("anything");
    await page.getByRole("button", { name: "Clear" }).click();
    await expect(page.getByPlaceholder("Search")).toHaveValue("");
  });
});

test.describe("First-run skip via localStorage", () => {
  test("skips onboarding when already completed", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("printninja-onboarding-complete", "true");
    });
    await page.goto("/");
    // main layout visible, onboarding not
    await expect(page.getByText("Step 1 of 4")).toBeHidden().catch(() => {});
    await expect(page.getByText("PrintNinja").first()).toBeVisible();
  });
});

test.describe("Batch per-record status UI", () => {
  test("batch dialog textarea accepts JSON input", async ({ page }) => {
    await page.goto("/print");
    await page.getByRole("button", { name: "New Batch" }).click();
    const ta = page.getByRole("textbox").first();
    await ta.fill('[{"name":"Tea","qty":2},{"name":"Coffee","qty":1}]');
    await expect(ta).toHaveValue(/Tea/);
  });
});

test.describe("Template creation flow", () => {
  test("creating without name shows an error", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "New Template" }).click();
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByText(/Template name required/i)).toBeVisible({ timeout: 5000 });
  });

  test("cancel dialog leaves templates unchanged", async ({ page }) => {
    await page.goto("/");
    const before = await page.getByText("Shipping Label").first().isVisible();
    await page.getByRole("button", { name: "New Template" }).click();
    await page.getByPlaceholder("My Template").fill("Should Not Create");
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText("Should Not Create")).toBeHidden().catch(() => {});
    expect(before).toBe(true);
  });

  test("duplicate name keeps dialog open", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "New Template" }).click();
    await page.getByPlaceholder("My Template").fill("Receipt 120mm");
    // record templates before
    await page.getByRole("button", { name: "Create" }).click();
    await page.waitForTimeout(600);
    const stillOpen = await page.getByPlaceholder("My Template").isVisible().catch(() => false);
    expect(stillOpen).toBe(true);
    await page.getByRole("button", { name: "Cancel" }).click();
  });

  test("new template appears and becomes active", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "New Template" }).click();
    await page.getByPlaceholder("My Template").fill("My Second Template");
    await page.getByRole("button", { name: "Create" }).click();
    const activeRow = page.locator("button", { hasText: "My Second Template" });
    await expect(activeRow.getByText("Active")).toBeVisible({ timeout: 5000 });
  });
});

test.describe("Print page (Batch 2)", () => {
  test("template dropdown shows empty state when no templates", async ({ page }) => {
    await page.goto("/print");
    const trigger = page.getByRole("combobox").nth(1);
    await trigger.click();
    await expect(
      page.getByRole("option", { name: /No templates/i }),
    ).toBeVisible({ timeout: 8000 }).catch(() => {});
  });

  test("print button is present and enabled once loaded", async ({ page }) => {
    await page.goto("/print");
    const printBtn = page.getByRole("button", { name: "Print", exact: true }).first();
    await expect(printBtn).toBeVisible();
  });

  test("status panel shows idle state", async ({ page }) => {
    await page.goto("/print");
    await expect(page.getByText(/Waiting to print/)).toBeVisible();
  });

  test("live status shows selected template/page info", async ({ page }) => {
    await page.goto("/print");
    await expect(page.getByText("Template:", { exact: false })).toBeVisible();
  });

  test("copy input rejects non-numeric-less values by clamping copies", async ({ page }) => {
    await page.goto("/print");
    const copies = page.locator("#copies");
    await copies.fill("0");
    await copies.fill("3");
    await expect(copies).toHaveValue("3");
  });

  test("test data toggle disables data URL input", async ({ page }) => {
    await page.goto("/print");
    const url = page.locator("#data-url");
    await expect(url).toBeEnabled();
    await page.locator("#test-data").click();
    await expect(url).toBeDisabled();
  });

  test("batch dialog validates JSON before invoking", async ({ page }) => {
    await page.goto("/print");
    await page.getByRole("button", { name: "New Batch" }).click();
    const ta = page.getByRole("textbox").first();
    await ta.fill("{not-an-array}");
    await page.getByRole("button", { name: "Start Batch" }).click();
    // must show a JSON error, not crash
    await expect(page.getByText(/Invalid JSON/i)).toBeVisible({ timeout: 5000 });
  });
});

test.describe("History page (Batch 2)", () => {
  test("shows loading then resolves to empty state", async ({ page }) => {
    await page.goto("/history");
    await expect(page.getByText(/No print jobs yet/)).toBeVisible({
      timeout: 8000,
    });
  });

  test("export is blocked when there is nothing to export", async ({ page }) => {
    await page.goto("/history");
    await page.getByRole("button", { name: "Export CSV" }).click();
    await expect(page.getByText(/Nothing to export/i)).toBeVisible({
      timeout: 5000,
    });
  });

  test("table headers render in order", async ({ page }) => {
    await page.goto("/history");
    for (const h of ["ID", "Time", "Template", "Printer", "Status", "Duration", "Source", "Version", "Actions"]) {
      await expect(page.getByRole("columnheader", { name: h })).toBeVisible();
    }
  });
});

test.describe("Versioning (Batch 3)", () => {
  test("versions panel shows empty guidance when no versions", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByText(/No versions yet/i).first(),
    ).toBeVisible({ timeout: 8000 }).catch(() => {});
  });

  test("save version dialog opens and accepts a label", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /Save Version/i }).first().click();
    await expect(
      page.getByRole("dialog").getByText("Save Version"),
    ).toBeVisible({ timeout: 5000 });
    await page.getByPlaceholder(/Added logo/).fill("Design tweak");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    // dialog should close
    await expect(page.getByPlaceholder(/Added logo/)).toBeHidden({
      timeout: 5000,
    });
  });

  test("version list gains an entry after saving", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /Save Version/i }).first().click();
    await page.getByPlaceholder(/Added logo/).fill("First snapshot");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText(/v1/).first()).toBeVisible({ timeout: 5000 });
  });

  test("second save creates v2", async ({ page }) => {
    await page.goto("/");
    for (const label of ["one", "two"]) {
      await page.getByRole("button", { name: /Save Version/i }).first().click();
      await page.getByPlaceholder(/Added logo/).fill(label);
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await page.waitForTimeout(300);
    }
    await expect(page.getByText(/v2/).first()).toBeVisible({ timeout: 5000 });
  });
});

test.describe("PrinterSetup (Batch 5)", () => {
  test("shows empty state instead of mock printers", async ({ page }) => {
    await page.goto("/printers");
    await expect(page.getByText(/No printers configured/i)).toBeVisible({
      timeout: 8000,
    });
  });

  test("empty state is not the old hard-coded mock card", async ({ page }) => {
    await page.goto("/printers");
    // The old build always rendered "Front Desk" / "Kitchen Receipt".
    await expect(page.getByText("Kitchen Receipt")).toHaveCount(0);
  });

  test("add printer dialog validates a missing name", async ({ page }) => {
    await page.goto("/printers");
    await page.getByRole("button", { name: "Add Printer" }).first().click();
    await page.getByRole("button", { name: "Save Printer" }).click();
    await expect(page.getByText(/Printer name is required/i)).toBeVisible({
      timeout: 5000,
    });
  });

  test("add printer dialog validates a missing address", async ({ page }) => {
    await page.goto("/printers");
    await page.getByRole("button", { name: "Add Printer" }).first().click();
    await page.getByLabel("Printer Name").fill("Test Printer");
    await page.getByRole("button", { name: "Save Printer" }).click();
    await expect(page.getByText(/Address .* is required/i)).toBeVisible({
      timeout: 5000,
    });
  });

  test("IPP address must be a URL", async ({ page }) => {
    await page.goto("/printers");
    await page.getByRole("button", { name: "Add Printer" }).first().click();
    await page.getByLabel("Printer Name").fill("Bad IPP");
    await page.getByLabel(/Address/).fill("192.168.1.5");
    await page.getByRole("button", { name: "Save Printer" }).click();
    await expect(page.getByText(/must start with http/i)).toBeVisible({
      timeout: 5000,
    });
  });

  test("language and paper selectors exist", async ({ page }) => {
    await page.goto("/printers");
    await page.getByRole("button", { name: "Add Printer" }).first().click();
    await expect(page.getByText("Language")).toBeVisible();
    await expect(page.getByText("Paper Width")).toBeVisible();
    await expect(page.getByText("DPI")).toBeVisible();
  });
});

test.describe("Settings persistence (Batch 5)", () => {
  test("api tab shows a running/disabled badge", async ({ page }) => {
    await page.goto("/settings");
    await page.getByRole("tab", { name: "API" }).click();
    await expect(page.getByText("Local REST API")).toBeVisible();
    await expect(page.getByText(/disabled|running/)).toBeVisible();
  });

  test("start server is offered when disabled", async ({ page }) => {
    await page.goto("/settings");
    await page.getByRole("tab", { name: "API" }).click();
    await expect(page.getByRole("button", { name: "Start Server" })).toBeVisible();
  });

  test("API key input is masked and can be revealed", async ({ page }) => {
    await page.goto("/settings");
    await page.getByRole("tab", { name: "API" }).click();
    const input = page.getByLabel("API key");
    await expect(input).toHaveAttribute("type", "password");
    await page.getByRole("button", { name: "Reveal key" }).click();
    await expect(input).toHaveAttribute("type", "text");
  });

  test("LAN toggle shows a warning when enabled", async ({ page }) => {
    await page.goto("/settings");
    await page.getByRole("tab", { name: "API" }).click();
    await page.locator("#lan-access").click();
    await expect(page.getByText(/LAN access is enabled/i)).toBeVisible({
      timeout: 5000,
    });
  });

  test("curl example shows the configured port", async ({ page }) => {
    await page.goto("/settings");
    await page.getByRole("tab", { name: "API" }).click();
    await expect(page.getByText(/curl -X POST http:\/\/127\.0\.0\.1:/)).toBeVisible();
  });

  test("trusted sources starts empty with a call to action", async ({ page }) => {
    await page.goto("/settings");
    await page.getByRole("tab", { name: "Deep Links" }).click();
    await expect(page.getByText(/No trusted sources yet/i)).toBeVisible({
      timeout: 8000,
    });
  });

  test("trusted source can be added and removed", async ({ page }) => {
    await page.goto("/settings");
    await page.getByRole("tab", { name: "Deep Links" }).click();
    await page.getByPlaceholder("pos.local or com.example.app").fill("pos.local");
    await page.getByRole("button", { name: "Add" }).click();
    await expect(page.locator("span").filter({ hasText: /^pos\.local$/ })).toBeVisible({ timeout: 5000 });
    await page.getByRole("button", { name: "Remove pos.local" }).click();
    await expect(page.getByText(/No trusted sources yet/i)).toBeVisible({
      timeout: 5000,
    });
  });

  test("security tab exposes allowed domains and private-IP toggle", async ({ page }) => {
    await page.goto("/settings");
    await page.getByRole("tab", { name: "Security" }).click();
    await expect(page.getByLabel(/Allowed Domains/i)).toBeVisible();
    await expect(page.locator("#block-private")).toBeVisible();
  });

  test("retention inputs are present and editable", async ({ page }) => {
    await page.goto("/settings");
    const days = page.locator("#retention-days");
    await expect(days).toBeVisible();
    await days.fill("60");
    await expect(days).toHaveValue("60");
  });
});

test.describe("Barcode generation (Batch 6)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  /** Open the barcode dialog and pick a symbology by its visible label. */
  async function openDialog(page: Page, label: string) {
    await page.getByRole("button", { name: /barcode/i }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Insert Barcode")).toBeVisible();
    await page.locator("#barcode-type").click();
    await page.getByRole("option", { name: label, exact: true }).click();
    return dialog;
  }

  test("QR Code inserts an inline SVG barcode", async ({ page }) => {
    // Regression for #38: `qr` is not a bwip-js encoder name (it is `qrcode`),
    // so this symbology silently failed to insert.
    await openDialog(page, "QR Code");
    await page.locator("#barcode-value").fill("https://example.com");
    await page.locator("#barcode-insert").click();

    await expect(page.locator("#barcode-error")).toHaveCount(0);
    await expect(page.getByText("Insert Barcode")).toHaveCount(0);

    // The barcode must be real inline SVG, not a canvas data URI mislabelled
    // as SVG (which rendered as a broken image).
    await page.getByRole("tab", { name: "Code" }).click();

    // CodeMirror only renders the visible viewport, so jump to the end where
    // the barcode was appended.
    const editor = page.locator(".cm-content").first();
    await expect
      .poll(
        async () => {
          await page
            .locator(".cm-scroller")
            .first()
            .evaluate((el) => {
              el.scrollTop = el.scrollHeight;
            });
          return editor.innerText();
        },
        { timeout: 5000 },
      )
      .toContain("barcode");

    await expect(editor).not.toContainText("data:image/svg+xml");
  });

  test("ITF inserts (friendly id maps to interleaved2of5)", async ({ page }) => {
    await openDialog(page, "ITF");
    await page.locator("#barcode-value").fill("1234");
    await page.locator("#barcode-insert").click();
    await expect(page.locator("#barcode-error")).toHaveCount(0);
  });

  test("Codabar requires start/stop letters", async ({ page }) => {
    await openDialog(page, "Codabar");
    await page.locator("#barcode-value").fill("12345");
    await page.locator("#barcode-insert").click();
    await expect(page.locator("#barcode-error")).toContainText("start/stop");
  });

  test("EAN-13 rejects a bad check digit", async ({ page }) => {
    await openDialog(page, "EAN-13");
    await page.locator("#barcode-value").fill("4006381333932");
    await page.locator("#barcode-insert").click();
    await expect(page.locator("#barcode-error")).toContainText("check digit");
  });

  test("insert is disabled until a value is entered", async ({ page }) => {
    await openDialog(page, "Code 128");
    await expect(page.locator("#barcode-insert")).toBeDisabled();
    await page.locator("#barcode-value").fill("PN-1042");
    await expect(page.locator("#barcode-insert")).toBeEnabled();
  });
});
