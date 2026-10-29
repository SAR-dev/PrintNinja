import { useCallback, useEffect, useRef, useState } from "react";
import { agent } from "@/lib/agent/commands";
import type { ApiStatus, RenderShareStatus } from "@/lib/agent/types";
import { useApiStatusChanged } from "@/lib/apiServer";
import { useSettingChanged } from "@/lib/hooks/useSettingChanged";
import { isPrintViaPc } from "@/lib/printViaPc";
import { readSetting } from "@/lib/settings";

/**
 * Everything the top bar reports about switches that change how the app
 * behaves, in one place, so each switch has one badge and one refresh path.
 */
export interface ShellStatus {
  /** Local API server; null when it cannot be read. */
  api: ApiStatus | null;
  /** This PC is live as a renderer for phones (needs server + LAN). */
  sharing: boolean;
  /** This phone prints through a paired PC. */
  viaPc: boolean;
  /** "Block private IPs" is switched off. */
  privateOpen: boolean;
}

/** Consecutive failed reads before the API badge is allowed to vanish. A
 * single hiccup must not hide a LAN alert. */
export const API_STATUS_FAILURES_BEFORE_HIDE = 3;

/** The saved sharing preference is not enough: with the server stopped
 * or LAN access off, no phone can reach this PC. Same rule as the
 * switch on Automation → Phones. */
export function isSharingLive(
  s: Pick<RenderShareStatus, "enabled" | "running" | "lan_access"> | null,
): boolean {
  return !!s && s.enabled && s.running && s.lan_access;
}

const FLAG_KEYS = ["print_via_pc", "block_private_ips"] as const;

export function useShellStatus(pathname: string): ShellStatus {
  const [api, setApi] = useState<ApiStatus | null>(null);
  const [sharing, setSharing] = useState(false);
  const [viaPc, setViaPc] = useState(false);
  const [privateOpen, setPrivateOpen] = useState(false);
  const failures = useRef(0);

  const loadServer = useCallback(async () => {
    try {
      const s = await agent("get_api_status", {});
      failures.current = 0;
      setApi(s ?? null);
    } catch {
      // Keep the last known state through a transient error.
      failures.current += 1;
      if (failures.current >= API_STATUS_FAILURES_BEFORE_HIDE) setApi(null);
    }
    try {
      const r = await agent("get_render_status", {});
      setSharing(isSharingLive(r ?? null));
    } catch {
      setSharing(false);
    }
  }, []);

  const loadFlags = useCallback(async () => {
    try {
      setViaPc(await isPrintViaPc());
    } catch {
      /* keep last */
    }
    try {
      // Default is "blocked" (true): only an explicit "false" is a warning.
      setPrivateOpen((await readSetting("block_private_ips")) === "false");
    } catch {
      /* keep last */
    }
  }, []);

  useApiStatusChanged(loadServer);
  useEffect(() => {
    void loadServer();
  }, [loadServer, pathname]);
  useEffect(() => {
    void loadFlags();
  }, [loadFlags, pathname]);
  useSettingChanged(FLAG_KEYS, () => void loadFlags());
  useEffect(() => {
    window.addEventListener("focus", loadFlags);
    return () => window.removeEventListener("focus", loadFlags);
  }, [loadFlags]);

  return { api, sharing, viaPc, privateOpen };
}
