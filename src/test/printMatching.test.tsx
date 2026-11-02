import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@/lib/i18n";

// Mutable so each test shapes its own printer/template world; the hook and
// lister mocks below read it live, like the real backend would.
const h = vi.hoisted(() => ({
  printers: [] as Array<Record<string, unknown>>,
  templates: [] as Array<Record<string, unknown>>,
}));

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));
vi.mock("@/lib/templates/listTemplates", () => ({
  listTemplates: async () => h.templates,
}));
vi.mock("@/lib/hooks/useSystemPrinters", () => ({
  useSystemPrinters: () => ({
    printers: h.printers,
    refresh: async () => h.printers,
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { toast } from "sonner";
import { PrintPage } from "@/pages/Print";
import { usePrintStore } from "@/lib/store/printStore";
import { parsePrintPrefs } from "@/lib/printPrefs";

const template = (id: number, name: string, w: number, hh: number) => ({
  id,
  name,
  page_w_mm: w,
  page_h_mm: hh,
  orientation: "portrait",
  html: "<p>x</p>",
  css: "",
  compiled_css: "",
  compiled_key: "",
});

beforeAll(() => {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.scrollIntoView = () => {};
});

beforeEach(() => {
  invoke.mockReset();
  localStorage.clear();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  // "Shipping label" is listed first so the preselect is not the same as
  // the remembered template — otherwise the memory test proves nothing.
  h.templates = [
    template(7, "Shipping label", 100, 150),
    template(8, "A4 sheet", 210, 297),
  ];
  h.printers = [
    { id: "saved:1", name: "Thermal 80", paper_width_mm: 80 },
    { id: "saved:2", name: "Front Desk", paper_width_mm: null },
  ];
  usePrintStore.setState({
    printerId: "",
    templateId: "",
    status: "idle",
    error: "",
    paperW: null,
    paperH: null,
  });
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "print_html") {
      return { success: true, job_id: "1", duration_ms: 50, timings: null };
    }
    return null;
  });
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <PrintPage />
    </MemoryRouter>,
  );

const pickPrinter = async (name: string) => {
  fireEvent.click(screen.getByRole("combobox", { name: "Printer" }));
  fireEvent.click(await screen.findByRole("option", { name }));
};
const pickTemplate = async (name: string) => {
  fireEvent.click(screen.getByRole("combobox", { name: "Template" }));
  fireEvent.click(await screen.findByRole("option", { name }));
};
const pickPaperPreset = async (name: string) => {
  fireEvent.click(screen.getByRole("combobox", { name: "Paper size" }));
  fireEvent.click(await screen.findByRole("option", { name }));
};
const printedPrefs = (): Record<string, unknown> =>
  JSON.parse(localStorage.getItem("printninja-setting:print_prefs") ?? "{}");

describe("paper size mismatch warning", () => {
  it("warns when the preselected template is wider than the printer's paper", async () => {
    renderPage();
    // Thermal 80 (80 mm) + Shipping label (100×150) are both preselected.
    expect(
      await screen.findByText(
        "Template is 100 × 150 mm; this printer uses 80 mm paper.",
      ),
    ).toBeInTheDocument();
  });

  it("drops the warning when the chosen printer has no registered width", async () => {
    renderPage();
    await screen.findByText(/this printer uses 80 mm paper/);
    await pickPrinter("Front Desk");
    await waitFor(() =>
      expect(screen.queryByText(/this printer uses 80 mm paper/)).toBeNull(),
    );
  });

  it("names the explicit paper, not the template, when a preset is set", async () => {
    renderPage();
    await screen.findByRole("button", { name: /^Print$/ });
    await pickPaperPreset("A4 (210 × 297 mm)");
    expect(
      await screen.findByText(
        "Paper is 210 × 297 mm; this printer uses 80 mm paper.",
      ),
    ).toBeInTheDocument();
  });
});

describe("per-printer remembered choices", () => {
  it("restores the remembered template and paper on the next visit", async () => {
    const { unmount } = renderPage();
    const print = await screen.findByRole("button", { name: /^Print$/ });
    await waitFor(() => expect(print).toBeEnabled());
    await pickTemplate("A4 sheet");
    await pickPaperPreset("A4 (210 × 297 mm)");
    fireEvent.click(print);
    expect(await screen.findByText("Print sent")).toBeInTheDocument();
    expect(printedPrefs()).toEqual({
      "thermal 80": { template_id: "8", paper_w: 210, paper_h: 297 },
    });

    // Fresh app: empty store, prefs still in localStorage.
    unmount();
    usePrintStore.setState({
      printerId: "",
      templateId: "",
      paperW: null,
      paperH: null,
    });
    renderPage();
    // Thermal 80 is preselected and its remembered template beats the
    // first-listed one (Shipping label); the paper comes back too.
    expect(await screen.findByText("A4 sheet")).toBeInTheDocument();
    await waitFor(() => expect(usePrintStore.getState().paperW).toBe(210));
    expect(usePrintStore.getState().paperH).toBe(297);
    // The remembered state is exactly the mismatching one, so the warning
    // comes back with it.
    expect(
      await screen.findByText(
        "Paper is 210 × 297 mm; this printer uses 80 mm paper.",
      ),
    ).toBeInTheDocument();
  });

  it("reapplies each printer's own choices when switching between them", async () => {
    renderPage();
    const print = await screen.findByRole("button", { name: /^Print$/ });
    await waitFor(() => expect(print).toBeEnabled());

    // Thermal 80: default template, no paper.
    fireEvent.click(print);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "print_html",
        expect.objectContaining({
          req: expect.objectContaining({ printer_name: "Thermal 80" }),
        }),
      ),
    );

    // Front Desk: the wider template on an explicit A4 sheet.
    await pickPrinter("Front Desk");
    await pickTemplate("A4 sheet");
    await pickPaperPreset("A4 (210 × 297 mm)");
    fireEvent.click(print);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "print_html",
        expect.objectContaining({
          req: expect.objectContaining({ printer_name: "Front Desk" }),
        }),
      ),
    );
    expect(printedPrefs()).toEqual({
      "thermal 80": { template_id: "7", paper_w: null, paper_h: null },
      "front desk": { template_id: "8", paper_w: 210, paper_h: 297 },
    });

    // Back to Thermal 80: its narrower template and template-size paper.
    await pickPrinter("Thermal 80");
    expect(screen.getByText("Shipping label")).toBeInTheDocument();
    expect(usePrintStore.getState().paperW).toBeNull();
    // And the warning is back: 100 mm template on 80 mm paper.
    expect(
      await screen.findByText(
        "Template is 100 × 150 mm; this printer uses 80 mm paper.",
      ),
    ).toBeInTheDocument();

    // Front Desk again: its A4 choices come back.
    await pickPrinter("Front Desk");
    expect(screen.getByText("A4 sheet")).toBeInTheDocument();
    expect(usePrintStore.getState().paperW).toBe(210);
  });
});

describe("parsePrintPrefs", () => {
  it("returns {} for missing, corrupt or non-object values", () => {
    expect(parsePrintPrefs(null)).toEqual({});
    expect(parsePrintPrefs("{oops")).toEqual({});
    expect(parsePrintPrefs('"str"')).toEqual({});
    expect(parsePrintPrefs("[1,2]")).toEqual({});
    expect(parsePrintPrefs("null")).toEqual({});
  });

  it("keeps only well-formed entries and nulls bad paper sizes", () => {
    expect(
      parsePrintPrefs(
        JSON.stringify({
          good: { template_id: "3", paper_w: 80, paper_h: null },
          "no template": { paper_w: 80 },
          zero: { template_id: "4", paper_w: 0, paper_h: -5 },
          "wrong type": { template_id: 5 },
        }),
      ),
    ).toEqual({
      good: { template_id: "3", paper_w: 80, paper_h: null },
      zero: { template_id: "4", paper_w: null, paper_h: null },
    });
  });
});
