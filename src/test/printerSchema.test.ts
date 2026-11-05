import { describe, expect, it } from "vitest";
import { t } from "i18next";
import "@/lib/i18n";
import { defaultLanguageFor, validatePrinterForm } from "@/lib/printerSchema";

const base = {
  name: "Dock Zebra",
  printer_type: "ipp" as const,
  address: "http://192.168.1.50/ipp/print",
  language: "pdf" as const,
  paper_width_mm: "80",
  dpi: "203",
  label_gap_mm: "",
  username: "",
  password: "",
  skip_tls_verification: false,
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

  it("keeps the label gap blank or a fractional number in range", () => {
    // Blank is the encoder default (2 mm); fractions are real gaps.
    expect(
      validatePrinterForm({ ...base, label_gap_mm: "" }).ok,
    ).toBe(true);
    const r = validatePrinterForm({ ...base, label_gap_mm: "1.5" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.req.label_gap_mm).toBe(1.5);
    for (const gap of ["0", "0.05", "51", "abc"]) {
      expect(
        validatePrinterForm({ ...base, label_gap_mm: gap }).ok,
        gap,
      ).toBe(false);
    }
  });

  it("passes the IPP sign-in fields through untouched", () => {
    const r = validatePrinterForm({
      ...base,
      username: "ada",
      password: "s3cret",
      skip_tls_verification: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.req.username).toBe("ada");
      expect(r.req.password).toBe("s3cret");
      expect(r.req.skip_tls_verification).toBe(true);
    }
  });
});

describe("defaultLanguageFor", () => {
  it("moves the PDF default to ESC/POS on the raw USB and Bluetooth wires", () => {
    expect(defaultLanguageFor("usb", "pdf")).toBe("escpos");
    expect(defaultLanguageFor("bluetooth", "pdf")).toBe("escpos");
  });

  it("leaves a language the person already chose", () => {
    for (const lang of ["escpos", "zpl", "tspl", "cpcl", "raster"]) {
      expect(defaultLanguageFor("usb", lang)).toBe(lang);
      expect(defaultLanguageFor("bluetooth", lang)).toBe(lang);
    }
  });

  it("keeps PDF for connections that can take a document", () => {
    for (const type of ["ipp", "raw_tcp", "system"]) {
      expect(defaultLanguageFor(type, "pdf")).toBe("pdf");
    }
  });
});
