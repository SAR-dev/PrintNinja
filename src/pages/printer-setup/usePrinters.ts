import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeError } from "@/lib/errors";
import { isAndroid } from "@/lib/android/platform";
import { notifyError, notifyInfo, notifySuccess } from "@/lib/notify";
import { isPrintViaPc } from "@/lib/printViaPc";
import { TimeoutError, withTimeout } from "@/lib/withTimeout";
import { agent } from "@/lib/agent/commands";
import type { PrinterRow } from "@/lib/agent/types";
import { TEST_TIMEOUT_MS } from "./constants";
import type { usePrinterDiscovery } from "./usePrinterDiscovery";

/**
 * The printers list and its row actions: load/refresh, scan-and-add,
 * remove and test-print, plus the print-via-PC flag. Mount-time discovery
 * (OS enumeration, background mDNS) writes into the discovery hook's
 * state, which is why it is passed in.
 */
export function usePrinters(discovery: ReturnType<typeof usePrinterDiscovery>) {
  const { t } = useTranslation();
  const [printers, setPrinters] = useState<PrinterRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("all");
  const [testing, setTesting] = useState<number | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);
  const [scanning, setScanning] = useState(false);
  // Print-via-PC mode: local printers sit unused while it is on.
  const [viaPc, setViaPc] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void isPrintViaPc()
      .then((v) => {
        if (!cancelled) setViaPc(v);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const saved = await agent("list_printers", {});
      setPrinters(saved ?? []);
    } catch (e) {
      notifyError(t("printers.toast_load_failed", { error: describeError(e) }));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // Discover OS printers for the "Add" dialog.
    agent("enumerate_system_printers", {})
      .then((list) => discovery.setSystemPrinters(list ?? []))
      .catch(() => discovery.setSystemPrinters([]))
      .finally(() => discovery.setSystemLoaded(true));
    // Background mDNS browse after mount (one-shot, not continuous) so
    // printers appear without an extra tap: an 8 s browse immediately,
    // then a single 8 s re-browse at 15 s (~30 s window total).
    // Android never browses on mount: the browse talks to the LAN, and
    // the local-network permission is only asked when the user does
    // something that needs it — opening the Add sheet runs a quiet
    // scan once the permission is granted (usePrinterForm). A
    // mount-time browse is exactly the unexplained system prompt this
    // removes.
    if (isAndroid()) return;
    void agent("discover_network_printers", { timeout_secs: 8 })
      .then((list) => {
        if (list && list.length > 0) discovery.setNetworkPrinters(list);
      })
      .catch(() => {});
    // Second low-frequency background scan at 15 s
    const bg = window.setTimeout(() => {
      void agent("discover_network_printers", { timeout_secs: 8 })
        .then((list) => {
          if (list && list.length > 0) discovery.setNetworkPrinters(list);
        })
        .catch(() => {});
    }, 15000);
    return () => window.clearTimeout(bg);
  }, [load]);

  const scanAndAddSystem = async () => {
    setScanning(true);
    try {
      const list = await agent("enumerate_system_printers", {});
      if (!list || list.length === 0) {
        notifyInfo(t("printers.toast_no_system"));
        return;
      }
      for (const sp of list) {
        if (printers.some((p) => p.name === sp.name)) {
          continue;
        }
        try {
          await agent("add_printer", {
            req: {
              name: sp.name,
              printer_type: "system",
              address: sp.address || sp.name,
              language: "pdf",
              paper_width_mm: 80,
              dpi: 203,
            },
          });
        } catch {
          // ignore duplicate / validation errors per-printer
        }
      }
      await load();
      // refresh discovered list too
      discovery.setSystemPrinters(list);
      // The table and the detected-devices block update with the new
      // rows — the result is on screen, so no toast.
    } catch (e) {
      notifyError(t("printers.toast_scan_failed", { error: describeError(e) }));
    } finally {
      setScanning(false);
    }
  };

  const removePrinter = async (p: PrinterRow) => {
    setRemoving(p.id);
    try {
      await agent("delete_printer", { id: p.id });
      setPrinters((prev) => prev.filter((x) => x.id !== p.id));
      notifySuccess(t("printers.toast_removed", { name: p.name }));
    } catch (e) {
      notifyError(
        t("printers.toast_remove_failed", { error: describeError(e) }),
      );
    } finally {
      setRemoving(null);
    }
  };

  const testPrinter = async (p: PrinterRow) => {
    setTesting(p.id);
    try {
      await withTimeout(
        agent("test_printer", { id: p.id }),
        TEST_TIMEOUT_MS,
        "test_printer",
      );
      notifySuccess(t("printers.toast_test_sent", { name: p.name }));
    } catch (e) {
      // A backend that never answers used to leave this button on
      // "Testing…" for ever; say so instead of spinning.
      if (e instanceof TimeoutError) {
        notifyError(
          t("printers.toast_test_timeout", {
            name: p.name,
            seconds: Math.round(e.afterMs / 1000),
          }),
        );
      } else {
        notifyError(
          t("printers.toast_test_failed", { error: describeError(e) }),
        );
      }
    } finally {
      setTesting(null);
    }
  };

  return {
    printers,
    loading,
    tab,
    setTab,
    testing,
    removing,
    scanning,
    viaPc,
    setViaPc,
    load,
    scanAndAddSystem,
    removePrinter,
    testPrinter,
  };
}
