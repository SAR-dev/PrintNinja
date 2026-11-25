import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@/lib/i18n";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => {
    // Android-simulated tests run with the local network permission
    // granted: they exercise the granted flows, not the prompt.
    if (cmd === "plugin:android-print|local_network_permission_state") {
      return Promise.resolve({ granted: true, canAskAgain: false });
    }
    if (cmd === "plugin:android-print|request_local_network_permission") {
      return Promise.resolve({ granted: true, openedSettings: false });
    }
    if (cmd === "plugin:android-print|open_local_network_settings") {
      return Promise.resolve(null);
    }
    return invoke(cmd, args);
  },
}));
// The page reads the template list on mount; tests that need a
// different listing (e.g. a scene track row) swap the holder, and
// beforeEach resets it back.
const { mockTemplates, defaultTemplates } = vi.hoisted(() => {
  const defaultTemplates = [
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
  ];
  return { mockTemplates: { current: defaultTemplates }, defaultTemplates };
});
vi.mock("@/lib/templates/listTemplates", () => ({
  listTemplates: async () => mockTemplates.current,
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
import { DEFAULT_MOCK_DATA } from "@/lib/templates/defaultTemplate";

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
  mockTemplates.current = defaultTemplates;
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

describe("Print page", () => {
  it("preselects the first printer and template and enables one primary Print button", async () => {
    renderPage();
    const print = await screen.findByRole("button", { name: /^Print$/ });
    await waitFor(() => expect(print).toBeEnabled());
  });

  it("explains why printing is disabled when nothing is chosen", async () => {
    usePrintStore.setState({ printerId: "", templateId: "" });
    invoke.mockImplementation(async () => []);
    renderPage();
    expect(
      await screen.findByText(/Choose a printer to enable printing/),
    ).toBeInTheDocument();
  });

  it("shows the preview for the selected template without opening a dialog", async () => {
    renderPage();
    const frame = await screen.findByTitle("Print preview");
    expect(frame).toHaveAttribute("sandbox", "");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("folds the layout options behind Advanced, closed by default", async () => {
    renderPage();
    const toggle = await screen.findByRole("button", {
      name: /Advanced options/,
    });
    // Folded: the header shows the current values, the fields stay hidden.
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent(/Portrait/);
    expect(screen.queryByRole("group", { name: /Margins/ })).toBeNull();
    expect(screen.queryByLabelText("Paper size")).toBeNull();
    expect(screen.queryByLabelText("Fit mode")).toBeNull();
    // Opening exposes every moved field.
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("group", { name: /Margins/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Paper size")).toBeInTheDocument();
    expect(screen.getByLabelText("Fit mode")).toBeInTheDocument();
    expect(screen.getByLabelText("HTTP method")).toBeInTheDocument();
    expect(screen.getByLabelText("Pages")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Send test page/ }),
    ).toBeInTheDocument();
  });

  it("announces success, and failure with a retry", async () => {
    renderPage();
    const print = await screen.findByRole("button", { name: /^Print$/ });
    await waitFor(() => expect(print).toBeEnabled());
    fireEvent.click(print);
    expect(await screen.findByText("Print sent")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith(
      "print_html",
      expect.objectContaining({
        req: expect.objectContaining({
          printer_name: "Dock Zebra",
          template_id: 7,
        }),
      }),
    );

    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "print_html")
        return {
          success: false,
          job_id: "10",
          duration_ms: 5,
          error: "Paper out",
        };
      return [];
    });
    fireEvent.click(screen.getByRole("button", { name: /^Print$/ }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Paper out");
    expect(
      screen.getByRole("button", { name: "Try again" }),
    ).toBeInTheDocument();
  });

  it("sends page range and grayscale with the print request", async () => {
    usePrintStore.setState({ pageRange: "1-3", grayscale: true });
    renderPage();
    const print = await screen.findByRole("button", { name: /^Print$/ });
    await waitFor(() => expect(print).toBeEnabled());
    fireEvent.click(print);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "print_html",
        expect.objectContaining({
          req: expect.objectContaining({
            page_range: "1-3",
            grayscale: true,
          }),
        }),
      ),
    );
  });

  it("sends the chosen data-url HTTP method with the print request", async () => {
    usePrintStore.setState({
      dataUrl: "https://api.example.com/orders/123",
      httpMethod: "POST",
    });
    renderPage();
    const print = await screen.findByRole("button", { name: /^Print$/ });
    await waitFor(() => expect(print).toBeEnabled());
    fireEvent.click(print);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "print_html",
        expect.objectContaining({
          req: expect.objectContaining({
            data_url: "https://api.example.com/orders/123",
            http_method: "POST",
          }),
        }),
      ),
    );
  });

  it("sends the template size as paper by default, explicit paper when set", async () => {
    renderPage();
    const print = await screen.findByRole("button", { name: /^Print$/ });
    await waitFor(() => expect(print).toBeEnabled());
    fireEvent.click(print);
    // Mock template is 100×150 portrait: orientation and paper follow it.
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "print_html",
        expect.objectContaining({
          req: expect.objectContaining({
            page_width_mm: 100,
            page_height_mm: 150,
            orientation: "portrait",
          }),
        }),
      ),
    );
  });

  it("sends an explicit paper size override with the print request", async () => {
    usePrintStore.setState({ paperW: 210, paperH: 297 });
    renderPage();
    const print = await screen.findByRole("button", { name: /^Print$/ });
    await waitFor(() => expect(print).toBeEnabled());
    fireEvent.click(print);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "print_html",
        expect.objectContaining({
          req: expect.objectContaining({
            page_width_mm: 210,
            page_height_mm: 297,
          }),
        }),
      ),
    );
  });
  it("lets Template size be re-selected after a preset was chosen", async () => {
    renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: /Advanced options/ }),
    );
    const paper = await screen.findByRole("combobox", { name: "Paper size" });
    // Choose A4, then ask for the template size again: the override must
    // be cleared, not re-applied as a no-op.
    // Radix opens the trigger and selects items on click when no pointer
    // type was set (the jsdom default), unlike a real mouse pointerdown.
    fireEvent.click(paper);
    fireEvent.click(await screen.findByRole("option", { name: /A4/ }));
    expect(usePrintStore.getState().paperW).toBe(210);
    expect(usePrintStore.getState().paperH).toBe(297);
    fireEvent.click(paper);
    fireEvent.click(
      await screen.findByRole("option", { name: "Template size" }),
    );
    expect(usePrintStore.getState().paperW).toBeNull();
    expect(usePrintStore.getState().paperH).toBeNull();
    const print = screen.getByRole("button", { name: /^Print$/ });
    fireEvent.click(print);
    // The job goes out at the template size again.
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "print_html",
        expect.objectContaining({
          req: expect.objectContaining({
            page_width_mm: 100,
            page_height_mm: 150,
          }),
        }),
      ),
    );
  });

  it("sends the pages count with the print request", async () => {
    renderPage();
    const print = await screen.findByRole("button", { name: /^Print$/ });
    await waitFor(() => expect(print).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /Advanced options/ }));
    fireEvent.change(screen.getByLabelText("Pages"), {
      target: { value: "3" },
    });
    fireEvent.click(print);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "print_html",
        expect.objectContaining({
          req: expect.objectContaining({ records: 3 }),
        }),
      ),
    );
  });

  it("marks a ready printer with a quiet chip next to the select", async () => {
    renderPage();
    // Ready is the normal state, so it is a small chip, not a banner.
    expect(await screen.findByTestId("print-ready-chip")).toBeInTheDocument();
  });

  it("shows a printing banner in the status slot while the job runs", async () => {
    let finish: (v: unknown) => void = () => {};
    const base = invoke.getMockImplementation() as (
      cmd: string,
      args?: unknown,
    ) => Promise<unknown>;
    invoke.mockImplementation((cmd: string, args?: unknown) =>
      cmd === "print_html"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : base(cmd, args),
    );
    renderPage();
    const print = await screen.findByRole("button", { name: /^Print$/ });
    await waitFor(() => expect(print).toBeEnabled());
    fireEvent.click(print);
    const banner = (
      await screen.findAllByText("Printing…", { selector: "span" })
    )[0].closest("[role=status]");
    expect(banner).not.toBeNull();
    expect(banner?.firstElementChild?.className).toMatch(/\bh-11\b/);
    expect(screen.queryByText("Print sent")).toBeNull();
    finish({ success: true, job_id: "9", duration_ms: 120 });
    expect(await screen.findByText("Print sent")).toBeInTheDocument();
    expect(screen.queryByText("Printing…", { selector: "span" })).toBeNull();
  });

  it("keeps the status banner the same height from printing to sent", async () => {
    let finish: (v: unknown) => void = () => {};
    const base = invoke.getMockImplementation() as (
      cmd: string,
      args?: unknown,
    ) => Promise<unknown>;
    invoke.mockImplementation((cmd: string, args?: unknown) =>
      cmd === "print_html"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : base(cmd, args),
    );
    renderPage();
    const print = await screen.findByRole("button", { name: /^Print$/ });
    await waitFor(() => expect(print).toBeEnabled());
    const fixed = (el: Element | null) =>
      el?.firstElementChild?.className.match(/\bh-11\b/);
    fireEvent.click(print);
    const printing = (
      await screen.findAllByText("Printing…", { selector: "span" })
    )[0].closest("[role=status]");
    expect(fixed(printing)).toBeTruthy();
    finish({ success: true, job_id: "9", duration_ms: 120 });
    const sent = (await screen.findByText("Print sent")).closest(
      "[role=status]",
    );
    expect(fixed(sent)).toBeTruthy();
  });

  it("reports a finished print in the alert, with its timing, and shows no toast", async () => {
    renderPage();
    const print = await screen.findByRole("button", { name: /^Print$/ });
    await waitFor(() => expect(print).toBeEnabled());
    fireEvent.click(print);
    expect(await screen.findByText("Print sent")).toBeInTheDocument();
    expect(screen.queryByTestId("print-ready-chip")).toBeNull();
    // The banner stays one line; the stage timings open on request.
    expect(screen.queryByTestId("timing-breakdown")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Details/ }));
    const timing = screen.getByTestId("timing-breakdown");
    expect(timing).toHaveTextContent("Total 0.120 s");
    expect(timing).toHaveTextContent("Render 0.090 s (75%)");
    expect(timing).toHaveTextContent("Send 0.025 s (21%)");
    expect(timing).toHaveTextContent("History write 0.004 s (3%)");
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe("Print via PC", () => {
  const PAIR = {
    id: "pc-1",
    name: "Studio PC",
    host: "192.168.1.9",
    port: 17717,
    secret: "s",
    fingerprint: "",
    provider_id: "pc-1",
    platform: "linux",
    paired_at: "",
    device_id: "phone-1",
  };
  const remoteOk = {
    success: true,
    status: "success",
    pc_job_id: "7",
    duration_ms: 50,
    error: null,
    code: null,
    pc_name: "Studio PC",
  };

  function viaPcBackend(
    opts: {
      pairs?: unknown[];
      printers?: unknown[];
      pcTemplates?: unknown[];
      cached?: boolean;
      print?: unknown;
    } = {},
  ) {
    invoke.mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === "get_setting") {
        if (args?.key === "print_via_pc") return "true";
        if (args?.key === "render_pairs")
          return JSON.stringify(opts.pairs ?? [PAIR]);
        return null;
      }
      if (cmd === "list_printers" || cmd === "enumerate_system_printers")
        return [{ id: "1", name: "Dock Zebra" }];
      if (cmd === "remote_printers")
        return {
          printers: opts.printers ?? [
            { name: "PC Printer", printer_type: "ipp", language: "pdf" },
          ],
          cached: opts.cached ?? false,
        };
      if (cmd === "pc_templates")
        return {
          templates: opts.pcTemplates ?? [
            { name: "PC Receipt", server_id: "srv-pc-1", server_revision: 3 },
          ],
          cached: false,
        };
      if (cmd === "remote_print") return opts.print ?? remoteOk;
      return null;
    });
  }

  const remoteCalls = () =>
    invoke.mock.calls
      .filter((c) => c[0] === "remote_print")
      .map((c) => (c[1] as any).args);

  it("prints through the PC and never calls the local pipeline", async () => {
    viaPcBackend();
    renderPage();
    expect(await screen.findByTestId("print-via-pc-banner")).toHaveTextContent(
      "Studio PC",
    );
    const print = await screen.findByRole("button", { name: /^Print$/ });
    await waitFor(() => expect(print).toBeEnabled());
    fireEvent.click(print);

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "remote_print",
        expect.objectContaining({
          args: expect.objectContaining({
            // Via-PC identity comes from the PC's own listing, not the
            // phone's row: matched by construction.
            template_id: undefined,
            template_name: "PC Receipt",
            template_server_id: "srv-pc-1",
            template_server_revision: 3,
            printer_name: "PC Printer",
            copies: 1,
          }),
        }),
      ),
    );
    expect(invoke).not.toHaveBeenCalledWith("print_html", expect.anything());
    expect(await screen.findByText("Print sent")).toBeInTheDocument();
    expect(screen.getByTestId("print-printed-via")).toHaveTextContent(
      "Studio PC",
    );
  });

  it("says when the printer list is cached", async () => {
    viaPcBackend({ cached: true });
    renderPage();
    expect(await screen.findByTestId("print-via-pc-banner")).toHaveTextContent(
      /cached/,
    );
  });

  it("lists the PC's templates while via-PC is on", async () => {
    viaPcBackend({
      pcTemplates: [
        { name: "PC Receipt", server_id: "srv-pc-1", server_revision: 3 },
        { name: "PC Label", server_id: "srv-pc-2", server_revision: 1 },
      ],
    });
    renderPage();
    await screen.findByTestId("print-via-pc-banner");
    // The picker offers the PC's rows (snapped to the first), not the
    // phone's own template.
    const picker = await screen.findByLabelText("Template");
    await waitFor(() => expect(picker).toHaveTextContent("PC Receipt"));
    expect(picker).not.toHaveTextContent("Shipping label");
  });

  it("blocks with a banner when no PC is chosen", async () => {
    viaPcBackend({ pairs: [] });
    renderPage();
    expect(await screen.findByTestId("print-via-pc-banner")).toHaveTextContent(
      /Choose which PC/,
    );
    const print = await screen.findByRole("button", { name: /^Print$/ });
    await waitFor(() => expect(print).toBeDisabled());
    fireEvent.click(print);
    expect(invoke).not.toHaveBeenCalledWith("remote_print", expect.anything());
  });

  it("resolves the block from the banner picker, no Settings trip", async () => {
    viaPcBackend({
      pairs: [
        {
          id: "pc-1",
          name: "Studio PC",
          host: "192.168.1.9",
          port: 17717,
          secret: "s",
          fingerprint: "",
          provider_id: "pc-1",
          platform: "linux",
          paired_at: "",
          device_id: "phone-1",
        },
        {
          id: "pc-2",
          name: "Shop PC",
          host: "192.168.1.10",
          port: 17717,
          secret: "s",
          fingerprint: "",
          provider_id: "pc-2",
          platform: "linux",
          paired_at: "",
          device_id: "phone-1",
        },
      ],
    });
    renderPage();
    await screen.findByTestId("print-via-pc-picker");
    fireEvent.click(screen.getByTestId("print-via-pc-picker"));
    fireEvent.click(await screen.findByText("Shop PC"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("set_setting", {
        key: "print_via_pc_device",
        value: "pc-2",
      }),
    );
    // The banner flips to the chosen PC; printing unblocks.
    expect(await screen.findByTestId("print-via-pc-banner")).toHaveTextContent(
      "Shop PC",
    );
    const print = await screen.findByRole("button", { name: /^Print$/ });
    await waitFor(() => expect(print).toBeEnabled());
  });

  it("offers Sync on a stale template and retries with the same key", async () => {
    viaPcBackend({
      print: {
        success: false,
        status: "failed",
        pc_job_id: null,
        duration_ms: 5,
        error: "template 'srv-1' is out of date",
        code: "template_stale",
        pc_name: "Studio PC",
      },
    });
    renderPage();
    const print = await screen.findByRole("button", { name: /^Print$/ });
    await waitFor(() => expect(print).toBeEnabled());
    fireEvent.click(print);

    expect(
      await screen.findByTestId("print-sync-templates"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("print-sync-templates"));
    await waitFor(() =>
      expect(
        screen.queryByTestId("print-sync-templates"),
      ).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(remoteCalls()).toHaveLength(2));
    const [first, second] = remoteCalls();
    expect(first.idempotency_key).toBeTruthy();
    expect(second.idempotency_key).toBe(first.idempotency_key);
  });

  it("names the PC and offers no phone sync when the template is missing there", async () => {
    // template_missing is a PC-side gap: syncing this phone cannot
    // create the PC's row, so the button would be a dead end.
    viaPcBackend({
      print: {
        success: false,
        status: "failed",
        pc_job_id: null,
        duration_ms: 5,
        error:
          "template 'srv-9' is not on Studio PC; sync templates on the PC, then retry",
        code: "template_missing",
        pc_name: "Studio PC",
      },
    });
    renderPage();
    const print = await screen.findByRole("button", { name: /^Print$/ });
    await waitFor(() => expect(print).toBeEnabled());
    fireEvent.click(print);

    expect(
      await screen.findByText(/sync templates on the PC/),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("print-sync-templates")).toBeNull();
  });
});

describe("Print via PC failure states", () => {
  function unreachableBackend() {
    invoke.mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === "get_setting") {
        if (args?.key === "print_via_pc") return "true";
        if (args?.key === "render_pairs")
          return JSON.stringify([
            {
              id: "pc-1",
              name: "Studio PC",
              host: "192.168.1.9",
              port: 17717,
              secret: "s",
              fingerprint: "",
              provider_id: "pc-1",
              platform: "linux",
              paired_at: "",
              device_id: "phone-1",
            },
          ]);
        return null;
      }
      if (cmd === "list_printers" || cmd === "enumerate_system_printers")
        return [{ id: "1", name: "Dock Zebra" }];
      if (cmd === "remote_printers")
        throw new Error("Studio PC is blocked or unreachable");
      if (cmd === "pc_templates")
        throw new Error("Studio PC is blocked or unreachable");
      return null;
    });
  }

  it("stays quiet on open, notes the dead PC, and shows one refresh", async () => {
    unreachableBackend();
    renderPage();
    expect(await screen.findByTestId("print-via-pc-banner")).toHaveTextContent(
      /did not answer/,
    );
    // The banner owns refresh now; the header button hides while via-PC.
    expect(
      screen.getAllByRole("button", { name: "Refresh printers" }),
    ).toHaveLength(1);
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });
});

describe("Print via PC exit", () => {
  function flagOnBackend() {
    invoke.mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === "get_setting") {
        if (args?.key === "print_via_pc") return "true";
        return null;
      }
      if (cmd === "list_printers" || cmd === "enumerate_system_printers")
        return [{ id: "1", name: "Dock Zebra" }];
      if (cmd === "remote_printers") return { printers: [], cached: false };
      if (cmd === "pc_templates") return { templates: [], cached: false };
      return null;
    });
  }

  it("leaves remote mode from the banner without visiting Settings", async () => {
    flagOnBackend();
    renderPage();
    await screen.findByTestId("print-via-pc-banner");
    // The local test page stays out of reach while remote.
    expect(screen.queryByText("Send test page")).toBeNull();
    fireEvent.click(screen.getByTestId("via-pc-exit"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("set_setting", {
        key: "print_via_pc",
        value: "false",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("print-via-pc-banner")).toBeNull(),
    );
  });
});

describe("unpaired phone on the Print page", () => {
  // PLAN §4: no pairing wall in front of the form. Thermal prints on
  // the device itself; only a PDF printer needs a pair.
  it("opens the form even when unpaired: a thermal printer prints", async () => {
    const ua = vi
      .spyOn(window.navigator, "userAgent", "get")
      .mockReturnValue("Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile");
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_printers" || cmd === "enumerate_system_printers")
        return mockPrinters.current;
      return null; // nothing paired
    });
    try {
      renderPage();
      const print = await screen.findByRole("button", { name: /^Print$/ });
      await waitFor(() => expect(print).toBeEnabled());
    } finally {
      ua.mockRestore();
    }
  });

  it("blocks a PDF printer with a pair link, not a redirect", async () => {
    const ua = vi
      .spyOn(window.navigator, "userAgent", "get")
      .mockReturnValue("Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile");
    mockPrinters.current = [
      {
        id: "2",
        name: "Dock PDF",
        address: "127.0.0.1:631",
        printer_type: "ipp",
        language: "pdf",
      },
    ];
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_printers" || cmd === "enumerate_system_printers")
        return mockPrinters.current;
      return null; // nothing paired
    });
    try {
      renderPage();
      const print = await screen.findByRole("button", { name: /^Print$/ });
      await waitFor(() => expect(print).toBeDisabled());
      expect(
        screen.getByText(/needs a paired PC to render/),
      ).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Pair a PC" })).toHaveAttribute(
        "href",
        "/pair",
      );
    } finally {
      ua.mockRestore();
    }
  });

  it("blocks Print with a Pair-again link instead of a generic message", async () => {
    const ua = vi
      .spyOn(window.navigator, "userAgent", "get")
      .mockReturnValue("Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile");
    invoke.mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === "get_setting") {
        if (args?.key === "render_pairs")
          return JSON.stringify([
            {
              id: "pc-1",
              name: "Studio PC",
              host: "192.168.1.9",
              port: 17717,
              secret: "s",
              fingerprint: "",
            },
          ]);
        return null;
      }
      if (cmd === "list_printers" || cmd === "enumerate_system_printers")
        return [{ id: "1", name: "Dock Zebra" }];
      if (cmd === "peer_capabilities")
        throw new Error("Studio PC removed this phone. Pair again.");
      return null;
    });
    try {
      renderPage();
      const print = await screen.findByRole("button", { name: /^Print$/ });
      await waitFor(() => expect(print).toBeDisabled());
      expect(screen.getByText("Pair again to print.")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Pair again" })).toHaveAttribute(
        "href",
        "/devices",
      );
    } finally {
      ua.mockRestore();
    }
  });

  it("debounces data-URL preview fetches while typing", async () => {
    const fetchMock = vi.fn(
      async (_url: string): Promise<Response> =>
        new Response(JSON.stringify({ hello: "world" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      renderPage();
      await screen.findByTitle("Print preview");
      const input = screen.getByLabelText("Data URL");
      fireEvent.change(input, { target: { value: "https://a.example/1" } });
      fireEvent.change(input, { target: { value: "https://a.example/12" } });
      fireEvent.change(input, { target: { value: "https://a.example/123" } });
      // Still settling: no request yet, so typing never POSTs per keystroke.
      expect(fetchMock).not.toHaveBeenCalled();
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), {
        timeout: 3000,
      });
      expect(fetchMock.mock.calls[0][0]).toBe("https://a.example/123");
    } finally {
      vi.unstubAllGlobals();
      usePrintStore.setState({ dataUrl: "" });
    }
  });

  it("says a slow data URL may still print", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation was aborted.", "AbortError");
      }),
    );
    try {
      usePrintStore.setState({ dataUrl: "https://slow.example/data" });
      renderPage();
      expect(
        await screen.findByText(/took too long to answer/),
      ).toBeInTheDocument();
      expect(screen.getByText(/may still work/)).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
      usePrintStore.setState({ dataUrl: "" });
    }
  });

  it("says a failed data URL may still print server-side", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    try {
      usePrintStore.setState({ dataUrl: "https://down.example/data" });
      renderPage();
      expect(
        await screen.findByText(/Could not load data from the URL/),
      ).toBeInTheDocument();
      expect(screen.getByText(/may still work/)).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
      usePrintStore.setState({ dataUrl: "" });
    }
  });
});

describe("Label (scene) track", () => {
  // The scene (label) template: its picker, preview and print all follow
  // the label track, not the html one.
  const SCENE = {
    id: 8,
    name: "Dock label",
    page_w_mm: 50,
    page_h_mm: 30,
    orientation: "portrait",
    html: "",
    css: "",
    compiled_css: "",
    compiled_key: "",
    track: "scene",
    scene_json: "{}",
  };
  // Saved rows carry a profile the backend plans label jobs against; the
  // OS row and the pdf head cannot run one.
  const labelPrinter = {
    id: "saved:1",
    name: "Dock Zebra",
    address: "127.0.0.1:9100",
    printer_type: "raw_tcp",
    language: "escpos",
  };
  const docPrinter = {
    id: "saved:2",
    name: "Doc Head",
    address: "127.0.0.1:631",
    printer_type: "ipp",
    language: "pdf",
  };
  const osPrinter = {
    id: "3",
    name: "Desk Laser",
    address: "127.0.0.1:631",
    printer_type: "ipp",
    language: "pdf",
  };
  // One 4×2 sheet, two ink dots on each row. packed is one byte per
  // eight pixels, so a single 0b11001100 draws both rows.
  const prepared = {
    path: "native",
    fallback: null,
    records: 1,
    pages: 1,
    units: 8,
    bytes: 4,
    preview: [
      {
        kind: "bitmap",
        width: 4,
        height: 2,
        packed: [0b11001100],
        width_mm: 50,
        height_mm: 30,
      },
    ],
    profile: "default",
    profile_source: "default",
  };

  // The Print page with the scene template picked and the given printer
  // listing; the label commands answer from the fixture unless overridden.
  const scenePage = (
    opts: {
      printers?: (typeof defaultPrinters)[number][];
      printerId?: string;
      dataUrl?: string;
      labelPrint?: () => unknown;
    } = {},
  ) => {
    const printers = opts.printers ?? [labelPrinter];
    mockTemplates.current = [SCENE];
    mockPrinters.current = printers;
    usePrintStore.setState({
      templateId: "8",
      printerId: opts.printerId ?? "",
      // The pages-count test earlier in the file leaves its value behind;
      // the label repeat math must start from one sheet.
      records: 1,
      dataUrl: opts.dataUrl ?? "",
    });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_printers" || cmd === "enumerate_system_printers")
        return printers;
      if (cmd === "label_prepare") return prepared;
      if (cmd === "label_print")
        return (
          opts.labelPrint?.() ?? {
            job_id: 11,
            report: { result: "confirmed", counts: null, reason: null },
            duration_ms: 300,
          }
        );
      return null;
    });
    renderPage();
    // The subtitle only renders once the list has loaded the scene row,
    // so this doubles as "the page knows it is on the label track".
    return screen.findByText(/Dock label, 50 × 30 mm/);
  };

  it("offers only saved label printers for a scene template, all of them for an html one", async () => {
    mockTemplates.current = [defaultTemplates[0], SCENE];
    mockPrinters.current = [labelPrinter, docPrinter, osPrinter];
    usePrintStore.setState({ templateId: "8", printerId: "Dock Zebra" });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_printers" || cmd === "enumerate_system_printers")
        return [labelPrinter, docPrinter, osPrinter];
      return null;
    });
    renderPage();
    const printer = await screen.findByRole("combobox", { name: "Printer" });
    await screen.findByText(/Dock label, 50 × 30 mm/);
    // The pdf head is a saved printer but plans no label jobs; the OS
    // row has no profile at all — only the thermal dock is offered.
    fireEvent.click(printer);
    const sceneOptions = (await screen.findAllByRole("option")).map(
      (o) => o.textContent,
    );
    expect(sceneOptions).toEqual(["Dock Zebra"]);
    // The html track keeps today's rule: every printer is offered. The
    // open list re-renders with the new picker as the template changes —
    // in jsdom the trigger click never closes the select, and the
    // subtitle is the sync point that the re-render has landed.
    usePrintStore.setState({ templateId: "7" });
    await screen.findByText(/Shipping label, 100 × 150 mm/);
    const htmlOptions = screen.getAllByRole("option").map((o) => o.textContent);
    expect(htmlOptions).toEqual(["Dock Zebra", "Doc Head", "Desk Laser"]);
  });

  it("moves a non-label printer selection to a saved label printer", async () => {
    await scenePage({
      printers: [osPrinter, labelPrinter],
      printerId: "Desk Laser",
    });
    await waitFor(() =>
      expect(usePrintStore.getState().printerId).toBe("Dock Zebra"),
    );
  });

  it("blocks printing and names the missing label printers when none is saved", async () => {
    await scenePage({ printers: [osPrinter], printerId: "Desk Laser" });
    // The auto-switch left no printer: the existing blocker line says so.
    await waitFor(() => expect(usePrintStore.getState().printerId).toBe(""));
    expect(
      await screen.findByText(/Choose a printer to enable printing/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Print$/ })).toBeDisabled();
    // The picker itself explains why it is empty.
    fireEvent.click(screen.getByRole("combobox", { name: "Printer" }));
    expect(
      await screen.findByText(/No saved label printers/),
    ).toBeInTheDocument();
  });

  it("previews a scene template as 1-bit sheets from label_prepare, not the page renderer", async () => {
    await scenePage();
    const sheet = await screen.findByRole("img", { name: "Preview" });
    expect(sheet).toHaveAttribute("viewBox", "0 0 4 2");
    // Background plus one ink run per row.
    expect(sheet.querySelectorAll("rect")).toHaveLength(3);
    const region = screen.getByRole("region", { name: "Print preview" });
    expect(region).toContainElement(sheet);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "label_prepare",
        expect.objectContaining({
          req: expect.objectContaining({
            template_id: 8,
            printer: "Dock Zebra",
            copies: 1,
          }),
        }),
      ),
    );
    const call = invoke.mock.calls.find(([cmd]) => cmd === "label_prepare");
    expect(
      JSON.parse((call?.[1] as { req: { records: string } }).req.records),
    ).toEqual([DEFAULT_MOCK_DATA]);
    // The html track's renderer never ran for the scene template.
    expect(invoke).not.toHaveBeenCalledWith("render_template_preview");
  });

  it("asks for a saved label printer before preparing a preview", async () => {
    await scenePage({ printers: [osPrinter], printerId: "Desk Laser" });
    expect(
      await screen.findByText(/A label preview needs a saved label printer/),
    ).toBeInTheDocument();
    // The auto-switch left no printer behind, and the backend was never
    // asked to plan a job it would refuse.
    await waitFor(() => expect(usePrintStore.getState().printerId).toBe(""));
    expect(invoke).not.toHaveBeenCalledWith("label_prepare");
  });

  it("prints a scene template as a label job, not a rendered page", async () => {
    await scenePage();
    const print = screen.getByRole("button", { name: /^Print$/ });
    await waitFor(() => expect(print).toBeEnabled());
    fireEvent.click(print);
    expect(await screen.findByText("Print sent")).toBeInTheDocument();
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "label_print",
        expect.objectContaining({
          req: expect.objectContaining({
            template_id: 8,
            printer: "Dock Zebra",
            copies: 1,
          }),
        }),
      ),
    );
    const call = invoke.mock.calls.find(([cmd]) => cmd === "label_print");
    expect(
      JSON.parse((call?.[1] as { req: { records: string } }).req.records),
    ).toEqual([DEFAULT_MOCK_DATA]);
    // The sheet count follows the record: one sample object, one sheet.
    expect(screen.getByText(/Finished in 0\.300 s/)).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("print_html");
  });

  it("warns when the label job is only partially confirmed", async () => {
    await scenePage({
      labelPrint: () => ({
        job_id: 12,
        report: { result: "partially_printed", counts: [1, 3], reason: null },
        duration_ms: 300,
      }),
    });
    const print = screen.getByRole("button", { name: /^Print$/ });
    await waitFor(() => expect(print).toBeEnabled());
    fireEvent.click(print);
    const line = await screen.findByText(/Partially printed: 1 of 3 sheets/);
    // A success carrying a warning reports as an alert — and the line
    // pins it: the page also has the thermal truncation warning as an
    // alert, so the alert is read from the line itself, not by role.
    expect(line.closest('[role="alert"]')).toHaveTextContent("Print sent");
  });

  it("warns when the label printer does not confirm the job", async () => {
    await scenePage({
      labelPrint: () => ({
        job_id: 12,
        report: { result: "sent_unconfirmed", counts: null, reason: null },
        duration_ms: 300,
      }),
    });
    const print = screen.getByRole("button", { name: /^Print$/ });
    await waitFor(() => expect(print).toBeEnabled());
    fireEvent.click(print);
    const line = await screen.findByText(
      /Sent to the printer — it did not confirm the job/,
    );
    expect(line.closest('[role="alert"]')).toHaveTextContent("Print sent");
  });

  it("fails the label print when its data URL cannot be loaded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    try {
      await scenePage({ dataUrl: "https://down.example/data" });
      const print = screen.getByRole("button", { name: /^Print$/ });
      await waitFor(() => expect(print).toBeEnabled());
      fireEvent.click(print);
      // The failed banner carries the error — the thermal truncation
      // warning is a second role="alert" on the page, so the error text
      // itself locates its banner.
      const line = await screen.findByText(
        /Could not load the data URL for the label job/,
      );
      expect(line.closest('[role="alert"]')).not.toBe(
        screen.getByTestId("thermal-truncate-warning"),
      );
      // Unlike the html track, a broken data URL is a failed print here:
      // the label command takes the records, so there is no server-side
      // fetch to fall back on.
      expect(invoke).not.toHaveBeenCalledWith("label_print");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
