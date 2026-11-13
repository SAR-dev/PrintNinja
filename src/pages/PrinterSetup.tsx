import { describeError, isAlreadyExists } from "@/lib/errors";
import {
  isAndroid,
  isLinux,
  supportedPrinterLanguages,
  supportedPrinterTypes,
} from "@/lib/platform";
import { TimeoutError, withTimeout } from "@/lib/withTimeout";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type SetStateAction,
} from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "@/components/PageHeader";
import { ExitViaPcButton } from "@/components/ExitViaPcButton";
import { isPrintViaPc } from "@/lib/printViaPc";
import { agent } from "@/lib/agent/commands";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DataTable } from "@/components/DataTable";
import { StatusBadge } from "@/components/StatusBadge";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { FoldSection } from "@/components/printers/FoldSection";
import { DisabledReason } from "@/components/ui/disabled-reason";
import {
  DetectedDevices,
  type DetectedDevice,
  type DetectedKind,
} from "@/components/printers/DetectedDevices";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Plus,
  Printer,
  Wifi,
  Usb,
  Bluetooth,
  Monitor,
  Pencil,
  Trash2,
  TestTube,
  Scan,
  RefreshCw,
  MoreHorizontal,
  AlertTriangle,
  Info,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { notifySuccess, notifyError, notifyInfo } from "@/lib/notify";
import { PHONE_QUERY, useMediaQuery } from "@/lib/hooks/useMediaQuery";
import {
  bluetoothAddressIssue,
  defaultLanguageFor,
  validatePrinterForm,
  type LoosePrinterForm,
} from "@/lib/printerSchema";
import type { PrinterRow, ProbeCapabilitiesResult } from "@/lib/agent/types";

const PRINTER_TYPES = [
  { value: "ipp", labelKey: "printers.conn_ipp" },
  { value: "raw_tcp", labelKey: "printers.conn_raw" },
  { value: "usb", labelKey: "printers.conn_usb" },
  { value: "bluetooth", labelKey: "printers.conn_bluetooth" },
  { value: "system", labelKey: "printers.conn_system" },
];

const LANGUAGES = [
  { value: "pdf", labelKey: "printers.lang_pdf" },
  { value: "escpos", labelKey: "printers.lang_escpos" },
  { value: "tspl", labelKey: "printers.lang_tspl" },
  { value: "zpl", labelKey: "printers.lang_zpl" },
  { value: "cpcl", labelKey: "printers.lang_cpcl" },
  { value: "raster", labelKey: "printers.lang_raster" },
];

const PAPERS = [
  { value: "58", label: "58 mm" },
  { value: "80", label: "80 mm" },
  { value: "100", label: "100 mm" },
  { value: "152", label: "4x6 in (152 mm)" },
  { value: "210", label: "A4 (210 mm)" },
];

/** Anything the dialog can pick up: an OS queue, an mDNS hit or a paired device. */
type SystemPrinter = DetectedDevice;

/** Tabs group printers by how they connect. */
const GROUPS = [
  {
    key: "all",
    labelKey: "printers.filter_all",
    types: null as string[] | null,
  },
  {
    key: "network",
    labelKey: "printers.filter_network",
    types: ["ipp", "raw_tcp"],
  },
  { key: "usb", labelKey: "printers.filter_usb", types: ["usb"] },
  {
    key: "bluetooth",
    labelKey: "printers.filter_bluetooth",
    types: ["bluetooth"],
  },
  { key: "system", labelKey: "printers.filter_system", types: ["system"] },
];

const TYPE_ICONS: Record<string, typeof Printer> = {
  ipp: Wifi,
  raw_tcp: Wifi,
  usb: Usb,
  bluetooth: Bluetooth,
  system: Monitor,
};

/**
 * USB and driverless Bluetooth hand the bytes to the printer unchanged, so
 * PDF is not a language they can print. Bluetooth in driver mode goes
 * through the OS queue, whose driver rasterizes — PDF is valid there.
 */
function isRawWire(printerType: string, viaDriver: boolean): boolean {
  return printerType === "usb" || (printerType === "bluetooth" && !viaDriver);
}

/**
 * How long the test print may take before the button gives up on it.
 *
 * Long enough for the backend's own worst case: the reachability probe
 * (≤10 s), a PDF render (up to 75 s with the Android WebView's watchdog
 * and the Rust deadline behind it) and the send. Past that no answer is
 * coming back, and without this bound the button stayed on "Testing…"
 * forever when the backend never replied.
 */
const TEST_TIMEOUT_MS = 80_000;

export function PrinterSetupPage() {
  const { t } = useTranslation();
  // Phones don't set up printers; they print through the PC. The title
  // says what the page is on a phone (PLAN §6).
  const isPhone = useMediaQuery(PHONE_QUERY);
  const [printers, setPrinters] = useState<PrinterRow[]>([]);
  const [systemPrinters, setSystemPrinters] = useState<SystemPrinter[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("all");
  const [testing, setTesting] = useState<number | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanningSys, setScanningSys] = useState(false);
  // False until the first OS enumeration answers, so the dialog never says
  // "no printers found" before it has looked.
  const [systemLoaded, setSystemLoaded] = useState(false);
  const [networkPrinters, setNetworkPrinters] = useState<SystemPrinter[]>([]);
  const [scanningNet, setScanningNet] = useState(false);
  // Bonded Bluetooth printers (Android): their MAC is the address a
  // Bluetooth row stores, so the dialog offers them instead of a typed MAC.
  const [btPrinters, setBtPrinters] = useState<SystemPrinter[]>([]);
  const [scanningBt, setScanningBt] = useState(false);
  // The detected-devices block shows counts only until a section is opened
  // (state lives in the block itself, which remounts with each dialog). While
  // editing it is tucked behind a link: filling from it overwrites the row.
  const [showDetected, setShowDetected] = useState(false);
  // Paper width / DPI / label gap sit behind "Advanced"; the header shows
  // their values so nothing is hidden, only folded.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // IPP sign-in (user, password, certificate check) is rarely needed, so it
  // starts folded; a row that already has any of it opens it when edited.
  const [signInOpen, setSignInOpen] = useState(false);
  // The generic address-format error waits for the first blur; a clear
  // connection mix-up (USB port in a Bluetooth row) shows at once.
  const [addressTouched, setAddressTouched] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<PrinterRow | null>(null);

  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
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
  const [form, setFormRaw] = useState<LoosePrinterForm>({
    name: "",
    printer_type: "ipp",
    address: "",
    language: "pdf",
    paper_width_mm: "80",
    dpi: "203",
    label_gap_mm: "",
    username: "",
    password: "",
    skip_tls_verification: false,
    via_driver: false,
  });
  // The one failing check from the last Save, as an i18n key, shown
  // inline next to the failing field instead of a toast. Any edit to
  // any field clears it — the person is already on top of it.
  const [formErrorKey, setFormErrorKey] = useState<string | null>(null);
  const setForm = (update: SetStateAction<LoosePrinterForm>) => {
    setFormRaw(update);
    setFormErrorKey(null);
  };

  const blankForm: LoosePrinterForm = {
    name: "",
    printer_type: "ipp",
    address: "",
    language: "pdf",
    paper_width_mm: "80",
    dpi: "203",
    label_gap_mm: "",
    username: "",
    password: "",
    skip_tls_verification: false,
    via_driver: false,
  };

  // What the capability probe found (TODO items 2 + 4). The probe never
  // errors: silence or a refused query is just "unknown — please pick".
  const [detecting, setDetecting] = useState(false);
  const [detectResult, setDetectResult] =
    useState<ProbeCapabilitiesResult | null>(null);
  // A manual language pick beats the probe's suggestion.
  const languageTouched = useRef(false);

  const resetDialogUi = () => {
    setShowDetected(false);
    setAdvancedOpen(false);
    setSignInOpen(false);
    setAddressTouched(false);
    setFormErrorKey(null);
  };

  const openAdd = () => {
    setEditingId(null);
    setForm(blankForm);
    setDetectResult(null);
    languageTouched.current = false;
    resetDialogUi();
    setShowAdd(true);
  };

  const openEdit = (p: PrinterRow) => {
    setEditingId(p.id);
    setForm({
      name: p.name,
      printer_type: p.printer_type,
      address: p.address,
      language: p.language,
      paper_width_mm: String(p.paper_width_mm ?? "80"),
      dpi: String(p.dpi ?? "203"),
      label_gap_mm: p.label_gap_mm != null ? String(p.label_gap_mm) : "",
      username: p.username ?? "",
      password: p.password ?? "",
      skip_tls_verification: p.skip_tls_verification ?? false,
      via_driver: p.via_driver ?? false,
    });
    setDetectResult(null);
    languageTouched.current = false;
    resetDialogUi();
    setSignInOpen(Boolean(p.username || p.password || p.skip_tls_verification));
    setShowAdd(true);
  };

  /** Ask the printer what it speaks and pre-fill the language if the
   * operator has not picked one yet. Never fails the form: a probe
   * problem shows as "unknown", the same as a silent printer. */
  const runDetect = async () => {
    setDetecting(true);
    setDetectResult(null);
    try {
      const res = await agent("probe_printer_capabilities", {
        printer_type: form.printer_type,
        name: form.name || undefined,
        address: form.address,
        username: form.username || undefined,
        password: form.password || undefined,
        skip_tls_verification: form.skip_tls_verification || undefined,
      });
      setDetectResult(res);
      if (
        res.suggested_language &&
        !languageTouched.current &&
        res.suggested_language !== form.language
      ) {
        setForm((f) => ({ ...f, language: res.suggested_language! }));
      }
    } catch {
      // The contract says the probe never errors; this only catches a
      // dead IPC channel, and that also reads as "unknown".
      setDetectResult(null);
    } finally {
      setDetecting(false);
    }
  };

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
      .then((list) => setSystemPrinters(list ?? []))
      .catch(() => setSystemPrinters([]))
      .finally(() => setSystemLoaded(true));
    // Background mDNS browse after mount (one-shot, not continuous) so
    // printers appear without an extra tap: an 8 s browse immediately,
    // then a single 8 s re-browse at 15 s (~30 s window total).
    void agent("discover_network_printers", { timeout_secs: 8 })
      .then((list) => {
        if (list && list.length > 0) setNetworkPrinters(list);
      })
      .catch(() => {});
    // Second low-frequency background scan at 15 s
    const bg = window.setTimeout(() => {
      void agent("discover_network_printers", { timeout_secs: 8 })
        .then((list) => {
          if (list && list.length > 0) setNetworkPrinters(list);
        })
        .catch(() => {});
    }, 15000);
    return () => window.clearTimeout(bg);
  }, [load]);

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

  /** One Rescan for every source the dialog currently shows. */
  const rescanAll = () => {
    const jobs: Promise<void>[] = [];
    if (!isAndroid()) jobs.push(refreshSystem());
    jobs.push(scanNetwork());
    if (isAndroid() && form.printer_type === "bluetooth") {
      jobs.push(scanBluetooth());
    }
    void Promise.all(jobs);
  };
  const scanningAny = scanningSys || scanningNet || scanningBt;

  /** Copy a detected device into the form without saving anything. */
  const fillFromDetected = (kind: DetectedKind, d: SystemPrinter) => {
    if (kind === "system") {
      setForm((f) => ({
        ...f,
        name: d.name,
        address: d.name,
        printer_type: "system",
      }));
    } else if (kind === "bluetooth") {
      setForm((f) => ({
        ...f,
        name: d.name,
        address: d.address,
        printer_type: "bluetooth",
        // Android rasterizes thermal locally (PLAN §4): a bonded printer
        // starts at ESC/POS unless another language was already chosen on
        // purpose.
        language: f.language === "pdf" ? "escpos" : f.language,
      }));
    } else {
      const type = d.printer_type ?? "ipp";
      setForm((f) => ({
        ...f,
        name: d.name,
        address: d.address,
        printer_type: type,
        language:
          type === "ipp"
            ? "pdf"
            : isAndroid()
              ? "escpos"
              : defaultLanguageFor(type, f.language, f.via_driver),
        // Driver mode is Bluetooth-only; a fill from another connection
        // type clears it.
        via_driver: type === "bluetooth" ? f.via_driver : false,
      }));
    }
  };

  // Pairing is an OS flow the app cannot perform: hand the user to the
  // system Bluetooth screen (Android only).
  const openBluetoothSettings = async () => {
    try {
      await agent("open_bluetooth_settings", {});
    } catch (e) {
      notifyError(describeError(e));
    }
  };

  // The moment the dialog is on Bluetooth (Android), list the bonded
  // printers: they are one tap away, no MAC to type.
  useEffect(() => {
    if (showAdd && isAndroid() && form.printer_type === "bluetooth") {
      void scanBluetooth();
    }
  }, [showAdd, form.printer_type, scanBluetooth]);

  const addDiscovered = async (np: SystemPrinter) => {
    const printerType = np.printer_type ?? "ipp";
    const address = np.address;
    const name = np.name;
    try {
      await agent("add_printer", {
        req: {
          name,
          printer_type: printerType,
          address,
          // Android rasterizes thermal languages locally (PLAN §4), so a
          // non-IPP add starts at ESC/POS there. On desktop a raw
          // USB/Bluetooth wire needs a command language too (a PDF would
          // print as gibberish); everything else keeps PDF.
          language:
            printerType === "ipp"
              ? "pdf"
              : isAndroid()
                ? "escpos"
                : defaultLanguageFor(printerType, "pdf"),
          paper_width_mm: 80,
          dpi: 203,
        },
      });
      notifySuccess(t("printers.toast_added", { name }));
      await load();
    } catch (e) {
      notifyError(t("printers.toast_save_failed", { error: describeError(e) }));
    }
  };

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
      setSystemPrinters(list);
      // The table and the detected-devices block update with the new
      // rows — the result is on screen, so no toast.
    } catch (e) {
      notifyError(t("printers.toast_scan_failed", { error: describeError(e) }));
    } finally {
      setScanning(false);
    }
  };

  const addPrinter = async () => {
    const parsed = validatePrinterForm(form);
    if (!parsed.ok) {
      // The paper / DPI / gap fields are folded away: open them so the
      // error points at something visible.
      if (/^printers\.err_(paper|dpi|gap)/.test(parsed.messageKey)) {
        setAdvancedOpen(true);
      }
      setAddressTouched(true);
      // The message lands inline next to the failing field, not in a
      // toast — the field is right here on screen.
      setFormErrorKey(parsed.messageKey);
      return;
    }
    const req = parsed.req;
    try {
      if (editingId === null) {
        await agent("add_printer", { req });
        notifySuccess(t("printers.toast_added", { name: form.name.trim() }));
      } else {
        await agent("update_printer", { id: editingId, req });
        notifySuccess(t("printers.toast_saved", { name: form.name.trim() }));
      }
      setShowAdd(false);
      setEditingId(null);
      setForm(blankForm);
      resetDialogUi();
      await load();
    } catch (e) {
      const msg = describeError(e);
      notifyError(
        isAlreadyExists(e)
          ? msg
          : t("printers.toast_save_failed", { error: msg }),
      );
    }
  };

  const removePrinter = async (p: PrinterRow) => {
    try {
      await agent("delete_printer", { id: p.id });
      setPrinters((prev) => prev.filter((x) => x.id !== p.id));
      notifySuccess(t("printers.toast_removed", { name: p.name }));
    } catch (e) {
      notifyError(
        t("printers.toast_remove_failed", { error: describeError(e) }),
      );
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

  const counts = (types: string[] | null) =>
    types
      ? printers.filter((p) => types.includes(p.printer_type)).length
      : printers.length;
  // Android cannot drive System printers (no spooler transport exists
  // there — USB and Bluetooth go through the Kotlin plugin instead), so
  // the add form and the tabs hide only that. `isAndroid` reads the
  // WebView user agent once per mount; it cannot change at runtime.
  const visibleTypes = useMemo(() => supportedPrinterTypes(PRINTER_TYPES), []);
  // The dialog's connection select: the supported types, plus the row's
  // own type while it is being edited. Android cannot drive `system`
  // printers, but a synced row of that type must stay editable — the
  // warning in the dialog explains the fix (re-add by address).
  const dialogTypes = useMemo(() => {
    const supported = supportedPrinterTypes(PRINTER_TYPES);
    if (supported.some((x) => x.value === form.printer_type)) return supported;
    const current = PRINTER_TYPES.find((x) => x.value === form.printer_type);
    return current ? [...supported, current] : supported;
  }, [form.printer_type]);
  // Android can produce PDF plus the receipt and label languages that pass
  // the per-language QA gate in platform.ts (PLAN §4, D4.4): its WebView
  // rasterizes them locally. A saved row that already uses another
  // language stays visible so editing it does not silently change its
  // language.
  //
  // Raw-wire types (usb/bluetooth) additionally hide `pdf`: their
  // firmware cannot parse PDF bytes, so a PDF row there prints blank.
  // A legacy row saved with PDF stays visible while it is being edited
  // (same keep-current fallback) and gets the note below; the backend
  // keeps the print-time warning as the safety net for the few models
  // that really do read raw PDF.
  const visibleLanguages = useMemo(() => {
    const rawWire = isRawWire(form.printer_type, form.via_driver);
    const supported = supportedPrinterLanguages(LANGUAGES).filter(
      (l) => !rawWire || l.value !== "pdf",
    );
    if (supported.some((l) => l.value === form.language)) return supported;
    const current = LANGUAGES.find((l) => l.value === form.language);
    return current ? [...supported, current] : supported;
  }, [form.language, form.printer_type, form.via_driver]);
  const languagesLimited = visibleLanguages.length < LANGUAGES.length;
  const visibleGroups = useMemo(
    () =>
      GROUPS.filter(
        (g) =>
          g.types === null ||
          g.types.some((t) => visibleTypes.some((v) => v.value === t)),
      ),
    [visibleTypes],
  );
  const group = visibleGroups.find((g) => g.key === tab) ?? visibleGroups[0];
  const filtered = group.types
    ? printers.filter((p) => group.types?.includes(p.printer_type))
    : printers;

  const columns = useMemo<ColumnDef<PrinterRow>[]>(
    () => [
      {
        id: "name",
        header: t("printers.col_printer"),
        accessorFn: (p) => p.name.toLowerCase(),
        enableSorting: true,
        cell: (c) => {
          const p = c.row.original;
          const Icon = TYPE_ICONS[p.printer_type] ?? Printer;
          return (
            <div className="flex min-w-0 items-center gap-3">
              <Icon
                className="h-4 w-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <div className="min-w-0">
                <p className="truncate font-medium">{p.name}</p>
                <p
                  className="max-w-[140px] truncate font-mono text-xs text-muted-foreground sm:max-w-[260px]"
                  title={p.address}
                >
                  {p.address}
                </p>
              </div>
            </div>
          );
        },
      },
      {
        id: "status",
        header: t("common.status"),
        cell: (c) => {
          const st = c.row.original.status;
          // Icon + word in both cases; unknown states
          // read "Not checked" instead of bare muted text.
          if (st === "online" || st === "offline")
            return <StatusBadge status={st} />;
          return <StatusBadge status="unchecked" />;
        },
      },
      {
        id: "connection",
        header: t("printers.col_connection"),
        meta: { className: "hidden md:table-cell" },
        cell: (c) => {
          const conn = PRINTER_TYPES.find(
            (x) => x.value === c.row.original.printer_type,
          );
          return conn ? t(conn.labelKey) : c.row.original.printer_type;
        },
      },
      {
        id: "language",
        header: t("printers.col_language"),
        meta: { className: "hidden lg:table-cell" },
        cell: (c) => {
          const lang = LANGUAGES.find(
            (x) => x.value === c.row.original.language,
          );
          return lang ? t(lang.labelKey) : c.row.original.language;
        },
      },
      {
        id: "paper",
        header: t("printers.col_paper"),
        meta: { className: "hidden lg:table-cell" },
        cell: (c) =>
          c.row.original.paper_width_mm
            ? `${c.row.original.paper_width_mm} mm`
            : "—",
      },
      {
        id: "actions",
        header: () => <span className="sr-only">{t("common.actions")}</span>,
        meta: { className: "text-right" },
        cell: (c) => {
          const p = c.row.original;
          return (
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("printers.edit_printer", { name: p.name })}
                title={t("common.edit")}
                onClick={() => openEdit(p)}
              >
                <Pencil className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={testing === p.id}
                onClick={() => testPrinter(p)}
                aria-label={t("printers.test_action", { name: p.name })}
                title={t("printers.test_print")}
              >
                <TestTube className="h-4 w-4" aria-hidden="true" />
                {/* Icon-only on phones so the row fits; the aria-label keeps it named. */}
                <span className="hidden sm:inline">
                  {testing === p.id
                    ? t("printers.testing")
                    : t("printers.test_print")}
                </span>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("printers.remove_printer", { name: p.name })}
                title={t("printers.remove_action")}
                onClick={() => setRemoveTarget(p)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          );
        },
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
    ],
    [testing, t],
  );

  // Phone card: name + address, status chip, a primary
  // Test print button, and a ⋯ menu holding Edit and Delete (Delete confirms
  // via the same dialog as the table).
  const printerCard = (p: PrinterRow) => {
    const st = p.status;
    const Icon = TYPE_ICONS[p.printer_type] ?? Printer;
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-accent text-accent-foreground"
          >
            <Icon className="h-6 w-6" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold">{p.name}</p>
            <p
              className="truncate font-mono text-xs text-muted-foreground"
              title={p.address}
            >
              {p.address}
            </p>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("common.actions_for", { name: p.name })}
              >
                <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => openEdit(p)}>
                <Pencil className="h-4 w-4" aria-hidden="true" />
                {t("printers.edit_printer", { name: p.name })}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => setRemoveTarget(p)}
                className="text-danger focus:text-danger"
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                {t("printers.remove_printer", { name: p.name })}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {st === "online" || st === "offline" ? (
            <StatusBadge status={st} />
          ) : (
            <StatusBadge status="unchecked" />
          )}
          <span className="text-xs text-muted-foreground">
            {(() => {
              const conn = PRINTER_TYPES.find(
                (x) => x.value === p.printer_type,
              );
              return conn ? t(conn.labelKey) : p.printer_type;
            })()}
            {p.paper_width_mm ? ` · ${p.paper_width_mm} mm` : ""}
          </span>
        </div>
        <Button
          size="sm"
          variant="secondary"
          className="w-full"
          disabled={testing === p.id}
          onClick={() => testPrinter(p)}
          aria-label={t("printers.test_action", { name: p.name })}
        >
          <TestTube className="h-4 w-4" aria-hidden="true" />
          {testing === p.id ? t("printers.testing") : t("printers.test_print")}
        </Button>
      </div>
    );
  };

  const field = "space-y-1.5";
  // In driver mode the OS queue is addressed by name, so the address is
  // never dialled. Keep it — the row needs it if driver mode is switched
  // back off — but mark it dormant so the field stops looking load-bearing.
  const addressDormant = form.printer_type === "bluetooth" && form.via_driver;
  const addressLabelKey =
    form.printer_type === "system"
      ? "printers.address_name"
      : form.printer_type === "usb"
        ? "printers.address_usb"
        : form.printer_type === "bluetooth"
          ? "printers.address_bluetooth"
          : "common.address";
  const addressHintKey =
    form.printer_type === "ipp"
      ? "printers.hint_ipp"
      : form.printer_type === "raw_tcp"
        ? "printers.hint_raw"
        : form.printer_type === "bluetooth"
          ? addressDormant
            ? "printers.hint_bluetooth_driver"
            : // Android offers the bonded-device list below; the desktop has
              // no list and now prints driverless, so its hint names the
              // OS pairing step instead.
              isAndroid()
              ? "printers.hint_bluetooth"
              : "printers.hint_bluetooth_desktop"
          : null;

  // Item 15: a Windows queue whose print processor offers no PDF datatype
  // sends a PDF job out as RAW, which a GDI-only driver prints as its
  // source text. Best effort — the backend reads the offered list when the
  // dialog scans the machine (cached an hour) and stays silent when it
  // cannot know (remote shares, unreadable list).
  const gdiWarning =
    form.printer_type === "system" &&
    form.language === "pdf" &&
    systemPrinters.some(
      (sp) =>
        sp.pdf_datatype === false &&
        sp.name.trim().toLowerCase() === form.name.trim().toLowerCase(),
    );

  // IPP endpoints speak PDF: with any other language, PrintNinja would
  // send raw printer bytes over IPP, which most endpoints reject.
  // Warn, never refuse (the same physical printer may well work that
  // way — the user knows their device).
  const ippNonPdfWarning =
    form.printer_type === "ipp" && form.language !== "pdf";

  // A legacy row saved before `pdf` was hidden from the raw-wire
  // dropdown: PDF bytes over USB/BT print blank. Warn, never refuse —
  // a few models do read raw PDF, and the backend keeps its print-time
  // warning as the safety net for that edge case.
  const rawWirePdfWarning =
    isRawWire(form.printer_type, form.via_driver) && form.language === "pdf";

  // Android has no System transport: a `system` row (usually synced from
  // a PC) cannot print on this phone. Warn, never refuse — the fix is
  // in the message, and the row stays editable above.
  const systemAndroidWarning = isAndroid() && form.printer_type === "system";

  // A driverless Bluetooth row must hold a MAC or COM port. A USB / print
  // port there is a connection-type mix-up (e.g. the type was switched
  // after filling from a system printer) and is flagged immediately; any
  // other malformed address waits for the first blur.
  const addressIssueKey =
    form.printer_type === "bluetooth" && !form.via_driver
      ? bluetoothAddressIssue(form.address)
      : null;
  const showAddressIssue =
    addressIssueKey !== null &&
    (addressIssueKey === "printers.err_bt_usb_port" || addressTouched);
  // Where the last failed Save's message lives: one inline slot per
  // field. Address-shape keys skip their slot when the live Bluetooth
  // check is already showing the same problem — one message per field.
  const formErrorIsAddress =
    formErrorKey !== null &&
    !showAddressIssue &&
    (formErrorKey === "printers.err_address_required" ||
      formErrorKey === "printers.err_ipp_url" ||
      formErrorKey === "printers.err_raw_tcp" ||
      formErrorKey === "printers.err_bluetooth" ||
      formErrorKey === "printers.err_bt_usb_port");
  const formErrorIsPaper =
    formErrorKey?.startsWith("printers.err_paper") === true;
  const formErrorIsDpi = formErrorKey?.startsWith("printers.err_dpi") === true;
  // The gap field only exists for TSPL; a stored gap failing on another
  // language has no slot, so it falls to the banner below.
  const formErrorIsGap =
    formErrorKey?.startsWith("printers.err_gap") === true &&
    form.language === "tspl";
  const formErrorIsName = formErrorKey === "printers.err_name_required";
  // What no single field owns (unknown type / language, unparsable):
  // one banner at the top of the form.
  const formErrorBanner =
    formErrorKey !== null &&
    !formErrorIsAddress &&
    !formErrorIsPaper &&
    !formErrorIsDpi &&
    !formErrorIsGap &&
    !formErrorIsName;
  const addressDescribedBy =
    [
      addressHintKey ? "printer-address-hint" : null,
      showAddressIssue ? "printer-address-error" : null,
      formErrorIsAddress ? "printer-address-submit-error" : null,
    ]
      .filter(Boolean)
      .join(" ") || undefined;

  return (
    <div className="space-y-4">
      <PageHeader
        title={t(isPhone ? "nav.printers" : "printers.title")}
        description={t("pages.printers")}
      >
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          {t("printers.refresh")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={scanAndAddSystem}
          disabled={scanning}
        >
          <Scan className="h-4 w-4" aria-hidden="true" />
          {scanning ? t("printers.scanning") : t("printers.scan")}
        </Button>
        <Button size="sm" onClick={openAdd}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t("printers.add_printer")}
        </Button>
      </PageHeader>

      {viaPc && (
        <div
          data-testid="printers-via-pc-note"
          className="flex items-center gap-3 rounded-lg border border-info/30 bg-info-soft px-4 py-3 text-info"
        >
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{t("printers.via_pc_note")}</p>
          </div>
          <ExitViaPcButton onExited={() => setViaPc(false)} />
        </div>
      )}

      <Tabs value={tab} onValueChange={setTab} className="w-full">
        {/* Stacked full-width filter rows on phones (mobile.css). */}
        <TabsList>
          {visibleGroups.map((g) => (
            <TabsTrigger key={g.key} value={g.key}>
              {t(g.labelKey)} ({counts(g.types)})
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value={tab} className="mt-4">
          <DataTable
            caption={t("nav.printers")}
            columns={columns}
            data={filtered}
            getRowId={(p) => String(p.id)}
            loading={loading}
            renderCard={printerCard}
            empty={{
              title:
                tab === "all"
                  ? t("printers.empty_title")
                  : t("printers.empty_group", {
                      group: t(group.labelKey).toLowerCase(),
                    }),
              description:
                tab === "all"
                  ? t("printers.empty_hint")
                  : t("printers.empty_group_hint"),
              action: { label: t("printers.empty_action"), onClick: openAdd },
            }}
          />
        </TabsContent>
      </Tabs>

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
        onConfirm={async () => {
          if (removeTarget) await removePrinter(removeTarget);
          setRemoveTarget(null);
        }}
      />

      {/* Setup lives in a side panel so the list stays in view */}
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
                  isAndroid() && form.printer_type === "bluetooth"
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
            <div className={field}>
              <Label htmlFor="printer-name">{t("printers.form_name")}</Label>
              <Input
                id="printer-name"
                value={form.name}
                placeholder={t("printers.form_name_example")}
                aria-invalid={formErrorIsName || undefined}
                aria-describedby={
                  formErrorIsName ? "printer-name-error" : undefined
                }
                onChange={(e) =>
                  setForm((f) => ({ ...f, name: e.target.value }))
                }
              />
              {formErrorIsName && (
                <p
                  id="printer-name-error"
                  role="alert"
                  data-testid="printer-name-error"
                  className="text-xs text-destructive"
                >
                  {t("printers.err_name_required")}
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className={field}>
                {/* Fixed h-6 header row, matching the Language column's
                    label+Detect row, so the two SelectTriggers below line
                    up vertically no matter whether the button renders. */}
                <div className="flex h-6 items-center">
                  <Label htmlFor="printer-connection">
                    {t("printers.form_connection")}
                  </Label>
                </div>
                <Select
                  value={form.printer_type}
                  onValueChange={(v) =>
                    setForm((f) => ({
                      ...f,
                      printer_type: v,
                      // New USB/Bluetooth printers send raw bytes on every
                      // platform (the WebView rasterizes on Android, the
                      // Windows spooler passes the job through as RAW), so
                      // a PDF default would put an unreadable page on a
                      // thermal head — start at ESC/POS instead. An
                      // explicitly chosen language is left alone. Driver
                      // mode keeps PDF valid (the driver rasterizes), and
                      // leaving Bluetooth clears the flag — it is a
                      // Bluetooth-only option.
                      language: defaultLanguageFor(v, f.language, f.via_driver),
                      via_driver: v === "bluetooth" ? f.via_driver : false,
                    }))
                  }
                >
                  <SelectTrigger
                    id="printer-connection"
                    aria-label={t("printers.form_connection")}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {dialogTypes.map((x) => (
                      <SelectItem key={x.value} value={x.value}>
                        {t(x.labelKey)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className={field}>
                {/* h-6 matches the Connection column's header row (and the
                    Detect button), so both selects below start at the same y. */}
                <div className="flex h-6 items-center justify-between gap-2">
                  <Label htmlFor="printer-language">
                    {t("printers.form_language")}
                  </Label>
                  {/* TODO 2+4: ask the printer what it speaks before the
                      row is saved. System printers convert anything the
                      spooler gives them, so there is nothing to ask. */}
                  {form.printer_type !== "system" && (
                    <DisabledReason
                      reason={
                        !detecting && !form.address.trim()
                          ? t("printers.detect_needs_address")
                          : undefined
                      }
                    >
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 gap-1 px-2 text-xs"
                        disabled={detecting || !form.address.trim()}
                        onClick={() => void runDetect()}
                      >
                        <Scan className="h-3 w-3" aria-hidden="true" />
                        {detecting
                          ? t("printers.detecting")
                          : t("printers.detect")}
                      </Button>
                    </DisabledReason>
                  )}
                </div>
                <Select
                  value={form.language}
                  onValueChange={(v) => {
                    languageTouched.current = true;
                    setForm((f) => ({ ...f, language: v }));
                  }}
                >
                  <SelectTrigger
                    id="printer-language"
                    aria-label={t("printers.form_language")}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {visibleLanguages.map((x) => (
                      <SelectItem key={x.value} value={x.value}>
                        {t(x.labelKey)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {languagesLimited && (
              <p
                data-testid="printer-language-hint"
                className="text-xs text-muted-foreground"
              >
                {isAndroid()
                  ? t("printers.lang_android_hint")
                  : t("printers.lang_rawwire_hint")}
              </p>
            )}
            {detectResult && !detecting && (
              <p
                data-testid="printer-detect-result"
                className="text-xs text-muted-foreground"
              >
                {detectResult.detected
                  ? t("printers.detect_done", {
                      name:
                        detectResult.make_and_model ??
                        detectResult.suggested_language ??
                        "",
                    })
                  : t("printers.detect_unknown")}
              </p>
            )}

            <div className={field}>
              <Label htmlFor="printer-address">{t(addressLabelKey)}</Label>
              <Input
                id="printer-address"
                value={form.address}
                // Dormant, not disabled: the value is still saved, and the
                // row dials it again the moment driver mode is switched off.
                aria-disabled={addressDormant || undefined}
                className={addressDormant ? "opacity-60" : undefined}
                aria-describedby={addressDescribedBy}
                aria-invalid={
                  showAddressIssue || formErrorIsAddress || undefined
                }
                onBlur={() => setAddressTouched(true)}
                onChange={(e) =>
                  setForm((f) => ({ ...f, address: e.target.value }))
                }
              />
              {addressHintKey && (
                <p
                  id="printer-address-hint"
                  className="text-xs text-muted-foreground"
                >
                  {t(addressHintKey)}
                </p>
              )}
              {showAddressIssue && addressIssueKey && (
                <p
                  id="printer-address-error"
                  role="alert"
                  data-testid="printer-address-error"
                  className="text-xs text-destructive"
                >
                  {t(addressIssueKey)}
                </p>
              )}
              {formErrorIsAddress && formErrorKey && (
                <p
                  id="printer-address-submit-error"
                  role="alert"
                  data-testid="printer-address-submit-error"
                  className="text-xs text-destructive"
                >
                  {t(formErrorKey)}
                </p>
              )}
            </div>

            {gdiWarning && (
              <div
                role="alert"
                data-testid="printer-gdi-warning"
                className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-warning"
              >
                <AlertTriangle
                  className="mt-0.5 h-4 w-4 shrink-0"
                  aria-hidden="true"
                />
                <p className="text-xs">
                  {t("printers.gdi_warning", { name: form.name })}
                </p>
              </div>
            )}

            {form.printer_type === "raw_tcp" && (
              <div
                role="note"
                className="flex items-start gap-2 rounded-md border border-info/30 bg-info-soft px-3 py-2 text-info"
              >
                <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <p className="text-xs">{t("printers.raw_not_encrypted")}</p>
              </div>
            )}

            {ippNonPdfWarning && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-warning"
              >
                <AlertTriangle
                  className="mt-0.5 h-4 w-4 shrink-0"
                  aria-hidden="true"
                />
                <p className="text-xs">{t("printers.ipp_non_pdf_warning")}</p>
              </div>
            )}

            {rawWirePdfWarning && (
              <div
                role="alert"
                data-testid="printer-raw-pdf-warning"
                className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-warning"
              >
                <AlertTriangle
                  className="mt-0.5 h-4 w-4 shrink-0"
                  aria-hidden="true"
                />
                <p className="text-xs">{t("printers.raw_wire_pdf_warning")}</p>
              </div>
            )}

            {systemAndroidWarning && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-warning"
              >
                <AlertTriangle
                  className="mt-0.5 h-4 w-4 shrink-0"
                  aria-hidden="true"
                />
                <p className="text-xs">
                  {t("printers.system_android_warning")}
                </p>
              </div>
            )}

            {form.printer_type === "ipp" && (
              <FoldSection
                id="printer-signin"
                data-testid="printer-signin-toggle"
                title={t("printers.ipp_signin")}
                summary={
                  form.username || form.password || form.skip_tls_verification
                    ? t("printers.signin_set")
                    : t("printers.signin_unset")
                }
                open={signInOpen}
                onToggle={() => setSignInOpen((v) => !v)}
              >
                <div className="space-y-3">
                  <div className={field}>
                    <Label htmlFor="printer-username">
                      {t("printers.ipp_username")}
                    </Label>
                    <Input
                      id="printer-username"
                      autoComplete="off"
                      value={form.username}
                      aria-describedby="printer-username-hint"
                      onChange={(e) =>
                        setForm((f) => ({ ...f, username: e.target.value }))
                      }
                    />
                    <p
                      id="printer-username-hint"
                      className="text-xs text-muted-foreground"
                    >
                      {t("printers.ipp_username_hint")}
                    </p>
                  </div>
                  <div className={field}>
                    <Label htmlFor="printer-password">
                      {t("printers.ipp_password")}
                    </Label>
                    <Input
                      id="printer-password"
                      type="password"
                      autoComplete="new-password"
                      value={form.password}
                      aria-describedby="printer-password-hint"
                      onChange={(e) =>
                        setForm((f) => ({ ...f, password: e.target.value }))
                      }
                    />
                    <p
                      id="printer-password-hint"
                      className="text-xs text-muted-foreground"
                    >
                      {t("printers.ipp_password_hint")}
                    </p>
                  </div>
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4"
                      checked={form.skip_tls_verification}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          skip_tls_verification: e.target.checked,
                        }))
                      }
                    />
                    <span>
                      {t("printers.ipp_skip_cert")}
                      <span className="block text-xs text-muted-foreground">
                        {t("printers.ipp_skip_cert_hint")}
                      </span>
                    </span>
                  </label>
                </div>
              </FoldSection>
            )}

            {/* Manual driver mode: hidden on Android, which has no driver
                path yet (docs/MISSING_FEATURES.md item 16) — offering a
                toggle that always errors would be worse than not showing
                it. On desktop the choice is total: on = the OS queue of
                this printer's name, off = the driverless wire, and the
                app never switches between them on its own. */}
            {form.printer_type === "bluetooth" && !isAndroid() && (
              <div className="rounded-md border p-3">
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4"
                    checked={form.via_driver}
                    aria-describedby="printer-via-driver-hint"
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        via_driver: e.target.checked,
                        // PDF is only valid through the OS driver; going
                        // back to the raw wire restarts at ESC/POS.
                        language: e.target.checked
                          ? f.language
                          : defaultLanguageFor("bluetooth", f.language, false),
                      }))
                    }
                  />
                  <span>
                    {t("printers.bt_driver")}
                    <span
                      id="printer-via-driver-hint"
                      className="block text-xs text-muted-foreground"
                    >
                      {isLinux()
                        ? t("printers.bt_driver_hint_linux")
                        : t("printers.bt_driver_hint_windows")}
                    </span>
                  </span>
                </label>
              </div>
            )}
            {/* Paper width, DPI and the TSPL label gap: set once per printer,
                so they fold away — the header still shows the values. */}
            <FoldSection
              id="printer-advanced"
              data-testid="printer-advanced-toggle"
              title={t("printers.advanced")}
              summary={t("printers.advanced_summary", {
                paper: form.paper_width_mm || "—",
                dpi: form.dpi || "—",
              })}
              open={advancedOpen}
              onToggle={() => setAdvancedOpen((v) => !v)}
            >
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className={field}>
                    <Label htmlFor="printer-paper">
                      {t("printers.paper_width_mm")}
                    </Label>
                    <Input
                      id="printer-paper"
                      type="number"
                      min="1"
                      max="1000"
                      list="printer-paper-widths"
                      value={form.paper_width_mm}
                      aria-invalid={formErrorIsPaper || undefined}
                      aria-describedby={
                        formErrorIsPaper ? "printer-paper-error" : undefined
                      }
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          paper_width_mm: e.target.value,
                        }))
                      }
                    />
                    <datalist id="printer-paper-widths">
                      {PAPERS.map((x) => (
                        <option key={x.value} value={x.value}>
                          {x.label}
                        </option>
                      ))}
                    </datalist>
                    {formErrorIsPaper && formErrorKey && (
                      <p
                        id="printer-paper-error"
                        role="alert"
                        data-testid="printer-paper-error"
                        className="text-xs text-destructive"
                      >
                        {t(formErrorKey)}
                      </p>
                    )}
                  </div>
                  <div className={field}>
                    <Label htmlFor="printer-dpi">{t("printers.dpi")}</Label>
                    <Input
                      id="printer-dpi"
                      type="number"
                      min="50"
                      max="2400"
                      list="printer-dpis"
                      value={form.dpi}
                      aria-invalid={formErrorIsDpi || undefined}
                      aria-describedby={
                        formErrorIsDpi ? "printer-dpi-error" : undefined
                      }
                      onChange={(e) =>
                        setForm((f) => ({ ...f, dpi: e.target.value }))
                      }
                    />
                    <datalist id="printer-dpis">
                      <option value="203" />
                      <option value="300" />
                      <option value="600" />
                    </datalist>
                    {formErrorIsDpi && formErrorKey && (
                      <p
                        id="printer-dpi-error"
                        role="alert"
                        data-testid="printer-dpi-error"
                        className="text-xs text-destructive"
                      >
                        {t(formErrorKey)}
                      </p>
                    )}
                  </div>
                </div>

                {form.language === "tspl" && (
                  <div className={field}>
                    <Label htmlFor="printer-label-gap">
                      {t("printers.label_gap_mm")}
                    </Label>
                    <Input
                      id="printer-label-gap"
                      type="number"
                      min="0.1"
                      max="50"
                      step="0.1"
                      value={form.label_gap_mm}
                      aria-invalid={formErrorIsGap || undefined}
                      aria-describedby={
                        formErrorIsGap
                          ? "printer-label-gap-hint printer-label-gap-error"
                          : "printer-label-gap-hint"
                      }
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          label_gap_mm: e.target.value,
                        }))
                      }
                    />
                    <p
                      id="printer-label-gap-hint"
                      className="text-xs text-muted-foreground"
                    >
                      {t("printers.label_gap_hint")}
                    </p>
                    {formErrorIsGap && formErrorKey && (
                      <p
                        id="printer-label-gap-error"
                        role="alert"
                        data-testid="printer-label-gap-error"
                        className="text-xs text-destructive"
                      >
                        {t(formErrorKey)}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </FoldSection>
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
    </div>
  );
}
