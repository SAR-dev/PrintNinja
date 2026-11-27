import { AlertTriangle, Info } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useRenderedPages } from "@/lib/hooks/useRenderedPages";
import { CanvasPane } from "./CanvasPane";
import { MM_TO_PX, ZoomStage, fitZoom, stepZoom } from "./ZoomStage";

export { MM_TO_PX, fitZoom, stepZoom };

interface Props {
  html: string;
  css: string;
  compiledCss: string;
  data: Record<string, unknown>;
  pageWidthMm: number;
  pageHeightMm: number;
  /** One-line note under the toolbar, e.g. that the canvas shows a pack's sample data. */
  sampleNote?: string;
  /** Fill the height of the parent and scroll inside (desktop); otherwise a fixed minimum height. */
  fill?: boolean;
  className?: string;
}

/** The document designer's canvas: the Rust-rendered page inside the shared zoom stage. */
export function CanvasWorkspace({
  html,
  css,
  compiledCss,
  data,
  pageWidthMm,
  pageHeightMm,
  sampleNote,
  fill = false,
  className,
}: Props) {
  const { t } = useTranslation();
  const { pages, error } = useRenderedPages(html, css, compiledCss, [data]);

  const notices = (
    <>
      {error && (
        <div
          role="alert"
          className="flex shrink-0 items-start gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <AlertTriangle
            className="mt-0.5 h-3.5 w-3.5 shrink-0"
            aria-hidden="true"
          />
          <span className="min-w-0 break-words">
            <strong className="font-semibold">
              {t("designer.template_error")}
            </strong>{" "}
            {error}
          </span>
        </div>
      )}
      {sampleNote && (
        <div
          role="status"
          className="flex shrink-0 items-start gap-2 border-b border-info/30 bg-info-soft px-3 py-2 text-xs text-info"
        >
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 break-words">{sampleNote}</span>
        </div>
      )}
    </>
  );

  return (
    <ZoomStage
      pageWidthMm={pageWidthMm}
      pageHeightMm={pageHeightMm}
      fill={fill}
      className={className}
      notices={notices}
    >
      {(zoom) => (
        <CanvasPane
          doc={pages[0] ?? ""}
          width={pageWidthMm * MM_TO_PX}
          height={pageHeightMm * MM_TO_PX}
          zoom={zoom}
        />
      )}
    </ZoomStage>
  );
}
