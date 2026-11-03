// Locks the phone to portrait. The orientation lives in a string resource so
// phones (`values/`) get `portrait` while tablets and Chromebooks
// (`values-sw600dp/`) keep rotating freely. Run after `tauri android init`.
//   node scripts/patch-android-orientation.mjs [path/to/android/app/src/main]
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ORIENTATION_ATTR = 'android:screenOrientation="@string/app_orientation"';

/** Pure and idempotent: returns the patched manifest. */
export function patchOrientation(xml) {
  // The main activity is the one the launcher opens (Tauri names it
  // ".MainActivity"); other activities keep whatever orientation they had.
  const m = xml.match(/<activity\b[^>]*android:name="\.MainActivity"[^>]*>/);
  if (!m) return xml;
  const tag = m[0];
  const next = tag.includes("android:screenOrientation")
    ? tag.replace(
        /android:screenOrientation="[^"]*"/,
        ORIENTATION_ATTR,
      )
    : tag.replace(/\/?>$/, (end) => ` ${ORIENTATION_ATTR}${end}`);
  return xml.replace(tag, next);
}

/** The two resource files that define the phone-only lock. */
export function orientationFiles() {
  const file = (value) =>
    `<resources>\n    <string name="app_orientation">${value}</string>\n</resources>\n`;
  return {
    "values/orientation.xml": file("portrait"),
    "values-sw600dp/orientation.xml": file("unspecified"),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const main =
    process.argv[2] ?? "src-tauri/gen/android/app/src/main";
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
  console.log(
    `${manifest}: ${after !== before ? "patched" : "already up to date"}`,
  );
  for (const [rel, content] of Object.entries(orientationFiles())) {
    const file = join(main, "res", rel);
    mkdirSync(join(file, ".."), { recursive: true });
    if (!existsSync(file) || readFileSync(file, "utf8") !== content)
      writeFileSync(file, content);
    console.log(`${file}: up to date`);
  }
  // Fail loudly when the attribute did not land (e.g. the generated
  // manifest renamed the activity).
  const final = readFileSync(manifest, "utf8");
  const check = final.match(/<activity\b[^>]*android:name="\.MainActivity"[^>]*>/);
  if (!check || !check[0].includes(ORIENTATION_ATTR)) {
    console.error(
      `screenOrientation is missing from the main activity in ${manifest}; refusing to build an app that may rotate.`,
    );
    process.exit(1);
  }
}
