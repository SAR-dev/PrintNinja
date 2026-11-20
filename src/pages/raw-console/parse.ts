/**
 * The raw console's input → bytes decoding.
 *
 * Two input modes:
 *
 * - `text`: plain text with escapes — `\n`, `\r`, `\t`, `\\` and `\xHH`
 *   (one byte). Non-ASCII text is UTF-8 encoded, matching what the app's
 *   own renderers feed to the printers.
 * - `hex`: whitespace-separated byte tokens (`1B 40 0A`); every token must
 *   be exactly two hex digits, so an odd digit count is a visible error
 *   rather than a silently dropped digit.
 *
 * The payload cap is the backend's: `send_raw_bytes` rejects anything over
 * 1 MiB, so the UI refuses earlier with the same number.
 */

export type RawMode = "text" | "hex";

export type RawParseError =
  | "empty"
  | "too_large"
  | "invalid_hex"
  | "unknown_escape";

export type RawParse =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; error: RawParseError };

/** Largest payload the backend accepts (`send_raw_bytes` rejects above it). */
export const MAX_RAW_BYTES = 1024 * 1024;

const HEX_PAIR = /^[0-9A-Fa-f]{2}$/;

function hexDigit(c: string): number | null {
  const n = c.charCodeAt(0);
  if (n >= 0x30 && n <= 0x39) return n - 0x30;
  if (n >= 0x61 && n <= 0x66) return n - 0x57;
  if (n >= 0x41 && n <= 0x46) return n - 0x37;
  return null;
}

function pushUtf8(out: number[], cp: number): void {
  if (cp < 0x80) {
    out.push(cp);
  } else if (cp < 0x800) {
    out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
  } else if (cp < 0x10000) {
    out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  } else {
    out.push(
      0xf0 | (cp >> 18),
      0x80 | ((cp >> 12) & 0x3f),
      0x80 | ((cp >> 6) & 0x3f),
      0x80 | (cp & 0x3f),
    );
  }
}

/**
 * Decode `input` into `out`, or name the first thing that is wrong.
 * Stops as soon as the output would exceed the cap, so a huge paste does
 * not allocate a huge buffer before being refused.
 */
function decodeInto(
  input: string,
  mode: RawMode,
  out: number[],
): RawParseError | null {
  if (mode === "hex") {
    for (const token of input.split(/\s+/)) {
      if (token === "") continue;
      if (!HEX_PAIR.test(token)) return "invalid_hex";
      out.push(parseInt(token, 16));
      if (out.length > MAX_RAW_BYTES) return "too_large";
    }
    return null;
  }
  for (let i = 0; i < input.length; ) {
    const ch = input[i];
    if (ch !== "\\") {
      const cp = input.codePointAt(i) as number;
      pushUtf8(out, cp);
      i += cp > 0xffff ? 2 : 1;
      if (out.length > MAX_RAW_BYTES) return "too_large";
      continue;
    }
    const next = input[i + 1];
    if (next === undefined) return "unknown_escape";
    i += 2;
    if (next === "n") out.push(0x0a);
    else if (next === "r") out.push(0x0d);
    else if (next === "t") out.push(0x09);
    else if (next === "\\") out.push(0x5c);
    else if (next === "x") {
      const d1 = hexDigit(input[i] ?? "");
      const d2 = hexDigit(input[i + 1] ?? "");
      if (d1 === null || d2 === null) return "invalid_hex";
      out.push((d1 << 4) | d2);
      i += 2;
    } else {
      return "unknown_escape";
    }
    if (out.length > MAX_RAW_BYTES) return "too_large";
  }
  return null;
}

/** Decode the console input; `error` says why the bytes cannot be sent. */
export function decodeRaw(input: string, mode: RawMode): RawParse {
  const out: number[] = [];
  const fail = decodeInto(input, mode, out);
  if (fail) return { ok: false, error: fail };
  if (out.length === 0) return { ok: false, error: "empty" };
  return { ok: true, bytes: Uint8Array.from(out) };
}

/**
 * Base64 of `bytes` for the `data_base64` argument. Chunked like
 * `btoa` wants: one `fromCharCode` call per 32 KiB, so a full 1 MiB
 * payload does not overflow the call's argument limit.
 */
export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
