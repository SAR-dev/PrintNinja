import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
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
    paperCustom: false,
    pageRange: "",
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

const failNow = () =>
  act(() => {
    usePrintStore.setState({
      status: "failed",
      error: "boom",
      warnings: ["old warning"],
    });
  });

describe("changing the template or printer", () => {
  it("drops the previous print's outcome when the template changes", async () => {
    renderPage();
    await screen.findByRole("button", { name: /^Print$/ });
    failNow();
    expect(usePrintStore.getState().status).toBe("failed");
    await pickTemplate("A4 sheet");
    const st = usePrintStore.getState();
    expect(st.templateId).toBe("8");
    expect([st.status, st.error, st.warnings]).toEqual(["idle", "", []]);
  });

  it("drops the previous print's outcome when the printer changes", async () => {
    renderPage();
    await screen.findByRole("button", { name: /^Print$/ });
    failNow();
    await pickPrinter("Front Desk");
    const st = usePrintStore.getState();
    expect(st.printerId).toBe("Front Desk");
    expect([st.status, st.error]).toEqual(["idle", ""]);
  });

  it("does not touch a running print", async () => {
    renderPage();
    await screen.findByRole("button", { name: /^Print$/ });
    act(() => usePrintStore.setState({ status: "printing" }));
    await pickTemplate("A4 sheet");
    expect(usePrintStore.getState().status).toBe("printing");
  });

  it("clears a page range typed for another template", async () => {
    renderPage();
    await screen.findByRole("button", { name: /^Print$/ });
    fireEvent.change(document.getElementById("page-range")!, {
      target: { value: "2-3" },
    });
    expect(usePrintStore.getState().pageRange).toBe("2-3");
    await pickTemplate("A4 sheet");
    expect(usePrintStore.getState().pageRange).toBe("");
  });

  it("keeps the page range when the same template is picked again", async () => {
    renderPage();
    await screen.findByRole("button", { name: /^Print$/ });
    fireEvent.change(document.getElementById("page-range")!, {
      target: { value: "2-3" },
    });
    await pickTemplate("Shipping label");
    expect(usePrintStore.getState().pageRange).toBe("2-3");
  });

  it("does not carry one printer's paper to a printer with no memory", async () => {
    renderPage();
    await screen.findByRole("button", { name: /^Print$/ });
    await pickPaperPreset("A4 (210 × 297 mm)");
    expect(usePrintStore.getState().paperW).toBe(210);
    await pickPrinter("Front Desk");
    const st = usePrintStore.getState();
    expect([st.paperW, st.paperH, st.paperCustom]).toEqual([null, null, false]);
  });

  it("restores a remembered printer's template and paper, Custom included", async () => {
    renderPage();
    await screen.findByRole("button", { name: /^Print$/ });
    await pickPrinter("Front Desk");
    await pickTemplate("A4 sheet");
    act(() => usePrintStore.getState().setPaper(150, 150));
    fireEvent.click(screen.getByRole("button", { name: /^Print$/ }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("print_html", expect.anything()),
    );
    // Another printer in between, then back to the remembered one.
    await pickPrinter("Thermal 80");
    expect(usePrintStore.getState().paperW).toBeNull();
    await pickPrinter("Front Desk");
    const st = usePrintStore.getState();
    expect(st.templateId).toBe("8");
    expect([st.paperW, st.paperH, st.paperCustom]).toEqual([150, 150, true]);
    expect(document.getElementById("paper-w")).not.toBeNull();
  });
});
