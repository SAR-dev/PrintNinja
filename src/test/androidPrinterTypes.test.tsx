import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  within,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@/lib/i18n";
import { isAndroid } from "@/lib/platform";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

import { PrinterSetupPage } from "@/pages/PrinterSetup";

const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0 Mobile Safari/537.36";
const realUA = window.navigator.userAgent;

function stubUA(ua: string) {
  Object.defineProperty(window.navigator, "userAgent", {
    value: ua,
    configurable: true,
  });
}

beforeEach(() => {
  localStorage.clear();
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "list_printers")
      return [
        {
          id: 1,
          name: "Office HP",
          printer_type: "ipp",
          address: "http://10.0.0.9",
          language: "pdf",
          paper_width_mm: 80,
          dpi: 203,
          status: "online",
        },
      ];
    if (cmd === "enumerate_system_printers") return [];
    return null;
  });
});
afterEach(() => {
  stubUA(realUA);
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <PrinterSetupPage />
    </MemoryRouter>,
  );

describe("printer types per platform", () => {
  it("detects the Android WebView from the user agent", () => {
    stubUA(ANDROID_UA);
    expect(isAndroid()).toBe(true);
    stubUA(realUA);
    expect(isAndroid()).toBe(false);
  });

  it("on Android offers everything but System", async () => {
    stubUA(ANDROID_UA);
    renderPage();
    await screen.findByRole("button", { name: /Add printer/i });

    // Tabs: All, Network, USB, Bluetooth — only System is hidden (no
    // spooler transport exists on Android).
    expect(
      screen.queryByRole("tab", { name: /System/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Bluetooth/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /USB/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Network/ })).toBeInTheDocument();

    // Add form: USB and Bluetooth are back now that transports exist.
    fireEvent.click(screen.getByRole("button", { name: /Add printer/i }));
    const panel = await screen.findByRole("dialog");
    // Radix renders options into a body portal, so query the screen.
    fireEvent.click(within(panel).getByLabelText("Connection"));
    expect(
      await screen.findByRole("option", { name: /Bluetooth/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /USB/ })).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /System/ }),
    ).not.toBeInTheDocument();
  });

  it("on desktop keeps every connection type", async () => {
    stubUA(realUA);
    renderPage();
    await screen.findByText(/No printers yet|All \(/);
    expect(screen.getByRole("tab", { name: /Bluetooth/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Add printer/i }));
    const panel = await screen.findByRole("dialog");
    fireEvent.click(within(panel).getByLabelText("Connection"));
    expect(
      await screen.findByRole("option", { name: /Bluetooth/ }),
    ).toBeInTheDocument();
  });

  it("on desktop shows no network scan section", async () => {
    stubUA(realUA);
    renderPage();
    await screen.findByText(/No printers yet|All \(/);
    fireEvent.click(screen.getByRole("button", { name: /Add printer/i }));
    const panel = await screen.findByRole("dialog");
    // mDNS scan is now available on all platforms (discover_network_printers via mdns-sd on desktop)
    expect(
      within(panel).queryByText(/Found on this network/),
    ).toBeInTheDocument();
  });

  it("on Android scans the LAN and fills the form from a found printer", async () => {
    stubUA(ANDROID_UA);
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_printers")
        return [
          {
            id: 1,
            name: "Office HP",
            printer_type: "ipp",
            address: "http://10.0.0.9",
            language: "pdf",
            paper_width_mm: 80,
            dpi: 203,
            status: "online",
          },
        ];
      if (cmd === "enumerate_system_printers") return [];
      if (cmd === "discover_network_printers")
        return [
          {
            id: "net:192.168.1.20:631",
            name: "Lobby IPP",
            address: "192.168.1.20:631",
            printer_type: "ipp",
            language: "pdf",
          },
          {
            id: "net:192.168.1.21:9100",
            name: "Counter JetDirect",
            address: "192.168.1.21:9100",
            printer_type: "raw_tcp",
            language: "pdf",
          },
        ];
      return null;
    });
    renderPage();
    await screen.findByRole("button", { name: /Add printer/i });
    fireEvent.click(screen.getByRole("button", { name: /Add printer/i }));
    const panel = await screen.findByRole("dialog");

    // Tapping scan calls the command and lists what mDNS found.
    fireEvent.click(within(panel).getByRole("button", { name: "Rescan" }));
    await waitFor(() =>
      expect(
        invoke.mock.calls.some((c) => c[0] === "discover_network_printers"),
      ).toBe(true),
    );
    expect(
      await within(panel).findByText("Found on this network"),
    ).toBeInTheDocument();
    const row = await within(panel).findByTestId(
      "discovered-printer-net:192.168.1.21:9100",
    );
    fireEvent.click(within(row).getByRole("button", { name: "Fill" }));
    // JetDirect fills host:port + raw_tcp; unpaired Android keeps PDF.
    expect(within(panel).getByLabelText("Address")).toHaveValue(
      "192.168.1.21:9100",
    );
  });

  it("on Android offers only the PDF language, on desktop all six", async () => {
    stubUA(ANDROID_UA);
    const view = renderPage();
    await screen.findByRole("button", { name: /Add printer/i });
    fireEvent.click(screen.getByRole("button", { name: /Add printer/i }));
    let panel = await screen.findByRole("dialog");
    fireEvent.click(within(panel).getByLabelText("Language"));
    expect(
      await screen.findByRole("option", { name: "PDF" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /ZPL/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /ESC\/POS/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Android prints PDF only/)).toBeInTheDocument();
    view.unmount();

    stubUA(realUA);
    renderPage();
    await screen.findByRole("button", { name: /Add printer/i });
    fireEvent.click(screen.getByRole("button", { name: /Add printer/i }));
    panel = await screen.findByRole("dialog");
    fireEvent.click(within(panel).getByLabelText("Language"));
    expect(
      await screen.findByRole("option", { name: /ZPL/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Android prints PDF only/),
    ).not.toBeInTheDocument();
  });

  it("on Android with a paired PC unlocks the thermal languages", async () => {
    stubUA(ANDROID_UA);
    localStorage.setItem(
      "printninja-setting:render_pairs",
      JSON.stringify([
        { id: "p1", name: "PC", host: "192.168.1.9", port: 17717, secret: "s" },
      ]),
    );
    localStorage.setItem("printninja-setting:render_policy", "auto");
    renderPage();
    await screen.findByRole("button", { name: /Add printer/i });
    fireEvent.click(screen.getByRole("button", { name: /Add printer/i }));
    const panel = await screen.findByRole("dialog");
    fireEvent.click(within(panel).getByLabelText("Language"));
    expect(
      await screen.findByRole("option", { name: /ESC\/POS/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /ZPL/ })).toBeInTheDocument();
    // All languages offered: no "PDF only" limitation note.
    expect(
      screen.queryByText(/Android prints PDF only/),
    ).not.toBeInTheDocument();
  });

  it("defaults a new USB printer to ESC/POS when a PC is paired", async () => {
    stubUA(ANDROID_UA);
    localStorage.setItem(
      "printninja-setting:render_pairs",
      JSON.stringify([
        { id: "p1", name: "PC", host: "192.168.1.9", port: 17717, secret: "s" },
      ]),
    );
    localStorage.setItem("printninja-setting:render_policy", "auto");
    renderPage();
    await screen.findByRole("button", { name: /Add printer/i });
    fireEvent.click(screen.getByRole("button", { name: /Add printer/i }));
    const panel = await screen.findByRole("dialog");
    fireEvent.click(within(panel).getByLabelText("Connection"));
    fireEvent.click(await screen.findByRole("option", { name: "USB" }));
    // The language select now reads ESC/POS instead of the PDF default.
    expect(within(panel).getByLabelText("Language")).toHaveTextContent(
      /ESC\/POS/,
    );
  });

  it("keeps PDF for USB printers without a paired PC", async () => {
    stubUA(ANDROID_UA);
    renderPage();
    await screen.findByRole("button", { name: /Add printer/i });
    fireEvent.click(screen.getByRole("button", { name: /Add printer/i }));
    const panel = await screen.findByRole("dialog");
    fireEvent.click(within(panel).getByLabelText("Connection"));
    fireEvent.click(await screen.findByRole("option", { name: "USB" }));
    expect(within(panel).getByLabelText("Connection")).toHaveTextContent("USB");
    expect(within(panel).getByLabelText("Language")).toHaveTextContent("PDF");
  });
});
