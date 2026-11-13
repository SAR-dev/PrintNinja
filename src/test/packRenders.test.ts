import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DELIVERY_SLIP_PACK } from "../lib/templates/packs/deliverySlip";
import { INVOICE_PACK } from "../lib/templates/packs/invoice";
import { RECEIPT_PACK } from "../lib/templates/packs/receipt";
import { SHIPPING_LABEL_PACK } from "../lib/templates/packs/shippingLabel";

// The golden-pack fixture is generated from these modules and rendered by
// the Rust integration test `src-tauri/tests/pack_renders.rs` (the e2e
// suite fakes the Tauri IPC surface, so no Rust ever runs in it). If a
// pack changes, regenerate with:
//
//   UPDATE_PACK_FIXTURES=1 pnpm vitest run src/test/packRenders.test.ts
//
// and commit the rewritten `src-tauri/tests/fixtures/pack_renders.json`.
// This test fails whenever the packs and the fixture drift apart, so the
// Rust-side coverage cannot rot silently.

// Resolved from the repo root (vitest's cwd), like the other file-walking
// tests: under the jsdom environment, node:url's `fileURLToPath` rejects a
// `new URL(...)` instance built in the test realm, so the fixture path is
// kept a plain string here.
const FIXTURE = resolve(
  process.cwd(),
  "src-tauri",
  "tests",
  "fixtures",
  "pack_renders.json",
);

// Substrings the Rust-rendered page must contain. The currency strings pin
// the Rust `{{currency}}` format (`$27.70` — fixed two decimals, not a
// locale string).
const PACKS = [
  { pack: INVOICE_PACK, needles: ["Acme Corp", "INV-1042", "$27.70"] },
  {
    pack: RECEIPT_PACK,
    needles: ["PrintNinja Cafe", "VISA ···· 4242", "$21.60"],
  },
  {
    pack: SHIPPING_LABEL_PACK,
    needles: ["John Doe", "45 Oak Lane, Apt 2"],
  },
  {
    pack: DELIVERY_SLIP_PACK,
    needles: ["Leave at door if not home", "Pathao"],
  },
] as const;

function buildFixture(): string {
  const doc = {
    generated_by: "src/test/packRenders.test.ts (do not edit by hand)",
    packs: PACKS.map(({ pack, needles }) => ({
      id: pack.id,
      html: pack.html,
      css: pack.css,
      mockData: pack.mockData,
      needles: [...needles],
    })),
  };
  return JSON.stringify(doc, null, 2) + "\n";
}

describe("pack render fixtures", () => {
  it("match the shipped packs (regenerate with UPDATE_PACK_FIXTURES=1)", () => {
    const expected = buildFixture();
    const file = FIXTURE;
    if (process.env.UPDATE_PACK_FIXTURES === "1") {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, expected);
      return;
    }
    expect(
      existsSync(file),
      "fixture missing — run with UPDATE_PACK_FIXTURES=1",
    ).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(expected);
  });
});
