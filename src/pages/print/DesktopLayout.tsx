import { useTranslation } from "react-i18next";
import { PageHeader } from "@/components/PageHeader";
import { ViaPcBanner } from "./ViaPcBanner";
import { PrintResultBanners } from "./PrintResultBanners";
import { JobCard } from "./JobCard";
import { PreviewCard } from "./PreviewCard";
import type { PrintState } from "./types";
import type { usePrintLists } from "./usePrintLists";
import type { useViaPc } from "./useViaPc";
import type { usePrintPreview } from "./usePrintPreview";
import type { usePrintPaper } from "./usePrintPaper";
import type { usePrintActions } from "./usePrintActions";
import type { PrintPagePrinter } from "@/lib/hooks/useSystemPrinters";

/**
 * The desktop and tablet print form: the "choose and print" card on the
 * left, "what will print" on the right. The phone renders its own
 * single-column flow (PhoneLayout) from the same values.
 */
export function DesktopLayout({
  paperSizeDialog,
  store,
  lists,
  pickerPrinters,
  labelOnly,
  viaPcApi,
  preview,
  paper,
  actions,
  canPrint,
  blocker,
  pdfNeedsPair,
  printedVia,
  remoteCode,
  field,
}: {
  paperSizeDialog: React.ReactNode;
  store: PrintState;
  lists: ReturnType<typeof usePrintLists>;
  /** The printer choices the picker shows: all printers for an HTML
   * template, only saved label printers for a scene one. */
  pickerPrinters: PrintPagePrinter[];
  labelOnly: boolean;
  viaPcApi: ReturnType<typeof useViaPc>;
  preview: ReturnType<typeof usePrintPreview>;
  paper: ReturnType<typeof usePrintPaper>;
  actions: ReturnType<typeof usePrintActions>;
  canPrint: boolean;
  blocker: string;
  pdfNeedsPair: boolean;
  printedVia: string | null;
  remoteCode: string | null;
  field: string;
}) {
  const { t } = useTranslation();
  const { templates, advancedOpen, toggleAdvanced } = lists;
  const {
    viaPc,
    viaPcPair,
    pcUnpaired,
    pcPrinters,
    pcCached,
    pcFailed,
    pairs,
    pcTemplate,
    pcTemplates,
    pcTemplatesCached,
    pickViaPcDevice,
    setViaPc,
    changePcTemplate,
  } = viaPcApi;
  const {
    previewTemplate,
    changeTemplate,
    previewPages,
    scenePreviews,
    previewError,
    previewNotice,
  } = preview;
  const {
    refreshingPrinters,
    loadPrinters,
    onPrinterChange,
    handlePrint,
    handleSyncTemplates,
    handleSpikeTest,
  } = actions;

  return (
    <div className="space-y-4">
      <PageHeader title={t("print.title")} description={t("pages.print")} />
      {paperSizeDialog}

      {viaPc && (
        <ViaPcBanner
          viaPcPair={viaPcPair}
          pcCached={pcCached}
          pcFailed={pcFailed}
          pcPrinters={pcPrinters}
          pairs={pairs}
          pickViaPcDevice={pickViaPcDevice}
          setViaPc={setViaPc}
        />
      )}

      <PrintResultBanners
        store={store}
        printedVia={printedVia}
        remoteCode={remoteCode}
        canPrint={canPrint}
        handleSyncTemplates={handleSyncTemplates}
        handlePrint={handlePrint}
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(340px,420px)_1fr]">
        {/* Left: choose and print */}
        <div className="space-y-4">
          <JobCard
            store={store}
            field={field}
            viaPc={viaPc}
            viaPcPair={viaPcPair}
            pcPrinters={pcPrinters}
            pcTemplate={pcTemplate}
            pcTemplates={pcTemplates}
            pcTemplatesCached={pcTemplatesCached}
            changePcTemplate={changePcTemplate}
            changeTemplate={changeTemplate}
            templates={templates}
            pickerPrinters={pickerPrinters}
            labelOnly={labelOnly}
            onPrinterChange={onPrinterChange}
            loadPrinters={loadPrinters}
            refreshingPrinters={refreshingPrinters}
            paperNotice={paper.paperNotice}
            advancedOpen={advancedOpen}
            toggleAdvanced={toggleAdvanced}
            advancedSummary={paper.advancedSummary}
            paperPreset={paper.paperPreset}
            effPaperW={paper.effPaperW}
            effPaperH={paper.effPaperH}
            designW={paper.designW}
            designH={paper.designH}
            previewPaperW={paper.previewPaperW}
            previewPaperH={paper.previewPaperH}
            handleSpikeTest={handleSpikeTest}
            canPrint={canPrint}
            blocker={blocker}
            pcUnpaired={pcUnpaired}
            pdfNeedsPair={pdfNeedsPair}
            handlePrint={handlePrint}
          />
        </div>

        {/* Right: what will print */}
        <div className="space-y-4">
          <PreviewCard
            store={store}
            previewTemplate={previewTemplate}
            previewPages={previewPages}
            scenePreviews={scenePreviews}
            previewError={previewError}
            previewNotice={previewNotice}
            thermalWarning={paper.thermalWarning}
            designW={paper.designW}
            designH={paper.designH}
            effPaperW={paper.effPaperW}
            effPaperH={paper.effPaperH}
            previewPaperW={paper.previewPaperW}
            previewPaperH={paper.previewPaperH}
            useTestData={store.useTestData}
            dataUrl={store.dataUrl}
          />
        </div>
      </div>
    </div>
  );
}
