import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@/lib/i18n";
import { ReadmeEditor } from "@/components/ReadmeEditor";
import {
  DEFAULT_TEMPLATE_HTML,
  defaultTemplateReadme,
  newTemplateContent,
} from "@/lib/templates/defaultTemplate";

const readme = defaultTemplateReadme("Shipping Label 4x6");

describe("default template README", () => {
  it("is the README a new template starts with", () => {
    expect(newTemplateContent("Shipping Label 4x6").readme).toBe(readme);
  });

  it("uses only Markdown the preview renders: no comments, no raw HTML", () => {
    expect(readme).not.toContain("<!--");
    // Outside fenced code a tag would show up as literal text.
    const prose = readme.replace(/```[\s\S]*?```/g, "");
    expect(prose).not.toMatch(/<\/?[a-z][^>]*>/i);
  });

  it("documents every data path the template reads", () => {
    const paths = new Set<string>();
    for (const m of DEFAULT_TEMPLATE_HTML.matchAll(
      /\{\{\s*([a-z]+(?:\.[a-z]+)+)[\s}]/g,
    )) {
      paths.add(m[1]);
    }
    expect(paths.size).toBeGreaterThan(0);
    for (const p of paths) {
      expect(readme, `README misses ${p}`).toContain(`{{${p}}}`);
    }
  });

  it("ships a data contract that is valid JSON", () => {
    const block = /```json\n([\s\S]*?)```/.exec(readme)?.[1];
    expect(block).toBeDefined();
    const data = JSON.parse(block!) as {
      order: { items: unknown[]; tracking: string };
    };
    expect(data.order.items.length).toBeGreaterThan(0);
    expect(data.order.tracking).toBeTruthy();
  });

  it("renders headings, the placeholder table and the JSON block", () => {
    render(
      <ReadmeEditor
        value={readme}
        onChange={() => {}}
        templateName="Shipping Label 4x6"
      />,
    );
    const tab = screen.getByRole("tab", { name: "Preview" });
    fireEvent.mouseDown(tab, { button: 0 });
    fireEvent.click(tab);
    expect(
      screen.getByRole("heading", { name: "Data contract" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText(/"tracking"/)).toBeInTheDocument();
  });
});
