import { expect, test, type Page } from "@playwright/test";
import { pc } from "../support/fixtures";

// Deep-link contract: parse_deeplink answers the same shapes as the
// Rust parser (src-tauri/src/deeplink.rs, contract table
// parse_deep_link_contract_table). There is no OS handoff in the
// harness — the app resolves links through this command, so the spec
// pins the parse half against the fake implementation.

async function parse(page: Page, url: string): Promise<unknown> {
  return page.evaluate(
    (u: string) =>
      (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke: (c: string, a: unknown) => Promise<unknown>;
          };
        }
      ).__TAURI_INTERNALS__.invoke("parse_deeplink", { url: u }),
    url,
  );
}

test("deeplinks parse print, open and template actions", async ({
  browser,
}) => {
  const seeded = await pc(browser, {});
  const page = await seeded.context.newPage();
  await page.goto("/");

  const print = (await parse(
    page,
    "printninja://print?template=My+Receipt&printer=Desk&copies=3&test=1",
  )) as {
    Print: {
      template: string | null;
      printer: string | null;
      copies: number | null;
      test: boolean;
      confirm: boolean;
      callback: string | null;
    };
  };
  expect(print.Print.template).toBe("My Receipt");
  expect(print.Print.printer).toBe("Desk");
  expect(print.Print.copies).toBe(3);
  expect(print.Print.test).toBe(true);
  expect(print.Print.confirm).toBe(true);
  expect(print.Print.callback).toBeNull();

  const open = (await parse(page, "printninja://open/history")) as {
    Open: string;
  };
  expect(open).toEqual({ Open: "history" });

  const template = (await parse(page, "printninja://template/abc-123")) as {
    Template: string;
  };
  expect(template).toEqual({ Template: "abc-123" });

  await expect(parse(page, "printninja://explode/now")).rejects.toThrow(
    /Unknown deep link action/,
  );
});

type NewPrintOptions = {
  Print: {
    page_range: string | null;
    grayscale: boolean | null;
    margin_top: number | null;
    margin_right: number | null;
    margin_bottom: number | null;
    margin_left: number | null;
  };
};

test("deeplinks parse page_range, grayscale and the four margins", async ({
  browser,
}) => {
  // Mirrors parse_deep_link_new_print_options in
  // src-tauri/src/deeplink.rs: same valid/garbage/absent rows.
  const seeded = await pc(browser, {});
  const page = await seeded.context.newPage();
  await page.goto("/");

  const withOptions = (await parse(
    page,
    "printninja://print?page_range=1%2C3%2C5-7&grayscale=1&margin_top=5&margin_left=7.5",
  )) as NewPrintOptions;
  expect(withOptions.Print.page_range).toBe("1,3,5-7");
  expect(withOptions.Print.grayscale).toBe(true);
  expect(withOptions.Print.margin_top).toBe(5);
  expect(withOptions.Print.margin_left).toBe(7.5);
  expect(withOptions.Print.margin_right).toBeNull();
  expect(withOptions.Print.margin_bottom).toBeNull();

  const explicitOff = (await parse(
    page,
    "printninja://print?grayscale=false",
  )) as NewPrintOptions;
  expect(explicitOff.Print.grayscale).toBe(false);

  const absent = (await parse(
    page,
    "printninja://print?template=Label",
  )) as NewPrintOptions;
  expect(absent.Print.page_range).toBeNull();
  expect(absent.Print.grayscale).toBeNull();
  expect(absent.Print.margin_top).toBeNull();
  expect(absent.Print.margin_right).toBeNull();
  expect(absent.Print.margin_bottom).toBeNull();
  expect(absent.Print.margin_left).toBeNull();

  // Every kind of margin garbage drops to null, one per kind — the same
  // rows the Rust test asserts.
  for (const raw of ["-1", "abc", "NaN", "inf", "1e400", "300.5"]) {
    const bad = (await parse(
      page,
      `printninja://print?margin_top=${raw}`,
    )) as NewPrintOptions;
    expect(bad.Print.margin_top).toBeNull();
  }
  const badGray = (await parse(
    page,
    "printninja://print?grayscale=bogus",
  )) as NewPrintOptions;
  expect(badGray.Print.grayscale).toBeNull();
});

test("deeplinks drop garbage copies and honor confirm/callback", async ({
  browser,
}) => {
  const seeded = await pc(browser, {});
  const page = await seeded.context.newPage();
  await page.goto("/");

  const garbage = (await parse(page, "printninja://print?copies=lots")) as {
    Print: { copies: number | null };
  };
  expect(garbage.Print.copies).toBeNull();

  const negative = (await parse(page, "printninja://print?copies=-3")) as {
    Print: { copies: number | null };
  };
  expect(negative.Print.copies).toBeNull();

  const overflow = (await parse(
    page,
    "printninja://print?copies=99999999999",
  )) as { Print: { copies: number | null } };
  expect(overflow.Print.copies).toBeNull();

  const withCallback = (await parse(
    page,
    "printninja://print?callback=https%3A%2F%2Fexample.com%2Fdone&confirm=0",
  )) as { Print: { confirm: boolean; callback: string | null } };
  expect(withCallback.Print.confirm).toBe(false);
  expect(withCallback.Print.callback).toBe("https://example.com/done");
});
