import { useEffect, useState } from "react";
import { SessionExpiredError } from "@/lib/api/errors";
import { isAndroid } from "@/lib/platform";
import { useLocalNetworkPermission } from "@/lib/android/useLocalNetworkPermission";
import * as share from "@/lib/share/client";
import { isLocalServiceUrl } from "@/lib/share/localUrl";

export type ShareStatus =
  | { state: "unconfigured" }
  | { state: "signed_out" }
  | { state: "online"; handle: string }
  | { state: "offline" };

const POLL_MS = 120_000;
// One immediate retry before reporting offline: a single failed check
// (cold server, dropped packet, one 5xx) must not park the badge on
// "offline" until the next poll or window focus. Only a second
// consecutive failure counts.
const RETRY_MS = 5_000;

/** Connection to the share service, for the top bar. Never throws. */
export function useShareStatus(): ShareStatus {
  const [status, setStatus] = useState<ShareStatus>({ state: "unconfigured" });
  // Reaching a share service on the LAN is local-network traffic on
  // Android: the badge must not fire the permission prompt on a poll.
  const { granted: lanGranted } = useLocalNetworkPermission();

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      let next: ShareStatus = { state: "unconfigured" };
      try {
        const url = await share.getServiceUrl();
        if (url) {
          const token = await share.getSessionToken();
          if (!token) {
            next = { state: "signed_out" };
          } else if (isAndroid() && !lanGranted && isLocalServiceUrl(url)) {
            // A valid session against a service the app is not allowed
            // to reach yet: unreachable, not signed out. The badge
            // flips on its own when the permission is granted (the
            // effect below re-runs the check).
            next = { state: "offline" };
          } else {
            next = (await checkOnline()) ?? next;
          }
        }
      } catch {
        next = { state: "unconfigured" };
      }
      if (!cancelled) setStatus(next);
    };

    /** Online unless the session died (signed out) or two consecutive
     * checks failed (offline). Returns null when unmounted mid-retry. */
    const checkOnline = async (): Promise<ShareStatus | null> => {
      for (let attempt = 0; ; attempt++) {
        try {
          const me = await share.fetchMe();
          return { state: "online", handle: me.handle ?? "" };
        } catch (err) {
          if (err instanceof SessionExpiredError) {
            // The server no longer accepts this session: back to sign-in
            // (callApi already cleared the token through onUnauthorized).
            return { state: "signed_out" };
          }
          if (attempt >= 1 || cancelled) {
            return { state: "offline" };
          }
          await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
          if (cancelled) return null;
        }
      }
    };

    void check();
    const id = window.setInterval(check, POLL_MS);
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    // The shell stays mounted across logout→login (AuthGate hides rather
    // than unmounts), so without these the badge keeps the previous
    // account's handle until the next poll.
    const offStarted = share.onSessionStarted(() => void check());
    const offEnded = share.onSessionEnded(() =>
      setStatus({ state: "signed_out" }),
    );
    return () => {
      cancelled = true;
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
      offStarted();
      offEnded();
    };
    // When the local network permission is granted (or revoked) the
    // check re-runs immediately so the badge reflects the new answer.
  }, [lanGranted]);

  return status;
}
