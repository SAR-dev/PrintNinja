import { expect, test, type Page } from "@playwright/test";
import { signedSeed } from "../support/fixtures";
import { testids } from "../support/testids";

// The two-step new-template chooser starts a template from a pack, and the
// pack's body lands on the created copy.

async function invoke(
  page: Page,
  cmd: string,
  args: unknown,
): Promise<unknown> {
  return page.evaluate(
    ({ c, a }: { c: string; a: unknown }) =>
      (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke: (c: string, a: unknown) => Promise<unknown>;
          };
        }
      ).__TAURI_INTERNALS__.invoke(c, a),
    { c: cmd, a: args },
  );
}

test("new template from the pack chooser keeps the pack's HTML", async ({
  browser,
}) => {
  const seeded = await signedSeed(browser, "packs", {});
  const page = await seeded.context.newPage();
  await page.goto("/");
  await expect(page.getByTestId(testids.shellApp)).toBeVisible({
    timeout: 15_000,
  });

  // startOnPrint() rewrites a first load of bare "/" to /print, so the app
  // opens on the Print page; the sidebar link navigates to the Designer
  // client-side (the rewrite already ran once per page load, so no loop).
  await page.getByRole("link", { name: "Designer" }).click();

  // Empty designer: the toolbar's "New Template" button opens the pack
  // chooser (the empty state repeats the label, so use the test id).
  await page.getByTestId(testids.designerNewTemplate).click();
  await page.getByTestId(testids.packCard("invoice")).click();
  await page.getByTestId(testids.packNext).click();

  // Step 2: name it, then create.
  await page.locator("#new-template-name").fill("E2E Invoice");
  await page.getByTestId(testids.packCreate).click();

  await expect(
    page.getByText('Template "E2E Invoice" created on the server'),
  ).toBeVisible({ timeout: 15_000 });

  // The created copy must carry the invoice pack's body, not the default.
  const rows = (await invoke(page, "list_templates", {})) as Array<{
    name: string;
    html: string;
  }>;
  const row = rows.find((r) => r.name === "E2E Invoice");
  expect(row, "created template missing from list").toBeDefined();
  expect(row!.html).toContain("INVOICE");
  expect(row!.html).toContain("{{#each invoice.items}}");
  expect(row!.html).not.toContain("{{message}}");
});
