import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PHONE_QUERY, useMediaQuery } from "@/lib/hooks/useMediaQuery";
import { isAndroid } from "@/lib/platform";
import { useLocalNetworkPermission } from "@/lib/android/useLocalNetworkPermission";
import { useRefreshable } from "@/lib/refresh/useRefreshable";
import { usePrintStore } from "@/lib/store/printStore";
import { usePrintLists } from "./print/usePrintLists";
import { useViaPc } from "./print/useViaPc";
import { usePrintPreview } from "./print/usePrintPreview";
import { usePrintPaper } from "./print/usePrintPaper";
import { usePrintActions } from "./print/usePrintActions";
import { PhoneLayout } from "./print/PhoneLayout";
import { DesktopLayout } from "./print/DesktopLayout";
import { PaperSizeDialog } from "./print/PaperSizeDialog";

/**
 * The print form, always. An unpaired phone can still print: thermal
 * languages render on the device itself (PLAN §4), so there is no
 * pairing wall in front of this page. The one case that does need a
 * pair — a PDF printer — says so on the form (the `pdfNeedsPair`
 * blocker) instead of a redirect.
 */
export function PrintPage() {
  return <PrintForm />;
}

function PrintForm() {
  const { t } = useTranslation();
  const store = usePrintStore();
  const [remoteCode, setRemoteCode] = useState<string | null>(null);
  const [printedVia, setPrintedVia] = useState<string | null>(null);
  const keyRef = useRef<string>("");

  // A print's outcome (banner, warnings, timings, the PC's reply) belongs to
  // the printer + template it ran with. Once either changes it is stale, and
  // a stale "failed" card would offer Retry, which reuses the old
  // idempotency key for a different job. A running print is left alone.
  const resetOutcome = () => {
    const st = usePrintStore.getState();
    if (st.status === "printing") return;
    st.setStatus("idle");
    st.setError("");
    st.setDurationMs(0);
    st.setTimings(null);
    st.setRenderedBy(null);
    st.setWarnings([]);
    setRemoteCode(null);
    setPrintedVia(null);
    keyRef.current = "";
  };

  const lists = usePrintLists();
  const {
    printers,
    refreshSystemPrinters,
    templates,
    loading,
    printerPrefs,
    setPrinterPrefs,
    paperPromptDismissed,
    setPaperPromptDismissed,
  } = lists;

  // The phone renders its own single-column flow (PhonePrintFlow, PLAN §6)
  // from the same handlers and derived values; the JSX below is desktop
  // and tablet only. jsdom has no matchMedia, so tests see that one too.
  const isPhone = useMediaQuery(PHONE_QUERY);

  const viaPcApi = useViaPc(resetOutcome);
  const {
    viaPc,
    setViaPc,
    pairs,
    viaPcPair,
    pcUnpaired,
    pcPrinters,
    pcCached,
    pcTemplates,
    pcTemplate,
    pcTemplatesCached,
    pcFailed,
    hasPair,
    refreshPcPrinters,
    refreshPcTemplates,
    pickViaPcDevice,
    changePcTemplate,
    viaPcDevice,
  } = viaPcApi;

  // The local row behind the chosen printer: its language (the PDF
  // blocker below), its paper width (the mismatch warning below), and —
  // for a scene template — the saved profile the label preview
  // prepares against.
  const selectedPrinter = !viaPc
    ? printers.find((p) => p.name === store.printerId)
    : undefined;

  const preview = usePrintPreview(
    store,
    templates,
    viaPc,
    pcTemplates,
    pcTemplate,
    viaPcPair,
    resetOutcome,
    selectedPrinter,
  );
  const {
    selectedPcTemplate,
    previewTemplate,
    changeTemplate,
    previewPages,
    scenePreviews,
    previewError,
    previewNotice,
  } = preview;

  // Via-PC prints choose from the PC's listing (by server_id); local
  // prints choose a local row. One of them must be chosen.
  const templateChosen = viaPc ? pcTemplate !== "" : store.templateId !== "";
  // The saved printer's database id ("saved:<id>"). OS printers have no
  // registered width — and so no width to correct from the warning.
  const savedDbId = selectedPrinter?.id.startsWith("saved:")
    ? Number(selectedPrinter.id.slice("saved:".length))
    : null;

  // The printer-class rule, in the picker: a scene (label) template
  // offers only saved label printers — the backend plans the job
  // against the saved row's profile, so an OS printer or a document
  // head would refuse it. An HTML (document) template keeps today's
  // full list: every printer is offered, thermal included.
  const isScene = !viaPc && preview.selectedTemplate?.track === "scene";
  const pickerPrinters = isScene
    ? printers.filter((p) => p.id.startsWith("saved:") && p.language !== "pdf")
    : printers;
  // Picking a scene template can leave a printer the job cannot run on
  // chosen (or none at all): move the selection to the first label
  // printer — or to none, which raises the existing blocker line. A
  // plain set, not onPrinterChange, which would restore the printer's
  // remembered template and flip the pick away from the scene.
  const scenePickerKey = isScene
    ? pickerPrinters.map((p) => p.name).join("␟")
    : "";
  useEffect(() => {
    if (!isScene) return;
    const st = usePrintStore.getState();
    const cur = printers.find((p) => p.name === st.printerId);
    if (cur && cur.id.startsWith("saved:") && cur.language !== "pdf") return;
    st.setPrinterId(pickerPrinters[0]?.name ?? "");
    resetOutcome();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isScene, scenePickerKey, store.printerId]);

  const paper = usePrintPaper({
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
  });

  const actions = usePrintActions({
    store,
    viaPc,
    pairs,
    viaPcDevice,
    selectedPcTemplate,
    keyRef,
    setRemoteCode,
    setPrintedVia,
    printerPrefs,
    setPrinterPrefs,
    templates,
    changeTemplate,
    effPaperW: paper.effPaperW,
    effPaperH: paper.effPaperH,
    templateChosen,
    sceneTemplate: isScene,
    selectedPrinter,
    refreshSystemPrinters,
    refreshPcPrinters,
    refreshPcTemplates,
    resetOutcome,
  });
  const {
    refreshingPrinters,
    loadPrinters,
    onPrinterChange,
    handlePrint,
    handleSyncTemplates,
    handleSpikeTest,
  } = actions;

  // The shared manual refresh re-reads the local printer/template lists,
  // and with Print via PC on, the PC's lists — the part that dials the
  // LAN, so on Android it declines with a message while the permission
  // is off.
  const { granted: lanGranted } = useLocalNetworkPermission();
  useRefreshable("print", {
    label: () => t("nav.print"),
    run: () => lists.reloadLists(false),
  });
  useRefreshable("print-pc", {
    label: () => t("nav.print"),
    run: async () => {
      await Promise.all([refreshPcPrinters(), refreshPcTemplates()]);
    },
    active: () => viaPc,
    skipReason: () =>
      isAndroid() && !lanGranted ? t("print.lan_denied") : null,
  });

  // PDF is the one language the phone cannot render itself: with no
  // pair, a PDF printer is blocked here while thermal printers go
  // straight to the device. Rust `need_peer` repeats the rule as a
  // backstop with the same message.
  const pdfNeedsPair =
    !viaPc &&
    isAndroid() &&
    hasPair === false &&
    selectedPrinter?.language === "pdf";
  const canPrint =
    !!store.printerId &&
    templateChosen &&
    store.copies >= 1 &&
    store.status !== "printing" &&
    !loading &&
    (!viaPc || !!viaPcPair) &&
    !pcUnpaired &&
    !pdfNeedsPair;
  // A removed pair blocks everything: say so first, with the way out.
  // A never-paired phone is blocked only for PDF (pdfNeedsPair). A
  // running print is not a blocker: the button already reads
  // "Printing…" and is disabled, and a line appearing under it
  // mid-print made the action bar jump.
  const blocker = pcUnpaired
    ? t("print.pair_again_to_print")
    : pdfNeedsPair
      ? t("print.pdf_needs_pair")
      : !store.printerId
        ? t("print.blocker_printer")
        : !templateChosen
          ? t("print.blocker_template")
          : store.copies < 1
            ? t("print.blocker_copies")
            : viaPc && !viaPcPair
              ? t("print.via_pc_no_pair")
              : loading
                ? t("print.blocker_loading")
                : "";
  const field = "space-y-1.5";

  // The small dialog both layouts open from the mismatch warning: one
  // number field, prefilled with the width the current print needs.
  const paperSizeDialog = (
    <PaperSizeDialog
      open={paper.paperDlg}
      onOpenChange={paper.setPaperDlg}
      value={paper.paperDlgValue}
      onValueChange={paper.setPaperDlgValue}
      error={paper.paperDlgError}
      onErrorChange={paper.setPaperDlgError}
      busy={paper.paperDlgBusy}
      onSave={() => void paper.savePrinterPaperWidth()}
      printerName={selectedPrinter?.name ?? ""}
      previewW={paper.previewPaperW}
      currentW={paper.printerPaperWidth ?? 0}
      field={field}
    />
  );

  if (isPhone) {
    return (
      <PhoneLayout
        viaPc={viaPc}
        viaPcPair={viaPcPair}
        pcUnpaired={pcUnpaired}
        pairs={pairs}
        pcPrinters={pcPrinters}
        pcCached={pcCached}
        pcFailed={pcFailed}
        pcTemplates={pcTemplates}
        pcTemplate={pcTemplate}
        changePcTemplate={changePcTemplate}
        changeTemplate={changeTemplate}
        pcTemplatesCached={pcTemplatesCached}
        printedVia={printedVia}
        remoteCode={remoteCode}
        pickViaPcDevice={pickViaPcDevice}
        setViaPc={setViaPc}
        printers={pickerPrinters}
        labelOnly={isScene}
        templates={templates}
        onPrinterChange={onPrinterChange}
        loadPrinters={loadPrinters}
        refreshingPrinters={refreshingPrinters}
        previewPages={previewPages}
        scenePreviews={scenePreviews}
        previewError={previewError}
        previewNotice={previewNotice}
        previewTemplate={previewTemplate}
        designW={paper.designW}
        designH={paper.designH}
        effPaperW={paper.effPaperW}
        effPaperH={paper.effPaperH}
        previewPaperW={paper.previewPaperW}
        previewPaperH={paper.previewPaperH}
        paperPreset={paper.paperPreset}
        paperNotice={paper.paperNotice}
        thermalWarning={paper.thermalWarning}
        canPrint={canPrint}
        blocker={blocker}
        handlePrint={handlePrint}
        handleSyncTemplates={handleSyncTemplates}
        handleSpikeTest={handleSpikeTest}
        paperSizeDialog={paperSizeDialog}
      />
    );
  }

  return (
    <DesktopLayout
      paperSizeDialog={paperSizeDialog}
      store={store}
      lists={lists}
      pickerPrinters={pickerPrinters}
      labelOnly={isScene}
      viaPcApi={viaPcApi}
      preview={preview}
      paper={paper}
      actions={actions}
      canPrint={canPrint}
      blocker={blocker}
      pdfNeedsPair={pdfNeedsPair}
      printedVia={printedVia}
      remoteCode={remoteCode}
      field={field}
    />
  );
}
