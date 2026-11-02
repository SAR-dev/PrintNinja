import { describeError, isAlreadyExists } from "@/lib/errors";
import {
  isAndroid,
  supportedPrinterLanguages,
  supportedPrinterTypes,
} from "@/lib/platform";
import { hasPairedProvider } from "@/lib/pairing";
import { TimeoutError, withTimeout } from "@/lib/withTimeout";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { notifySuccess, notifyError, notifyInfo } from "@/lib/notify";
import { validatePrinterForm } from "@/lib/printerSchema";
import type { PrinterRow } from "@/lib/agent/types";

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

interface SystemPrinter {
  id: string;
  name: string;
  address: string;
  status?: string;
  /** Present on network discoveries (`ipp` / `raw_tcp`); absent on OS rows. */
  printer_type?: string;
}

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
  const [printers, setPrinters] = useState<PrinterRow[]>([]);
  const [systemPrinters, setSystemPrinters] = useState<SystemPrinter[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("all");
  const [testing, setTesting] = useState<number | null>(null);
  const [scanning, setScanning] = useState(false);
  const [networkPrinters, setNetworkPrinters] = useState<SystemPrinter[]>([]);
  const [scanningNet, setScanningNet] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<PrinterRow | null>(null);
  const tabListRef = useRef<HTMLDivElement>(null);

  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  // Whether a PC is paired for shared rendering (auto policy): on
  // Android this unlocks the thermal languages, which the PC renders.
  const [pairedProvider, setPairedProvider] = useState(false);
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
  // A mid-word cut tab reads broken on a phone: keep the active one in
  // view when the tab changes — but only when it is actually cut off,
  // so loading never shifts a fully-visible strip.
  useEffect(() => {
    const list = tabListRef.current;
    const active = list?.querySelector('[data-state="active"]');
    if (!list || !active) return;
    const r = active.getBoundingClientRect();
    const lr = list.getBoundingClientRect();
    if (r.left < lr.left || r.right > lr.right) {
      active.scrollIntoView({ inline: "center", block: "nearest" });
    }
  }, [tab]);
  const [form, setForm] = useState({
    name: "",
    printer_type: "ipp",
    address: "",
    language: "pdf",
    paper_width_mm: "80",
    dpi: "203",
  });

  const blankForm = {
    name: "",
    printer_type: "ipp",
    address: "",
    language: "pdf",
    paper_width_mm: "80",
    dpi: "203",
  };

  const openAdd = () => {
    setEditingId(null);
    setForm(blankForm);
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
    });
    setShowAdd(true);
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
      .catch(() => setSystemPrinters([]));
    // A paired PC (auto policy) unlocks the thermal languages on Android.
    void hasPairedProvider().then(setPairedProvider);
    // Background mDNS browse for 30s after mount (one-shot, not continuous)
    // so printers appear without an extra tap.
    void agent("discover_network_printers", { timeout_secs: 8 })
      .then((list) => {
        if (list && list.length > 0) setNetworkPrinters(list);
      })
      .catch(() => {});
    // Keep a low-frequency background scan for 30s: re-browse once at 15s
    const bg = window.setTimeout(() => {
      void agent("discover_network_printers", { timeout_secs: 8 })
        .then((list) => {
          if (list && list.length > 0) setNetworkPrinters(list);
        })
        .catch(() => {});
    }, 15000);
    return () => window.clearTimeout(bg);
  }, [load]);

  const refreshSystem = async () => {
    try {
      const list = await agent("enumerate_system_printers", {});
      setSystemPrinters(list ?? []);
      notifySuccess(t("printers.toast_found_system", { count: list.length }));
    } catch (e) {
      notifyError(
        t("printers.toast_discovery_failed", { error: describeError(e) }),
      );
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
      if (!list || list.length === 0) {
        notifyInfo(t("printers.toast_no_network"));
      }
    } catch (e) {
      notifyError(
        t("printers.toast_discovery_failed", { error: describeError(e) }),
      );
    } finally {
      setScanningNet(false);
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
          language: printerType === "ipp" ? "pdf" : pairedProvider ? "escpos" : "pdf",
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
      let added = 0;
      let skipped = 0;
      for (const sp of list) {
        if (printers.some((p) => p.name === sp.name)) {
          skipped++;
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
          added++;
        } catch {
          // ignore duplicate / validation errors per-printer
        }
      }
      await load();
      // refresh discovered list too
      setSystemPrinters(list);
      if (added > 0)
        notifySuccess(
          `Added ${added} system printer(s)${skipped ? `, ${skipped} already existed` : ""}`,
        );
      else if (skipped)
        notifyInfo(t("printers.toast_all_added", { count: skipped }));
      else notifyInfo(t("printers.toast_none_new"));
    } catch (e) {
      notifyError(t("printers.toast_scan_failed", { error: describeError(e) }));
    } finally {
      setScanning(false);
    }
  };

  const addPrinter = async () => {
    const parsed = validatePrinterForm(form);
    if (!parsed.ok) {
      notifyError(t(parsed.messageKey));
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
  // Android renders PDF only, so the command languages are hidden there. A
  // saved row that already uses one stays visible so editing it does not
  // silently change its language. With a paired PC the thermal languages
  // come back: the PC renders them through shared rendering.
  const visibleLanguages = useMemo(() => {
    const supported = supportedPrinterLanguages(LANGUAGES, {
      pairedProvider,
    });
    if (supported.some((l) => l.value === form.language)) return supported;
    const current = LANGUAGES.find((l) => l.value === form.language);
    return current ? [...supported, current] : supported;
  }, [form.language, pairedProvider]);
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
        header: "Printer",
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
        header: "Status",
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
        : null;

  return (
    <div className="space-y-4">
      <PageHeader title={t("printers.title")} description={t("pages.printers")}>
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
        {/* Edge fade signals the row scrolls on phones. */}
        <TabsList
          ref={tabListRef}
          className="[mask-image:linear-gradient(to_right,black_calc(100%-12px),transparent)]"
        >
          {visibleGroups.map((g) => (
            <TabsTrigger key={g.key} value={g.key}>
              {t(g.labelKey)} ({counts(g.types)})
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value={tab} className="mt-4">
          <DataTable
            caption="Printers"
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
            {systemPrinters.length > 0 && (
              <div className="rounded-md border p-3">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-xs font-medium">
                    {t("printers.found_system")}
                  </p>
                  <Button variant="ghost" size="sm" onClick={refreshSystem}>
                    {t("printers.rescan")}
                  </Button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {systemPrinters.map((sp) => (
                    <Button
                      key={sp.id}
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setForm((f) => ({
                          ...f,
                          name: sp.name,
                          address: sp.name,
                          printer_type: "system",
                        }))
                      }
                    >
                      {sp.name}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            <div className="rounded-md border p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs font-medium">
                  {t("printers.found_network")}
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={scanNetwork}
                  disabled={scanningNet}
                  data-testid="printers-scan-network"
                >
                  {scanningNet ? t("printers.scanning") : t("printers.rescan")}
                </Button>
              </div>
              {networkPrinters.length > 0 ? (
                <div className="space-y-1.5">
                  {networkPrinters.map((np) => (
                    <div
                      key={np.id}
                      className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5"
                      data-testid={`discovered-printer-${np.id}`}
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{np.name}</p>
                        <p className="truncate font-mono text-xs text-muted-foreground">
                          {np.address} · {np.printer_type ?? "ipp"}
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-1.5">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setForm((f) => ({
                              ...f,
                              name: np.name,
                              address: np.address,
                              printer_type: np.printer_type ?? "ipp",
                              language:
                                (np.printer_type ?? "ipp") === "ipp"
                                  ? "pdf"
                                  : pairedProvider
                                    ? "escpos"
                                    : f.language,
                            }))
                          }
                        >
                          Fill
                        </Button>
                        <Button size="sm" onClick={() => void addDiscovered(np)}>
                          {t("common.add")}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                !scanningNet && (
                  <p className="text-xs text-muted-foreground">
                    {t("printers.no_network_printers")}
                  </p>
                )
              )}
            </div>

            <div className={field}>
              <Label htmlFor="printer-name">{t("printers.form_name")}</Label>
              <Input
                id="printer-name"
                value={form.name}
                placeholder={t("printers.form_name_example")}
                onChange={(e) =>
                  setForm((f) => ({ ...f, name: e.target.value }))
                }
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className={field}>
                <Label htmlFor="printer-connection">
                  {t("printers.form_connection")}
                </Label>
                <Select
                  value={form.printer_type}
                  onValueChange={(v) =>
                    setForm((f) => ({
                      ...f,
                      printer_type: v,
                      // New USB/Bluetooth printers on a paired phone print
                      // through the PC, which renders thermal languages: a
                      // PDF default would put an unreadable page on a
                      // thermal head, so start at ESC/POS instead. An
                      // explicitly chosen language is left alone.
                      language:
                        pairedProvider &&
                        isAndroid() &&
                        (v === "usb" || v === "bluetooth") &&
                        f.language === "pdf"
                          ? "escpos"
                          : f.language,
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
                    {visibleTypes.map((x) => (
                      <SelectItem key={x.value} value={x.value}>
                        {t(x.labelKey)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className={field}>
                <Label htmlFor="printer-language">
                  {t("printers.form_language")}
                </Label>
                <Select
                  value={form.language}
                  onValueChange={(v) => setForm((f) => ({ ...f, language: v }))}
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
              <p className="text-xs text-muted-foreground">
                {t("printers.lang_android_hint")}
              </p>
            )}

            <div className={field}>
              <Label htmlFor="printer-address">{t(addressLabelKey)}</Label>
              <Input
                id="printer-address"
                value={form.address}
                aria-describedby={
                  addressHintKey ? "printer-address-hint" : undefined
                }
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
            </div>

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
                  onChange={(e) =>
                    setForm((f) => ({ ...f, paper_width_mm: e.target.value }))
                  }
                />
                <datalist id="printer-paper-widths">
                  {PAPERS.map((x) => (
                    <option key={x.value} value={x.value}>
                      {x.label}
                    </option>
                  ))}
                </datalist>
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
                  onChange={(e) =>
                    setForm((f) => ({ ...f, dpi: e.target.value }))
                  }
                />
                <datalist id="printer-dpis">
                  <option value="203" />
                  <option value="300" />
                  <option value="600" />
                </datalist>
              </div>
            </div>
          </div>

          <DialogFooter className="gap-2 border-t p-5 sm:space-x-0">
            <Button variant="outline" onClick={() => setShowAdd(false)}>
              Cancel
            </Button>
            <Button onClick={addPrinter}>{t("printers.save_action")}</Button>
          </DialogFooter>
        </SheetContent>
      </Sheet>
    </div>
  );
}
