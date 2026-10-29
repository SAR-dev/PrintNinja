/**
 * Content-driven pagination for design pages.
 *
 * A design's Height is the height of one page. When a record's content is
 * taller (a long item list, say) the rest continues on further pages of that
 * height instead of being clipped. Only the browser knows how tall the content
 * is, so it is measured here by laying the finished document out once at the
 * design's own width and height.
 *
 * This is the TypeScript half of the `PAGINATE_SCRIPT` in
 * `src-tauri/src/render/layout.rs`: the PDF measures the same way (a frame at
 * the design size, `scrollHeight`, a one pixel tolerance) and shows page `k` of
 * `n` the same way (a frame `n` pages tall, shifted up `k` pages and clipped to
 * one), so the preview shows the pages that print.
 */

/** CSS pixels per millimetre at 96 dpi (the constant the Designer canvas uses). */
export const MM_TO_PX = 3.7795;

/** Same cap as `MAX_SHEETS_PER_DESIGN` in printLayout.ts and layout.rs. */
export const MAX_PAGES_PER_DESIGN = 200;

/** Content may overshoot a page by this many px before it needs another one. */
const TOLERANCE_PX = 1;

/** How long to wait for a frame to load, or for its web fonts, before giving up. */
const LOAD_TIMEOUT_MS = 4000;
const FONT_TIMEOUT_MS = 1500;

/** How many pages `contentHeightPx` of content takes at `pageHeightPx` per page. */
export function pageCount(
  contentHeightPx: number,
  pageHeightPx: number,
  maxPages = MAX_PAGES_PER_DESIGN,
): number {
  if (
    !Number.isFinite(contentHeightPx) ||
    !Number.isFinite(pageHeightPx) ||
    pageHeightPx <= 0
  )
    return 1;
  const n = Math.ceil((contentHeightPx - TOLERANCE_PX) / pageHeightPx);
  return Math.max(1, Math.min(n || 1, Math.max(1, maxPages)));
}

/**
 * How page `k` of `n` is cut out of a frame `n` pages tall: the frame is moved
 * up by `k` pages and everything outside page `k` is clipped away.
 * All lengths are in the units of `pageHeight`.
 */
export interface PageWindow {
  /** Height of the frame: every page of the record in one column. */
  frameHeight: number;
  /** How far the frame moves up, before any scaling. */
  shift: number;
  /** `clip-path` inset, from the top and bottom of the frame; "" for a single page. */
  clipPath: string;
}

export function pageWindow(
  k: number,
  n: number,
  pageHeight: number,
  unit: "px" | "mm",
): PageWindow {
  const r = (v: number) => Math.round(v * 1e4) / 1e4;
  return {
    frameHeight: r(pageHeight * n),
    shift: r(pageHeight * k),
    clipPath:
      n > 1
        ? `inset(${r(k * pageHeight)}${unit} 0 ${r((n - k - 1) * pageHeight)}${unit} 0)`
        : "",
  };
}

const cache = new Map<string, number>();
const CACHE_LIMIT = 64;

function remember(key: string, value: number) {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T) =>
  new Promise<T>((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(fallback);
      },
    );
  });

/**
 * The height, in CSS px, that `doc` needs when laid out in a frame
 * `widthPx` × `heightPx`; never less than `heightPx` (the browser pads a short
 * page up to the frame). Resolves 0 when it cannot be measured.
 *
 * The measuring frame is `sandbox="allow-same-origin"` so the page can read
 * its layout. It still cannot run a script (`allow-scripts` is absent, the
 * document's CSP forbids them, and `sanitizeForRender` has stripped them), so
 * the template stays as inert as in the sandboxed frames that display it.
 */
export function measureContentHeightPx(
  doc: string,
  widthPx: number,
  heightPx: number,
): Promise<number> {
  const key = `${Math.round(widthPx)}x${Math.round(heightPx)}\n${doc}`;
  const hit = cache.get(key);
  if (hit !== undefined) return Promise.resolve(hit);
  if (typeof document === "undefined" || !document.body)
    return Promise.resolve(0);

  return new Promise<number>((resolve) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-same-origin");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    Object.assign(frame.style, {
      position: "fixed",
      left: "-100000px",
      top: "0",
      width: `${widthPx}px`,
      height: `${heightPx}px`,
      border: "0",
      visibility: "hidden",
      pointerEvents: "none",
    });

    let done = false;
    const finish = (h: number) => {
      if (done) return;
      done = true;
      clearTimeout(giveUp);
      frame.remove();
      if (h > 0) remember(key, h);
      resolve(h);
    };
    const giveUp = setTimeout(() => finish(0), LOAD_TIMEOUT_MS);

    frame.addEventListener("load", () => {
      void (async () => {
        try {
          const d = frame.contentDocument;
          if (!d || !d.documentElement) return finish(0);
          // A web font can change how much the text wraps, so wait for it.
          if (d.fonts?.ready)
            await withTimeout(d.fonts.ready, FONT_TIMEOUT_MS, null);
          finish(
            Math.max(
              d.documentElement.scrollHeight,
              d.body ? d.body.scrollHeight : 0,
            ),
          );
        } catch {
          finish(0);
        }
      })();
    });
    frame.srcdoc = doc;
    document.body.appendChild(frame);
  });
}
