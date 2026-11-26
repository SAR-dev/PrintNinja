import { describe, expect, it } from "vitest";
import { decodeRaw, MAX_RAW_BYTES, toBase64 } from "@/pages/raw-console/parse";

type Mode = "text" | "hex";

const decoded = (input: string, mode: Mode): number[] => {
  const r = decodeRaw(input, mode);
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return Array.from(r.bytes);
};

describe("decodeRaw — hex mode", () => {
  it("decodes whitespace-separated byte tokens", () => {
    expect(decoded("1B 40 0A", "hex")).toEqual([0x1b, 0x40, 0x0a]);
  });

  it("accepts lowercase and mixed-case digits", () => {
    expect(decoded("1b 4F 0a", "hex")).toEqual([0x1b, 0x4f, 0x0a]);
  });

  it("accepts any whitespace between tokens", () => {
    expect(decoded("1B\n40\t0A  ", "hex")).toEqual([0x1b, 0x40, 0x0a]);
  });

  it("rejects an odd digit count", () => {
    expect(decodeRaw("1B4", "hex")).toEqual({
      ok: false,
      error: "invalid_hex",
    });
    expect(decodeRaw("123 40", "hex")).toEqual({
      ok: false,
      error: "invalid_hex",
    });
  });

  it("rejects a non-hex token", () => {
    expect(decodeRaw("1G 40", "hex")).toEqual({
      ok: false,
      error: "invalid_hex",
    });
  });

  it("treats empty input as empty", () => {
    expect(decodeRaw("", "hex")).toEqual({ ok: false, error: "empty" });
    expect(decodeRaw("   \n", "hex")).toEqual({ ok: false, error: "empty" });
  });

  it("refuses more than 1 MiB", () => {
    expect(decodeRaw("00 ".repeat(MAX_RAW_BYTES + 1), "hex")).toEqual({
      ok: false,
      error: "too_large",
    });
  });

  it("accepts exactly 1 MiB", () => {
    const r = decodeRaw("00 ".repeat(MAX_RAW_BYTES - 1) + "00", "hex");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bytes.length).toBe(MAX_RAW_BYTES);
  });
});

describe("decodeRaw — text mode", () => {
  it("passes plain ASCII through", () => {
    expect(decoded("TEST", "text")).toEqual([0x54, 0x45, 0x53, 0x54]);
  });

  it("decodes every supported escape", () => {
    expect(decoded("\\n\\r\\t\\\\\\x41\\xff", "text")).toEqual([
      0x0a, 0x0d, 0x09, 0x5c, 0x41, 0xff,
    ]);
  });

  it("rejects an unknown escape", () => {
    expect(decodeRaw("a\\qb", "text")).toEqual({
      ok: false,
      error: "unknown_escape",
    });
  });

  it("rejects a trailing backslash", () => {
    expect(decodeRaw("a\\", "text")).toEqual({
      ok: false,
      error: "unknown_escape",
    });
  });

  it("rejects a malformed \\x escape", () => {
    expect(decodeRaw("\\x1G", "text")).toEqual({
      ok: false,
      error: "invalid_hex",
    });
    expect(decodeRaw("\\x4", "text")).toEqual({
      ok: false,
      error: "invalid_hex",
    });
  });

  it("UTF-8 encodes non-ASCII text (incl. surrogate pairs)", () => {
    expect(decoded("A", "text")).toEqual([0x41]);
    expect(decoded("é", "text")).toEqual([0xc3, 0xa9]);
    expect(decoded("あ", "text")).toEqual([0xe3, 0x81, 0x82]);
    expect(decoded("🎉", "text")).toEqual([0xf0, 0x9f, 0x8e, 0x89]);
  });

  it("treats empty input as empty, but keeps literal spaces", () => {
    expect(decodeRaw("", "text")).toEqual({ ok: false, error: "empty" });
    expect(decoded("   ", "text")).toEqual([0x20, 0x20, 0x20]);
  });

  it("refuses more than 1 MiB of output", () => {
    expect(decodeRaw("A".repeat(MAX_RAW_BYTES + 1), "text")).toEqual({
      ok: false,
      error: "too_large",
    });
  });
});

describe("toBase64", () => {
  it("encodes known bytes", () => {
    expect(toBase64(Uint8Array.from([0x1b, 0x40, 0x0a]))).toBe("G0AK");
  });

  it("round-trips through atob", () => {
    const bytes = decoded("1B 40 FF 00 7F", "hex");
    const bin = atob(toBase64(Uint8Array.from(bytes)));
    expect([...bin].map((c) => c.charCodeAt(0))).toEqual(bytes);
  });

  it("round-trips a full 1 MiB payload (the chunked fromCharCode path)", () => {
    const bytes = Uint8Array.from(
      { length: MAX_RAW_BYTES },
      (_, i) => (i * 31 + 7) & 0xff,
    );
    const bin = atob(toBase64(bytes));
    expect(bin.length).toBe(MAX_RAW_BYTES);
    for (let i = 0; i < MAX_RAW_BYTES; i += 99991) {
      expect(bin.charCodeAt(i)).toBe(bytes[i]);
    }
  });
});
