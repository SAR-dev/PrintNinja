import { useEffect, useRef } from "react";
import { agent } from "@/lib/agent/commands";

/**
 * One place that starts and stops the local API server and tells every
 * screen that shows its status (topbar badge, Automation → Server and
 * Explorer tabs, the Phones card) to re-read it. Before this, each screen
 * read `get_api_status` once and went stale when another one changed
 * the server.
 */

export const API_STATUS_EVENT = "api-status:changed";

/** Safety net for changes made outside the UI (autostart at boot, a
 * server that stopped on its own). */
const POLL_MS = 5000;

export function notifyApiStatusChanged(): void {
  window.dispatchEvent(new Event(API_STATUS_EVENT));
}

export async function startApiServer(
  port: number,
  lanAccess: boolean,
): Promise<string> {
  try {
    return await agent("start_api_server", { port, lan_access: lanAccess });
  } finally {
    notifyApiStatusChanged();
  }
}

export async function stopApiServer(): Promise<void> {
  try {
    await agent("stop_api_server", {});
  } finally {
    notifyApiStatusChanged();
  }
}

/** Run `refresh` whenever the API server may have changed: after any
 * start/stop through this module, when the window regains focus, and on
 * a slow poll while the window is visible. The caller still does its own
 * first load. */
export function useApiStatusChanged(refresh: () => void | Promise<void>): void {
  const latest = useRef(refresh);
  useEffect(() => {
    latest.current = refresh;
  });
  useEffect(() => {
    const run = () => {
      void latest.current();
    };
    const tick = () => {
      if (document.visibilityState !== "hidden") run();
    };
    window.addEventListener(API_STATUS_EVENT, run);
    window.addEventListener("focus", run);
    const timer = window.setInterval(tick, POLL_MS);
    return () => {
      window.removeEventListener(API_STATUS_EVENT, run);
      window.removeEventListener("focus", run);
      window.clearInterval(timer);
    };
  }, []);
}
