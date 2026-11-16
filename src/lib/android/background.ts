import { invoke } from "@/lib/invoke";
import { isAndroid } from "./platform";

const PLUGIN = "plugin:android-print";

/** Re-exported for existing import sites. The implementation lives in
 * ./platform so a platform check alone never pulls this module (and its
 * invoke wrapper) into a chunk; every function below no-ops or reports
 * unsupported off-Android instead of throwing at import time. */
export { isAndroid };

function plugin<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(`${PLUGIN}|${cmd}`, args);
}

/** Ensures the foreground print service is running. Safe to call on
 * every launch: the service is idempotent, and non-Android builds
 * resolve false instead of failing. */
export async function ensureBackgroundService(): Promise<boolean> {
  if (!isAndroid()) return false;
  try {
    return await plugin<boolean>("start_background_service");
  } catch {
    return false;
  }
}

export async function stopBackgroundService(): Promise<void> {
  if (!isAndroid()) return;
  await plugin<void>("stop_background_service");
}

export async function isBackgroundServiceRunning(): Promise<boolean> {
  if (!isAndroid()) return false;
  try {
    return await plugin<boolean>("is_background_service_running");
  } catch {
    return false;
  }
}

/**
 * Opens the system battery-optimization exemption screen for the app.
 * Doze and app standby otherwise defer the queue worker and the local
 * API server. Call only from an explicit user toggle — never silently.
 * Resolves true when the screen was shown, false when already exempt
 * or the OS cannot show it. Rejects when the system refuses the
 * request (e.g. missing platform support) — the caller shows the
 * error instead of a fake success.
 */
export async function requestBatteryExemption(): Promise<boolean> {
  if (!isAndroid()) return false;
  return plugin<boolean>("request_battery_exemption");
}

export async function isBatteryExemptionGranted(): Promise<boolean> {
  if (!isAndroid()) return false;
  try {
    return await plugin<boolean>("is_battery_exemption_granted");
  } catch {
    return false;
  }
}

/** Notification permission as Android reports it: `granted` is the
 * current answer, `canAskAgain` whether the system prompt may still be
 * shown (false means the only route left is the settings screen). */
export interface NotificationPermissionState {
  granted: boolean;
  canAskAgain: boolean;
}

/**
 * Reads the POST_NOTIFICATIONS state for the Settings → Background row.
 * Non-Android reports granted (nothing to ask there); an unanswered or
 * unavailable plugin reports the conservative "not granted, do not ask"
 * shape so the row never claims a permission it cannot verify.
 */
export async function notificationPermissionState(): Promise<NotificationPermissionState> {
  if (!isAndroid()) return { granted: true, canAskAgain: false };
  try {
    const raw = await plugin<Partial<NotificationPermissionState> | null>(
      "notification_permission_state",
    );
    return {
      granted: raw?.granted === true,
      canAskAgain: raw?.canAskAgain === true,
    };
  } catch {
    return { granted: false, canAskAgain: false };
  }
}

/**
 * Asks for the notification permission, or (when Android will not prompt
 * again) opens the app's notification settings screen. Resolves as soon
 * as the dialog fires — the prompt is system UI — so `granted` is the
 * state at that instant, not the user's answer: re-read the state when
 * the app becomes visible again. `openedSettings` is true when the
 * settings screen was opened instead of a prompt.
 */
export async function requestNotificationPermission(): Promise<{
  granted: boolean;
  openedSettings: boolean;
}> {
  if (!isAndroid()) return { granted: true, openedSettings: false };
  const raw = await plugin<{
    granted?: boolean;
    openedSettings?: boolean;
  } | null>("request_notification_permission");
  return {
    granted: raw?.granted === true,
    openedSettings: raw?.openedSettings === true,
  };
}
