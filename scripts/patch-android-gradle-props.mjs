// AGP 9 warns on every build about the project options the Tauri
// template still sets (`android.proguard.failOnMissingFiles`,
// `android.builtInKotlin`, `android.newDsl`) and about Tauri's use of
// the legacy variant API. The options are load-bearing until Tauri
// moves off the legacy DSL (the template says "TODO: Remove this in
// v3") — deleting `android.newDsl=false` would break the generated
// build.gradle.kts — so silence the warnings the way AGP suggests.
// Run after `tauri android init`:
//   node scripts/patch-android-gradle-props.mjs [path/to/android]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SUPPRESS_LINE =
  "android.sync.suppressAgpWarnings=UNSUPPORTED_PROJECT_OPTION_USE,DEPRECATED_DSL";

/** Pure and idempotent: returns the patched gradle.properties. */
export function patchGradleProperties(src) {
  if (src.includes("android.sync.suppressAgpWarnings=")) return src;
  const prefix = src.length > 0 && !src.endsWith("\n") ? "\n" : "";
  return `${src}${prefix}${SUPPRESS_LINE}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const androidDir = process.argv[2] ?? "src-tauri/gen/android";
  const file = join(androidDir, "gradle.properties");
  if (!existsSync(file)) {
    console.error(
      `No gradle.properties at ${file}. Run \`pnpm exec tauri android init\` first.`,
    );
    process.exit(1);
  }
  const before = readFileSync(file, "utf8");
  const after = patchGradleProperties(before);
  if (after !== before) writeFileSync(file, after);
  console.log(`${file}: ${after !== before ? "patched" : "already up to date"}`);
}
