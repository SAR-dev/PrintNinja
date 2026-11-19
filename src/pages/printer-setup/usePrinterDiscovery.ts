import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeError } from "@/lib/errors";
import { notifyError } from "@/lib/notify";
import { agent } from "@/lib/agent/commands";
import { type SystemPrinter } from "./constants";

/**
 * The discovery lists behind the Add sheet's "Detected devices" block (OS
 * queues, mDNS hits, bonded Bluetooth) and the scans that refresh them.
 * The lists are also what the page's mount effect and the "Scan & add"
 * header button write to, so the setters are exposed.
 */
export function usePrinterDiscovery() {
  const { t } = useTranslation();
  const [systemPrinters, setSystemPrinters] = useState<SystemPrinter[]>([]);
  // False until the first OS enumeration answers, so the dialog never says
  // "no printers found" before it has looked.
  const [systemLoaded, setSystemLoaded] = useState(false);
  const [networkPrinters, setNetworkPrinters] = useState<SystemPrinter[]>([]);
  const [scanningSys, setScanningSys] = useState(false);
  const [scanningNet, setScanningNet] = useState(false);
  // Bonded Bluetooth printers (Android): their MAC is the address a
  // Bluetooth row stores, so the dialog offers them instead of a typed MAC.
  const [btPrinters, setBtPrinters] = useState<SystemPrinter[]>([]);
  const [scanningBt, setScanningBt] = useState(false);

  // The three scans below back the dialog's single Rescan button. Run from
  // there they are quiet on success (the counts in the block say what was
  // found) and loud only on failure.
  const refreshSystem = async () => {
    setScanningSys(true);
    try {
      const list = await agent("enumerate_system_printers", {});
      setSystemPrinters(list ?? []);
    } catch (e) {
      notifyError(
        t("printers.toast_discovery_failed", { error: describeError(e) }),
      );
    } finally {
      setScanningSys(false);
      setSystemLoaded(true);
    }
  };

  // mDNS scan for the add panel: listens for IPP and JetDirect
  // advertisements via NsdManager on Android or mdns-sd on desktop.
  const scanNetwork = async () => {
    setScanningNet(true);
    try {
      const list = await agent("discover_network_printers", {
        timeout_secs: 8,
      });
      setNetworkPrinters(list ?? []);
    } catch (e) {
      notifyError(
        t("printers.toast_discovery_failed", { error: describeError(e) }),
      );
    } finally {
      setScanningNet(false);
    }
  };

  // Bonded-device listing for the add panel (Android only): the MAC of a
  // paired printer is the address a Bluetooth row stores.
  const scanBluetooth = useCallback(async () => {
    setScanningBt(true);
    try {
      const list = await agent("list_bluetooth_devices", {});
      setBtPrinters(list ?? []);
    } catch (e) {
      notifyError(
        t("printers.toast_discovery_failed", { error: describeError(e) }),
      );
    } finally {
      setScanningBt(false);
    }
  }, [t]);

  // Pairing is an OS flow the app cannot perform: hand the user to the
  // system Bluetooth screen (Android only).
  const openBluetoothSettings = async () => {
    try {
      await agent("open_bluetooth_settings", {});
    } catch (e) {
      notifyError(describeError(e));
    }
  };

  const scanningAny = scanningSys || scanningNet || scanningBt;

  return {
    systemPrinters,
    setSystemPrinters,
    systemLoaded,
    setSystemLoaded,
    networkPrinters,
    setNetworkPrinters,
    btPrinters,
    scanningAny,
    refreshSystem,
    scanNetwork,
    scanBluetooth,
    openBluetoothSettings,
  };
}
