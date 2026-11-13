import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PrintPreview } from "@/components/PrintPreview";
import { MarkdownPreview } from "@/components/ReadmeEditor";
import { useRenderedPages } from "@/lib/hooks/useRenderedPages";

type ViewerSection = "preview" | "sample" | "readme" | "code" | "details";

export interface PhoneDesignerViewerProps {
  templateName: string;
  pageWidthMm: number;
  pageHeightMm: number;
  /** Live editor values: what the Code section shows verbatim. */
  html: string;
  css: string;
  /** Debounced (and compiled for the preview): what the pages render. */
  debouncedHtml: string;
  debouncedCss: string;
  compiledCss: string | null;
  /** The selected dataset, parsed: the data the preview is rendered with. */
  sampleData: Record<string, unknown>;
  /** The dataset panel (read-only rows, editable JSON in a dialog). */
  samplePanel: ReactNode;
  readme: string;
  dirty: boolean;
  offline: boolean;
  readOnly: boolean;
  nameError: string;
  /** A template row is open (null on the nameless starting state). */
  hasTemplate: boolean;
  published: boolean;
  publishedAt: string | null;
  saving: boolean;
  onSave: () => void;
}

/**
 * The phone's Designer (PLAN §6, D4): templates are edited on a computer,
 * so the phone shows them — a full-width preview, sample data it can
 * tweak, and the README, code and details read-only. One section picker
 * replaces the desktop's editor, canvas and controls; nothing here can
 * change the template's HTML or CSS.
 */
export function PhoneDesignerViewer(props: PhoneDesignerViewerProps) {
  const { t } = useTranslation();
  const [section, setSection] = useState<ViewerSection>("preview");

  // One pass of the renderer at the design's own size: the preview is the
  // design, not a print sheet, so paper equals design and margins are zero.
  const { pages: previewPages } = useRenderedPages(
    props.debouncedHtml,
    props.debouncedCss,
    props.compiledCss,
    [props.sampleData],
  );

  const canSave =
    props.hasTemplate &&
    props.dirty &&
    !props.offline &&
    !props.readOnly &&
    !props.nameError &&
    !props.saving;

  return (
    <div className="space-y-4">
      <div
        data-testid="designer-phone-notice"
        role="note"
        className="rounded-lg border border-info/30 bg-info-soft px-4 py-3 text-sm text-info"
      >
        {t("designer.viewer_notice")}
      </div>

      <Select
        value={section}
        onValueChange={(v) => setSection(v as ViewerSection)}
      >
        <SelectTrigger
          data-testid="designer-phone-sections"
          aria-label={t("designer.viewer_section_aria")}
          className="w-full"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="preview">
            {t("designer.viewer_preview")}
          </SelectItem>
          <SelectItem value="sample">{t("designer.sampleData")}</SelectItem>
          <SelectItem value="readme">README</SelectItem>
          <SelectItem value="code">{t("designer.code")}</SelectItem>
          <SelectItem value="details">
            {t("designer.viewer_details")}
          </SelectItem>
        </SelectContent>
      </Select>

      {section === "preview" && (
        <div
          role="region"
          aria-label={t("designer.viewer_preview_title")}
          data-testid="designer-phone-preview"
        >
          {previewPages.length > 0 ? (
            <PrintPreview
              pages={previewPages}
              designW={props.pageWidthMm}
              designH={props.pageHeightMm}
              paperW={props.pageWidthMm}
              paperH={props.pageHeightMm}
              margins={{ top: 0, right: 0, bottom: 0, left: 0 }}
              fitMode="fit-width"
              title={t("designer.viewer_preview_title")}
            />
          ) : (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {t("print.no_preview")}
            </p>
          )}
        </div>
      )}

      {section === "sample" && (
        <div className="space-y-4">
          <Card>
            <CardContent className="pt-5">
              <div className="viewer-sample space-y-4">{props.samplePanel}</div>
            </CardContent>
          </Card>
          {/* The one edit a phone makes: sample data. Save stays reachable
              without scrolling back up. */}
          <div className="sticky bottom-0 z-10 -mx-4 border-t bg-background/95 px-4 py-3 backdrop-blur">
            <Button
              data-testid="designer-phone-save"
              className="w-full"
              onClick={props.onSave}
              disabled={!canSave}
            >
              <Save className="h-4 w-4" aria-hidden="true" />
              {t("common.save")}
            </Button>
          </div>
        </div>
      )}

      {section === "readme" && (
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            <div className="px-6 py-5">
              <MarkdownPreview
                text={props.readme}
                emptyHint={t("readme.empty_hint")}
              />
            </div>
          </CardContent>
        </Card>
      )}

      {section === "code" && (
        <div className="space-y-4">
          {[
            { label: t("designer.editor_html"), code: props.html },
            { label: t("designer.editor_css"), code: props.css },
          ].map(({ label, code }) => (
            <Card key={label} className="overflow-hidden">
              <CardContent className="p-0">
                <div className="border-b px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {label}
                </div>
                <pre className="overflow-x-hidden whitespace-pre-wrap break-words p-4 font-mono text-xs leading-5">
                  {code}
                </pre>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {section === "details" && (
        <Card>
          <CardContent className="pt-5">
            <dl className="space-y-3 text-sm">
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-muted-foreground">
                  {t("designer.viewer_details_size")}
                </dt>
                <dd className="font-medium tabular-nums">
                  {props.pageWidthMm} × {props.pageHeightMm} mm
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-muted-foreground">
                  {t("designer.viewer_details_sync")}
                </dt>
                <dd className="font-medium">
                  {props.published ? t("status.published") : t("status.draft")}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-muted-foreground">
                  {t("designer.viewer_details_last_saved")}
                </dt>
                <dd className="font-medium">
                  {props.publishedAt
                    ? new Date(props.publishedAt).toLocaleString()
                    : t("designer.viewer_details_never")}
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
