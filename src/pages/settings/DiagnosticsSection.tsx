import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Link } from "react-router-dom";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { agent } from "@/lib/agent/commands";
import type { RenderEngineStatus } from "@/lib/agent/types";
import { describeError } from "@/lib/errors";
import { notifyError, notifySuccess } from "@/lib/notify";
import { diagnostics } from "@/lib/diagnostics";
import { readCachedSetting, readSetting, writeSetting } from "@/lib/settings";
import { DEV_TOOLS_SETTING, useDeveloperTools } from "@/lib/devtools";
import { PrintRepairCard } from "./PrintRepairCard";

const BROWSER_CHOICES = ["auto", "system", "shell", "custom"];

// Unknown/legacy values fall back to the safe default in Rust; mirror
// that here so the select always shows a valid option.
function validChoice(v: string | null): string {
  return v && BROWSER_CHOICES.includes(v) ? v : "auto";
}

/**
 * Settings → Diagnostics: the active render engine, the browser
 * choice behind it, diagnostics export and the backend log. The
 * engine status is fetched once at page level and passed in.
 */
export function DiagnosticsSection({
  engine,
  recheckEngine,
}: {
  engine: RenderEngineStatus | null;
  recheckEngine: () => Promise<RenderEngineStatus | null>;
}) {
  const { t } = useTranslation();
  // Developer tools toggle: the route at /raw-console renders only while
  // this is on, and both read the same setting through the same hook.
  const devToolsOn = useDeveloperTools();

  // The engine line and the browser choice only make sense where the app
  // renders locally (Windows or Linux); "other" platforms delegate.
  const isLocalRender =
    engine?.platform === "windows" || engine?.platform === "linux";
  // Human label for the active engine (item 6), from its source.
  const engineLabel = (() => {
    const src = engine?.source;
    if (!src) return null;
    switch (src) {
      case "env":
        return t("settings_page.diag_engine_env");
      case "shell":
        return t("settings_page.diag_engine_shell");
      case "custom":
        return t("settings_page.diag_engine_custom");
      case "system":
        return engine.platform === "linux"
          ? t("settings_page.diag_engine_system_linux")
          : t("settings_page.diag_engine_system_windows");
      default:
        return null;
    }
  })();

  // Browser choice (items 1 + 2): which browser the renderer uses. Two
  // device-local settings; the Rust layer re-reads them on every set, so
  // the change takes effect without a restart (env vars still override).
  const [browserChoice, setBrowserChoice] = useState(() =>
    validChoice(readCachedSetting("browser-choice")),
  );
  const [customPath, setCustomPath] = useState(
    () => readCachedSetting("browser-custom-path") ?? "",
  );
  const [browserBusy, setBrowserBusy] = useState(false);
  // The last-persisted pair, so the Save button knows when there is
  // something to save. The path only means anything for the custom choice.
  const savedChoiceRef = useRef(browserChoice);
  const savedPathRef = useRef(browserChoice === "custom" ? customPath : "");

  // The cache paints the first frame; the DB read corrects it if the
  // two ever diverge.
  useEffect(() => {
    (async () => {
      const [bChoice, bPath] = await Promise.all([
        readSetting("browser-choice"),
        readSetting("browser-custom-path"),
      ]);
      if (bChoice) setBrowserChoice(validChoice(bChoice));
      savedChoiceRef.current = validChoice(bChoice);
      if (bPath) setCustomPath(bPath);
      savedPathRef.current =
        savedChoiceRef.current === "custom" ? (bPath ?? "") : "";
    })();
  }, []);

  const browserDirty =
    browserChoice !== savedChoiceRef.current ||
    (browserChoice === "custom" ? customPath : "") !== savedPathRef.current;
  const saveBrowserChoice = useCallback(async () => {
    const choice = browserChoice;
    const path = choice === "custom" ? customPath : "";
    setBrowserBusy(true);
    try {
      // Choice first, then the path: the final apply_from sees both.
      await writeSetting("browser-choice", choice);
      await writeSetting("browser-custom-path", path);
      savedChoiceRef.current = choice;
      savedPathRef.current = path;
      // The radio selection is the visible result; no toast.
      await recheckEngine();
    } catch (e) {
      notifyError(describeError(e));
    } finally {
      setBrowserBusy(false);
    }
  }, [browserChoice, customPath, recheckEngine]);

  const downloadAppLog = async () => {
    try {
      const text = await agent("read_app_logs", { max_kb: 256 });
      const blob = new Blob([text], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `printninja-app-${new Date().toISOString().slice(0, 10)}.log`;
      a.click();
      URL.revokeObjectURL(url);
      notifySuccess(t("settings_page.toast_diag_app_log_exported"));
    } catch {
      notifyError(t("settings_page.toast_diag_app_log_failed"));
    }
  };

  const [appLogOpen, setAppLogOpen] = useState(false);
  const [appLogText, setAppLogText] = useState<string | null>(null);

  const openAppLogViewer = async () => {
    try {
      // Small budget: the dialog renders raw text, so keep the DOM light;
      // the download above carries the full export.
      const text = await agent("read_app_logs", { max_kb: 64 });
      setAppLogText(text);
      setAppLogOpen(true);
    } catch {
      notifyError(t("settings_page.toast_diag_app_log_failed"));
    }
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("settings_page.diag_title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {t("settings_page.diag_hint")}
          </p>
          {isLocalRender && (
            <div
              id="settings-diag-engine"
              className="rounded-md border p-3 text-sm"
            >
              <p className="font-medium">
                {engineLabel && engine?.available
                  ? t("settings_page.diag_rendering_with", {
                      engine: engineLabel,
                    })
                  : t("settings_page.diag_rendering_missing")}
              </p>
              {engine?.path && (
                <p
                  id="settings-diag-engine-path"
                  className="mt-1 break-all font-mono text-xs text-muted-foreground"
                >
                  {engine.path}
                </p>
              )}
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <Label htmlFor="settings-diag-browser-choice">
                  {t("settings_page.diag_browser_title")}
                </Label>
                <Select
                  value={browserChoice}
                  onValueChange={setBrowserChoice}
                  disabled={browserBusy}
                >
                  <SelectTrigger
                    id="settings-diag-browser-choice"
                    className="w-56"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">
                      {t("settings_page.diag_browser_auto")}
                    </SelectItem>
                    <SelectItem value="system">
                      {t("settings_page.diag_browser_system")}
                    </SelectItem>
                    <SelectItem value="shell">
                      {t("settings_page.diag_browser_shell")}
                    </SelectItem>
                    <SelectItem value="custom">
                      {t("settings_page.diag_browser_custom")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {t("settings_page.diag_browser_hint")}
              </p>
              {browserChoice === "custom" && (
                <div className="mt-2 space-y-1">
                  <Label htmlFor="settings-diag-browser-custom-path">
                    {t("settings_page.diag_browser_custom_path")}
                  </Label>
                  <Input
                    id="settings-diag-browser-custom-path"
                    value={customPath}
                    onChange={(e) => setCustomPath(e.target.value)}
                    disabled={browserBusy}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("settings_page.diag_browser_custom_path_hint")}
                  </p>
                </div>
              )}
              {browserDirty && (
                <div className="mt-3">
                  <Button
                    size="sm"
                    id="settings-diag-browser-save"
                    disabled={browserBusy}
                    onClick={() => void saveBrowserChoice()}
                  >
                    {t("common.save")}
                  </Button>
                </div>
              )}
            </div>
          )}
          <Button
            variant="outline"
            id="settings-diag-export"
            onClick={() => {
              diagnostics.download();
              notifySuccess(t("settings_page.toast_diag_exported"));
            }}
          >
            <Download className="h-4 w-4 mr-2" />
            {t("settings_page.diag_export")}
          </Button>
          <p className="text-sm text-muted-foreground">
            {t("settings_page.diag_app_log_hint")}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              id="settings-diag-app-log-view"
              onClick={() => void openAppLogViewer()}
            >
              {t("settings_page.diag_app_log_view")}
            </Button>
            <Button
              variant="outline"
              id="settings-diag-app-log"
              onClick={() => void downloadAppLog()}
            >
              <Download className="h-4 w-4 mr-2" />
              {t("settings_page.diag_app_log_export")}
            </Button>
          </div>
          <PrintRepairCard engine={engine} />
          <p className="text-xs text-muted-foreground">
            {t("settings_page.diag_note")}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("raw_console.settings_title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {t("raw_console.settings_hint")}
          </p>
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="settings-diag-devtools">
              {t("raw_console.settings_title")}
            </Label>
            <Switch
              id="settings-diag-devtools"
              checked={devToolsOn}
              onCheckedChange={(v) =>
                void writeSetting(DEV_TOOLS_SETTING, v ? "true" : "false")
              }
            />
          </div>
          {devToolsOn && (
            <Button asChild variant="outline" size="sm">
              <Link to="/raw-console">{t("raw_console.settings_open")}</Link>
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Backend log viewer: same source as the download, smaller budget
          so the dialog stays light on phones. Works on every platform
          with a backend; in the web preview the invoke fails into a toast. */}
      <Dialog open={appLogOpen} onOpenChange={setAppLogOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t("settings_page.diag_app_log_view")}</DialogTitle>
            <DialogDescription>
              {t("settings_page.diag_app_log_hint")}
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-sheet overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap break-all">
            {appLogText || t("settings_page.diag_app_log_empty")}
          </pre>
        </DialogContent>
      </Dialog>
    </>
  );
}
