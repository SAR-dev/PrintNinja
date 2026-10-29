import { useEffect, useState } from "react";
import {
  measureContentHeightPx,
  pageCount,
  MAX_PAGES_PER_DESIGN,
} from "@/lib/render/paginate";

/** Typing in the editor re-renders the document on every keystroke; measure once it settles. */
const SETTLE_MS = 150;

/**
 * How many pages each document takes at a page size of `widthPx` × `heightPx`.
 * Starts at one page per document and settles on the measured count, so the
 * first paint is never blocked on a measurement. A document that cannot be
 * measured stays one page.
 */
export function useDesignPageCounts(
  docs: string[],
  widthPx: number,
  heightPx: number,
  maxPages = MAX_PAGES_PER_DESIGN,
): number[] {
  const [counts, setCounts] = useState<number[]>([]);

  // Identical documents (one template, many records) share a measurement.
  const key = `${widthPx}x${heightPx}x${maxPages}\u0000${docs.join("\u0001")}`;

  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      void (async () => {
        const heights = new Map<string, number>();
        for (const d of docs) {
          if (!heights.has(d))
            heights.set(d, await measureContentHeightPx(d, widthPx, heightPx));
        }
        if (!live) return;
        const next = docs.map((d) =>
          pageCount(heights.get(d) ?? 0, heightPx, maxPages),
        );
        setCounts((prev) =>
          prev.length === next.length && prev.every((v, i) => v === next[i])
            ? prev
            : next,
        );
      })();
    }, SETTLE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // `key` stands for docs, which is a new array on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Until measured (or after the documents changed length) one page each.
  return docs.map((_, i) => counts[i] ?? 1);
}
