import { z } from "zod";

/**
 * Shared add/edit validation for printers, used by the Setup panel for
 * both flows (the backend shares one rulebook too, but only for
 * type/language — address shapes are a UI concern and validated here).
 */

export const PRINTER_TYPES = [
  "ipp",
  "raw_tcp",
  "usb",
  "bluetooth",
  "system",
] as const;
export const PRINTER_LANGUAGES = [
  "pdf",
  "escpos",
  "tspl",
  "zpl",
  "cpcl",
  "raster",
] as const;

/**
 * The language a printer should start with once its connection type is
 * known.
 *
 * USB and Bluetooth are raw wires: the bytes go to the printer unchanged,
 * with no driver in between to rasterize a document. A PDF sent that way
 * prints as pages of gibberish on a receipt or label head, so those types
 * start at ESC/POS instead of the PDF default — unless the row is a
 * Bluetooth one printing through its OS driver (`viaDriver`), where the
 * driver in between *is* a rasterizer and PDF is a normal choice again.
 * The flag belongs to Bluetooth only (USB has no driver-mode option), so
 * it never changes what USB starts at. Anything the person already moved
 * off PDF is left alone, and every other connection type keeps what it
 * had (IPP and system printers read PDF; JetDirect lasers do too).
 */
export function defaultLanguageFor(
  printerType: string,
  current: string,
  viaDriver = false,
): string {
  const rawWire =
    printerType === "usb" || (printerType === "bluetooth" && !viaDriver);
  return rawWire && current === "pdf" ? "escpos" : current;
}

const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[^\]]+\])$/i;

/** The schemes an IPP endpoint may be written with. */
const IPP_SCHEMES = ["http:", "https:", "ipp:", "ipps:"];

/**
 * An IPP address, in any form the backend's `parse_endpoint` accepts:
 * `http://host/ipp/print`, `ipp://host:631/ipp/print`, and a bare
 * `host`, `host:port` or `host:port/path`.
 *
 * The backend has accepted all of these since P7 — a bare host is
 * normalised to `http://host:631/ipp/print` — but the form used to insist
 * on a full `http(s)://` URL, so the address CUPS and every IPP client
 * print as `ipp://…` (RFC 8010's own form) was rejected here.
 */
function ippAddressOk(address: string): boolean {
  // Any URL with a printing scheme. `new URL` also rejects the shapes
  // that are not URLs at all, which the bare form below still allows.
  try {
    if (IPP_SCHEMES.includes(new URL(address).protocol)) return true;
  } catch {
    /* not a URL — try the schemeless form */
  }

  // Bare form: `host`, `host:port`, `host:port/path` (and the bracketed
  // IPv6 `[::1]:631/ipp/print`). A colon before a slash is the port, so
  // this never mistakes an IPv6 literal for `host:port`.
  const trimmed = address.trim();
  const m =
    /^\[([^\]]+)\](?::(\d{1,5}))?(?:[/?#].*)?$/.exec(trimmed) ??
    /^([^:/?#\s]+)(?::(\d{1,5}))?(?:[/?#].*)?$/.exec(trimmed);
  if (!m) return false;
  if (!HOST_RE.test(m[1]) && !m[1].includes(":")) return false;
  if (m[2] === undefined) return true;
  const port = Number(m[2]);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * A Bluetooth address in any shape the backend's `bluetooth_addr::parse`
 * accepts: a MAC (`:` or `-` separators, optional `:1`–`:30` RFCOMM
 * channel) or a Windows serial port (`COM7`, `\\.\COM7`).
 */
export function bluetoothAddressOk(address: string): boolean {
  const a = address.trim();
  const com = /^(?:\\\\\.\\|\/\/\.\/)?COM(\d{1,5})$/i.exec(a);
  if (com) {
    const n = Number(com[1]);
    return n >= 1 && n <= 65535;
  }
  const parts = a.split(/[:-]/);
  if (parts.length !== 6 && parts.length !== 7) return false;
  if (!parts.slice(0, 6).every((p) => /^[0-9a-f]{2}$/i.test(p))) return false;
  if (parts.length === 6) return true;
  if (!/^\d{1,2}$/.test(parts[6])) return false;
  const ch = Number(parts[6]);
  return ch >= 1 && ch <= 30;
}

/**
 * An address that is plainly a USB or print-queue port (`USB003`,
 * `LPT1:`, `PORTPROMPT:`, a pipe or WSD path) — what ends up in a
 * Bluetooth row when the connection type is changed after picking a
 * system printer or a USB device. Worth its own message: it is a
 * connection-type mix-up, not a typo.
 */
export function looksLikePortAddress(address: string): boolean {
  const a = address.trim();
  return (
    /^USB\d+$/i.test(a) ||
    /^LPT\d+:?$/i.test(a) ||
    /^(PORTPROMPT|FILE|nul|XPSPort|SHRFAX):?$/i.test(a) ||
    /^\\\\/.test(a) ||
    /^WSD-/i.test(a)
  );
}

/**
 * The i18n key explaining why a driverless Bluetooth address is wrong, or
 * `null` when it is fine (or still empty — "required" is its own message).
 */
export function bluetoothAddressIssue(address: string): string | null {
  if (!address.trim()) return null;
  if (bluetoothAddressOk(address)) return null;
  return looksLikePortAddress(address)
    ? "printers.err_bt_usb_port"
    : "printers.err_bluetooth";
}

function addressError(
  printerType: string,
  address: string,
  viaDriver = false,
): string | null {
  switch (printerType) {
    case "ipp":
      return ippAddressOk(address) ? null : "printers.err_ipp_url";
    case "raw_tcp": {
      const m = /^(.+):(\d{1,5})$/.exec(address);
      const port = m ? Number(m[2]) : NaN;
      if (
        !m ||
        !HOST_RE.test(m[1]) ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535
      ) {
        return "printers.err_raw_tcp";
      }
      return null;
    }
    case "bluetooth":
      // Driver mode prints through the OS queue named by the printer, so
      // the address is not dialled and has no fixed shape there.
      return viaDriver ? null : bluetoothAddressIssue(address);
    default:
      // usb, system: device ids and names have no fixed shape.
      return null;
  }
}

/** A positive, finite, fractional number; blank is `undefined`. */
const finitePositive = (
  notNumberKey: string,
  minKey: string,
  maxKey: string,
  min: number,
  max: number,
) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : Number(v)),
    z
      .number({ invalid_type_error: notNumberKey })
      .min(min, minKey)
      .max(max, maxKey)
      .refine((n) => Number.isFinite(n), {
        message: notNumberKey,
      })
      // Blank is the encoder default, not an error — the field may be
      // left empty, which the preprocess above maps to `undefined`.
      .optional(),
  );

const finitePositiveInt = (
  notNumberKey: string,
  notIntKey: string,
  minKey: string,
  maxKey: string,
  min: number,
  max: number,
) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : Number(v)),
    z
      .number({ invalid_type_error: notNumberKey })
      .int(notIntKey)
      .min(min, minKey)
      .max(max, maxKey)
      .refine((n) => Number.isFinite(n), {
        message: notNumberKey,
      }),
  );

export const printerFormSchema = z
  .object({
    name: z.string().trim().min(1, "printers.err_name_required"),
    printer_type: z.enum(PRINTER_TYPES, {
      errorMap: () => ({ message: "printers.err_unknown_type" }),
    }),
    address: z.string().trim().min(1, "printers.err_address_required"),
    language: z.enum(PRINTER_LANGUAGES, {
      errorMap: () => ({ message: "printers.err_unknown_language" }),
    }),
    paper_width_mm: finitePositiveInt(
      "printers.err_paper_number",
      "printers.err_paper_int",
      "printers.err_paper_min",
      "printers.err_paper_max",
      1,
      1000,
    ),
    dpi: finitePositiveInt(
      "printers.err_dpi_number",
      "printers.err_dpi_int",
      "printers.err_dpi_min",
      "printers.err_dpi_max",
      50,
      2400,
    ),
    // TSPL media gap in mm. Blank means the encoder default (2 mm); the
    // value is only meaningful for a TSPL label, but accepting it for
    // other languages costs nothing and keeps one rulebook. Fractional
    // gaps are real (a 1.5 mm gap), so this is a positive number, not
    // an integer, between 0.1 and 50 mm.
    label_gap_mm: finitePositive(
      "printers.err_gap_number",
      "printers.err_gap_min",
      "printers.err_gap_max",
      0.1,
      50,
    ),
    // IPP sign-in: blank user means the built-in `PrintNinja` identity,
    // blank password means no HTTP authentication at all.
    username: z.string().trim().max(200).optional(),
    password: z.string().max(200).optional(),
    skip_tls_verification: z.boolean().optional(),
    // Manual Bluetooth mode: through the OS driver queue instead of the
    // driverless wire. Hidden in the Android UI (no driver path there
    // yet), so a value on a non-Bluetooth type is simply ignored by the
    // backend — nothing validates it harder than a boolean here.
    via_driver: z.boolean().optional(),
  })
  .superRefine((form, ctx) => {
    const err = addressError(
      form.printer_type,
      form.address,
      form.via_driver === true,
    );
    if (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["address"],
        message: err,
      });
    }
  });

export type PrinterForm = z.input<typeof printerFormSchema>;
export type ValidPrinterReq = z.output<typeof printerFormSchema>;

/** The panel keeps every field as a string; enums reject unknowns here. */
export interface LoosePrinterForm {
  name: string;
  printer_type: string;
  address: string;
  language: string;
  paper_width_mm: string;
  dpi: string;
  label_gap_mm: string;
  username: string;
  password: string;
  skip_tls_verification: boolean;
  via_driver: boolean;
}

/** One friendly message for the toast: the first failing field, as an i18n key. */
export function validatePrinterForm(
  form: LoosePrinterForm,
): { ok: true; req: ValidPrinterReq } | { ok: false; messageKey: string } {
  const parsed = printerFormSchema.safeParse(form);
  if (parsed.success) return { ok: true, req: parsed.data };
  return {
    ok: false,
    messageKey: parsed.error.issues[0]?.message ?? "printers.err_invalid",
  };
}
