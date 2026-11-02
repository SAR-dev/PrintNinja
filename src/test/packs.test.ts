import { describe, it, expect } from "vitest";
import { PACKS, getPack } from "@/lib/templates/packs";
import { newTemplateContent, DEFAULT_TEMPLATE_HTML } from "@/lib/templates/defaultTemplate";
import { renderTemplate } from "@/lib/render/renderTemplate";
import { compileTemplateCss } from "@/lib/templates/compileTemplateCss";
import { extractClasses } from "@/lib/templates/extractClasses";

describe("packs", () => {
  it("has 6 packs", () => expect(PACKS.length).toBe(6));
  it("getPack works", () => expect(getPack("receipt")?.id).toBe("receipt"));
  it("backwards compat", () => {
    expect(newTemplateContent("Test").html).toBe(DEFAULT_TEMPLATE_HTML);
    expect(newTemplateContent("Test","receipt").html).not.toBe(DEFAULT_TEMPLATE_HTML);
    expect(newTemplateContent("Test","blank").html).toContain("{{message}}");
    expect(newTemplateContent("Test","unknown").html).toBe(DEFAULT_TEMPLATE_HTML);
  });
  for (const p of PACKS) {
    it(`${p.id} renders against mockData without leftover mustache`, () => {
      const out = renderTemplate(p.html, p.css, p.mockData as any);
      // barcode helpers may leave empty but not raw mustache
      expect(out).not.toMatch(/\{\{[^}]+\}\}/);
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
      for (const m of p.html.matchAll(/\{\{\s*([a-z]+(?:\.[a-z]+)+)[\s}]/g)) paths.add(m[1]);
      for (const path of paths) expect(readme, `missing ${path} in ${p.id}`).toContain(`{{${path}}}`);
      // also contains valid JSON
      const block = /```json\n([\s\S]*?)```/.exec(readme)?.[1];
      expect(block, `${p.id} JSON block`).toBeDefined();
      expect(() => JSON.parse(block!), `${p.id} JSON valid`).not.toThrow();
    });
  }
});
