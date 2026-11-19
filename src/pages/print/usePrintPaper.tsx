import { useState } from "react";
import { useTranslation } from "react-i18next";
import { agent } from "@/lib/agent/commands";
import { describeError } from "@/lib/errors";
import { notifyError } from "@/lib/notify";
import { computePrintLayout, resolvePaper } from "@/lib/render/printLayout";
import { derivePaperKey, PAPER_PRESETS } from "@/lib/paperPresets";
import { PaperWidthNotice } from "@/components/print/PaperWidthNotice";
import type { PrintState } from "./types";
import type { TemplateListRow } from "@/lib/templates/listTemplates";
import type { PrintPagePrinter } from "@/lib/hooks/useSystemPrinters";
import { prefsKey, savePaperWidthDismissed } from "@/lib/printPrefs";

/** Fit mode → label key, for the Advanced fold's header summary. */
const FIT_MODE_LABELS = {
  actual: "print.fit_actual",
  "fit-width": "print.fit_width",
  "fit-page": "print.fit_page",
  shrink: "print.fit_shrink",
  fill: "print.fit_fill",
} as const;

/**
 * The paper: the physical sheet the print will use (design size, the
 * explicit per-print choice, orientation and fit applied), the mismatch
 * and "no width saved" warnings for the chosen printer, and the small
 * dialog that corrects a saved printer's registered width.
 */
export function usePrintPaper({
  store,
  previewTemplate,
  viaPc,
  previewPages,
  selectedPrinter,
  savedDbId,
  templateChosen,
  paperPromptDismissed,
  setPaperPromptDismissed,
  refreshSystemPrinters,
}: {
  store: PrintState;
  previewTemplate: TemplateListRow | undefined;
  viaPc: boolean;
  previewPages: string[];
  selectedPrinter: PrintPagePrinter | undefined;
  savedDbId: number | null;
  templateChosen: boolean;
  paperPromptDismissed: string[];
  setPaperPromptDismissed: (paperPromptDismissed: string[]) => void;
  refreshSystemPrinters: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  // F3: the paper-width dialog, opened from the mismatch warning below.
  const [paperDlg, setPaperDlg] = useState(false);
  const [paperDlgValue, setPaperDlgValue] = useState("");
  const [paperDlgBusy, setPaperDlgBusy] = useState(false);
  // The failed-width message, shown inline under the input (no toast).
  const [paperDlgError, setPaperDlgError] = useState<string | null>(null);

  // Paper presets: physical sheets. "auto" means the template's design
  // size; "custom" is edited in the inputs below.
  const designW = previewTemplate?.page_w_mm ?? 80;
  const designH = previewTemplate?.page_h_mm ?? 200;
  // Explicit paper size wins per axis; null falls back to the design size.
  // The paper is per-print only — never written back to the template.
  // Print via PC sends no paper size (the PC prints at the template's
  // design size), so the explicit choice is ignored there and the preview
  // shows what will really print.
  const reqPaperW = viaPc ? null : store.paperW;
  const reqPaperH = viaPc ? null : store.paperH;
  const effPaperW = reqPaperW ?? designW;
  const effPaperH = reqPaperH ?? designH;
  // The physical sheet the preview draws (and the PDF prints on): the same
  // mapping the backend applies, so orientation swaps the paper, never the
  // design.
  const { paperW: previewPaperW, paperH: previewPaperH } = resolvePaper(
    designW,
    designH,
    store.orientation,
    reqPaperW,
    reqPaperH,
  );
  // "Custom…" is a deliberate choice kept in the store; every other value
  // is derived from the size so presets still show when restored.
  const paperPreset = viaPc
    ? "auto"
    : store.paperCustom
      ? "custom"
      : derivePaperKey(store.paperW, store.paperH);

  // The fold's header line: the current values, so folding hides the
  // controls but not what is set. Via PC sends no paper, so the summary
  // stays at orientation and fit.
  const paperSummary = viaPc
    ? null
    : paperPreset === "auto"
      ? t("print.paper_auto")
      : paperPreset === "custom"
        ? `${store.paperW ?? "—"}×${store.paperH ?? "—"}`
        : t(
            PAPER_PRESETS.find((x) => x.key === paperPreset)?.labelKey ??
              "print.paper_auto",
          );
  const advancedSummary = [
    t(
      store.orientation === "portrait"
        ? "designer.portrait"
        : "designer.landscape",
    ),
    t(FIT_MODE_LABELS[store.fitMode]),
    ...(paperSummary ? [paperSummary] : []),
  ].join(" · ");

  // F3: warn when the sheet the print will use is wider than the chosen
  // printer's registered paper width (e.g. an A4 template aimed at an
  // 80 mm thermal). previewPaperW is the wide axis after the orientation
  // swap, so landscape is covered too. OS printers have no registered
  // width and never warn; 1 mm absorbs rounding.
  const printerPaperWidth = selectedPrinter?.paper_width_mm ?? null;
  const paperMismatch =
    Number.isFinite(printerPaperWidth) &&
    (printerPaperWidth as number) > 0 &&
    previewPaperW > (printerPaperWidth as number) + 1
      ? t(
          reqPaperW == null && reqPaperH == null
            ? "print.paper_mismatch_template"
            : "print.paper_mismatch_paper",
          {
            tw: designW,
            th: designH,
            // The sheet that will print (orientation applied), the same
            // one the warning compares against.
            pw2: previewPaperW,
            ph2: previewPaperH,
            pw: printerPaperWidth,
          },
        )
      : "";

  // F3: the warning's "Set paper size" action corrects the width the saved
  // printer is registered with. The row is read first and updated with only
  // the width changed, so name, address and language stay untouched.
  const openPaperSizeDialog = () => {
    setPaperDlgValue(String(previewPaperW));
    setPaperDlgError(null);
    setPaperDlg(true);
  };
  // The width's one inline error (same four checks the save used to toast,
  // collapsed into the first failing one).
  const paperDlgErrorKey = (): string | null => {
    const w = Number(paperDlgValue.trim());
    if (!Number.isFinite(w)) return "printers.err_paper_number";
    if (!Number.isInteger(w)) return "printers.err_paper_int";
    if (w < 1) return "printers.err_paper_min";
    if (w > 1000) return "printers.err_paper_max";
    return null;
  };
  // Writes a width onto the saved printer: the row is read first and updated
  // with only the width changed. Shared by the dialog and the one-tap action.
  const writePaperWidth = async (w: number): Promise<boolean> => {
    if (savedDbId == null) return false;
    setPaperDlgBusy(true);
    try {
      const row = await agent("get_printer", { id: savedDbId });
      await agent("update_printer", {
        id: savedDbId,
        req: {
          name: row.name,
          printer_type: row.printer_type,
          address: row.address,
          language: row.language,
          paper_width_mm: w,
          dpi: row.dpi ?? undefined,
        },
      });
      await refreshSystemPrinters();
      // The notice on the card clears with the new width — the result is
      // on screen, so no toast.
      return true;
    } catch (e) {
      notifyError(describeError(e));
      return false;
    } finally {
      setPaperDlgBusy(false);
    }
  };
  const savePrinterPaperWidth = async () => {
    const bad = paperDlgErrorKey();
    if (bad) {
      setPaperDlgError(bad);
      return;
    }
    if (await writePaperWidth(Number(paperDlgValue.trim()))) setPaperDlg(false);
  };
  // The one-tap action: the whole-mm width the current sheet needs (rounded
  // up so it always fits), or null when that is not a valid width — then
  // the dialog is the way to set one.
  const neededWidth = Math.ceil(previewPaperW - 1e-6);
  const oneTapWidth =
    Number.isInteger(neededWidth) && neededWidth >= 1 && neededWidth <= 1000
      ? neededWidth
      : null;
  const applyPaperWidth = () => {
    if (oneTapWidth == null) openPaperSizeDialog();
    else void writePaperWidth(oneTapWidth);
  };
  // A saved printer with no width yet: offer the sheet's width once.
  const paperWidthMissing =
    savedDbId != null &&
    selectedPrinter != null &&
    templateChosen &&
    oneTapWidth != null &&
    !(Number(printerPaperWidth) > 0) &&
    !paperPromptDismissed.includes(prefsKey(selectedPrinter.name));
  const dismissPaperPrompt = () => {
    if (!selectedPrinter) return;
    const next = [...paperPromptDismissed, prefsKey(selectedPrinter.name)];
    setPaperPromptDismissed(next);
    void savePaperWidthDismissed(next).catch(() => {});
  };
  // Item 49 (frontend mitigation): a command-language printer (ESC/POS,
  // ZPL, TSPL, CPCL, raster) rasterizes a single paper-height bitmap and
  // sends it once, so a job that spans more than one sheet is cut off after
  // the first. The preview knows the record count and the sheet count, so
  // warn before that surprise reaches paper. The real multi-sheet output is
  // backend work.
  const commandLanguage =
    !viaPc &&
    selectedPrinter != null &&
    selectedPrinter.language != null &&
    selectedPrinter.language !== "pdf";
  const sheetLayout = computePrintLayout(
    store.fitMode,
    designW,
    designH,
    previewPaperW,
    previewPaperH,
    {
      top: store.marginTop,
      right: store.marginRight,
      bottom: store.marginBottom,
      left: store.marginLeft,
    },
  );
  const thermalTruncates =
    commandLanguage &&
    (store.records > 1 ||
      previewPages.length > 1 ||
      sheetLayout.placements.length > 1);
  const thermalWarning = thermalTruncates ? t("print.thermal_truncate") : "";

  // One element for both layouts: the mismatch warning wins over the
  // "missing" prompt (they never both apply: one needs a saved width).
  const paperNotice = paperMismatch ? (
    <PaperWidthNotice
      kind="mismatch"
      message={paperMismatch}
      width={oneTapWidth}
      busy={paperDlgBusy}
      onApply={savedDbId != null ? applyPaperWidth : undefined}
      onOther={savedDbId != null ? openPaperSizeDialog : undefined}
    />
  ) : paperWidthMissing ? (
    <PaperWidthNotice
      kind="missing"
      message={t("print.paper_width_missing", {
        name: selectedPrinter?.name,
        w: oneTapWidth,
      })}
      width={oneTapWidth}
      busy={paperDlgBusy}
      onApply={applyPaperWidth}
      onDismiss={dismissPaperPrompt}
    />
  ) : null;

  return {
    paperDlg,
    setPaperDlg,
    paperDlgValue,
    setPaperDlgValue,
    paperDlgBusy,
    paperDlgError,
    setPaperDlgError,
    designW,
    designH,
    effPaperW,
    effPaperH,
    previewPaperW,
    previewPaperH,
    paperPreset,
    advancedSummary,
    printerPaperWidth,
    paperNotice,
    thermalWarning,
    savePrinterPaperWidth,
  };
}
