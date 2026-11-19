import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Pencil,
  Printer,
  TestTube,
  Trash2,
  MoreHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/DataTable";
import { StatusBadge } from "@/components/StatusBadge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { PrinterRow } from "@/lib/agent/types";
import { LANGUAGES, PRINTER_TYPES, TYPE_ICONS } from "./constants";

type Group = { key: string; labelKey: string; types: string[] | null };

/**
 * The printers list: connection-type filter tabs, the desktop table and
 * the phone card layout. Row actions (edit / test / remove) are handed
 * down from the page's hooks.
 */
export function PrinterTable({
  tab,
  setTab,
  visibleGroups,
  counts,
  filtered,
  group,
  loading,
  testing,
  openAdd,
  openEdit,
  testPrinter,
  setRemoveTarget,
}: {
  tab: string;
  setTab: (t: string) => void;
  visibleGroups: Group[];
  counts: (types: string[] | null) => number;
  filtered: PrinterRow[];
  group: Group;
  loading: boolean;
  testing: number | null;
  openAdd: () => void;
  openEdit: (p: PrinterRow) => void;
  testPrinter: (p: PrinterRow) => void;
  setRemoveTarget: (p: PrinterRow) => void;
}) {
  const { t } = useTranslation();

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

  return (
    <Tabs value={tab} onValueChange={setTab} className="w-full">
      {/* Stacked full-width filter rows on phones (TabsList max-md: classes). */}
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
  );
}
