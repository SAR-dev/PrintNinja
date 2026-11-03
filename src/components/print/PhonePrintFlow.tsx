import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  FileText,
  Minus,
  Plus,
  Printer,
  RefreshCw,
  XCircle,
  Zap,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { ExitViaPcButton } from "@/components/ExitViaPcButton";
import { PrintPreview } from "@/components/PrintPreview";
import { MM_TO_PX } from "@/lib/render/paginate";
import { renderDesignPages } from "@/lib/render/renderTemplate";
import { cn } from "@/lib/utils";
import { formatSeconds } from "@/lib/timings";
import { PAPER_PRESETS } from "@/lib/paperPresets";
import { DEFAULT_MOCK_DATA } from "@/lib/templates/defaultTemplate";
import type { TemplateListRow } from "@/lib/templates/listTemplates";
import type {
  PcPrinterInfo,
  PcTemplateInfo,
  RenderPair,
} from "@/lib/agent/types";
import type { PrintPagePrinter } from "@/lib/hooks/useSystemPrinters";
import { usePrintStore } from "@/lib/store/printStore";

/**
 * The phone print flow (PLAN §6, D1/D4): one field per row, a template
 * picker with real thumbnails, layout options in a bottom sheet, and a
 * sticky Print button. Presentational — every load, print and error
 * handler stays in PrintForm; this component only lays things out for
 * one column and big touch targets. The desktop page keeps its
 * two-column form in Print.tsx.
 */
interface PhonePrintFlowProps {
  viaPc: boolean;
  viaPcPair: RenderPair | null;
  pcUnpaired: boolean;
  pairs: RenderPair[];
  pcPrinters: PcPrinterInfo[];
  pcCached: boolean;
  pcFailed: boolean;
  pcTemplates: PcTemplateInfo[];
  pcTemplate: string;
  onPcTemplateChange: (serverId: string) => void;
  pcTemplatesCached: boolean;
  printedVia: string | null;
  remoteCode: string | null;
  onPickViaPcDevice: (id: string) => void;
  onExitViaPc: () => void;

  printers: PrintPagePrinter[];
  templates: TemplateListRow[];
  onPrinterChange: (name: string) => void;
  onRefreshPrinters: () => void;
  refreshingPrinters: boolean;

  previewPages: string[];
  previewError: string;
  previewNotice: string;
  previewTemplate: TemplateListRow | undefined;
  designW: number;
  designH: number;
  effPaperW: number;
  effPaperH: number;
  previewPaperW: number;
  previewPaperH: number;
  paperPreset: string;
  paperMismatch: string;

  canPrint: boolean;
  blocker: string;
  onPrint: () => void;
  onRetry: () => void;
  onSyncTemplates: () => void;
  onSpikeTest: () => void;
}

/** Store fit values → their display key (the ids are kebab, keys are not). */
const FIT_LABELS: Record<string, string> = {
  actual: "print.fit_actual",
  "fit-width": "print.fit_width",
  "fit-page": "print.fit_page",
  shrink: "print.fit_shrink",
  fill: "print.fit_fill",
};

export function PhonePrintFlow(props: PhonePrintFlowProps) {
  const { t } = useTranslation();
  const store = usePrintStore();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(true);
  const [previewExpanded, setPreviewExpanded] = useState(false);

  const selectedLocal = useMemo(
    () => props.templates.find((x) => String(x.id) === store.templateId),
    [props.templates, store.templateId],
  );
  const selectedPc = useMemo(
    () =>
      props.viaPc
        ? props.pcTemplates.find((x) => x.server_id === props.pcTemplate)
        : undefined,
    [props.viaPc, props.pcTemplates, props.pcTemplate],
  );
  const templateName = props.viaPc ? selectedPc?.name : selectedLocal?.name;

  // What the layout-options trigger summarizes on one line.
  const summaryParts: string[] = [];
  if (props.paperPreset !== "auto") {
    summaryParts.push(
      t("print.phone.sum_paper", {
        pw: props.effPaperW,
        ph: props.effPaperH,
      }),
    );
  }
  if (
    props.previewTemplate &&
    store.orientation !==
      (props.previewTemplate.orientation === "landscape"
        ? "landscape"
        : "portrait")
  ) {
    summaryParts.push(
      t(
        store.orientation === "landscape"
          ? "designer.landscape"
          : "designer.portrait",
      ),
    );
  }
  if (store.fitMode !== "fit-width") {
    summaryParts.push(t(FIT_LABELS[store.fitMode] ?? "print.fit_width"));
  }
  if (
    store.marginTop !== 5 ||
    store.marginRight !== 5 ||
    store.marginBottom !== 5 ||
    store.marginLeft !== 5
  ) {
    summaryParts.push(
      t("print.phone.sum_margins", {
        t: store.marginTop,
        r: store.marginRight,
        b: store.marginBottom,
        l: store.marginLeft,
      }),
    );
  }
  if (store.pageRange.trim()) {
    summaryParts.push(
      t("print.phone.sum_range", { range: store.pageRange.trim() }),
    );
  }
  if (store.grayscale) summaryParts.push(t("print.grayscale"));
  const layoutSummary =
    summaryParts.length > 0
      ? summaryParts.join(" · ")
      : t("print.phone.layout_default");

  return (
    <div className="space-y-4">
      <PageHeader title={t("print.title")} description={t("pages.print")} />

      {/* Print via PC: the job runs on the paired PC's printers, never on
          this phone's transports. */}
      {props.viaPc &&
        (props.viaPcPair ? (
          <div
            data-testid="print-via-pc-banner"
            className="flex items-start gap-3 rounded-lg border border-info/30 bg-info-soft px-4 py-3 text-info"
          >
            <Printer className="h-5 w-5 shrink-0" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">
                {t("print.via_pc_banner", {
                  pc: props.viaPcPair.name || props.viaPcPair.host,
                })}
              </p>
              {props.pcCached && (
                <p className="text-xs">{t("print.via_pc_cached")}</p>
              )}
              {props.pcFailed && props.pcPrinters.length === 0 && (
                <p className="text-xs">{t("print.via_pc_unreachable")}</p>
              )}
            </div>
            <div className="flex shrink-0 items-center">
              <ExitViaPcButton onExited={props.onExitViaPc} />
            </div>
          </div>
        ) : (
          <div
            data-testid="print-via-pc-banner"
            role="alert"
            className="space-y-3 rounded-lg border border-danger/30 bg-danger-soft p-4 text-danger"
          >
            <div className="flex items-center gap-3">
              <XCircle className="h-5 w-5 shrink-0" aria-hidden="true" />
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {t("print.via_pc_no_pair")}
                </p>
                <p className="text-xs">{t("print.via_pc_choose_hint")}</p>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="print-via-pc-picker" className="text-xs">
                {t("settings_page.via_pc_device")}
              </Label>
              <Select
                value=""
                onValueChange={(v) => void props.onPickViaPcDevice(v)}
              >
                <SelectTrigger
                  id="print-via-pc-picker"
                  data-testid="print-via-pc-picker"
                  aria-label={t("settings_page.via_pc_device")}
                  className="w-full"
                >
                  <SelectValue
                    placeholder={t("settings_page.via_pc_device_placeholder")}
                  />
                </SelectTrigger>
                <SelectContent>
                  {props.pairs.map((p) => (
                    <SelectItem
                      key={p.provider_id || p.id}
                      value={p.provider_id || p.id}
                    >
                      {p.name || p.host}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <ExitViaPcButton onExited={props.onExitViaPc} />
          </div>
        ))}

      {/* The one place a print's outcome is reported. */}
      {(store.status === "idle" || store.status === "queued") && (
        <div
          role="status"
          className="flex items-center gap-3 rounded-lg border border-success/30 bg-success-soft px-4 py-2 text-success"
        >
          <CheckCircle2 className="h-5 w-5 shrink-0" aria-hidden="true" />
          <p className="min-w-0 flex-1 truncate text-sm">
            {t("print.ready_title")} —{" "}
            {store.printerId
              ? t("print.ready_detail", { printer: store.printerId })
              : t("print.ready_empty")}
          </p>
        </div>
      )}
      {store.status === "success" && (
        <div
          role="status"
          className="space-y-1 rounded-lg border border-success/30 bg-success-soft px-4 py-3 text-success"
        >
          <p className="flex items-center gap-2 text-sm font-medium">
            <CheckCircle2 className="h-5 w-5 shrink-0" aria-hidden="true" />
            {t("print.sent")}
          </p>
          {store.renderedBy && (
            <p className="text-xs">
              {t("print.rendered_on", { peer: store.renderedBy })}
            </p>
          )}
          {props.printedVia && (
            <p data-testid="print-printed-via" className="text-xs">
              {t("print.printed_via", { pc: props.printedVia })}
            </p>
          )}
          <p className="text-xs">
            {t("print.finished", { seconds: formatSeconds(store.durationMs) })}
          </p>
        </div>
      )}
      {store.status === "failed" && (
        <div
          role="alert"
          className="space-y-3 rounded-lg border border-danger/30 bg-danger-soft p-4"
        >
          <div className="flex items-center gap-3 text-danger">
            <XCircle className="h-5 w-5 shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {t("print.phone.failed_sentence")}
              </p>
              <p className="break-words text-xs text-danger/80">
                {store.error || t("print.unknown_error")}
              </p>
            </div>
          </div>
          {props.remoteCode === "template_stale" && (
            <Button
              variant="outline"
              className="min-h-11 w-full"
              data-testid="print-sync-templates"
              onClick={props.onSyncTemplates}
            >
              {t("print.sync_templates")}
            </Button>
          )}
          <Button
            variant="outline"
            className="min-h-11 w-full"
            onClick={props.onRetry}
            disabled={!props.canPrint}
          >
            {t("print.retry")}
          </Button>
          <Link
            to="/history"
            className="flex min-h-11 w-full items-center justify-center rounded-lg text-sm text-foreground underline underline-offset-2"
          >
            {t("print.phone.open_history")}
          </Link>
        </div>
      )}

      {/* The job: one field per row. */}
      <Card>
        <CardHeader>
          <CardTitle>{t("print.job_title")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label>{t("print.template")}</Label>
            <Button
              type="button"
              variant="outline"
              data-testid="print-template"
              className="min-h-11 w-full justify-between gap-3 px-3 py-2 font-normal"
              aria-haspopup="dialog"
              aria-expanded={pickerOpen}
              onClick={() => setPickerOpen(true)}
            >
              <span className="min-w-0 text-left">
                <span className="block truncate">
                  {templateName ?? t("print.template_placeholder")}
                </span>
                {!props.viaPc && selectedLocal && (
                  <span className="block text-xs text-muted-foreground">
                    {t("designer.pack_size", {
                      w: selectedLocal.page_w_mm,
                      h: selectedLocal.page_h_mm,
                    })}
                  </span>
                )}
              </span>
              <ChevronDown
                className="h-4 w-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            </Button>
            {props.viaPc &&
              props.viaPcPair &&
              props.pcTemplatesCached &&
              props.pcTemplates.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t("print.via_pc_templates_cached")}
                </p>
              )}
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="print-printer">{t("print.printer")}</Label>
              <Button
                type="button"
                variant="ghost"
                className="min-h-11 px-3 text-xs"
                onClick={props.onRefreshPrinters}
                disabled={props.refreshingPrinters}
                aria-label={t("print.refresh")}
                title={t("print.refresh")}
              >
                <RefreshCw
                  className={
                    props.refreshingPrinters
                      ? "h-4 w-4 animate-spin"
                      : "h-4 w-4"
                  }
                  aria-hidden="true"
                />
                {t("print.refresh")}
              </Button>
            </div>
            <Select
              value={store.printerId}
              onValueChange={props.onPrinterChange}
            >
              <SelectTrigger
                id="print-printer"
                aria-label={t("print.printer")}
                className="w-full"
              >
                <SelectValue placeholder={t("print.printer_placeholder")} />
              </SelectTrigger>
              <SelectContent>
                {props.viaPc ? (
                  <>
                    {props.pcPrinters.length === 0 && (
                      <SelectItem value="none" disabled>
                        {t("print.no_printers")}
                      </SelectItem>
                    )}
                    {props.pcPrinters.map((p) => (
                      <SelectItem key={p.name} value={p.name}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </>
                ) : (
                  <>
                    {props.printers.length === 0 && (
                      <SelectItem value="none" disabled>
                        {t("print.no_printers")}
                      </SelectItem>
                    )}
                    {props.printers.map((p) => (
                      <SelectItem key={p.id} value={p.name}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </>
                )}
              </SelectContent>
            </Select>
            {props.paperMismatch && (
              <p
                role="status"
                className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-warning"
              >
                {props.paperMismatch}
              </p>
            )}
          </div>

          {/* Data: which data feeds the template. */}
          <div className="space-y-2">
            <div
              role="radiogroup"
              aria-label={t("print.phone.data")}
              className="space-y-2"
            >
              <button
                type="button"
                role="radio"
                aria-checked={store.useTestData}
                onClick={() => store.setUseTestData(true)}
                className={cn(
                  "flex min-h-11 w-full items-center justify-between gap-2 rounded-xl border px-3 text-left text-sm",
                  store.useTestData
                    ? "border-primary bg-primary/5"
                    : "border-border",
                )}
              >
                {t("print.phone.data_sample")}
                {store.useTestData && (
                  <Check
                    className="h-4 w-4 shrink-0 text-primary"
                    aria-hidden="true"
                  />
                )}
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={!store.useTestData}
                onClick={() => store.setUseTestData(false)}
                className={cn(
                  "flex min-h-11 w-full items-center justify-between gap-2 rounded-xl border px-3 text-left text-sm",
                  !store.useTestData
                    ? "border-primary bg-primary/5"
                    : "border-border",
                )}
              >
                {t("print.phone.data_link")}
                {!store.useTestData && (
                  <Check
                    className="h-4 w-4 shrink-0 text-primary"
                    aria-hidden="true"
                  />
                )}
              </button>
            </div>
            {store.useTestData ? (
              <p className="text-xs text-muted-foreground">
                {t("print.sample_note", {
                  store: DEFAULT_MOCK_DATA.store.name,
                  order: DEFAULT_MOCK_DATA.order.id,
                })}
              </p>
            ) : (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="phone-data-url">{t("print.data_url")}</Label>
                  <Input
                    id="phone-data-url"
                    placeholder={t("print.data_url_example")}
                    value={store.dataUrl}
                    onChange={(e) => store.setDataUrl(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="phone-method">{t("print.method_aria")}</Label>
                  <Select
                    value={store.httpMethod}
                    onValueChange={(v: "GET" | "POST") =>
                      store.setHttpMethod(v)
                    }
                  >
                    <SelectTrigger
                      id="phone-method"
                      aria-label={t("print.method_aria")}
                      className="w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="GET">GET</SelectItem>
                      <SelectItem value="POST">POST</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>{t("print.copies")}</Label>
            <div className="flex items-center justify-between gap-2">
              <Button
                type="button"
                variant="outline"
                className="h-11 w-11 px-0"
                aria-label={t("print.phone.copies_decrease")}
                disabled={store.copies <= 1 || store.status === "printing"}
                onClick={() => store.setCopies(store.copies - 1)}
              >
                <Minus className="h-4 w-4" aria-hidden="true" />
              </Button>
              <span
                className="min-w-8 text-center text-lg font-medium tabular-nums"
                aria-live="polite"
              >
                {store.copies}
              </span>
              <Button
                type="button"
                variant="outline"
                className="h-11 w-11 px-0"
                aria-label={t("print.phone.copies_increase")}
                disabled={store.status === "printing"}
                onClick={() => store.setCopies(store.copies + 1)}
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("print.phone.copies_hint")}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="phone-pages">{t("print.pages")}</Label>
            <Input
              id="phone-pages"
              type="number"
              inputMode="numeric"
              min="1"
              max="500"
              value={store.records}
              onChange={(e) => store.setRecords(Number(e.target.value))}
            />
            <p className="text-xs text-muted-foreground">
              {t("print.phone.pages_hint")}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* What will print. */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div className="space-y-1">
            <CardTitle className="text-base">{t("print.preview")}</CardTitle>
            <p className="text-xs text-muted-foreground">
              {props.previewTemplate
                ? t("print.preview_subtitle", {
                    name: props.previewTemplate.name,
                    w: props.previewTemplate.page_w_mm,
                    h: props.previewTemplate.page_h_mm,
                    source: t(
                      store.useTestData || !store.dataUrl.trim()
                        ? "print.preview_sample"
                        : "print.preview_live",
                    ),
                  })
                : t("print.preview_empty")}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            className="h-11 w-11"
            aria-expanded={previewOpen}
            aria-controls="print-preview-body-phone"
            aria-label={
              previewOpen
                ? t("print.preview_collapse")
                : t("print.preview_expand")
            }
            onClick={() => setPreviewOpen((v) => !v)}
          >
            <ChevronDown
              className={cn(
                "h-4 w-4 transition-transform",
                previewOpen && "rotate-180",
              )}
              aria-hidden="true"
            />
          </Button>
        </CardHeader>
        <CardContent
          id="print-preview-body-phone"
          className={cn(!previewOpen && "hidden")}
        >
          {props.previewNotice && !props.previewError ? (
            <p className="mb-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning">
              {props.previewNotice}
            </p>
          ) : null}
          {props.previewError ? (
            <p className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning">
              {props.previewError}
            </p>
          ) : props.previewPages.length > 0 ? (
            <div
              className={cn(
                "overflow-auto rounded-md border bg-muted p-4",
                previewExpanded ? "max-h-[70vh]" : "max-h-[40vh]",
              )}
              tabIndex={0}
              role="region"
              aria-label={t("print.preview_region")}
            >
              <PrintPreview
                pages={props.previewPages}
                designW={props.designW}
                designH={props.designH}
                paperW={props.previewPaperW}
                paperH={props.previewPaperH}
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
          {previewOpen &&
            props.previewPages.length > 0 &&
            !props.previewError && (
              <Button
                type="button"
                variant="ghost"
                className="mt-2 min-h-11 w-full"
                aria-pressed={previewExpanded}
                onClick={() => setPreviewExpanded((v) => !v)}
              >
                {previewExpanded
                  ? t("print.preview_less")
                  : t("print.tap_expand")}
              </Button>
            )}
        </CardContent>
      </Card>

      {/* Everything else about the sheet: behind one trigger. */}
      <Card>
        <CardContent className="p-4">
          <Button
            type="button"
            variant="outline"
            className="min-h-11 w-full justify-between gap-3 px-3 py-2 font-normal"
            aria-haspopup="dialog"
            aria-expanded={layoutOpen}
            onClick={() => setLayoutOpen(true)}
          >
            <span className="min-w-0 text-left">
              <span className="block">{t("print.phone.layout_options")}</span>
              <span className="block truncate text-xs font-normal text-muted-foreground">
                {layoutSummary}
              </span>
            </span>
            <ChevronDown
              className="h-4 w-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          </Button>
        </CardContent>
      </Card>

      <LayoutOptionsSheet
        open={layoutOpen}
        onOpenChange={setLayoutOpen}
        viaPc={props.viaPc}
        paperPreset={props.paperPreset}
        effPaperW={props.effPaperW}
        effPaperH={props.effPaperH}
        designW={props.designW}
        designH={props.designH}
        onSpikeTest={props.onSpikeTest}
      />

      <TemplatePickerSheet
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        viaPc={props.viaPc}
        pcName={
          props.viaPcPair ? props.viaPcPair.name || props.viaPcPair.host : null
        }
        templates={props.templates}
        pcTemplates={props.pcTemplates}
        selectedKey={props.viaPc ? props.pcTemplate : store.templateId}
        onPick={(key) => {
          if (props.viaPc) props.onPcTemplateChange(key);
          else store.setTemplateId(key);
          setPickerOpen(false);
        }}
      />

      {/* Sticky Print bar: full-width, always a thumb-reach away. */}
      <div
        className="sticky bottom-0 z-10 -mx-4 border-t bg-card/95 px-4 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] pt-2 backdrop-blur md:hidden"
        data-slot="action-bar"
        data-testid="print-action-bar"
      >
        <Button
          size="lg"
          className="min-h-11 w-full"
          onClick={props.onPrint}
          disabled={!props.canPrint}
          title={props.blocker || undefined}
          aria-describedby={props.blocker ? "print-blocker-phone" : undefined}
        >
          <Printer className="h-5 w-5" aria-hidden="true" />
          {store.status === "printing" ? t("print.printing") : t("print.print")}
        </Button>
        {props.blocker && (
          <p
            id="print-blocker-phone"
            className="mt-1 text-xs text-muted-foreground"
          >
            {props.blocker}{" "}
            {props.pcUnpaired && (
              <Link
                to="/automation?tab=phones"
                className="underline underline-offset-2"
              >
                {t("shell.pc_pair_again")}
              </Link>
            )}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * A real render of the template's first page, scaled into a small box —
 * the same pipeline as the big preview, so the picker shows what will
 * print. The iframe stays inert and hidden from the a11y tree; its title
 * matches the preview's so the axe run skips it the same way.
 */
function TemplateThumb({ tpl }: { tpl: TemplateListRow | null }) {
  const { t } = useTranslation();
  const [doc, setDoc] = useState<string | null>(null);

  useEffect(() => {
    if (!tpl || !tpl.html.trim()) {
      setDoc(null);
      return;
    }
    let cancelled = false;
    // A tick later: the picker never blocks the first paint.
    const timer = window.setTimeout(() => {
      try {
        const pages = renderDesignPages(
          tpl.html,
          tpl.css,
          [DEFAULT_MOCK_DATA],
          tpl.compiled_css || null,
        );
        if (!cancelled) setDoc(pages[0] ?? null);
      } catch {
        if (!cancelled) setDoc(null);
      }
    }, 60);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [tpl]);

  if (!tpl || !doc) {
    return (
      <span
        aria-hidden="true"
        className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-accent"
      >
        <FileText className="h-5 w-5 text-muted-foreground" />
      </span>
    );
  }

  const boxW = 28;
  const scale = boxW / (tpl.page_w_mm * MM_TO_PX);
  const boxH = Math.max(20, Math.min(56, tpl.page_h_mm * MM_TO_PX * scale));

  return (
    <span
      aria-hidden="true"
      className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-accent"
    >
      <span
        className="block overflow-hidden bg-white shadow-sm ring-1 ring-border"
        style={{ width: boxW, height: boxH }}
      >
        <iframe
          title={t("print.preview_region")}
          sandbox=""
          srcDoc={doc}
          scrolling="no"
          className="pointer-events-none border-0 bg-white"
          style={{
            width: tpl.page_w_mm * MM_TO_PX,
            height: tpl.page_h_mm * MM_TO_PX,
            transform: `scale(${scale})`,
            transformOrigin: "top left",
          }}
        />
      </span>
    </span>
  );
}

function TemplatePickerSheet({
  open,
  onOpenChange,
  viaPc,
  pcName,
  templates,
  pcTemplates,
  selectedKey,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  viaPc: boolean;
  pcName: string | null;
  templates: TemplateListRow[];
  pcTemplates: PcTemplateInfo[];
  selectedKey: string;
  onPick: (key: string) => void;
}) {
  const { t } = useTranslation();
  const empty = viaPc ? pcTemplates.length === 0 : templates.length === 0;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="max-h-[80vh] overflow-y-auto pb-[calc(env(safe-area-inset-bottom)+1.5rem)]"
      >
        <h2 className="text-base font-semibold">
          {t("print.phone.template_picker")}
        </h2>
        {empty ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {t("print.no_templates")}
          </p>
        ) : (
          <div className="-mx-2 space-y-1">
            {viaPc
              ? pcTemplates.map((x) => {
                  const selected = x.server_id === selectedKey;
                  return (
                    <button
                      key={x.server_id}
                      type="button"
                      onClick={() => onPick(x.server_id)}
                      className={cn(
                        "flex min-h-11 w-full items-center gap-3 rounded-xl px-2 py-2 text-left",
                        selected && "bg-accent",
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-accent"
                      >
                        <FileText className="h-5 w-5 text-muted-foreground" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{x.name}</span>
                        {pcName && (
                          <span className="block truncate text-xs text-muted-foreground">
                            {pcName}
                          </span>
                        )}
                      </span>
                      {selected && (
                        <Check
                          className="h-4 w-4 shrink-0 text-primary"
                          aria-hidden="true"
                        />
                      )}
                    </button>
                  );
                })
              : templates.map((x) => {
                  const selected = String(x.id) === selectedKey;
                  return (
                    <button
                      key={x.id}
                      type="button"
                      onClick={() => onPick(String(x.id))}
                      className={cn(
                        "flex min-h-11 w-full items-center gap-3 rounded-xl px-2 py-2 text-left",
                        selected && "bg-accent",
                      )}
                    >
                      <TemplateThumb tpl={x} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{x.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {t("designer.pack_size", {
                            w: x.page_w_mm,
                            h: x.page_h_mm,
                          })}
                        </span>
                      </span>
                      {selected && (
                        <Check
                          className="h-4 w-4 shrink-0 text-primary"
                          aria-hidden="true"
                        />
                      )}
                    </button>
                  );
                })}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function LayoutOptionsSheet({
  open,
  onOpenChange,
  viaPc,
  paperPreset,
  effPaperW,
  effPaperH,
  designW,
  designH,
  onSpikeTest,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  viaPc: boolean;
  paperPreset: string;
  effPaperW: number;
  effPaperH: number;
  designW: number;
  designH: number;
  onSpikeTest: () => void;
}) {
  const { t } = useTranslation();
  const store = usePrintStore();
  const custom = paperPreset === "custom";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="max-h-[85vh] overflow-y-auto pb-[calc(env(safe-area-inset-bottom)+1.5rem)]"
      >
        <h2 className="text-base font-semibold">
          {t("print.phone.layout_options")}
        </h2>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="phone-paper">{t("print.paper_size")}</Label>
            <Select
              value={paperPreset}
              onValueChange={(v) => {
                const preset = PAPER_PRESETS.find((x) => x.key === v);
                if (!preset) {
                  // Custom: start from the current effective size so
                  // the inputs below are populated.
                  store.setPaperW(effPaperW);
                  store.setPaperH(effPaperH);
                  return;
                }
                store.setPaperW(preset.w);
                store.setPaperH(preset.h);
              }}
            >
              <SelectTrigger
                id="phone-paper"
                aria-label={t("print.paper_size")}
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{t("print.paper_auto")}</SelectItem>
                {PAPER_PRESETS.map((x) => (
                  <SelectItem key={x.key} value={x.key}>
                    {t(x.labelKey)}
                  </SelectItem>
                ))}
                <SelectItem value="custom">
                  {t("print.paper_custom")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          {custom && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="phone-paper-w">{t("print.paper_width")}</Label>
                <Input
                  id="phone-paper-w"
                  type="number"
                  min="1"
                  value={store.paperW ?? ""}
                  placeholder={String(designW)}
                  onChange={(e) =>
                    store.setPaperW(
                      e.target.value === ""
                        ? null
                        : Math.max(1, Number(e.target.value) || 1),
                    )
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="phone-paper-h">{t("print.paper_height")}</Label>
                <Input
                  id="phone-paper-h"
                  type="number"
                  min="1"
                  value={store.paperH ?? ""}
                  placeholder={String(designH)}
                  onChange={(e) =>
                    store.setPaperH(
                      e.target.value === ""
                        ? null
                        : Math.max(1, Number(e.target.value) || 1),
                    )
                  }
                />
              </div>
            </>
          )}
          <p className="text-xs text-muted-foreground">
            {t("print.paper_note", {
              dw: designW,
              dh: designH,
              pw: effPaperW,
              ph: effPaperH,
            })}
          </p>

          <div className="space-y-1.5">
            <Label htmlFor="phone-orientation">{t("print.orientation")}</Label>
            <Select
              value={store.orientation}
              onValueChange={(v) =>
                store.setOrientation(v as "portrait" | "landscape")
              }
            >
              <SelectTrigger
                id="phone-orientation"
                aria-label={t("print.orientation")}
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="portrait">
                  {t("designer.portrait")}
                </SelectItem>
                <SelectItem value="landscape">
                  {t("designer.landscape")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="phone-fit">{t("print.fit_mode")}</Label>
            <Select
              value={store.fitMode}
              onValueChange={(v) =>
                store.setFitMode(
                  v as "actual" | "fit-width" | "fit-page" | "shrink" | "fill",
                )
              }
            >
              <SelectTrigger
                id="phone-fit"
                aria-label={t("print.fit_mode")}
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="actual">{t("print.fit_actual")}</SelectItem>
                <SelectItem value="fit-width">
                  {t("print.fit_width")}
                </SelectItem>
                <SelectItem value="fit-page">{t("print.fit_page")}</SelectItem>
                <SelectItem value="shrink">{t("print.fit_shrink")}</SelectItem>
                <SelectItem value="fill">{t("print.fit_fill")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">
              {t("print.margins")} (mm)
            </legend>
            {(
              [
                [
                  "phone-mt",
                  "print.margin_top",
                  store.marginTop,
                  store.setMarginTop,
                ],
                [
                  "phone-mr",
                  "print.margin_right",
                  store.marginRight,
                  store.setMarginRight,
                ],
                [
                  "phone-mb",
                  "print.margin_bottom",
                  store.marginBottom,
                  store.setMarginBottom,
                ],
                [
                  "phone-ml",
                  "print.margin_left",
                  store.marginLeft,
                  store.setMarginLeft,
                ],
              ] as const
            ).map(([id, key, value, set]) => (
              <div key={id} className="space-y-1.5">
                <Label
                  htmlFor={id}
                  className="text-xs font-normal text-muted-foreground"
                >
                  {t(key)}
                </Label>
                <Input
                  id={id}
                  type="number"
                  value={value}
                  onChange={(e) => set(Number(e.target.value))}
                />
              </div>
            ))}
          </fieldset>

          <div className="space-y-1.5">
            <Label htmlFor="phone-page-range">{t("print.page_range")}</Label>
            <Input
              id="phone-page-range"
              placeholder={t("print.page_range_example")}
              value={store.pageRange}
              onChange={(e) => store.setPageRange(e.target.value)}
            />
          </div>

          <div className="flex min-h-11 items-center justify-between">
            <Label htmlFor="phone-grayscale" className="font-normal">
              {t("print.grayscale")}
            </Label>
            <Switch
              id="phone-grayscale"
              checked={store.grayscale}
              onCheckedChange={store.setGrayscale}
            />
          </div>

          {/* Local test page: hidden while printing through a PC. */}
          {!viaPc && (
            <div className="space-y-2 border-t pt-3">
              <p className="text-xs text-muted-foreground">
                {t("print.test_hint")}
              </p>
              <Button
                type="button"
                variant="outline"
                className="min-h-11 w-full"
                data-testid="print-spike-test"
                onClick={onSpikeTest}
                disabled={store.status === "printing"}
              >
                <Zap className="h-4 w-4" aria-hidden="true" />
                {t("print.send_test")}
              </Button>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
