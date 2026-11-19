import { useState } from "react";
import { useTranslation } from "react-i18next";
import { isAndroid } from "@/lib/platform";
import { useLocalNetworkPermission } from "@/lib/android/useLocalNetworkPermission";
import { agent } from "@/lib/agent/commands";
import { describeError } from "@/lib/errors";
import { notifyError } from "@/lib/notify";
import {
  prefsKey,
  PRINT_PREFS_KEY,
  type PrintPrefsMap,
} from "@/lib/printPrefs";
import { writeSetting } from "@/lib/settings";
import { cacheNow } from "@/lib/sync/useSyncStatus";
import { DEFAULT_MOCK_DATA } from "@/lib/templates/defaultTemplate";
import type { PrintState } from "./types";
import { resolvePhonePair } from "@/lib/printViaPc";
import type { RenderPair, PcTemplateInfo } from "@/lib/agent/types";
import type { PrintPagePrinter } from "@/lib/hooks/useSystemPrinters";

/**
 * The form's actions: refreshing the printer list, picking a printer
 * (and restoring its remembered choices), the print itself (local or
 * through the paired PC), the follow-up buttons on a failed result and
 * the local test page.
 */
export function usePrintActions({
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
  effPaperW,
  effPaperH,
  templateChosen,
  /** The local row behind `store.printerId` (its connection type
   * decides whether the print dials the LAN). */
  selectedPrinter,
  refreshSystemPrinters,
  refreshPcPrinters,
  refreshPcTemplates,
  resetOutcome,
}: {
  store: PrintState;
  viaPc: boolean;
  pairs: RenderPair[];
  viaPcDevice: string | null;
  selectedPcTemplate: PcTemplateInfo | undefined;
  keyRef: { current: string };
  setRemoteCode: (code: string | null) => void;
  setPrintedVia: (name: string | null) => void;
  printerPrefs: PrintPrefsMap;
  setPrinterPrefs: (p: PrintPrefsMap) => void;
  templates: { id: number | string; name: string }[];
  changeTemplate: (id: string) => void;
  effPaperW: number;
  effPaperH: number;
  templateChosen: boolean;
  selectedPrinter: PrintPagePrinter | undefined;
  refreshSystemPrinters: () => Promise<unknown>;
  refreshPcPrinters: (pairId?: string | null) => Promise<void>;
  refreshPcTemplates: (
    pairId?: string | null,
    quiet?: boolean,
  ) => Promise<void>;
  resetOutcome: () => void;
}) {
  const { t } = useTranslation();
  const { granted: lanGranted } = useLocalNetworkPermission();
  const [refreshingPrinters, setRefreshingPrinters] = useState(false);
  const loadPrinters = async () => {
    if (refreshingPrinters) return;
    setRefreshingPrinters(true);
    // Via PC, the phone's own printers are not in play: asking the OS
    // would only toast "Found 0 system printers" next to the real result.
    try {
      if (viaPc) {
        await refreshPcPrinters();
        await refreshPcTemplates();
        return;
      }
      // The result is the list itself: the dropdown updates, so no toast.
      await refreshSystemPrinters();
    } catch (e) {
      notifyError(t("settings_page.toast_failed", { error: describeError(e) }));
    } finally {
      setRefreshingPrinters(false);
    }
  };

  // Picking a printer brings back its last local choices (F3): the
  // remembered template when it still exists, plus the remembered paper.
  // Via-PC choices are the PC's own ids and never remembered here.
  const onPrinterChange = (name: string) => {
    store.setPrinterId(name);
    resetOutcome();
    if (viaPc) return;
    const remembered = printerPrefs[prefsKey(name)];
    const tpl = remembered
      ? templates.find((x) => String(x.id) === remembered.template_id)
      : undefined;
    if (!remembered || !tpl) {
      // Nothing usable remembered for this printer (never printed here, or
      // its template is gone): drop the previous printer's paper rather
      // than silently carrying it over.
      store.selectPaper("auto");
      return;
    }
    changeTemplate(String(tpl.id));
    store.setPaper(remembered.paper_w, remembered.paper_h);
  };

  const handlePrint = (retry = false) => {
    if (!store.printerId) {
      notifyError(t("print.blocker_printer"));
      return;
    }
    if (!templateChosen) {
      notifyError(t("print.blocker_template"));
      return;
    }
    if (store.copies < 1) {
      notifyError(t("print.blocker_copies"));
      return;
    }
    // Android: printing to an IP address (ipp / raw_tcp) or through a
    // paired PC dials the local network. With the permission denied the
    // network is unreachable, so the result names it instead of
    // dialing — Retry works once the permission is on.
    const dialsLan =
      viaPc ||
      selectedPrinter?.printer_type === "ipp" ||
      selectedPrinter?.printer_type === "raw_tcp";
    if (isAndroid() && dialsLan && !lanGranted) {
      store.setStatus("failed");
      store.setError(t("print.lan_denied"));
      return;
    }
    void doPrint(retry);
  };

  const doPrint = async (retry: boolean) => {
    // Remember this printer's choices for its next visit (F3). Saved
    // before the transport call so the prefs survive a failed print too.
    if (!viaPc) {
      const next: PrintPrefsMap = {
        ...printerPrefs,
        [prefsKey(store.printerId)]: {
          template_id: store.templateId,
          paper_w: store.paperW,
          paper_h: store.paperH,
        },
      };
      setPrinterPrefs(next);
      void writeSetting(PRINT_PREFS_KEY, JSON.stringify(next));
    }
    // Print via PC: no local pipeline or transport call from here on.
    if (viaPc) {
      await handleRemotePrint(retry);
      return;
    }

    store.setStatus("printing");
    store.setError("");
    store.setTimings(null);
    store.setRenderedBy(null);
    store.setWarnings([]);

    try {
      const result = await agent("print_html", {
        req: {
          printer_name: store.printerId,
          html: "",
          template_id: Number(store.templateId),
          page_width_mm: effPaperW,
          page_height_mm: effPaperH,
          orientation: store.orientation,
          copies: store.copies,
          records: store.records,
          margin_top: store.marginTop,
          margin_right: store.marginRight,
          margin_bottom: store.marginBottom,
          margin_left: store.marginLeft,
          fit_mode: store.fitMode,
          page_range: store.pageRange.trim() || undefined,
          grayscale: store.grayscale,
          test: store.useTestData,
          source: store.useTestData ? "test" : "ui",
          data: store.useTestData ? DEFAULT_MOCK_DATA : undefined,
          data_url: store.useTestData ? undefined : store.dataUrl || undefined,
          http_method: store.useTestData ? undefined : store.httpMethod,
        },
      });

      // The result alert above the form reports the outcome; no toast.
      store.setDurationMs(result.duration_ms);
      store.setTimings(result.timings ?? null);
      store.setRenderedBy(result.rendered_by ?? null);
      store.setWarnings(result.warnings ?? []);
      if (result.success) {
        store.setStatus("success");
      } else {
        store.setStatus("failed");
        store.setError(result.error || "Unknown error");
      }
    } catch (e) {
      store.setStatus("failed");
      store.setError(describeError(e));
    }
  };

  // One print through the paired PC. A fresh attempt mints the
  // idempotency key; a retry reuses it, so a timeout never prints twice.
  // Paper size and the four margins ride along — the same values the local
  // path sends — so a phone job lays out the page the same way a local
  // one would.
  const handleRemotePrint = async (retry: boolean) => {
    const pair = resolvePhonePair(pairs, viaPcDevice);
    if (!pair) {
      notifyError(t("print.via_pc_no_pair"));
      return;
    }
    store.setStatus("printing");
    store.setError("");
    store.setTimings(null);
    store.setRenderedBy(null);
    store.setWarnings([]);
    setRemoteCode(null);
    setPrintedVia(null);
    try {
      if (!retry || !keyRef.current) {
        keyRef.current =
          globalThis.crypto?.randomUUID?.() ??
          `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      }
      // Via-PC identity comes from the PC's own listing (matched by
      // construction); the local row is only history linkage, and may
      // not exist — e.g. a guest printing a PC template.
      const pcPick =
        viaPc && selectedPcTemplate
          ? {
              template_id: undefined,
              template_name: selectedPcTemplate.name,
              template_server_id: selectedPcTemplate.server_id,
              template_server_revision:
                selectedPcTemplate.server_revision ?? undefined,
            }
          : {
              template_id: Number(store.templateId),
              template_name: undefined,
              template_server_id: undefined,
              template_server_revision: undefined,
            };
      const result = await agent("remote_print", {
        args: {
          ...pcPick,
          printer_name: store.printerId,
          copies: store.copies,
          records: store.records,
          margin_top: store.marginTop,
          margin_right: store.marginRight,
          margin_bottom: store.marginBottom,
          margin_left: store.marginLeft,
          page_width_mm: effPaperW,
          page_height_mm: effPaperH,
          orientation: store.orientation,
          fit_mode: store.fitMode,
          page_range: store.pageRange.trim() || undefined,
          grayscale: store.grayscale,
          test: store.useTestData,
          data: store.useTestData ? DEFAULT_MOCK_DATA : undefined,
          data_url: store.useTestData ? undefined : store.dataUrl || undefined,
          http_method: store.useTestData ? undefined : store.httpMethod,
          idempotency_key: keyRef.current,
          pair_id: pair.provider_id || pair.id,
        },
      });
      store.setDurationMs(result.duration_ms);
      setPrintedVia(result.pc_name);
      setRemoteCode(result.code);
      store.setWarnings(result.warnings ?? []);
      if (result.success) {
        store.setStatus("success");
      } else {
        store.setStatus("failed");
        store.setError(result.error || "Unknown error");
      }
    } catch (e) {
      store.setStatus("failed");
      store.setError(describeError(e));
    }
  };

  const handleSyncTemplates = async () => {
    try {
      // The failed-print card clears as the visible result; the follow-up
      // is the Retry button that replaces it.
      await cacheNow();
      setRemoteCode(null);
    } catch (e) {
      notifyError(describeError(e));
    }
  };

  const handleSpikeTest = async () => {
    store.setStatus("printing");
    store.setError("");
    store.setTimings(null);
    store.setRenderedBy(null);
    store.setWarnings([]);
    try {
      const result = await agent("spike_test_print", {});
      store.setDurationMs(result.duration_ms);
      store.setTimings(result.timings ?? null);
      store.setRenderedBy(result.rendered_by ?? null);
      store.setWarnings(result.warnings ?? []);
      if (result.success) {
        store.setStatus("success");
      } else {
        store.setStatus("failed");
        store.setError(result.error || "Unknown error");
      }
    } catch (e) {
      store.setStatus("failed");
      store.setError(describeError(e));
    }
  };

  return {
    refreshingPrinters,
    loadPrinters,
    onPrinterChange,
    handlePrint,
    handleSyncTemplates,
    handleSpikeTest,
  };
}
