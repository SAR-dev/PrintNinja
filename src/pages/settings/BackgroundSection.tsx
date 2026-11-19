import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AndroidBackgroundControls,
  isAndroidBackground,
} from "@/components/BackgroundAndroid";
import { NotifyOnSettings } from "@/components/NotifyOnSettings";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { agent } from "@/lib/agent/commands";
import { describeError } from "@/lib/errors";
import { notifyError, notifyInfo, notifySuccess } from "@/lib/notify";
import { readCachedSetting, readSetting, writeSetting } from "@/lib/settings";
// Type only: keeps the background module (and its invoke wrapper) out
// of this chunk — every runtime use goes through the dynamic import.
import type { NotificationPermissionState } from "@/lib/android/background";

/** A cached toggle: the live write path stores "1"/"0"; "true" covers
    anything written before the switch to numeric strings. */
function cachedToggle(key: string, fallback: boolean): boolean {
  const v = readCachedSetting(key);
  return v === null ? fallback : v === "true" || v === "1";
}

/**
 * Settings → Background: autostart/tray toggles on desktop, the
 * Android background-service card on phones. Toggles persist on
 * change and ask the backend to re-apply without a restart.
 */
export function BackgroundSection() {
  const { t } = useTranslation();

  const [launchAtStartup, setLaunchAtStartup] = useState(() =>
    cachedToggle("launch_at_startup", false),
  );
  const [startMinimized, setStartMinimized] = useState(() =>
    cachedToggle("start_minimized", false),
  );
  const [minimizeToTray, setMinimizeToTray] = useState(() =>
    cachedToggle("minimize_to_tray", false),
  );
  const [closeToTray, setCloseToTray] = useState(() =>
    cachedToggle("close_to_tray", true),
  );
  // The cache paints the first frame; the DB read below corrects it if
  // the two ever diverge (e.g. an old app copy wrote to the DB only).
  useEffect(() => {
    (async () => {
      const [startup, minimized, minTray, closeTray] = await Promise.all([
        readSetting("launch_at_startup"),
        readSetting("start_minimized"),
        readSetting("minimize_to_tray"),
        readSetting("close_to_tray"),
      ]);
      if (startup !== null)
        setLaunchAtStartup(startup === "true" || startup === "1");
      if (minimized !== null)
        setStartMinimized(minimized === "true" || minimized === "1");
      if (minTray !== null)
        setMinimizeToTray(minTray === "true" || minTray === "1");
      if (closeTray !== null)
        setCloseToTray(closeTray === "true" || closeTray === "1");
    })();
  }, []);

  const [bgServiceRunning, setBgServiceRunning] = useState<boolean | null>(
    null,
  );
  const [batteryExempt, setBatteryExempt] = useState<boolean | null>(null);
  const [notifPerm, setNotifPerm] =
    useState<NotificationPermissionState | null>(null);
  const [bgBusy, setBgBusy] = useState(false);
  // The exemption dialog opens on top of the app, so the real answer
  // only exists once the user comes back: re-read the state on
  // visibilitychange instead of trusting the moment the invoke
  // resolved (the state read there is always stale — the dialog is
  // still on screen). The notification prompt behaves the same way.
  const pendingBatteryRecheck = useRef(false);
  const pendingNotifRecheck = useRef(false);

  useEffect(() => {
    if (!isAndroidBackground()) return;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (pendingBatteryRecheck.current) {
        pendingBatteryRecheck.current = false;
        void (async () => {
          const bg = await import("@/lib/android/background");
          const exempt = await bg.isBatteryExemptionGranted();
          setBatteryExempt(exempt);
          if (exempt) {
            notifySuccess(t("settings_page.background_toast_granted"));
          } else {
            notifyInfo(t("settings_page.background_toast_not_granted"));
          }
        })();
      }
      if (pendingNotifRecheck.current) {
        pendingNotifRecheck.current = false;
        void (async () => {
          const bg = await import("@/lib/android/background");
          const state = await bg.notificationPermissionState();
          setNotifPerm(state);
          if (state.granted) {
            notifySuccess(
              t("settings_page.background_notifications_toast_granted"),
            );
          }
          // Still denied: silent — the row already shows it and the
          // button keeps offering a way back.
        })();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [t]);

  // One behavior for every background toggle: persist the key and ask
  // the backend to re-apply autostart/tray without a restart. The switch
  // flipping is the visible result; no toast.
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
  };

  return (
    <>
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
            notif={notifPerm}
            busy={bgBusy}
            onRefresh={async () => {
              const bg = await import("@/lib/android/background");
              if (!bg.isAndroid()) return;
              setBgBusy(true);
              try {
                setBgServiceRunning(await bg.isBackgroundServiceRunning());
                setBatteryExempt(await bg.isBatteryExemptionGranted());
                setNotifPerm(await bg.notificationPermissionState());
              } finally {
                setBgBusy(false);
              }
            }}
            onRequestExemption={async () => {
              const bg = await import("@/lib/android/background");
              setBgBusy(true);
              try {
                const shown = await bg.requestBatteryExemption();
                if (shown) {
                  // The system dialog is on top of the app:
                  // the real state arrives when the user
                  // returns (visibilitychange effect), so
                  // don't read or toast it yet.
                  pendingBatteryRecheck.current = true;
                } else {
                  // Already exempt (or the OS cannot show
                  // the screen): the state is final now.
                  setBatteryExempt(await bg.isBatteryExemptionGranted());
                  notifySuccess(t("settings_page.background_toast_updated"));
                }
              } catch (e) {
                notifyError(describeError(e));
              } finally {
                setBgBusy(false);
              }
            }}
            onRequestNotifications={async () => {
              const bg = await import("@/lib/android/background");
              setBgBusy(true);
              try {
                const result = await bg.requestNotificationPermission();
                // The prompt and the settings screen both sit
                // on top of the app: the real answer arrives
                // when the user comes back (visibilitychange
                // effect). The instant read only catches the
                // already-granted short circuit.
                pendingNotifRecheck.current = true;
                if (!result.openedSettings) {
                  setNotifPerm(await bg.notificationPermissionState());
                }
              } catch (e) {
                notifyError(describeError(e));
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
                    setBackgroundPref("start_minimized", v, setStartMinimized)
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
                    setBackgroundPref("minimize_to_tray", v, setMinimizeToTray)
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
                    setBackgroundPref("close_to_tray", v, setCloseToTray)
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
      {/* Item 41: when finished background jobs notify.
          Android-only — the desktop has no notification
          shade, so the setting would never apply. */}
      {isAndroidBackground() && <NotifyOnSettings />}
    </>
  );
}
