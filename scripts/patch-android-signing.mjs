// Pins the generated Android project to one stable signing key for the
// debug AND release variants, so every release APK upgrades cleanly over
// the last — including the debug-signed test builds already on phones.
//
// Why: `tauri android init` regenerates gen/android per machine/run and the
// default signers are per-machine keystores (~/.android/debug.keystore,
// plus a throwaway for release). Without this, each release carries a
// different signer and Android refuses the update ("App installation
// failed", INSTALL_FAILED_UPDATE_INCOMPATIBLE).
//
// Release keeps cleartext HTTP allowed (same as the debug variant):
// the app's WebView still fetches http:// share servers and data URLs,
// which the release default (blocked) would break. Revisit when sync
// and previews move off WebView fetch.
//
// Run after `tauri android init`, before `tauri android build`:
//   ANDROID_KEYSTORE_BASE64=<base64 .keystore> ANDROID_KEYSTORE_PASSWORD=<pw> \
//     node scripts/patch-android-signing.mjs [path/to/android/app]
// ANDROID_KEYSTORE_ALIAS overrides the key alias (default "printninja").
//
// Fails loudly when the secrets are missing: silently falling back to a
// throwaway key is exactly the bug this prevents. Idempotent, and upgrades
// files patched by the older debug-only version of this script.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const KEYSTORE_FILE = "printninja.keystore";
export const KEY_PROPERTIES_FILE = "key.properties";
export const MARKER = "// printninja-signing: stable shared key";
const OLD_MARKER = "// printninja-signing: stable debug key";

function variantBlock(variant) {
  // AGP pre-creates only the debug signing config: debug is looked up,
  // release is created.
  const accessor = variant === "release" ? "create" : "getByName";
  return `        ${accessor}("${variant}") {
            val keyProps = Properties().apply {
                val keyFile = file("${KEY_PROPERTIES_FILE}")
                if (keyFile.exists()) {
                    keyFile.inputStream().use { load(it) }
                }
            }
            storeFile = file(keyProps.getProperty("storeFile", "${KEYSTORE_FILE}"))
            storePassword = keyProps.getProperty("storePassword")
            keyAlias = keyProps.getProperty("keyAlias")
            keyPassword = keyProps.getProperty("keyPassword")
        }`;
}

/** Pure and idempotent: returns the patched build.gradle.kts. */
export function patchBuildGradle(kts, keyAlias = "printninja") {
  void keyAlias;
  let out = kts;
  // Normalize: the first version of the release support wrongly used
  // getByName inside signingConfigs, but AGP only pre-creates debug —
  // release must be create()d. The buildType wiring keeps getByName
  // (reading is fine once the config exists).
  const wrongAccessor =
    '        getByName("release") {\n            val keyProps';
  if (out.includes(wrongAccessor)) {
    out = out.replace(
      wrongAccessor,
      '        create("release") {\n            val keyProps',
    );
  }
  if (!out.includes("signingConfigs {")) {
    const configs = `    ${MARKER} (see scripts/patch-android-signing.mjs)
    signingConfigs {
${variantBlock("debug")}
${variantBlock("release")}
    }
`;
    const at = out.indexOf("    buildTypes {");
    if (at === -1) throw new Error("buildTypes block not found");
    out = `${out.slice(0, at)}${configs}${out.slice(at)}`;
  } else if (!out.includes('create("release")')) {
    // Upgrade path: files patched by the older debug-only script get the
    // release variant alongside debug, inside the existing block. (The
    // buildTypes below hold same-named blocks of their own, so the check
    // keys on create(), which only ever lives in signingConfigs.)
    const anchor = `            keyPassword = keyProps.getProperty("keyPassword")
        }`;
    const at = out.indexOf(anchor);
    if (at === -1) throw new Error("existing signingConfigs block not recognised");
    const insertAt = at + anchor.length;
    out = `${out.slice(0, insertAt)}\n${variantBlock("release")}${out.slice(insertAt)}`;
    if (!out.includes(MARKER)) {
      out = out.replace(OLD_MARKER, `${MARKER} (see scripts/patch-android-signing.mjs)`);
    }
  }
  for (const variant of ["debug", "release"]) {
    const line = `            signingConfig = signingConfigs.getByName("${variant}")`;
    if (!out.includes(line)) {
      // Each buildType lives inside `buildTypes { ... }`, after the
      // signingConfigs block — anchor there so the match cannot land
      // inside signingConfigs itself.
      const buildTypesAt = out.indexOf("    buildTypes {");
      const m = new RegExp(`\\n(\\s*)getByName\\("${variant}"\\) \\{\\n`).exec(
        out.slice(buildTypesAt),
      );
      if (buildTypesAt === -1 || !m)
        throw new Error(`${variant} buildType not found`);
      const idx = buildTypesAt + m.index + 1 + m[0].length;
      const indent = `${m[1]}    `;
      out = `${out.slice(0, idx)}${indent}${line.trim()}\n${out.slice(idx)}`;
    }
  }
  // Release keeps cleartext parity with debug (see header): the stock
  // file leaves the release default (blocked) in place. Anchored inside
  // buildTypes — signingConfigs holds a same-named block of its own.
  const cleartextLine =
    '            manifestPlaceholders["usesCleartextTraffic"] = "true"';
  const buildTypesAt = out.indexOf("    buildTypes {");
  const releaseAt =
    buildTypesAt === -1
      ? -1
      : out.indexOf('getByName("release") {', buildTypesAt);
  if (releaseAt !== -1) {
    const blockEnd = out.indexOf("\n        }", releaseAt);
    const block = out.slice(releaseAt, blockEnd);
    if (!block.includes("usesCleartextTraffic")) {
      const insertAt = releaseAt + 'getByName("release") {'.length;
      out = `${out.slice(0, insertAt)}\n${cleartextLine}${out.slice(insertAt)}`;
    }
  }
  return out;
}

/** Pure: the key.properties content pointing at the shared keystore. */
export function keyPropertiesContent(storePassword, keyAlias = "printninja") {
  return [
    `storeFile=${KEYSTORE_FILE}`,
    `storePassword=${storePassword}`,
    `keyAlias=${keyAlias}`,
    `keyPassword=${storePassword}`,
    "",
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const appDir = process.argv[2] ?? "src-tauri/gen/android/app";
  const b64 = process.env.ANDROID_KEYSTORE_BASE64;
  const storePassword = process.env.ANDROID_KEYSTORE_PASSWORD;
  const keyAlias = process.env.ANDROID_KEYSTORE_ALIAS ?? "printninja";
  if (!b64 || !storePassword) {
    console.error(
      "Missing ANDROID_KEYSTORE_BASE64 and/or ANDROID_KEYSTORE_PASSWORD. " +
        "Refusing to build with a throwaway key.",
    );
    process.exit(1);
  }
  const gradleFile = join(appDir, "build.gradle.kts");
  if (!existsSync(gradleFile)) {
    console.error(`No build.gradle.kts at ${gradleFile}. Run \`pnpm exec tauri android init\` first.`);
    process.exit(1);
  }
  writeFileSync(join(appDir, KEYSTORE_FILE), Buffer.from(b64, "base64"));
  console.log(`${join(appDir, KEYSTORE_FILE)}: written`);
  writeFileSync(
    join(appDir, KEY_PROPERTIES_FILE),
    keyPropertiesContent(storePassword, keyAlias),
  );
  console.log(`${join(appDir, KEY_PROPERTIES_FILE)}: written`);
  const before = readFileSync(gradleFile, "utf8");
  const after = patchBuildGradle(before, keyAlias);
  if (after !== before) writeFileSync(gradleFile, after);
  console.log(`${gradleFile}: ${after !== before ? "patched" : "already up to date"}`);
}
