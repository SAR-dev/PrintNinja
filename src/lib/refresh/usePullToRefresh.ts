import { useEffect, useRef, useState, type RefObject } from "react";

const THRESHOLD = 72;
const MAX_PULL = 120;

/**
 * Android pull-to-refresh on a scroll container: pulling down at the top
 * of the scroll shows a spinner, and releasing past the threshold runs
 * the shared manual refresh. `onRefresh` left undefined switches it off
 * (not Android, or a viewport-filling page whose container does not
 * scroll). The hook never fires while a refresh is already running —
 * the shared manual refresh ignores a second start.
 */
export function usePullToRefresh(
  scroller: RefObject<HTMLElement | null>,
  onRefresh?: () => void,
) {
  const [pull, setPull] = useState(0);
  const pullRef = useRef(0);
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let startY = 0;
    let pulling = false;

    const set = (v: number) => {
      pullRef.current = v;
      setPull(v);
    };
    const onStart = (e: TouchEvent) => {
      if (refreshRef.current == null || e.touches.length !== 1) return;
      // A container that does not scroll (the designer fills its
      // viewport on wide screens) has no top to pull from.
      if (getComputedStyle(el).overflowY === "hidden") return;
      pulling = el.scrollTop <= 0;
      startY = e.touches[0].clientY;
    };
    const onMove = (e: TouchEvent) => {
      if (!pulling) return;
      const dy = e.touches[0].clientY - startY;
      if (dy <= 0 || el.scrollTop > 0) {
        pulling = false;
        set(0);
        return;
      }
      e.preventDefault();
      set(Math.min(MAX_PULL, dy * 0.5));
    };
    const onEnd = () => {
      if (!pulling) return;
      pulling = false;
      const past = pullRef.current >= THRESHOLD;
      set(0);
      if (past) refreshRef.current?.();
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [scroller]);

  return { pull, threshold: THRESHOLD };
}
