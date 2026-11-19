import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/i18n";
import type { PrinterRow } from "@/lib/agent/types";
import { usePrinterForm } from "@/pages/printer-setup/usePrinterForm";
import type { SystemPrinter } from "@/pages/printer-setup/constants";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

type FormArgs = Parameters<typeof usePrinterForm>;

const makeDiscovery = (): FormArgs[0] =>
  ({
    scanBluetooth: vi.fn().mockResolvedValue(undefined),
    refreshSystem: vi.fn().mockResolvedValue(undefined),
    scanNetwork: vi.fn().mockResolvedValue(undefined),
    systemPrinters: [] as SystemPrinter[],
  }) as unknown as FormArgs[0];

const makeList = (): FormArgs[1] =>
  ({
    load: vi.fn().mockResolvedValue(undefined),
    printers: [] as PrinterRow[],
    tab: "all",
  }) as unknown as FormArgs[1];

const netRow: SystemPrinter = {
  id: "net-1",
  name: "NetPrinter",
  address: "192.168.1.50",
  printer_type: "ipp",
};

const btRow: SystemPrinter = {
  id: "bt-1",
  name: "Bonded BT",
  address: "AA:BB:CC:DD:EE:FF",
  printer_type: "bluetooth",
};

const savedRow: PrinterRow = {
  id: 7,
  name: "SavedPrinter",
  address: "192.168.1.51",
  printer_type: "ipp",
  language: "pdf",
  paper_width_mm: 80,
  dpi: 203,
};

describe("usePrinterForm sheet lifecycle", () => {
  beforeEach(() => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "add_printer") return { ...savedRow, id: 8 };
      if (cmd === "update_printer") return null;
      return null;
    });
  });

  it("closes the sheet after a one-tap add from the network list", async () => {
    const discovery = makeDiscovery();
    const list = makeList();
    const { result } = renderHook(() => usePrinterForm(discovery, list));
    act(() => result.current.openAdd());
    expect(result.current.showAdd).toBe(true);

    await act(async () => {
      await result.current.addDiscovered(netRow);
    });

    expect(invoke).toHaveBeenCalledWith(
      "add_printer",
      expect.objectContaining({
        req: expect.objectContaining({
          name: "NetPrinter",
          address: "192.168.1.50",
          printer_type: "ipp",
        }),
      }),
    );
    expect(result.current.showAdd).toBe(false);
    expect(result.current.editingId).toBeNull();
    expect(result.current.form).toEqual(result.current.blankForm);
    expect(list.load).toHaveBeenCalledTimes(1);
  });

  it("closes the sheet after a one-tap add from the Bluetooth list", async () => {
    const discovery = makeDiscovery();
    const list = makeList();
    const { result } = renderHook(() => usePrinterForm(discovery, list));
    act(() => result.current.openAdd());
    expect(result.current.showAdd).toBe(true);

    await act(async () => {
      await result.current.addDiscovered(btRow);
    });

    expect(invoke).toHaveBeenCalledWith(
      "add_printer",
      expect.objectContaining({
        req: expect.objectContaining({ name: "Bonded BT" }),
      }),
    );
    expect(result.current.showAdd).toBe(false);
    expect(result.current.form).toEqual(result.current.blankForm);
    expect(list.load).toHaveBeenCalledTimes(1);
  });

  it("keeps the sheet open when a one-tap add fails", async () => {
    invoke.mockImplementation(async () => {
      throw new Error("boom");
    });
    const discovery = makeDiscovery();
    const list = makeList();
    const { result } = renderHook(() => usePrinterForm(discovery, list));
    act(() => result.current.openAdd());

    await act(async () => {
      await result.current.addDiscovered(netRow);
    });

    expect(result.current.showAdd).toBe(true);
    expect(list.load).not.toHaveBeenCalled();
  });

  it("ignores a second tap while a one-tap add is in flight", async () => {
    let resolveAdd: (v: unknown) => void = () => {};
    invoke.mockImplementation((cmd: string) =>
      cmd === "add_printer"
        ? new Promise((resolve) => {
            resolveAdd = resolve;
          })
        : Promise.resolve(null),
    );
    const discovery = makeDiscovery();
    const list = makeList();
    const { result } = renderHook(() => usePrinterForm(discovery, list));
    act(() => result.current.openAdd());

    const first = result.current.addDiscovered(netRow);
    const second = result.current.addDiscovered(netRow);
    await act(async () => {
      resolveAdd({ ...savedRow, id: 8 });
      await Promise.all([first, second]);
    });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(result.current.showAdd).toBe(false);
  });

  it("saves an edit and closes the sheet, as before", async () => {
    const discovery = makeDiscovery();
    const list = makeList();
    const { result } = renderHook(() => usePrinterForm(discovery, list));
    act(() => result.current.openEdit(savedRow));
    expect(result.current.showAdd).toBe(true);
    expect(result.current.editingId).toBe(7);

    await act(async () => {
      await result.current.addPrinter();
    });

    expect(invoke).toHaveBeenCalledWith(
      "update_printer",
      expect.objectContaining({ id: 7 }),
    );
    expect(result.current.showAdd).toBe(false);
    expect(result.current.editingId).toBeNull();
    expect(result.current.form).toEqual(result.current.blankForm);
    expect(list.load).toHaveBeenCalledTimes(1);
  });
});
