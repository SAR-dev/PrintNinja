// Locks the phone to portrait; tablets (smallest width >= 600dp) keep
// rotating freely. The device-class check must live in the generated
// MainActivity.kt: resources referenced from the manifest may not vary by
// configuration (lint "ManifestResource", fatal in release builds), so the
// earlier `@string/app_orientation` + values-sw600dp variant broke
// `lintVitalRelease` — and the sw600dp value was dead anyway, since a
// manifest reference only ever resolves the default configuration.
// Run after `tauri android init`:
//   node scripts/patch-android-orientation.mjs [path/to/android/app/src/main]
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ORIENTATION_ATTR = 'android:screenOrientation="unspecified"';
const ACTIVITY_IMPORT = "import android.content.pm.ActivityInfo";
const ORIENTATION_BLOCK = `
    // Phones are portrait-locked (single-column layout); tablets
    // (smallest width >= 600dp) keep rotating freely. Done here because
    // manifest-referenced resources may not vary by configuration
    // (lint ManifestResource, fatal in release).
    requestedOrientation =
      if (resources.configuration.smallestScreenWidthDp < 600) {
        ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
      } else {
        ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
      }`;

/** Pure and idempotent: returns the patched manifest. */
export function patchOrientation(xml) {
  // The main activity is the one the launcher opens (Tauri names it
  // ".MainActivity"); other activities keep whatever orientation they had.
  const m = xml.match(/<activity\b[^>]*android:name="\.MainActivity"[^>]*>/);
  if (!m) return xml;
  const tag = m[0];
  const next = tag.includes("android:screenOrientation")
    ? tag.replace(/android:screenOrientation="[^"]*"/, ORIENTATION_ATTR)
    : tag.replace(/\/?>$/, (end) => ` ${ORIENTATION_ATTR}${end}`);
  return xml.replace(tag, next);
}

/** Pure and idempotent: returns the patched MainActivity.kt, or the input
 * unchanged when it does not look like the generated activity (the CLI
 * then fails loudly instead of shipping an app that may rotate). */
export function patchMainActivity(src) {
  if (src.includes("SCREEN_ORIENTATION_PORTRAIT")) return src;
  if (!src.includes("super.onCreate(savedInstanceState)")) return src;
  let out = src;
  if (!out.includes(ACTIVITY_IMPORT)) {
    // Insert before the first import so the group stays alphabetical
    // (android.content.* sorts before android.os.* and app.*).
    const firstImport = out.match(/^import [^\n]+/m);
    if (firstImport) {
      const at = firstImport.index;
      out = `${out.slice(0, at)}${ACTIVITY_IMPORT}\n${out.slice(at)}`;
    } else {
      const pkg = out.match(/^package [^\n]+/m);
      if (pkg) {
        const at = pkg.index + pkg[0].length;
        out = `${out.slice(0, at)}\n\n${ACTIVITY_IMPORT}${out.slice(at)}`;
      }
    }
  }
  // Look the anchor up after the import insert, which shifts offsets.
  const at = out.indexOf("super.onCreate(savedInstanceState)");
  const insertAt = at + "super.onCreate(savedInstanceState)".length;
  return `${out.slice(0, insertAt)}${ORIENTATION_BLOCK}${out.slice(insertAt)}`;
}

/** The generated tree is tiny; a walk beats parsing the package out of the manifest. */
function findMainActivity(javaDir) {
  if (!existsSync(javaDir)) return null;
  const stack = [javaDir];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (entry.name === "MainActivity.kt") return p;
    }
  }
  return null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const main = process.argv[2] ?? "src-tauri/gen/android/app/src/main";
  const manifest = join(main, "AndroidManifest.xml");
  if (!existsSync(manifest)) {
    console.error(
      `No AndroidManifest.xml at ${manifest}. Run \`pnpm exec tauri android init\` first.`,
    );
    process.exit(1);
  }
  const before = readFileSync(manifest, "utf8");
  const after = patchOrientation(before);
  if (after !== before) writeFileSync(manifest, after);
  console.log(`${manifest}: ${after !== before ? "patched" : "already up to date"}`);

  // Remove the resource files the old approach created. They are dead
  // weight (a manifest reference cannot resolve them per configuration);
  // the sw600dp one is what tripped lint ManifestResource.
  for (const rel of ["values/orientation.xml", "values-sw600dp/orientation.xml"]) {
    const file = join(main, "res", rel);
    if (existsSync(file)) {
      rmSync(file);
      console.log(`${file}: removed (obsolete)`);
    }
  }

  const activity = findMainActivity(join(main, "java"));
  if (!activity) {
    console.error(
      `MainActivity.kt not found under ${main}/java; refusing to build an app that may rotate.`,
    );
    process.exit(1);
  }
  const src = readFileSync(activity, "utf8");
  const patched = patchMainActivity(src);
  if (patched !== src) writeFileSync(activity, patched);
  console.log(`${activity}: ${patched !== src ? "patched" : "already up to date"}`);
  // Fail loudly when the orientation did not land (e.g. the generated
  // template renamed the onCreate anchor).
  if (!patched.includes("SCREEN_ORIENTATION_PORTRAIT")) {
    console.error(
      `MainActivity.kt at ${activity} was not recognised (no super.onCreate anchor?); refusing to build an app that may rotate.`,
    );
    process.exit(1);
  }
}
