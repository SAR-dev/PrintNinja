#!/usr/bin/env node
"use strict";

/**
 * Smoke test for `server.cjs --raw`: does what PrintNinja's raw_tcp transport
 * does, without the app.
 *
 *   node dev-printer/smoke-raw.cjs [host:port]     default 127.0.0.1:9100
 *
 * 1. For each language with a status query (escpos, zpl, tspl) it sends the
 *    query from src-tauri/src/transport/status.rs and judges the reply the
 *    way `decode` does (healthy / fault / silent).
 * 2. For each language (escpos, zpl, tspl, cpcl) it sends one job with text
 *    and a bitmap, encoded like the app's encoders. The server saves each
 *    and writes a .png preview of the bitmap.
 * Run it against `--fault <kind>` and `--silent-after <n>` to see each
 * fault. Exit code 0 when every connection worked; a fault is a finding to
 * read, not a failure.
 */

const net = require("node:net");

const target = process.argv[2] || "127.0.0.1:9100";
const idx = target.lastIndexOf(":");
const host = target.slice(0, idx) || "127.0.0.1";
const port = Number(target.slice(idx + 1)) || 9100;
const REPLY_WAIT_MS = 1500;

// Same bytes as Dialect::query and Dialect::answered.
const DIALECTS = {
  escpos: {
    query: Buffer.from([0x10, 0x04, 1, 0x10, 0x04, 2, 0x10, 0x04, 3, 0x10, 0x04, 4]),
    answered: (r) => r.length >= 4,
    decode(r) {
      const bits = [0x08, 0x64, 0x68, 0x60];
      const found = [];
      r.subarray(0, 4).forEach((b, i) => {
        if ((b & 0x12) !== 0x12 || (b & 0x81) !== 0 || !(b & bits[i])) return;
        if (i === 0) found.push("offline");
        if (i === 1 && b & 0x04) found.push("cover open");
        if (i === 1 && b & 0x20) found.push("out of paper");
        if (i === 1 && b & 0x40) found.push("error");
        if (i === 2 && b & 0x08) found.push("cutter jam");
        if (i === 2 && b & 0x60) found.push("error");
        if (i === 3) found.push("out of paper");
      });
      return [...new Set(found)];
    },
  },
  zpl: {
    query: Buffer.from("~HS"),
    answered: (r) => r.filter((b) => b === 0x02).length >= 3,
    decode(r) {
      const s = r.indexOf(0x02) + 1;
      const e = r.indexOf(0x03, s);
      if (s === 0 || e < 0) return [];
      const f = r.subarray(s, e).toString().split(",");
      const found = [];
      if (f[1]?.trim() === "1") found.push("out of paper");
      if (f[2]?.trim() === "1") found.push("paused");
      return found;
    },
  },
  tspl: {
    query: Buffer.from([0x1b, 0x21, 0x3f]),
    answered: (r) => r.length > 0,
    decode(r) {
      if (r.length !== 1) return [];
      const b = r[0];
      const names = [
        [0x01, "head open"],
        [0x02, "paper jam"],
        [0x04, "out of paper"],
        [0x08, "out of ribbon"],
        [0x10, "paused"],
        [0x40, "cover open"],
        [0x80, "error"],
      ];
      return names.filter(([bit]) => b & bit).map(([, n]) => n);
    },
  },
};

// A 64x24 test bitmap (box and diagonal, 1 = black, 8 pixels per byte), packed
// like the app's RasterImage, so the server can write a PNG preview of it.
const W_BYTES = 8;
const H = 24;
const dots = Buffer.alloc(W_BYTES * H);
for (let y = 0; y < H; y++)
  for (let x = 0; x < W_BYTES * 8; x++) {
    const edge = x === 0 || y === 0 || x === W_BYTES * 8 - 1 || y === H - 1;
    if (edge || x === Math.floor((y * (W_BYTES * 8)) / H)) dots[y * W_BYTES + (x >> 3)] |= 0x80 >> (x & 7);
  }
const hex = (b) => b.toString("hex").toUpperCase();

// The same shapes the app's encoders write (escpos.rs, label_langs.rs).
const JOBS = {
  escpos: Buffer.concat([
    Buffer.from([0x1b, 0x40]),
    Buffer.from("PrintNinja ESC/POS smoke\n"),
    Buffer.from([0x1d, 0x76, 0x30, 0x00, W_BYTES, 0, H, 0]),
    dots,
    Buffer.from([0x1b, 0x64, 3, 0x1d, 0x56, 0x00]),
  ]),
  zpl: Buffer.from(
    `^XA\n^MMT\n^PR6\n^FO0,0^GFA,${dots.length},${dots.length},${W_BYTES},${hex(dots)}^FS\n^FO0,40^FDPrintNinja ZPL smoke^FS\n^XZ\n`,
  ),
  tspl: Buffer.concat([
    Buffer.from(
      `SIZE 40 mm,30 mm\r\nGAP 2 mm,0 mm\r\nDIRECTION 1\r\nREFERENCE 0,0\r\nCLS\r\nBITMAP 0,0,${W_BYTES},${H},0,`,
    ),
    dots,
    Buffer.from("\r\nPRINT 1\r\n"),
  ]),
  cpcl: Buffer.from(
    `! 0 200 200 ${H} 1\r\nCG ${W_BYTES * 8} ${W_BYTES} 0 0\r\n${[...Array(H).keys()]
      .map((y) => hex(dots.subarray(y * W_BYTES, (y + 1) * W_BYTES)))
      .join("\r\n")}\r\nPRINT\r\n`,
  ),
};

/** One short-lived connection: write `data`, optionally read a reply. */
function talk(data, dialect) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    let reply = Buffer.alloc(0);
    let timer = null;
    const done = (value) => {
      clearTimeout(timer);
      sock.destroy();
      resolve(value);
    };
    sock.on("error", reject);
    sock.on("connect", () => {
      sock.write(data);
      if (!dialect) {
        sock.end(); // a job: write and close, like raw_tcp send_raw
        sock.on("close", () => done(null));
        return;
      }
      timer = setTimeout(() => done(reply.length ? reply : null), REPLY_WAIT_MS);
    });
    sock.on("data", (c) => {
      reply = Buffer.concat([reply, c]);
      if (dialect?.answered(reply)) done(reply);
    });
  });
}

async function main() {
  let failed = false;
  for (const [name, d] of Object.entries(DIALECTS)) {
    try {
      const reply = await talk(d.query, d);
      if (!reply) {
        console.log(`${name.padEnd(6)} status: SILENT after ${REPLY_WAIT_MS} ms`);
      } else {
        const found = d.decode(reply);
        console.log(
          `${name.padEnd(6)} status: ${found.length ? `FAULT ${found.join(" and ")}` : "healthy"}  [${reply.toString("hex")}]`,
        );
      }
    } catch (err) {
      failed = true;
      console.error(`${name.padEnd(6)} FAILED: ${err.message}`);
    }
  }
  // CPCL has no status query, so it is job-only.
  for (const [name, job] of Object.entries(JOBS)) {
    try {
      await talk(job, null);
      console.log(`${name.padEnd(6)} job:    sent ${job.length} bytes`);
    } catch (err) {
      failed = true;
      console.error(`${name.padEnd(6)} job FAILED: ${err.message}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

main();
