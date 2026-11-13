import { describe, it, expect } from "vitest";
import { t } from "i18next";
import "@/lib/i18n";
import {
  validateBarcode,
  BARCODE_TYPES,
  buildBarcodeSnippet,
} from "@/lib/utils/barcode";

describe("validateBarcode", () => {
  it("rejects empty values for every type", () => {
    for (const { value: type } of BARCODE_TYPES) {
      expect(t(validateBarcode(type, "") ?? ""), type).toBe(
        "Value is required",
      );
    }
  });

  it("accepts a valid EAN-13 with a correct check digit", () => {
    expect(validateBarcode("ean13", "4006381333931")).toBeNull();
  });

  it("rejects an EAN-13 with a wrong check digit", () => {
    expect(t(validateBarcode("ean13", "4006381333932") ?? "")).toContain(
      "check digit",
    );
  });

  it("enforces exact digit counts for EAN/UPC", () => {
    expect(t(validateBarcode("ean13", "123") ?? "")).toContain("13 digits");
    expect(t(validateBarcode("ean8", "123") ?? "")).toContain("8 digits");
    expect(t(validateBarcode("upca", "123") ?? "")).toContain("12 digits");
    expect(t(validateBarcode("upce", "123") ?? "")).toContain("digits");
    expect(t(validateBarcode("itf14", "123") ?? "")).toContain("digits");
  });

  it("validates UPC-E the way rxing's writer does", () => {
    // 7 digits (check computed by Rust) and 8 with a matching check.
    expect(validateBarcode("upce", "0123456")).toBeNull();
    expect(validateBarcode("upce", "01234565")).toBeNull();
    // Wrong check digit (the true one is 5).
    expect(t(validateBarcode("upce", "01234567") ?? "")).toContain(
      "check digit",
    );
    // The number system must be 0 or 1, and 6 digits do not fit.
    expect(t(validateBarcode("upce", "2123456") ?? "")).toContain("digits");
    expect(t(validateBarcode("upce", "123456") ?? "")).toContain("digits");
  });

  it("validates ITF-14 as GTIN-14 (13 digits computed, 14 checked)", () => {
    expect(validateBarcode("itf14", "0001234567890")).toBeNull();
    expect(validateBarcode("itf14", "00012345678905")).toBeNull();
    expect(t(validateBarcode("itf14", "00012345678906") ?? "")).toContain(
      "check digit",
    );
  });

  it("accepts the UPC-A check parity the Rust encoder uses", () => {
    // Rust encodes UPC-A as EAN-13 with a leading 0, so the 11-digit body
    // weights positions 1, 3, … (from the left) ×3. The old JS check had the
    // parity inverted and rejected this perfectly valid value.
    expect(validateBarcode("upca", "036000291452")).toBeNull();
    expect(t(validateBarcode("upca", "036000291458") ?? "")).toContain(
      "check digit",
    );
  });

  it("enforces Code 39's restricted charset", () => {
    expect(validateBarcode("code39", "ABC-123")).toBeNull();
    expect(t(validateBarcode("code39", "hello@world") ?? "")).toContain(
      "only supports",
    );
  });

  it("requires ITF values to have an even number of digits", () => {
    expect(validateBarcode("itf", "1234")).toBeNull();
    expect(t(validateBarcode("itf", "123") ?? "")).toContain("even number");
    expect(t(validateBarcode("itf", "12a4") ?? "")).toContain("even number");
  });

  it("requires Codabar start/stop letters", () => {
    expect(validateBarcode("codabar", "A12345B")).toBeNull();
    expect(validateBarcode("codabar", "A12345")).toBeNull();
    expect(validateBarcode("codabar", "12345B")).toBeNull();
    // Neither start nor stop letter is invalid.
    expect(t(validateBarcode("codabar", "12345") ?? "")).toContain(
      "start/stop",
    );
  });

  it("rejects Codabar values outside the symbol set", () => {
    expect(t(validateBarcode("codabar", "12#45") ?? "")).toContain(
      "start/stop",
    );
  });

  it("accepts arbitrary text for 2D symbologies", () => {
    for (const t of ["qr", "datamatrix", "pdf417", "aztec"]) {
      expect(validateBarcode(t, "anything goes"), t).toBeNull();
    }
  });

  it("trims surrounding whitespace before validating", () => {
    expect(validateBarcode("ean13", "  4006381333931  ")).toBeNull();
  });
});

describe("buildBarcodeSnippet", () => {
  it("inserts a helper call that reads a data field", () => {
    expect(buildBarcodeSnippet("code128", "order.id", true)).toEqual({
      ok: true,
      text: '{{barcode "code128" order.id}}',
    });
    expect(buildBarcodeSnippet("qr", " order.url ", true)).toEqual({
      ok: true,
      text: "{{qrcode order.url}}",
    });
  });

  it("rejects something that is not a field path", () => {
    for (const bad of ["order id", "{{order.id}}", "order.", "1abc", 'a"b']) {
      const r = buildBarcodeSnippet("code128", bad, true);
      expect(r.ok, bad).toBe(false);
    }
  });

  it("uses the helper for every symbology, even 2D ones", () => {
    expect(buildBarcodeSnippet("datamatrix", "order.id", true)).toEqual({
      ok: true,
      text: '{{barcode "datamatrix" order.id}}',
    });
  });

  it("quotes a fixed value and still uses the helper", () => {
    expect(buildBarcodeSnippet("code128", "ABC-123", false)).toEqual({
      ok: true,
      text: '{{barcode "code128" "ABC-123"}}',
    });
    expect(buildBarcodeSnippet("qr", "https://example.com", false)).toEqual({
      ok: true,
      text: '{{qrcode "https://example.com"}}',
    });
  });

  it("validates a fixed value for its symbology", () => {
    const r = buildBarcodeSnippet("ean13", "123", false);
    expect(r).toEqual({
      ok: false,
      messageKey: "designer.barcode_err_ean13_len",
    });
  });

  it("uses single quotes when the value holds a double quote, and rejects both", () => {
    expect(buildBarcodeSnippet("code128", 'a"b', false)).toMatchObject({
      ok: true,
      text: `{{barcode "code128" 'a"b'}}`,
    });
    expect(buildBarcodeSnippet("code128", `a"b'c`, false).ok).toBe(false);
  });

  it("inserts a helper call for a fixed 2D value, not a static SVG", () => {
    expect(buildBarcodeSnippet("datamatrix", "PN-1042", false)).toEqual({
      ok: true,
      text: '{{barcode "datamatrix" "PN-1042"}}',
    });
  });

  it("requires a value", () => {
    expect(buildBarcodeSnippet("code128", "  ", true)).toEqual({
      ok: false,
      messageKey: "designer.barcode_err_required",
    });
  });
});
