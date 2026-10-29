import { useEffect } from "react";

const FLASH = [
  "ring-2",
  "ring-primary",
  "ring-offset-2",
  "ring-offset-background",
  "rounded-md",
];

/**
 * Palette deep-link (`?field=`): scroll the control into view and flash
 * it. The ring is temporary: it only orients, the control is unchanged.
 *
 * The target may not exist yet (a tab that just mounted, a card that
 * loads its state first), so a missing element is retried for ~2 s
 * instead of giving up on the first render. `deps` re-arm the effect,
 * for example when the tab or loading gate changes.
 */
export function useFlashField(
  field: string | null,
  enabled: boolean,
  deps: ReadonlyArray<unknown> = [],
): void {
  useEffect(() => {
    if (!field || !enabled) return;
    let removeTimer: number | undefined;
    let retryTimer: number | undefined;
    let el: HTMLElement | null = null;
    let tries = 0;
    const attempt = () => {
      el = document.getElementById(field);
      if (!el) {
        if (++tries < 14) retryTimer = window.setTimeout(attempt, 150);
        return;
      }
      if (typeof el.scrollIntoView === "function") {
        el.scrollIntoView({ block: "center" });
      }
      el.classList.add(...FLASH);
      const target = el;
      removeTimer = window.setTimeout(
        () => target.classList.remove(...FLASH),
        2400,
      );
    };
    attempt();
    return () => {
      window.clearTimeout(retryTimer);
      window.clearTimeout(removeTimer);
      el?.classList.remove(...FLASH);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field, enabled, ...deps]);
}
