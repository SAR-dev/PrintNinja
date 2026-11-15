import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { isAndroid } from "@/lib/android/platform";
import type { NotificationPermissionState } from "@/lib/android/background";

/** Android-only background controls. Desktop uses tray settings
 * instead (rendered beside this, never together). */
export function isAndroidBackground(): boolean {
  return isAndroid();
}

interface AndroidBackgroundControlsProps {
  running: boolean | null;
  exempt: boolean | null;
  /** null until the first state read lands. */
  notif: NotificationPermissionState | null;
  busy: boolean;
  onRefresh: () => void;
  onRequestExemption: () => void;
  onRequestNotifications: () => void;
}

export function AndroidBackgroundControls({
  running,
  exempt,
  notif,
  busy,
  onRefresh,
  onRequestExemption,
  onRequestNotifications,
}: AndroidBackgroundControlsProps) {
  const { t } = useTranslation();
  useEffect(() => {
    if (isAndroidBackground()) {
      void onRefresh();
    }
    // Refresh once when the section mounts; the service state only
    // changes through this screen or the notification action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!isAndroidBackground()) {
    return null;
  }

  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">
            {t("settings_page.background_service")}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("settings_page.background_service_hint")}
          </p>
        </div>
        <Badge variant={running ? "success" : "secondary"}>
          {running == null
            ? "…"
            : running
              ? t("settings_page.background_running")
              : t("settings_page.background_stopped")}
        </Badge>
      </div>
      <div
        className="flex items-center justify-between gap-2"
        data-testid="settings-notifications-row"
      >
        <div>
          <p className="text-sm font-medium">
            {t("settings_page.background_notifications")}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("settings_page.background_notifications_hint")}
          </p>
        </div>
        <Badge variant={notif?.granted ? "success" : "secondary"}>
          {notif == null
            ? "…"
            : notif.granted
              ? t("settings_page.background_allowed")
              : t("settings_page.background_not_allowed")}
        </Badge>
      </div>
      {notif != null && !notif.granted && (
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={onRequestNotifications}
            data-testid="settings-notification-permission"
          >
            {notif.canAskAgain
              ? t("settings_page.background_allow_notifications")
              : t("settings_page.background_open_notification_settings")}
          </Button>
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">
            {t("settings_page.background_battery")}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("settings_page.background_battery_hint")}
          </p>
        </div>
        <Badge variant={exempt ? "success" : "secondary"}>
          {exempt == null
            ? "…"
            : exempt
              ? t("settings_page.background_allowed")
              : t("settings_page.background_not_allowed")}
        </Badge>
      </div>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={onRequestExemption}
          data-testid="settings-battery-exemption"
        >
          {busy
            ? t("settings_page.background_working")
            : t("settings_page.background_request")}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onRefresh}>
          {t("settings_page.background_refresh")}
        </Button>
      </div>
    </div>
  );
}
