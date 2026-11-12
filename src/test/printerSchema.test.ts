import { describe, expect, it } from "vitest";
import { t } from "i18next";
import "@/lib/i18n";
import {
  bluetoothAddressIssue,
  bluetoothAddressOk,
  defaultLanguageFor,
  looksLikePortAddress,
  validatePrinterForm,
} from "@/lib/printerSchema";

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
  via_driver: false,
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
    expect(validatePrinterForm({ ...base, label_gap_mm: "" }).ok).toBe(true);
    const r = validatePrinterForm({ ...base, label_gap_mm: "1.5" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.req.label_gap_mm).toBe(1.5);
    for (const gap of ["0", "0.05", "51", "abc"]) {
      expect(validatePrinterForm({ ...base, label_gap_mm: gap }).ok, gap).toBe(
        false,
      );
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

  it("carries the manual driver flag through to the request", () => {
    // Off and on are both explicit values the form always sends — the
    // stored row is what the transport reads, so nothing can flip the
    // path without this field flipping too.
    expect(
      validatePrinterForm({
        ...base,
        printer_type: "bluetooth",
        address: "A4:77:17:22:33:44",
      }),
    ).toMatchObject({ ok: true, req: { via_driver: false } });
    const on = validatePrinterForm({
      ...base,
      printer_type: "bluetooth",
      address: "A4:77:17:22:33:44",
      via_driver: true,
    });
    expect(on.ok).toBe(true);
    if (on.ok) expect(on.req.via_driver).toBe(true);
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

  it("keeps PDF on a Bluetooth row printing through its driver", () => {
    // The driver in between rasterizes — the reason the raw wire needs
    // ESC/POS does not apply. USB has no driver-mode option, so its
    // rule is unchanged.
    expect(defaultLanguageFor("bluetooth", "pdf", true)).toBe("pdf");
    expect(defaultLanguageFor("usb", "pdf", true)).toBe("escpos");
    // The flag does not override an explicit non-PDF choice either.
    expect(defaultLanguageFor("bluetooth", "zpl", true)).toBe("zpl");
  });
});

describe("Bluetooth address validation (mirrors bluetooth_addr::parse)", () => {
  it("accepts a MAC in any case and separator, with an optional channel", () => {
    for (const a of [
      "A4:77:17:22:33:44",
      "a4-77-17-22-33-44",
      "A4:77:17:22:33:44:2",
      "A4:77:17:22:33:44:30",
      " A4:77:17:22:33:44 ",
    ]) {
      expect(bluetoothAddressOk(a), a).toBe(true);
    }
  });

  it("accepts Windows COM ports, with and without the extended prefix", () => {
    for (const a of ["COM7", "com12", "\\\\.\\COM7", "//./COM7"]) {
      expect(bluetoothAddressOk(a), a).toBe(true);
    }
  });

  it("rejects what the backend rejects", () => {
    for (const a of [
      "A4:77:17:22:33",
      "A4:77:17:22:33:4",
      "A4:77:17:22:33:44:0",
      "A4:77:17:22:33:44:31",
      "A4:77:17:22:33:44:1:1",
      "GG:77:17:22:33:44",
      "COM0",
      "COM",
      "COMx",
      "USB003",
      "Ruijie 80",
    ]) {
      expect(bluetoothAddressOk(a), a).toBe(false);
    }
  });

  it("recognises ports and queues that were left in the address by mistake", () => {
    for (const a of [
      "USB003",
      "usb1",
      "LPT1:",
      "PORTPROMPT:",
      "nul:",
      "\\\\.\\pipe\\PDFPrint",
      "WSD-de33823c-3047-4b1b-ad11-d2df0f8",
    ]) {
      expect(looksLikePortAddress(a), a).toBe(true);
    }
    expect(looksLikePortAddress("A4:77:17:22:33:44")).toBe(false);
    expect(looksLikePortAddress("Ruijie 80")).toBe(false);
  });

  it("names the right message, and stays quiet on empty input", () => {
    expect(bluetoothAddressIssue("")).toBeNull();
    expect(bluetoothAddressIssue("  ")).toBeNull();
    expect(bluetoothAddressIssue("A4:77:17:22:33:44")).toBeNull();
    expect(bluetoothAddressIssue("USB003")).toBe("printers.err_bt_usb_port");
    expect(bluetoothAddressIssue("A4:77")).toBe("printers.err_bluetooth");
  });

  it("blocks a driverless Bluetooth row with a bad address, not a driver-mode one", () => {
    const row = {
      ...base,
      printer_type: "bluetooth",
      language: "escpos",
      address: "USB003",
    };
    expect(validatePrinterForm(row)).toEqual({
      ok: false,
      messageKey: "printers.err_bt_usb_port",
    });
    expect(validatePrinterForm({ ...row, via_driver: true }).ok).toBe(true);
    expect(validatePrinterForm({ ...row, address: "COM7" }).ok).toBe(true);
  });

  it("has an English message for every key it can return", () => {
    for (const key of ["printers.err_bt_usb_port", "printers.err_bluetooth"]) {
      expect(t(key)).not.toBe(key);
    }
  });
});
