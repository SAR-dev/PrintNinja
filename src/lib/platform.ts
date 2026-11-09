/**
 * Which device the UI is running on, read from the WebView user agent.
 *
 * This is only ever a UI concern: the backend decides what it can drive
 * (`create_transport` in src-tauri/src/transport/mod.rs), and the page
 * below uses this to avoid offering choices that choice cannot fulfil.
 * Kept as a function of `navigator.userAgent` (rather than a Tauri OS
 * plugin) so no new native dependency is needed and tests can stub it.
 */

/** True inside the Android app's WebView. */
export function isAndroid(): boolean {
  return (
    typeof navigator !== "undefined" &&
    /Android/i.test(navigator.userAgent ?? "")
  );
}

/**
 * True on a desktop Linux WebView.
 *
 * Android's user agent also contains "Linux" (`Linux; Android 14; …`),
 * so it must be excluded — CUPS, the only thing this drives in the UI,
 * runs on the desktop.
 */
export function isLinux(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !isAndroid() &&
    /Linux/i.test(navigator.userAgent ?? "")
  );
}

/**
 * Connection types the current platform can actually drive.
 *
 * Android has no System transport (and Windows-only spooler/USB/Bluetooth
 * are replaced there), but USB and Bluetooth are driven through the Kotlin
 * plugin — only `system` stays hidden on Android. Desktop keeps everything:
 * Windows drives all five, Linux serves system printers through CUPS.
 */
export function supportedPrinterTypes<T extends { value: string }>(
  all: readonly T[],
): readonly T[] {
  if (!isAndroid()) return all;
  return all.filter((t) => t.value !== "system");
}

/**
 * The receipt and label languages the Android WebView raster has been
 * QA'd for (PLAN §4, D4.4 — tier 1, the fake-head framing test). These
 * are enabled on Android and documented as unverified on a real head;
 * adding a language here after its real-head pass is the one-line
 * per-language flip the plan calls for.
 */
export const ANDROID_THERMAL_QA_GATE = new Set(["escpos", "zpl", "tspl"]);

/**
 * Printer languages the current platform can actually produce.
 *
 * Android rasterizes receipt and label jobs itself through the system
 * WebView (PLAN §4), so it offers PDF plus the languages that pass
 * `ANDROID_THERMAL_QA_GATE` — independent of whether a PC is paired.
 * Desktop keeps all six.
 */
export function supportedPrinterLanguages<T extends { value: string }>(
  all: readonly T[],
): readonly T[] {
  if (!isAndroid()) return all;
  return all.filter(
    (l) => l.value === "pdf" || ANDROID_THERMAL_QA_GATE.has(l.value),
  );
}
