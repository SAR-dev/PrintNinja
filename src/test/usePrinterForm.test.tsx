import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/i18n";
import type { PrinterRow } from "@/lib/agent/types";
import { usePrinterForm } from "@/pages/printer-setup/usePrinterForm";
import type { SystemPrinter } from "@/pages/printer-setup/constants";
import type { LoosePrinterForm } from "@/lib/printerSchema";

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

const btRowSaved: PrinterRow = {
  id: 9,
  name: "Bonded BT",
  address: "AA:BB:CC:DD:EE:FF",
  printer_type: "bluetooth",
  language: "escpos",
  paper_width_mm: 54,
  dpi: 203,
  default_settings_json: '{"bluetooth":{"chunkBytes":256,"chunkPauseMs":100}}',
};

/** A valid driverless Bluetooth form; the pace fields default to blank. */
const btForm = (over: Partial<LoosePrinterForm> = {}): LoosePrinterForm => ({
  name: "Bonded BT",
  printer_type: "bluetooth",
  address: "AA:BB:CC:DD:EE:FF",
  language: "escpos",
  paper_width_mm: "54",
  dpi: "203",
  label_gap_mm: "",
  bt_chunk_bytes: "",
  bt_chunk_pause_ms: "",
  escpos_band_rows: "",
  username: "",
  password: "",
  skip_tls_verification: false,
  via_driver: false,
  ...over,
});

describe("usePrinterForm sheet lifecycle", () => {
  beforeEach(() => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "add_printer") return { ...savedRow, id: 8 };
      if (cmd === "update_printer") return { ...savedRow };
      if (cmd === "set_printer_bluetooth_delivery") return null;
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

  it("fills the form instead of saving on a one-tap add from the Bluetooth list", async () => {
    const discovery = makeDiscovery();
    const list = makeList();
    const { result } = renderHook(() => usePrinterForm(discovery, list));
    act(() => result.current.openAdd());
    expect(result.current.showAdd).toBe(true);

    act(() => {
      result.current.addDiscovered(btRow);
    });

    // B1: the paper width decides whether the page fits, so a bonded
    // row is confirmed before saving — no add_printer, the sheet stays
    // open, and the width is a safe 2-inch default under the user's
    // eyes (Advanced opened), never a blind 80 mm.
    expect(invoke).not.toHaveBeenCalledWith("add_printer", expect.anything());
    expect(result.current.showAdd).toBe(true);
    expect(result.current.editingId).toBeNull();
    expect(result.current.form.name).toBe("Bonded BT");
    expect(result.current.form.address).toBe("AA:BB:CC:DD:EE:FF");
    expect(result.current.form.printer_type).toBe("bluetooth");
    expect(result.current.form.language).toBe("escpos");
    expect(result.current.form.paper_width_mm).toBe("54");
    expect(result.current.advancedOpen).toBe(true);
    expect(list.load).not.toHaveBeenCalled();
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

  it("prefills the Bluetooth pace fields from the row's settings when editing", () => {
    const discovery = makeDiscovery();
    const list = makeList();
    const { result } = renderHook(() => usePrinterForm(discovery, list));
    act(() => result.current.openEdit(btRowSaved));
    expect(result.current.form.bt_chunk_bytes).toBe("256");
    expect(result.current.form.bt_chunk_pause_ms).toBe("100");
  });

  it("saves the pace after the row for a driverless Bluetooth add", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "add_printer") return { ...btRowSaved };
      if (cmd === "set_printer_bluetooth_delivery") return null;
      return null;
    });
    const discovery = makeDiscovery();
    const list = makeList();
    const { result } = renderHook(() => usePrinterForm(discovery, list));
    act(() => result.current.openAdd());
    act(() => result.current.setForm(btForm({ bt_chunk_bytes: "256" })));

    await act(async () => {
      await result.current.addPrinter();
    });

    // Only the filled half is sent; the missing one stays at its default.
    expect(invoke).toHaveBeenCalledWith("set_printer_bluetooth_delivery", {
      id: 9,
      delivery: { chunkBytes: 256 },
    });
    expect(result.current.showAdd).toBe(false);
    expect(list.load).toHaveBeenCalledTimes(1);
  });

  it("sends delivery null when a driverless Bluetooth row is saved blank", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "add_printer") return { ...btRowSaved };
      if (cmd === "set_printer_bluetooth_delivery") return null;
      return null;
    });
    const discovery = makeDiscovery();
    const list = makeList();
    const { result } = renderHook(() => usePrinterForm(discovery, list));
    act(() => result.current.openAdd());
    act(() => result.current.setForm(btForm()));

    await act(async () => {
      await result.current.addPrinter();
    });

    // Both fields blank clears the stored pace: the built-in defaults apply.
    expect(invoke).toHaveBeenCalledWith("set_printer_bluetooth_delivery", {
      id: 9,
      delivery: null,
    });
  });

  it("leaves the pace alone for a driver-mode Bluetooth row", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "add_printer") return { ...btRowSaved };
      return null;
    });
    const discovery = makeDiscovery();
    const list = makeList();
    const { result } = renderHook(() => usePrinterForm(discovery, list));
    act(() => result.current.openAdd());
    act(() =>
      result.current.setForm(
        btForm({ via_driver: true, bt_chunk_bytes: "256" }),
      ),
    );

    await act(async () => {
      await result.current.addPrinter();
    });

    // The driver in between buffers on its own — no raw-wire pacing.
    expect(invoke).not.toHaveBeenCalledWith(
      "set_printer_bluetooth_delivery",
      expect.anything(),
    );
    expect(result.current.showAdd).toBe(false);
  });

  it("prefills the ESC/POS band height from the row's settings when editing", () => {
    const discovery = makeDiscovery();
    const list = makeList();
    const { result } = renderHook(() => usePrinterForm(discovery, list));
    act(() =>
      result.current.openEdit({
        ...btRowSaved,
        default_settings_json: '{"escpos":{"bandRows":64}}',
      }),
    );
    expect(result.current.form.escpos_band_rows).toBe("64");
    // A row without the key reads blank (the built-in 256 rows).
    act(() => result.current.openEdit(btRowSaved));
    expect(result.current.form.escpos_band_rows).toBe("");
  });

  it("saves the ESC/POS band height after the row", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "add_printer") return { ...btRowSaved };
      return null;
    });
    const discovery = makeDiscovery();
    const list = makeList();
    const { result } = renderHook(() => usePrinterForm(discovery, list));
    act(() => result.current.openAdd());
    act(() => result.current.setForm(btForm({ escpos_band_rows: "64" })));

    await act(async () => {
      await result.current.addPrinter();
    });

    expect(invoke).toHaveBeenCalledWith("set_printer_escpos_tuning", {
      id: 9,
      tuning: { bandRows: 64 },
    });
    expect(result.current.showAdd).toBe(false);
  });

  it("clears the ESC/POS band height when the field is saved blank", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "add_printer") return { ...btRowSaved };
      return null;
    });
    const discovery = makeDiscovery();
    const list = makeList();
    const { result } = renderHook(() => usePrinterForm(discovery, list));
    act(() => result.current.openAdd());
    act(() => result.current.setForm(btForm()));

    await act(async () => {
      await result.current.addPrinter();
    });

    expect(invoke).toHaveBeenCalledWith("set_printer_escpos_tuning", {
      id: 9,
      tuning: null,
    });
  });

  it("does not touch the band height for a non-ESC/POS row", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "add_printer") return { ...btRowSaved };
      return null;
    });
    const discovery = makeDiscovery();
    const list = makeList();
    const { result } = renderHook(() => usePrinterForm(discovery, list));
    act(() => result.current.openAdd());
    act(() =>
      result.current.setForm(
        btForm({ language: "zpl", escpos_band_rows: "64" }),
      ),
    );

    await act(async () => {
      await result.current.addPrinter();
    });

    expect(invoke).not.toHaveBeenCalledWith(
      "set_printer_escpos_tuning",
      expect.anything(),
    );
  });

  it("keeps the saved row when only the pace call fails", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "add_printer") return { ...btRowSaved };
      if (cmd === "set_printer_bluetooth_delivery") throw new Error("boom");
      return null;
    });
    const discovery = makeDiscovery();
    const list = makeList();
    const { result } = renderHook(() => usePrinterForm(discovery, list));
    act(() => result.current.openAdd());
    act(() => result.current.setForm(btForm({ bt_chunk_bytes: "256" })));

    await act(async () => {
      await result.current.addPrinter();
    });

    // The row is already saved and prints fine at the defaults; the sheet
    // closes and the list refreshes — only the custom pace is lost.
    expect(result.current.showAdd).toBe(false);
    expect(result.current.editingId).toBeNull();
    expect(result.current.form).toEqual(result.current.blankForm);
    expect(list.load).toHaveBeenCalledTimes(1);
  });
});

describe("password semantics on edit (blank means keep)", () => {
  const secureRow: PrinterRow = {
    ...savedRow,
    username: "admin",
    has_password: true,
  };

  const setup = () => {
    const discovery = makeDiscovery();
    const list = makeList();
    const { result } = renderHook(() => usePrinterForm(discovery, list));
    act(() => result.current.openEdit(secureRow));
    return { result };
  };

  const updateReq = () => {
    const call = invoke.mock.calls.find((c) => c[0] === "update_printer");
    return (call as [string, { id: number; req: Record<string, unknown> }])[1]
      .req as Record<string, unknown>;
  };

  it("never prefills the stored password and shows the keep hint", () => {
    const { result } = setup();
    expect(result.current.form.password).toBe("");
    expect(result.current.signInOpen).toBe(true);
    expect(result.current.passwordKeepHint).toBe(true);
  });

  it("sends no password when the untouched field is left blank", async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.addPrinter();
    });
    // Undefined omits the key from the JSON — the backend keeps the
    // stored password.
    expect(updateReq().password).toBeUndefined();
    expect(result.current.passwordKeepHint).toBe(false);
  });

  it("sends the typed password when the field is changed", async () => {
    const { result } = setup();
    act(() => {
      result.current.setPasswordTouched(true);
      result.current.setForm((f) => ({ ...f, password: "new-secret" }));
    });
    expect(result.current.passwordKeepHint).toBe(false);

    await act(async () => {
      await result.current.addPrinter();
    });
    expect(updateReq().password).toBe("new-secret");
  });

  it("sends a blank string when the field was touched and cleared", async () => {
    const { result } = setup();
    act(() => {
      result.current.setPasswordTouched(true);
      result.current.setForm((f) => ({ ...f, password: "new-secret" }));
      result.current.setForm((f) => ({ ...f, password: "" }));
    });

    await act(async () => {
      await result.current.addPrinter();
    });
    // Touched blank is explicit: it clears the stored password.
    expect(updateReq().password).toBe("");
  });
});
