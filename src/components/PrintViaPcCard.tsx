import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { notifyError } from "@/lib/notify";
import type { RenderPair } from "@/lib/agent/types";
import { describeError } from "@/lib/errors";
import { isAndroid } from "@/lib/platform";
import {
  getPrintViaPcDevice,
  isPrintViaPc,
  listPhonePairs,
  setPrintViaPc,
  setPrintViaPcDevice,
} from "@/lib/printViaPc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

/**
 * Settings → Share: "Print via PC" (Release B §3.5). Android only — the
 * desktop prints locally, so nothing renders there.
 *
 * On, the print dialog sends the job to the chosen paired PC instead of
 * the local pipeline, with no fallback: an unreachable PC fails the job
 * with a clear message. The flag needs at least one paired PC; with
 * several, the picker names the printer owner.
 */
export function PrintViaPcCard() {
  const { t } = useTranslation();
  const [on, setOn] = useState(false);
  const [pairs, setPairs] = useState<RenderPair[]>([]);
  const [device, setDevice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [flag, list, chosen] = await Promise.all([
        isPrintViaPc(),
        listPhonePairs(),
        getPrintViaPcDevice(),
      ]);
      setOn(flag);
      setPairs(list);
      setDevice(chosen);
    } catch {
      /* backend unavailable */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!isAndroid()) return null;

  const flip = async (next: boolean) => {
    setBusy(true);
    try {
      await setPrintViaPc(next);
      setOn(next);
    } catch (e) {
      notifyError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const pick = async (id: string) => {
    setBusy(true);
    try {
      await setPrintViaPcDevice(id);
      setDevice(id);
    } catch (e) {
      notifyError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const effective =
    pairs.find((p) => p.provider_id === device || p.id === device) ??
    (pairs.length === 1 ? pairs[0] : null);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {t("settings_page.via_pc_title")}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          {t("settings_page.via_pc_hint")}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="via-pc-switch">
            {t("settings_page.via_pc_switch")}
          </Label>
          <Switch
            id="via-pc-switch"
            data-testid="via-pc-switch"
            checked={on}
            disabled={busy || pairs.length === 0}
            onCheckedChange={(v) => void flip(v)}
          />
        </div>
        {pairs.length === 0 ? (
          <p
            data-testid="via-pc-no-pairs"
            className="text-xs text-muted-foreground"
          >
            {t("settings_page.via_pc_no_pairs")}
          </p>
        ) : (
          pairs.length > 1 && (
            <div className="space-y-1.5">
              <Label htmlFor="via-pc-device">
                {t("settings_page.via_pc_device")}
              </Label>
              <Select
                value={effective?.provider_id ?? ""}
                onValueChange={(v) => void pick(v)}
                disabled={busy}
              >
                <SelectTrigger
                  id="via-pc-device"
                  data-testid="via-pc-device"
                  aria-label={t("settings_page.via_pc_device")}
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
            </div>
          )
        )}
        {on && pairs.length > 1 && !effective && (
          <p className="text-xs text-muted-foreground">
            {t("settings_page.via_pc_choose")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
