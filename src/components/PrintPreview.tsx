import { useEffect, useMemo, useRef, useState } from "react";
import { computePrintLayout, type Margins } from "@/lib/render/printLayout";
import {
  MAX_PAGES_PER_DESIGN,
  MM_TO_PX,
  pageWindow,
} from "@/lib/render/paginate";
import { useDesignPageCounts } from "@/lib/hooks/useDesignPageCounts";
import { Skeleton } from "@/components/ui/skeleton";
import { useTranslation } from "react-i18next";

/** Space around the sheets inside the scroll area (Tailwind p-4, both sides). */
const PAD_X = 32;

/** A very tall design on a big record count must not mount hundreds of frames. */
export const MAX_PREVIEW_SHEETS = 24;

interface Props {
  /**
   * One complete HTML document per record, each laid out as the Designer
   * canvas lays it out (no paper, no margins, no scaling).
   */
  pages: string[];
  /** The template's design size, mm. Never swapped for orientation. */
  designW: number;
  designH: number;
  /** The physical sheet, mm, already swapped for landscape. */
  paperW: number;
  paperH: number;
  margins: Margins;
  fitMode: string;
  grayscale?: boolean;
  /** Accessible name of the first sheet; later sheets get their number. */
  title: string;
}

/**
 * What will come out of the printer: every record's design page, shown at the
 * design's own size and then scaled and positioned on a sheet of the selected
 * paper by the same rules the PDF uses (`computePrintLayout`, mirrored by
 * `render::layout::compute` in Rust). The design is never re-laid out at the
 * paper size, so its aspect ratio and line breaks match the Designer.
 */
export function PrintPreview({
  pages,
  designW,
  designH,
  paperW,
  paperH,
  margins,
  fitMode,
  grayscale = false,
  title,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [hostWidth, setHostWidth] = useState(0);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const measure = () => setHostWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { top, right, bottom, left } = margins;
  const layout = useMemo(
    () =>
      computePrintLayout(fitMode, designW, designH, paperW, paperH, {
        top,
        right,
        bottom,
        left,
      }),
    [fitMode, designW, designH, paperW, paperH, top, right, bottom, left],
  );

  // A design's Height is one page; content taller than that continues on
  // further pages of the same height (see lib/render/paginate.ts), each placed
  // on the sheet exactly as page one is.
  const designWpx = designW * MM_TO_PX;
  const designHpx = designH * MM_TO_PX;
  const { counts: pageCounts, ready: pagesReady } = useDesignPageCounts(
    pages,
    designWpx,
    designHpx,
    Math.max(1, Math.floor(MAX_PAGES_PER_DESIGN / layout.placements.length)),
  );

  const sheets = useMemo(() => {
    const out: {
      doc: string;
      offsetX: number;
      offsetY: number;
      /** Which page of the record this sheet shows, of how many. */
      page: number;
      pages: number;
    }[] = [];
    for (let i = 0; i < pages.length; i++) {
      const n = pageCounts[i] ?? 1;
      for (let k = 0; k < n; k++) {
        for (const p of layout.placements) {
          if (out.length >= MAX_PREVIEW_SHEETS) return out;
          out.push({
            doc: pages[i],
            offsetX: p.offsetX,
            // Page k sits one page (as drawn on the paper) higher up the frame.
            offsetY: p.offsetY - k * layout.drawH,
            page: k,
            pages: n,
          });
        }
      }
    }
    return out;
  }, [pages, pageCounts, layout]);

  const paperWpx = paperW * MM_TO_PX;
  const paperHpx = paperH * MM_TO_PX;
  // Shrink a wide sheet to the space it has; never enlarge it. Width is 0
  // before the first measurement (and in jsdom): show the sheet at full size.
  const shown = hostWidth > 0 ? Math.min(1, (hostWidth - PAD_X) / paperWpx) : 1;
  const display = Math.max(0.05, shown);

  // Measuring takes a beat: hold one skeleton sheet until every record's
  // page count is known rather than flashing a premature single sheet.
  // No data-testid here: it must not shadow the real preview's one.
  const { t } = useTranslation();
  if (!pagesReady) {
    return (
      <div ref={hostRef} className="flex flex-col items-center gap-4">
        <Skeleton
          data-testid="print-preview-loading"
          role="status"
          aria-label={t("designer.measuring_pages")}
          style={{ width: paperWpx * display, height: paperHpx * display }}
        />
      </div>
    );
  }

  return (
    <div
      ref={hostRef}
      data-testid="print-preview"
      data-fit-mode={fitMode}
      data-scale={layout.scale.toFixed(4)}
      className="flex flex-col items-center gap-4"
    >
      {sheets.map((sheet, i) => (
        <div
          key={i}
          data-testid="print-sheet"
          className="relative shrink-0 bg-white shadow-md ring-1 ring-border"
          // The outer box takes the scaled size so scrolling matches what is drawn.
          style={{ width: paperWpx * display, height: paperHpx * display }}
        >
          <div
            className="relative"
            style={{
              width: paperWpx,
              height: paperHpx,
              transform: `scale(${display})`,
              transformOrigin: "top left",
              filter: grayscale ? "grayscale(1)" : undefined,
            }}
          >
            {/* The printable area: paper minus margins. Anything the fit mode
                pushes outside it (fill's crop, the next sheet's slice) is cut
                off here, as it is in the PDF. */}
            <div
              className="absolute overflow-hidden"
              style={{
                left: layout.contentX * MM_TO_PX,
                top: layout.contentY * MM_TO_PX,
                width: layout.contentW * MM_TO_PX,
                height: layout.contentH * MM_TO_PX,
              }}
            >
              <iframe
                srcDoc={sheet.doc}
                sandbox=""
                title={i === 0 ? title : `${title} ${i + 1}`}
                className="pointer-events-none absolute border-0"
                style={{
                  left: sheet.offsetX * MM_TO_PX,
                  top: sheet.offsetY * MM_TO_PX,
                  // The frame is the design's own size, like the Designer
                  // canvas; only the transform scales it onto the paper.
                  // With several pages it is that many pages tall and
                  // clipped to the one this sheet shows.
                  width: designWpx,
                  height: designHpx * sheet.pages,
                  transform: `scale(${layout.scale})`,
                  transformOrigin: "top left",
                  clipPath:
                    pageWindow(sheet.page, sheet.pages, designHpx, "px")
                      .clipPath || undefined,
                }}
              />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
