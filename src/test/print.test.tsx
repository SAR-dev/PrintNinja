import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@/lib/i18n";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));
vi.mock("@/lib/templates/seedTemplates", () => ({
  ensureStarterTemplates: async () => [
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
vi.mock("@/lib/hooks/useSystemPrinters", () => ({
  useSystemPrinters: () => ({
    printers: [{ id: "1", name: "Dock Zebra" }],
    // Follows the invoke mock, as the real hook does, so a test that makes
    // the backend report no printers really has none.
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

  it("shows layout options inline with no advanced section", async () => {
    renderPage();
    await screen.findByRole("button", { name: /^Print$/ });
    // Everything lives in the default section: no toggle, no hiding.
    expect(
      screen.queryByRole("button", { name: /Advanced options/ }),
    ).toBeNull();
    expect(screen.getByLabelText("Page range")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /Margins/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Paper size")).toBeInTheDocument();
    expect(screen.getByLabelText("Fit mode")).toBeInTheDocument();
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
  it("sends the pages count with the print request", async () => {
    renderPage();
    const print = await screen.findByRole("button", { name: /^Print$/ });
    await waitFor(() => expect(print).toBeEnabled());
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

  it("shows that the printer is ready before anything is printed", async () => {
    renderPage();
    // One truncated line now, not a two-line card.
    expect(await screen.findByText(/Printer is ready/)).toBeInTheDocument();
  });

  it("reports a finished print in the alert, with its timing, and shows no toast", async () => {
    renderPage();
    const print = await screen.findByRole("button", { name: /^Print$/ });
    await waitFor(() => expect(print).toBeEnabled());
    fireEvent.click(print);
    expect(await screen.findByText("Print sent")).toBeInTheDocument();
    expect(screen.queryByText("Printer is ready")).toBeNull();
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
    // phone's starter template.
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
        "/automation?tab=phones",
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
