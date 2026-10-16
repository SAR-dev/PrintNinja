import bwipjs from "bwip-js";

export interface BarcodeOptions {
  type: string;
  value: string;
  height?: number;
  width?: number;
  text?: boolean;
  includetext?: boolean;
}

export function generateBarcodeSvg(options: BarcodeOptions): string {
  try {
    const canvas = document.createElement("canvas");
    bwipjs.toCanvas(canvas, {
      bcid: options.type,
      text: options.value,
      scale: 3,
      height: options.height || 10,
      width: options.width || 2,
      includetext: options.text !== false,
      textxalign: "center",
    });
    return canvas.toDataURL("image/svg+xml");
  } catch {
    return "";
  }
}

export function validateBarcode(type: string, value: string): string | null {
  switch (type) {
    case "code128":
      return value.length > 0 ? null : "Code 128 requires at least 1 character";
    case "code39":
      return /^[0-9A-Z\-\.\ \/\+\%]+$/i.test(value) ? null : "Code 39 only supports A-Z, 0-9, -, ., space, /, +, %, $";
    case "ean13":
      if (!/^\d{13}$/.test(value)) return "EAN-13 requires exactly 13 digits";
      return validateEanCheckDigit(value) ? null : "Invalid EAN-13 check digit";
    case "ean8":
      if (!/^\d{8}$/.test(value)) return "EAN-8 requires exactly 8 digits";
      return validateEanCheckDigit(value) ? null : "Invalid EAN-8 check digit";
    case "upca":
      if (!/^\d{12}$/.test(value)) return "UPC-A requires exactly 12 digits";
      return validateEanCheckDigit(value) ? null : "Invalid UPC-A check digit";
    case "qr":
      return value.length > 0 ? null : "QR code requires content";
    default:
      return value.length > 0 ? null : "Value is required";
  }
}

function validateEanCheckDigit(value: string): boolean {
  const digits = value.split("").map(Number);
  const check = digits.pop()!;
  const sum = digits.reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10 === check;
}

export const BARCODE_TYPES = [
  { value: "code128", label: "Code 128" },
  { value: "code39", label: "Code 39" },
  { value: "code93", label: "Code 93" },
  { value: "ean13", label: "EAN-13" },
  { value: "ean8", label: "EAN-8" },
  { value: "upca", label: "UPC-A" },
  { value: "upce", label: "UPC-E" },
  { value: "itf", label: "ITF" },
  { value: "itf14", label: "ITF-14" },
  { value: "codabar", label: "Codabar" },
  { value: "qr", label: "QR Code" },
  { value: "datamatrix", label: "Data Matrix" },
  { value: "pdf417", label: "PDF417" },
  { value: "aztec", label: "Aztec" },
] as const;
