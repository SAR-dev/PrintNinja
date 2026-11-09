#!/usr/bin/env node
"use strict";

/**
 * Local fake printer for PrintNinja development.
 *
 * IPP mode (default), built on `ipp-printer`:
 *   Add it in the app as:  ipp://localhost:6310/ipp/print
 *   Every job the app sends is written to ./output/ (PDFs get a .pdf name).
 *
 * Raw mode (--raw), a fake thermal head for PLAN §4:
 *   Listens like a JetDirect printer (default port 9100). Every job the app
 *   sends is written to ./output/ named by detected framing (.escpos,
 *   .zpl, .tspl, .cpcl, .bin), and status queries are answered "healthy" so the
 *   app's precheck behaves like it would against a real head.
 *   Add it in the app as:  connection "Raw TCP", address 127.0.0.1:9100.
 *   --fault, --delay and --silent-after make the head misbehave: see
 *   RAW_FAULTS below. Each saved job also gets a one-line summary in the
 *   console and, for every bitmap in it (ESC/POS GS v 0, TSPL BITMAP, ZPL
 *   ^GFA, CPCL CG), a .png preview next to the job file, so the printed
 *   result can be looked at without a printer.
 *
 * Usage:  node dev-printer/server.cjs [options]
 *   --raw            fake raw (JetDirect) head instead of the IPP printer
 *   --port <n>       listen port (default 6310 for IPP, 9100 for --raw)
 *   --lan            listen on the local network (same as --host 0.0.0.0) and
 *                    print the URL other devices should use
 *   --host <addr>    bind address (default 127.0.0.1)
 *   --name <text>    printer name (default "PrintNinja Dev Printer")
 *   --out <dir>      where jobs are saved (default ./output)
 *   --fault <kind>   simulate a broken printer: FAULTS (IPP) or RAW_FAULTS (--raw)
 *   --delay <ms>     wait this long before answering every request (IPP), or
 *                    every status query (--raw)
 *   --silent-after <n>  --raw only: answer the first n status queries, then
 *                    go silent, like a Zebra that stopped (needs no --fault)
 *   --mdns           advertise over Bonjour/mDNS (off by default so a dev
 *                    box does not show up as a printer for the whole LAN)
 */

const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const zlib = require("node:zlib");
const path = require("node:path");
const Printer = require("ipp-printer");

// Same numeric values the app's transport reads (RFC 8011 §5.4.11, §5.3.7).
const JOB_PROCESSING_STOPPED = 6;
const JOB_ABORTED = 8;

// --raw mode: the dialect status queries the app's precheck sends on its own
// connection, and the "healthy" answers a real head would give. The bytes
// mirror src-tauri/src/transport/status.rs (Dialect::query / answered and its
// tests), so the precheck behaves here as it would against real hardware.
const STATUS_QUERIES = [
  {
    name: "escpos",
    query: Buffer.from([0x10, 0x04, 0x01, 0x10, 0x04, 0x02, 0x10, 0x04, 0x03, 0x10, 0x04, 0x04]),
    // Four DLE EOT replies, none of whose fault bits are set (status.rs READY).
    answer: Buffer.from([0x12, 0x12, 0x12, 0x12]),
  },
  {
    name: "zpl",
    query: Buffer.from("~HS"),
    // Three STX-framed fields: status, media sensors, self-test (status.rs test).
    answer: Buffer.from("\x02030,0,0,1,2,3,4,5,6,7,8,9\x03\r\n\x02000,0\x03\r\n\x020000,0\x03\r\n"),
  },
  {
    name: "tspl",
    query: Buffer.from([0x1b, 0x21, 0x3f]),
    answer: Buffer.from([0x00]),
  },
];
// No status query is longer than this, and no print job starts with a query
// prefix, so the first 12 bytes of a connection decide what it is.
const QUERY_HEAD_BYTES = 12;

// --fault <kind>: what Get-Printer-Attributes reports as printer-state-reasons,
// and how a Print-Job is answered. These drive the error paths in
// src-tauri/src/transport/ipp.rs (describe_reason / parse_job_outcome).
const FAULTS = {
  "media-empty": { jobState: JOB_PROCESSING_STOPPED }, // "out of paper"
  "media-jam": { jobState: JOB_PROCESSING_STOPPED }, // "paper jam"
  paused: { jobState: JOB_PROCESSING_STOPPED }, // "it is paused"
  "offline-report": { jobState: JOB_PROCESSING_STOPPED }, // "it is offline"
  "toner-empty": { jobState: JOB_PROCESSING_STOPPED }, // "out of toner"
  aborted: { jobState: JOB_ABORTED, reason: "none" }, // job-state 8, no reason
};

// --raw --fault <kind>: what the fake head answers to status queries. These
// bytes are the inverse of the decoders in src-tauri/src/transport/status.rs
// (escpos / zpl / tspl), so each kind trips the matching "did not print"
// message. SILENT = send no reply at all: a real Zebra does that when the
// media or ribbon is out or the head is open, and the app reads silence after
// an earlier answer as a stopped printer. A language missing from an entry
// cannot express that fault, so the head answers healthy for it and says so.
const SILENT = Symbol("silent");
const zplStatus = (paperOut, paused) =>
  Buffer.from(
    `\x02030,${paperOut},${paused},1,2,3,4,5,6,7,8,9\x03\r\n\x02000,0\x03\r\n\x020000,0\x03\r\n`,
  );
const RAW_FAULTS = {
  // DLE EOT 4 = 0x72 (paper end), DLE EOT 2 = 0x32 (paper end).
  "paper-out": {
    escpos: Buffer.from([0x12, 0x32, 0x12, 0x72]),
    zpl: zplStatus(1, 0),
    tspl: Buffer.from([0x04]),
  },
  "cover-open": {
    escpos: Buffer.from([0x12, 0x16, 0x12, 0x12]), // DLE EOT 2 bit 2
    zpl: SILENT,
    tspl: Buffer.from([0x40]),
  },
  "head-open": {
    escpos: Buffer.from([0x12, 0x16, 0x12, 0x12]),
    zpl: SILENT,
    tspl: Buffer.from([0x01]),
  },
  offline: {
    escpos: Buffer.from([0x1a, 0x12, 0x12, 0x12]), // DLE EOT 1 bit 3
    zpl: SILENT,
    tspl: Buffer.from([0x80]), // TSPL has no offline bit: generic error
  },
  "cutter-jam": {
    escpos: Buffer.from([0x12, 0x12, 0x1a, 0x12]), // DLE EOT 3 bit 3
    zpl: SILENT,
    tspl: Buffer.from([0x02]),
  },
  error: {
    escpos: Buffer.from([0x12, 0x52, 0x12, 0x12]), // DLE EOT 2 bit 6
    zpl: SILENT,
    tspl: Buffer.from([0x80]),
  },
  paused: {
    escpos: Buffer.from([0x1a, 0x12, 0x12, 0x12]), // no pause bit: offline
    zpl: zplStatus(0, 1),
    tspl: Buffer.from([0x10]),
  },
  "ribbon-out": {
    zpl: SILENT,
    tspl: Buffer.from([0x08]), // ESC/POS has no ribbon
  },
  silent: { escpos: SILENT, zpl: SILENT, tspl: SILENT },
};

const USAGE = `Usage: node dev-printer/server.cjs [options]

  --raw            fake raw (JetDirect-style) thermal head instead of the
                   IPP printer (PLAN §4, D4.4 tier-1 QA)
  --port <n>       listen port (default 6310 for IPP, 9100 for --raw)
  --lan            listen on the local network and print its URLs
  --host <addr>    bind address (default 127.0.0.1; --lan = 0.0.0.0)
  --name <text>    printer name (default "PrintNinja Dev Printer")
  --out <dir>      where jobs are saved (default ./output)
  --fault <kind>   IPP:  ${Object.keys(FAULTS).join(" | ")}
                   --raw: ${Object.keys(RAW_FAULTS).join(" | ")}
  --delay <ms>     wait this long before answering every request
                   (use more than 30000 to hit the app's response timeout);
                   with --raw, delays every status-query reply
  --silent-after <n>  --raw only: answer the first n status queries, then
                   stop answering (a Zebra that has stopped)
  --mdns           advertise over Bonjour/mDNS (off by default, IPP mode)`;

function parseArgs(argv) {
  const opts = {
    port: 6310, // --raw without an explicit --port switches to 9100 below
    portGiven: false,
    host: "127.0.0.1",
    name: "PrintNinja Dev Printer",
    out: path.join(__dirname, "output"),
    fault: null,
    delay: 0,
    silentAfter: null,
    mdns: false,
    raw: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) fail(`${arg} needs a value`);
      return argv[++i];
    };
    switch (arg) {
      case "--port":
        opts.port = Number(value());
        opts.portGiven = true;
        if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535)
          fail("--port must be 0-65535");
        break;
      case "--host":
        opts.host = value();
        break;
      case "--lan":
        opts.host = "0.0.0.0";
        break;
      case "--name":
        opts.name = value();
        break;
      case "--out":
        opts.out = path.resolve(value());
        break;
      case "--fault":
        opts.fault = value(); // checked after the loop: --raw changes the list
        break;
      case "--delay":
        opts.delay = Number(value());
        if (!Number.isFinite(opts.delay) || opts.delay < 0)
          fail("--delay must be a number of milliseconds");
        break;
      case "--silent-after":
        opts.silentAfter = Number(value());
        if (!Number.isInteger(opts.silentAfter) || opts.silentAfter < 0)
          fail("--silent-after must be a whole number of status queries");
        break;
      case "--mdns":
        opts.mdns = true;
        break;
      case "--raw":
        opts.raw = true;
        break;
      case "-h":
      case "--help":
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        fail(`unknown option ${arg}`);
    }
  }
  if (opts.raw) {
    if (!opts.portGiven) opts.port = 9100;
    if (opts.mdns) fail("--mdns is not supported with --raw (a raw head has no mDNS)");
    if (opts.fault && !(opts.fault in RAW_FAULTS))
      fail(`--fault with --raw must be one of: ${Object.keys(RAW_FAULTS).join(", ")}`);
  } else {
    if (opts.fault && !(opts.fault in FAULTS))
      fail(`--fault must be one of: ${Object.keys(FAULTS).join(", ")}`);
    if (opts.silentAfter !== null) fail("--silent-after only works with --raw");
  }
  return opts;
}

function fail(message) {
  console.error(`dev-printer: ${message}`);
  process.exit(2);
}

/** This machine's non-loopback IPv4 addresses, for same-network URLs. */
function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      // Node < 18.4 reports family as the number 4
      if ((a.family === "IPv4" || a.family === 4) && !a.internal)
        out.push({ name, address: a.address });
    }
  }
  return out;
}

/** Pick a file extension from the first bytes of a saved job. */
function sniffExtension(file) {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(8);
    const n = fs.readSync(fd, head, 0, 8, 0);
    const text = head.subarray(0, n).toString("latin1");
    if (text.startsWith("%PDF-")) return ".pdf";
    if (text.startsWith("%!")) return ".ps";
    if (text.startsWith("\x89PNG")) return ".png";
    if (text.startsWith("\xff\xd8")) return ".jpg";
    return ".bin";
  } finally {
    fs.closeSync(fd);
  }
}

/** Pick a file extension from the first bytes of a raw job. */
function sniffFraming(buf) {
  if (buf.length >= 3 && buf.toString("latin1", 0, 3) === "^XA") return "zpl";
  // ESC/POS: init (ESC @) or GS v 0 raster mode.
  if (buf.length >= 2 && buf[0] === 0x1b && buf[1] === 0x40) return "escpos";
  if (buf.length >= 4 && buf[0] === 0x1d && buf[1] === 0x76 && buf[2] === 0x30 && buf[3] === 0x00)
    return "escpos";
  // TSPL jobs open with `SIZE w,h`; the app writes `SIZE 40 mm,30 mm`.
  if (/^SIZE\s+\d+(\.\d+)?\s*(mm|inch|")?\s*,/.test(buf.toString("latin1", 0, Math.min(buf.length, 32))))
    return "tspl";
  // CPCL jobs open with `! offset hres vres height qty`.
  if (/^! \d+ \d+ \d+ \d+ \d+/.test(buf.toString("latin1", 0, Math.min(buf.length, 32)))) return "cpcl";
  return "bin";
}

/**
 * Find the bitmaps in a raw job, the way the app's encoders write them
 * (src-tauri/src/transport/escpos.rs and label_langs.rs). Each is
 * `{ widthBytes, height, data }` with 1 = black, 8 pixels per byte, MSB
 * first, the packing of `RasterImage`. Also counts ESC/POS cuts.
 *
 * Handles: ESC/POS `GS v 0`, TSPL `BITMAP`, ZPL `^GFA` with plain hex data,
 * CPCL `CG`. Compressed ZPL graphics (`^GFA` with `:Z64:` data) are skipped.
 */
function extractBitmaps(lang, buf) {
  const out = [];
  let cuts = 0;
  const src = buf.toString("latin1"); // 1 char = 1 byte, so offsets line up
  const push = (widthBytes, height, data) => {
    if (widthBytes > 0 && height > 0 && data.length >= widthBytes * height)
      out.push({ widthBytes, height, data: data.subarray(0, widthBytes * height) });
  };
  if (lang === "escpos") {
    for (let i = 0; i < buf.length; ) {
      if (buf[i] === 0x1b) {
        i += buf[i + 1] === 0x40 ? 2 : 3; // ESC @ has no parameter; most others have one
      } else if (buf[i] === 0x1d) {
        if (buf[i + 1] === 0x76 && buf[i + 2] === 0x30) {
          // GS v 0 m xL xH yL yH <data>
          const w = buf[i + 4] + buf[i + 5] * 256;
          const h = buf[i + 6] + buf[i + 7] * 256;
          push(w, h, buf.subarray(i + 8, i + 8 + w * h));
          i += 8 + w * h;
        } else if (buf[i + 1] === 0x56) {
          cuts += 1;
          i += buf[i + 2] === 0x41 || buf[i + 2] === 0x42 ? 4 : 3;
        } else {
          i += 3;
        }
      } else {
        i += 1;
      }
    }
  } else if (lang === "tspl") {
    for (const m of src.matchAll(/BITMAP\s+\d+,\d+,(\d+),(\d+),\d+,/g)) {
      const start = m.index + m[0].length;
      push(Number(m[1]), Number(m[2]), buf.subarray(start, start + Number(m[1]) * Number(m[2])));
    }
  } else if (lang === "zpl") {
    for (const m of src.matchAll(/\^GFA,(\d+),(\d+),(\d+),([0-9A-Fa-f]+)/g)) {
      if (m[4].length === Number(m[2]) * 2)
        push(Number(m[3]), Number(m[2]) / Number(m[3]), Buffer.from(m[4], "hex"));
    }
  } else if (lang === "cpcl") {
    for (const m of src.matchAll(/CG\s+\d+\s+(\d+)\s+\d+\s+\d+\r?\n((?:[0-9A-Fa-f]+\r?\n)+)/g)) {
      const rows = m[2].trim().split(/\r?\n/);
      push(Number(m[1]), rows.length, Buffer.from(rows.join(""), "hex"));
    }
  }
  return { bitmaps: out, cuts };
}

/** A 1-bit grayscale PNG of a bitmap (black dots on white), no dependencies. */
function bitmapToPng({ widthBytes, height, data }) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (b) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), body])));
    return Buffer.concat([len, Buffer.from(type), body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(widthBytes * 8, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 1; // bit depth
  ihdr[9] = 0; // grayscale
  const raw = Buffer.alloc((widthBytes + 1) * height); // each row starts with filter 0
  for (let y = 0; y < height; y++)
    for (let x = 0; x < widthBytes; x++) raw[y * (widthBytes + 1) + 1 + x] = ~data[y * widthBytes + x] & 0xff;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * A short, approximate description of a raw job, so a saved print can be
 * eyeballed without a printer. Not a renderer: it lists the text it can find
 * and counts bitmaps and cuts (the bitmaps themselves are written as PNGs).
 */
function summarize(lang, buf, found) {
  const clip = (t) => (t.length > 120 ? `${t.slice(0, 117)}...` : t);
  const src = buf.toString("latin1");
  const bitmaps = `${found.bitmaps.length} bitmap(s)`;
  if (lang === "zpl") {
    const labels = (src.match(/\^XA/g) || []).length;
    const text = [...src.matchAll(/\^FD([\s\S]*?)\^FS/g)].map((m) => m[1]);
    return `${labels} label(s), ${bitmaps}, fields: ${clip(text.join(" | ")) || "none"}`;
  }
  if (lang === "tspl") {
    const text = [...src.matchAll(/^TEXT\s+[^"\r\n]*"([^"]*)"/gm)].map((m) => m[1]);
    const print = src.match(/^PRINT\s+(\d+)/m);
    return `print ${print ? print[1] : "?"}, ${bitmaps}, text: ${clip(text.join(" | ")) || "none"}`;
  }
  if (lang === "cpcl") return `${bitmaps}, print ${/^PRINT/m.test(src) ? "sent" : "missing"}`;
  if (lang === "escpos") {
    // Text is whatever printable bytes sit outside commands and bitmap data.
    let text = "";
    for (let i = 0; i < buf.length; ) {
      const b = buf[i];
      if (b === 0x1b) i += buf[i + 1] === 0x40 ? 2 : 3;
      else if (b === 0x1d && buf[i + 1] === 0x76 && buf[i + 2] === 0x30)
        i += 8 + (buf[i + 4] + buf[i + 5] * 256) * (buf[i + 6] + buf[i + 7] * 256);
      else if (b === 0x1d) i += buf[i + 1] === 0x56 && (buf[i + 2] === 0x41 || buf[i + 2] === 0x42) ? 4 : 3;
      else {
        if (b === 0x0a) text += " / ";
        else if (b >= 0x20 && b < 0x7f) text += String.fromCharCode(b);
        i += 1;
      }
    }
    return `${bitmaps}, ${found.cuts} cut(s), text: ${clip(text.replace(/( \/ )+/g, " / ").trim()) || "none"}`;
  }
  return "unrecognised framing";
}

/**
 * --raw mode: a fake JetDirect-style thermal head (PLAN §4, D4.4 tier-1
 * QA). The app's transport (raw_tcp) connects, writes, and closes; each
 * connection is either a status query (answered "healthy"), the two-byte
 * connectivity test (ESC @), or a job (saved to opts.out).
 */
function startRaw(opts) {
  let jobs = 0;
  let queries = 0; // status connections answered or deliberately ignored
  const fault = opts.fault ? RAW_FAULTS[opts.fault] : null;

  /** The reply to a status query, or null to stay silent. */
  const reply = (match) => {
    queries += 1;
    if (opts.silentAfter !== null && queries > opts.silentAfter) {
      console.log(`[status] ${match.name} query #${queries}: silent (--silent-after ${opts.silentAfter})`);
      return null;
    }
    if (!fault) return match.answer;
    const entry = fault[match.name];
    if (entry === SILENT) {
      console.log(`[status] ${match.name} query #${queries}: silent (fault "${opts.fault}")`);
      return null;
    }
    if (!entry) {
      console.log(
        `[status] ${match.name} query #${queries}: fault "${opts.fault}" has no ${match.name} form, answering healthy`,
      );
      return match.answer;
    }
    console.log(`[status] ${match.name} query #${queries}: fault "${opts.fault}"`);
    return entry;
  };

  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    let status = null;
    let decidedJob = false;
    socket.on("data", (chunk) => {
      if (status) return; // status connection: drop everything after the answer
      if (decidedJob) {
        buf = Buffer.concat([buf, chunk]);
        return;
      }
      buf = Buffer.concat([buf, chunk]);
      const match = STATUS_QUERIES.find(
        (q) => buf.length >= q.query.length && buf.subarray(0, q.query.length).equals(q.query),
      );
      if (match) {
        status = match;
        const answer = reply(match);
        if (answer) {
          const send = () => {
            if (!socket.destroyed) socket.write(answer);
          };
          if (opts.delay > 0) setTimeout(send, opts.delay);
          else send();
        }
        return;
      }
      if (buf.length >= QUERY_HEAD_BYTES) {
        decidedJob = true; // no query fits the first 12 bytes: it is a job
        console.log(`[job] connection from ${socket.remoteAddress}`);
      }
      // else: wait for more; a query arrives in at most 12 bytes
    });
    socket.on("end", () => {
      if (status) {
        socket.end();
        return;
      }
      const job = buf;
      if (job.length === 0) {
        socket.end();
        return;
      }
      if (job.length === 2 && job[0] === 0x1b && job[1] === 0x40) {
        // The app's "test connection" sends exactly ESC @ (raw_tcp `test()`):
        // report it, but it is not a job.
        console.log(`[status] connectivity test (ESC @) from ${socket.remoteAddress}`);
        socket.end();
        return;
      }
      jobs += 1;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const lang = sniffFraming(job);
      const file = path.join(opts.out, `job-${jobs}-${stamp}.${lang}`);
      fs.writeFileSync(file, job);
      console.log(
        `[job ${jobs}] ${lang}, ${job.length} bytes from ${socket.remoteAddress} -> ${path.relative(process.cwd(), file)}`,
      );
      const found = extractBitmaps(lang, job);
      console.log(`        ${summarize(lang, job, found)}`);
      found.bitmaps.forEach((bm, n) => {
        const png = file.replace(/\.[^.]+$/, found.bitmaps.length > 1 ? `-${n + 1}.png` : ".png");
        fs.writeFileSync(png, bitmapToPng(bm));
        console.log(`        preview: ${path.relative(process.cwd(), png)} (${bm.widthBytes * 8}x${bm.height})`);
      });
      socket.end();
    });
    socket.on("error", () => {
      // A dropped dev connection (client timeout) is not a fault to report.
    });
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") fail(`port ${opts.port} is already in use (try --port)`);
    if (err.code === "EACCES")
      fail(`no permission to bind port ${opts.port} (ports below 1024 need root)`);
    throw err;
  });

  server.listen(opts.port, opts.host, () => {
    const { port } = server.address();
    console.log(`${opts.name} (raw head) listening on ${opts.host}:${port}`);
    if (opts.host === "0.0.0.0") {
      const lan = lanAddresses();
      if (lan.length === 0) console.log("  same network:       no network address found");
      for (const { name, address } of lan)
        console.log(`  add in PrintNinja:  Raw TCP ${address}:${port}   (${name})`);
    } else if (opts.host === "127.0.0.1") {
      console.log(`  add in PrintNinja:  Raw TCP localhost:${port}`);
      console.log("  same network:       off (localhost only), restart with --lan");
    } else {
      console.log(`  add in PrintNinja:  Raw TCP ${opts.host}:${port}`);
    }
    console.log(`  jobs saved to:      ${opts.out}`);
    if (opts.fault) console.log(`  fault mode:         ${opts.fault}`);
    if (opts.delay) console.log(`  status reply delay: ${opts.delay} ms`);
    if (opts.silentAfter !== null) console.log(`  silent after:       ${opts.silentAfter} status queries`);
  });

  const shutdown = () => {
    console.log("\nshutting down");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  fs.mkdirSync(opts.out, { recursive: true });

  if (opts.raw) {
    startRaw(opts);
    return;
  }

  const fault = opts.fault ? FAULTS[opts.fault] : null;

  // Own the HTTP server so we control the bind address; ipp-printer would
  // otherwise listen on every interface. It answers on any URL path, so
  // /ipp/print (the app's default) works.
  const server = http.createServer();

  // The printer-uri-supported attribute should name an address clients can
  // actually reach, so use the first LAN address when listening on all of them.
  const lan = lanAddresses();
  const lanMode = opts.host === "0.0.0.0";
  const uriHost =
    lanMode && lan.length ? lan[0].address : opts.host === "127.0.0.1" || lanMode ? "localhost" : opts.host;

  // --delay: hold every reply, like a printer that accepts the connection and
  // then goes quiet. Registered before ipp-printer's own listener so it can
  // wrap the response first.
  if (opts.delay > 0) {
    server.on("request", (req, res) => {
      const writeHead = res.writeHead;
      const end = res.end;
      const queued = [];
      res.writeHead = (...args) => {
        queued.push(() => writeHead.apply(res, args));
        return res;
      };
      res.end = (...args) => {
        queued.push(() => end.apply(res, args));
        setTimeout(() => queued.forEach((fn) => fn()), opts.delay);
        return res;
      };
    });
  }

  const printer = new Printer({
    name: opts.name,
    server,
    uri: `ipp://${uriHost}:${opts.port}/ipp/print`,
    zeroconf: opts.mdns,
  });

  // Second fake advertisement for peer discovery: _printninja._tcp so CI
  // can test browse_peers without real hardware. Uses the same bonjour
  // stack as ipp-printer's zeroconf.
  let printNinjaService = null;
  let bonjourInstance = null;
  if (opts.mdns) {
    try {
      const bonjour = require("bonjour")();
      bonjourInstance = bonjour;
      printNinjaService = bonjour.publish({
        name: "PrintNinja-Test-PC",
        type: "printninja",
        protocol: "tcp",
        port: 17717,
        txt: {
          prot: "1",
          id: "dev-provider-id",
          port: "17717",
          plat: "linux",
          ver: "2.5.0",
        },
      });
      console.log("  mDNS:               advertising _printninja._tcp (PrintNinja-Test-PC)");
    } catch (e) {
      console.warn("  mDNS:               _printninja._tcp advertise failed:", e.message);
    }
  }

  // Report the simulated fault from Get-Printer-Attributes.
  if (opts.fault) {
    const reason = fault.reason ?? opts.fault;
    const base = printer.attributes.bind(printer);
    printer.attributes = (filter) =>
      base(filter).map((attr) => {
        if (attr.name === "printer-state-reasons")
          return { ...attr, value: reason };
        return attr;
      });
  }

  printer.on("job", (job) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const tmp = path.join(opts.out, `job-${job.id}-${stamp}.part`);
    console.log(
      `[job ${job.id}] received "${job.name ?? ""}" from ${job.userName ?? "?"}`,
    );

    if (fault) {
      // Answer with a stopped/aborted job state and discard the document.
      // The body still has to be read, or the request never ends and the
      // reply (which is sent on request end) is never written.
      job.process = function () {
        this.state = fault.jobState;
        this._req.resume();
      };
      console.log(`[job ${job.id}] fault "${opts.fault}": not printed`);
      return;
    }

    const sink = fs.createWriteStream(tmp);
    job.pipe(sink);
    sink.on("finish", () => {
      const final = tmp.replace(/\.part$/, sniffExtension(tmp));
      fs.renameSync(tmp, final);
      const size = fs.statSync(final).size;
      console.log(`[job ${job.id}] saved ${path.relative(process.cwd(), final)} (${size} bytes)`);
    });
    job.on("error", (err) => console.error(`[job ${job.id}] error: ${err.message}`));
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") fail(`port ${opts.port} is already in use (try --port)`);
    if (err.code === "EACCES") fail(`no permission to bind port ${opts.port} (ports below 1024 need root)`);
    throw err;
  });

  server.listen(opts.port, opts.host, () => {
    const { port } = server.address();
    console.log(`${opts.name} listening on ${opts.host}:${port}`);
    if (lanMode) {
      console.log(`  this machine:       ipp://localhost:${port}/ipp/print`);
      if (lan.length === 0) console.log("  same network:       no network address found");
      for (const { name, address } of lan)
        console.log(`  same network:       ipp://${address}:${port}/ipp/print   (${name})`);
    } else if (opts.host === "127.0.0.1") {
      console.log(`  add in PrintNinja:  ipp://localhost:${port}/ipp/print`);
      console.log("  same network:       off (localhost only), restart with --lan");
    } else {
      console.log(`  add in PrintNinja:  ipp://${opts.host}:${port}/ipp/print`);
    }
    console.log(`  jobs saved to:      ${opts.out}`);
    if (opts.fault) console.log(`  fault mode:         ${opts.fault}`);
    if (opts.delay) console.log(`  reply delay:        ${opts.delay} ms`);
    if (opts.mdns) console.log("  mDNS:               advertising _ipp._tcp");
    if (lanMode) {
      console.log("  WARNING: reachable by anyone on your network; ipp-printer has no auth.");
      if (process.platform === "win32")
        console.log("  Windows: if devices cannot connect, allow Node.js through Windows Firewall (Private networks).");
    }
  });

  const shutdown = () => {
    console.log("\nshutting down");
    if (printNinjaService) try { printNinjaService.stop(() => {}); } catch {}
    if (bonjourInstance) try { bonjourInstance.destroy(); } catch {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
