/**
 * The one-time "first print" brand moment. A flag in localStorage keeps it
 * to the very first successful print on this device.
 */
const KEY = "printninja-first-print-seen";

/** True once the moment has been shown (or storage is unavailable). */
export function hasSeenFirstPrint(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    // Storage blocked (private mode, SSR): never celebrate twice.
    return true;
  }
}

/** Remember that the moment was shown. Fails silently when blocked. */
export function markFirstPrintSeen(): void {
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    /* no storage — the moment simply repeats, nothing to do */
  }
}
