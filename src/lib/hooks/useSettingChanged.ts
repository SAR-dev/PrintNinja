import { useEffect, useRef } from "react";
import { SETTING_CHANGED_EVENT } from "@/lib/settings";

/** Run `onChange` whenever one of `keys` is written through `writeSetting`. */
export function useSettingChanged(
  keys: readonly string[],
  onChange: (key: string) => void,
): void {
  const latest = useRef(onChange);
  useEffect(() => {
    latest.current = onChange;
  });
  const joined = keys.join("|");
  useEffect(() => {
    const wanted = joined.split("|");
    const handler = (e: Event) => {
      const key = (e as CustomEvent<{ key?: string }>).detail?.key;
      if (key && wanted.includes(key)) latest.current(key);
    };
    window.addEventListener(SETTING_CHANGED_EVENT, handler);
    return () => window.removeEventListener(SETTING_CHANGED_EVENT, handler);
  }, [joined]);
}
