#!/usr/bin/env node
"use strict";

/**
 * Smoke test: sends the same bytes PrintNinja's IppPrinter sends
 * (build_ipp_request / build_get_printer_attributes in
 * src-tauri/src/transport/ipp.rs) and judges the reply the way
 * parse_status_code / parse_job_outcome do.
 *
 *   node dev-printer/smoke.cjs [url]        default http://127.0.0.1:6310/ipp/print
 *
 * Exit code 0 when the server accepts the job (job-state 3/4/5/9).
 */

const http = require("node:http");

const url = new URL(process.argv[2] || "http://127.0.0.1:6310/ipp/print");
const printerUri = `ipp://${url.host}${url.pathname}`;

function attr(tag, name, value) {
  const n = Buffer.from(name);
  const v = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const head = Buffer.alloc(3);
  head[0] = tag;
  head.writeUInt16BE(n.length, 1);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(v.length);
  return Buffer.concat([head, n, len, v]);
}

function printJob(pdf, copies) {
  const parts = [
    Buffer.from([0x01, 0x01, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01, 0x01]),
    attr(0x47, "attributes-charset", "utf-8"),
    attr(0x48, "attributes-natural-language", "en"),
    attr(0x45, "printer-uri", printerUri),
    attr(0x42, "requesting-user-name", "PrintNinja"),
    attr(0x42, "job-name", "PrintNinja Job"),
    attr(0x44, "document-format", "application/pdf"),
  ];
  if (copies > 1) {
    const c = Buffer.alloc(4);
    c.writeInt32BE(copies);
    parts.push(attr(0x21, "copies", c));
  }
  parts.push(attr(0x22, "ipp-attribute-fidelity", Buffer.from([0x00])));
  parts.push(Buffer.from([0x03]), pdf);
  return Buffer.concat(parts);
}

function getPrinterAttributes() {
  return Buffer.concat([
    Buffer.from([0x01, 0x01, 0x00, 0x0b, 0x00, 0x00, 0x00, 0x01, 0x01]),
    attr(0x47, "attributes-charset", "utf-8"),
    attr(0x48, "attributes-natural-language", "en"),
    attr(0x45, "printer-uri", printerUri),
    attr(0x44, "requested-attributes", "printer-state-reasons"),
    Buffer.from([0x03]),
  ]);
}

function post(body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: "POST", headers: { "Content-Type": "application/ipp" } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ http: res.statusCode, body: Buffer.concat(chunks) }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

// Same walk as parse_attributes in ipp.rs.
function parseAttributes(body) {
  const out = [];
  let last = "";
  let i = 8;
  while (i < body.length) {
    const tag = body[i];
    if (tag < 0x10) {
      if (tag === 0x03) break;
      i += 1;
      continue;
    }
    const nameLen = body.readUInt16BE(i + 1);
    if (nameLen > 0) last = body.subarray(i + 3, i + 3 + nameLen).toString();
    const lenAt = i + 3 + nameLen;
    const valueLen = body.readUInt16BE(lenAt);
    out.push({ name: last, tag, value: body.subarray(lenAt + 2, lenAt + 2 + valueLen) });
    i = lenAt + 2 + valueLen;
  }
  return out;
}

(async () => {
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
  const res = await post(printJob(pdf, 2));
  const status = res.body.readUInt16BE(2);
  const attrs = parseAttributes(res.body);
  const jobState = attrs.find((a) => a.name === "job-state");
  const state = jobState ? jobState.value.readUInt32BE(0) : null;
  const accepted = status >> 8 === 0 && [null, 3, 4, 5, 9].includes(state);
  console.log(`Print-Job: http ${res.http}, ipp status 0x${status.toString(16).padStart(4, "0")}, job-state ${state}`);

  const diag = await post(getPrinterAttributes());
  const reasons = parseAttributes(diag.body)
    .filter((a) => a.name === "printer-state-reasons" && a.tag === 0x44)
    .map((a) => a.value.toString());
  console.log(`printer-state-reasons: ${reasons.join(", ") || "(none returned)"}`);

  console.log(accepted ? "RESULT: job accepted" : "RESULT: job NOT accepted (expected with --fault)");
  process.exit(accepted ? 0 : 1);
})().catch((err) => {
  console.error(`smoke: ${err.message}`);
  process.exit(2);
});
