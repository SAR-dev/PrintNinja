#!/usr/bin/env node
/**
 * Screenshot every page across platforms, themes, densities and languages.
 *
 * No backend, database or Tauri shell is needed: the app runs in web mode on
 * the Vite dev server, and the e2e fake agent (e2e/support/fakeAgent) stands
 * in for the native side with seeded templates, printers and print history.
 *
 *   pnpm shots                                  # full matrix
 *   pnpm shots --platforms=windows,android-phone --themes=dark
 *   pnpm shots --routes=/print,/history --langs=en,ja
 *   pnpm shots --out=shots/before --full-page=false
 *
 * Flags (comma-separated lists; defaults in brackets):
 *   --platforms  windows, windows-narrow-900, windows-narrow-1024,
 *                android-phone, android-small, android-tablet          [all]
 *   --themes     light, dark                                   [light,dark]
 *   --densities  comfortable, compact                           [comfortable]
 *   --langs      en, ja                                         [en]
 *   --routes     override the route list                        [all pages]
 *   --out        output directory                               [screenshots]
 *   --base-url   use an already running app instead of starting Vite
 *   --full-page  capture the whole scroll height (true|false)   [true]
 *   --index      write <out>/index.html contact sheet (true|false) [true]
 *   --jobs       pages captured in parallel                        [4]
 *   --chromium   path to a Chromium binary (or env CHROMIUM_PATH). Used when
 *                Playwright's own matching browser is not installed.
 *
 * Output: <out>/<platform>/<lang>-<theme>-<density>/<page>.png
 * Needs Chromium: `pnpm --filter e2e exec playwright install chromium`
 * (or set PLAYWRIGHT_BROWSERS_PATH to an existing install).
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const e2eRequire = createRequire(join(root, "e2e", "package.json"));
const { chromium, devices } = e2eRequire("@playwright/test");
const { build } = e2eRequire("esbuild");

// ---------------------------------------------------------------- flags ----
const flags = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, ...v] = a.slice(2).split("=");
      return [k, v.length ? v.join("=") : "true"];
    }),
);
const list = (name, fallback) =>
  flags[name]
    ? flags[name]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : fallback;

const OUT = resolve(root, flags.out ?? "screenshots");
const FULL_PAGE = flags["full-page"] !== "false";
const WRITE_INDEX = flags.index !== "false";
const JOBS = Math.max(1, Number(flags.jobs ?? 4) || 4);
const PORT = 1420;
const BASE_URL = flags["base-url"] ?? `http://localhost:${PORT}`;

// ------------------------------------------------------------ platforms ----
// The app reads the user agent to tell Android from desktop (src/lib/platform
// .ts); the viewport and touch flags drive the phone layer in mobile.css.
const WIN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";

const PLATFORMS = {
  windows: {
    android: false,
    context: {
      viewport: { width: 1440, height: 900 },
      userAgent: WIN_UA,
    },
  },
  // The 768-1100px range (DESIGN_IMPROVEMENTS 4.1): the desktop layout is
  // still active here, but its tables and two-column pages need about 1100px.
  "windows-narrow-900": {
    android: false,
    context: {
      viewport: { width: 900, height: 700 },
      userAgent: WIN_UA,
    },
  },
  "windows-narrow-1024": {
    android: false,
    context: {
      viewport: { width: 1024, height: 768 },
      userAgent: WIN_UA,
    },
  },
  "android-phone": {
    android: true,
    context: { ...devices["Pixel 7"], userAgent: ANDROID_UA },
  },
  "android-small": {
    android: true,
    context: {
      viewport: { width: 360, height: 640 },
      userAgent: ANDROID_UA,
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    },
  },
  "android-tablet": {
    android: true,
    context: {
      viewport: { width: 800, height: 1280 },
      userAgent: ANDROID_UA,
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    },
  },
};

// --------------------------------------------------------------- routes ----
// "/" is the Designer; on a phone it is reached through /template/:id.
// `guest: false` keeps the sign-in gate in place (every other route skips it
// through guest mode so the screenshot shows the page itself).
const ROUTES = [
  { name: "signin", path: "/print", guest: false },
  { name: "print", path: "/print" },
  { name: "templates", path: "/templates" },
  { name: "designer", path: "/template/1" },
  { name: "printers", path: "/printers" },
  { name: "history", path: "/history" },
  { name: "automation", path: "/automation" },
  { name: "devices", path: "/devices" },
  { name: "settings", path: "/settings" },
  { name: "settings-profile", path: "/settings?section=profile" },
  { name: "api-explorer", path: "/api-explorer" },
];

// ------------------------------------------------------------ seed data ----
const PAIRED_PC_SETTINGS = {
  render_pairs: JSON.stringify([
    {
      id: "shots-seed-pc",
      name: "Front Desk PC",
      host: "192.168.1.50",
      port: 17717,
      secret: "seed-secret",
      fingerprint: "",
    },
  ]),
  render_policy: "auto",
};

const LABEL_CSS = ".label{font-family:sans-serif;padding:4mm}h1{margin:0;font-size:5mm}";
const TEMPLATES = [
  ["Shipping Label 100x150", "<div class='label'><h1>{{name}}</h1><p>{{address}}</p></div>"],
  ["Product Tag 50x30", "<div class='label'><h1>{{sku}}</h1><p>{{price}}</p></div>"],
  ["Receipt 58mm", "<div class='label'><h1>Receipt</h1><p>{{total}}</p></div>"],
  ["Shelf Label", "<div class='label'><h1>{{item}}</h1></div>"],
].map(([name, html], i) => ({
  name,
  html,
  css: LABEL_CSS,
  server_id: `00000000-0000-4000-8000-00000000000${i + 1}`,
  sync_state: i === 3 ? "dirty" : "synced",
  summary: `Sample ${name.toLowerCase()} used for screenshots.`,
}));

const PRINTERS = [
  { name: "Zebra ZD421", printer_type: "usb", language: "zpl", paper_width_mm: 100 },
  { name: "Brother QL-820NWB", printer_type: "network", address: "192.168.1.60:9100", language: "escpos", paper_width_mm: 62 },
  { name: "Office Laser (CUPS)", printer_type: "system" },
];

function seedJobs() {
  const statuses = ["success", "success", "failed", "success", "cancelled", "success"];
  return statuses.map((status, i) => {
    const at = new Date(Date.UTC(2026, 10, 17, 9, 0, 0) - i * 3_600_000).toISOString();
    return {
      id: i + 1,
      batch_id: null,
      record_index: null,
      template_id: (i % 3) + 1,
      printer_id: (i % 2) + 1,
      source: i % 3 === 0 ? "api" : "ui",
      source_url: null,
      status,
      error: status === "failed" ? "Printer offline: connection refused" : null,
      copies: (i % 3) + 1,
      settings_json: null,
      rendered_html: "<p>seed</p>",
      idempotency_key: null,
      is_test: i === 4,
      started_at: at,
      finished_at: at,
      duration_ms: 800 + i * 140,
      timings_json: null,
      requested_by_device_id: null,
      template_revision: 1,
      printed_by: null,
    };
  });
}

// ------------------------------------------------------------- dev server ----
async function isUp(url) {
  try {
    const res = await fetch(url);
    return res.ok;
  } catch {
    return false;
  }
}

async function startVite() {
  if (flags["base-url"]) return null;
  if (await isUp(BASE_URL)) {
    console.log(`Using the app already running at ${BASE_URL}`);
    return null;
  }
  console.log("Starting Vite…");
  // Launch vite's own entry via the running Node, not node_modules/.bin/vite:
  // that shim is a shell script and does not spawn on Windows.
  const vite = join(root, "node_modules", "vite", "bin", "vite.js");
  const child = spawn(
    process.execPath,
    [vite, "--port", String(PORT), "--strictPort"],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, BROWSER: "none" },
    },
  );
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Vite exited early:\n${log}`);
    if (await isUp(BASE_URL)) return child;
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error(`Vite did not start within 90s:\n${log}`);
}

// ---------------------------------------------------------------- browser ----
/** Playwright's own browser first; else any Chromium under the browsers dir. */
async function launchBrowser() {
  const explicit = flags.chromium ?? process.env.CHROMIUM_PATH;
  if (explicit) return chromium.launch({ executablePath: explicit });
  try {
    return await chromium.launch();
  } catch (err) {
    const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
    if (base && existsSync(base)) {
      for (const dir of readdirSync(base).filter((d) => d.startsWith("chromium-"))) {
        const exe = join(base, dir, "chrome-linux64", "chrome");
        if (existsSync(exe)) {
          console.log(`Playwright's browser is missing; using ${exe}`);
          return chromium.launch({ executablePath: exe });
        }
      }
    }
    throw new Error(
      `${String(err).split("\n")[0]}\nInstall one with: pnpm --filter e2e exec playwright install chromium`,
    );
  }
}

// ----------------------------------------------------------------- main ----
async function main() {
  const platforms = list("platforms", Object.keys(PLATFORMS));
  const themes = list("themes", ["light", "dark"]);
  const densities = list("densities", ["comfortable"]);
  const langs = list("langs", ["en"]);
  const routes = flags.routes
    ? list("routes", []).map((path) => ({
        name: path.replace(/^\//, "").replace(/[/?=&]+/g, "-") || "home",
        path,
      }))
    : ROUTES;

  for (const p of platforms) {
    if (!PLATFORMS[p]) throw new Error(`Unknown platform "${p}". Use: ${Object.keys(PLATFORMS).join(", ")}`);
  }

  // The fake agent rides into the page as one bundled IIFE (same as e2e).
  const bundlePath = join(root, "e2e", "support", "fake-agent.bundle.js");
  await build({
    entryPoints: [join(root, "e2e", "support", "fakeAgent", "index.ts")],
    bundle: true,
    format: "iife",
    platform: "browser",
    outfile: bundlePath,
    logLevel: "silent",
  });

  const server = await startVite();
  let browser;
  const results = [];
  const failures = [];

  rmSync(OUT, { recursive: true, force: true });

  try {
    browser = await launchBrowser();
    for (const platform of platforms) {
      const def = PLATFORMS[platform];
      for (const lang of langs) {
        for (const theme of themes) {
          for (const density of densities) {
            const combo = `${lang}-${theme}-${density}`;
            const dir = join(OUT, platform, combo);
            mkdirSync(dir, { recursive: true });

            const context = await browser.newContext({
              ...def.context,
              colorScheme: theme,
              locale: lang === "ja" ? "ja-JP" : "en-US",
              timezoneId: "Asia/Tokyo",
            });
            const seed = {
              settings: {
                onboarding_done: "true",
                share_service_url: null,
                share_session_token: null,
                ui_theme: theme,
                ui_density: density,
                ...(def.android ? PAIRED_PC_SETTINGS : {}),
              },
              templates: TEMPLATES,
              printers: PRINTERS,
              jobs: seedJobs(),
            };
            const encoded = Buffer.from(JSON.stringify(seed), "utf8").toString("base64");
            await context.addInitScript({
              content: `localStorage.setItem('fake-agent:seed','${encoded}');localStorage.setItem('printninja.language','${lang}');localStorage.setItem('fake-agent:render-html','true');`,
            });
            await context.addInitScript({ path: bundlePath });
            // Never hit the network: the update check would add a badge.
            await context.route("https://api.github.com/**", (r) => r.abort());

            const capture = async (route) => {
              const page = await context.newPage();
              if (route.guest !== false) {
                await page.addInitScript(
                  "localStorage.setItem('printninja-guest-mode','true');localStorage.setItem('printninja-guest-handle','demo_user');",
                );
              }
              const consoleErrors = [];
              // The fake agent is injected into every frame, including the sandboxed
              // print-preview iframe, which cannot read localStorage: harness noise.
              page.on("pageerror", (e) => {
                if (!/sandboxed/i.test(String(e))) consoleErrors.push(String(e));
              });
              const file = join(dir, `${route.name}.png`);
              try {
                await page.goto(BASE_URL + route.path, { waitUntil: "load" });
                if (route.guest !== false) {
                  await page.getByRole("main").first().waitFor({ state: "visible", timeout: 20_000 });
                } else {
                  await page.getByRole("button").first().waitFor({ state: "visible", timeout: 20_000 });
                }
                // Let lazy chunks, skeletons and transitions settle. Vite compiles
                // each page on first visit, so wait for the route spinner and any
                // skeleton to go away before taking the picture.
                await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
                await page
                  .waitForFunction(
                    () => !document.querySelector(".animate-spin, .animate-pulse"),
                    undefined,
                    { timeout: 45_000 },
                  )
                  .catch(() => {
                    failures.push(`${platform}/${combo}/${route.name}: still loading after 45s`);
                  });
                await page.addStyleTag({
                  content:
                    "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}",
                });
                await page.waitForTimeout(400);
                await page.screenshot({ path: file, fullPage: FULL_PAGE });
                results.push({ platform, combo, route: route.name, file });
                if (consoleErrors.length) {
                  failures.push(`${platform}/${combo}/${route.name}: page error: ${consoleErrors[0]}`);
                }
                console.log(`✓ ${platform}/${combo}/${route.name}`);
              } catch (err) {
                failures.push(`${platform}/${combo}/${route.name}: ${String(err).split("\n")[0]}`);
                console.log(`✗ ${platform}/${combo}/${route.name}`);
                await page.screenshot({ path: file, fullPage: false }).catch(() => {});
              } finally {
                await page.close();
              }
            };
            // Small worker pool: JOBS pages at a time per context.
            const queue = [...routes];
            await Promise.all(
              Array.from({ length: Math.min(JOBS, queue.length) }, async () => {
                while (queue.length) await capture(queue.shift());
              }),
            );
            await context.close();
          }
        }
      }
    }
  } finally {
    await browser?.close();
    if (server) server.kill();
  }

  if (WRITE_INDEX) writeIndex(results);

  console.log(`\n${results.length} screenshots in ${relative(root, OUT) || "."}/`);
  if (WRITE_INDEX) console.log(`Contact sheet: ${relative(root, join(OUT, "index.html"))}`);
  if (failures.length) {
    console.log(`\n${failures.length} problem(s):`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

function writeIndex(results) {
  const byPlatform = new Map();
  for (const r of results) {
    if (!byPlatform.has(r.platform)) byPlatform.set(r.platform, []);
    byPlatform.get(r.platform).push(r);
  }
  const sections = [...byPlatform]
    .map(
      ([platform, rows]) => `<h2>${platform}</h2><div class="grid">${rows
        .map((r) => {
          const src = relative(OUT, r.file).split("\\").join("/");
          return `<figure><a href="${src}"><img loading="lazy" src="${src}" alt="${r.route} (${r.combo})"></a><figcaption>${r.route} · ${r.combo}</figcaption></figure>`;
        })
        .join("")}</div>`,
    )
    .join("");
  writeFileSync(
    join(OUT, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>PrintNinja screenshots</title>
<style>body{font:14px system-ui;margin:24px;background:#f4f7f7;color:#14252b}
h2{margin:32px 0 12px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}
figure{margin:0;background:#fff;border:1px solid #d6e0e0;border-radius:6px;padding:8px}
img{width:100%;height:auto;max-height:340px;object-fit:cover;object-position:top;border-radius:4px}
figcaption{margin-top:6px;font-size:12px;color:#44575d}</style>
<h1>PrintNinja screenshots</h1>${sections}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
