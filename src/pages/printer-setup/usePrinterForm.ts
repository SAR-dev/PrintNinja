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
import { useLocalNetworkPermission } from "@/lib/android/useLocalNetworkPermission";
import { describeError, isAlreadyExists } from "@/lib/errors";
import { notifyError, notifySuccess } from "@/lib/notify";
import { agent } from "@/lib/agent/commands";
import {
  bluetoothAddressIssue,
  defaultLanguageFor,
  validatePrinterForm,
  type LoosePrinterForm,
} from "@/lib/printerSchema";
import type {
  ProfileInfo,
  PrinterRow,
  ProbeCapabilitiesResult,
} from "@/lib/agent/types";
import type { DetectedKind } from "@/components/printers/DetectedDevices";
import {
  GROUPS,
  LANGUAGES,
  PRINTER_TYPES,
  isRawWire,
  labelProfileFamily,
  type SystemPrinter,
} from "./constants";
import type { usePrinterDiscovery } from "./usePrinterDiscovery";
import type { usePrinters } from "./usePrinters";

/**
 * The ESC/POS raster band height a row already has, as a form string: the
 * `escpos.bandRows` key of the row's settings JSON. Missing or malformed
 * reads as blank — the built-in 256 rows.
 */
function escposBandRowsFromRow(json: string | null | undefined): string {
  if (!json) return "";
  try {
    const root = JSON.parse(json) as { escpos?: { bandRows?: number } };
    const rows = root.escpos?.bandRows;
    return rows != null && Number.isFinite(rows) ? String(rows) : "";
  } catch {
    return "";
  }
}

/**
 * The Bluetooth pacing a row already has, as form strings: the `bluetooth`
 * key of the row's settings JSON (B4). A missing, half-empty or malformed
 * value reads as blank — the built-in defaults — the same leniency the
 * Rust side applies when it prints.
 */
function bluetoothPaceFromRow(json: string | null | undefined): {
  chunkBytes: string;
  pauseMs: string;
} {
  const blank = { chunkBytes: "", pauseMs: "" };
  if (!json) return blank;
  try {
    const root = JSON.parse(json) as {
      bluetooth?: { chunkBytes?: number; chunkPauseMs?: number };
    };
    const bt = root.bluetooth;
    return {
      chunkBytes:
        bt?.chunkBytes != null && Number.isFinite(bt.chunkBytes)
          ? String(bt.chunkBytes)
          : "",
      pauseMs:
        bt?.chunkPauseMs != null && Number.isFinite(bt.chunkPauseMs)
          ? String(bt.chunkPauseMs)
          : "",
    };
  } catch {
    return blank;
  }
}

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
  const { scanBluetooth, setNetworkPrinters } = discovery;
  const {
    granted: lanGranted,
    canAskAgain: lanCanAskAgain,
    ask: askLan,
  } = useLocalNetworkPermission();
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
  // The password field is never prefilled, so "touched" is what separates
  // "keep what is stored" from "the person actually changed it".
  const [passwordTouched, setPasswordTouched] = useState(false);
  // Whether the row being edited carries a stored password — the hint
  // under the (always blank) field depends on it.
  const [editHasPassword, setEditHasPassword] = useState(false);
  // The model pick the row being edited already carries (null for a new
  // row): Save rewrites the pick only when it actually changed, so an
  // untouched pick never round-trips the backend.
  const [editLabelProfile, setEditLabelProfile] = useState<string | null>(null);
  // The bundled label models, as the backend ships them — embedded at
  // compile time, so one fetch per page mount is the whole lifetime.
  const [labelProfiles, setLabelProfiles] = useState<ProfileInfo[] | null>(
    null,
  );
  useEffect(() => {
    if (labelProfiles) return;
    void agent("label_list_profiles", {})
      .then((list) => {
        if (Array.isArray(list)) setLabelProfiles(list);
      })
      .catch(() => {});
  }, [labelProfiles]);
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
    bt_chunk_bytes: "",
    bt_chunk_pause_ms: "",
    escpos_band_rows: "",
    label_profile: "",
    username: "",
    password: "",
    skip_tls_verification: false,
    via_driver: false,
  });
  // Android: the local network permission is off while the form would
  // reach the LAN (saving a new ipp / raw_tcp row, or running Detect on
  // one) — the explanation dialog opens instead, and the quiet scan
  // picks the list back up once the permission comes back.
  const [lanPromptOpen, setLanPromptOpen] = useState(false);
  // The one failing check from the last Save, as an i18n key, shown
  // inline next to the failing field instead of a toast. Any edit to
  // any field clears it — the person is already on top of it.
  const [formErrorKey, setFormErrorKey] = useState<string | null>(null);
  const setForm = (update: SetStateAction<LoosePrinterForm>) => {
    setFormRaw((prev) => {
      const next = typeof update === "function" ? update(prev) : update;
      // A model pick belongs to the row's language family — the backend
      // would refuse to write it to a row of another family — so a
      // language change orphans it and the field starts over at auto.
      return next.language !== prev.language
        ? { ...next, label_profile: "" }
        : next;
    });
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
    bt_chunk_bytes: "",
    bt_chunk_pause_ms: "",
    escpos_band_rows: "",
    label_profile: "",
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
    setPasswordTouched(false);
    setEditHasPassword(false);
    setEditLabelProfile(null);
    setLanPromptOpen(false);
    setFormErrorKey(null);
  };

  // After a successful add or save: hide the sheet and clear everything so
  // the next open starts from a blank form. A failed save deliberately
  // skips this — the sheet stays open with the values still in it.
  const closeAndReset = () => {
    setShowAdd(false);
    setEditingId(null);
    setFormRaw(blankForm);
    resetDialogUi();
  };

  const openAdd = () => {
    setEditingId(null);
    setFormRaw(blankForm);
    setDetectResult(null);
    languageTouched.current = false;
    resetDialogUi();
    setShowAdd(true);
  };

  const openEdit = (p: PrinterRow) => {
    setEditingId(p.id);
    const pace = bluetoothPaceFromRow(p.default_settings_json);
    setFormRaw({
      name: p.name,
      printer_type: p.printer_type,
      address: p.address,
      language: p.language,
      paper_width_mm: String(p.paper_width_mm ?? "72"),
      dpi: String(p.dpi ?? "203"),
      label_gap_mm: p.label_gap_mm != null ? String(p.label_gap_mm) : "",
      bt_chunk_bytes: pace.chunkBytes,
      bt_chunk_pause_ms: pace.pauseMs,
      escpos_band_rows: escposBandRowsFromRow(p.default_settings_json),
      // null (no pick) reads as "" — the language-based default.
      label_profile: p.label_profile ?? "",
      username: p.username ?? "",
      // Never prefill: the row no longer carries the value, and blank
      // means "keep what is stored".
      password: "",
      skip_tls_verification: p.skip_tls_verification ?? false,
      via_driver: p.via_driver ?? false,
    });
    setDetectResult(null);
    languageTouched.current = false;
    resetDialogUi();
    setEditLabelProfile(p.label_profile ?? null);
    setEditHasPassword(Boolean(p.has_password));
    setSignInOpen(
      Boolean(p.username || p.has_password || p.skip_tls_verification),
    );
    setShowAdd(true);
  };

  // The connection types that dial out over the local network.
  const isLanType = (type: string) => type === "ipp" || type === "raw_tcp";

  /** Ask the printer what it speaks and pre-fill the language if the
   * operator has not picked one yet. Never fails the form: a probe
   * problem shows as "unknown", the same as a silent printer. On
   * Android the probe dials the LAN, so a denied permission opens the
   * explanation dialog instead of the probe. */
  const runDetect = async () => {
    if (isAndroid() && !lanGranted && isLanType(form.printer_type)) {
      setLanPromptOpen(true);
      return;
    }
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

  // On Android the page no longer browses the LAN on mount (usePrinters):
  // the one quiet browse rides on the sheet instead, and only when the
  // local-network permission is already granted — a denied permission
  // shows the explanation, not a silently empty list. Once per open,
  // no scanning state and no toasts: it just keeps the detected rows
  // fresh for the person who just asked to see them.
  const quietScanDone = useRef(false);
  useEffect(() => {
    if (!showAdd) {
      quietScanDone.current = false;
      return;
    }
    if (!isAndroid() || !lanGranted || quietScanDone.current) return;
    quietScanDone.current = true;
    void agent("discover_network_printers", { timeout_secs: 8 })
      .then((list) => {
        if (list && list.length > 0) setNetworkPrinters(list);
      })
      .catch(() => {});
  }, [showAdd, lanGranted, setNetworkPrinters]);

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

  // The detected-row Add is one tap; a double-tap while the first is still
  // in flight would otherwise add the printer twice.
  const addDiscoveredInFlight = useRef(false);

  const addDiscovered = (np: SystemPrinter) => {
    const printerType = np.printer_type ?? "ipp";
    // Bluetooth rows are confirmed before saving (B1): the paper width
    // decides whether the page fits, and a blind 80 mm default is the
    // classic 2-inch-thermal failure. One tap fills the form with a
    // safe 2-inch width and leaves the sheet open; Save commits.
    if (printerType === "bluetooth") {
      fillFromDetected("bluetooth", np);
      setForm((f) => ({ ...f, paper_width_mm: "54" }));
      // The width is folded away under Advanced — open it so the
      // confirmation is something the user can actually see.
      setAdvancedOpen(true);
      return;
    }
    void addDetectedNow(np);
  };

  const addDetectedNow = async (np: SystemPrinter) => {
    if (addDiscoveredInFlight.current) return;
    addDiscoveredInFlight.current = true;
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
      // One-tap add is done: close the sheet just like Save does.
      closeAndReset();
      await list.load();
    } catch (e) {
      // Failure keeps the sheet open so the row is still there to retry.
      notifyError(t("printers.toast_save_failed", { error: describeError(e) }));
    } finally {
      addDiscoveredInFlight.current = false;
    }
  };

  const addPrinter = async () => {
    const parsed = validatePrinterForm(form);
    if (!parsed.ok) {
      // The paper / DPI / gap / Bluetooth-pace fields are folded away:
      // open them so the error points at something visible.
      if (
        /^printers\.err_(paper|dpi|gap|bt_chunk|bt_pause|escpos_band)/.test(
          parsed.messageKey,
        )
      ) {
        setAdvancedOpen(true);
      }
      setAddressTouched(true);
      // The message lands inline next to the failing field, not in a
      // toast — the field is right here on screen.
      setFormErrorKey(parsed.messageKey);
      return;
    }
    const req = parsed.req;
    // The password field is never prefilled, so on an edit a blank,
    // untouched field means "keep the stored password": omit it from the
    // request. Only a value the person typed (or a deliberately cleared
    // field) is sent — a blank string there clears the stored password.
    if (editingId !== null && !passwordTouched) {
      req.password = undefined;
    }
    // Adding by IP needs the LAN on Android; editing an existing row
    // does not (it only rewrites the local config), so it goes through.
    if (
      editingId === null &&
      isAndroid() &&
      !lanGranted &&
      isLanType(req.printer_type)
    ) {
      setLanPromptOpen(true);
      return;
    }
    try {
      const saved =
        editingId === null
          ? await agent("add_printer", { req })
          : await agent("update_printer", { id: editingId, req });
      if (req.printer_type === "bluetooth" && !req.via_driver) {
        // Pacing (B4) is a per-row setting stored outside the core row,
        // so it rides a second call after the row exists. A cleared field
        // is omitted, not sent as null: the backend fills a missing half
        // with its default, and a null half would be a type error. A
        // failure here loses only the custom pace, not the row — the
        // row is already saved and printable at the defaults.
        try {
          await agent("set_printer_bluetooth_delivery", {
            id: saved.id,
            delivery:
              req.bt_chunk_bytes == null && req.bt_chunk_pause_ms == null
                ? null
                : {
                    ...(req.bt_chunk_bytes != null
                      ? { chunkBytes: req.bt_chunk_bytes }
                      : {}),
                    ...(req.bt_chunk_pause_ms != null
                      ? { chunkPauseMs: req.bt_chunk_pause_ms }
                      : {}),
                  },
          });
        } catch (e) {
          notifyError(
            t("printers.toast_save_failed", { error: describeError(e) }),
          );
        }
      }
      if (req.language === "escpos") {
        // The ESC/POS band height is a per-row setting stored outside the
        // core row, so it rides a second call after the row exists. A
        // cleared field sends null (the built-in 256 rows). A failure here
        // loses only the custom band height, not the row.
        try {
          await agent("set_printer_escpos_tuning", {
            id: saved.id,
            tuning:
              req.escpos_band_rows == null
                ? null
                : { bandRows: req.escpos_band_rows },
          });
        } catch (e) {
          notifyError(
            t("printers.toast_save_failed", { error: describeError(e) }),
          );
        }
      }
      if (labelProfileFamily(req.language) !== null) {
        // The label model pick is a per-row setting stored outside the
        // core row, so it rides a second call after the row exists — the
        // same shape as the pacing and band height above, and skipped
        // entirely while it matches what the row already carries. A
        // cleared field sends null (the language-based default). A
        // failure here loses only the pick, not the row.
        if (form.label_profile !== (editLabelProfile ?? "")) {
          try {
            await agent("label_set_printer_profile", {
              printer_id: saved.id,
              profile_id: form.label_profile || null,
            });
          } catch (e) {
            notifyError(
              t("printers.toast_save_failed", { error: describeError(e) }),
            );
          }
        }
      }
      notifySuccess(
        editingId === null
          ? t("printers.toast_added", { name: form.name.trim() })
          : t("printers.toast_saved", { name: form.name.trim() }),
      );
      closeAndReset();
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
  // The model picker's options: the bundled profiles of the row's own
  // language family — a ZPL row never sees an ESC/POS model. Empty while
  // the list is still loading (the trigger shows nothing yet) or for a
  // PDF row, which has no picker at all.
  const labelModelOptions = useMemo(() => {
    const family = labelProfileFamily(form.language);
    return family && labelProfiles
      ? labelProfiles.filter((p) => p.language === family)
      : [];
  }, [form.language, labelProfiles]);
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
  // The pace fields only exist for a driverless Bluetooth row; a stored
  // pace failing on any other row has no slot, so it falls to the banner.
  const paceVisible = form.printer_type === "bluetooth" && !form.via_driver;
  const formErrorIsChunk =
    paceVisible && formErrorKey?.startsWith("printers.err_bt_chunk") === true;
  const formErrorIsPause =
    paceVisible && formErrorKey?.startsWith("printers.err_bt_pause") === true;
  // The band-height field only exists for ESC/POS; a stored value failing
  // on another language has no slot, so it falls to the banner below.
  const formErrorIsBand =
    formErrorKey?.startsWith("printers.err_escpos_band") === true &&
    form.language === "escpos";
  const formErrorIsName = formErrorKey === "printers.err_name_required";
  // What no single field owns (unknown type / language, unparsable):
  // one banner at the top of the form.
  const formErrorBanner =
    formErrorKey !== null &&
    !formErrorIsAddress &&
    !formErrorIsPaper &&
    !formErrorIsDpi &&
    !formErrorIsGap &&
    !formErrorIsChunk &&
    !formErrorIsPause &&
    !formErrorIsBand &&
    !formErrorIsName;
  const addressDescribedBy =
    [
      addressHintKey ? "printer-address-hint" : null,
      showAddressIssue ? "printer-address-error" : null,
      formErrorIsAddress ? "printer-address-submit-error" : null,
    ]
      .filter(Boolean)
      .join(" ") || undefined;

  // The saved-password hint under the (always blank) field: only while
  // editing a row that has one, and until the person touches the field.
  const passwordKeepHint = editHasPassword && !passwordTouched;

  return {
    showDetected,
    setShowDetected,
    lanGranted,
    lanCanAskAgain,
    lanPromptOpen,
    setLanPromptOpen,
    askLan,
    advancedOpen,
    setAdvancedOpen,
    signInOpen,
    setSignInOpen,
    passwordTouched,
    setPasswordTouched,
    passwordKeepHint,
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
    labelModelOptions,
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
    formErrorIsChunk,
    formErrorIsPause,
    formErrorIsBand,
    formErrorIsName,
    formErrorBanner,
    addressDescribedBy,
  };
}
