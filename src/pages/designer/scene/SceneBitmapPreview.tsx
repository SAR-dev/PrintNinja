/**
 * The rendered pages of a prepared label. Each page is a 1-bit bitmap;
 * draw it straight into a canvas with putImageData rather than one SVG
 * rect per ink run, so even a 300 dpi 4×6 label renders instantly.
 */
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { LabelPreview } from "@/lib/agent/types";

/** Rows are packed to whole bytes; index by row stride, not pixel width. */
const rowBytes = (width: number) => Math.ceil(width / 8);
const bit = (packed: number[], width: number, x: number, y: number) =>
  (packed[y * rowBytes(width) + (x >> 3)] >> (7 - (x & 7))) & 1;

function BitmapPage({
  preview,
  index,
  total,
}: {
  preview: Extract<LabelPreview, { kind: "bitmap" }>;
  index: number;
  total: number;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const image = ctx.createImageData(preview.width, preview.height);
    for (let y = 0; y < preview.height; y++) {
      for (let x = 0; x < preview.width; x++) {
        const i = (y * preview.width + x) * 4;
        const ink = bit(preview.packed, preview.width, x, y) ? 0x18 : 0xff;
        image.data[i] = ink;
        image.data[i + 1] = ink;
        image.data[i + 2] = ink;
        image.data[i + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
  }, [preview]);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-caption text-muted-foreground">
        <span>{t("designer.page_n_of", { n: index + 1, total })}</span>
        <span>
          {preview.width_mm} × {preview.height_mm} mm
        </span>
      </div>
      <canvas
        ref={ref}
        width={preview.width}
        height={preview.height}
        className="w-full rounded-md border border-border bg-white"
        style={{ imageRendering: "pixelated" }}
        role="img"
        aria-label={t("scene.preview")}
      />
    </div>
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
        <BitmapPage key={i} preview={p} index={i} total={bitmaps.length} />
      ))}
      {hasPdf && (
        <p className="rounded-md bg-muted px-3 py-2 text-body-sm text-muted-foreground">
          {t("scene.preview_pdf_note")}
        </p>
      )}
    </div>
  );
}
