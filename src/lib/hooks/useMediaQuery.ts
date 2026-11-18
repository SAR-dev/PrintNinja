import { useEffect, useState } from "react";

/** Tailwind's `lg` breakpoint: the desktop workspace starts here. */
export const DESKTOP_QUERY = "(min-width: 1024px)";

/** Wide enough to show the Designer's controls column at full width; narrower desktops get the icon rail. */
export const WIDE_QUERY = "(min-width: 1440px)";

/** Below Tailwind's `md`: phone portrait, where the shell uses the bottom bar. */
export const PHONE_QUERY = "(max-width: 767px)";

/**
 * The "middle" desktop band (DESIGN_IMPROVEMENTS 4.1): wide enough for the
 * desktop shell (sidebar + top bar) but too narrow for the full 224px
 * sidebar and the wide tables. The shell collapses to the icon rail here,
 * and `DataTable` falls back to its card list (see `CARD_QUERY`).
 */
export const NARROW_QUERY = "(min-width: 768px) and (max-width: 1099px)";

/**
 * Below the width where full desktop tables fit: phones (below `md`) and the
 * narrow band both render `DataTable` rows as cards. Kept as a positive
 * `max-width` so jsdom (no `matchMedia`) still resolves to the table.
 */
export const CARD_QUERY = "(max-width: 1099px)";

/**
 * Landscape phone: narrow height with a coarse pointer (about 844×390 CSS
 * px). The shell keys off this as well as width: the sidebar starts
 * collapsed and the wide search field hides.
 */
export const LANDSCAPE_QUERY = "(pointer: coarse) and (max-height: 500px)";

const read = (query: string) =>
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(query).matches
    : false;

/** Whether a CSS media query currently matches; updates when it changes. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => read(query));
  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    )
      return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}
