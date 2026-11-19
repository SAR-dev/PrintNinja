import { PhonePrintFlow } from "@/components/print/PhonePrintFlow";
import type { TemplateListRow } from "@/lib/templates/listTemplates";
import type { PrintPagePrinter } from "@/lib/hooks/useSystemPrinters";
import type {
  RenderPair,
  PcPrinterInfo,
  PcTemplateInfo,
} from "@/lib/agent/types";
import type { PaperKey } from "@/lib/paperPresets";

/**
 * The phone's single-column print flow (PhonePrintFlow, PLAN §6) from the
 * same handlers and derived values as the desktop form, plus the shared
 * paper-size dialog.
 */
export function PhoneLayout({
  viaPc,
  viaPcPair,
  pcUnpaired,
  pairs,
  pcPrinters,
  pcCached,
  pcFailed,
  pcTemplates,
  pcTemplate,
  changePcTemplate,
  changeTemplate,
  pcTemplatesCached,
  printedVia,
  remoteCode,
  pickViaPcDevice,
  setViaPc,
  printers,
  templates,
  onPrinterChange,
  loadPrinters,
  refreshingPrinters,
  previewPages,
  previewError,
  previewNotice,
  previewTemplate,
  designW,
  designH,
  effPaperW,
  effPaperH,
  previewPaperW,
  previewPaperH,
  paperPreset,
  paperNotice,
  thermalWarning,
  canPrint,
  blocker,
  handlePrint,
  handleSyncTemplates,
  handleSpikeTest,
  paperSizeDialog,
}: {
  viaPc: boolean;
  viaPcPair: RenderPair | null;
  pcUnpaired: boolean;
  pairs: RenderPair[];
  pcPrinters: PcPrinterInfo[];
  pcCached: boolean;
  pcFailed: boolean;
  pcTemplates: PcTemplateInfo[];
  pcTemplate: string;
  changePcTemplate: (serverId: string) => void;
  changeTemplate: (id: string) => void;
  pcTemplatesCached: boolean;
  printedVia: string | null;
  remoteCode: string | null;
  pickViaPcDevice: (id: string) => Promise<void>;
  setViaPc: (viaPc: boolean) => void;
  printers: PrintPagePrinter[];
  templates: TemplateListRow[];
  onPrinterChange: (name: string) => void;
  loadPrinters: () => void;
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
  paperPreset: PaperKey;
  paperNotice: React.ReactNode;
  thermalWarning: string;
  canPrint: boolean;
  blocker: string;
  handlePrint: (retry?: boolean) => void;
  handleSyncTemplates: () => void;
  handleSpikeTest: () => void;
  paperSizeDialog: React.ReactNode;
}) {
  return (
    <>
      <PhonePrintFlow
        viaPc={viaPc}
        viaPcPair={viaPcPair}
        pcUnpaired={pcUnpaired}
        pairs={pairs}
        pcPrinters={pcPrinters}
        pcCached={pcCached}
        pcFailed={pcFailed}
        pcTemplates={pcTemplates}
        pcTemplate={pcTemplate}
        onPcTemplateChange={changePcTemplate}
        onTemplateChange={changeTemplate}
        pcTemplatesCached={pcTemplatesCached}
        printedVia={printedVia}
        remoteCode={remoteCode}
        onPickViaPcDevice={pickViaPcDevice}
        onExitViaPc={() => setViaPc(false)}
        printers={printers}
        templates={templates}
        onPrinterChange={onPrinterChange}
        onRefreshPrinters={() => void loadPrinters()}
        refreshingPrinters={refreshingPrinters}
        previewPages={previewPages}
        previewError={previewError}
        previewNotice={previewNotice}
        previewTemplate={previewTemplate}
        designW={designW}
        designH={designH}
        effPaperW={effPaperW}
        effPaperH={effPaperH}
        previewPaperW={previewPaperW}
        previewPaperH={previewPaperH}
        paperPreset={paperPreset}
        paperNotice={paperNotice}
        thermalWarning={thermalWarning}
        canPrint={canPrint}
        blocker={blocker}
        onPrint={() => void handlePrint(false)}
        onRetry={() => void handlePrint(true)}
        onSyncTemplates={handleSyncTemplates}
        onSpikeTest={handleSpikeTest}
      />
      {paperSizeDialog}
    </>
  );
}
