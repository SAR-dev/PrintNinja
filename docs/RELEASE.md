# Release Guide — PrintNinja

This guide explains how to version, sign, and ship a new PrintNinja release.

## Prerequisites
- **Windows**: Rust stable, Node 22+, Visual Studio Build Tools (MSVC), `pnpm`
- **Android**: JDK 17, Android SDK (34), NDK 27+, `cargo ndk`
- For signing locally: Windows code-signing certificate (`.pfx`) OR Android keystore

## 1. Bump version + rename (optional)

```bash
# Bump patch and tag a release
./scripts/release.sh 1.0.0 --tag

# With new app name
./scripts/release.sh --name "PrintNinja" --version 1.0.0 --tag

# Just bump patch (auto-increments z)
./scripts/release.sh --bump --tag
```

The script updates:
- `src-tauri/Cargo.toml` (name, version)
- `src-tauri/tauri.conf.json` (productName, version, identifier)
- `package.json` (name, version)

Then commits and (optionally) tags.

## 2. Sign app locally (for now)

### Windows (MSI)
Store your certificate as `scripts/certs/windows.pfx` (not committed).

```powershell
# Set environment variables (Git Bash / pwsh)
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content ./scripts/certs/windows-private.key -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "your-password"

# Build MSI only
pnpm tauri:build -- --target x86_64-pc-windows-msvc --bundles msi

# Optional: sign the resulting MSI with signtool
signtool sign /f ./scripts/certs/windows.pfx /p password /tr http://timestamp.digicert.com /td sha256 /fd sha256 src-tauri/target/release/bundle/msi/*.msi
```

### Android (APK / AAB)
```bash
# Set the keystore path
export ANDROID_KEYSTORE_PATH=./scripts/certs/android.keystore
export ANDROID_KEYSTORE_PASSWORD=secret
export ANDROID_KEY_ALIAS=printninja
export ANDROID_KEY_PASSWORD=secret

# Build arm64-v8a only (modern mobiles)
pnpm tauri android build --target aarch64

# Optional: for emulator testing, also build x86_64
pnpm tauri android build --target x86_64
```

## 3. Local-only signing in CI

By default, **CI does not sign anything**. Code signing is intentionally local-only for now. The GitHub Actions workflow only *builds* unsigned artifacts and uploads them as workflow artifacts. Distribute signed binaries from your local machine via the GitHub Releases page.

## 4. Trigger CI build (unsigned)

```bash
git push origin main
git push origin v1.0.0
```

This triggers:
- **web-check**: lint + type-check + vite build
- **rust-check**: cargo fmt + clippy + tests
- **windows-build**: MSI only (`x86_64-pc-windows-msvc`, `--bundles msi`)
- **android-build**: `aarch64` (arm64-v8a) only
- **cargo test**: unit tests

Artifacts are uploaded for 30 days.

## 5. Publish to GitHub Releases

```bash
gh release create v1.0.0 --title "PrintNinja v1.0.0" --notes-file release-notes.md
gh release upload v1.0.0 ./src-tauri/target/release/bundle/msi/*.msi
gh release upload v1.0.0 ./src-tauri/gen/android/.../*.apk
```

## 6. Architecture targets summary

| Platform | CI bundle | Local signing | Architectures |
|---|---|---|---|
| Windows | MSI only | `signtool` with `.pfx` | `x86_64-pc-windows-msvc` |
| Android | arm64-v8a | Android keystore | `aarch64-linux-android` (x86_64 optional for emulator) |

## Clean up cache

```bash
cd src-tauri && cargo clean
pnpm store prune
```
EOF
mkdir -p /root/projects/PrintNinja/docs && mv /root/projects/PrintNinja/docs/RELEASE.md /tmp/scratchpad 2>/dev/null; mkdir -p /root/projects/PrintNinja/docs && mv /tmp/scratchpad /root/projects/PrintNinja/docs/RELEASE.md 2>/dev/null; ls /root/projects/PrintNinja/docs/ 2>/dev/null || echo "docs dir not present - creating"