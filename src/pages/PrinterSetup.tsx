import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Scan } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { RefreshButton } from "@/components/RefreshButton";
import { ExitViaPcButton } from "@/components/ExitViaPcButton";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PHONE_QUERY, useMediaQuery } from "@/lib/hooks/useMediaQuery";
import { isAndroid } from "@/lib/platform";
import { useRefreshable } from "@/lib/refresh/useRefreshable";
import type { PrinterRow } from "@/lib/agent/types";
import { usePrinterDiscovery } from "./printer-setup/usePrinterDiscovery";
import { usePrinters } from "./printer-setup/usePrinters";
import { usePrinterForm } from "./printer-setup/usePrinterForm";
import { PrinterTable } from "./printer-setup/PrinterTable";
import { PrinterAddSheet } from "./printer-setup/PrinterAddSheet";

/**
 * Printers page: header actions, the via-PC note, the list
 * (`PrinterTable`), the remove-confirmation dialog and the Add/Edit
 * sheet (`PrinterAddSheet`). State lives in the `printer-setup/` hooks:
 * discovery lists, the list/row actions, and the dialog form.
 */
export function PrinterSetupPage() {
  const { t } = useTranslation();
  // Phones don't set up printers; they print through the PC. The title
  // says what the page is on a phone (PLAN §6).
  const isPhone = useMediaQuery(PHONE_QUERY);
  const discovery = usePrinterDiscovery();
  const printers = usePrinters(discovery);
  const form = usePrinterForm(discovery, printers);
  const [removeTarget, setRemoveTarget] = useState<PrinterRow | null>(null);

  // The shared manual refresh re-reads the saved list and the OS queues,
  // and runs the network scan — the one part that dials the LAN, so it
  // declines with a message while the permission is off on Android.
  useRefreshable("printers", {
    label: () => t("nav.printers"),
    run: async () => {
      await Promise.all([
        printers.load(),
        discovery.refreshSystem(),
        discovery.scanBluetooth(),
      ]);
    },
  });
  useRefreshable("printers-network", {
    label: () => t("nav.printers"),
    run: () => discovery.scanNetwork(),
    skipReason: () =>
      isAndroid() && !discovery.lanGranted ? t("printers.lan_denied") : null,
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title={t(isPhone ? "nav.printers" : "printers.title")}
        description={t("pages.printers")}
      >
        <RefreshButton />
        <Button
          variant="outline"
          size="sm"
          onClick={printers.scanAndAddSystem}
          disabled={printers.scanning}
        >
          <Scan className="h-4 w-4" aria-hidden="true" />
          {printers.scanning ? t("printers.scanning") : t("printers.scan")}
        </Button>
        <Button size="sm" onClick={form.openAdd}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t("printers.add_printer")}
        </Button>
      </PageHeader>

      {printers.viaPc && (
        <div
          data-testid="printers-via-pc-note"
          className="flex items-center gap-3 rounded-lg border border-info/30 bg-info-soft px-4 py-3 text-info"
        >
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{t("printers.via_pc_note")}</p>
          </div>
          <ExitViaPcButton onExited={() => printers.setViaPc(false)} />
        </div>
      )}

      <PrinterTable
        tab={printers.tab}
        setTab={printers.setTab}
        visibleGroups={form.visibleGroups}
        counts={form.counts}
        filtered={form.filtered}
        group={form.group}
        loading={printers.loading}
        testing={printers.testing}
        openAdd={form.openAdd}
        openEdit={form.openEdit}
        testPrinter={printers.testPrinter}
        setRemoveTarget={setRemoveTarget}
      />

      <ConfirmDialog
        open={removeTarget != null}
        onOpenChange={(o) => {
          if (!o) setRemoveTarget(null);
        }}
        title={
          removeTarget
            ? t("printers.remove_title", { name: removeTarget.name })
            : ""
        }
        description={t("printers.remove_body")}
        confirmLabel={t("printers.remove_confirm")}
        destructive
        busy={printers.removing != null}
        onConfirm={async () => {
          if (removeTarget) await printers.removePrinter(removeTarget);
          setRemoveTarget(null);
        }}
      />

      {/* Setup lives in a side panel so the list stays in view */}
      <PrinterAddSheet form={form} discovery={discovery} />
    </div>
  );
}
