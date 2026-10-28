import { describe, expect, it } from "vitest";
import { t } from "i18next";
import "@/lib/i18n";
import { validatePrinterForm } from "@/lib/printerSchema";

const base = {
  name: "Dock Zebra",
  printer_type: "ipp" as const,
  address: "http://192.168.1.50/ipp/print",
  language: "pdf" as const,
  paper_width_mm: "80",
  dpi: "203",
};

describe("validatePrinterForm", () => {
  it("accepts a valid form and trims strings", () => {
    const r = validatePrinterForm({ ...base, name: "  Dock  " });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.req.name).toBe("Dock");
      expect(r.req.paper_width_mm).toBe(80);
    }
  });

  it("requires a name and a known type/language", () => {
    expect(validatePrinterForm({ ...base, name: "  " }).ok).toBe(false);
    expect(
      validatePrinterForm({ ...base, printer_type: "pigeon" as never }),
    ).toMatchObject({ ok: false });
    expect(
      validatePrinterForm({ ...base, language: "hieroglyphs" as never }),
    ).toMatchObject({ ok: false });
  });

  it("accepts IPP addresses in every form the backend parses", () => {
    // http(s), ipp(s), and the schemeless forms `parse_endpoint`
    // normalises — a bare host means the printer's IPP endpoint.
    for (const address of [
      "http://192.168.1.50/ipp/print",
      "https://printer.local/printers/1",
      "ipp://192.168.1.50:631/ipp/print",
      "ipps://printer.local:631/ipp/print",
      "192.168.1.50",
      "192.168.1.50:9100",
      "printer.local:8080/ipp/files",
      "[::1]:631/ipp/print",
    ]) {
      expect(validatePrinterForm({ ...base, address }).ok, address).toBe(true);
    }
  });

  it("still refuses IPP addresses that name no printer", () => {
    for (const address of ["ftp://x/y", "host:99999", "ho st", ""]) {
      expect(validatePrinterForm({ ...base, address }).ok, address).toBe(false);
    }
  });

  it("checks raw TCP addresses are host:port", () => {
    const tcp = { ...base, printer_type: "raw_tcp" as const };
    expect(
      validatePrinterForm({ ...tcp, address: "192.168.1.50:9100" }).ok,
    ).toBe(true);
    for (const bad of [
      "anything",
      "host:",
      "host:0",
      "host:99999",
      "ho st:9100",
    ]) {
      const r = validatePrinterForm({ ...tcp, address: bad });
      expect(r).toMatchObject({ ok: false });
      if (!r.ok) expect(t(r.messageKey)).toMatch(/host:port/);
    }
  });

  it("rejects non-finite and out-of-range numbers", () => {
    for (const paper of ["", "abc", "NaN", "Infinity", "0", "80.5", "1001"]) {
      expect(
        validatePrinterForm({ ...base, paper_width_mm: paper }).ok,
        paper,
      ).toBe(false);
    }
    for (const dpi of ["203x", "-1", "49", "2401"]) {
      expect(validatePrinterForm({ ...base, dpi }).ok, dpi).toBe(false);
    }
    // Custom values inside the range are accepted.
    expect(
      validatePrinterForm({ ...base, paper_width_mm: "110", dpi: "600" }).ok,
    ).toBe(true);
  });
});
