#!/usr/bin/env node
// Manual release: the full CI release pipeline as one local script, for
// when hosted runners are unavailable. Each machine builds what its OS
// allows (Windows -> MSI, Linux -> deb/AppImage, any OS with an Android
// SDK -> APK/AAB); the draft release collects whatever was produced.
//
//   node scripts/release-local.mjs 0.2.0 [--push] [--skip-checks]
//     [--share-url https://share.example.com]
//
// Without --push nothing leaves the machine: it bumps, checks, builds
// locally and prints the remaining commands. With --push it also pushes
// main + the tag and creates/updates the draft GitHub release.
// e2e (Playwright) is intentionally not run here — CI covers it on PRs.
//
// Requirements per machine: Node 22, pnpm 10, Rust 1.90, `gh` authed
// with repo scope. Android additionally needs ANDROID_HOME with SDK +
// NDK 27 plus ANDROID_KEYSTORE_BASE64 / ANDROID_KEYSTORE_PASSWORD
// (see docs/SIGNING.md and /root/secrets.txt on the release machine).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function usage() {
  console.log(`Usage: node scripts/release-local.mjs <X.Y.Z> [--push] [--skip-checks] [--share-url URL]

  X.Y.Z          exact version, must be higher than the current one
  --push         also push main + the tag and create/update the draft release
  --skip-checks  skip lint/tests/clippy (for iterating on build issues)
  --share-url    baked into the app as the share pre-fill
                 (default: https://print-ninja.vercel.app; empty string disables)`);
}

function die(msg) {
  console.error(`\nError: ${msg}`);
  process.exit(1);
}

function sh(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, {
    cwd: ROOT,
    stdio: "inherit",
    ...opts,
  });
}

function out(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  }).trim();
}

function have(cmd) {
  try {
    out(process.platform === "win32" ? "where" : "which", [cmd]);
    return true;
  } catch {
    return false;
  }
}

/** All files under dir ending with one of exts (recursive). */
function findFiles(dir, exts) {
  const found = [];
  if (!existsSync(dir)) return found;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) found.push(...findFiles(p, exts));
    else if (exts.some((e) => name.endsWith(e))) found.push(p);
  }
  return found;
}

// ---- args ---------------------------------------------------------------

const raw = process.argv.slice(2);
if (raw.includes("--help") || raw.includes("-h")) {
  usage();
  process.exit(0);
}
const push = raw.includes("--push");
const skipChecks = raw.includes("--skip-checks");
const shareIdx = raw.indexOf("--share-url");
const shareUrl =
  shareIdx === -1 ? "https://print-ninja.vercel.app" : (raw[shareIdx + 1] ?? "");
if (shareIdx !== -1 && !raw[shareIdx + 1]) die("--share-url needs a value (or omit the flag)");
const positional = raw.filter(
  (a, i) => !a.startsWith("--") && !(shareIdx !== -1 && (i === shareIdx || i === shareIdx + 1)),
);
if (positional.length !== 1) {
  usage();
  die("give exactly one version like 1.2.3");
}
const version = positional[0];
if (!/^\d+\.\d+\.\d+$/.test(version)) die(`"${version}" is not a version like 1.2.3`);
const tag = `v${version}`;

// ---- preflight (read-only) ----------------------------------------------

for (const tool of ["node", "cargo", "gh"]) {
  if (!have(tool)) die(`required tool not on PATH: ${tool}`);
}
try {
  out("gh", ["auth", "status"]);
} catch {
  die("gh is not authenticated (run `gh auth login`)");
}
if (!have("pnpm") && !existsSync(join(ROOT, "node_modules"))) {
  die("pnpm not found and node_modules missing: install pnpm 10 first");
}
const current = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const cmp = (a, b) => {
  const [x, y] = [a.split(".").map(Number), b.split(".").map(Number)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};
if (cmp(version, current) <= 0) die(`${version} is not higher than the current version ${current}`);
const branch = out("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
if (branch !== "main") die(`on branch "${branch}"; releases ship from main`);
if (out("git", ["status", "--porcelain"])) die("working tree is not clean (commit or stash first)");
const checkManifest = (file, want) => {
  const text = readFileSync(join(ROOT, file), "utf8");
  if (!text.includes(want)) die(`${file} does not contain ${want}: versions out of sync, fix first`);
};
for (const [f, want] of [
  ["package.json", `"version": "${current}"`],
  ["src-tauri/tauri.conf.json", `"version": "${current}"`],
  ["src-tauri/Cargo.toml", `version = "${current}"`],
  ["src/components/Layout.tsx", `"v${current}"`],
]) checkManifest(f, want);
if (out("git", ["tag", "-l", tag])) die(`tag ${tag} already exists locally`);
try {
  if (out("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`])) {
    die(`tag ${tag} already exists on origin`);
  }
} catch (e) {
  if (!/already exists on origin/.test(e.message)) console.warn("Warning: could not reach origin.");
}
console.log(`=== release-local ${current} -> ${version} (${tag}) on ${process.platform} ===`);

// ---- version bump (same files CI's version-check reads) -----------------

sh("node", ["scripts/set-version.mjs", version]);

// ---- checks (the blocking CI subset) ------------------------------------

const buildEnv = {
  ...process.env,
  VITE_DEFAULT_SHARE_URL: shareUrl,
  DATABASE_URL: `file:${join(tmpdir(), "printninja_build_dummy.db")}`,
};
if (!skipChecks) {
  sh(PNPM, ["install", "--frozen-lockfile"]);
  sh(PNPM, ["lint"]);
  sh(PNPM, ["check:tauri-args"]);
  sh(PNPM, ["test"]);
  sh(PNPM, ["gen:api"]);
  if (out("git", ["status", "--porcelain", "--", "src/lib/api/schema.d.ts"])) {
    die("src/lib/api/schema.d.ts drifted: commit the regenerated client first");
  }
  sh(PNPM, ["--filter", "server", "db:generate"], { env: buildEnv });
  sh(PNPM, ["--filter", "server", "typecheck"]);
  sh(PNPM, ["--filter", "server", "test"]);
  sh("cargo", ["fmt", "--manifest-path", "src-tauri/Cargo.toml", "--", "--check"]);
  sh("cargo", ["clippy", "--manifest-path", "src-tauri/Cargo.toml", "--all-targets", "--", "-D", "warnings"]);
  sh("cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml"]);
} else {
  console.log("(skipping checks: --skip-checks)");
}

// ---- commit + tag --------------------------------------------------------

sh("git", ["add", "--", "package.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src/components/Layout.tsx"]);
try {
  execFileSync("git", ["-c", "user.name=Release", "-c", "user.email=release@local", "commit", "-m", `release: ${tag}`, "-m", `Release printninja ${version}`], { cwd: ROOT, stdio: "inherit" });
} catch {
  // Already bumped+committed by an earlier interrupted run: reuse it.
  console.log("(commit exists, continuing)");
}
try {
  out("git", ["rev-parse", tag]);
  console.log(`(tag ${tag} exists, continuing)`);
} catch {
  sh("git", ["tag", "-a", tag, "-m", `release: ${tag}`]);
}

// ---- builds (whatever this OS allows) ------------------------------------

const artifacts = [];
if (process.platform === "win32") {
  // MSI only (mirrors CI's windows-build).
  sh(PNPM, ["exec", "tauri", "build", "--bundles", "msi"], { env: buildEnv });
  artifacts.push(...findFiles(join(ROOT, "src-tauri/target/release/bundle/msi"), [".msi"]));
} else if (process.platform === "linux") {
  // deb + AppImage only (mirrors CI's linux-build).
  sh(PNPM, ["exec", "tauri", "build", "--bundles", "deb", "appimage"], { env: buildEnv });
  artifacts.push(...findFiles(join(ROOT, "src-tauri/target/release/bundle/deb"), [".deb"]));
  artifacts.push(...findFiles(join(ROOT, "src-tauri/target/release/bundle/appimage"), [".AppImage"]));
} else {
  console.log(`(no desktop bundles configured for ${process.platform}; skipping)`);
}

// Android: any OS with an SDK, same keystore contract as CI.
const androidHome = process.env.ANDROID_HOME ?? "";
const sdkManager =
  androidHome && existsSync(androidHome)
    ? findFiles(join(androidHome, "cmdline-tools"), ["sdkmanager", "sdkmanager.bat"])[0]
    : undefined;
if (sdkManager && process.env.ANDROID_KEYSTORE_BASE64 && process.env.ANDROID_KEYSTORE_PASSWORD) {
  const genDir = join(ROOT, "src-tauri/gen/android");
  if (!existsSync(genDir)) sh(PNPM, ["exec", "tauri", "android", "init", "--ci"], { env: buildEnv });
  sh("node", ["scripts/patch-android-theme.mjs"]);
  sh("node", ["scripts/patch-android-signing.mjs"], {
    env: {
      ...buildEnv,
      ANDROID_KEYSTORE_BASE64: process.env.ANDROID_KEYSTORE_BASE64,
      ANDROID_KEYSTORE_PASSWORD: process.env.ANDROID_KEYSTORE_PASSWORD,
    },
  });
  if (process.platform !== "win32") {
    try {
      execFileSync("chmod", ["+x", join(genDir, "gradlew")], { cwd: ROOT, stdio: "ignore" });
    } catch {
      /* best effort; gradlew may already be executable */
    }
  }
  sh(PNPM, ["exec", "tauri", "android", "build", "--target", "aarch64", "--apk", "--aab"], { env: buildEnv });
  const outDir = join(genDir, "app/build/outputs");
  const apks = findFiles(join(outDir, "apk"), [".apk"]);
  const aabs = findFiles(join(outDir, "bundle"), [".aab"]);
  if (apks.length !== 1 || aabs.length !== 1) {
    die(`expected exactly 1 APK and 1 AAB, found ${apks.length} APK / ${aabs.length} AAB`);
  }
  const namedApk = join(outDir, `PrintNinja_${version}_aarch64.apk`);
  const namedAab = join(outDir, `PrintNinja_${version}_aarch64.aab`);
  renameSync(apks[0], namedApk);
  renameSync(aabs[0], namedAab);
  artifacts.push(namedApk, namedAab);
} else {
  console.log("(Android SDK or signing secrets missing; skipping APK/AAB)");
}
if (artifacts.length === 0) die("no artifacts were built on this machine");
console.log(`\n[ok] built ${artifacts.length} artifact(s):`);
for (const f of artifacts) console.log(`  ${f}`);

// ---- publish ---------------------------------------------------------------

if (!push) {
  console.log(`\nNext (this publishes):\n  git push --atomic origin main ${tag}`);
  console.log(`  gh release create ${tag} --draft --title "PrintNinja ${tag}"`);
  console.log(`  gh release upload ${tag} ${artifacts.map((f) => `"${f}"`).join(" ")} --clobber`);
  process.exit(0);
}
sh("git", ["push", "--atomic", "origin", "main", tag]);
try {
  out("gh", ["release", "view", tag]);
  console.log(`(release ${tag} exists, reusing)`);
} catch {
  sh("gh", ["release", "create", tag, "--draft", "--title", `PrintNinja ${tag}`]);
}
sh("gh", ["release", "upload", tag, ...artifacts, "--clobber"]);
console.log(`\n[ok] pushed main + ${tag}; draft release updated. Open it on GitHub to publish.`);
