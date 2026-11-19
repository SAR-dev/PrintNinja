import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { readCachedSetting, readSetting, writeSetting } from "@/lib/settings";

/**
 * Settings → Data & network: which remote hosts may feed data URLs,
 * and whether private (LAN) addresses are blocked.
 */
export function DataSection() {
  const { t } = useTranslation();

  const [allowedDomains, setAllowedDomains] = useState(
    () => readCachedSetting("allowed_domains") ?? "",
  );
  const [blockPrivate, setBlockPrivate] = useState(() => {
    const v = readCachedSetting("block_private_ips");
    return v === null ? true : v === "true" || v === "1";
  });
  const [domainsError, setDomainsError] = useState("");
  const [allowAllOpen, setAllowAllOpen] = useState(false);
  // Last persisted value: clearing a non-empty allowlist is allow-all,
  // which needs an explicit confirm.
  const lastSavedDomains = useRef<string | null>(
    readCachedSetting("allowed_domains") ?? "",
  );

  useEffect(() => {
    (async () => {
      const [domains, block] = await Promise.all([
        readSetting("allowed_domains"),
        readSetting("block_private_ips"),
      ]);
      if (domains) setAllowedDomains(domains);
      lastSavedDomains.current = domains ?? "";
      if (block !== null) setBlockPrivate(block === "true" || block === "1");
    })();
  }, []);

  // Hostnames only: no scheme, path, port-range or spaces. An empty
  // field means allow-all, so clearing a non-empty list asks first.
  const saveAllowedDomains = async (raw: string) => {
    const entries = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const bad = entries.find(
      (e) =>
        !/^(?=.{1,253}$)[a-z0-9]([a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/i.test(
          e,
        ) || e.includes(".."),
    );
    if (bad) {
      setDomainsError(
        `“${bad}” is not a domain — use hostnames like api.example.com, comma-separated`,
      );
      return;
    }
    setDomainsError("");
    const normalized = entries.join(", ");
    if (normalized === "") {
      if (lastSavedDomains.current) {
        setAllowAllOpen(true);
        return;
      }
      return;
    }
    await writeSetting("allowed_domains", normalized);
    if (normalized !== raw) setAllowedDomains(normalized);
    lastSavedDomains.current = normalized;
    // The list re-renders with the saved value — visible, so no toast.
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("settings_page.data_title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="allowed-domains">
              {t("settings_page.allowed_domains")}
            </Label>
            <Input
              id="allowed-domains"
              placeholder={t("settings_page.domains_example")}
              value={allowedDomains}
              aria-invalid={!!domainsError}
              aria-describedby={
                domainsError ? "allowed-domains-error" : undefined
              }
              onChange={(e) => {
                setAllowedDomains(e.target.value);
                setDomainsError("");
              }}
              onBlur={() => void saveAllowedDomains(allowedDomains)}
            />
            {domainsError && (
              <p
                id="allowed-domains-error"
                role="alert"
                className="text-xs text-danger"
              >
                {domainsError}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {t("settings_page.domains_hint")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id="block-private"
              data-testid="settings-block-private"
              checked={blockPrivate}
              onCheckedChange={(v) => {
                setBlockPrivate(v);
                writeSetting("block_private_ips", String(v));
              }}
            />
            <Label htmlFor="block-private">
              {t("settings_page.block_private")}
            </Label>
          </div>
        </CardContent>
      </Card>

      {/* Clearing the allowlist means any domain can feed data URLs. */}
      <Dialog open={allowAllOpen} onOpenChange={setAllowAllOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("settings_page.allow_title")}</DialogTitle>
            <DialogDescription>
              {t("settings_page.allow_hint")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAllowAllOpen(false)}>
              {t("settings_page.allow_keep")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                void (async () => {
                  await writeSetting("allowed_domains", "");
                  lastSavedDomains.current = "";
                  setAllowAllOpen(false);
                  // The dialog closes and the list shows "allow all" —
                  // the change is on screen, so no toast.
                })();
              }}
            >
              {t("settings_page.allow_all")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
