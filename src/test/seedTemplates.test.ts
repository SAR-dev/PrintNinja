import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  NEW_TEMPLATE_PAGE_W_MM,
  NEW_TEMPLATE_PAGE_H_MM,
  newTemplateContent,
} from "@/lib/templates/defaultTemplate";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

describe("listTemplates", () => {
  beforeEach(() => {
    invoke.mockReset();
    vi.resetModules();
  });

  it("returns the database rows unchanged — nothing is seeded", async () => {
    const rows = [
      {
        id: 7,
        name: "My Template",
        page_w_mm: 100,
        page_h_mm: 150,
        orientation: "portrait",
        html: "<p>x</p>",
        css: "",
        compiled_css: "",
        compiled_key: "",
      },
    ];
    invoke.mockResolvedValue(rows);

    const { listTemplates } = await import("@/lib/templates/listTemplates");
    const out = await listTemplates();

    // Origin rides along (null for rows that predate it); nothing is
    // created on the side — an empty account is genuinely empty.
    expect(out).toEqual([{ ...rows[0], origin: null }]);
    expect(
      invoke.mock.calls.filter((c) => c[0] === "create_template"),
    ).toHaveLength(0);
  });

  it("returns an empty list for an empty account instead of throwing", async () => {
    invoke.mockResolvedValue([]);

    const { listTemplates } = await import("@/lib/templates/listTemplates");
    await expect(listTemplates()).resolves.toEqual([]);
  });

  it("returns an empty list in web mode instead of throwing", async () => {
    invoke.mockRejectedValue(new Error("no Tauri backend"));

    const { listTemplates } = await import("@/lib/templates/listTemplates");
    await expect(listTemplates()).resolves.toEqual([]);
  });
});

describe("newTemplateContent", () => {
  it("starts every new template from the bundled label example", () => {
    const start = newTemplateContent("My label");
    expect(start.page_w_mm).toBe(NEW_TEMPLATE_PAGE_W_MM);
    expect(start.page_h_mm).toBe(NEW_TEMPLATE_PAGE_H_MM);
    expect(start.page_w_mm).toBe(102);
    expect(start.page_h_mm).toBe(152);
    // The starting README is written for the template being made.
    expect(start.readme).toContain("# My label");
    expect(start.html).toContain("order.tracking");
  });
});
