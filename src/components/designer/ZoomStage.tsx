import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
  type TouchList as ReactTouchList,
} from "react";
import { ZoomIn, ZoomOut } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

/** CSS pixels per millimetre at 96 dpi. */
export const MM_TO_PX = 3.7795;

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;
const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3];
const ZOOM_PRESETS = [0.5, 1];
const PAD_X = 32;
const PAD_Y = 32;
const MAX_FIT = 3;

type ZoomMode = "fit" | number;

/** The zoom that fits the page in the available pane, never above 100% unless it fits both ways. */
export function fitZoom(
  availableWidth: number,
  pageWidthPx: number,
  availableHeight = 0,
  pageHeightPx = 0,
): number {
  if (availableWidth <= 0 || pageWidthPx <= 0) return 1;
  const byWidth = (availableWidth - PAD_X) / pageWidthPx;
  if (availableHeight > 0 && pageHeightPx > 0) {
    const byHeight = (availableHeight - PAD_Y) / pageHeightPx;
    const both = Math.min(byWidth, byHeight);
    if (both > 1) return Math.min(MAX_FIT, both);
  }
  return Math.min(1, Math.max(MIN_ZOOM, byWidth));
}

/** The next zoom step above or below `zoom`, or the same at the range end. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  const eps = 0.001;
  if (direction > 0) return ZOOM_STEPS.find((s) => s > zoom + eps) ?? MAX_ZOOM;
  return [...ZOOM_STEPS].reverse().find((s) => s < zoom - eps) ?? MIN_ZOOM;
}

interface Props {
  pageWidthMm: number;
  pageHeightMm: number;
  /** Fill the parent height and scroll inside; otherwise a fixed minimum height. */
  fill?: boolean;
  className?: string;
  /** Extra controls in the toolbar, next to the zoom group (printer, preview toggle). */
  toolbar?: ReactNode;
  /** Notices below the toolbar (template errors, sample-data notes). */
  notices?: ReactNode;
  /** The page content, drawn at the current zoom. */
  children: (zoom: number) => ReactNode;
}

/**
 * The shared canvas chrome: title, zoom controls and the scroll area.
 * Both designers render their own page inside it, so zoom, Fit and touch
 * gestures behave exactly the same on the document and label tracks.
 */
export function ZoomStage({
  pageWidthMm,
  pageHeightMm,
  fill = false,
  className,
  toolbar,
  notices,
  children,
}: Props) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<ZoomMode>("fit");
  const [areaWidth, setAreaWidth] = useState(0);
  const [areaHeight, setAreaHeight] = useState(0);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      setAreaWidth(el.clientWidth);
      setAreaHeight(fill ? el.clientHeight : 0);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fill]);

  const pageWidth = pageWidthMm * MM_TO_PX;
  const pageHeight = pageHeightMm * MM_TO_PX;
  const zoom =
    mode === "fit"
      ? fitZoom(areaWidth, pageWidth, areaHeight, pageHeight)
      : mode;
  const pct = Math.round(zoom * 100);
  const isPreset = mode !== "fit" && ZOOM_PRESETS.includes(mode);
  const selectValue =
    mode === "fit" ? "fit" : isPreset ? String(mode) : "custom";

  const gesture = useRef<{
    startDist: number;
    startZoom: number;
    multi: boolean;
  } | null>(null);
  const tap = useRef<{ at: number; x: number; y: number } | null>(null);
  const lastTapAt = useRef(0);
  const touchDist = (touches: ReactTouchList) =>
    Math.hypot(
      touches[0].clientX - touches[1].clientX,
      touches[0].clientY - touches[1].clientY,
    );
  const onTouchStart = (e: ReactTouchEvent) => {
    if (e.touches.length === 2) {
      gesture.current = {
        startDist: touchDist(e.touches),
        startZoom: zoom,
        multi: true,
      };
      tap.current = null;
    } else if (e.touches.length === 1 && !gesture.current) {
      const t = e.touches[0];
      tap.current = { at: Date.now(), x: t.clientX, y: t.clientY };
    } else if (gesture.current) {
      gesture.current.multi = true;
      tap.current = null;
    }
  };
  const onTouchMove = (e: ReactTouchEvent) => {
    const g = gesture.current;
    if (g && e.touches.length === 2 && g.startDist > 0) {
      setMode(
        Math.min(
          MAX_ZOOM,
          Math.max(
            MIN_ZOOM,
            (g.startZoom * touchDist(e.touches)) / g.startDist,
          ),
        ),
      );
    }
  };
  const onTouchEnd = (e: ReactTouchEvent) => {
    if (e.touches.length > 0) return;
    const g = gesture.current;
    gesture.current = null;
    const tp = tap.current;
    tap.current = null;
    if (g?.multi || !tp) return;
    if (Date.now() - tp.at > 250) return;
    const now = Date.now();
    if (now - lastTapAt.current < 300) {
      lastTapAt.current = 0;
      setMode((m) => (m === "fit" ? 1 : "fit"));
    } else {
      lastTapAt.current = now;
    }
  };

  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden rounded-lg border bg-card",
        fill && "h-full",
        className,
      )}
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-3 py-1.5">
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">
            {t("designer.canvas")}
          </span>
          <span className="block text-xs text-muted-foreground">
            {t("designer.canvas_size", { w: pageWidthMm, h: pageHeightMm })}
          </span>
        </span>
        <div className="flex flex-wrap items-center gap-2">
          {toolbar}
          <div className="inline-flex h-8 items-center overflow-hidden rounded-md border border-input bg-background">
            <Select
              value={selectValue}
              onValueChange={(v) => {
                if (v === "fit") setMode("fit");
                else if (v !== "custom") setMode(Number(v));
              }}
            >
              <SelectTrigger
                aria-label={t("designer.zoom_level")}
                className="h-full w-[4.5rem] rounded-none border-0 bg-transparent px-2.5 text-xs shadow-none ring-offset-0 focus:ring-inset focus:ring-offset-0"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fit">{t("designer.zoom_fit")}</SelectItem>
                {ZOOM_PRESETS.map((p) => (
                  <SelectItem key={p} value={String(p)}>
                    {Math.round(p * 100)}%
                  </SelectItem>
                ))}
                {selectValue === "custom" && (
                  <SelectItem value="custom">{pct}%</SelectItem>
                )}
              </SelectContent>
            </Select>
            <span className="h-4 w-px bg-border" aria-hidden="true" />
            <Button
              variant="ghost"
              size="icon"
              className="h-full w-8 rounded-none"
              aria-label={t("designer.zoom_out")}
              title={t("designer.zoom_out")}
              disabled={zoom <= MIN_ZOOM + 0.001}
              onClick={() => setMode(stepZoom(zoom, -1))}
            >
              <ZoomOut className="h-4 w-4" />
            </Button>
            <span
              className="w-12 text-center text-xs tabular-nums"
              aria-live="polite"
            >
              {pct}%
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-full w-8 rounded-none"
              aria-label={t("designer.zoom_in")}
              title={t("designer.zoom_in")}
              disabled={zoom >= MAX_ZOOM - 0.001}
              onClick={() => setMode(stepZoom(zoom, 1))}
            >
              <ZoomIn className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
      {notices}
      <div
        ref={scrollRef}
        data-testid="canvas-scroll"
        role="region"
        aria-label={t("designer.canvas")}
        tabIndex={0}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        className={cn(
          "flex overflow-auto bg-muted p-4 [background-image:radial-gradient(hsl(var(--border))_1px,transparent_1px)] [background-size:16px_16px] [scrollbar-gutter:stable] [touch-action:pan-x_pan-y]",
          fill ? "min-h-0 flex-1" : "min-h-[62dvh]",
        )}
      >
        <div className="m-auto">{children(zoom)}</div>
      </div>
    </div>
  );
}
