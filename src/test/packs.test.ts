import { describe, it, expect } from "vitest";
import { PACKS, getPack } from "@/lib/templates/packs";
import {
  newTemplateContent,
  DEFAULT_TEMPLATE_HTML,
  DEFAULT_MOCK_DATA,
} from "@/lib/templates/defaultTemplate";
import { compileTemplateCss } from "@/lib/templates/compileTemplateCss";
import { extractClasses } from "@/lib/templates/extractClasses";
import {
  unresolvedMustaches,
  pickCanvasSample,
} from "@/lib/templates/mustacheCoverage";

describe("packs", () => {
  it("has 6 packs", () => expect(PACKS.length).toBe(6));
  it("getPack works", () => expect(getPack("receipt")?.id).toBe("receipt"));
  it("backwards compat", () => {
    expect(newTemplateContent("Test").html).toBe(DEFAULT_TEMPLATE_HTML);
    expect(newTemplateContent("Test", "receipt").html).not.toBe(
      DEFAULT_TEMPLATE_HTML,
    );
    expect(newTemplateContent("Test", "blank").html).toContain("{{message}}");
    expect(newTemplateContent("Test", "unknown").html).toBe(
      DEFAULT_TEMPLATE_HTML,
    );
  });
  describe("pickCanvasSample", () => {
    const packs = PACKS.map((p) => ({ name: p.name, mockData: p.mockData }));
    const kitchen = getPack("kitchenTicket")!;

    it("keeps the account data when it covers the template", () => {
      const data = kitchen.mockData as Record<string, unknown>;
      const pick = pickCanvasSample(kitchen.html, data, packs);
      expect(pick.packName).toBeNull();
      expect(pick.data).toBe(data);
    });

    it("falls back to the fitting pack when the data covers nothing", () => {
      // Shipping-label-shaped account data against the kitchen ticket:
      // every mustache is blank, so the canvas borrows the pack's sample.
      const data = DEFAULT_MOCK_DATA as Record<string, unknown>;
      const pick = pickCanvasSample(kitchen.html, data, packs);
      expect(pick.packName).toBe(kitchen.name);
      expect(pick.data).toBe(kitchen.mockData);
    });

    it("lets the account data take over once it covers one mustache", () => {
      const data = {
        ...DEFAULT_MOCK_DATA,
        ticket: { number: "7" },
      } as Record<string, unknown>;
      const pick = pickCanvasSample(kitchen.html, data, packs);
      expect(pick.packName).toBeNull();
      expect(pick.data).toBe(data);
    });

    it("keeps the account data when no pack fits better", () => {
      const html = "<p>{{weird.only.path}}</p>";
      const data = { some: { other: "value" } } as Record<string, unknown>;
      const pick = pickCanvasSample(html, data, packs);
      expect(pick.packName).toBeNull();
      expect(pick.data).toBe(data);
    });
  });

  for (const p of PACKS) {
    it(`${p.id} reads only data paths its mock data provides`, () => {
      const missing = unresolvedMustaches(p.html, p.mockData);
      expect(missing, `${p.id}: ${missing.join(", ")}`).toEqual([]);
    });
    it(`${p.id} compiles CSS`, async () => {
      const { css } = await compileTemplateCss(p.html);
      const { candidates } = extractClasses(p.html);
      // at least some candidates should compile
      if (candidates.length > 0) expect(css.length).toBeGreaterThan(0);
    });
    it(`${p.id} readme covers every placeholder`, () => {
      const readme = p.readme("Test");
      const paths = new Set<string>();
      for (const m of p.html.matchAll(/\{\{\s*([a-z]+(?:\.[a-z]+)+)[\s}]/g))
        paths.add(m[1]);
      for (const path of paths)
        expect(readme, `missing ${path} in ${p.id}`).toContain(`{{${path}}}`);
      // also contains valid JSON
      const block = /```json\n([\s\S]*?)```/.exec(readme)?.[1];
      expect(block, `${p.id} JSON block`).toBeDefined();
      expect(() => JSON.parse(block!), `${p.id} JSON valid`).not.toThrow();
    });
  }
});
