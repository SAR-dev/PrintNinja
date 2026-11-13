import { useEffect, useRef, useState } from "react";
import { renderDesignPagesRust } from "@/lib/render/rustPreview";

/**
 * Debounce before the Rust preview re-renders; matches the measurement
 * debounce in `useDesignPageCounts` so both settle at the same time.
 */
const RENDER_DEBOUNCE_MS = 150;

export interface RenderedPages {
  /**
   * One document per record; empty until the first render lands, and the
   * previous pages stay up while a new render is in flight, so typing
   * never flashes the preview blank.
   */
  pages: string[];
  /** One-line reason when the template cannot be rendered; null when it can. */
  error: string | null;
}

/**
 * Render the design with the Rust engine (the same one that prints) and
 * keep it fresh.
 *
 * Tauri IPC has no abort, so each scheduled render takes a request id and a
 * late response from an older request is dropped instead of overwriting a
 * newer one.
 */
export function useRenderedPages(
  html: string,
  css: string,
  compiledCss: string | null,
  records: unknown[],
): RenderedPages {
  const [state, setState] = useState<RenderedPages>({ pages: [], error: null });
  const req = useRef(0);
  // A content key, not the array itself: callers pass a fresh array on
  // every render, and re-arming the debounce on identity alone would reset
  // the timer on every unrelated parent render and stall the preview.
  const recordsKey = JSON.stringify(records);

  useEffect(() => {
    const id = ++req.current;
    const timer = window.setTimeout(async () => {
      const result = await renderDesignPagesRust(
        html,
        css,
        records,
        compiledCss,
      );
      if (req.current === id) setState(result);
    }, RENDER_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // `recordsKey` stands in for `records` (see above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, css, compiledCss, recordsKey]);

  return state;
}
