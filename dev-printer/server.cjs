#!/usr/bin/env node
"use strict";

/**
 * Local fake IPP printer for PrintNinja development, built on `ipp-printer`.
 *
 * Add it in the app as:  ipp://localhost:6310/ipp/print
 * Every job the app sends is written to ./output/ (PDFs get a .pdf name).
 *
 * Usage:  node dev-printer/server.cjs [options]
 *   --port <n>       listen port (default 6310; 631 needs root)
 *   --lan            listen on the local network (same as --host 0.0.0.0) and
 *                    print the URL other devices should use
 *   --host <addr>    bind address (default 127.0.0.1)
 *   --name <text>    printer name (default "PrintNinja Dev Printer")
 *   --out <dir>      where jobs are saved (default ./output)
 *   --fault <kind>   simulate a broken printer, see FAULTS below
 *   --delay <ms>     wait this long before answering every request
 *   --mdns           advertise over Bonjour/mDNS (off by default so a dev
 *                    box does not show up as a printer for the whole LAN)
 */

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const Printer = require("ipp-printer");

// Same numeric values the app's transport reads (RFC 8011 §5.4.11, §5.3.7).
const JOB_PROCESSING_STOPPED = 6;
const JOB_ABORTED = 8;

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

  --port <n>       listen port (default 6310; 631 needs root)
  --lan            listen on the local network and print its URLs
  --host <addr>    bind address (default 127.0.0.1; --lan = 0.0.0.0)
  --name <text>    printer name (default "PrintNinja Dev Printer")
  --out <dir>      where jobs are saved (default ./output)
  --fault <kind>   ${Object.keys(FAULTS).join(" | ")}
  --delay <ms>     wait this long before answering every request
                   (use more than 30000 to hit the app's response timeout)
  --mdns           advertise over Bonjour/mDNS (off by default)`;

function parseArgs(argv) {
  const opts = {
    port: 6310,
    host: "127.0.0.1",
    name: "PrintNinja Dev Printer",
    out: path.join(__dirname, "output"),
    fault: null,
    delay: 0,
    mdns: false,
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
      case "-h":
      case "--help":
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        fail(`unknown option ${arg}`);
    }
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

function main() {
  const opts = parseArgs(process.argv.slice(2));
  fs.mkdirSync(opts.out, { recursive: true });

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
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
