import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PrintPreview } from "@/components/PrintPreview";
import { SceneBitmapPreview } from "@/pages/designer/scene/SceneBitmapPreview";
import type { PrintState } from "./types";
import type { TemplateListRow } from "@/lib/templates/listTemplates";
import type { LabelPreview } from "@/lib/agent/types";

/**
 * The preview card: what will print — the rendered pages, the warnings
 * and notices above them, and the "nothing to show" fallbacks.
 */
export function PreviewCard({
  store,
  previewTemplate,
  previewPages,
  scenePreviews,
  previewError,
  previewNotice,
  thermalWarning,
  designW,
  designH,
  effPaperW,
  effPaperH,
  previewPaperW,
  previewPaperH,
  useTestData,
  dataUrl,
}: {
  store: PrintState;
  previewTemplate: TemplateListRow | undefined;
  previewPages: string[];
  /** The scene track's prepared preview (1-bit sheets), or null for
   * the html track and while nothing is prepared. */
  scenePreviews: LabelPreview[] | null;
  previewError: string;
  previewNotice: string;
  thermalWarning: string;
  designW: number;
  designH: number;
  effPaperW: number;
  effPaperH: number;
  previewPaperW: number;
  previewPaperH: number;
  useTestData: boolean;
  dataUrl: string;
}) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div className="space-y-1">
          <CardTitle>{t("print.preview")}</CardTitle>
          <p className="text-xs text-muted-foreground">
            {previewTemplate
              ? t("print.preview_subtitle", {
                  name: previewTemplate.name,
                  w: previewTemplate.page_w_mm,
                  h: previewTemplate.page_h_mm,
                  source: t(
                    useTestData || !dataUrl.trim()
                      ? "print.preview_sample"
                      : "print.preview_live",
                  ),
                })
              : t("print.preview_empty")}
          </p>
          {previewTemplate ? (
            <p className="text-xs text-muted-foreground">
              {t("print.paper_note", {
                dw: designW,
                dh: designH,
                pw: effPaperW,
                ph: effPaperH,
              })}
            </p>
          ) : null}
        </div>
      </CardHeader>
      <CardContent id="print-preview-body">
        {thermalWarning && (
          <p
            role="alert"
            data-testid="thermal-truncate-warning"
            className="mb-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning"
          >
            {thermalWarning}
          </p>
        )}
        {previewNotice && !previewError ? (
          <p className="mb-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning">
            {previewNotice}
          </p>
        ) : null}
        {previewError ? (
          <p className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning">
            {previewError}
          </p>
        ) : scenePreviews && scenePreviews.length > 0 ? (
          <div
            className="max-h-sheet overflow-auto rounded-md border bg-muted p-4"
            tabIndex={0}
            role="region"
            aria-label={t("print.preview_region")}
          >
            <SceneBitmapPreview previews={scenePreviews} />
          </div>
        ) : previewPages.length > 0 ? (
          <div
            className="max-h-sheet overflow-auto rounded-md border bg-muted p-4"
            tabIndex={0}
            role="region"
            aria-label={t("print.preview_region")}
          >
            <PrintPreview
              pages={previewPages}
              designW={designW}
              designH={designH}
              paperW={previewPaperW}
              paperH={previewPaperH}
              margins={{
                top: store.marginTop,
                right: store.marginRight,
                bottom: store.marginBottom,
                left: store.marginLeft,
              }}
              fitMode={store.fitMode}
              grayscale={store.grayscale}
              title={t("print.preview_region")}
            />
          </div>
        ) : (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {t("print.no_preview")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
