import { useEffect, useRef } from "react";
import { registerRefreshable, type RefreshPart } from "./registry";

/**
 * Register this component with the shared manual refresh while it is on
 * screen. The callbacks are read through a ref on each refresh, so the
 * registration never needs re-creating; unmounting drops it, so
 * navigating away mid-refresh leaves nothing to update.
 *
 * `skipReason` lets a part decline with a message instead of dialing a
 * network it cannot use (Android's local network permission off).
 */
export function useRefreshable(
  id: string,
  opts: {
    label: () => string;
    run: () => Promise<void> | void;
    skipReason?: () => string | null;
    active?: () => boolean;
  },
) {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    const part: RefreshPart = {
      id,
      label: () => optsRef.current.label(),
      run: () => optsRef.current.run(),
      skipReason: () => optsRef.current.skipReason?.() ?? null,
      active: () => optsRef.current.active?.() ?? true,
    };
    return registerRefreshable(part);
  }, [id]);
}
