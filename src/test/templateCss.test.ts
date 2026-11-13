import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TEMPLATE_BASE_CSS,
  buildTemplateCss,
} from "@/lib/templates/templateCss";
import { resolvePaper } from "@/lib/render/printLayout";
import {
  DEFAULT_TEMPLATE_HTML,
  NEW_TEMPLATE_PAGE_W_MM,
  NEW_TEMPLATE_PAGE_H_MM,
  newTemplateContent,
} from "@/lib/templates/defaultTemplate";
import {
  rawSourceDocument,
  renderDesignPagesRust,
  renderTemplateRust,
  shortTemplateError,
} from "@/lib/render/rustPreview";

// The preview plumbing calls the Rust engine over IPC. The engine itself is
// tested in Rust (src-tauri), so here the command is mocked and only the
// JS-side behaviour — argument mapping, fallback, error surfacing — is under
// test.
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/invoke", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

describe("base print stylesheet", () => {
  it("never references the Tailwind CDN", () => {
    // Regression for #35/#81: templates used to load cdn.tailwindcss.com.
    expect(TEMPLATE_BASE_CSS).not.toContain("cdn.tailwindcss.com");
    expect(buildTemplateCss()).not.toContain("cdn.");
  });

  it("contains no external resource references", () => {
    expect(TEMPLATE_BASE_CSS).not.toMatch(/url\(\s*['"]?https?:/i);
    expect(TEMPLATE_BASE_CSS).not.toContain("@import");
  });

  it("carries the reset and print essentials", () => {
    expect(TEMPLATE_BASE_CSS).toContain("box-sizing:border-box");
    expect(TEMPLATE_BASE_CSS).toContain("print-color-adjust");
  });

  it("defines the Designer's helper classes", () => {
    for (const c of [
      ".page-break-before",
      ".page-break-after",
      ".page-break-inside-avoid",
      ".no-print",
      ".print-only",
      ".barcode",
    ]) {
      expect(TEMPLATE_BASE_CSS, c).toContain(c);
    }
  });

  it("is small: the Tailwind rules come from the template, not from here", () => {
    expect(TEMPLATE_BASE_CSS.length).toBeLessThan(2_000);
  });
});

describe("buildTemplateCss", () => {
  it("puts the base print rules before the template's Tailwind CSS", () => {
    const css = buildTemplateCss("", ".flex{display:flex}");
    expect(css.indexOf("@page")).toBeLessThan(
      css.indexOf(".flex{display:flex}"),
    );
  });

  it("is just the base rules for a template with no compiled CSS", () => {
    expect(buildTemplateCss()).toBe(TEMPLATE_BASE_CSS);
  });

  it("appends caller CSS last so it wins", () => {
    const css = buildTemplateCss(".brand{color:red}");
    expect(css.endsWith(".brand{color:red}")).toBe(true);
  });

  it("ignores empty caller CSS", () => {
    expect(buildTemplateCss("")).toBe(buildTemplateCss());
    expect(buildTemplateCss(null)).toBe(buildTemplateCss());
    expect(buildTemplateCss("   ")).toBe(buildTemplateCss());
  });
});

describe("resolvePaper", () => {
  it("swaps the paper for landscape, never the design", () => {
    expect(resolvePaper(80, 200, "landscape")).toEqual({
      paperW: 200,
      paperH: 80,
    });
    expect(resolvePaper(80, 200, "portrait")).toEqual({
      paperW: 80,
      paperH: 200,
    });
  });

  it("lets an explicit paper size win per axis", () => {
    expect(resolvePaper(80, 200, "portrait", 210, null)).toEqual({
      paperW: 210,
      paperH: 200,
    });
  });
});

describe("rawSourceDocument", () => {
  it("wraps the escaped source in a full document with the base styles", () => {
    const doc = rawSourceDocument("<p>Hi</p>", "", null);
    expect(doc).toContain("<!DOCTYPE html>");
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain("<style data-printninja>");
    expect(doc).toContain("&lt;p&gt;Hi&lt;/p&gt;");
  });

  it("escapes the source so a broken template cannot smuggle markup", () => {
    const doc = rawSourceDocument(
      "<script>alert(1)</script><img src=x>",
      "",
      null,
    );
    expect(doc).not.toContain("<script>");
    expect(doc).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});

describe("shortTemplateError", () => {
  it("keeps a one-line message whole", () => {
    expect(
      shortTemplateError(new Error("Template render failed: unclosed tag")),
    ).toBe("Template render failed: unclosed tag");
  });

  it("collapses a multi-line message to its first and last line", () => {
    const out = shortTemplateError(new Error("line one\nline two\nline three"));
    expect(out).toBe("line one line three");
    expect(out).not.toContain("\n");
  });

  it("stringifies non-Error rejects", () => {
    expect(shortTemplateError("boom")).toBe("boom");
  });
});

describe("renderDesignPagesRust", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("renders through the Rust engine and reports no error", async () => {
    invokeMock.mockResolvedValue(["<html><body>1</body></html>"]);
    const { pages, error } = await renderDesignPagesRust("<p>{{n}}</p>", "", [
      { n: 1 },
    ]);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("render_template_preview", {
      html: "<p>{{n}}</p>",
      css: "",
      compiled_css: "",
      records: [{ n: 1 }],
    });
    expect(pages).toEqual(["<html><body>1</body></html>"]);
    expect(error).toBeNull();
  });

  it("falls back to one raw-source document per record when the engine fails", async () => {
    invokeMock.mockRejectedValue(
      new Error("Template render failed: unclosed tag"),
    );
    const { pages, error } = await renderDesignPagesRust("<p>{{n}}</p>", "", [
      { n: 1 },
      { n: 2 },
    ]);
    expect(pages).toHaveLength(2);
    for (const doc of pages) {
      expect(doc).toContain("<!DOCTYPE html>");
      expect(doc).toContain("&lt;p&gt;{{n}}&lt;/p&gt;");
    }
    expect(error).toBe("Template render failed: unclosed tag");
  });

  it("treats a non-array resolve as a failure, never leaks it to the caller", async () => {
    // The command's contract is a list of documents. A stale binary or a
    // loose IPC mock resolving null must fall back to raw-source pages,
    // not crash the preview (regression: setPreviewPages(null) crashed
    // Print.tsx under the `return null` catch-all invoke mocks).
    invokeMock.mockResolvedValue(null);
    const { pages, error } = await renderDesignPagesRust("<p>{{n}}</p>", "", [
      { n: 1 },
    ]);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain("&lt;p&gt;{{n}}&lt;/p&gt;");
    expect(error).toBe("render_template_preview returned no documents");
  });
});

describe("renderTemplateRust", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("returns the single rendered page", async () => {
    invokeMock.mockResolvedValue(["<html><body>ok</body></html>"]);
    const doc = await renderTemplateRust("<p>x</p>", "", { a: 1 }, ".a{}");
    expect(doc).toBe("<html><body>ok</body></html>");
  });
});

describe("new-template example content", () => {
  it("has sane page dimensions at label size", () => {
    const start = newTemplateContent("Example");
    expect(start.page_w_mm).toBe(NEW_TEMPLATE_PAGE_W_MM);
    expect(start.page_h_mm).toBe(NEW_TEMPLATE_PAGE_H_MM);
    expect(start.page_w_mm).toBeGreaterThan(0);
    expect(start.page_h_mm).toBeGreaterThan(0);
  });

  it("carries a Code 128 barcode of the tracking number", () => {
    expect(DEFAULT_TEMPLATE_HTML).toContain(
      '{{barcode "code128" order.tracking',
    );
  });
});
