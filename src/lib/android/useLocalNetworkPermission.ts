import { useCallback, useEffect, useState } from "react";
import {
  localNetworkPermissionState,
  requestLocalNetworkPermission,
  type LocalNetworkPermissionState,
} from "./localNetwork";
import { isAndroid } from "./platform";

/**
 * The live answer to the local network permission, shared by every LAN
 * gate (printer scans, PC pairing, IP printing, share status). Reads the
 * state on mount and re-reads it when the app becomes visible again —
 * the prompt and the settings screen are system UI, and the plugin never
 * receives the grant callback, so the only reliable moment to read the
 * answer back is after the user comes back. Before the first read
 * settles it reports the conservative "not granted" answer, so a LAN
 * action in the first milliseconds cannot outrun the check.
 */
export function useLocalNetworkPermission() {
  const [state, setState] = useState<LocalNetworkPermissionState | null>(null);
  const [asking, setAsking] = useState(false);

  const read = useCallback(async () => {
    setState(await localNetworkPermissionState());
  }, []);

  useEffect(() => {
    if (!isAndroid()) return;
    void read();
    const onVisible = () => {
      if (document.visibilityState === "visible") void read();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [read]);

  /** Shows the system prompt (or the settings screen when Android will
   * not prompt again), then re-reads the state. */
  const ask = useCallback(async () => {
    setAsking(true);
    try {
      await requestLocalNetworkPermission();
    } finally {
      setAsking(false);
      // The user's answer arrives with the system UI (the dialog being
      // dismissed, or the return from the settings screen); the
      // visibilitychange read picks that up. Re-read once now so the
      // already-granted case is not left stale for the round-trip.
      await read();
    }
  }, [read]);

  return {
    /** Conservative before the first read settles; granted off-Android. */
    granted: state?.granted ?? !isAndroid(),
    /** True while the system prompt may still be shown. */
    canAskAgain: state?.canAskAgain ?? false,
    /** True while a prompt/settings open is in flight. */
    asking,
    ask,
  };
}
