# PrintNinja

Cross-platform silent print app for Windows and Android.

## Tech Stack

- **App shell:** Tauri 2 (Rust core)
- **UI:** React + Vite + TypeScript + Tailwind CSS + shadcn/ui
- **Database:** SQLite (via tauri-plugin-sql)
- **Android native:** Kotlin Tauri plugins

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) 22+
- [Rust](https://rustup.rs/) (stable)
- [pnpm](https://pnpm.io/) 10+
- For Android: Java 17, Android SDK, NDK 27+

### Setup

```bash
pnpm install
```

### Run

```bash
# Web UI only (hot reload)
pnpm dev

# Full Tauri app (desktop)
pnpm tauri:dev

# Android (requires emulator or device)
pnpm tauri android dev
```

### Build

```bash
pnpm build          # Web UI
pnpm tauri:build    # Desktop installer
pnpm tauri android build  # Android APK
```

## Project Structure

```
src/                    # Web UI (React + TypeScript)
  components/ui/        # shadcn/ui components
  components/           # App components (Layout, etc.)
  pages/                # Page components
  lib/                  # Theme, i18n, utilities

src-tauri/              # Rust core
  src/
    commands/           # Tauri command handlers
    db/                 # Database schema and models
    transport/          # Printer transport trait
  icons/                # App icons
```

## License

MIT
