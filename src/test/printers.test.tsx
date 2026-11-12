import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@/lib/i18n";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

import { PrinterSetupPage } from "@/pages/PrinterSetup";

const P = (o: object) => ({
  paper_width_mm: 80,
  dpi: 203,
  language: "pdf",
  ...o,
});
const PRINTERS = [
  P({
    id: 1,
    name: "Dock Zebra",
    printer_type: "raw_tcp",
    address: "10.0.0.5:9100",
    status: "online",
  }),
  P({
    id: 2,
    name: "Office HP",
    printer_type: "ipp",
    address: "http://10.0.0.9",
    status: "offline",
  }),
  P({ id: 3, name: "Counter USB", printer_type: "usb", address: "usb-1" }),
];

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
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "list_printers") return PRINTERS;
    if (cmd === "enumerate_system_printers") return [];
    return null;
  });
});
const renderPage = () =>
  render(
    <MemoryRouter>
      <PrinterSetupPage />
    </MemoryRouter>,
  );

describe("Printers page", () => {
  it("lists printers with status words, and says when status was not checked", async () => {
    renderPage();
    expect(await screen.findByText("Dock Zebra")).toBeInTheDocument();
    expect(screen.getByText("Online")).toBeInTheDocument();
    expect(screen.getByText("Offline")).toBeInTheDocument();
    expect(screen.getByText("Not checked")).toBeInTheDocument();
  });

  it("groups Wi-Fi and raw TCP printers under Network (the old Wi-Fi tab matched nothing)", async () => {
    renderPage();
    await screen.findByText("Dock Zebra");
    expect(screen.getByRole("tab", { name: "All (3)" })).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "Network (2)" }),
    ).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Network (2)" }));
    await waitFor(() => expect(screen.queryByText("Counter USB")).toBeNull());
    expect(screen.getByText("Office HP")).toBeInTheDocument();
  });

  it("sends a test page from the row", async () => {
    renderPage();
    await screen.findByText("Dock Zebra");
    fireEvent.click(
      screen.getByRole("button", { name: "Test print on Dock Zebra" }),
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("test_printer", { id: 1 }),
    );
  });

  it("names the printer before removing it", async () => {
    renderPage();
    await screen.findByText("Dock Zebra");
    fireEvent.click(screen.getByRole("button", { name: "Remove Dock Zebra" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("Remove “Dock Zebra”?"),
    ).toBeInTheDocument();
    expect(invoke.mock.calls.some((c) => c[0] === "delete_printer")).toBe(
      false,
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Remove printer" }),
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("delete_printer", { id: 1 }),
    );
  });

  it("adds a printer from the side panel and validates IPP addresses", async () => {
    renderPage();
    await screen.findByText("Dock Zebra");
    fireEvent.click(screen.getByRole("button", { name: /Add printer/i }));
    const panel = await screen.findByRole("dialog");
    fireEvent.change(within(panel).getByLabelText("Printer name"), {
      target: { value: "Lobby" },
    });
    // A bare host is valid (the backend normalises it to the IPP
    // endpoint), so the rejected case is an address that names no
    // printer at all.
    fireEvent.change(within(panel).getByLabelText("Address"), {
      target: { value: "ho st" },
    });
    fireEvent.click(
      within(panel).getByRole("button", { name: "Save printer" }),
    );
    expect(invoke.mock.calls.some((c) => c[0] === "add_printer")).toBe(false);
    fireEvent.change(within(panel).getByLabelText("Address"), {
      target: { value: "http://10.0.0.7" },
    });
    fireEvent.click(
      within(panel).getByRole("button", { name: "Save printer" }),
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "add_printer",
        expect.objectContaining({
          req: expect.objectContaining({
            name: "Lobby",
            address: "http://10.0.0.7",
          }),
        }),
      ),
    );
  });

  it("validates raw TCP addresses and custom numbers", async () => {
    renderPage();
    await screen.findByText("Dock Zebra");
    fireEvent.click(screen.getByRole("button", { name: /Add printer/i }));
    const panel = await screen.findByRole("dialog");
    fireEvent.change(within(panel).getByLabelText("Printer name"), {
      target: { value: "Raw One" },
    });
    // Connection select: raw TCP needs host:port, not a bare host.
    fireEvent.click(within(panel).getByLabelText("Connection"));
    fireEvent.click(
      await screen.findByRole("option", {
        name: "Wi-Fi / LAN (Raw TCP 9100)",
      }),
    );
    fireEvent.change(within(panel).getByLabelText("Address"), {
      target: { value: "10.0.0.7" },
    });
    fireEvent.click(
      within(panel).getByRole("button", { name: "Save printer" }),
    );
    expect(invoke.mock.calls.some((c) => c[0] === "add_printer")).toBe(false);
    fireEvent.change(within(panel).getByLabelText("Address"), {
      target: { value: "10.0.0.7:9100" },
    });
    // Paper width and DPI are folded under Advanced, whose header already
    // shows the current values.
    expect(within(panel).queryByLabelText(/Paper width/)).toBeNull();
    fireEvent.click(
      within(panel).getByRole("button", { name: /Advanced.*80 mm · 203 dpi/ }),
    );
    // Custom numbers outside the old fixed selects are accepted.
    fireEvent.change(within(panel).getByLabelText(/Paper width/), {
      target: { value: "110" },
    });
    fireEvent.change(within(panel).getByLabelText("DPI"), {
      target: { value: "600" },
    });
    fireEvent.click(
      within(panel).getByRole("button", { name: "Save printer" }),
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "add_printer",
        expect.objectContaining({
          req: expect.objectContaining({
            printer_type: "raw_tcp",
            address: "10.0.0.7:9100",
            paper_width_mm: 110,
            dpi: 600,
          }),
        }),
      ),
    );
  });

  it("edits a printer in place without delete and re-add", async () => {
    renderPage();
    await screen.findByText("Dock Zebra");
    fireEvent.click(screen.getByRole("button", { name: "Edit Dock Zebra" }));
    const panel = await screen.findByRole("dialog");
    expect(
      within(panel).getByRole("heading", { name: "Edit printer" }),
    ).toBeInTheDocument();
    expect(within(panel).getByLabelText("Printer name")).toHaveValue(
      "Dock Zebra",
    );
    fireEvent.change(within(panel).getByLabelText("Address"), {
      target: { value: "10.0.0.6:9100" },
    });
    fireEvent.click(
      within(panel).getByRole("button", { name: "Save printer" }),
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "update_printer",
        expect.objectContaining({
          id: 1,
          req: expect.objectContaining({
            name: "Dock Zebra",
            address: "10.0.0.6:9100",
          }),
        }),
      ),
    );
    expect(invoke.mock.calls.some(([cmd]) => cmd === "delete_printer")).toBe(
      false,
    );
  });

  it("explains an empty group and offers a next step", async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "list_printers" ? [] : [],
    );
    renderPage();
    expect(await screen.findByText("No printers yet")).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: /Add printer/i }).length,
    ).toBeGreaterThan(0);
  });
});

describe("Bluetooth in the add dialog", () => {
  const BT_ROW = {
    id: "A4:77:17:22:33:44",
    name: "Ruijie 80",
    address: "A4:77:17:22:33:44",
    printer_type: "bluetooth",
    language: "pdf",
    status: "unknown",
  };

  function phoneMode() {
    const ua = vi
      .spyOn(window.navigator, "userAgent", "get")
      .mockReturnValue("Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile");
    return () => ua.mockRestore();
  }

  async function openBluetoothDialog() {
    renderPage();
    await screen.findByText("Dock Zebra");
    fireEvent.click(screen.getByRole("button", { name: /Add printer/i }));
    const panel = await screen.findByRole("dialog");
    fireEvent.click(within(panel).getByLabelText("Connection"));
    fireEvent.click(await screen.findByRole("option", { name: "Bluetooth" }));
    return panel;
  }

  it("shows a MAC sample under the address input when Bluetooth is selected", async () => {
    const panel = await openBluetoothDialog();
    const hint = await screen.findByText(/A4:77:17:22:33:44/);
    // Wired to the address input so a screen reader reads it on focus.
    expect(hint).toHaveAttribute("id", "printer-address-hint");
    expect(
      within(panel).getByLabelText("Bluetooth MAC or COM port"),
    ).toHaveAttribute("aria-describedby", "printer-address-hint");
  });

  // The section is collapsed by default (count only); expand it first.
  async function expandBondedList(panel: HTMLElement) {
    const toggle = await within(panel).findByRole("button", {
      name: "Paired Bluetooth printers (1)",
    });
    fireEvent.click(toggle);
    return toggle;
  }

  it("keeps bonded printers collapsed behind their count until tapped", async () => {
    const done = phoneMode();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_printers") return PRINTERS;
      if (cmd === "list_bluetooth_devices") return [BT_ROW];
      if (cmd === "enumerate_system_printers") return [];
      return null;
    });
    try {
      const panel = await openBluetoothDialog();
      const toggle = await within(panel).findByRole("button", {
        name: "Paired Bluetooth printers (1)",
      });
      // Collapsed by default: only the count shows, no rows.
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(
        screen.queryByTestId("discovered-bluetooth-A4:77:17:22:33:44"),
      ).not.toBeInTheDocument();
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(
        await screen.findByTestId("discovered-bluetooth-A4:77:17:22:33:44"),
      ).toBeInTheDocument();
    } finally {
      done();
    }
  });

  it("lists bonded printers with Fill and Add on Android", async () => {
    const done = phoneMode();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_printers") return PRINTERS;
      if (cmd === "list_bluetooth_devices") return [BT_ROW];
      if (cmd === "enumerate_system_printers") return [];
      return null;
    });
    try {
      const panel = await openBluetoothDialog();
      await expandBondedList(panel);
      const row = await screen.findByTestId(
        "discovered-bluetooth-A4:77:17:22:33:44",
      );
      expect(within(row).getByText("Ruijie 80")).toBeInTheDocument();
      fireEvent.click(within(row).getByRole("button", { name: "Fill" }));
      expect(
        within(panel).getByLabelText("Bluetooth MAC or COM port"),
      ).toHaveValue("A4:77:17:22:33:44");
    } finally {
      done();
    }
  });

  it("adds a bonded printer in one tap on Android", async () => {
    const done = phoneMode();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_printers") return PRINTERS;
      if (cmd === "list_bluetooth_devices") return [BT_ROW];
      if (cmd === "enumerate_system_printers") return [];
      return null;
    });
    try {
      const panel = await openBluetoothDialog();
      await expandBondedList(panel);
      const row = await screen.findByTestId(
        "discovered-bluetooth-A4:77:17:22:33:44",
      );
      fireEvent.click(within(row).getByRole("button", { name: /Add/ }));
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith(
          "add_printer",
          expect.objectContaining({
            req: expect.objectContaining({
              name: "Ruijie 80",
              address: "A4:77:17:22:33:44",
              printer_type: "bluetooth",
              // Android rasterizes thermal locally: the add starts at
              // ESC/POS, not PDF.
              language: "escpos",
            }),
          }),
        ),
      );
    } finally {
      done();
    }
  });
});

describe("GDI-only system queue warning", () => {
  // The backend sets `pdf_datatype` to `false` when the queue's offered
  // datatype list is readable and has no `PDF` entry (the RAW-fallback
  // condition), `true` when the queue offers PDF, and `null`/absent when
  // it cannot know (remote shares, unreadable list).
  const SYSTEM_PRINTERS = [
    {
      id: "HP LaserJet 1020",
      name: "HP LaserJet 1020",
      address: "WINSPOOL",
      printer_type: "system",
      language: "pdf",
      status: "online",
      pdf_datatype: false,
    },
    {
      id: "Microsoft Print to PDF",
      name: "Microsoft Print to PDF",
      address: "WINSPOOL",
      printer_type: "system",
      language: "pdf",
      status: "online",
      pdf_datatype: true,
    },
    {
      id: "OfficeShare\\Lobby",
      name: "OfficeShare\\Lobby",
      address: "\\\\print-server\\lobby",
      printer_type: "system",
      language: "pdf",
      status: "online",
      pdf_datatype: null,
    },
  ];

  beforeEach(() => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_printers") return PRINTERS;
      if (cmd === "enumerate_system_printers") return SYSTEM_PRINTERS;
      return null;
    });
  });

  async function openAddDialog() {
    renderPage();
    await screen.findByText("Dock Zebra");
    fireEvent.click(screen.getByRole("button", { name: /Add printer/i }));
    const panel = await screen.findByRole("dialog");
    // System queues are collapsed behind their count: open the list.
    fireEvent.click(
      await within(panel).findByRole("button", {
        name: "Found on this computer (3)",
      }),
    );
    return panel;
  }

  /** The Fill button of one system-queue row. */
  const fillRow = (name: string) =>
    within(screen.getByTestId(`discovered-system-${name}`)).getByRole(
      "button",
      { name: "Fill" },
    );

  it("marks the GDI-risk row and stays quiet for known and unknown queues", async () => {
    await openAddDialog();
    const flagged = screen.getByTestId("discovered-system-HP LaserJet 1020");
    // The risk is spelled out in the row, not hidden in a tooltip.
    expect(flagged).toHaveTextContent(/No PDF datatype/);
    // PDF-offering and unknown (remote share) rows carry no marker.
    expect(
      screen.getByTestId("discovered-system-Microsoft Print to PDF"),
    ).not.toHaveTextContent(/No PDF datatype/);
    expect(
      screen.getByTestId("discovered-system-OfficeShare\\Lobby"),
    ).not.toHaveTextContent(/No PDF datatype/);
  });

  it("warns in the form when a GDI-risk queue is picked, and clears it otherwise", async () => {
    await openAddDialog();
    fireEvent.click(fillRow("HP LaserJet 1020"));
    const warning = await screen.findByTestId("printer-gdi-warning");
    expect(warning).toHaveAttribute("role", "alert");
    expect(warning).toHaveTextContent(/GDI-only/);
    // A PDF-offering queue: no warning.
    fireEvent.click(fillRow("Microsoft Print to PDF"));
    await waitFor(() =>
      expect(screen.queryByTestId("printer-gdi-warning")).toBeNull(),
    );
    // An unknown (remote share) queue: still no warning — unknown is not GDI.
    fireEvent.click(fillRow("OfficeShare\\Lobby"));
    await waitFor(() =>
      expect(screen.queryByTestId("printer-gdi-warning")).toBeNull(),
    );
    // System queues label the address field "Printer name" too (the queue
    // name is the address), so target the name input by id.
    expect(
      screen.getByLabelText("Printer name", { selector: "#printer-name" }),
    ).toHaveValue("OfficeShare\\Lobby");
  });
});

describe("Language guard and detection (TODO items 1, 2, 4)", () => {
  async function openAddDialog() {
    renderPage();
    await screen.findByText("Dock Zebra");
    fireEvent.click(screen.getByRole("button", { name: /Add printer/i }));
    return screen.findByRole("dialog");
  }

  const pickConnection = async (panel: HTMLElement, name: string) => {
    fireEvent.click(within(panel).getByLabelText("Connection"));
    fireEvent.click(await screen.findByRole("option", { name }));
  };

  const openLanguage = async (panel: HTMLElement) => {
    fireEvent.click(within(panel).getByLabelText("Language"));
  };

  it("omits PDF for USB and Bluetooth rows, keeps it for IPP and System", async () => {
    const panel = await openAddDialog();
    // The default (IPP) dialog still offers PDF.
    await openLanguage(panel);
    expect(
      await screen.findByRole("option", { name: "PDF" }),
    ).toBeInTheDocument();

    await pickConnection(panel, "USB");
    await openLanguage(panel);
    expect(screen.queryByRole("option", { name: "PDF" })).toBeNull();
    expect(
      screen.getByRole("option", { name: "ESC/POS (receipt)" }),
    ).toBeInTheDocument();

    await pickConnection(panel, "Bluetooth");
    await openLanguage(panel);
    expect(screen.queryByRole("option", { name: "PDF" })).toBeNull();

    await pickConnection(panel, "Wi-Fi / LAN (IPP)");
    await openLanguage(panel);
    expect(
      await screen.findByRole("option", { name: "PDF" }),
    ).toBeInTheDocument();

    await pickConnection(panel, "System");
    await openLanguage(panel);
    expect(
      await screen.findByRole("option", { name: "PDF" }),
    ).toBeInTheDocument();
  });

  it("keeps a legacy USB+PDF row editable and warns it prints blank", async () => {
    renderPage();
    await screen.findByText("Counter USB");
    fireEvent.click(screen.getByRole("button", { name: "Edit Counter USB" }));
    const panel = await screen.findByRole("dialog");
    const warning = await screen.findByTestId("printer-raw-pdf-warning");
    expect(warning).toHaveAttribute("role", "alert");
    // The saved language stays in the list so editing does not silently
    // change it.
    await openLanguage(panel);
    const pdf = await screen.findByRole("option", { name: "PDF" });
    fireEvent.click(pdf);
    fireEvent.click(
      within(panel).getByRole("button", { name: "Save printer" }),
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "update_printer",
        expect.objectContaining({
          id: 3,
          req: expect.objectContaining({ language: "pdf" }),
        }),
      ),
    );
  });

  it("detects the language from the probe and pre-fills an untouched field", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_printers") return PRINTERS;
      if (cmd === "enumerate_system_printers") return [];
      if (cmd === "probe_printer_capabilities")
        return {
          detected: true,
          suggested_language: "zpl",
          make_and_model: "Zebra ZT411",
          printer_info: null,
          document_formats: [],
        };
      return null;
    });
    const panel = await openAddDialog();
    // Detect waits for an address to probe.
    expect(
      within(panel).getByRole("button", { name: "Detect" }),
    ).toBeDisabled();
    fireEvent.change(within(panel).getByLabelText("Address"), {
      target: { value: "10.0.0.9" },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Detect" }));
    expect(
      await screen.findByTestId("printer-detect-result"),
    ).toHaveTextContent(/Detected Zebra ZT411/);
    // The untouched language field takes the suggestion, and it is what
    // gets saved.
    expect(within(panel).getByLabelText("Language")).toHaveTextContent(
      "ZPL (label)",
    );
    fireEvent.change(within(panel).getByLabelText("Printer name"), {
      target: { value: "Lobby Zebra" },
    });
    fireEvent.click(
      within(panel).getByRole("button", { name: "Save printer" }),
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "add_printer",
        expect.objectContaining({
          req: expect.objectContaining({
            printer_type: "ipp",
            address: "10.0.0.9",
            language: "zpl",
          }),
        }),
      ),
    );
  });

  it("never overrides a language the operator already picked", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_printers") return PRINTERS;
      if (cmd === "enumerate_system_printers") return [];
      if (cmd === "probe_printer_capabilities")
        return {
          detected: true,
          suggested_language: "zpl",
          make_and_model: "Zebra ZT411",
          printer_info: null,
          document_formats: [],
        };
      return null;
    });
    const panel = await openAddDialog();
    fireEvent.change(within(panel).getByLabelText("Address"), {
      target: { value: "10.0.0.9" },
    });
    await openLanguage(panel);
    fireEvent.click(
      await screen.findByRole("option", { name: "ESC/POS (receipt)" }),
    );
    fireEvent.click(within(panel).getByRole("button", { name: "Detect" }));
    await screen.findByTestId("printer-detect-result");
    expect(within(panel).getByLabelText("Language")).toHaveTextContent(
      "ESC/POS (receipt)",
    );
  });

  it("reports an unresponsive probe as unknown, not an error", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_printers") return PRINTERS;
      if (cmd === "enumerate_system_printers") return [];
      if (cmd === "probe_printer_capabilities")
        return {
          detected: false,
          suggested_language: null,
          make_and_model: null,
          printer_info: null,
          document_formats: [],
        };
      return null;
    });
    const panel = await openAddDialog();
    fireEvent.change(within(panel).getByLabelText("Address"), {
      target: { value: "10.0.0.9" },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Detect" }));
    expect(
      await screen.findByTestId("printer-detect-result"),
    ).toHaveTextContent(/did not identify/);
    // The form keeps its default — silence is not a failure.
    expect(within(panel).getByLabelText("Language")).toHaveTextContent("PDF");
  });
});

describe("Print via PC notice", () => {
  it("explains the idle list and offers the exit", async () => {
    invoke.mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === "get_setting") {
        if (args?.key === "print_via_pc") return "true";
        return null;
      }
      if (cmd === "list_printers") return PRINTERS;
      if (cmd === "enumerate_system_printers") return [];
      return null;
    });
    renderPage();
    expect(await screen.findByTestId("printers-via-pc-note")).toHaveTextContent(
      /unused/,
    );
    fireEvent.click(screen.getByTestId("via-pc-exit"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("set_setting", {
        key: "print_via_pc",
        value: "false",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("printers-via-pc-note")).toBeNull(),
    );
  });
});

describe("Add / edit dialog layout", () => {
  const SYSTEM = [
    { id: "PDF24", name: "PDF24", address: "\\\\.\\pipe\\PDFPrint" },
    { id: "M220 Printer", name: "M220 Printer", address: "USB003" },
  ];

  beforeEach(() => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_printers") return PRINTERS;
      if (cmd === "enumerate_system_printers") return SYSTEM;
      if (cmd === "discover_network_printers") return [];
      return null;
    });
  });

  async function openAdd() {
    renderPage();
    await screen.findByText("Dock Zebra");
    fireEvent.click(screen.getByRole("button", { name: /Add printer/i }));
    return screen.findByRole("dialog");
  }

  const pickConnection = async (panel: HTMLElement, name: string) => {
    fireEvent.click(within(panel).getByLabelText("Connection"));
    fireEvent.click(await screen.findByRole("option", { name }));
  };

  it("shows detected devices as counts only until a section is opened", async () => {
    const panel = await openAdd();
    const toggle = await within(panel).findByRole("button", {
      name: "Found on this computer (2)",
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(
      within(panel).getByRole("button", { name: "Found on this network (0)" }),
    ).toBeDisabled();
    // No row and no chip until the section is opened.
    expect(screen.queryByTestId("discovered-system-M220 Printer")).toBeNull();
    expect(
      within(panel).queryByRole("button", { name: "M220 Printer" }),
    ).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByTestId("discovered-system-M220 Printer"),
    ).toBeInTheDocument();
  });

  it("has one Rescan button for every source", async () => {
    const panel = await openAdd();
    await within(panel).findByRole("button", {
      name: "Found on this computer (2)",
    });
    expect(
      within(panel).getAllByRole("button", { name: "Rescan" }),
    ).toHaveLength(1);
    invoke.mockClear();
    fireEvent.click(within(panel).getByRole("button", { name: "Rescan" }));
    await waitFor(() => {
      const cmds = invoke.mock.calls.map((c) => c[0]);
      expect(cmds).toContain("enumerate_system_printers");
      expect(cmds).toContain("discover_network_printers");
    });
  });

  it("tucks detected devices behind a link while editing", async () => {
    renderPage();
    await screen.findByText("Dock Zebra");
    fireEvent.click(screen.getByRole("button", { name: "Edit Dock Zebra" }));
    const panel = await screen.findByRole("dialog");
    expect(within(panel).queryByTestId("printers-detected")).toBeNull();
    fireEvent.click(within(panel).getByTestId("printers-show-detected"));
    const block = await within(panel).findByTestId("printers-detected");
    fireEvent.click(
      within(block).getByRole("button", { name: "Found on this computer (2)" }),
    );
    // Editing never offers a second, one-tap "Add": it would create a new
    // printer next to the one being edited.
    const row = screen.getByTestId("discovered-system-M220 Printer");
    expect(within(row).queryByRole("button", { name: /Add/ })).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "Fill" }));
    expect(
      within(panel).getByLabelText("Printer name", {
        selector: "#printer-name",
      }),
    ).toHaveValue("M220 Printer");
  });

  it("folds paper width and DPI under Advanced and shows their values", async () => {
    const panel = await openAdd();
    const toggle = within(panel).getByTestId("printer-advanced-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent("80 mm · 203 dpi");
    expect(within(panel).queryByLabelText("DPI")).toBeNull();
    fireEvent.click(toggle);
    expect(within(panel).getByLabelText("DPI")).toHaveValue(203);
  });

  it("opens Advanced when a folded field fails validation", async () => {
    const panel = await openAdd();
    fireEvent.change(within(panel).getByLabelText("Printer name"), {
      target: { value: "Lobby" },
    });
    fireEvent.change(within(panel).getByLabelText("Address"), {
      target: { value: "10.0.0.7" },
    });
    // The Advanced header shows what is folded; clear DPI through it.
    fireEvent.click(within(panel).getByTestId("printer-advanced-toggle"));
    fireEvent.change(within(panel).getByLabelText("DPI"), {
      target: { value: "5" },
    });
    fireEvent.click(within(panel).getByTestId("printer-advanced-toggle"));
    expect(within(panel).queryByLabelText("DPI")).toBeNull();
    fireEvent.click(
      within(panel).getByRole("button", { name: "Save printer" }),
    );
    expect(await within(panel).findByLabelText("DPI")).toBeInTheDocument();
    expect(invoke.mock.calls.some((c) => c[0] === "add_printer")).toBe(false);
  });

  it("explains why Detect is disabled", async () => {
    const panel = await openAdd();
    const detect = within(panel).getByRole("button", { name: "Detect" });
    expect(detect).toBeDisabled();
    expect(detect.parentElement).toHaveAttribute("tabindex", "0");
    fireEvent.change(within(panel).getByLabelText("Address"), {
      target: { value: "10.0.0.7" },
    });
    expect(within(panel).getByRole("button", { name: "Detect" })).toBeEnabled();
  });

  it("folds the IPP sign-in form until it is opened", async () => {
    const panel = await openAdd();
    // Wi-Fi / LAN (IPP) is the default connection.
    const toggle = within(panel).getByTestId("printer-signin-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent("Not needed");
    expect(within(panel).queryByLabelText("Username")).toBeNull();
    expect(within(panel).queryByLabelText("Password")).toBeNull();
    fireEvent.click(toggle);
    expect(within(panel).getByLabelText("Username")).toBeInTheDocument();
    expect(within(panel).getByLabelText("Password")).toBeInTheDocument();
    // Other connection types have no sign-in section at all.
    await pickConnection(panel, "Wi-Fi / LAN (Raw TCP 9100)");
    expect(within(panel).queryByTestId("printer-signin-toggle")).toBeNull();
  });

  it("opens the sign-in form when the edited printer already has credentials", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_printers")
        return [
          ...PRINTERS,
          P({
            id: 9,
            name: "Secure IPP",
            printer_type: "ipp",
            address: "https://10.0.0.8",
            username: "admin",
            password: "secret",
          }),
        ];
      if (cmd === "enumerate_system_printers") return SYSTEM;
      return [];
    });
    renderPage();
    await screen.findByText("Secure IPP");
    fireEvent.click(screen.getByRole("button", { name: "Edit Secure IPP" }));
    const panel = await screen.findByRole("dialog");
    const toggle = within(panel).getByTestId("printer-signin-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveTextContent("Configured");
    expect(within(panel).getByLabelText("Username")).toHaveValue("admin");
    // A printer without credentials still opens folded.
    fireEvent.keyDown(panel, { key: "Escape" });
  });

  it("keeps the Save footer sticky", async () => {
    const panel = await openAdd();
    const footer = within(panel).getByTestId("printer-dialog-footer");
    expect(footer.className).toMatch(/sticky/);
    expect(
      within(footer).getByRole("button", { name: "Cancel" }),
    ).toBeInTheDocument();
  });

  describe("Bluetooth address and hints on desktop", () => {
    it("flags a USB port typed into a Bluetooth address at once", async () => {
      const panel = await openAdd();
      await pickConnection(panel, "Bluetooth");
      const input = within(panel).getByLabelText("Bluetooth MAC or COM port");
      fireEvent.change(input, { target: { value: "USB003" } });
      const err = await within(panel).findByTestId("printer-address-error");
      expect(err).toHaveTextContent(/USB or print port/);
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(input.getAttribute("aria-describedby")).toContain(
        "printer-address-error",
      );
      // And it cannot be saved that way.
      fireEvent.change(within(panel).getByLabelText("Printer name"), {
        target: { value: "M220" },
      });
      fireEvent.click(
        within(panel).getByRole("button", { name: "Save printer" }),
      );
      expect(invoke.mock.calls.some((c) => c[0] === "add_printer")).toBe(false);
    });

    it("waits for blur before judging a half-typed MAC", async () => {
      const panel = await openAdd();
      await pickConnection(panel, "Bluetooth");
      const input = within(panel).getByLabelText("Bluetooth MAC or COM port");
      fireEvent.change(input, { target: { value: "A4:77:17" } });
      expect(within(panel).queryByTestId("printer-address-error")).toBeNull();
      fireEvent.blur(input);
      expect(
        await within(panel).findByTestId("printer-address-error"),
      ).toHaveTextContent(/MAC/);
      fireEvent.change(input, { target: { value: "A4:77:17:22:33:44" } });
      await waitFor(() =>
        expect(within(panel).queryByTestId("printer-address-error")).toBeNull(),
      );
    });

    it("accepts a COM port, and any address in driver mode", async () => {
      const panel = await openAdd();
      await pickConnection(panel, "Bluetooth");
      const input = within(panel).getByLabelText("Bluetooth MAC or COM port");
      fireEvent.change(input, { target: { value: "COM7" } });
      fireEvent.blur(input);
      expect(within(panel).queryByTestId("printer-address-error")).toBeNull();
      fireEvent.change(input, { target: { value: "USB003" } });
      expect(
        await within(panel).findByTestId("printer-address-error"),
      ).toBeInTheDocument();
      // Driver mode prints through the OS queue named by the printer: the
      // address is not dialled, so it is not held to the MAC shape.
      fireEvent.click(within(panel).getByRole("checkbox", { name: /driver/i }));
      await waitFor(() =>
        expect(within(panel).queryByTestId("printer-address-error")).toBeNull(),
      );
    });

    it("shows the raw-wire note, never the Android one, on desktop", async () => {
      const panel = await openAdd();
      await pickConnection(panel, "Bluetooth");
      const hint = await within(panel).findByTestId("printer-language-hint");
      expect(hint).toHaveTextContent(/PDF is not offered/);
      expect(hint).not.toHaveTextContent(/Android/);
    });

    it("offers PDF again once driver mode is on", async () => {
      const panel = await openAdd();
      await pickConnection(panel, "Bluetooth");
      fireEvent.click(within(panel).getByRole("checkbox", { name: /driver/i }));
      fireEvent.click(within(panel).getByLabelText("Language"));
      expect(
        await screen.findByRole("option", { name: "PDF" }),
      ).toBeInTheDocument();
    });
  });
});
