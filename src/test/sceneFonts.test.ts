import { describe, expect, it } from "vitest";
import { cssFontFamily, sceneFontRows } from "@/lib/scene/fonts";
import { fontFamilies, type Element } from "@/lib/scene/schema";
import type { FontRow } from "@/lib/agent/types";

const row = (over: Partial<FontRow>): FontRow => ({
  id: 1,
  family: "Brand Sans",
  style: "normal",
  weight: "400",
  file_path: "brand.ttf",
  format: "ttf",
  created_at: "",
  server_id: "s1",
  sync_state: "synced",
  sha256: "",
  size_bytes: 1,
  state: "ready",
  ...over,
});

describe("sceneFontRows", () => {
  it("keeps TrueType and OpenType uploads, one per family", () => {
    const rows = sceneFontRows([
      row({ server_id: "a", family: "Brand Sans", format: "ttf" }),
      row({ server_id: "b", family: "brand sans", format: "otf" }),
      row({ server_id: "c", family: "Display", format: "OTF" }),
    ]);
    expect(rows.map((r) => r.server_id)).toEqual(["a", "c"]);
  });

  it("drops web formats, deleted rows and rows without a file", () => {
    const rows = sceneFontRows([
      row({ server_id: "w", family: "Web", format: "woff2" }),
      row({ server_id: "d", family: "Gone", sync_state: "deleted_pending" }),
      row({ server_id: "n", family: "NoFile", file_path: "" }),
      row({ server_id: "e", family: "  ", format: "ttf" }),
      row({ server_id: "ok", family: "Fine" }),
    ]);
    expect(rows.map((r) => r.server_id)).toEqual(["ok"]);
  });

  it("does not hide a font whose download state is still pending", () => {
    expect(sceneFontRows([row({ state: "pending" })])).toHaveLength(1);
  });
});

describe("fontFamilies", () => {
  const text = (font: string | undefined): Element => ({
    type: "text",
    at: { x_mm: 0, y_mm: 0 },
    size: { w_mm: 10, h_mm: 5 },
    content: "x",
    style: { size_mm: 3, font },
  });

  it("collects the distinct families, through groups and frames", () => {
    const elements: Element[] = [
      text("Brand Sans"),
      text(undefined),
      text(" brand sans "),
      {
        type: "frame",
        at: { x_mm: 0, y_mm: 0 },
        size: { w_mm: 10, h_mm: 10 },
        children: [text("Display")],
      } as Element,
    ];
    expect(fontFamilies(elements)).toEqual(["Brand Sans", "Display"]);
  });
});

describe("cssFontFamily", () => {
  it("quotes the family, strips quote characters, and adds a fallback", () => {
    expect(cssFontFamily("Brand Sans")).toBe('"Brand Sans", sans-serif');
    expect(cssFontFamily('Bad"; x: y')).toBe('"Bad; x: y", sans-serif');
  });
});
