/** True inside the Android app (WebView user agent). Desktop and web
 * builds return false.
 *
 * Lives in its own module (not android/background.ts) so components that
 * only need the platform check do not pull the background-service
 * bindings — and with them the Tauri invoke wrapper — into chunks that
 * would otherwise stay lazy. */
export const isAndroid = (): boolean =>
  typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
