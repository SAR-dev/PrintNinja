import { useTranslation } from "react-i18next";
import { Printer, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ReadyChip } from "@/components/print/ReadyChip";
import { FoldSection } from "@/components/printers/FoldSection";
import type { PrintState } from "./types";
import type { TemplateListRow } from "@/lib/templates/listTemplates";
import type { PrintPagePrinter } from "@/lib/hooks/useSystemPrinters";
import { DEFAULT_MOCK_DATA } from "@/lib/templates/defaultTemplate";
import type { PcPrinterInfo, RenderPair } from "@/lib/agent/types";
import { AdvancedOptions } from "./AdvancedOptions";
import type { PaperKey } from "@/lib/paperPresets";

/**
 * The print job card: the printer and template choices, the surface
 * data fields, the Advanced fold and the print button with its blocker
 * line.
 */
export function JobCard({
  store,
  field,
  viaPc,
  viaPcPair,
  pcPrinters,
  pcTemplate,
  pcTemplates,
  pcTemplatesCached,
  changePcTemplate,
  changeTemplate,
  templates,
  printers,
  onPrinterChange,
  loadPrinters,
  refreshingPrinters,
  paperNotice,
  advancedOpen,
  toggleAdvanced,
  advancedSummary,
  paperPreset,
  effPaperW,
  effPaperH,
  designW,
  designH,
  previewPaperW,
  previewPaperH,
  handleSpikeTest,
  canPrint,
  blocker,
  pcUnpaired,
  pdfNeedsPair,
  handlePrint,
}: {
  store: PrintState;
  field: string;
  viaPc: boolean;
  viaPcPair: RenderPair | null;
  pcPrinters: PcPrinterInfo[];
  pcTemplate: string;
  pcTemplates: { server_id: string; name: string }[];
  pcTemplatesCached: boolean;
  changePcTemplate: (serverId: string) => void;
  changeTemplate: (id: string) => void;
  templates: TemplateListRow[];
  printers: PrintPagePrinter[];
  onPrinterChange: (name: string) => void;
  loadPrinters: () => void;
  refreshingPrinters: boolean;
  paperNotice: React.ReactNode;
  advancedOpen: boolean;
  toggleAdvanced: () => void;
  advancedSummary: string;
  paperPreset: PaperKey;
  effPaperW: number;
  effPaperH: number;
  designW: number;
  designH: number;
  previewPaperW: number;
  previewPaperH: number;
  handleSpikeTest: () => void;
  canPrint: boolean;
  blocker: string;
  pcUnpaired: boolean;
  pdfNeedsPair: boolean;
  handlePrint: (retry?: boolean) => void;
}) {
  const { t } = useTranslation();

  // The card's surface fields: data URL and copies. Everything else
  // (method, pages, orientation, fit, paper, range, margins, grayscale,
  // test page) folds away behind Advanced.
  const dataFields = (
    <>
      <div className={field}>
        <Label htmlFor="data-url">{t("print.data_url")}</Label>
        <Input
          id="data-url"
          placeholder={t("print.data_url_example")}
          value={store.dataUrl}
          onChange={(e) => store.setDataUrl(e.target.value)}
          disabled={store.useTestData}
        />
      </div>
      <div className={field}>
        <Label htmlFor="copies">{t("print.copies")}</Label>
        <Input
          id="copies"
          type="number"
          min="1"
          value={store.copies}
          onChange={(e) =>
            store.setCopies(
              Math.max(1, Math.floor(Number(e.target.value) || 1)),
            )
          }
        />
      </div>
    </>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("print.job_title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className={field}>
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Label htmlFor="print-printer">{t("print.printer")}</Label>
              {(store.status === "idle" || store.status === "queued") &&
                store.printerId && <ReadyChip />}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={loadPrinters}
              disabled={refreshingPrinters}
              aria-label={t("print.refresh")}
              title={t("print.refresh")}
            >
              <RefreshCw
                className={`h-4 w-4${refreshingPrinters ? " animate-spin" : ""}`}
                aria-hidden="true"
              />
              {t("print.refresh")}
            </Button>
          </div>
          <Select value={store.printerId} onValueChange={onPrinterChange}>
            <SelectTrigger id="print-printer" aria-label={t("print.printer")}>
              <SelectValue placeholder={t("print.printer_placeholder")} />
            </SelectTrigger>
            <SelectContent>
              {viaPc ? (
                <>
                  {pcPrinters.length === 0 && (
                    <SelectItem value="none" disabled>
                      {t("print.no_printers")}
                    </SelectItem>
                  )}
                  {pcPrinters.map((p) => (
                    <SelectItem key={p.name} value={p.name}>
                      {p.name}
                    </SelectItem>
                  ))}
                </>
              ) : (
                <>
                  {printers.length === 0 && (
                    <SelectItem value="none" disabled>
                      {t("print.no_printers")}
                    </SelectItem>
                  )}
                  {printers.map((p) => (
                    <SelectItem key={p.id} value={p.name}>
                      {p.name}
                    </SelectItem>
                  ))}
                </>
              )}
            </SelectContent>
          </Select>
          {paperNotice}
        </div>
        <div className={field}>
          <Label htmlFor="print-template">{t("print.template")}</Label>
          {viaPc && viaPcPair ? (
            <Select value={pcTemplate} onValueChange={changePcTemplate}>
              <SelectTrigger
                id="print-template"
                aria-label={t("print.template")}
              >
                <SelectValue placeholder={t("print.template_placeholder")} />
              </SelectTrigger>
              <SelectContent>
                {pcTemplates.length === 0 && (
                  <SelectItem value="none" disabled>
                    {t("print.no_templates")}
                  </SelectItem>
                )}
                {pcTemplates.map((x) => (
                  <SelectItem key={x.server_id} value={x.server_id}>
                    {x.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Select value={store.templateId} onValueChange={changeTemplate}>
              <SelectTrigger
                id="print-template"
                aria-label={t("print.template")}
              >
                <SelectValue placeholder={t("print.template_placeholder")} />
              </SelectTrigger>
              <SelectContent>
                {templates.length === 0 && (
                  <SelectItem value="none" disabled>
                    {t("print.no_templates")}
                  </SelectItem>
                )}
                {templates.map((x) => (
                  <SelectItem key={x.id} value={String(x.id)}>
                    {x.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {viaPc &&
            viaPcPair &&
            pcTemplatesCached &&
            pcTemplates.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {t("print.via_pc_templates_cached")}
              </p>
            )}
        </div>

        <div className="flex items-center justify-between">
          <Label htmlFor="test-data" className="font-normal">
            {t("print.test_data")}
          </Label>
          <Switch
            id="test-data"
            checked={store.useTestData}
            onCheckedChange={store.setUseTestData}
          />
        </div>
        {store.useTestData && (
          <p className="text-xs text-muted-foreground">
            {t("print.sample_note", {
              store: DEFAULT_MOCK_DATA.store.name,
              order: DEFAULT_MOCK_DATA.order.id,
            })}
          </p>
        )}
        {dataFields}

        <FoldSection
          id="print-advanced"
          title={t("print.advanced")}
          summary={advancedSummary}
          open={advancedOpen}
          onToggle={toggleAdvanced}
          data-testid="print-advanced-toggle"
        >
          <AdvancedOptions
            store={store}
            field={field}
            viaPc={viaPc}
            paperPreset={paperPreset}
            effPaperW={effPaperW}
            effPaperH={effPaperH}
            designW={designW}
            designH={designH}
            previewPaperW={previewPaperW}
            previewPaperH={previewPaperH}
            handleSpikeTest={handleSpikeTest}
          />
        </FoldSection>

        <div className="space-y-2 pt-1">
          <Button
            size="lg"
            className="w-full"
            onClick={() => void handlePrint(false)}
            disabled={!canPrint}
            title={blocker || undefined}
            aria-describedby={blocker ? "print-blocker" : undefined}
          >
            <Printer className="h-5 w-5" aria-hidden="true" />
            {store.status === "printing"
              ? t("print.printing")
              : t("print.print")}
          </Button>
          {blocker && (
            <p id="print-blocker" className="text-xs text-muted-foreground">
              {blocker}{" "}
              {pcUnpaired && (
                <Link to="/devices" className="underline underline-offset-2">
                  {t("shell.pc_pair_again")}
                </Link>
              )}
              {pdfNeedsPair && (
                <Link
                  to="/pair"
                  state={{ returnTo: "/print" }}
                  className="underline underline-offset-2"
                >
                  {t("print.pdf_pair_now")}
                </Link>
              )}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
