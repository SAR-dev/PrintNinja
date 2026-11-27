/**
 * The rendered pages of a prepared label: each 1-bit bitmap page drawn
 * as an svg of its dark dots (run-lengthed per row, so a label with a
 * line of text costs a few dozen rects, not a pixel each). Pdf pages
 * have no bitmap to draw, so a note stands in for them.
 */
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { LabelPreview } from "@/lib/agent/types";

const INK = "#18181b";
/** Above this many pixels the svg would carry hundreds of thousands of
 * rects; a note is cheaper than that. */
const MAX_PIXELS = 2_000_000;

/** Rows are packed to whole bytes; index by row stride, not pixel width. */
const rowBytes = (width: number) => Math.ceil(width / 8);
const bit = (packed: number[], width: number, x: number, y: number) =>
  (packed[y * rowBytes(width) + (x >> 3)] >> (7 - (x & 7))) & 1;

function BitmapPage({
  preview,
}: {
  preview: Extract<LabelPreview, { kind: "bitmap" }>;
}) {
  const { t } = useTranslation();
  if (preview.width * preview.height > MAX_PIXELS) {
    return (
      <p className="rounded-md bg-muted px-3 py-2 text-body-sm text-muted-foreground">
        {t("scene.preview_unavailable")}
      </p>
    );
  }
  const rects: ReactNode[] = [];
  for (let y = 0; y < preview.height; y++) {
    let x = 0;
    while (x < preview.width) {
      while (x < preview.width && !bit(preview.packed, preview.width, x, y))
        x++;
      if (x >= preview.width) break;
      const start = x;
      while (x < preview.width && bit(preview.packed, preview.width, x, y)) x++;
      rects.push(
        <rect
          key={`${y}-${start}`}
          x={start}
          y={y}
          width={x - start}
          height={1}
        />,
      );
    }
  }
  return (
    <svg
      viewBox={`0 0 ${preview.width} ${preview.height}`}
      style={{ width: "100%", maxWidth: 240 }}
      className="rounded-md border border-border"
      role="img"
      aria-label={t("scene.preview")}
    >
      <rect width={preview.width} height={preview.height} fill="#ffffff" />
      <g fill={INK}>{rects}</g>
    </svg>
  );
}

export function SceneBitmapPreview({ previews }: { previews: LabelPreview[] }) {
  const { t } = useTranslation();
  const bitmaps = previews.filter(
    (p): p is Extract<LabelPreview, { kind: "bitmap" }> => p.kind === "bitmap",
  );
  const hasPdf = previews.some((p) => p.kind === "pdf");
  return (
    <div className="flex flex-col gap-3">
      {bitmaps.map((p, i) => (
        <BitmapPage key={i} preview={p} />
      ))}
      {hasPdf && (
        <p className="rounded-md bg-muted px-3 py-2 text-body-sm text-muted-foreground">
          {t("scene.preview_pdf_note")}
        </p>
      )}
    </div>
  );
}
