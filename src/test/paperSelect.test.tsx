import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@/lib/i18n";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));
vi.mock("@/lib/templates/listTemplates", () => ({
  listTemplates: async () => [
    {
      id: 7,
      name: "Shipping label",
      page_w_mm: 100,
      page_h_mm: 150,
      orientation: "portrait",
      html: "<p>Hi {{store.name}}</p>",
      css: "",
      compiled_css: "",
      compiled_key: "",
    },
  ],
}));
// The page reads `printers` on mount; tests that need a different
// listing (e.g. a PDF printer) swap the holder, and beforeEach resets
// it back. `refresh` follows the invoke mock, as the real hook does.
const { mockPrinters, defaultPrinters } = vi.hoisted(() => {
  const defaultPrinters = [
    {
      id: "1",
      name: "Dock Zebra",
      address: "127.0.0.1:9100",
      printer_type: "raw_tcp",
      language: "escpos",
    },
  ];
  return { mockPrinters: { current: defaultPrinters }, defaultPrinters };
});
vi.mock("@/lib/hooks/useSystemPrinters", () => ({
  useSystemPrinters: () => ({
    printers: mockPrinters.current,
    refresh: async () => (await invoke("list_printers", {})) ?? [],
  }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { toast } from "sonner";
import { PrintPage } from "@/pages/Print";
import { usePrintStore } from "@/lib/store/printStore";

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
  mockPrinters.current = defaultPrinters;
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  usePrintStore.setState({
    printerId: "",
    templateId: "",
    status: "idle",
    error: "",
    copies: 1,
    timings: null,
    pageRange: "",
    grayscale: false,
    orientation: "portrait",
    paperW: null,
    paperH: null,
    dataUrl: "",
    httpMethod: "GET",
    useTestData: false,
  });
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "list_printers" || cmd === "enumerate_system_printers")
      return [{ id: "1", name: "Dock Zebra" }];
    if (cmd === "print_html") {
      return {
        success: true,
        job_id: "9",
        duration_ms: 120,
        timings: {
          fetch_ms: 0,
          template_ms: 1,
          layout_ms: 0,
          render_ms: 90,
          send_ms: 25,
          history_ms: 4,
          total_ms: 120,
        },
      };
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

const open = async (name: RegExp | string) => {
  const paper = await screen.findByRole("combobox", { name: "Paper size" });
  fireEvent.click(paper);
  fireEvent.click(await screen.findByRole("option", { name }));
  return paper;
};
const w = () => document.getElementById("paper-w") as HTMLInputElement | null;
const h = () => document.getElementById("paper-h") as HTMLInputElement | null;

describe("Print page: paper size selection", () => {
  beforeEach(() => {
    usePrintStore.setState({ paperW: null, paperH: null, paperCustom: false });
  });

  it("keeps Custom open when chosen from a preset", async () => {
    renderPage();
    await open(/A4/);
    const paper = screen.getByRole("combobox", { name: "Paper size" });
    fireEvent.click(paper);
    fireEvent.click(await screen.findByRole("option", { name: /Custom/ }));
    expect(usePrintStore.getState().paperCustom).toBe(true);
    // Seeded from the previous size, and the inputs are there to edit.
    expect(w()?.value).toBe("210");
    expect(h()?.value).toBe("297");
  });

  it("keeps the inputs open when the typed size matches a preset", async () => {
    renderPage();
    await open(/Custom/);
    fireEvent.change(w()!, { target: { value: "210" } });
    fireEvent.change(h()!, { target: { value: "297" } });
    expect(w()).not.toBeNull();
    expect(usePrintStore.getState().paperW).toBe(210);
  });

  it("keeps the inputs open when both are cleared", async () => {
    renderPage();
    await open(/Custom/);
    fireEvent.change(w()!, { target: { value: "" } });
    fireEvent.change(h()!, { target: { value: "" } });
    expect(w()).not.toBeNull();
    // Cleared axes fall back to the template size.
    expect(usePrintStore.getState().paperW).toBeNull();
  });

  it("ignores zero and negative sizes instead of forcing 1", async () => {
    renderPage();
    await open(/Custom/);
    fireEvent.change(w()!, { target: { value: "120" } });
    fireEvent.change(w()!, { target: { value: "0" } });
    fireEvent.change(w()!, { target: { value: "-5" } });
    expect(usePrintStore.getState().paperW).toBe(120);
  });

  it("leaves Custom when a preset or Template size is picked", async () => {
    renderPage();
    await open(/Custom/);
    await open(/A4/);
    expect(usePrintStore.getState().paperCustom).toBe(false);
    expect(w()).toBeNull();
  });

  it("shows the sheet that prints (orientation applied) in the note", async () => {
    usePrintStore.setState({ paperW: 210, paperH: 297 });
    renderPage();
    const orientation = await screen.findByRole("combobox", {
      name: "Orientation",
    });
    fireEvent.click(orientation);
    fireEvent.click(await screen.findByRole("option", { name: "Landscape" }));
    expect(await screen.findByText(/paper 297 × 210 mm/)).toBeTruthy();
  });
});

describe("printStore paper actions", () => {
  it("setPaper marks only non-preset sizes as custom", () => {
    const st = usePrintStore.getState();
    st.setPaper(210, 297);
    expect(usePrintStore.getState().paperCustom).toBe(false);
    st.setPaper(150, 150);
    expect(usePrintStore.getState().paperCustom).toBe(true);
    st.setPaper(null, null);
    expect(usePrintStore.getState().paperCustom).toBe(false);
  });
  it("selectPaper(auto) clears the override", () => {
    const st = usePrintStore.getState();
    st.selectPaper("custom", { w: 90, h: 120 });
    expect(usePrintStore.getState().paperW).toBe(90);
    st.selectPaper("auto");
    const s = usePrintStore.getState();
    expect([s.paperW, s.paperH, s.paperCustom]).toEqual([null, null, false]);
  });
});
