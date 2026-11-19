import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/StatusBadge";
import { RefreshCw } from "lucide-react";
import { useShareStatus } from "@/lib/shell/useShareStatus";
import { useManualRefresh } from "@/lib/refresh/manual";
import { useSyncStatus } from "@/lib/sync/useSyncStatus";
import { cn } from "@/lib/utils";

/**
 * Visible cache state for the Settings → Share tab. The topbar only
 * carries badges and a hover tooltip (and hides on phones), so a failed
 * refresh's reason had nowhere to be read. This card shows the
 * connection, the local drafts (edits not yet saved to the server), the
 * last refresh time and — when set — the last error as plain text, plus
 * the shared manual refresh (the same one the topbar and page headers
 * run, so it works even while the server is unreachable).
 */
export function SyncStatusCard() {
  const { t } = useTranslation();
  const share = useShareStatus();
  const sync = useSyncStatus();
  const { refreshing, run } = useManualRefresh();

  const online = share.state === "online";
  const syncing = refreshing || sync.state === "syncing";

  const connection =
    share.state === "online"
      ? t("shell.share_online", { handle: share.handle })
      : share.state === "offline"
        ? t("shell.share_offline")
        : share.state === "signed_out"
          ? t("shell.share_signed_out")
          : t("settings_page.sync_unconfigured");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {t("settings_page.sync_status")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            {t("settings_page.sync_connection")}
          </p>
          {share.state === "online" ? (
            <StatusBadge
              status="online"
              label={share.handle || t("status.online")}
            />
          ) : share.state === "offline" ? (
            <StatusBadge status="offline" />
          ) : (
            <span className="text-sm">{connection}</span>
          )}
        </div>

        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            {t("settings_page.sync_drafts")}
          </p>
          {syncing ? (
            <StatusBadge status="syncing" />
          ) : sync.drafts > 0 ? (
            <StatusBadge
              status="pending"
              label={t("shell.sync_drafts", { count: sync.drafts })}
            />
          ) : (
            <StatusBadge status="synced" />
          )}
        </div>

        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            {t("settings_page.sync_last")}
          </p>
          <span className="text-sm">
            {sync.lastPulledAt
              ? t("shell.sync_synced", { time: sync.lastPulledAt })
              : t("settings_page.sync_never")}
          </span>
        </div>

        {sync.lastError && (
          <p role="alert" className="text-sm text-danger">
            {t("shell.sync_failed", { error: sync.lastError })}
          </p>
        )}

        <Button
          variant="outline"
          onClick={run}
          disabled={refreshing}
          title={t("shell.refresh")}
        >
          <RefreshCw
            className={cn("h-4 w-4 mr-2", refreshing && "animate-spin")}
            aria-hidden="true"
          />
          {syncing ? t("shell.sync_syncing") : t("shell.sync_now")}
        </Button>
        {!online && (
          <p className="text-xs text-muted-foreground">
            {t("settings_page.sync_sign_in_first")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
