import { useTranslation } from "react-i18next";
import { Printer, XCircle } from "lucide-react";
import { ExitViaPcButton } from "@/components/ExitViaPcButton";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { RenderPair, PcPrinterInfo } from "@/lib/agent/types";

/**
 * The via-PC banner: with a pair chosen, the job runs on the paired PC's
 * printers, never on this phone's transports; without one, the block and
 * the picker that resolves it.
 */
export function ViaPcBanner({
  viaPcPair,
  pcCached,
  pcFailed,
  pcPrinters,
  pairs,
  pickViaPcDevice,
  setViaPc,
}: {
  viaPcPair: RenderPair | null;
  pcCached: boolean;
  pcFailed: boolean;
  pcPrinters: PcPrinterInfo[];
  pairs: RenderPair[];
  pickViaPcDevice: (id: string) => Promise<void>;
  setViaPc: (viaPc: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {/* Print via PC: the job runs on the paired PC's printers, never on
          this phone's transports. */}
      {viaPcPair ? (
        <div
          data-testid="print-via-pc-banner"
          className="flex items-center gap-3 rounded-lg border border-info/30 bg-info-soft px-4 py-3 text-info"
        >
          <Printer className="h-5 w-5 shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">
              {t("print.via_pc_banner", {
                pc: viaPcPair.name || viaPcPair.host,
              })}
            </p>
            {pcCached && <p className="text-xs">{t("print.via_pc_cached")}</p>}
            {pcFailed && pcPrinters.length === 0 && (
              <p className="text-xs">{t("print.via_pc_unreachable")}</p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <ExitViaPcButton onExited={() => setViaPc(false)} />
          </div>
        </div>
      ) : (
        <div
          data-testid="print-via-pc-banner"
          role="alert"
          className="flex items-center gap-3 rounded-lg border border-danger/30 bg-danger-soft px-4 py-3 text-danger"
        >
          <XCircle className="h-5 w-5 shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1 space-y-2">
            <p className="text-sm font-medium">{t("print.via_pc_no_pair")}</p>
            <p className="text-xs">{t("print.via_pc_choose_hint")}</p>
            <div className="flex items-center gap-2">
              <Label htmlFor="print-via-pc-picker" className="shrink-0 text-xs">
                {t("settings_page.via_pc_device")}
              </Label>
              <Select value="" onValueChange={(v) => void pickViaPcDevice(v)}>
                <SelectTrigger
                  id="print-via-pc-picker"
                  data-testid="print-via-pc-picker"
                  aria-label={t("settings_page.via_pc_device")}
                  className="min-w-0 flex-1"
                >
                  <SelectValue
                    placeholder={t("settings_page.via_pc_device_placeholder")}
                  />
                </SelectTrigger>
                <SelectContent>
                  {pairs.map((p) => (
                    <SelectItem
                      key={p.provider_id || p.id}
                      value={p.provider_id || p.id}
                    >
                      {p.name || p.host}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <ExitViaPcButton onExited={() => setViaPc(false)} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
