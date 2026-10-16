import { describe, it, expect } from "vitest";
import { renderTemplate } from "@/lib/render/renderTemplate";
import { DEFAULT_MOCK_DATA } from "@/lib/templates/defaultTemplate";

describe("renderTemplate", () => {
  it("renders a simple template with data", () => {
    const html = "{{name}}";
    const css = "body { color: red; }";
    const data = { name: "Test" };
    const result = renderTemplate(html, css, data);
    expect(result).toContain("Test");
    expect(result).toContain("tailwindcss.com");
    expect(result).toContain("body { color: red; }");
  });

  it("uses Handlebars helpers", () => {
    const html = "{{currency price}}";
    const result = renderTemplate(html, "", { price: 10.5 });
    expect(result).toContain("$10.50");
  });

  it("renders loops", () => {
    const html = "{{#each items}}{{name}} {{/each}}";
    const result = renderTemplate(html, "", { items: [{ name: "A" }, { name: "B" }] });
    expect(result).toContain("A");
    expect(result).toContain("B");
  });

  it("includes Tailwind CDN", () => {
    const result = renderTemplate("<p>hi</p>", "", {});
    expect(result).toContain("cdn.tailwindcss.com");
  });

  it("renders upper helper", () => {
    const html = "{{upper name}}";
    const result = renderTemplate(html, "", { name: "hello" });
    expect(result).toContain("HELLO");
  });

  it("renders number helper", () => {
    const html = "{{number value 2}}";
    const result = renderTemplate(html, "", { value: 3.14159 });
    expect(result).toContain("3.14");
  });

  it("renders default mock data correctly", () => {
    const html = `<h1>{{store.name}}</h1><p>#{{order.id}}</p>`;
    const result = renderTemplate(html, "", DEFAULT_MOCK_DATA as any);
    expect(result).toContain("PrintNinja Cafe");
    expect(result).toContain("#1042");
  });
});
