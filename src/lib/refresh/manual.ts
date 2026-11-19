import { useSyncExternalStore } from "react";
import i18next from "i18next";
import { notifyError, notifyInfo, notifySuccess } from "@/lib/notify";
import { refreshAll } from "./registry";

let running = false;
const listeners = new Set<() => void>();

const setRunning = (value: boolean) => {
  if (running === value) return;
  running = value;
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * The one manual refresh: the server cache sync, then every on-screen
 * page's refresher, with a toast on the outcome. One at a time — a tap
 * while one is running is ignored. Every entry point (the topbar
 * refresh, page header buttons, the command palette, pull-to-refresh
 * and Settings' "Refresh cache") calls this, so they share the same
 * spinning state and the same feedback.
 */
export async function manualRefresh(): Promise<void> {
  if (running) return;
  setRunning(true);
  try {
    const result = await refreshAll({ force: true });
    const failed: string[] = [];
    if (result.core.attempted && !result.core.ok) {
      failed.push(i18next.t("shell.refresh_server"));
    }
    for (const part of result.parts) {
      if (part.status === "failed") failed.push(part.label);
    }
    if (failed.length === 0) {
      notifySuccess(i18next.t("shell.refresh_up_to_date"));
    } else {
      notifyError(
        i18next.t("shell.refresh_failed", { what: failed.join(", ") }),
        {
          action: {
            label: i18next.t("shell.retry"),
            onClick: () => void manualRefresh(),
          },
        },
      );
    }
    // A part may decline with a reason (the local network permission is
    // off) — say so without calling it a failure.
    for (const part of result.parts) {
      if (part.status === "skipped" && part.detail) {
        notifyInfo(part.detail, { id: `refresh-skipped:${part.id}` });
      }
    }
  } finally {
    setRunning(false);
  }
}

/**
 * Spinning state shared by every refresh entry point.
 */
export function useManualRefresh(): {
  refreshing: boolean;
  run: () => void;
} {
  const refreshing = useSyncExternalStore(subscribe, () => running);
  return { refreshing, run: () => void manualRefresh() };
}
