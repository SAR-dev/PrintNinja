import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { renderTemplate } from "@/lib/render/renderTemplate";
import { useDesignPageCounts } from "@/lib/hooks/useDesignPageCounts";
import { Skeleton } from "@/components/ui/skeleton";

interface Props {
  html: string;
  css: string;
  /** The template's compiled Tailwind CSS; "" until the first compile finishes. */
  compiledCss: string;
  /** The sample dataset the page is rendered with. */
  data: Record<string, unknown>;
  /** The page's true size in CSS pixels: page size in mm × 3.7795. Not scaled by zoom. */
  width: number;
  height: number;
  /** How much to scale the page on screen. The page is laid out at its true size and then scaled, so zoom never reflows it. */
  zoom?: number;
}

/** Space between pages, in screen px: a gap, so a page break reads as one. */
const PAGE_GAP = 16;

/**
 * The live page: the template rendered with the chosen sample data.
 *
 * The Height is one page. When the content is taller, the rest continues on
 * further pages of that height, stacked below, exactly as it prints.
 */
export function CanvasPane({
  html,
  css,
  compiledCss,
  data,
  width,
  height,
  zoom = 1,
}: Props) {
  const { t } = useTranslation();
  const doc = useMemo(
    () => renderTemplate(html, css, data, compiledCss),
    [html, css, data, compiledCss],
  );
  const { counts, ready } = useDesignPageCounts([doc], width, height);
  const pages = counts[0] ?? 1;
  const title = t("designer.canvas_preview");

  // Measuring takes a beat (settle + frame load): hold a skeleton until
  // the real page count is known rather than flashing one page first.
  if (!ready) {
    return (
      <div className="flex shrink-0 flex-col" style={{ gap: PAGE_GAP }}>
        <Skeleton
          data-testid="canvas-loading"
          role="status"
          aria-label={t("designer.measuring_pages")}
          style={{ width: width * zoom, height: height * zoom }}
        />
      </div>
    );
  }

  return (
    <div className="flex shrink-0 flex-col" style={{ gap: PAGE_GAP }}>
      {Array.from({ length: pages }, (_, k) => (
        <div key={k} className="flex flex-col gap-1">
          {/* The outer box takes the scaled size so scrolling matches what is drawn. */}
          <div
            className="relative shrink-0 bg-white shadow-md ring-1 ring-border"
            style={{ width: width * zoom, height: height * zoom }}
          >
            <div
              className="relative overflow-hidden"
              style={{
                width,
                height,
                transform: `scale(${zoom})`,
                transformOrigin: "top left",
              }}
            >
              {/* One frame as tall as every page together, moved up to this
                  page; the box around it shows just the one page. */}
              <iframe
                srcDoc={doc}
                sandbox=""
                scrolling="no"
                className="pointer-events-none absolute left-0"
                title={k === 0 ? title : `${title} ${k + 1}`}
                style={{
                  width: "100%",
                  height: `${pages * 100}%`,
                  top: `${-k * 100}%`,
                  border: 0,
                }}
              />
            </div>
          </div>
          {pages > 1 && (
            <span className="text-center text-xs text-muted-foreground">
              {t("designer.page_n_of", { n: k + 1, total: pages })}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
