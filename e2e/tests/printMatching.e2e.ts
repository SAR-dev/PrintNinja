import { expect, test } from "@playwright/test";
import { signedSeed } from "../support/fixtures";

// F3 — smart printer/template matching: the paper-size mismatch warning
// (a label template aimed at an 80 mm thermal), and per-printer
// remembered template + paper. The prefs ride the agent's settings, so a
// page reload — an app restart — must bring them back. The fake agent
// stubs print_html, but the prefs are saved before the dispatch, so the
// stub's null answer is irrelevant to what this spec pins.

test("warns on paper mismatch and remembers each printer's choices", async ({
  browser,
}) => {
  const seeded = await signedSeed(browser, "matching", {
    templates: [
      {
        name: "Matching Label",
        server_id: crypto.randomUUID(),
        html: "<p>label</p>",
        page_w: 100,
        page_h: 150,
        sync_state: "synced",
      },
      {
        name: "Matching A4",
        server_id: crypto.randomUUID(),
        html: "<p>sheet</p>",
        page_w: 210,
        page_h: 297,
        sync_state: "synced",
      },
    ],
    printers: [
      {
        name: "E2E Thermal 80",
        printer_type: "raw_tcp",
        language: "escpos",
        paper_width_mm: 80,
      },
      { name: "E2E Front Desk" },
    ],
  });
  const page = await seeded.context.newPage();
  await page.goto("/print");

  // Preselect is the first printer (Thermal 80) with the first template
  // (the 100 mm label) — 20 mm too wide for an 80 mm thermal.
  await expect(
    page.getByText("Template is 100 × 150 mm; this printer uses 80 mm paper."),
  ).toBeVisible({ timeout: 20_000 });

  // A printer with no registered paper width never warns.
  await page.getByRole("combobox", { name: "Printer" }).click();
  await page.getByRole("option", { name: "E2E Front Desk" }).click();
  await expect(page.getByText(/this printer uses 80 mm paper/)).toHaveCount(0);

  // Back on the thermal: the wider template on an explicit A4 sheet…
  await page.getByRole("combobox", { name: "Printer" }).click();
  await page.getByRole("option", { name: "E2E Thermal 80" }).click();
  await page.getByRole("combobox", { name: "Template" }).click();
  await page.getByRole("option", { name: "Matching A4" }).click();
  await page.getByRole("combobox", { name: "Paper size" }).click();
  await page.getByRole("option", { name: /A4/ }).click();
  await expect(
    page.getByText("Paper is 210 × 297 mm; this printer uses 80 mm paper."),
  ).toBeVisible();

  // …and a print, which remembers them for this printer.
  await page.getByRole("button", { name: /^Print$/ }).click();
  await expect
    .poll(
      async () =>
        (
          await page.evaluate(() =>
            (
              window as unknown as {
                __FAKE_AGENT_CALLS: { cmd: string }[];
              }
            ).__FAKE_AGENT_CALLS.filter((c) => c.cmd === "print_html"),
          )
        ).length,
      { timeout: 15_000 },
    )
    .toBe(1);

  // Restart: the remembered template and paper for the preselected
  // printer come back from the agent's settings.
  await page.reload();
  await expect(
    page.getByRole("combobox", { name: "Template" }),
  ).toHaveText("Matching A4", { timeout: 20_000 });
  await expect(
    page.getByRole("combobox", { name: "Paper size" }),
  ).toHaveText("A4 (210 × 297 mm)");
  await expect(
    page.getByText("Paper is 210 × 297 mm; this printer uses 80 mm paper."),
  ).toBeVisible();
});
