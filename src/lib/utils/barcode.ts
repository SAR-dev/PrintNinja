/**
 * What the UI knows about barcodes.
 *
 * Every preview and every print is rendered by Rust (src-tauri/src/render/barcode.rs
 * and src-tauri/src/commands/print.rs), so this file only carries the picker
 * list, the value validation that mirrors the Rust encoders, and the snippet
 * the Designer's Insert Barcode dialog inserts. Keep the symbology list in
 * sync with `SYMBOLOGIES` in `barcode.rs`.
 */
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

/** A data path a template can read: `order.id`, `this.sku`, `sku`. */
const FIELD_PATH = /^[A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)*$/;

export type BarcodeSnippet =
  | { ok: true; text: string }
  | { ok: false; messageKey: string; messageParams?: Record<string, string> };

/**
 * What the Designer's Insert Barcode dialog puts in the template.
 *
 * - `fromData`: `value` is a field path, giving `{{barcode "code128" order.id}}`,
 *   so every print (and every CSV row) gets its own code.
 * - otherwise `value` is fixed text, inserted as a quoted literal.
 *
 * Every symbology prints through the Rust `{{barcode}}` / `{{qrcode}}`
 * helpers, so every snippet is a helper call — the preview and the printed
 * label always come from the same renderer.
 */
export function buildBarcodeSnippet(
  type: string,
  value: string,
  fromData: boolean,
): BarcodeSnippet {
  const v = value.trim();
  if (!v) return { ok: false, messageKey: "designer.barcode_err_required" };
  const call = (arg: string) =>
    type === "qr" ? `{{qrcode ${arg}}}` : `{{barcode "${type}" ${arg}}}`;

  if (fromData) {
    if (!FIELD_PATH.test(v)) {
      return { ok: false, messageKey: "designer.barcode_err_field" };
    }
    return { ok: true, text: call(v) };
  }

  const errorKey = validateBarcode(type, v);
  if (errorKey) return { ok: false, messageKey: errorKey };

  // A Handlebars string literal can hold either quote, but not both.
  if (v.includes('"') && v.includes("'")) {
    return {
      ok: false,
      messageKey: "designer.barcode_err_quotes",
    };
  }
  const literal = v.includes('"') ? `'${v}'` : `"${v}"`;
  return { ok: true, text: call(literal) };
}

export function validateBarcode(type: string, value: string): string | null {
  const v = value.trim();

  if (!v) return "designer.barcode_err_required";

  const checkOk = (data: string, checkDigit: string) =>
    eanupcCheckDigit(data) === Number(checkDigit);

  switch (type) {
    case "code128":
      return null;
    case "code39":
      return /^[0-9A-Z\-\.\ \/\+\%\$]+$/i.test(v)
        ? null
        : "designer.barcode_err_c39";
    case "ean13":
      if (!/^\d{13}$/.test(v)) return "designer.barcode_err_ean13_len";
      return checkOk(v.slice(0, 12), v[12])
        ? null
        : "designer.barcode_err_ean13_check";
    case "ean8":
      if (!/^\d{8}$/.test(v)) return "designer.barcode_err_ean8_len";
      return checkOk(v.slice(0, 7), v[7])
        ? null
        : "designer.barcode_err_ean8_check";
    case "upca":
      if (!/^\d{12}$/.test(v)) return "designer.barcode_err_upca_len";
      // Rust encodes UPC-A as EAN-13 with a leading 0, so the parity here is
      // the EAN-13 one (odd positions ×3) — see eanupcCheckDigit.
      return checkOk(v.slice(0, 11), v[11])
        ? null
        : "designer.barcode_err_upca_check";
    case "upce":
      // rxing's UPC-E writer: 7 digits (check computed) or 8 digits (check
      // must pass), first digit the number system 0 or 1.
      if (!/^[01]\d{6,7}$/.test(v)) return "designer.barcode_err_upce";
      if (v.length === 8 && !checkOk(upceToUpca11(v.slice(0, 7)), v[7]))
        return "designer.barcode_err_upce_check";
      return null;
    case "itf":
      // ITF encodes digit pairs only, so it needs an even count.
      return /^\d+$/.test(v) && v.length % 2 === 0
        ? null
        : "designer.barcode_err_itf";
    case "itf14":
      // 13 digits (check computed by Rust) or 14 (check must match).
      if (!/^\d{13,14}$/.test(v)) return "designer.barcode_err_itf14";
      if (v.length === 14 && !checkOk(v.slice(0, 13), v[13]))
        return "designer.barcode_err_itf14_check";
      return null;
    case "codabar": {
      // Codabar = optional start letter A-D, digits, optional stop letter
      // A-D, and AT LEAST ONE of the letters must be present. Plain digits
      // with neither are not a valid Codabar value.
      const body = "0-9\\-\\$\\+\\:\\/\\.";
      const shaped = new RegExp(`^[A-Da-d]?[${body}]+[A-Da-d]?$`).test(v);
      const hasLetter = /[A-Da-d]/.test(v);
      return shaped && hasLetter ? null : "designer.barcode_err_codabar";
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

/**
 * The check digit of an EAN/UPC/GTIN body (the digits WITHOUT the check).
 *
 * The standard rule, independent of the total length: counting from the
 * right, the digit immediately left of the check is ×3, then ×1, ×3, …
 * That is the formula both encoders apply — `barcoders`' EAN-13 for
 * ean13/ean8/upca (UPC-A rides as `0` + 12 digits) and rxing's
 * `getStandardUPCEANChecksum` for UPC-E and ITF-14 — so a check digit this
 * function rejects is one the Rust encoder will refuse too.
 */
function eanupcCheckDigit(data: string): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += Number(data[i]) * ((data.length - 1 - i) % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * The 11 data digits of the UPC-A form of a 7-digit UPC-E value, using the
 * same expansion rxing (`convertUPCEtoUPCA`) applies before computing the
 * check digit.
 */
function upceToUpca11(v: string): string {
  const [n, x1, x2, x3, x4, x5, x6] = v.split("");
  switch (x6) {
    case "0":
    case "1":
    case "2":
      return `${n}${x1}${x2}${x6}0000${x3}${x4}${x5}`;
    case "3":
      return `${n}${x1}${x2}${x3}00000${x4}${x5}`;
    case "4":
      return `${n}${x1}${x2}${x3}${x4}00000${x5}`;
    default:
      return `${n}${x1}${x2}${x3}${x4}${x5}0000${x6}`;
  }
}
