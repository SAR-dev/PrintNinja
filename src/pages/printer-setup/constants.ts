import { Bluetooth, Monitor, Printer, Usb, Wifi } from "lucide-react";
import type { DetectedDevice } from "@/components/printers/DetectedDevices";

export const PRINTER_TYPES = [
  { value: "ipp", labelKey: "printers.conn_ipp" },
  { value: "raw_tcp", labelKey: "printers.conn_raw" },
  { value: "usb", labelKey: "printers.conn_usb" },
  { value: "bluetooth", labelKey: "printers.conn_bluetooth" },
  { value: "system", labelKey: "printers.conn_system" },
];

export const LANGUAGES = [
  { value: "pdf", labelKey: "printers.lang_pdf" },
  { value: "escpos", labelKey: "printers.lang_escpos" },
  { value: "tspl", labelKey: "printers.lang_tspl" },
  { value: "zpl", labelKey: "printers.lang_zpl" },
  { value: "cpcl", labelKey: "printers.lang_cpcl" },
  { value: "raster", labelKey: "printers.lang_raster" },
];

export const PAPERS = [
  { value: "48", label: "48 mm" },
  { value: "54", label: "54 mm" },
  { value: "72", label: "72 mm" },
  { value: "100", label: "100 mm" },
  { value: "152", label: "4x6 in (152 mm)" },
  { value: "210", label: "A4 (210 mm)" },
];

/** Anything the dialog can pick up: an OS queue, an mDNS hit or a paired device. */
export type SystemPrinter = DetectedDevice;

/** Tabs group printers by how they connect. */
export const GROUPS = [
  {
    key: "all",
    labelKey: "printers.filter_all",
    types: null as string[] | null,
  },
  {
    key: "network",
    labelKey: "printers.filter_network",
    types: ["ipp", "raw_tcp"],
  },
  { key: "usb", labelKey: "printers.filter_usb", types: ["usb"] },
  {
    key: "bluetooth",
    labelKey: "printers.filter_bluetooth",
    types: ["bluetooth"],
  },
  { key: "system", labelKey: "printers.filter_system", types: ["system"] },
];

export const TYPE_ICONS: Record<string, typeof Printer> = {
  ipp: Wifi,
  raw_tcp: Wifi,
  usb: Usb,
  bluetooth: Bluetooth,
  system: Monitor,
};

/**
 * USB and driverless Bluetooth hand the bytes to the printer unchanged, so
 * PDF is not a language they can print. Bluetooth in driver mode goes
 * through the OS queue, whose driver rasterizes — PDF is valid there.
 */
export function isRawWire(printerType: string, viaDriver: boolean): boolean {
  return printerType === "usb" || (printerType === "bluetooth" && !viaDriver);
}

/** Which test print to send: the image page, or one line of plain text. */
export type TestKind = "page" | "text";

/**
 * The bundled-model family a row's language takes, or `null` for a
 * document (PDF) printer that has no label model at all: `raster` rows
 * print ESC/POS bytes, every command language speaks its own. Mirrors
 * the backend's `expected_language`, which validates the pick the same
 * way at write time.
 */
export function labelProfileFamily(language: string): string | null {
  switch (language) {
    case "escpos":
    case "raster":
      return "escpos";
    case "zpl":
    case "tspl":
    case "cpcl":
      return language;
    default:
      return null;
  }
}

/**
 * Whether Test Print can send the plain-text test on top of the image
 * page. The command languages print text natively; pdf and raster only
 * accept bitmaps, so they have the page test and nothing cheaper.
 */
export function supportsTextTest(language: string): boolean {
  return (
    language === "escpos" ||
    language === "tspl" ||
    language === "zpl" ||
    language === "cpcl"
  );
}

/**
 * How long the test print may take before the button gives up on it.
 *
 * Long enough for the backend's own worst case: the reachability probe
 * (≤10 s), a PDF render (up to 75 s with the Android WebView's watchdog
 * and the Rust deadline behind it) and the send. Past that no answer is
 * coming back, and without this bound the button stayed on "Testing…"
 * forever when the backend never replied.
 */
export const TEST_TIMEOUT_MS = 80_000;
