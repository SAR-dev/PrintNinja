import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
  within,
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

const phoneMatchMedia = (query: string) =>
  ({
    matches: query.includes("767"),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }) as unknown as MediaQueryList;

beforeEach(() => {
  window.matchMedia = phoneMatchMedia as typeof window.matchMedia;
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

const failNow = () =>
  act(() => {
    usePrintStore.setState({
      status: "failed",
      error: "boom",
      pageRange: "2-3",
    });
  });

describe("phone Print page: changing the template or printer", () => {
  it("drops the old outcome and page range when a template is picked in the sheet", async () => {
    renderPage();
    const trigger = await screen.findByTestId("print-template");
    await waitFor(() => expect(usePrintStore.getState().templateId).toBe("7"));
    failNow();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      await within(dialog).findByRole("button", { name: /A4 sheet/ }),
    );
    const st = usePrintStore.getState();
    expect(st.templateId).toBe("8");
    expect([st.status, st.error, st.pageRange]).toEqual(["idle", "", ""]);
  });

  it("drops the old outcome when the printer changes", async () => {
    renderPage();
    await screen.findByTestId("print-template");
    failNow();
    await pickPrinter("Front Desk");
    const st = usePrintStore.getState();
    expect(st.printerId).toBe("Front Desk");
    expect([st.status, st.error]).toEqual(["idle", ""]);
  });

  it("does not carry one printer's paper to a printer with no memory", async () => {
    renderPage();
    await screen.findByTestId("print-template");
    act(() => usePrintStore.getState().selectPaper("a4"));
    await pickPrinter("Front Desk");
    const st = usePrintStore.getState();
    expect([st.paperW, st.paperH]).toEqual([null, null]);
  });
});
