import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type SetStateAction,
} from "react";
import { useTranslation } from "react-i18next";
import {
  isAndroid,
  supportedPrinterLanguages,
  supportedPrinterTypes,
} from "@/lib/platform";
import { describeError, isAlreadyExists } from "@/lib/errors";
import { notifyError, notifySuccess } from "@/lib/notify";
import { agent } from "@/lib/agent/commands";
import {
  bluetoothAddressIssue,
  defaultLanguageFor,
  validatePrinterForm,
  type LoosePrinterForm,
} from "@/lib/printerSchema";
import type { PrinterRow, ProbeCapabilitiesResult } from "@/lib/agent/types";
import type { DetectedKind } from "@/components/printers/DetectedDevices";
import {
  GROUPS,
  LANGUAGES,
  PRINTER_TYPES,
  isRawWire,
  type SystemPrinter,
} from "./constants";
import type { usePrinterDiscovery } from "./usePrinterDiscovery";
import type { usePrinters } from "./usePrinters";

/**
 * The Add/Edit sheet: the form itself, its per-field error placement,
 * the capability probe and the save/remove of a single printer row.
 * Discovery lists come from `usePrinterDiscovery`; `load` (from
 * `usePrinters`) refreshes the table after a successful save.
 */
export function usePrinterForm(
  discovery: ReturnType<typeof usePrinterDiscovery>,
  list: ReturnType<typeof usePrinters>,
) {
  const { t } = useTranslation();
  const { scanBluetooth } = discovery;
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
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setFormRaw] = useState<LoosePrinterForm>({
    name: "",
    printer_type: "ipp",
    address: "",
    language: "pdf",
    paper_width_mm: "72",
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
    paper_width_mm: "72",
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
      paper_width_mm: String(p.paper_width_mm ?? "72"),
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

  /** One Rescan for every source the dialog currently shows. */
  const rescanAll = () => {
    const jobs: Promise<void>[] = [];
    if (!isAndroid()) jobs.push(discovery.refreshSystem());
    jobs.push(discovery.scanNetwork());
    if (isAndroid() && form.printer_type === "bluetooth") {
      jobs.push(scanBluetooth());
    }
    void Promise.all(jobs);
  };

  // The moment the dialog is on Bluetooth (Android), list the bonded
  // printers: they are one tap away, no MAC to type.
  useEffect(() => {
    if (showAdd && isAndroid() && form.printer_type === "bluetooth") {
      void scanBluetooth();
    }
  }, [showAdd, form.printer_type, scanBluetooth]);

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
      await list.load();
    } catch (e) {
      notifyError(t("printers.toast_save_failed", { error: describeError(e) }));
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
      await list.load();
    } catch (e) {
      const msg = describeError(e);
      notifyError(
        isAlreadyExists(e)
          ? msg
          : t("printers.toast_save_failed", { error: msg }),
      );
    }
  };

  const counts = (types: string[] | null) =>
    types
      ? list.printers.filter((p) => types.includes(p.printer_type)).length
      : list.printers.length;
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
  const group =
    visibleGroups.find((g) => g.key === list.tab) ?? visibleGroups[0];
  const filtered = group.types
    ? list.printers.filter((p) => group.types?.includes(p.printer_type))
    : list.printers;

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
    discovery.systemPrinters.some(
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

  return {
    showDetected,
    setShowDetected,
    advancedOpen,
    setAdvancedOpen,
    signInOpen,
    setSignInOpen,
    addressTouched,
    setAddressTouched,
    showAdd,
    setShowAdd,
    editingId,
    setEditingId,
    form,
    setForm,
    blankForm,
    formErrorKey,
    resetDialogUi,
    openAdd,
    openEdit,
    runDetect,
    rescanAll,
    fillFromDetected,
    addDiscovered,
    addPrinter,
    detecting,
    detectResult,
    languageTouched,
    visibleTypes,
    visibleGroups,
    group,
    filtered,
    counts,
    dialogTypes,
    visibleLanguages,
    languagesLimited,
    addressDormant,
    addressLabelKey,
    addressHintKey,
    gdiWarning,
    ippNonPdfWarning,
    rawWirePdfWarning,
    systemAndroidWarning,
    addressIssueKey,
    showAddressIssue,
    formErrorIsAddress,
    formErrorIsPaper,
    formErrorIsDpi,
    formErrorIsGap,
    formErrorIsName,
    formErrorBanner,
    addressDescribedBy,
  };
}
