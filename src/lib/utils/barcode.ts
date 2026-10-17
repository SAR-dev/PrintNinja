import { toSVG } from "bwip-js";

export interface BarcodeOptions {
  type: string;
  value: string;
  /** Bar height in mm (bwip-js `height`). */
  height?: number;
  /** Module width in mm (bwip-js `width`). */
  width?: number;
  /** Render the human-readable text under the bars. */
  text?: boolean;
  /** Output width in mm; omit to let bwip-js decide. */
  scaleToWidth?: number;
}

/**
 * Generate an inline SVG barcode.
 *
 * PLANNING.md 7.5 requires *inline SVG* so the rendered template needs no
 * scripts and no external image files.
 *
 * NOTE: the previous implementation drew onto a `<canvas>` and then called
 * `canvas.toDataURL("image/svg+xml")`. A canvas only ever holds raster
 * pixels, so that produced PNG bytes labelled as SVG — browsers refuse to
 * render it and the `<img>` showed a broken image. bwip-js has a real
 * `toSVG()`; use it.
 */
export function generateBarcodeSvg(options: BarcodeOptions): string {
  // Translate our friendly id into the real bwip-js encoder name.
  const bcid = bcidFor(options.type);
  if (!bcid) return "";

  try {
    return toSVG({
      bcid,
      text: options.value,
      height: options.height || 10,
      width: options.width || 2,
      includetext: options.text !== false,
      textxalign: "center",
      scale: 3,
    });
  } catch {
    return "";
  }
}

/**
 * Convert a number of millimetres to device-independent pixels using the
 * supplied DPI (default 96 CSS px per inch). Keeps bar modules on whole
 * pixels so thermal output is not blurry.
 */
export function mmToPx(mm: number, dpi = 96): number {
  return Math.round((mm / 25.4) * dpi);
}

/**
 * Snap a module width to a whole number of dots at the printer's DPI,
 * because a fractional module width renders as a smeared bar on thermal
 * heads (PLANNING.md 7.5).
 */
export function snapModuleToDot(widthMm: number, dpi: number): number {
  const dots = mmToPx(widthMm, dpi);
  return Math.max(1, Math.round(dots));
}

/** Build a printable `<img>`/inline SVG block for a template. */
export function buildBarcodeHtml(options: BarcodeOptions): string {
  const svg = generateBarcodeSvg(options);
  if (!svg) return "";

  const widthMm = options.scaleToWidth ?? 40;
  // bwip-js emits `<svg ...>` — inject the physical width right after the tag.
  return `<div class="barcode" style="text-align:center;margin:2mm 0">
${svg.replace(/^<svg/, `<svg width="${widthMm}mm"`)}
</div>`;
}

export function validateBarcode(type: string, value: string): string | null {
  const v = value.trim();

  if (!v) return "Value is required";

  switch (type) {
    case "code128":
      return null;
    case "code39":
      return /^[0-9A-Z\-\.\ \/\+\%\$]+$/i.test(v)
        ? null
        : "Code 39 only supports A-Z, 0-9, -, ., space, /, +, %, $";
    case "ean13":
      if (!/^\d{13}$/.test(v)) return "EAN-13 requires exactly 13 digits";
      return validateEanCheckDigit(v) ? null : "Invalid EAN-13 check digit";
    case "ean8":
      if (!/^\d{8}$/.test(v)) return "EAN-8 requires exactly 8 digits";
      return validateEanCheckDigit(v) ? null : "Invalid EAN-8 check digit";
    case "upca":
      if (!/^\d{12}$/.test(v)) return "UPC-A requires exactly 12 digits";
      return validateEanCheckDigit(v) ? null : "Invalid UPC-A check digit";
    case "itf":
      // ITF encodes digit pairs only, so it needs an even count.
      return /^\d+$/.test(v) && v.length % 2 === 0
        ? null
        : "ITF requires an even number of digits";
    case "codabar": {
      // Codabar = optional start letter A-D, digits, optional stop letter
      // A-D, and AT LEAST ONE of the letters must be present. Plain digits
      // with neither are not a valid Codabar value.
      const body = "0-9\\-\\$\\+\\:\\/\\.";
      const shaped = new RegExp(`^[A-Da-d]?[${body}]+[A-Da-d]?$`).test(v);
      const hasLetter = /[A-Da-d]/.test(v);
      return shaped && hasLetter
        ? null
        : "Codabar requires start/stop letters A-D and digits";
    }
    case "qr":
    case "datamatrix":
    case "pdf417":
    case "aztec":
      return null;
    default:
      return null;
  }
}

function validateEanCheckDigit(value: string): boolean {
  const digits = value.split("").map(Number);
  const check = digits.pop()!;
  const sum = digits.reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10 === check;
}

export const BARCODE_TYPES = [
  { value: "code128", label: "Code 128", bcid: "code128" },
  { value: "code39", label: "Code 39", bcid: "code39" },
  { value: "code93", label: "Code 93", bcid: "code93" },
  { value: "ean13", label: "EAN-13", bcid: "ean13" },
  { value: "ean8", label: "EAN-8", bcid: "ean8" },
  { value: "upca", label: "UPC-A", bcid: "upca" },
  { value: "upce", label: "UPC-E", bcid: "upce" },
  { value: "itf", label: "ITF", bcid: "interleaved2of5" },
  { value: "itf14", label: "ITF-14", bcid: "itf14" },
  { value: "codabar", label: "Codabar", bcid: "rationalizedCodabar" },
  { value: "qr", label: "QR Code", bcid: "qrcode" },
  { value: "datamatrix", label: "Data Matrix", bcid: "datamatrix" },
  { value: "pdf417", label: "PDF417", bcid: "pdf417" },
  { value: "aztec", label: "Aztec", bcid: "azteccode" },
] as const;

/**
 * Map our friendly symbology id to the bwip-js encoder name.
 *
 * Four ids do NOT match bwip-js encoder names, and passing them through
 * verbatim made `toSVG` throw `unknown encoder name` — so those options in
 * the Designer picker silently failed to insert:
 *   - itf     -> interleaved2of5
 *   - codabar -> rationalizedCodabar
 *   - aztec   -> azteccode
 *   - qr      -> qrcode
 */
export function bcidFor(type: string): string | null {
  return BARCODE_TYPES.find((t) => t.value === type)?.bcid ?? null;
}

/** Human-readable label for a symbology id. */
export function labelFor(type: string): string {
  return BARCODE_TYPES.find((t) => t.value === type)?.label ?? type;
}