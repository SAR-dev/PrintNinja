import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { isAndroidBackground } from "@/components/BackgroundAndroid";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { agent } from "@/lib/agent/commands";
import type { ApiStatus } from "@/lib/agent/types";
import {
  startApiServer,
  stopApiServer,
  useApiStatusChanged,
} from "@/lib/apiServer";
import { describeError } from "@/lib/errors";
import { isWebMode, readSetting, writeSetting } from "@/lib/settings";

/**
 * The one place that owns the local API server: status, port, LAN
 * access, autostart, start and stop. The Explorer only reads the status
 * and sends requests; it never starts or stops anything.
 */
export function ApiServerPanel({
  onOpenExplorer,
}: {
  onOpenExplorer: () => void;
}) {
  const { t } = useTranslation();
  const [apiPort, setApiPort] = useState("17717");
  const [lanAccess, setLanAccess] = useState(false);
  const [apiAutostart, setApiAutostart] = useState(false);
  const [apiStatus, setApiStatus] = useState<ApiStatus | null>(null);
  const [starting, setStarting] = useState(false);

  const loadApiStatus = useCallback(async () => {
    if (isWebMode()) {
      const port = await readSetting("api_port");
      setApiStatus({
        running: false,
        address: "127.0.0.1",
        port: Number(port) || 17717,
        lan_access: false,
      });
      return;
    }
    try {
      const s = await agent("get_api_status", {});
      setApiStatus(s);
      // A running server was started with these values (possibly from
      // another screen, e.g. Phones → Share this PC), so the inputs show
      // what is actually live instead of what this page loaded earlier.
      if (s.running) {
        setApiPort(String(s.port));
        setLanAccess(s.lan_access);
      }
    } catch {
      /* backend unavailable */
    }
  }, []);
  useApiStatusChanged(loadApiStatus);

  useEffect(() => {
    void loadApiStatus();
    (async () => {
      const [port, lan, autostart] = await Promise.all([
        readSetting("api_port"),
        readSetting("api_lan_access"),
        readSetting("api_autostart"),
      ]);
      if (port) setApiPort(port);
      if (lan) setLanAccess(lan === "true");
      if (autostart) setApiAutostart(autostart === "true");
    })();
  }, [loadApiStatus]);

  const startApi = async () => {
    setStarting(true);
    try {
      const addr = await startApiServer(Number(apiPort), lanAccess);
      toast.success(t("settings_page.toast_api_up", { addr }));
      await writeSetting("api_port", apiPort);
      await writeSetting("api_lan_access", String(lanAccess));
      await loadApiStatus();
    } catch (e) {
      toast.error(
        t("settings_page.toast_api_start_failed", { error: describeError(e) }),
      );
    } finally {
      setStarting(false);
    }
  };

  const stopApi = async () => {
    try {
      await stopApiServer();
      toast.success(t("settings_page.toast_api_down"));
      await loadApiStatus();
    } catch (e) {
      toast.error(
        t("settings_page.toast_api_stop_failed", { error: describeError(e) }),
      );
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {t("automation.server_title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between p-3 rounded-md border">
          <div>
            <p className="text-sm font-medium">{t("common.status")}</p>
            <p className="text-xs text-muted-foreground">
              {apiStatus?.running
                ? `${apiStatus.address}:${apiStatus.port}`
                : `Default: ${lanAccess ? "0.0.0.0" : "127.0.0.1"}:${apiPort}`}
            </p>
          </div>
          <Badge variant={apiStatus?.running ? "success" : "secondary"}>
            {apiStatus?.running ? "running" : "disabled"}
          </Badge>
        </div>

        {/* Android only: the server outlives the app here, and
                      the foreground notification is what proves it. */}
        {isAndroidBackground() && apiStatus?.running && (
          <div
            data-testid="settings-api-background"
            className="rounded-md border border-success/30 bg-success-soft px-3 py-2 text-xs text-success"
          >
            {t("settings_page.api_background_hint")}
          </div>
        )}

        <div className="space-y-1">
          <Label htmlFor="api-port">{t("settings_page.api_port")}</Label>
          <Input
            id="api-port"
            data-testid="settings-api-port"
            type="number"
            min="1"
            max="65535"
            value={apiPort}
            onChange={(e) => setApiPort(e.target.value)}
            disabled={apiStatus?.running}
          />
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Switch
              id="lan-access"
              checked={lanAccess}
              disabled={apiStatus?.running}
              onCheckedChange={(v) => {
                setLanAccess(v);
                writeSetting("api_lan_access", String(v));
              }}
            />
            <Label htmlFor="lan-access">{t("settings_page.api_lan")}</Label>
          </div>
          {apiStatus?.running ? (
            <Button variant="destructive" onClick={stopApi}>
              {t("settings_page.api_stop")}
            </Button>
          ) : (
            <Button onClick={startApi} disabled={starting}>
              {starting
                ? t("settings_page.api_starting")
                : t("settings_page.api_start")}
            </Button>
          )}
        </div>

        {lanAccess && (
          <p className="text-xs text-warning">
            {t("settings_page.api_lan_warning")}
          </p>
        )}

        <div className="flex items-center gap-2">
          <Switch
            id="api-autostart"
            checked={apiAutostart}
            onCheckedChange={(v) => {
              setApiAutostart(v);
              writeSetting("api_autostart", String(v));
            }}
          />
          <Label htmlFor="api-autostart">
            {t("settings_page.api_autostart")}
          </Label>
        </div>
        <p className="-mt-3 text-xs text-muted-foreground">
          {t("settings_page.api_autostart_hint")}
        </p>

        <div className="rounded-md bg-muted p-3">
          <p className="text-xs font-medium mb-1">
            {t("settings_page.api_curl_title")}
          </p>
          <pre className="text-[11px] overflow-x-auto whitespace-pre-wrap break-all">{`curl -X POST http://127.0.0.1:${apiPort}/v1/print \\
  -H "Content-Type: application/json" \\
  -d '{"template":"Receipt","printer":"Front Desk","data":{"order":1042}}'`}</pre>
        </div>

        <Button variant="outline" onClick={onOpenExplorer}>
          {t("automation.open_explorer")}
        </Button>
      </CardContent>
    </Card>
  );
}
