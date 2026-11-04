import { describe, it, expect, afterEach } from "vitest";
import {
  isAndroid,
  supportedPrinterLanguages,
  supportedPrinterTypes,
  ANDROID_THERMAL_QA_GATE,
} from "@/lib/platform";

const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0 Mobile Safari/537.36";
const realUA = window.navigator.userAgent;

const LANGUAGES = [
  { value: "pdf", label: "PDF" },
  { value: "escpos", label: "ESC/POS" },
  { value: "zpl", label: "ZPL" },
  { value: "tspl", label: "TSPL" },
  { value: "cpcl", label: "CPCL" },
  { value: "raster", label: "Raster" },
];
const TYPES = [
  { value: "ipp", label: "IPP" },
  { value: "raw_tcp", label: "Raw TCP" },
  { value: "usb", label: "USB" },
  { value: "bluetooth", label: "Bluetooth" },
  { value: "system", label: "System" },
];

function stubUA(ua: string) {
  Object.defineProperty(window.navigator, "userAgent", {
    value: ua,
    configurable: true,
  });
}

afterEach(() => {
  stubUA(realUA);
});

describe("isAndroid", () => {
  it("reads the WebView user agent", () => {
    expect(isAndroid()).toBe(false);
    stubUA(ANDROID_UA);
    expect(isAndroid()).toBe(true);
  });
});

describe("ANDROID_THERMAL_QA_GATE (PLAN §4, D4.4)", () => {
  it("is the three QA'd receipt and label languages", () => {
    expect([...ANDROID_THERMAL_QA_GATE].sort()).toEqual([
      "escpos",
      "tspl",
      "zpl",
    ]);
  });
});

describe("supportedPrinterLanguages", () => {
  it("on Android keeps PDF plus the QA-gated languages only", () => {
    stubUA(ANDROID_UA);
    expect(supportedPrinterLanguages(LANGUAGES).map((l) => l.value)).toEqual([
      "pdf",
      "escpos",
      "zpl",
      "tspl",
    ]);
  });

  it("on desktop keeps every language", () => {
    stubUA(realUA);
    expect(supportedPrinterLanguages(LANGUAGES)).toHaveLength(LANGUAGES.length);
  });
});

describe("supportedPrinterTypes", () => {
  it("on Android hides only the System transport", () => {
    stubUA(ANDROID_UA);
    expect(supportedPrinterTypes(TYPES).map((t) => t.value)).toEqual([
      "ipp",
      "raw_tcp",
      "usb",
      "bluetooth",
    ]);
  });

  it("on desktop keeps every transport", () => {
    stubUA(realUA);
    expect(supportedPrinterTypes(TYPES)).toHaveLength(TYPES.length);
  });
});
