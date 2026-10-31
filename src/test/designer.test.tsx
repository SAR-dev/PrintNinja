import { createRef, useState } from "react";
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import {
  render,
  renderHook,
  screen,
  fireEvent,
  waitFor,
  within,
  act,
} from "@testing-library/react";
import "@/lib/i18n";
import { DesignerToolbar } from "@/components/designer/DesignerToolbar";
import { ControlsAccordion } from "@/components/designer/ControlsAccordion";
import { CanvasPane } from "@/components/designer/CanvasPane";
import {
  CodeEditors,
  EditorPane,
  type EditorPaneHandle,
} from "@/components/designer/EditorPane";
import {
  CanvasWorkspace,
  MM_TO_PX,
  fitZoom,
  stepZoom,
} from "@/components/designer/CanvasWorkspace";
import { SampleDataPanel } from "@/components/designer/SampleDataPanel";
import { ControlsRail } from "@/components/designer/ControlsRail";
import {
  HelpersPanel,
  helperSnippet,
} from "@/components/designer/HelpersPanel";
import {
  LayoutToggle,
  isDesignerLayout,
} from "@/components/designer/LayoutToggle";
import { usePersistentState } from "@/lib/hooks/usePersistentState";
import { getTemplateError } from "@/lib/render/renderTemplate";

beforeAll(() => {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.scrollIntoView = () => {};
  // CodeMirror measures text with Range rects, which jsdom does not implement.
  const noRects = () =>
    ({
      length: 0,
      item: () => null,
      [Symbol.iterator]: function* () {},
    }) as unknown as DOMRectList;
  Range.prototype.getClientRects = Range.prototype.getClientRects || noRects;
  Range.prototype.getBoundingClientRect =
    Range.prototype.getBoundingClientRect || (() => new DOMRect());
});

// jsdom does no layout, so the measured content height is supplied per test:
// 0 means "could not be measured", which keeps the page to one page.
const measured = vi.hoisted(() => ({ height: 0 }));
vi.mock("@/lib/render/paginate", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/render/paginate")>()),
  measureContentHeightPx: async () => measured.height,
}));

beforeEach(() => {
  measured.height = 0;
});

beforeEach(() => window.localStorage.clear());

describe("DesignerToolbar", () => {
  const base = {
    templateName: "Label",
    onTemplateNameChange: (() => {}) as (name: string) => void,
    remoteId: null as string | null,
    publishedAt: null as string | null,
    readOnly: false as boolean,
    pending: null as "save" | "visibility" | null,
    onVisibilityChange: (() => {}) as any,
  };

  it("fires New and Save", () => {
    const onNew = vi.fn();
    const onSave = vi.fn();
    render(
      <DesignerToolbar
        {...base}
        onNew={onNew}
        onSave={onSave}
        onVisibilityChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /New/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onNew).toHaveBeenCalled();
    expect(onSave).toHaveBeenCalled();
  });

  it("edits the template name in place beside Save", () => {
    const onTemplateNameChange = vi.fn();
    render(
      <DesignerToolbar
        {...base}
        onNew={vi.fn()}
        onSave={vi.fn()}
        onVisibilityChange={vi.fn()}
        onTemplateNameChange={onTemplateNameChange}
      />,
    );
    const name = screen.getByRole("textbox", { name: "Template name" });
    expect(name).toHaveValue("Label");
    fireEvent.change(name, { target: { value: "Renamed" } });
    expect(onTemplateNameChange).toHaveBeenCalledWith("Renamed");
  });

  it("puts the template switcher inside the name field as an icon, so the name is not repeated", () => {
    render(
      <DesignerToolbar
        {...base}
        templates={[{ id: 1, name: "Label" }]}
        currentTemplateId={1}
        onSelectTemplate={vi.fn()}
        onNew={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    const switcher = screen.getByRole("button", { name: "Switch template" });
    const name = screen.getByRole("textbox", { name: "Template name" });
    // Same frame, and no "Templates" word beside the name.
    const frame = switcher.closest('[data-slot="template-field"]');
    expect(frame).not.toBeNull();
    expect(name.closest('[data-slot="template-field"]')).toBe(frame);
    expect(switcher).toHaveTextContent("");
  });

  it("shows only New until a template is open", () => {
    render(
      <DesignerToolbar
        {...base}
        noTemplate
        templates={[]}
        onSelectTemplate={vi.fn()}
        onNew={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /New/ })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Template name" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Switch template" }),
    ).toBeNull();
  });

  it("offers the switcher beside the name, and reports the chosen template", async () => {
    const onSelectTemplate = vi.fn();
    render(
      <DesignerToolbar
        {...base}
        templates={[
          { id: 1, name: "Receipt" },
          { id: 2, name: "Label" },
        ]}
        currentTemplateId={2}
        onSelectTemplate={onSelectTemplate}
        onNew={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Switch template" }));
    const active = await screen.findByRole("option", { name: /Label/ });
    expect(active).toHaveAttribute("aria-current", "true");
    fireEvent.click(screen.getByRole("option", { name: /Receipt/ }));
    expect(onSelectTemplate).toHaveBeenCalledWith(1);
    // The list closes once a template is chosen.
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("closes the switcher on Escape without choosing", async () => {
    const onSelectTemplate = vi.fn();
    render(
      <DesignerToolbar
        {...base}
        templates={[{ id: 1, name: "Receipt" }]}
        currentTemplateId={1}
        onSelectTemplate={onSelectTemplate}
        onNew={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Switch template" }));
    const search = await screen.findByPlaceholderText("Search templates…");
    fireEvent.keyDown(search, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onSelectTemplate).not.toHaveBeenCalled();
  });

  it("says when the name cannot be saved, and when edits are unsaved", () => {
    const { rerender } = render(
      <DesignerToolbar
        {...base}
        nameError="Template name taken"
        dirty
        onNew={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Template name taken");
    expect(
      screen.getByRole("textbox", { name: "Template name" }),
    ).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    rerender(<DesignerToolbar {...base} onNew={vi.fn()} onSave={vi.fn()} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Unsaved changes")).toBeNull();
  });

  it("shows the name of a read-only saved copy in a disabled field, and keeps Save disabled", () => {
    const onTemplateNameChange = vi.fn();
    render(
      <DesignerToolbar
        {...base}
        onNew={vi.fn()}
        onSave={vi.fn()}
        onVisibilityChange={vi.fn()}
        onTemplateNameChange={onTemplateNameChange}
        nameError="Template name taken"
        dirty
        readOnly
      />,
    );
    const name = screen.getByRole("textbox", { name: "Template name" });
    expect(name).toHaveValue("Label");
    expect(name).toBeDisabled();
    expect(screen.getByText("Read-only")).toBeInTheDocument();
    // Nothing to fix or save on a copy that cannot change.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("has no Import or Export actions", () => {
    render(
      <DesignerToolbar
        {...base}
        onNew={vi.fn()}
        onSave={vi.fn()}
        onVisibilityChange={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Import" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Export" })).toBeNull();
    expect(screen.queryByTestId("template-import")).toBeNull();
  });

  it("marks a template that is only on this computer", () => {
    render(
      <DesignerToolbar
        {...base}
        onNew={vi.fn()}
        onSave={vi.fn()}
        remoteId={null}
        publishedAt={null}
      />,
    );
    expect(screen.queryByText("Draft")).not.toBeInTheDocument();
    expect(screen.getByText("Only on this computer")).toBeInTheDocument();
  });

  it("shows a Public switch once a template is published", () => {
    const onVisibilityChange = vi.fn();
    render(
      <DesignerToolbar
        {...base}
        onNew={vi.fn()}
        onSave={vi.fn()}
        onVisibilityChange={onVisibilityChange}
        remoteId="r1"
        publishedAt="2026-02-01T00:00:00Z"
      />,
    );
    expect(screen.queryByText("Published")).not.toBeInTheDocument();
    expect(screen.getByTestId("template-visibility")).toBeInTheDocument();
    expect(screen.getByText("Public")).toBeInTheDocument();
  });

  it("shows a Private switch for an unpublished server copy", () => {
    render(
      <DesignerToolbar
        {...base}
        onNew={vi.fn()}
        onSave={vi.fn()}
        remoteId="r1"
        publishedAt={null}
        onVisibilityChange={vi.fn()}
      />,
    );
    expect(screen.queryByText("Draft")).not.toBeInTheDocument();
    expect(screen.getByText("Private")).toBeInTheDocument();
  });

  it("calls onVisibilityChange when the switch flips", () => {
    const onVisibilityChange = vi.fn();
    render(
      <DesignerToolbar
        {...base}
        onNew={vi.fn()}
        onSave={vi.fn()}
        onVisibilityChange={onVisibilityChange}
        remoteId="r1"
        publishedAt={null}
      />,
    );
    fireEvent.click(screen.getByTestId("template-visibility"));
    expect(onVisibilityChange).toHaveBeenCalled();
  });

  it("keeps Save and the visibility switch on a saved copy, disabled, with the reason on focus", async () => {
    render(
      <DesignerToolbar
        {...base}
        onNew={vi.fn()}
        onSave={vi.fn()}
        readOnly
        remoteId="x1"
        publishedAt="2026-02-01T00:00:00Z"
        onVisibilityChange={vi.fn()}
      />,
    );
    expect(screen.getByText("Read-only")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByTestId("template-visibility")).toBeDisabled();

    // A disabled button sends no hover or focus, so the reason hangs on its wrapper.
    fireEvent.focus(screen.getByTestId("save-disabled-reason"));
    expect(
      (await screen.findAllByText(/saved copy from Community/)).length,
    ).toBeGreaterThan(0);
  });

  it("explains why Save is disabled offline, and leaves a plain Save alone", () => {
    const { rerender } = render(
      <DesignerToolbar
        {...base}
        onNew={vi.fn()}
        onSave={vi.fn()}
        saveDisabled
        saveTitle="Offline — connect to save to the server"
      />,
    );
    expect(screen.getByTestId("save-disabled-reason")).toBeInTheDocument();
    rerender(<DesignerToolbar {...base} onNew={vi.fn()} onSave={vi.fn()} />);
    expect(screen.queryByTestId("save-disabled-reason")).toBeNull();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("lets the name field take all the free width", () => {
    render(<DesignerToolbar {...base} onNew={vi.fn()} onSave={vi.fn()} />);
    const wrapper = screen
      .getByRole("textbox", { name: "Template name" })
      .closest('[data-slot="template-field"]')!.parentElement!;
    expect(wrapper.className).toContain("flex-1");
    expect(wrapper.className).not.toMatch(/(^|\s)(max-w-|w-\[)/);
  });
});

describe("ControlsAccordion", () => {
  const props = () => ({
    templates: [
      { id: 1, name: "Receipt" },
      { id: 2, name: "Label" },
    ] as Array<{ id: number; name: string; origin?: string | null }>,
    currentTemplateId: 2,
    loadTemplate: vi.fn(),
    templateName: "Label",
    setTemplateName: vi.fn(),
    pageWidth: 80,
    setPageWidth: vi.fn(),
    pageHeight: 200,
    setPageHeight: vi.fn(),
    presets: [{ labelKey: "designer.preset_a4", width: 210, height: 297 }],
  });

  const ALL_OPEN = ["templates", "page", "helpers"];

  it("opens only Page Setup at first, and opens and closes sections on click", () => {
    render(<ControlsAccordion {...props()} />);
    const trigger = (name: string) => screen.getByRole("button", { name });
    expect(trigger("Page Setup")).toHaveAttribute("aria-expanded", "true");
    for (const name of ["Templates", "Helpers"]) {
      expect(trigger(name)).toHaveAttribute("aria-expanded", "false");
    }
    expect(screen.getByLabelText("Width (mm)")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Receipt/ }),
    ).not.toBeInTheDocument();
    // Several sections can be open at once.
    fireEvent.click(trigger("Templates"));
    expect(screen.getByRole("button", { name: /Receipt/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Width (mm)")).toBeInTheDocument();
    fireEvent.click(trigger("Page Setup"));
    expect(screen.queryByLabelText("Width (mm)")).not.toBeInTheDocument();
  });

  it("starts fully collapsed when asked to, as on a phone", () => {
    render(
      <ControlsAccordion {...props()} defaultOpen={[]} showHelpers={false} />,
    );
    for (const name of ["Templates", "Page Setup"]) {
      expect(screen.getByRole("button", { name })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
    }
    expect(
      screen.queryByRole("button", { name: "Helpers" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Sample data" }),
    ).not.toBeInTheDocument();
  });

  it("shows the helpers section when asked", () => {
    render(<ControlsAccordion {...props()} defaultOpen={ALL_OPEN} />);
    expect(screen.getByText("Available helpers:")).toBeInTheDocument();
  });

  it("marks the open template and loads another on click", () => {
    const p = props();
    render(<ControlsAccordion {...p} defaultOpen={ALL_OPEN} />);
    expect(screen.getByRole("button", { name: /Label/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: /Receipt/ }));
    expect(p.loadTemplate).toHaveBeenCalledWith(p.templates[0]);
  });

  it("groups own and saved templates under separate headings", () => {
    const p = props();
    p.templates = [
      { id: 1, name: "Receipt", origin: "own" },
      { id: 2, name: "Label", origin: "saved" },
    ];
    render(<ControlsAccordion {...p} defaultOpen={ALL_OPEN} />);
    expect(screen.getByText("Mine")).toBeInTheDocument();
    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Receipt/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Label/ })).toBeInTheDocument();
  });

  it("applies a page preset and labels its fields", () => {
    const p = props();
    render(<ControlsAccordion {...p} defaultOpen={ALL_OPEN} />);
    fireEvent.click(screen.getByRole("button", { name: "A4" }));
    expect(p.setPageWidth).toHaveBeenCalledWith(210);
    expect(p.setPageHeight).toHaveBeenCalledWith(297);
    expect(screen.getByLabelText("Width (mm)")).toHaveValue(80);
  });

  it("renders each section header as an h2, so heading order stays under the page h1", () => {
    render(<ControlsAccordion {...props()} defaultOpen={ALL_OPEN} />);
    const headings = screen
      .getAllByRole("heading", { level: 2 })
      .map((h) => h.textContent);
    expect(headings).toEqual(["Templates", "Page Setup", "Helpers"]);
    expect(
      screen.queryByRole("heading", {
        level: 3,
        name: /Templates|Page Setup|Helpers/,
      }),
    ).not.toBeInTheDocument();
  });

  it("has no Properties, Visual or Preview section, since those were removed", () => {
    render(<ControlsAccordion {...props()} defaultOpen={ALL_OPEN} />);
    for (const name of [
      "Properties",
      "Visual",
      "Visual Canvas",
      "Preview",
      "Variables",
    ]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
    expect(screen.queryByText("Properties")).not.toBeInTheDocument();
  });

  it("reports page size and zoom only once, in Page Setup, with no separate orientation control", () => {
    render(<ControlsAccordion {...props()} defaultOpen={ALL_OPEN} />);
    expect(screen.getAllByLabelText("Width (mm)")).toHaveLength(1);
    expect(screen.getAllByLabelText("Height (mm)")).toHaveLength(1);
    expect(
      screen.queryByRole("combobox", { name: "Orientation" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/zoom/i)).not.toBeInTheDocument();
  });

  it("swaps width and height with one button", () => {
    const p = props();
    render(<ControlsAccordion {...p} defaultOpen={ALL_OPEN} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Swap width and height" }),
    );
    expect(p.setPageWidth).toHaveBeenCalledWith(200);
    expect(p.setPageHeight).toHaveBeenCalledWith(80);
  });

  it("leaves out the Templates section and the name field when the top row owns them", () => {
    render(
      <ControlsAccordion
        {...props()}
        showTemplates={false}
        defaultOpen={["page"]}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Templates" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Template name")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Width (mm)")).toBeInTheDocument();
  });

  it("keeps a closed section's contents out of the page", () => {
    render(<ControlsAccordion {...props()} defaultOpen={[]} />);
    expect(screen.queryByLabelText("Width (mm)")).not.toBeInTheDocument();
  });

  it("shows Barcode and Font in a Custom input section when onBarcode is given", () => {
    render(
      <ControlsAccordion {...props()} defaultOpen={[]} onBarcode={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Custom input" }));
    expect(screen.getByRole("button", { name: "Barcode" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Font" })).toBeInTheDocument();
  });

  it("hides the Custom input section without onBarcode", () => {
    render(<ControlsAccordion {...props()} defaultOpen={[]} />);
    expect(
      screen.queryByRole("button", { name: "Custom input" }),
    ).not.toBeInTheDocument();
  });

  it("calls onBarcode from the Custom input section", () => {
    const onBarcode = vi.fn();
    render(
      <ControlsAccordion {...props()} defaultOpen={[]} onBarcode={onBarcode} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Custom input" }));
    fireEvent.click(screen.getByRole("button", { name: "Barcode" }));
    expect(onBarcode).toHaveBeenCalled();
  });
});

describe("ClassWarnings", () => {
  it("renders nothing for a template without data-built classes", async () => {
    const { ClassWarnings } = await import(
      "@/components/designer/ClassWarnings"
    );
    const { container } = render(
      <ClassWarnings
        html={`<p class="p-2 {{#if a}}flex{{else}}grid{{/if}}">x</p>`}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("names the line and the offending class, and explains the fix", async () => {
    const { ClassWarnings } = await import(
      "@/components/designer/ClassWarnings"
    );
    render(
      <ClassWarnings
        html={`<p>one</p>\n<b class="p-2 bg-{{color}}-500">x</b>`}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("1 class name is built from data");
    expect(alert).toHaveTextContent("Line 2:");
    expect(alert).toHaveTextContent("bg-{{color}}-500");
    expect(alert).toHaveTextContent(/every branch/);
    expect(alert).toHaveTextContent(/CSS variable/);
  });

  it("counts several and caps the list", async () => {
    const { ClassWarnings } = await import(
      "@/components/designer/ClassWarnings"
    );
    const rows = Array.from(
      { length: 7 },
      (_, i) => `<i class="m-{{n${i}}}">x</i>`,
    ).join("\n");
    render(<ClassWarnings html={rows} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("7 class names are built from data");
    expect(alert).toHaveTextContent("…and 2 more");
    expect(within(alert).getAllByText(/^Line \d+:/)).toHaveLength(5);
  });

  it("updates when the template is fixed", async () => {
    const { ClassWarnings } = await import(
      "@/components/designer/ClassWarnings"
    );
    const { rerender, container } = render(
      <ClassWarnings html={`<b class="bg-{{c}}">x</b>`} />,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    rerender(
      <ClassWarnings
        html={`<b class="{{#if c}}bg-red-600{{else}}bg-green-600{{/if}}">x</b>`}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("CanvasPane", () => {
  const base = {
    html: "<p>Hi {{store.name}}</p>",
    css: "",
    compiledCss: "",
    width: 302,
    height: 756,
  };

  it("renders the template with the sample data into a sandboxed frame", async () => {
    render(<CanvasPane {...base} data={{ store: { name: "Ninja Mart" } }} />);
    const frame = (await screen.findByTitle(
      "Canvas preview",
    )) as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toContain("Hi Ninja Mart");
  });

  it("holds a loading state until the page count is measured", async () => {
    render(<CanvasPane {...base} data={{}} />);
    // First paint: skeleton, not a premature single page.
    expect(screen.getByTestId("canvas-loading")).toBeInTheDocument();
    expect(screen.queryByTitle("Canvas preview")).toBeNull();
    // Then the measured pages.
    expect(await screen.findByTitle("Canvas preview")).toBeInTheDocument();
    expect(screen.queryByTestId("canvas-loading")).toBeNull();
  });

  it("re-renders when the sample data changes and sizes the page from width and height", async () => {
    const { rerender } = render(
      <CanvasPane {...base} data={{ store: { name: "One" } }} />,
    );
    rerender(
      <CanvasPane
        {...base}
        data={{ store: { name: "Two" } }}
        width={100}
        height={200}
      />,
    );
    const frame = await screen.findByTitle("Canvas preview");
    expect(frame.getAttribute("srcdoc")).toContain("Hi Two");
    expect(frame.parentElement).toHaveStyle({
      width: "100px",
      height: "200px",
    });
  });

  it("scales the page instead of resizing it, so zooming never reflows the template", async () => {
    render(
      <CanvasPane {...base} data={{}} width={400} height={800} zoom={0.5} />,
    );
    const frame = await screen.findByTitle("Canvas preview");
    // The page keeps its true size and is scaled; the box around it takes the scaled size.
    expect(frame.parentElement).toHaveStyle({
      width: "400px",
      height: "800px",
      transform: "scale(0.5)",
    });
    expect(frame.parentElement?.parentElement).toHaveStyle({
      width: "200px",
      height: "400px",
    });
  });

  it("shows content taller than the page as further pages, not a scrollbar", async () => {
    measured.height = 2000; // 756 px pages: 3 of them
    render(<CanvasPane {...base} data={{}} zoom={0.5} />);
    await waitFor(() =>
      expect(screen.getAllByTitle(/Canvas preview/)).toHaveLength(3),
    );
    const frames = screen.getAllByTitle(/Canvas preview/);
    for (const [k, frame] of frames.entries()) {
      // One frame three pages tall, moved up to page k, inside a one-page box.
      expect(frame.getAttribute("scrolling")).toBe("no");
      expect(frame).toHaveStyle({
        height: "300%",
        top: `${-k * 100}%`,
      });
      expect(frame.parentElement).toHaveStyle({
        width: "302px",
        height: "756px",
      });
      expect(frame.parentElement?.className).toContain("overflow-hidden");
      expect(frame.parentElement?.parentElement).toHaveStyle({
        width: "151px",
        height: "378px",
      });
    }
    expect(screen.getByText("Page 1 of 3")).toBeTruthy();
    expect(screen.getByText("Page 3 of 3")).toBeTruthy();
  });

  it("is one page, with no page label, when the content fits", async () => {
    measured.height = 500;
    render(<CanvasPane {...base} data={{}} />);
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.getAllByTitle(/Canvas preview/)).toHaveLength(1);
    expect(screen.queryByText(/Page \d+ of/)).toBeNull();
  });
});

describe("zoom maths", () => {
  it("fits the page to the width it has, never above 100%", () => {
    // 600 px of space, 32 px of it padding, against a 568 px page: exactly 100%.
    expect(fitZoom(600, 568)).toBe(1);
    expect(fitZoom(2000, 302)).toBe(1);
    // An A4 page (794 px) in 500 px of space.
    expect(fitZoom(500, 794)).toBeCloseTo((500 - 32) / 794, 5);
  });

  it("shows the page at full size before it has been measured, and never goes below 25%", () => {
    expect(fitZoom(0, 794)).toBe(1);
    expect(fitZoom(100, 794)).toBe(0.25);
  });

  it("enlarges a page that already fits when the pane's height is known, up to 300%", () => {
    // 80 × 100 mm label (302 × 378 px) in a 590 × 800 px pane: width is the limit.
    expect(fitZoom(590, 302, 800, 378)).toBeCloseTo((590 - 32) / 302, 5);
    // A tall pane is not the limit when the pane is narrow.
    expect(fitZoom(400, 302, 2000, 378)).toBeCloseTo((400 - 32) / 302, 5);
    // A short pane limits it by height.
    expect(fitZoom(2000, 302, 500, 378)).toBeCloseTo((500 - 32) / 378, 5);
    // Never beyond 300%.
    expect(fitZoom(5000, 100, 5000, 100)).toBe(3);
    // A page bigger than the pane keeps fitting by width, never by height.
    expect(fitZoom(500, 794, 600, 1123)).toBeCloseTo((500 - 32) / 794, 5);
    // No measured height: the old cap of 100% holds.
    expect(fitZoom(2000, 302, 0, 378)).toBe(1);
  });

  it("steps to the next zoom level up or down, and stops at the ends", () => {
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.75);
    expect(stepZoom(0.63, 1)).toBe(0.75);
    expect(stepZoom(0.63, -1)).toBe(0.5);
    expect(stepZoom(3, 1)).toBe(3);
    expect(stepZoom(0.25, -1)).toBe(0.25);
  });
});

describe("CanvasWorkspace", () => {
  const props = {
    html: "<p>Hi</p>",
    css: "",
    compiledCss: "",
    data: {},
    pageWidthMm: 80,
    pageHeightMm: 200,
  };
  const pageBox = () =>
    screen.getByTitle("Canvas preview").parentElement as HTMLElement;
  // The picker repeats the percentage once it is off Fit, so read the live readout next to the buttons.
  const readout = () =>
    document.querySelector("[aria-live=polite]") as HTMLElement;

  it("starts on Fit, with zoom controls in its own toolbar", () => {
    render(<CanvasWorkspace {...props} />);
    expect(
      screen.getByRole("combobox", { name: "Zoom level" }),
    ).toHaveTextContent("Fit");
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Zoom out" }),
    ).toBeInTheDocument();
    expect(readout()).toHaveTextContent("100%");
  });

  it("zooms out and in by steps, leaving Fit", async () => {
    render(<CanvasWorkspace {...props} />);
    // Wait past the page-count measuring skeleton: zooming acts on pages.
    await screen.findByTitle("Canvas preview");
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(readout()).toHaveTextContent("75%");
    expect(
      screen.getByRole("combobox", { name: "Zoom level" }),
    ).toHaveTextContent("75%");
    // The page is laid out at its true size (80 mm) and scaled.
    expect(pageBox()).toHaveStyle({
      width: `${80 * MM_TO_PX}px`,
      transform: "scale(0.75)",
    });
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(readout()).toHaveTextContent("125%");
  });

  it("offers Fit, 50% and 100% in the zoom picker", async () => {
    render(<CanvasWorkspace {...props} />);
    fireEvent.click(screen.getByRole("combobox", { name: "Zoom level" }));
    const options = (await screen.findAllByRole("option")).map(
      (o) => o.textContent,
    );
    expect(options).toEqual(["Fit", "50%", "100%"]);
    fireEvent.click(screen.getByRole("option", { name: "50%" }));
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Zoom level" }),
      ).toHaveTextContent("50%"),
    );
    // Zooming acts on measured pages: wait past the measuring skeleton
    // (150 ms settle) before asserting on the frame.
    await screen.findByTitle("Canvas preview");
    expect(pageBox()).toHaveStyle({ transform: "scale(0.5)" });
  });

  it("fills its parent when asked, so the page does not scroll", () => {
    const { container } = render(<CanvasWorkspace {...props} fill />);
    expect(container.firstElementChild).toHaveClass("h-full");
  });
});

describe("CodeEditors", () => {
  it("labels the HTML editor with the template name, and has a CSS editor", () => {
    render(
      <CodeEditors
        templateName="Label"
        htmlCode="<b>x</b>"
        cssCode="b{}"
        onHtmlChange={vi.fn()}
        onCssChange={vi.fn()}
      />,
    );
    expect(screen.getByText("HTML — Label")).toBeInTheDocument();
    expect(screen.getByText("CSS")).toBeInTheDocument();
  });

  it("states the no-network print guarantee above the editors", () => {
    render(
      <CodeEditors
        templateName="Label"
        htmlCode="<b>x</b>"
        cssCode="b{}"
        onHtmlChange={vi.fn()}
        onCssChange={vi.fn()}
      />,
    );
    expect(
      screen.getByText(/Printing never touches the network/),
    ).toBeInTheDocument();
  });
});

describe("EditorPane", () => {
  const props = () => ({
    templateName: "Label",
    htmlCode: "<b>x</b>",
    cssCode: "b{}",
    onHtmlChange: vi.fn(),
    onCssChange: vi.fn(),
    readme: "# Label docs",
    onReadmeChange: vi.fn(),
    readmeSaving: false,
    onSaveReadme: vi.fn(),
  });
  // Radix Tabs switch on mousedown, not click.
  const openTab = (name: string) => {
    const tab = screen.getByRole("tab", { name });
    fireEvent.mouseDown(tab, { button: 0 });
    fireEvent.click(tab);
  };

  it("has HTML, CSS and README tabs, starting on HTML", () => {
    render(<EditorPane {...props()} />);
    const names = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(names).toEqual(["HTML", "CSS", "README"]);
    expect(screen.getByRole("tab", { name: "HTML" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("keeps both code editors mounted, so a tab switch does not lose the cursor or undo history", () => {
    const { container } = render(<EditorPane {...props()} />);
    expect(container.querySelectorAll(".cm-editor")).toHaveLength(2);
    openTab("CSS");
    expect(screen.getByRole("tab", { name: "CSS" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(container.querySelectorAll(".cm-editor")).toHaveLength(2);
  });

  it("shows the README editor and its Save button on the README tab", () => {
    const p = props();
    render(<EditorPane {...p} />);
    expect(
      screen.queryByRole("button", { name: "Save README" }),
    ).not.toBeInTheDocument();
    openTab("README");
    expect(screen.queryByText(/README — Label/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save README" }));
    expect(p.onSaveReadme).toHaveBeenCalled();
  });

  it("disables Save README on a read-only copy", () => {
    render(<EditorPane {...props()} readmeReadOnly />);
    openTab("README");
    expect(screen.getByRole("button", { name: "Save README" })).toBeDisabled();
  });

  it("shows notices under the HTML and CSS tabs, but not README", () => {
    render(<EditorPane {...props()} notices={<p>watch out</p>} />);
    expect(screen.getByText("watch out")).toBeInTheDocument();
    openTab("CSS");
    expect(screen.getByText("watch out")).toBeInTheDocument();
    openTab("README");
    expect(screen.queryByText("watch out")).not.toBeInTheDocument();
  });

  it("offers exactly HTML, CSS and README, and none of the removed tabs", () => {
    render(<EditorPane {...props()} />);
    const list = screen.getByRole("tablist", { name: "Editor files" });
    expect(
      Array.from(list.querySelectorAll('[role="tab"]')).map(
        (t) => t.textContent,
      ),
    ).toEqual(["HTML", "CSS", "README"]);
    for (const name of [
      "Visual",
      "Preview",
      "Canvas",
      "Code",
      "Variables",
      "Sample data",
    ]) {
      expect(screen.queryByRole("tab", { name })).not.toBeInTheDocument();
    }
  });

  it("shows one panel at a time, though both code editors stay in the DOM", () => {
    render(<EditorPane {...props()} />);
    const html = screen.getByLabelText("HTML editor");
    const css = screen.getByLabelText("CSS editor");
    const panel = (el: HTMLElement) =>
      el.closest('[role="tabpanel"]') as HTMLElement;
    expect(panel(html)).toHaveAttribute("data-state", "active");
    expect(panel(css)).toHaveAttribute("data-state", "inactive");
    openTab("CSS");
    expect(panel(html)).toHaveAttribute("data-state", "inactive");
    expect(panel(css)).toHaveAttribute("data-state", "active");
    expect(screen.queryByText(/README — Label/)).not.toBeInTheDocument();
  });

  it("keeps the tab row to the tabs alone, so a long name cannot squeeze them into a scrollbar", () => {
    render(
      <EditorPane
        {...props()}
        templateName="Parcel Tag 80mm (1793396109) with a very long name"
      />,
    );
    const list = screen.getByRole("tablist", { name: "Editor files" });
    expect(list).toHaveClass("shrink-0", "overflow-visible");
    expect(
      screen.queryByTitle("Parcel Tag 80mm (1793396109) with a very long name"),
    ).not.toBeInTheDocument();
  });

  it("renders the initial HTML and CSS without reporting a change", () => {
    const p = props();
    render(<EditorPane {...p} />);
    expect(screen.getByLabelText("HTML editor")).toHaveTextContent("<b>x</b>");
    expect(screen.getByLabelText("CSS editor")).toHaveTextContent("b{}");
    expect(p.onHtmlChange).not.toHaveBeenCalled();
  });
});

describe("SampleDataPanel", () => {
  const datasets = [
    {
      name: "Sample Order",
      json: '{"store":{"name":"A"},"items":[]}',
      isDefault: true,
    },
    { name: "Empty", json: "{}", isDefault: false },
  ];
  const props = () => ({
    datasets,
    selectedName: "Sample Order",
    onSelect: vi.fn(),
    onAdd: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
  });

  it("picks the dataset the canvas uses, and lists its fields", () => {
    const p = props();
    render(<SampleDataPanel {...p} />);
    expect(
      screen.getByRole("radio", { name: "Use dataset Sample Order" }),
    ).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "Use dataset Empty" }));
    expect(p.onSelect).toHaveBeenCalledWith("Empty");
    expect(screen.getAllByText("{{store}}").length).toBeGreaterThan(0);
  });

  it("adds, edits and deletes datasets, but never deletes the default one", () => {
    const p = props();
    render(<SampleDataPanel {...p} />);
    fireEvent.click(screen.getByRole("button", { name: /Add Dataset/ }));
    expect(p.onAdd).toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[1]);
    expect(p.onEdit).toHaveBeenCalledWith(datasets[1]);
    expect(
      screen.getByRole("button", { name: "Delete dataset Sample Order" }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: "Delete dataset Empty" }),
    );
    expect(p.onDelete).toHaveBeenCalledWith(datasets[1]);
  });
});

// Phase 3: layout toggle, remembered state, icon rail, click-to-insert, error banner.
describe("getTemplateError", () => {
  it("is null for a template that renders", () => {
    expect(getTemplateError("<p>{{name}}</p>", { name: "x" })).toBeNull();
  });

  it("reports an unclosed block as a single line", () => {
    const msg = getTemplateError("<table>{{#each items}}<tr></tr>", {});
    expect(msg).toBeTruthy();
    expect(msg).not.toContain("\n");
  });

  it("reports a half-typed tag", () => {
    expect(getTemplateError("<p>{{order.</p>", {})).toBeTruthy();
  });
});

describe("CanvasWorkspace error banner", () => {
  const base = {
    css: "",
    compiledCss: "",
    data: {},
    pageWidthMm: 100,
    pageHeightMm: 150,
  };

  it("shows an alert while the template is invalid, and not otherwise", () => {
    const { rerender } = render(<CanvasWorkspace {...base} html="<p>ok</p>" />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    rerender(<CanvasWorkspace {...base} html="{{#each items}}<p>" />);
    expect(screen.getByRole("alert")).toHaveTextContent(/Template error/);
    rerender(<CanvasWorkspace {...base} html="<p>fixed</p>" />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("LayoutToggle", () => {
  it("marks the current layout and reports a change", () => {
    const onChange = vi.fn();
    render(<LayoutToggle value="side" onChange={onChange} />);
    expect(
      screen.getByRole("button", { name: "Side by side" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Stacked" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    fireEvent.click(screen.getByRole("button", { name: "Canvas only" }));
    expect(onChange).toHaveBeenCalledWith("canvas");
  });

  it("only accepts the three known layouts from storage", () => {
    expect(isDesignerLayout("stacked")).toBe(true);
    expect(isDesignerLayout("diagonal")).toBe(false);
    expect(isDesignerLayout(null)).toBe(false);
  });
});

describe("usePersistentState", () => {
  const isStrings = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((x) => typeof x === "string");

  it("starts from the initial value, then remembers what was set", () => {
    const first = renderHook(() =>
      usePersistentState("k", ["page"], isStrings),
    );
    expect(first.result.current[0]).toEqual(["page"]);
    act(() => first.result.current[1](["page", "helpers"]));
    const second = renderHook(() =>
      usePersistentState("k", ["page"], isStrings),
    );
    expect(second.result.current[0]).toEqual(["page", "helpers"]);
  });

  it("ignores a stored value that is invalid or not JSON", () => {
    window.localStorage.setItem("k", JSON.stringify([1, 2]));
    expect(
      renderHook(() => usePersistentState("k", ["page"], isStrings)).result
        .current[0],
    ).toEqual(["page"]);
    window.localStorage.setItem("k", "{not json");
    expect(
      renderHook(() => usePersistentState("k", ["page"], isStrings)).result
        .current[0],
    ).toEqual(["page"]);
  });
});

describe("ControlsAccordion, controlled", () => {
  const props = () => ({
    templates: [{ id: 1, name: "Label" }],
    currentTemplateId: 1,
    loadTemplate: vi.fn(),
    templateName: "Label",
    setTemplateName: vi.fn(),
    pageWidth: 100,
    setPageWidth: vi.fn(),
    pageHeight: 150,
    setPageHeight: vi.fn(),
    presets: [],
    onNewVersion: vi.fn(),
    openDiff: vi.fn(),
    handleRestoreVersion: vi.fn(),
    handleDeleteVersion: vi.fn(),
  });

  it("opens the sections it is given and reports every change, so the parent can remember them", () => {
    const onChange = vi.fn();
    render(
      <ControlsAccordion
        {...props()}
        openSections={["helpers"]}
        onOpenSectionsChange={onChange}
      />,
    );
    expect(screen.getByRole("button", { name: "Helpers" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("button", { name: "Page Setup" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    fireEvent.click(screen.getByRole("button", { name: "Page Setup" }));
    expect(onChange).toHaveBeenCalledWith(["helpers", "page"]);
  });
});

describe("ControlsRail", () => {
  it("offers one button per section and an expand button", () => {
    const onOpenSection = vi.fn();
    const onExpand = vi.fn();
    render(<ControlsRail onOpenSection={onOpenSection} onExpand={onExpand} />);
    fireEvent.click(screen.getByRole("button", { name: "Open Helpers" }));
    expect(onOpenSection).toHaveBeenCalledWith("helpers");
    fireEvent.click(screen.getByRole("button", { name: "Open Helpers" }));
    expect(onOpenSection).toHaveBeenCalledWith("helpers");
    fireEvent.click(screen.getByRole("button", { name: "Open Sample data" }));
    expect(onOpenSection).toHaveBeenCalledWith("sample");
    fireEvent.click(screen.getByRole("button", { name: "Open Custom input" }));
    expect(onOpenSection).toHaveBeenCalledWith("custom");
    fireEvent.click(screen.getByRole("button", { name: "Expand controls" }));
    expect(onExpand).toHaveBeenCalled();
    // Expand, Page Setup, Sample data, Helpers, Custom input. Templates live in the top row.
    expect(screen.getAllByRole("button")).toHaveLength(5);
    expect(
      screen.queryByRole("button", { name: "Open Templates" }),
    ).not.toBeInTheDocument();
  });
});

describe("HelpersPanel", () => {
  it("is a plain reference when there is nowhere to insert", () => {
    render(<HelpersPanel />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("{{currency}}")).toBeInTheDocument();
  });

  it("inserts a helper with the cursor left before the closing braces", () => {
    const onInsert = vi.fn();
    render(<HelpersPanel onInsert={onInsert} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Insert currency helper" }),
    );
    expect(onInsert).toHaveBeenCalledWith("{{currency }}", 2);
    expect(helperSnippet("upper")).toEqual({ text: "{{upper }}", back: 2 });
  });

  it("starts a barcode call with a symbology", () => {
    expect(helperSnippet("barcode")).toEqual({
      text: '{{barcode "code128" }}',
      back: 2,
    });
    expect(helperSnippet("qrcode")).toEqual({ text: "{{qrcode }}", back: 2 });
  });
});

describe("EditorPane insertAtCursor", () => {
  function Harness({ handle }: { handle: React.RefObject<EditorPaneHandle> }) {
    const [html, setHtml] = useState("<p></p>");
    const [css, setCss] = useState("");
    return (
      <>
        <EditorPane
          ref={handle}
          templateName="Label"
          htmlCode={html}
          cssCode={css}
          onHtmlChange={setHtml}
          onCssChange={setCss}
          readme=""
          onReadmeChange={() => {}}
          readmeSaving={false}
          onSaveReadme={() => {}}
        />
        <output data-testid="html">{html}</output>
      </>
    );
  }

  it("puts the text into the HTML document and updates the page state", async () => {
    const handle = createRef<EditorPaneHandle>();
    render(<Harness handle={handle} />);
    await act(async () => {
      handle.current!.insertAtCursor("{{upper }}", 2);
    });
    expect(screen.getByTestId("html").textContent).toContain("{{upper }}");
  });

  it("switches back to the HTML tab first", async () => {
    const handle = createRef<EditorPaneHandle>();
    render(<Harness handle={handle} />);
    const css = screen.getByRole("tab", { name: "CSS" });
    fireEvent.mouseDown(css);
    fireEvent.click(css);
    await act(async () => {
      handle.current!.insertAtCursor("x");
    });
    expect(screen.getByRole("tab", { name: "HTML" })).toHaveAttribute(
      "data-state",
      "active",
    );
  });
});

describe("DesignerOverflowMenu", () => {
  it("hides New and visibility behind More, and reports state outside", async () => {
    const { DesignerOverflowMenu } = await import(
      "@/components/designer/DesignerOverflowMenu"
    );
    const onNew = vi.fn();
    const onVisibilityChange = vi.fn();
    render(
      <DesignerOverflowMenu
        onNew={onNew}
        published={false}
        remoteId="r1"
        readOnly={false}
        busy={false}
        onVisibilityChange={onVisibilityChange}
      />,
    );
    // State reads without opening: unpublished server copy.
    expect(screen.getByText("Private")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New template" })).toBeNull();
    const more = () => screen.getByRole("button", { name: "More" });
    const openMenu = () =>
      fireEvent.pointerDown(more(), { button: 0, ctrlKey: false });
    openMenu();
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "New Template" }),
    );
    expect(onNew).toHaveBeenCalledOnce();
    openMenu();
    fireEvent.click(
      await screen.findByRole("menuitemcheckbox", { name: "Private" }),
    );
    expect(onVisibilityChange).toHaveBeenCalledWith(true);
  });
});
