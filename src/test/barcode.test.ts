import { describe, it, expect } from "vitest";
import { validateBarcode, BARCODE_TYPES } from "@/lib/utils/barcode";

describe("barcode validation", () => {
  it("validates empty value for code128", () => {
    expect(validateBarcode("code128", "")).toContain("requires at least 1 character");
  });

  it("accepts non-empty value for code128", () => {
    expect(validateBarcode("code128", "ABC123")).toBeNull();
  });

  it("validates code39 charset", () => {
    expect(validateBarcode("code39", "ABC")).toBeNull();
    expect(validateBarcode("code39", "abc123")).toBeNull();
    expect(validateBarcode("code39", "hello@world")).toContain("only supports");
  });

  it("validates EAN-13 digit count", () => {
    expect(validateBarcode("ean13", "4006381333931")).toBeNull();
    expect(validateBarcode("ean13", "123")).toContain("exactly 13 digits");
    expect(validateBarcode("ean13", "abcdefghij")).toContain("exactly 13 digits");
  });

  it("validates QR code requires content", () => {
    expect(validateBarcode("qr", "")).toContain("requires content");
    expect(validateBarcode("qr", "https://example.com")).toBeNull();
  });

  it("validates EAN-13 check digit", () => {
    // 4006381333931 is a valid EAN-13 with correct check digit
    expect(validateBarcode("ean13", "4006381333931")).toBeNull();
    // Change last digit makes it invalid
    expect(validateBarcode("ean13", "4006381333932")).toContain("check digit");
  });

  it("has all expected barcode types", () => {
    expect(BARCODE_TYPES.length).toBeGreaterThanOrEqual(10);
    expect(BARCODE_TYPES.map((b) => b.value)).toContain("code128");
    expect(BARCODE_TYPES.map((b) => b.value)).toContain("qr");
    expect(BARCODE_TYPES.map((b) => b.value)).toContain("ean13");
  });
});
