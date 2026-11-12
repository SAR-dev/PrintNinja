import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Bluetooth,
  ChevronDown,
  Monitor,
  Wifi,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** One thing the app found: an OS print queue, an mDNS hit or a paired device. */
export interface DetectedDevice {
  id: string;
  name: string;
  address: string;
  status?: string;
  /** Present on network discoveries (`ipp` / `raw_tcp`); absent on OS rows. */
  printer_type?: string;
  /** Windows spooler rows only: queue offers a PDF datatype. */
  pdf_datatype?: boolean | null;
}

export type DetectedKind = "system" | "network" | "bluetooth";

interface Props {
  /** OS print queues; `null` hides the section (Android has no spooler). */
  system: DetectedDevice[] | null;
  /** True once the first OS enumeration has answered (no "none found" flash). */
  systemLoaded: boolean;
  network: DetectedDevice[];
  /** Paired Bluetooth printers; `null` hides the section (Android + Bluetooth only). */
  bluetooth: DetectedDevice[] | null;
  /** Any of the sources is being scanned right now. */
  scanning: boolean;
  onRescan: () => void;
  onFill: (kind: DetectedKind, device: DetectedDevice) => void;
  /** One-tap add for network and Bluetooth rows; omitted while editing. */
  onAdd?: (kind: DetectedKind, device: DetectedDevice) => void;
  /** Android only: opens the OS Bluetooth screen where pairing happens. */
  onOpenBluetoothSettings?: () => void;
}

const TEST_IDS: Record<DetectedKind, (id: string) => string> = {
  system: (id) => `discovered-system-${id}`,
  network: (id) => `discovered-printer-${id}`,
  bluetooth: (id) => `discovered-bluetooth-${id}`,
};

/**
 * Everything the app found, in one block: a single Rescan button and one
 * collapsed row per source showing only its count. A list opens on demand,
 * so a PC with a dozen virtual printers (OneNote, Print to PDF, …) or a
 * background mDNS hit never pushes the form down or resizes the panel.
 */
export function DetectedDevices({
  system,
  systemLoaded,
  network,
  bluetooth,
  scanning,
  onRescan,
  onFill,
  onAdd,
  onOpenBluetoothSettings,
}: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<Record<DetectedKind, boolean>>({
    system: false,
    network: false,
    bluetooth: false,
  });
  const toggle = (k: DetectedKind) => setOpen((o) => ({ ...o, [k]: !o[k] }));

  const total =
    (system?.length ?? 0) + network.length + (bluetooth?.length ?? 0);

  return (
    <div className="rounded-md border" data-testid="printers-detected">
      <div className="flex items-center justify-between gap-2 px-3 pt-2">
        <p className="text-xs font-medium">
          {t("printers.detected_title")}
          <span className="font-normal text-muted-foreground"> · {total}</span>
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRescan}
          disabled={scanning}
          data-testid="printers-scan-network"
        >
          {scanning ? t("printers.scanning") : t("printers.rescan")}
        </Button>
      </div>

      <div className="divide-y px-3 pb-1">
        {system && (
          <Section
            kind="system"
            icon={Monitor}
            label={t("printers.found_system")}
            devices={system}
            expanded={open.system}
            onToggle={() => toggle("system")}
            emptyHint={
              !scanning && systemLoaded
                ? t("printers.no_system_printers")
                : null
            }
            data-testid="printers-toggle-system"
            onFill={onFill}
          />
        )}
        <Section
          kind="network"
          icon={Wifi}
          label={t("printers.found_network")}
          devices={network}
          expanded={open.network}
          onToggle={() => toggle("network")}
          emptyHint={!scanning ? t("printers.no_network_printers") : null}
          data-testid="printers-toggle-network"
          onFill={onFill}
          onAdd={onAdd}
        />
        {bluetooth && (
          <Section
            kind="bluetooth"
            icon={Bluetooth}
            label={t("printers.found_bluetooth")}
            devices={bluetooth}
            expanded={open.bluetooth}
            onToggle={() => toggle("bluetooth")}
            emptyHint={
              !scanning ? (
                <>
                  {t("printers.no_bluetooth_printers")}
                  <br />
                  {t("printers.bluetooth_settings_hint")}
                </>
              ) : null
            }
            data-testid="printers-toggle-bluetooth"
            onFill={onFill}
            onAdd={onAdd}
            action={
              onOpenBluetoothSettings && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onOpenBluetoothSettings}
                  data-testid="printers-open-bluetooth-settings"
                >
                  {t("printers.bluetooth_settings_button")}
                </Button>
              )
            }
          />
        )}
      </div>
    </div>
  );
}

interface SectionProps {
  kind: DetectedKind;
  icon: typeof Wifi;
  label: string;
  devices: DetectedDevice[];
  expanded: boolean;
  onToggle: () => void;
  emptyHint: ReactNode;
  "data-testid": string;
  onFill: Props["onFill"];
  onAdd?: Props["onAdd"];
  action?: ReactNode;
}

function Section({
  kind,
  icon: Icon,
  label,
  devices,
  expanded,
  onToggle,
  emptyHint,
  "data-testid": toggleTestId,
  onFill,
  onAdd,
  action,
}: SectionProps) {
  const { t } = useTranslation();
  const empty = devices.length === 0;
  return (
    <div className="py-1.5">
      <div className="flex items-center justify-between gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 justify-start gap-1.5 text-xs"
          aria-expanded={expanded}
          disabled={empty}
          onClick={onToggle}
          data-testid={toggleTestId}
        >
          <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {label} ({devices.length})
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 shrink-0 transition-transform",
              expanded && "rotate-180",
            )}
            aria-hidden="true"
          />
        </Button>
        {action}
      </div>
      {empty && emptyHint && (
        <p className="pb-1 text-xs text-muted-foreground">{emptyHint}</p>
      )}
      {expanded && !empty && (
        <div className="space-y-1.5 pb-1">
          {devices.map((d) => {
            const gdiRisk = kind === "system" && d.pdf_datatype === false;
            return (
              <div
                key={d.id}
                className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5"
                data-testid={TEST_IDS[kind](d.id)}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{d.name}</p>
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {kind === "network"
                      ? `${d.address} · ${d.printer_type ?? "ipp"}`
                      : kind === "bluetooth"
                        ? `${d.address} · bluetooth`
                        : d.address}
                  </p>
                  {gdiRisk && (
                    <p className="mt-0.5 flex items-start gap-1 text-xs text-warning">
                      <AlertTriangle
                        className="mt-0.5 h-3.5 w-3.5 shrink-0"
                        aria-hidden="true"
                      />
                      {t("printers.gdi_row_hint")}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onFill(kind, d)}
                  >
                    {t("printers.fill")}
                  </Button>
                  {/* System queues are fill-only: the form shows the GDI
                      warning before anything is saved. */}
                  {onAdd && kind !== "system" && (
                    <Button size="sm" onClick={() => onAdd(kind, d)}>
                      {t("common.add")}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
