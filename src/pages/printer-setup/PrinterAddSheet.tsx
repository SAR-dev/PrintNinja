import { useTranslation } from "react-i18next";
import { isAndroid } from "@/lib/platform";
import { Scan } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { DetectedDevices } from "@/components/printers/DetectedDevices";
import { PrinterFormFields } from "./PrinterFormFields";
import type { usePrinterDiscovery } from "./usePrinterDiscovery";
import type { usePrinterForm } from "./usePrinterForm";

/**
 * The Add/Edit sheet: the detected-devices block, the form body
 * (`PrinterFormFields`) and the pinned Cancel / Save footer. State comes
 * from the page's `usePrinterForm`; the discovered-device lists come from
 * `usePrinterDiscovery`.
 */
export function PrinterAddSheet({
  form,
  discovery,
}: {
  form: ReturnType<typeof usePrinterForm>;
  discovery: ReturnType<typeof usePrinterDiscovery>;
}) {
  const { t } = useTranslation();
  const {
    showAdd,
    setShowAdd,
    editingId,
    setEditingId,
    setForm,
    blankForm,
    resetDialogUi,
    showDetected,
    setShowDetected,
    form: formState,
    formErrorKey,
    formErrorBanner,
    addPrinter,
    rescanAll,
    fillFromDetected,
    addDiscovered,
    detecting,
    detectResult,
    runDetect,
    languageTouched,
    dialogTypes,
    visibleLanguages,
    languagesLimited,
    addressDormant,
    addressLabelKey,
    addressHintKey,
    addressDescribedBy,
    showAddressIssue,
    addressIssueKey,
    setAddressTouched,
    formErrorIsAddress,
    formErrorIsPaper,
    formErrorIsDpi,
    formErrorIsGap,
    formErrorIsName,
    gdiWarning,
    ippNonPdfWarning,
    rawWirePdfWarning,
    systemAndroidWarning,
    signInOpen,
    setSignInOpen,
    advancedOpen,
    setAdvancedOpen,
  } = form;
  const {
    systemPrinters,
    systemLoaded,
    networkPrinters,
    btPrinters,
    scanningAny,
    openBluetoothSettings,
  } = discovery;

  return (
    <Sheet
      open={showAdd}
      onOpenChange={(open) => {
        setShowAdd(open);
        if (!open) {
          setEditingId(null);
          setForm(blankForm);
          resetDialogUi();
        }
      }}
    >
      <SheetContent className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-md">
        <DialogHeader className="border-b p-5 pr-12">
          <DialogTitle>
            {editingId === null
              ? t("printers.add_title")
              : t("printers.edit_title")}
          </DialogTitle>
          <DialogDescription>{t("printers.add_hint")}</DialogDescription>
        </DialogHeader>

        <div className="flex-1 space-y-4 p-5">
          {editingId !== null && !showDetected ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="-ml-2 gap-1.5 text-xs"
              onClick={() => setShowDetected(true)}
              data-testid="printers-show-detected"
            >
              <Scan className="h-3.5 w-3.5" aria-hidden="true" />
              {t("printers.repick_detected")}
            </Button>
          ) : (
            <DetectedDevices
              system={isAndroid() ? null : systemPrinters}
              systemLoaded={systemLoaded}
              network={networkPrinters}
              bluetooth={
                isAndroid() && formState.printer_type === "bluetooth"
                  ? btPrinters
                  : null
              }
              scanning={scanningAny}
              onRescan={rescanAll}
              onFill={fillFromDetected}
              // One-tap add would create a second printer while an
              // existing one is being edited: fill is the only action then.
              onAdd={
                editingId === null
                  ? (_kind, d) => void addDiscovered(d)
                  : undefined
              }
              onOpenBluetoothSettings={
                isAndroid() ? () => void openBluetoothSettings() : undefined
              }
            />
          )}

          {formErrorBanner && formErrorKey && (
            <p
              role="alert"
              data-testid="printer-form-error"
              className="text-xs text-destructive"
            >
              {t(formErrorKey)}
            </p>
          )}
          <PrinterFormFields
            form={formState}
            setForm={setForm}
            detecting={detecting}
            detectResult={detectResult}
            runDetect={runDetect}
            languageTouched={languageTouched}
            dialogTypes={dialogTypes}
            visibleLanguages={visibleLanguages}
            languagesLimited={languagesLimited}
            addressLabelKey={addressLabelKey}
            addressHintKey={addressHintKey}
            addressDormant={addressDormant}
            addressDescribedBy={addressDescribedBy}
            showAddressIssue={showAddressIssue}
            addressIssueKey={addressIssueKey}
            setAddressTouched={setAddressTouched}
            formErrorKey={formErrorKey}
            formErrorIsAddress={formErrorIsAddress}
            formErrorIsPaper={formErrorIsPaper}
            formErrorIsDpi={formErrorIsDpi}
            formErrorIsGap={formErrorIsGap}
            formErrorIsName={formErrorIsName}
            gdiWarning={gdiWarning}
            ippNonPdfWarning={ippNonPdfWarning}
            rawWirePdfWarning={rawWirePdfWarning}
            systemAndroidWarning={systemAndroidWarning}
            signInOpen={signInOpen}
            setSignInOpen={setSignInOpen}
            advancedOpen={advancedOpen}
            setAdvancedOpen={setAdvancedOpen}
          />
        </div>

        {/* Sticky: Save stays reachable however far the form scrolls. */}
        <DialogFooter
          className="sticky bottom-0 z-10 gap-2 border-t bg-background p-5 sm:space-x-0"
          data-testid="printer-dialog-footer"
        >
          <Button variant="outline" onClick={() => setShowAdd(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={addPrinter}>{t("printers.save_action")}</Button>
        </DialogFooter>
      </SheetContent>
    </Sheet>
  );
}
