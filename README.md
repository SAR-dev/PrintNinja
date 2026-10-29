<div align="center">

<img src="app-icon.svg" alt="PrintNinja" width="120" height="120" />

# PrintNinja

**Silent printing for Windows, Android and Linux.**
Design a receipt or label in HTML and CSS, feed it JSON, and it prints. No print dialog, no driver dance, no fuss.

[![Version](https://img.shields.io/badge/version-0.15.0-e43636)](https://github.com/SAR-dev/PrintNinja/releases)
![Tauri 2](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-1.90-DEA584?logo=rust&logoColor=black)
![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript&logoColor=white)
![Platforms](https://img.shields.io/badge/Windows%20%C2%B7%20Linux%20%C2%B7%20Android-supported-2ea44f)

[Quick start](#-quick-start) ·
[Automate it](#-automate-it) ·
[Features](#-features) ·
[Architecture](#-how-it-works) ·
[Contributing](#-contributing)

</div>

---

## Why PrintNinja?

Printing from software is still a mess of dialogs, drivers and printer-specific quirks. PrintNinja turns it into three steps:

1. **Design** a template with the web skills you already have: HTML, CSS, Tailwind and Handlebars.
2. **Send data** from a JSON URL, a CSV, the REST API or a deep link.
3. **Print silently** to a receipt, label or office printer, with the real reason when something goes wrong.

```handlebars
<h1 class="text-xl font-bold">Order {{order.id}}</h1>
<p>{{date order.createdAt}}</p>
<p class="text-right">{{currency order.total}}</p>

{{barcode "code128" order.id}}
{{qrcode order.url}}
```

The barcode and QR code in the preview are the same ones that come out of the printer.

## 🚀 Quick start

You need Node 22 (the `engines` field pins 22.x), pnpm 10 and Rust 1.90 (pinned in `rust-toolchain.toml`). For Android you also need Java 17 and the Android SDK and NDK.

```bash
git clone https://github.com/SAR-dev/PrintNinja.git
cd PrintNinja
pnpm install

pnpm dev          # web preview at http://localhost:1420
pnpm tauri:dev    # full desktop app
```

In a browser there is no Tauri backend, so settings fall back to `localStorage`.

**No printer on your desk?** Start the bundled fake IPP printer and watch jobs land as PDFs:

```bash
pnpm dev:printer  # ipp://localhost:6310/ipp/print
```

Add it in PrintNinja as a network printer at `localhost:6310`. Every job is saved to `dev-printer/output/`. See [`dev-printer/README.md`](dev-printer/README.md).

## 🤖 Automate it

PrintNinja runs a local REST API on `127.0.0.1:17717`, so any script, POS or back office can print through it.

```bash
curl -X POST http://127.0.0.1:17717/v1/print \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-1042" \
  -d '{
        "template": "Receipt",
        "printer": "Front Desk",
        "data": { "order": { "id": "1042", "total": 18.5 } },
        "settings": { "copies": 2 }
      }'
```

If you have enabled API keys, add `-H "Authorization: Bearer <key>"`.

- **Safe retries.** Replaying an `Idempotency-Key` never prints a second copy.
- **Honest answers.** The response reports the real outcome (printed, or why not), and `GET /v1/jobs/{id}` tracks any job.
- **Observable.** Metrics in JSON and Prometheus format, plus a live OpenAPI document.
- **Deep links.** `printninja://print?template=My+Receipt&printer=Desk` prints from a link, behind a trust list and a confirmation sheet.

The in-app **Automation** page lets you start the server, try requests against the live spec, pair phones and manage trusted deep-link sources.

## ✨ Features

### 🎨 Designer
- HTML and CSS editor (CodeMirror) with a live canvas, fit-to-width and manual zoom
- Page presets: A4, 80 mm and 58 mm rolls, 4×6 labels and custom sizes
- Handlebars templates with helpers such as `currency`, `date`, `upper`, `lower`, `number` and `padLeft`
- Any Tailwind class works: each template is compiled with its own CSS
- Barcodes and QR codes from data (Code 128/39/93, EAN-13/8, UPC-A, ITF, Codabar, QR), identical in preview and print
- Custom fonts, version history with diff and restore, and a README tab per template
- Phone layout with a bottom sheet, sticky tabs, and pinch and double-tap zoom

### 🖨️ Print
- Pick a printer, template, data source and copies, preview, then print
- Data from built-in test data or a JSON URL (GET or POST); a JSON array prints one record per label or page
- Per-printer profiles, plus orientation, fit, margins, page range and grayscale under Advanced options
- Clear success and failure messages, including when a printer is out of paper, jammed or offline
- **Shared rendering:** a phone can ask a paired PC on the same Wi-Fi to prepare its PDFs, which is faster. Pair with the 8-character code shown on the PC. If the PC (Windows or Linux) is off or away, the phone fails the job and names the PC

### 🔌 Printers
- Network (IPP, raw TCP 9100) and system printers on Windows and Linux
- USB and Bluetooth through the Windows spooler, or directly on Android
- Printer languages: PDF, ESC/POS, ZPL, TSPL, CPCL and raster (Android prints PDF only for now)
- Status checks before a raw job is sent, and timeouts so a stuck printer never hangs a job
- A test print per printer (Windows spooler, USB and Bluetooth tests check status only)
- Linux needs Chromium and CUPS. The `.deb` declares both, the AppImage does not

### 📚 Templates and sharing
- Mine, Saved and Community tabs with search and sort
- Publish and unpublish, save to server, refresh from server, and get your templates onto a new PC
- **Offline-first:** printing keeps working when the server is unreachable, and changes sync when it returns
- Hosted share service with accounts, delta sync, sample datasets, printer profiles, fonts and preferences

### 🕘 History
- Filter by status, source, printer, template and date, with saved filter sets
- Bulk reprint and retry, CSV export, and automatic retention (by age and record count)
- Every job carries a per-stage timing breakdown: fetch, template, layout, render, send, history

### 🧰 The app itself
- Tray icon, autostart, single instance, and a background service on Android
- Setup checklist, profile, background, share, data sources, retention and diagnostics in Settings
- IBM Plex fonts bundled for offline use, comfortable or compact density, custom name and logo
- Keyboard first: `Ctrl/Cmd+K` command palette and `G` then `P/H/D/T/R/S` navigation
- Responsive on phones: bottom navigation, card lists instead of tables, sticky Print bar
- Accessibility target: WCAG 2.1 AA

## 🧠 How it works

Printing is a chain of transformations, and every entry point (the Print page, the REST API, a deep link, a reprint from history) goes through the same one:

```
Data + Template → Design pages → Sheets → Image or PDF → Printer language → Wire → Paper
```

A template renders into design pages exactly as it looks in the Designer, with no knowledge of the paper. Only afterwards are those pages placed on physical sheets. One stage can even run on another machine, so a phone hands the image step to a paired PC and takes back finished bytes.

Read the full story in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## 🧱 Tech stack

| Area | Technology |
|---|---|
| Desktop and mobile shell | Tauri 2 (Windows MSI, Linux deb and AppImage, Android arm64) |
| Core | Rust 1.90, Tokio, axum and tower-http (local API), reqwest (rustls), rusqlite (bundled SQLite) |
| Rendering | Handlebars (Rust and JS), headless Edge over the DevTools protocol (Windows), headless Chromium (Linux), the system WebView (Android), `barcoders` and `qrcode`, `bwip-js` for previews |
| Printing | IPP, raw TCP, Windows spooler (also USB and Bluetooth), CUPS (Linux), a Kotlin plugin for Android (WebView to PDF, `UsbManager`, RFCOMM) |
| UI | React 18, TypeScript 5.6, Vite 6, Tailwind 3, shadcn/ui on Radix, Zustand, TanStack Query and Table, React Router 7, react-hook-form, i18next, cmdk, sonner |
| Template CSS | Tailwind v4 `compile()`, run in the app and stored with each template version |
| Editor | CodeMirror 6, `react-diff-viewer-continued`, `react-markdown` with `remark-gfm` |
| API client | `openapi-fetch` with types generated by `openapi-typescript`, `zod` for validation |
| Share service | Node, Fastify 5, Zod 4, Prisma 7 on Turso/libSQL (a local SQLite file in development), Argon2id, Swagger UI. Runs in Docker or on Vercel |
| Security | HTML sanitizing, sandboxed preview iframes with a strict CSP, secrets redacted from stored jobs, rate limits |
| Quality | Vitest and Testing Library, `cargo test`, Playwright with axe-core (desktop and phone projects), Biome, Clippy |

## 🗂️ Project layout

```
src/          React app: pages, components, stores, sync, template rendering
src-tauri/    Rust core: print queue, transports, rendering, local API, SQLite
plugins/      Tauri plugin for Android printing (Kotlin)
server/       Share service (Fastify, Prisma, OpenAPI contract in server/openapi)
e2e/          Playwright suite with a fake desktop agent
dev-printer/  Fake IPP printer for local development
docs/         Architecture, shared rendering, UI guide, environment, release and signing
scripts/      Release and versioning helpers
```

## 🛠️ Development

| Command | Purpose |
|---|---|
| `pnpm check` | Run the project checks locally (add `--rust` or `--e2e`; `pnpm check:full` before a release) |
| `pnpm build` | Type-check and build the web app |
| `pnpm test` | Unit tests (Vitest) |
| `pnpm lint` | Biome |
| `pnpm e2e` | Playwright end-to-end tests |
| `pnpm gen:api` | Regenerate API types from `server/openapi/openapi.json` |
| `pnpm tauri:build` | Build the installer for the current platform |
| `pnpm --filter server dev` | Run the share service with reload |
| `pnpm --filter server test` | Share service unit and integration tests |
| `cargo test --manifest-path src-tauri/Cargo.toml` | Rust tests |

There is no hosted CI, so run `pnpm check` before you push. See [`docs/CI.md`](docs/CI.md).

### Run the share service

```bash
cd server
cp env.example .env
docker compose up -d
curl localhost:3001/v2/health
```

It uses a local SQLite file by default. For production, set `DATABASE_URL` (`libsql://…`) and `DATABASE_AUTH_TOKEN` for Turso Cloud. Every variable is listed in [`docs/ENV.md`](docs/ENV.md).

### Release

```bash
pnpm release:patch   # bump + commit + tag (or release:minor / release:major)
```

Installers are built on your own machines with `node scripts/release-local.mjs X.Y.Z --push`, which builds the unsigned MSI, deb, AppImage and APK and attaches them to a draft GitHub release. See [`docs/RELEASE.md`](docs/RELEASE.md) and [`docs/SIGNING.md`](docs/SIGNING.md).

## 🤝 Contributing

Pull requests go to `develop`; `main` is the release branch. Keep commits small, use conventional messages (`feat(print): …`, `fix(designer): …`), and add a regression test with every bug fix. The full rules are in [`CONTRIBUTING.md`](CONTRIBUTING.md).

## 📖 Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): how data becomes dots on paper, including [borrowing a faster device](docs/ARCHITECTURE.md#9-borrowing-a-faster-device)
- [`docs/UI_GUIDE.md`](docs/UI_GUIDE.md): design principles, components and status vocabulary
- [`docs/PRINT_SPEED.md`](docs/PRINT_SPEED.md): print performance findings
- [`docs/ENV.md`](docs/ENV.md): share service environment variables
- [`docs/RELEASE.md`](docs/RELEASE.md) and [`docs/SIGNING.md`](docs/SIGNING.md): releasing and signing

## License

Proprietary. All rights reserved.