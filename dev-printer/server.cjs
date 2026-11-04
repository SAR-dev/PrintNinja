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
 *   .zpl, .tspl, .bin), and status queries are answered "healthy" so the
 *   app's precheck behaves like it would against a real head.
 *   Add it in the app as:  connection "Raw TCP", address 127.0.0.1:9100.
 *
 * Usage:  node dev-printer/server.cjs [options]
 *   --raw            fake raw (JetDirect) head instead of the IPP printer
 *   --port <n>       listen port (default 6310 for IPP, 9100 for --raw)
 *   --lan            listen on the local network (same as --host 0.0.0.0) and
 *                    print the URL other devices should use
 *   --host <addr>    bind address (default 127.0.0.1)
 *   --name <text>    printer name (default "PrintNinja Dev Printer")
 *   --out <dir>      where jobs are saved (default ./output)
 *   --fault <kind>   simulate a broken printer, see FAULTS below (IPP mode)
 *   --delay <ms>     wait this long before answering every request (IPP mode)
 *   --mdns           advertise over Bonjour/mDNS (off by default so a dev
 *                    box does not show up as a printer for the whole LAN)
 */

const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
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

const USAGE = `Usage: node dev-printer/server.cjs [options]

  --raw            fake raw (JetDirect-style) thermal head instead of the
                   IPP printer (PLAN §4, D4.4 tier-1 QA)
  --port <n>       listen port (default 6310 for IPP, 9100 for --raw)
  --lan            listen on the local network and print its URLs
  --host <addr>    bind address (default 127.0.0.1; --lan = 0.0.0.0)
  --name <text>    printer name (default "PrintNinja Dev Printer")
  --out <dir>      where jobs are saved (default ./output)
  --fault <kind>   ${Object.keys(FAULTS).join(" | ")}   (IPP mode)
  --delay <ms>     wait this long before answering every request
                   (use more than 30000 to hit the app's response timeout)
                   (IPP mode)
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
        opts.fault = value();
        if (!(opts.fault in FAULTS))
          fail(`--fault must be one of: ${Object.keys(FAULTS).join(", ")}`);
        break;
      case "--delay":
        opts.delay = Number(value());
        if (!Number.isFinite(opts.delay) || opts.delay < 0)
          fail("--delay must be a number of milliseconds");
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
    if (opts.fault)
      fail("--fault is not supported with --raw (status queries always answer healthy)");
    if (opts.delay) fail("--delay is not supported with --raw");
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
  // TSPL jobs open with `SIZE w,h`.
  if (/^SIZE \d+,\d+/.test(buf.toString("latin1", 0, Math.min(buf.length, 16)))) return "tspl";
  return "bin";
}

/**
 * --raw mode: a fake JetDirect-style thermal head (PLAN §4, D4.4 tier-1
 * QA). The app's transport (raw_tcp) connects, writes, and closes; each
 * connection is either a status query (answered "healthy"), the two-byte
 * connectivity test (ESC @), or a job (saved to opts.out).
 */
function startRaw(opts) {
  let jobs = 0;
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
        console.log(`[status] ${match.name} query answered healthy from ${socket.remoteAddress}`);
        socket.write(match.answer);
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
