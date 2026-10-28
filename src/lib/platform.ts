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
 * Printer languages the current platform can actually produce.
 *
 * Android renders to PDF only, so the command languages (ESC/POS, ZPL,
 * TSPL, CPCL, raster) are hidden — unless a PC is paired for shared
 * rendering (`pairedProvider`), in which case the PC renders them and
 * the phone only sends the bytes. Desktop keeps all six.
 */
export function supportedPrinterLanguages<T extends { value: string }>(
  all: readonly T[],
  opts?: { pairedProvider?: boolean },
): readonly T[] {
  if (!isAndroid()) return all;
  if (opts?.pairedProvider) return all;
  return all.filter((l) => l.value === "pdf");
}
