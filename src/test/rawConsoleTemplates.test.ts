import { describe, expect, it } from "vitest";
import { decodeRaw } from "@/pages/raw-console/parse";
import {
  RAW_TEMPLATE_CASES,
  RAW_TEMPLATES,
  type RawTemplateCase,
} from "@/pages/raw-console/templates";

/**
 * Hand-computed bytes for every row of the spec table (ASCII of the
 * decoded text, or the hex straight from the table). These pin the
 * templates' `source` strings: an accidental edit to a template shows
 * up here instead of on a printer.
 */
const PINNED: Record<string, string> = {
  "text-zpl":
    "5E 58 41 5E 46 4F 33 30 2C 33 30 5E 41 44 4E 2C 33 36 2C 32 30 5E 46 44 54 45 53 54 5E 46 53 5E 58 5A",
  "text-escpos": "1B 40 54 45 53 54 0A 0A 0A",
  "text-tspl":
    "53 49 5A 45 20 34 30 20 6D 6D 2C 33 30 20 6D 6D 0D 0A 47 41 50 20 32 20 6D 6D 2C 30 20 6D 6D 0D 0A 43 4C 53 0D 0A 54 45 58 54 20 30 2C 30 2C 22 32 22 2C 30 2C 31 2C 31 2C 22 54 45 53 54 22 0D 0A 50 52 49 4E 54 20 31 0D 0A",
  "text-cpcl":
    "21 20 30 20 32 30 30 20 32 30 30 20 32 31 30 20 31 0D 0A 54 45 58 54 20 34 20 30 20 30 20 32 30 20 54 45 53 54 0D 0A 50 52 49 4E 54 0D 0A",
  "large-zpl":
    "5E 58 41 5E 46 4F 33 30 2C 33 30 5E 41 30 4E 2C 34 30 2C 34 30 5E 46 44 54 45 53 54 5E 46 53 5E 58 5A",
  "large-escpos": "1B 40 1B 21 11 54 45 53 54 0A 1B 21 00",
  "newlines-zpl":
    "5E 58 41 0A 5E 46 4F 35 30 2C 35 30 5E 41 30 4E 2C 34 30 2C 34 30 0A 5E 46 44 50 72 69 6E 74 4E 69 6E 6A 61 20 74 65 73 74 5E 46 53 0A 5E 58 5A 0A",
  "multiline-escpos":
    "54 45 53 54 20 4C 49 4E 45 20 31 0A 54 45 53 54 20 4C 49 4E 45 20 32 0A 54 45 53 54 20 4C 49 4E 45 20 33 0A 0A",
  "barcode128-zpl":
    "5E 58 41 5E 46 4F 35 30 2C 35 30 5E 42 59 33 5E 42 43 4E 2C 31 30 30 2C 59 2C 4E 2C 4E 5E 46 44 31 32 33 34 35 36 37 38 39 30 5E 46 53 5E 58 5A",
  "barcode128-tspl":
    "53 49 5A 45 20 34 30 20 6D 6D 2C 33 30 20 6D 6D 0D 0A 47 41 50 20 32 20 6D 6D 2C 30 20 6D 6D 0D 0A 43 4C 53 0D 0A 42 41 52 43 4F 44 45 20 31 30 2C 31 30 2C 22 31 32 38 22 2C 32 2C 39 30 2C 30 2C 30 2C 32 2C 22 31 32 33 34 35 36 37 38 39 30 22 0D 0A 50 52 49 4E 54 20 31 0D 0A",
  "barcode128-escpos":
    "1B 40 1D 6B 4E 01 02 30 31 32 33 34 35 36 37 38 39 30 00 1D 68 48",
  "qr-zpl":
    "5E 58 41 5E 46 4F 35 30 2C 35 30 5E 42 51 4E 2C 32 2C 31 30 5E 46 44 51 2C 50 72 69 6E 74 4E 69 6E 6A 61 5E 46 53 5E 58 5A",
  "qr-escpos":
    "1B 40 1D 28 6B 04 00 31 41 32 00 1D 28 6B 03 00 31 43 03 1D 28 6B 03 00 31 45 30 33 32 1D 28 6B 0D 00 31 50 30 50 72 69 6E 74 4E 69 6E 6A 61 1D 28 6B 03 00 31 51 30 32 30",
  "box-zpl":
    "5E 58 41 5E 46 4F 33 30 2C 33 30 5E 47 42 33 30 30 2C 32 30 30 2C 32 30 5E 46 53 5E 46 4F 35 30 2C 31 32 30 5E 46 44 49 4E 20 42 4F 58 5E 46 53 5E 58 5A",
  "box-tspl":
    "53 49 5A 45 20 34 30 20 6D 6D 2C 33 30 20 6D 6D 0D 0A 47 41 50 20 32 20 6D 6D 2C 30 20 6D 6D 0D 0A 43 4C 53 0D 0A 42 4F 58 20 31 30 2C 31 30 2C 33 35 30 2C 32 35 30 2C 32 0D 0A 50 52 49 4E 54 20 31 0D 0A",
  "cjk-zpl":
    "5E 58 41 5E 46 4F 35 30 2C 35 30 5E 41 30 4E 2C 33 30 2C 33 30 5E 46 44 E3 83 97 E3 83 AA E3 83 B3 E3 83 88 E3 83 8B E3 83 B3 E3 82 B8 E3 83 A3 5E 46 53 5E 58 5A",
  "cjk-escpos": "1B 40 1B 74 28 F8 EA C4 FC EA D4 EA C9 48 53",
  "raster-escpos":
    "1B 40 1D 76 30 00 01 00 10 FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF",
  "raster-zpl":
    "5E 58 41 0D 5E 44 47 30 2C 31 2C 31 2C 30 2C 30 2C 30 2C FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF 0D 5E 58 5A",
};

describe("raw console templates", () => {
  it("lists exactly the spec's 19 rows", () => {
    expect(RAW_TEMPLATES).toHaveLength(19);
  });

  it("has a unique id per row, and every source decodes to its pinned bytes", () => {
    const ids = RAW_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const tpl of RAW_TEMPLATES) {
      const pinned = PINNED[tpl.id];
      expect(pinned, `pinned bytes for ${tpl.id}`).toBeDefined();
      const r = decodeRaw(tpl.source, tpl.mode);
      expect(r.ok, `${tpl.id} must decode`).toBe(true);
      if (r.ok) {
        const got = [...r.bytes]
          .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
          .join(" ");
        expect(got, `${tpl.id} decoded bytes`).toBe(pinned);
      }
    }
  });

  it("pins the hex rows to the spec table verbatim", () => {
    for (const tpl of RAW_TEMPLATES.filter((t) => t.mode === "hex")) {
      const tokens = tpl.source.split(/\s+/).map((s) => s.toUpperCase());
      expect(tokens, `${tpl.id} hex source`).toEqual(
        PINNED[tpl.id]!.split(" "),
      );
    }
  });

  it("flags exactly the CJK and raster rows as expected-to-fail", () => {
    const flagged = RAW_TEMPLATES.filter((t) => t.expectedToFail)
      .map((t) => t.case)
      .sort();
    expect(flagged).toEqual(["cjk", "cjk", "raster", "raster"]);
  });

  it("groups every row under a known case", () => {
    const cases = new Set<RawTemplateCase>(RAW_TEMPLATE_CASES.map((c) => c.id));
    for (const tpl of RAW_TEMPLATES) {
      expect(cases.has(tpl.case), `${tpl.id} case`).toBe(true);
    }
  });
});
