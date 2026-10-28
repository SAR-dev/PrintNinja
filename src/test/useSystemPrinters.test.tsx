import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

import {
  mergePrinters,
  useSystemPrinters,
} from "@/lib/hooks/useSystemPrinters";

const saved = (id: number, name: string) => ({
  id,
  name,
  address: "http://10.0.0.5:631/ipp/print",
  printer_type: "ipp",
  language: "pdf",
});

describe("useSystemPrinters", () => {
  beforeEach(() => {
    // A block body: returning the mock would make Vitest call it as a cleanup.
    invoke.mockReset();
  });

  it("lists a printer saved on the Printers page when the OS reports none (Android)", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_printers") return [saved(3, "Office IPP")];
      if (cmd === "enumerate_system_printers") return [];
      return null;
    });
    const { result } = renderHook(() => useSystemPrinters());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.printers.map((p) => p.name)).toEqual(["Office IPP"]);
  });

  it("picks up a printer added after the first load on refresh()", async () => {
    let rows = [saved(1, "First")];
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_printers") return rows;
      if (cmd === "enumerate_system_printers") return [];
      return null;
    });
    const { result } = renderHook(() => useSystemPrinters());
    await waitFor(() => expect(result.current.printers).toHaveLength(1));

    rows = [saved(1, "First"), saved(2, "Added later")];
    const merged = await result.current.refresh();
    expect(merged.map((p) => p.name)).toEqual(["First", "Added later"]);
    await waitFor(() => expect(result.current.printers).toHaveLength(2));
  });

  it("still lists saved printers when OS discovery fails", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_printers") return [saved(1, "Saved")];
      throw new Error("no spooler");
    });
    const { result } = renderHook(() => useSystemPrinters());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.printers.map((p) => p.name)).toEqual(["Saved"]);
  });
});

describe("mergePrinters", () => {
  it("puts saved first and drops a system printer with the same name", () => {
    const merged = mergePrinters(
      [saved(1, "Zebra")],
      [
        {
          id: "a",
          name: "zebra",
          address: "",
          printer_type: "system",
          language: "pdf",
        },
        {
          id: "b",
          name: "Brother",
          address: "",
          printer_type: "system",
          language: "pdf",
        },
      ],
    );
    expect(merged.map((p) => p.name)).toEqual(["Zebra", "Brother"]);
    expect(merged[0].id).toBe("saved:1");
  });
});
