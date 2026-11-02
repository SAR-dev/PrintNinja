#!/usr/bin/env node
// Captures the three README screenshots (assets/designer.png, print.png,
// history.png) from the web preview, with the fake agent seeded with one
// shipping-label template, two printers and a short print history.
//
// Usage: node scripts/capture-readme-screens.mjs [baseUrl]
// The web preview must be running (pnpm dev); it is started automatically
// when the base URL does not answer.

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
// esbuild and Playwright are e2e workspace deps (pnpm keeps them out of
// the root node_modules), so resolve them from e2e/package.json.
const requireFromE2e = createRequire(
  fileURLToPath(new URL("../e2e/package.json", import.meta.url)),
);
const esbuild = requireFromE2e("esbuild");
const { chromium } = requireFromE2e("@playwright/test");

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const base = (process.argv[2] ?? "http://localhost:1420").replace(/\/$/, "");
const assetsDir = join(root, "assets");

// ---------------------------------------------------------------- dev server

async function serverUp(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

let devProc = null;
if (!(await serverUp(base))) {
  console.log(`No server at ${base}; starting pnpm dev …`);
  // shell: true on Windows — pnpm is a .cmd shim Node cannot spawn bare.
  devProc = spawn("pnpm", ["dev"], { cwd: root, shell: true, stdio: "ignore" });
  // A cold vite start on a quiet machine takes well over a minute.
  for (let i = 0; i < 180 && !(await serverUp(base)); i++) {
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!(await serverUp(base))) {
    devProc.kill();
    console.error(`Could not reach ${base}. Run \`pnpm dev\` and retry.`);
    process.exit(1);
  }
}

// ------------------------------------------------------- fake agent + seed

// Same bundle the e2e stack builds (e2e/support/stack.ts); the gitignored
// output path is shared.
const agentBundle = join(root, "e2e", "support", "fake-agent.bundle.js");
await esbuild.build({
  entryPoints: [join(root, "e2e", "support", "fakeAgent", "index.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  outfile: agentBundle,
  logLevel: "silent",
});

// The bundled shipping-label pack: the script only needs its HTML and CSS —
// the canvas and preview both render it against the app's own sample data.
const tmp = await mkdtemp(join(tmpdir(), "pn-screens-"));
const templateJs = join(tmp, "shippingLabel.mjs");
try {
  const src = await readFile(
    join(root, "src", "lib", "templates", "packs", "shippingLabel.ts"),
    "utf8",
  );
  await writeFile(templateJs, (await esbuild.transform(src, { loader: "ts", format: "esm" })).code);
  const mod = await import(`file:///${templateJs.replaceAll("\\", "/")}`);
  const { SHIPPING_LABEL_HTML, SHIPPING_LABEL_CSS } = mod;

  const min = 60_000;
  const at = (agoMs) => new Date(Date.now() - agoMs).toISOString();
  const timings = (send) =>
    JSON.stringify({
      fetch_ms: 40,
      template_ms: 12,
      layout_ms: 30,
      render_ms: 900,
      send_ms: send,
      history_ms: 8,
      total_ms: 900 + send + 190,
    });

  const seed = {
    settings: {
      onboarding_done: "true",
      share_service_url: null,
      share_session_token: null,
    },
    templates: [
      {
        name: "Shipping Label",
        server_id: crypto.randomUUID(),
        html: SHIPPING_LABEL_HTML,
        css: SHIPPING_LABEL_CSS,
        page_w: 102,
        page_h: 152,
        sync_state: "synced",
        base_revision: 3,
        server_revision: 3,
      },
    ],
    printers: [
      {
        name: "Front Desk",
        address: "ipp://192.168.1.20:631/ipp/print",
        printer_type: "ipp",
        language: "pdf",
      },
      {
        name: "Thermal 80",
        address: "192.168.1.21:9100",
        printer_type: "tcp",
        language: "escpos",
      },
    ],
    // History, newest first. The failed job shows the real-reason column.
    jobs: [
      {
        id: 4,
        batch_id: null,
        record_index: null,
        template_id: 1,
        printer_id: 2,
        source: "ui",
        source_url: null,
        status: "failed",
        error: "Out of paper — the printer reports an open media sensor",
        copies: 1,
        settings_json: JSON.stringify({ orientation: "portrait", fit_mode: "fit" }),
        rendered_html: null,
        idempotency_key: null,
        is_test: false,
        started_at: at(3 * min),
        finished_at: at(2 * min),
        duration_ms: 5200,
        timings_json: timings(4000),
        requested_by_device_id: null,
        template_revision: 3,
        printed_by: null,
      },
      {
        id: 3,
        batch_id: null,
        record_index: null,
        template_id: 1,
        printer_id: 1,
        source: "api",
        source_url: null,
        status: "success",
        error: null,
        copies: 2,
        settings_json: JSON.stringify({ orientation: "portrait", fit_mode: "fit" }),
        rendered_html: null,
        idempotency_key: "order-1042",
        is_test: false,
        started_at: at(26 * min),
        finished_at: at(26 * min + 2400),
        duration_ms: 2400,
        timings_json: timings(1100),
        requested_by_device_id: null,
        template_revision: 3,
        printed_by: null,
      },
      {
        id: 2,
        batch_id: null,
        record_index: null,
        template_id: 1,
        printer_id: 1,
        source: "deeplink",
        source_url: "printninja://print?template=Shipping+Label",
        status: "success",
        error: null,
        copies: 1,
        settings_json: JSON.stringify({ orientation: "portrait", fit_mode: "fit" }),
        rendered_html: null,
        idempotency_key: null,
        is_test: false,
        started_at: at(61 * min),
        finished_at: at(61 * min + 2100),
        duration_ms: 2100,
        timings_json: timings(900),
        requested_by_device_id: null,
        template_revision: 3,
        printed_by: null,
      },
      {
        id: 1,
        batch_id: null,
        record_index: null,
        template_id: 1,
        printer_id: 1,
        source: "test",
        source_url: null,
        status: "success",
        error: null,
        copies: 1,
        settings_json: JSON.stringify({ orientation: "portrait", fit_mode: "fit" }),
        rendered_html: null,
        idempotency_key: null,
        is_test: true,
        started_at: at(3 * 60 * min),
        finished_at: at(3 * 60 * min + 1900),
        duration_ms: 1900,
        timings_json: timings(800),
        requested_by_device_id: null,
        template_revision: 2,
        printed_by: null,
      },
    ],
  };
  const encoded = Buffer.from(JSON.stringify(seed), "utf8").toString("base64");

  // ------------------------------------------------------------- captures

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  await context.addInitScript(() => {
    localStorage.setItem("printninja-onboarding-complete", "true");
    // Guest mode: the sign-in gate lets a signed-out guest straight through
    // (src/components/AuthGate.tsx), and every screen reads from the local
    // cache the fake agent serves, so no share server is needed.
    localStorage.setItem("printninja-guest-mode", "true");
  });
  // Raw base64, like e2e/support/fixtures.ts: the agent bundle decodes it
  // as UTF-8 (store.ts readSeedValue), which bare atob would mangle.
  await context.addInitScript({
    content: `localStorage.setItem('fake-agent:seed', '${encoded}')`,
  });
  await context.addInitScript({ path: agentBundle });
  const page = await context.newPage();
  await mkdir(assetsDir, { recursive: true });

  // Designer: the seeded label rendered on its live canvas.
  await page.goto(`${base}/template/1`, { waitUntil: "networkidle" });
  await page
    .locator('[data-testid="canvas-scroll"] iframe')
    .first()
    .waitFor({ timeout: 20_000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(assetsDir, "designer.png") });

  // Print: printer and template picked, preview rendered.
  await page.goto(`${base}/print`, { waitUntil: "networkidle" });
  await page.getByRole("combobox", { name: "Printer" }).click();
  await page.getByRole("option", { name: "Front Desk" }).click();
  await page.getByRole("combobox", { name: "Template" }).click();
  await page.getByRole("option", { name: "Shipping Label" }).click();
  await page
    .locator('iframe[title="Print preview"]')
    .first()
    .waitFor({ timeout: 20_000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(assetsDir, "print.png") });

  // History: a few jobs, one failed with its real reason. The desktop table
  // never shows the error inline, so open the failed job's details dialog —
  // it renders the reason in a danger alert. "Front Desk" first matches the
  // mobile-only card label (hidden at this width), so wait on the visible
  // occurrence instead.
  await page.goto(`${base}/history`, { waitUntil: "networkidle" });
  await page
    .getByText("Front Desk")
    .locator("visible=true")
    .first()
    .waitFor({ timeout: 20_000 });
  await page.getByRole("button", { name: "View job 4" }).click();
  await page
    .getByText("Out of paper")
    .locator("visible=true")
    .first()
    .waitFor({ timeout: 20_000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(assetsDir, "history.png") });

  await browser.close();
  console.log(`Wrote assets/designer.png, assets/print.png, assets/history.png`);
} finally {
  await rm(tmp, { recursive: true, force: true });
  if (devProc) {
    // taskkill /T takes the vite child with pnpm on Windows.
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(devProc.pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } else {
      devProc.kill();
    }
  }
}
