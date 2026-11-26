/**
 * The raw console's template library (docs/todo/RAW-CONSOLE-MINIMAL.md).
 *
 * Each row is a known-good payload for one printer language, copied from
 * the spec's table so its bytes never change under you. `source` is what
 * you type into the console's data field (text mode uses `\n`/`\r`/`\xHH`
 * escapes; hex mode is space-separated byte tokens); `mode` says which.
 *
 * `expectedToFail` marks rows whose payload is correct by construction but
 * that most hardware still garbles (CJK and raster) — the console shows an
 * expectation note for those so a garbled label is not mistaken for a
 * console bug.
 */

import type { RawMode } from "./parse";

export type RawTemplateLanguage = "zpl" | "escpos" | "tspl" | "cpcl";

export type RawTemplateCase =
  | "text"
  | "barcode"
  | "qr"
  | "shapes"
  | "cjk"
  | "raster";

export interface RawTemplate {
  id: string;
  case: RawTemplateCase;
  name: string;
  language: RawTemplateLanguage;
  mode: RawMode;
  source: string;
  description: string;
  /** The payload is correct; most printers still render it wrong. */
  expectedToFail?: boolean;
}

/** Case order in the template list. */
export const RAW_TEMPLATE_CASES: { id: RawTemplateCase; label: string }[] = [
  { id: "text", label: "Text" },
  { id: "barcode", label: "Barcodes" },
  { id: "qr", label: "QR codes" },
  { id: "shapes", label: "Shapes" },
  { id: "cjk", label: "CJK" },
  { id: "raster", label: "Raster" },
];

/**
 * Every row of the spec table. Bytes are pinned by the vitest suite
 * (decode each `source`, compare against the hand-computed byte arrays),
 * so a stray edit to an escape shows up as a failing test.
 */
export const RAW_TEMPLATES: RawTemplate[] = [
  // — Text —
  {
    id: "text-zpl",
    case: "text",
    name: "Text minimal",
    language: "zpl",
    mode: "text",
    source: "^XA^FO30,30^ADN,36,20^FDTEST^FS^XZ",
    description: "Smallest valid ZPL job: one 36 pt character at (30,30).",
  },
  {
    id: "text-escpos",
    case: "text",
    name: "Text minimal",
    language: "escpos",
    mode: "text",
    source: "\\x1B\\x40TEST\\n\\n\\n",
    description: "Initialize, print TEST, feed three lines.",
  },
  {
    id: "text-tspl",
    case: "text",
    name: "Text minimal",
    language: "tspl",
    mode: "text",
    source:
      'SIZE 40 mm,30 mm\r\nGAP 2 mm,0 mm\r\nCLS\r\nTEXT 0,0,"2",0,1,1,"TEST"\r\nPRINT 1\r\n',
    description: "A 40×30 mm label with one text field.",
  },
  {
    id: "text-cpcl",
    case: "text",
    name: "Text minimal",
    language: "cpcl",
    mode: "text",
    source: "! 0 200 200 210 1\r\nTEXT 4 0 0 20 TEST\r\nPRINT\r\n",
    description: "One text line on a 200×200 dot label.",
  },
  {
    id: "large-zpl",
    case: "text",
    name: "Large text",
    language: "zpl",
    mode: "text",
    source: "^XA^FO30,30^A0N,40,40^FDTEST^FS^XZ",
    description: "Scalable font (^A0) at 40×40.",
  },
  {
    id: "large-escpos",
    case: "text",
    name: "Large text",
    language: "escpos",
    mode: "hex",
    source: "1B 40 1B 21 11 54 45 53 54 0A 1B 21 00",
    description: "Double-height font on, TEST, one feed line, font off.",
  },
  {
    id: "newlines-zpl",
    case: "text",
    name: "Newlines",
    language: "zpl",
    mode: "text",
    source: "^XA\n^FO50,50^A0N,40,40\n^FDPrintNinja test^FS\n^XZ\n",
    description:
      "Real newline bytes inside the ZPL — the B-FP2D case; feeds blank lines.",
  },
  {
    id: "multiline-escpos",
    case: "text",
    name: "Multiline",
    language: "escpos",
    mode: "text",
    source: "TEST LINE 1\nTEST LINE 2\nTEST LINE 3\n\n",
    description: "Three lines plus two feed lines.",
  },
  // — Barcodes —
  {
    id: "barcode128-zpl",
    case: "barcode",
    name: "Barcode Code128",
    language: "zpl",
    mode: "text",
    source: "^XA^FO50,50^BY3^BCN,100,Y,N,N^FD1234567890^FS^XZ",
    description: "Code128 with the human-readable digits below.",
  },
  {
    id: "barcode128-tspl",
    case: "barcode",
    name: "Barcode Code128",
    language: "tspl",
    mode: "text",
    source:
      'SIZE 40 mm,30 mm\r\nGAP 2 mm,0 mm\r\nCLS\r\nBARCODE 10,10,"128",2,90,0,0,2,"1234567890"\r\nPRINT 1\r\n',
    description: "Code128 on a 40×30 mm label.",
  },
  {
    id: "barcode128-escpos",
    case: "barcode",
    name: "Barcode Code128",
    language: "escpos",
    mode: "hex",
    source: "1B 40 1D 6B 4E 01 02 30 31 32 33 34 35 36 37 38 39 30 00 1D 68 48",
    description: "GS k Code128, height 72 dots (0x48).",
  },
  // — QR —
  {
    id: "qr-zpl",
    case: "qr",
    name: "QR",
    language: "zpl",
    mode: "text",
    source: "^XA^FO50,50^BQN,2,10^FDQ,PrintNinja^FS^XZ",
    description: "QR, model 2, magnification 10.",
  },
  {
    id: "qr-escpos",
    case: "qr",
    name: "QR",
    language: "escpos",
    mode: "hex",
    source:
      "1B 40 1D 28 6B 04 00 31 41 32 00 1D 28 6B 03 00 31 43 03 1D 28 6B 03 00 31 45 30 33 32 1D 28 6B 0D 00 31 50 30 50 72 69 6E 74 4E 69 6E 6A 61 1D 28 6B 03 00 31 51 30 32 30",
    description: "GS ( k: model 2, level M, mag 3, payload “PrintNinja”.",
  },
  // — Shapes —
  {
    id: "box-zpl",
    case: "shapes",
    name: "Box + line",
    language: "zpl",
    mode: "text",
    source: "^XA^FO30,30^GB300,200,20^FS^FO50,120^FDIN BOX^FS^XZ",
    description: "A 300×200 box with text inside it.",
  },
  {
    id: "box-tspl",
    case: "shapes",
    name: "Box + line",
    language: "tspl",
    mode: "text",
    source:
      "SIZE 40 mm,30 mm\r\nGAP 2 mm,0 mm\r\nCLS\r\nBOX 10,10,350,250,2\r\nPRINT 1\r\n",
    description: "One 350×250 box, 2-dot border.",
  },
  // — CJK —
  {
    id: "cjk-zpl",
    case: "cjk",
    name: "Japanese text",
    language: "zpl",
    mode: "text",
    source: "^XA^FO50,50^A0N,30,30^FDプリントニンジャ^FS^XZ",
    description:
      "プリントニンジャ (PrintNinja). Most built-in ZPL fonts have no CJK glyphs — garbled output is expected.",
    expectedToFail: true,
  },
  {
    id: "cjk-escpos",
    case: "cjk",
    name: "Japanese text",
    language: "escpos",
    mode: "hex",
    source: "1B 40 1B 74 28 F8 EA C4 FC EA D4 EA C9 48 53",
    description:
      "ESC t selects the CP932 code page, then SS2 + double-byte text. The exact sequence is a hypothesis to confirm per printer (spec note).",
    expectedToFail: true,
  },
  // — Raster —
  {
    id: "raster-escpos",
    case: "raster",
    name: "Raster square",
    language: "escpos",
    mode: "hex",
    source:
      "1B 40 1D 76 30 00 01 00 10 FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF",
    description:
      "GS v 0, 16-dot column of black — a 16×16 square. Banding or drift is the common failure.",
    expectedToFail: true,
  },
  {
    id: "raster-zpl",
    case: "raster",
    name: "Raster square",
    language: "zpl",
    mode: "hex",
    source:
      "5E 58 41 0D 5E 44 47 30 2C 31 2C 31 2C 30 2C 30 2C 30 2C FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF 0D 5E 58 5A",
    description:
      "^DG 16-dot raster block — 16×16 square. Most common failure: the square is drawn but misaligned.",
    expectedToFail: true,
  },
];
