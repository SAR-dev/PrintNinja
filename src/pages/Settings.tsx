import { describeError } from "@/lib/errors";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { AppearanceSettings } from "@/components/AppearanceSettings";
import { SyncStatusCard } from "@/components/SyncStatusCard";
import { PageHeader } from "@/components/PageHeader";
import { SetupChecklist } from "@/components/SetupChecklist";
import {
  AndroidBackgroundControls,
  isAndroidBackground,
} from "@/components/BackgroundAndroid";
import { parseSection, type SettingsSection } from "@/lib/setup/checklist";
import { agent } from "@/lib/agent/commands";
import { useFlashField } from "@/lib/hooks/useFlashField";
import { readSetting, writeSetting } from "@/lib/settings";
import type { BrowserShellStatus, FixReport, FontRow } from "@/lib/agent/types";
import { useRenderEngine } from "@/lib/render/useRenderEngine";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Type,
  UserRound,
  Archive,
  Activity,
  AppWindow,
  Globe,
  Shield,
  Download,
  Trash2,
  Upload,
  ListChecks,
  ArrowLeft,
  ChevronRight,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { PHONE_QUERY, useMediaQuery } from "@/lib/hooks/useMediaQuery";
import { ProfileCard } from "@/components/ProfileCard";
import { notifySuccess, notifyError } from "@/lib/notify";
import { diagnostics } from "@/lib/diagnostics";
import * as share from "@/lib/share/client";
import { defaultServiceUrl, normalizeServiceUrl } from "@/lib/share/session";

/** Phone list → detail navigation: icon, label and a
    one-line summary per section. Labels match the desktop tab strip. */
const SECTION_META: Array<{
  key: SettingsSection;
  icon: LucideIcon;
  labelKey: string;
  summaryKey: string;
}> = [
  {
    key: "general",
    icon: Type,
    labelKey: "section_general",
    summaryKey: "hint_general",
  },
  {
    key: "setup",
    icon: ListChecks,
    labelKey: "section_setup",
    summaryKey: "hint_setup",
  },
  {
    key: "profile",
    icon: UserRound,
    labelKey: "section_profile",
    summaryKey: "hint_profile",
  },
  {
    key: "background",
    icon: AppWindow,
    labelKey: "section_background",
    summaryKey: "hint_background",
  },
  {
    key: "share",
    icon: Globe,
    labelKey: "section_share",
    summaryKey: "hint_share",
  },
  {
    key: "data",
    icon: Shield,
    labelKey: "section_data",
    summaryKey: "hint_data",
  },
  {
    key: "retention",
    icon: Archive,
    labelKey: "section_retention",
    summaryKey: "hint_retention",
  },
  {
    key: "diagnostics",
    icon: Activity,
    labelKey: "section_diagnostics",
    summaryKey: "hint_diagnostics",
  },
];

export function SettingsPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const section = parseSection(searchParams.get("section"));
  const isPhone = useMediaQuery(PHONE_QUERY);
  // Phone list → detail: the list shows when no section is selected.
  const hasSection = searchParams.has("section");
  const openSection = (next: SettingsSection) => {
    const params = new URLSearchParams(searchParams);
    // "general" is the default, so desktop drops the param; phones always
    // set it, or tapping General would land back on the section list.
    if (next === "general" && !isPhone) params.delete("section");
    else params.set("section", next);
    setSearchParams(params, { replace: true });
  };
  const closeSection = () => {
    const params = new URLSearchParams(searchParams);
    params.delete("section");
    setSearchParams(params, { replace: true });
  };
  // Initial load gate: every section below reads persisted settings on
  // mount, and without it each card pops from defaults to values (the
  // flicker). The detail column shows a skeleton until this flips.
  // Declared up here: the palette effect below already depends on it.
  const [ready, setReady] = useState(false);

  // Palette deep-link (`?section=&field=`). `ready`: the target may not
  // exist until the loading gate lifts.
  useFlashField(searchParams.get("field"), hasSection, [section, ready]);

  const [retentionError, setRetentionError] = useState("");
  const [maxError, setMaxError] = useState("");
  const [retentionDays, setRetentionDays] = useState("30");
  const [maxRecords, setMaxRecords] = useState("10000");

  const [allowedDomains, setAllowedDomains] = useState("");
  const [blockPrivate, setBlockPrivate] = useState(true);
  const [domainsError, setDomainsError] = useState("");
  const [allowAllOpen, setAllowAllOpen] = useState(false);
  // Last persisted value: clearing a non-empty allowlist is allow-all,
  // which needs an explicit confirm.
  const lastSavedDomains = useRef<string | null>(null);

  const [launchAtStartup, setLaunchAtStartup] = useState(false);
  const [startMinimized, setStartMinimized] = useState(false);
  const [minimizeToTray, setMinimizeToTray] = useState(false);
  const [closeToTray, setCloseToTray] = useState(true);
  const [bgServiceRunning, setBgServiceRunning] = useState<boolean | null>(
    null,
  );
  const [batteryExempt, setBatteryExempt] = useState<boolean | null>(null);
  const [bgBusy, setBgBusy] = useState(false);

  const [fonts, setFonts] = useState<FontRow[]>([]);
  const [fontUploadError, setFontUploadError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [showResetDialog, setShowResetDialog] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);

  // One-click repair of the Windows print pipeline (Settings → Diagnostics).
  // `engineStatus` doubles as the platform check: the repair only exists
  // where the Edge handoff failure can (Windows).
  const { status: engineStatus, recheck: recheckEngine } = useRenderEngine();
  const isWindows = engineStatus?.platform === "windows";
  // The engine line and the browser choice only make sense where the app
  // renders locally (Windows or Linux); "other" platforms delegate.
  const isLocalRender =
    engineStatus?.platform === "windows" || engineStatus?.platform === "linux";
  // Human label for the active engine (item 6), from its source.
  const engineLabel = (() => {
    const src = engineStatus?.source;
    if (!src) return null;
    switch (src) {
      case "env":
        return t("settings_page.diag_engine_env");
      case "shell":
        return t("settings_page.diag_engine_shell");
      case "custom":
        return t("settings_page.diag_engine_custom");
      case "system":
        return engineStatus.platform === "linux"
          ? t("settings_page.diag_engine_system_linux")
          : t("settings_page.diag_engine_system_windows");
      default:
        return null;
    }
  })();
  const [fixOpen, setFixOpen] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [fixReport, setFixReport] = useState<FixReport | null>(null);
  const runFix = useCallback(async () => {
    setFixing(true);
    setFixReport(null);
    try {
      const report = await agent("fix_pc_print", { close_edge: true });
      setFixReport(report);
      if (report?.test_render_ok) {
        notifySuccess(t("settings_page.toast_fix_ok"));
      } else {
        notifyError(t("settings_page.toast_fix_failed"));
      }
    } catch (e) {
      notifyError(describeError(e));
    } finally {
      setFixing(false);
    }
  }, [t]);

  // Opt-in headless browser (the repair's fallback): its status, download
  // progress and removal. Nothing is downloaded without an explicit press.
  const [shellStatus, setShellStatus] = useState<BrowserShellStatus | null>(
    null,
  );
  const [shellBusy, setShellBusy] = useState(false);
  const [shellProgress, setShellProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const refreshShellStatus = useCallback(async () => {
    try {
      const status = await agent("browser_shell_status", {});
      setShellStatus(status ?? null);
    } catch {
      setShellStatus(null);
    }
  }, []);
  useEffect(() => {
    if (fixReport && isWindows) void refreshShellStatus();
  }, [fixReport, isWindows, refreshShellStatus]);
  const downloadShell = useCallback(async () => {
    setShellBusy(true);
    setShellProgress(null);
    let unlisten: (() => void) | null = null;
    try {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlisten = await listen<{ done: number; total: number }>(
          "browser-shell-progress",
          (e) => setShellProgress(e.payload),
        );
      } catch {
        /* no Tauri event bridge (web preview / tests): no live progress */
      }
      await agent("browser_shell_download", {});
      notifySuccess(t("settings_page.diag_fix_shell_ready"));
    } catch (e) {
      notifyError(describeError(e));
    } finally {
      unlisten?.();
      setShellBusy(false);
      setShellProgress(null);
      await refreshShellStatus();
    }
  }, [refreshShellStatus, t]);
  const removeShell = useCallback(async () => {
    setShellBusy(true);
    try {
      await agent("browser_shell_remove", {});
      await refreshShellStatus();
    } catch (e) {
      notifyError(describeError(e));
    } finally {
      setShellBusy(false);
    }
  }, [refreshShellStatus]);
  const cancelShell = useCallback(async () => {
    try {
      await agent("browser_shell_cancel", {});
    } catch (e) {
      notifyError(describeError(e));
    }
    // The in-flight download notices the flag on its next chunk and bails;
    // `downloadShell`'s finally then refreshes the status.
    void refreshShellStatus();
  }, [refreshShellStatus]);

  // Browser choice (items 1 + 2): which browser the renderer uses. Two
  // device-local settings; the Rust layer re-reads them on every set, so
  // the change takes effect without a restart (env vars still override).
  const [browserChoice, setBrowserChoice] = useState("auto");
  const [customPath, setCustomPath] = useState("");
  const [browserBusy, setBrowserBusy] = useState(false);
  // The last-persisted pair, so the Save button knows when there is
  // something to save. The path only means anything for the custom choice.
  const savedChoiceRef = useRef("auto");
  const savedPathRef = useRef("");
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
      notifySuccess(t("settings_page.toast_browser_saved"));
      await recheckEngine();
    } catch (e) {
      notifyError(describeError(e));
    } finally {
      setBrowserBusy(false);
    }
  }, [browserChoice, customPath, recheckEngine, t]);

  const [shareUrl, setShareUrl] = useState("");
  const [shareHandle, setShareHandle] = useState("");
  const [sharePassword, setSharePassword] = useState("");
  const [shareUser, setShareUser] = useState<{ handle: string } | null>(null);
  const [shareBusy, setShareBusy] = useState(false);

  const loadFonts = useCallback(async () => {
    try {
      setFonts((await agent("list_fonts", {})) ?? []);
    } catch {
      /* backend unavailable */
    }
  }, []);

  // Load persisted settings on mount.
  useEffect(() => {
    (async () => {
      const [
        days,
        max,
        domains,
        block,
        startup,
        minimized,
        minTray,
        closeTray,
        bChoice,
        bPath,
      ] = await Promise.all([
        readSetting("retention_days"),
        readSetting("max_records"),
        readSetting("allowed_domains"),
        readSetting("block_private_ips"),
        readSetting("launch_at_startup"),
        readSetting("start_minimized"),
        readSetting("minimize_to_tray"),
        readSetting("close_to_tray"),
        readSetting("browser-choice"),
        readSetting("browser-custom-path"),
      ]);
      if (days) setRetentionDays(days);
      if (max) setMaxRecords(max);
      if (domains) setAllowedDomains(domains);
      lastSavedDomains.current = domains ?? "";
      if (block !== null) setBlockPrivate(block === "true");
      if (startup !== null)
        setLaunchAtStartup(startup === "true" || startup === "1");
      if (minimized !== null)
        setStartMinimized(minimized === "true" || minimized === "1");
      if (minTray !== null)
        setMinimizeToTray(minTray === "true" || minTray === "1");
      if (closeTray !== null)
        setCloseToTray(closeTray === "true" || closeTray === "1");
      // Unknown/legacy choice values fall back to the safe default in
      // Rust; mirror that here so the select always shows a valid option.
      if (bChoice && ["auto", "system", "shell", "custom"].includes(bChoice))
        setBrowserChoice(bChoice);
      savedChoiceRef.current =
        bChoice && ["auto", "system", "shell", "custom"].includes(bChoice)
          ? bChoice
          : "auto";
      if (bPath) setCustomPath(bPath);
      savedPathRef.current = bChoice === "custom" ? (bPath ?? "") : "";

      // Share service
      try {
        // A saved address wins; the build-time default only pre-fills
        // the field on a first run before anything was saved.
        const url = (await share.getServiceUrl()) ?? defaultServiceUrl();
        if (url) setShareUrl(url);
        const token = await share.getSessionToken();
        if (token && url) {
          try {
            const me = await share.fetchMe();
            setShareUser({ handle: me.handle });
          } catch {}
        }
      } catch {}
      setReady(true);
    })();
    loadFonts();
  }, [loadFonts]);

  // Same behaviour for every numeric setting: validate, save, and say so.
  const saveNumber = async (
    key: string,
    value: string,
    min: number,
    label: string,
    setErr: (m: string) => void,
  ) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min) {
      setErr(t("settings_page.number_error", { label, min }));
      return;
    }
    setErr("");
    await writeSetting(key, String(n));
    notifySuccess(t("settings_page.toast_saved"));
  };

  // One behavior for every background toggle: persist the key, ask the
  // backend to re-apply autostart/tray without a restart, and say so.
  const setBackgroundPref = async (
    key: string,
    value: boolean,
    set: (v: boolean) => void,
  ) => {
    set(value);
    await writeSetting(key, value ? "1" : "0");
    try {
      await agent("refresh_background", {});
    } catch {
      // Web preview or an old backend: the stored value still applies
      // at the next launch.
    }
    notifySuccess(t("settings_page.toast_bg_saved"));
  };

  // A completed pull may bring another PC's fonts (or confirm a
  // delete); reload so the list shows it with no manual step (F10).
  useEffect(() => {
    const onPulled = () => {
      void loadFonts();
    };
    window.addEventListener("sync:pulled", onPulled);
    return () => window.removeEventListener("sync:pulled", onPulled);
  }, [loadFonts]);

  const uploadFont = async (file: File) => {
    setFontUploadError("");
    try {
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      await agent("upload_font", {
        file_name: file.name,
        file_data: bytes,
        family: null,
      });
      notifySuccess(
        t("settings_page.toast_font_uploaded", { name: file.name }),
      );
      await loadFonts();
      // Stored locally for now; sending fonts to the server gets its own
      // explicit action in phase 2.
    } catch (e) {
      // The wrong content (a non-font with a font extension) must read
      // inline, not just in a toast (F10).
      setFontUploadError(
        t("designer.custom_font_failed", { error: describeError(e) }),
      );
    }
  };

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
    notifySuccess(t("settings_page.toast_domains_updated"));
  };

  const saveShareUrl = async () => {
    const typed = shareUrl.trim();
    const next = typed ? normalizeServiceUrl(typed) : null;
    if (typed && !next) {
      notifyError(t("settings_page.toast_bad_url"));
      return;
    }
    const current = await share.getServiceUrl();
    if (next === current) {
      notifySuccess(t("settings_page.toast_url_unchanged"));
      return;
    }
    const hadSession = !!(await share.getSessionToken());
    await share.setServiceUrl(next);
    setShareUrl(next ?? "");
    if (hadSession) {
      // The session token belongs to the old server. Drop it and return to the
      // sign-in screen, which is prefilled with the new address.
      setShareUser(null);
      await share.endSession("signed_out");
    }
    notifySuccess(t("settings_page.toast_url_saved"));
  };

  const doRegister = async () => {
    if (!shareUrl.trim() || !shareHandle.trim() || !sharePassword) {
      notifyError(t("settings_page.toast_signin_required"));
      return;
    }
    setShareBusy(true);
    try {
      const res = await share.register(shareHandle.trim(), sharePassword);
      setShareUser({ handle: res.user.handle });
      setSharePassword("");
      notifySuccess(
        t("settings_page.toast_registered", { handle: res.user.handle }),
      );
    } catch (e) {
      notifyError(describeError(e));
    } finally {
      setShareBusy(false);
    }
  };

  const doLogin = async () => {
    if (!shareUrl.trim() || !shareHandle.trim() || !sharePassword) {
      notifyError(t("settings_page.toast_signin_required"));
      return;
    }
    setShareBusy(true);
    try {
      const res = await share.login(shareHandle.trim(), sharePassword);
      setShareUser({ handle: res.user.handle });
      setSharePassword("");
      notifySuccess(
        t("settings_page.toast_signed_in", { handle: res.user.handle }),
      );
    } catch (e) {
      notifyError(describeError(e));
    } finally {
      setShareBusy(false);
    }
  };

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
    <div className="space-y-4">
      <PageHeader
        title={t("settings_page.title")}
        description={t("pages.settings")}
      />

      {isPhone && !hasSection ? (
        /* Phone section list: tapping one opens it with a back arrow. */
        <ul className="space-y-2">
          {SECTION_META.map((s) => (
            <li key={s.key}>
              <button
                type="button"
                onClick={() => openSection(s.key)}
                className="flex min-h-16 w-full items-center gap-3.5 rounded-lg border bg-card p-3 text-left"
              >
                <span
                  aria-hidden="true"
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-foreground"
                >
                  <s.icon className="h-5 w-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[0.9375rem] font-semibold">
                    {t(`settings_page.${s.labelKey}`)}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {t(`settings_page.${s.summaryKey}`)}
                  </span>
                </span>
                <ChevronRight
                  className="h-4 w-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <Tabs
          value={section}
          onValueChange={(v) => openSection(v as SettingsSection)}
          orientation="vertical"
          className="flex flex-col gap-4 md:flex-row md:items-start md:gap-8"
        >
          {isPhone ? (
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={closeSection}
                aria-label={t("common.back")}
              >
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                {t("common.back")}
              </Button>
              <span className="truncate text-sm font-medium">
                {t(`settings_page.section_${section}`, section)}
              </span>
            </div>
          ) : (
            // Desktop/tablet only (phones take the back-button branch
            // above): a vertical section rail.
            <TabsList
              aria-label={t("settings_page.sections_aria")}
              className="h-auto w-full shrink-0 gap-1 bg-transparent p-0 md:w-56 md:flex-col"
            >
              {SECTION_META.map((s) => (
                <TabsTrigger
                  key={s.key}
                  value={s.key}
                  className="w-full justify-start gap-2 data-[state=active]:bg-accent data-[state=active]:text-accent-foreground data-[state=active]:shadow-none"
                >
                  <s.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  {t(`settings_page.${s.labelKey}`)}
                </TabsTrigger>
              ))}
            </TabsList>
          )}

          <div className="min-w-0 max-w-3xl flex-1">
            {!ready ? (
              <div
                data-testid="settings-loading"
                aria-label={t("common.loading")}
                className="space-y-3"
              >
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className="h-24 animate-pulse rounded-lg border bg-muted"
                  />
                ))}
              </div>
            ) : (
              <>
                <TabsContent value="setup" className="mt-0 space-y-4">
                  <SetupChecklist onOpenSection={openSection} />
                </TabsContent>

                <TabsContent value="profile" className="mt-0 space-y-4">
                  <ProfileCard />
                </TabsContent>

                <TabsContent value="general" className="mt-0 space-y-4">
                  <AppearanceSettings />
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">
                        {t("settings_page.fonts_installed")}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {fonts.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          {t("settings_page.fonts_empty")}
                        </p>
                      ) : (
                        fonts.map((f) => (
                          <div
                            key={f.id}
                            data-testid={`font-row-${f.id}`}
                            className="flex items-center justify-between p-3 rounded-md border"
                          >
                            <div>
                              <p className="text-sm font-medium">{f.family}</p>
                              <p className="text-xs text-muted-foreground uppercase">
                                {f.format}
                              </p>
                              <p
                                data-testid={`font-state-${f.id}`}
                                className="text-xs text-muted-foreground"
                              >
                                {f.state === "ready"
                                  ? t("settings_page.font_ready")
                                  : f.state === "error"
                                    ? "Download failed — will retry"
                                    : "Downloading…"}
                              </p>
                            </div>
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={t("settings_page.font_remove", {
                                name: f.family,
                              })}
                              data-testid={`font-delete-${f.id}`}
                              onClick={async () => {
                                try {
                                  await agent("delete_font", { id: f.id });
                                  await loadFonts();
                                  notifySuccess(
                                    t("settings_page.toast_font_removed", {
                                      name: f.family,
                                    }),
                                  );
                                } catch (e) {
                                  notifyError(
                                    t("settings_page.toast_failed", {
                                      error: describeError(e),
                                    }),
                                  );
                                }
                              }}
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </div>
                        ))
                      )}

                      <input
                        ref={fileRef}
                        type="file"
                        aria-label={t("settings_page.font_upload_label")}
                        tabIndex={-1}
                        accept=".ttf,.otf,.woff,.woff2"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) uploadFont(f);
                          e.target.value = "";
                        }}
                      />
                      <Button
                        variant="outline"
                        id="settings-font-upload"
                        data-testid="settings-font-upload"
                        onClick={() => fileRef.current?.click()}
                      >
                        <Upload className="h-4 w-4" />
                        {t("settings_page.font_upload")}
                      </Button>
                      {fontUploadError && (
                        <p role="alert" className="text-sm text-danger">
                          {fontUploadError}
                        </p>
                      )}
                    </CardContent>
                  </Card>
                </TabsContent>

                <TabsContent value="background" className="mt-0 space-y-4">
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">
                        {t("settings_page.background_title")}
                      </CardTitle>
                      <p className="text-xs text-muted-foreground">
                        {t("settings_page.background_hint")}
                      </p>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <AndroidBackgroundControls
                        running={bgServiceRunning}
                        exempt={batteryExempt}
                        busy={bgBusy}
                        onRefresh={async () => {
                          const bg = await import("@/lib/android/background");
                          if (!bg.isAndroid()) return;
                          setBgBusy(true);
                          try {
                            setBgServiceRunning(
                              await bg.isBackgroundServiceRunning(),
                            );
                            setBatteryExempt(
                              await bg.isBatteryExemptionGranted(),
                            );
                          } finally {
                            setBgBusy(false);
                          }
                        }}
                        onRequestExemption={async () => {
                          const bg = await import("@/lib/android/background");
                          setBgBusy(true);
                          try {
                            await bg.requestBatteryExemption();
                            setBatteryExempt(
                              await bg.isBatteryExemptionGranted(),
                            );
                            notifySuccess(
                              t("settings_page.background_toast_updated"),
                            );
                          } finally {
                            setBgBusy(false);
                          }
                        }}
                      />
                      {!isAndroidBackground() && (
                        <>
                          <div className="flex items-center gap-2">
                            <Switch
                              id="launch-at-startup"
                              data-testid="settings-launch-at-startup"
                              checked={launchAtStartup}
                              onCheckedChange={(v) =>
                                setBackgroundPref(
                                  "launch_at_startup",
                                  v,
                                  setLaunchAtStartup,
                                )
                              }
                            />
                            <Label htmlFor="launch-at-startup">
                              {t("settings_page.background_launch")}
                            </Label>
                          </div>
                          <div className="flex items-center gap-2">
                            <Switch
                              id="start-minimized"
                              data-testid="settings-start-minimized"
                              checked={startMinimized}
                              disabled={!launchAtStartup}
                              onCheckedChange={(v) =>
                                setBackgroundPref(
                                  "start_minimized",
                                  v,
                                  setStartMinimized,
                                )
                              }
                            />
                            <Label htmlFor="start-minimized">
                              {t("settings_page.background_minimized")}
                            </Label>
                          </div>
                          {!launchAtStartup && (
                            <p className="text-xs text-muted-foreground">
                              {t("settings_page.background_minimized_hint")}
                            </p>
                          )}
                          <div className="flex items-center gap-2">
                            <Switch
                              id="minimize-to-tray"
                              data-testid="settings-minimize-to-tray"
                              checked={minimizeToTray}
                              onCheckedChange={(v) =>
                                setBackgroundPref(
                                  "minimize_to_tray",
                                  v,
                                  setMinimizeToTray,
                                )
                              }
                            />
                            <Label htmlFor="minimize-to-tray">
                              {t("settings_page.background_minimize_tray")}
                            </Label>
                          </div>
                          <div className="flex items-center gap-2">
                            <Switch
                              id="close-to-tray"
                              data-testid="settings-close-to-tray"
                              checked={closeToTray}
                              onCheckedChange={(v) =>
                                setBackgroundPref(
                                  "close_to_tray",
                                  v,
                                  setCloseToTray,
                                )
                              }
                            />
                            <Label htmlFor="close-to-tray">
                              {t("settings_page.background_close_tray")}
                            </Label>
                          </div>
                          {!closeToTray && (
                            <p className="text-xs text-warning">
                              {t("settings_page.background_close_warning")}
                            </p>
                          )}
                        </>
                      )}
                    </CardContent>
                  </Card>
                </TabsContent>

                <TabsContent value="share" className="mt-0 space-y-4">
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">
                        {t("settings_page.share_title")}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="space-y-1">
                        <Label htmlFor="share-url">
                          {t("settings_page.share_url")}
                        </Label>
                        <div className="flex gap-2">
                          <Input
                            id="share-url"
                            placeholder={t("settings_page.share_url_example")}
                            value={shareUrl}
                            onChange={(e) => setShareUrl(e.target.value)}
                          />
                          <Button variant="outline" onClick={saveShareUrl}>
                            {t("common.save")}
                          </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {t("settings_page.share_url_hint")}
                        </p>
                      </div>

                      {!shareUser ? (
                        <div className="space-y-3 border-t pt-4">
                          <p className="text-sm font-medium">
                            {t("settings_page.share_signin_title")}
                          </p>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <div className="space-y-1">
                              <Label htmlFor="share-handle">
                                {t("auth.handle")}
                              </Label>
                              <Input
                                id="share-handle"
                                placeholder={t(
                                  "settings_page.share_handle_example",
                                )}
                                value={shareHandle}
                                onChange={(e) => setShareHandle(e.target.value)}
                              />
                            </div>
                            <div className="space-y-1">
                              <Label htmlFor="share-password">
                                {t("auth.password")}
                              </Label>
                              <Input
                                id="share-password"
                                type="password"
                                value={sharePassword}
                                onChange={(e) =>
                                  setSharePassword(e.target.value)
                                }
                              />
                            </div>
                          </div>
                          <div className="flex gap-2">
                            <Button onClick={doLogin} disabled={shareBusy}>
                              {shareBusy ? "…" : t("auth.sign_in")}
                            </Button>
                            <Button
                              variant="outline"
                              onClick={doRegister}
                              disabled={shareBusy}
                            >
                              {shareBusy
                                ? "…"
                                : t("settings_page.share_register")}
                            </Button>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {t("settings_page.share_rules")}
                          </p>
                        </div>
                      ) : (
                        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
                          <p className="text-sm">
                            {t("settings_page.share_signed_in")}{" "}
                            <span className="font-medium">
                              {shareUser.handle}
                            </span>
                          </p>
                          <Button asChild variant="outline" size="sm">
                            <Link to="/settings?section=profile">
                              {t("settings_page.share_manage_account")}
                            </Link>
                          </Button>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                  <SyncStatusCard />
                </TabsContent>

                <TabsContent value="data" className="mt-0 space-y-4">
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
                </TabsContent>

                <TabsContent value="retention" className="mt-0 space-y-4">
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">
                        {t("settings_page.retention")}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <Label htmlFor="retention-days">
                          {t("settings_page.retention_days")}
                        </Label>
                        <Input
                          id="retention-days"
                          type="number"
                          min="1"
                          value={retentionDays}
                          aria-invalid={!!retentionError}
                          aria-describedby={
                            retentionError ? "retention-days-error" : undefined
                          }
                          onChange={(e) => {
                            setRetentionDays(e.target.value);
                            setRetentionError("");
                          }}
                          onBlur={() =>
                            saveNumber(
                              "retention_days",
                              retentionDays,
                              1,
                              t("settings_page.retention_days"),
                              setRetentionError,
                            )
                          }
                        />
                        {retentionError && (
                          <p
                            id="retention-days-error"
                            role="alert"
                            className="text-xs text-danger"
                          >
                            {retentionError}
                          </p>
                        )}
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="max-records">
                          {t("settings_page.max_records")}
                        </Label>
                        <Input
                          id="max-records"
                          type="number"
                          min="100"
                          value={maxRecords}
                          aria-invalid={!!maxError}
                          aria-describedby={
                            maxError ? "max-records-error" : undefined
                          }
                          onChange={(e) => {
                            setMaxRecords(e.target.value);
                            setMaxError("");
                          }}
                          onBlur={() =>
                            saveNumber(
                              "max_records",
                              maxRecords,
                              100,
                              t("settings_page.max_records"),
                              setMaxError,
                            )
                          }
                        />
                        {maxError && (
                          <p
                            id="max-records-error"
                            role="alert"
                            className="text-xs text-danger"
                          >
                            {maxError}
                          </p>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">
                        {t("settings_page.reset_title")}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <p className="text-sm text-muted-foreground">
                        {t("settings_page.reset_desc")}
                      </p>
                      <Button
                        variant="destructive"
                        id="settings-reset-database"
                        data-testid="settings-reset-database"
                        onClick={() => setShowResetDialog(true)}
                      >
                        <Trash2 className="h-3 w-3 mr-2" />
                        {t("settings_page.reset_action")}
                      </Button>
                    </CardContent>
                  </Card>
                </TabsContent>

                <TabsContent value="diagnostics" className="mt-0 space-y-4">
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
                            {engineLabel && engineStatus?.available
                              ? t("settings_page.diag_rendering_with", {
                                  engine: engineLabel,
                                })
                              : t("settings_page.diag_rendering_missing")}
                          </p>
                          {engineStatus?.path && (
                            <p
                              id="settings-diag-engine-path"
                              className="mt-1 break-all font-mono text-xs text-muted-foreground"
                            >
                              {engineStatus.path}
                            </p>
                          )}
                          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                            <Label
                              htmlFor="settings-diag-browser-choice"
                            >
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
                              <Label
                                htmlFor="settings-diag-browser-custom-path"
                              >
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
                      {isWindows && (
                        <>
                          <p className="text-sm text-muted-foreground">
                            {t("settings_page.diag_fix_pc_print_hint")}
                          </p>
                          <Button
                            variant="outline"
                            id="settings-diag-fix-pc-print"
                            disabled={fixing}
                            onClick={() => setFixOpen(true)}
                          >
                            <Wrench className="h-4 w-4 mr-2" />
                            {fixing
                              ? t("settings_page.diag_fix_pc_print_running")
                              : t("settings_page.diag_fix_pc_print")}
                          </Button>
                        </>
                      )}
                      {fixReport && (
                        <div
                          id="settings-diag-fix-result"
                          className="rounded-md border p-3 text-sm"
                        >
                          <ul className="space-y-1">
                            <li>
                              {fixReport.edge_found
                                ? t("settings_page.fix_edge_found")
                                : t("settings_page.fix_edge_missing")}
                            </li>
                            {fixReport.edge_was_running && (
                              <li>
                                {fixReport.edge_closed
                                  ? t("settings_page.fix_edge_closed")
                                  : t("settings_page.fix_edge_running")}
                              </li>
                            )}
                            {fixReport.edge_closed &&
                              !fixReport.edge_verified_dead && (
                                <li
                                  id="settings-diag-fix-edge-survived"
                                  className="text-destructive"
                                >
                                  {t(
                                    "settings_page.diag_fix_edge_still_running",
                                  )}
                                </li>
                              )}
                            {fixReport.elevated && (
                              <li
                                id="settings-diag-fix-elevated"
                                className="text-destructive"
                              >
                                {t("settings_page.fix_elevated")}
                              </li>
                            )}
                            <li>
                              {fixReport.profiles_removed.length > 0
                                ? t("settings_page.fix_profiles_removed", {
                                    n: fixReport.profiles_removed.length,
                                  })
                                : t("settings_page.fix_no_profiles")}
                            </li>
                            {fixReport.cooldown_reset && (
                              <li>{t("settings_page.fix_cooldown")}</li>
                            )}
                            <li
                              className={
                                fixReport.test_render_ok
                                  ? "text-success"
                                  : "text-destructive"
                              }
                            >
                              {fixReport.test_render_ok
                                ? t("settings_page.fix_test_ok")
                                : t("settings_page.fix_test_failed")}
                            </li>
                          </ul>
                          {fixReport.test_render_error && (
                            <p className="mt-2 break-words text-xs text-muted-foreground">
                              {describeError(fixReport.test_render_error)}
                            </p>
                          )}
                          {!fixReport.test_render_ok && (
                            <div
                              id="settings-diag-shell-offer"
                              className="mt-3 border-t pt-3"
                            >
                              <p className="text-xs text-muted-foreground">
                                {t("settings_page.diag_fix_shell_offer")}
                              </p>
                              <div className="mt-2 flex flex-wrap items-center gap-2">
                                {shellStatus?.state === "ready" ? (
                                  <>
                                    <p
                                      id="settings-diag-shell-ready"
                                      className="text-xs text-success"
                                    >
                                      {t("settings_page.diag_fix_shell_ready")}
                                    </p>
                                    <Button
                                      variant="outline"
                                      id="settings-diag-shell-remove"
                                      disabled={shellBusy}
                                      onClick={() => void removeShell()}
                                    >
                                      <Trash2 className="h-4 w-4 mr-2" />
                                      {t("settings_page.diag_fix_shell_remove")}
                                    </Button>
                                  </>
                                ) : shellBusy ? (
                                  <div className="flex items-center gap-2">
                                    <p
                                      id="settings-diag-shell-downloading"
                                      className="text-xs"
                                    >
                                      {t(
                                        "settings_page.diag_fix_shell_downloading",
                                        {
                                          done: shellProgress
                                            ? Math.floor(
                                                shellProgress.done / 1048576,
                                              )
                                            : 0,
                                          total: shellProgress
                                            ? Math.max(
                                                1,
                                                Math.floor(
                                                  shellProgress.total /
                                                  1048576,
                                                ),
                                              )
                                            : 0,
                                        },
                                      )}
                                    </p>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      id="settings-diag-shell-cancel"
                                      onClick={() => void cancelShell()}
                                    >
                                      {t("settings_page.diag_shell_cancel")}
                                    </Button>
                                  </div>
                                ) : (
                                  <Button
                                    variant="outline"
                                    id="settings-diag-shell-download"
                                    onClick={() => void downloadShell()}
                                  >
                                    <Download className="h-4 w-4 mr-2" />
                                    {t("settings_page.diag_fix_shell_download")}
                                  </Button>
                                )}
                              </div>
                              {shellStatus?.state === "error" &&
                                shellStatus.error && (
                                  <p
                                    id="settings-diag-shell-error"
                                    className="mt-2 break-words text-xs text-destructive"
                                  >
                                    {describeError(
                                      new Error(shellStatus.error),
                                    )}
                                  </p>
                                )}
                            </div>
                          )}
                        </div>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {t("settings_page.diag_note")}
                      </p>
                    </CardContent>
                  </Card>
                </TabsContent>
              </>
            )}
          </div>
        </Tabs>
      )}

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
                  notifySuccess(t("settings_page.toast_allow_all"));
                })();
              }}
            >
              {t("settings_page.allow_all")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Print repair confirmation: it closes Edge windows without saving. */}
      <Dialog open={fixOpen} onOpenChange={(o) => !fixing && setFixOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("settings_page.fix_title")}</DialogTitle>
            <DialogDescription>{t("settings_page.fix_hint")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setFixOpen(false)}
              disabled={fixing}
            >
              {t("settings_page.fix_cancel")}
            </Button>
            <Button
              disabled={fixing}
              onClick={() => {
                setFixOpen(false);
                void runFix();
              }}
            >
              {t("settings_page.fix_confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Full-reset confirmation: the wipe cannot be undone. */}
      <Dialog open={showResetDialog} onOpenChange={setShowResetDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("settings_page.reset_confirm_title")}</DialogTitle>
            <DialogDescription>
              {t("settings_page.reset_body")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowResetDialog(false)}
              disabled={resetBusy}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={resetBusy}
              onClick={() => {
                void (async () => {
                  setResetBusy(true);
                  try {
                    const report = await agent("reset_database", {});
                    notifySuccess(
                      t("settings_page.toast_reset_done", {
                        templates: report.templates,
                        jobs: report.print_jobs,
                        fonts: report.fonts,
                      }),
                    );
                    window.location.reload();
                  } catch (e) {
                    notifyError(
                      t("settings_page.toast_reset_failed", {
                        error: describeError(e),
                      }),
                    );
                  } finally {
                    setResetBusy(false);
                    setShowResetDialog(false);
                  }
                })();
              }}
            >
              {resetBusy
                ? t("settings_page.reset_erasing")
                : t("settings_page.reset_confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
          <pre className="max-h-[50dvh] overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap break-all">
            {appLogText || t("settings_page.diag_app_log_empty")}
          </pre>
        </DialogContent>
      </Dialog>
    </div>
  );
}
