/**
 * Developer tools (Settings → Diagnostics → Developer tools): the app
 * surfaces for poking at the print pipeline directly — today the raw
 * console at /raw-console. Off by default; the route renders only while
 * the toggle is on, so a bookmark to /raw-console just goes home.
 */
import { useEffect, useState } from "react";
import {
  SETTING_CHANGED_EVENT,
  readCachedSetting,
  readSetting,
} from "./settings";

export const DEV_TOOLS_SETTING = "developer-tools";

const isOn = (v: string | null) => v === "true";

/**
 * Whether the developer tools are on. The cached value paints the first
 * frame; the DB read corrects it; the setting-changed event keeps the
 * route and the toggle in step when the toggle is flipped (writeSetting
 * updates the cache before it fires, so the re-read already sees it).
 */
export function useDeveloperTools(): boolean {
  const [on, setOn] = useState(() =>
    isOn(readCachedSetting(DEV_TOOLS_SETTING)),
  );

  useEffect(() => {
    let cancelled = false;
    void readSetting(DEV_TOOLS_SETTING).then((v) => {
      if (!cancelled) setOn(isOn(v));
    });
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<{ key?: string }>).detail;
      if (detail?.key === DEV_TOOLS_SETTING) {
        setOn(isOn(readCachedSetting(DEV_TOOLS_SETTING)));
      }
    };
    window.addEventListener(SETTING_CHANGED_EVENT, onChange);
    return () => {
      cancelled = true;
      window.removeEventListener(SETTING_CHANGED_EVENT, onChange);
    };
  }, []);

  return on;
}
