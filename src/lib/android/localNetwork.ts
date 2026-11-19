import { invoke } from "@/lib/invoke";
import { isAndroid } from "./platform";

const PLUGIN = "plugin:android-print";

function plugin<T>(cmd: string): Promise<T> {
  return invoke<T>(`${PLUGIN}|${cmd}`);
}

/** Local network access as Android reports it: `granted` is the current
 * answer (LAN discovery, paired PCs, IP printing), `canAskAgain` whether
 * the system prompt may still be shown (false means the only route left
 * is the settings screen). */
export interface LocalNetworkPermissionState {
  granted: boolean;
  canAskAgain: boolean;
}

/**
 * Reads the local network permission state (NEARBY_WIFI_DEVICES, plus
 * ACCESS_LOCAL_NETWORK on apps targeting Android 17). Non-Android
 * reports granted (nothing to ask there); an unavailable plugin
 * reports the conservative "not granted, do not ask" shape so a caller
 * never fires LAN traffic it cannot verify.
 */
export async function localNetworkPermissionState(): Promise<LocalNetworkPermissionState> {
  if (!isAndroid()) return { granted: true, canAskAgain: false };
  try {
    const raw = await plugin<Partial<LocalNetworkPermissionState> | null>(
      "local_network_permission_state",
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
 * Asks for the local network permission, or (when Android will not
 * prompt again) opens the app's permission settings screen. Resolves as
 * soon as the dialog fires — the prompt is system UI — so `granted` is
 * the state at that instant, not the user's answer: re-read the state
 * when the app becomes visible again. `openedSettings` is true when the
 * settings screen was opened instead of a prompt.
 */
export async function requestLocalNetworkPermission(): Promise<{
  granted: boolean;
  openedSettings: boolean;
}> {
  if (!isAndroid()) return { granted: true, openedSettings: false };
  const raw = await plugin<{
    granted?: boolean;
    openedSettings?: boolean;
  } | null>("request_local_network_permission");
  return {
    granted: raw?.granted === true,
    openedSettings: raw?.openedSettings === true,
  };
}

/**
 * Opens the app's Android permission settings screen directly — the
 * "Open settings" route on the denial notice. Unlike
 * `requestLocalNetworkPermission` it never fires the system prompt,
 * even while the prompt is still available. Non-Android is a no-op.
 */
export async function openLocalNetworkSettings(): Promise<void> {
  if (!isAndroid()) return;
  await plugin<null>("open_local_network_settings");
}
