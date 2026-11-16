import { describeError } from "@/lib/errors";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { notifySuccess, notifyError } from "@/lib/notify";
import * as share from "@/lib/share/client";

/** "2026-03-01T14:05…" → "1 Mar 2026, 14:05" in the app language;
 * "" when unparseable. Time matters here — two rows on one machine
 * differ by minutes, not days. */
function formatLastUsed(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * The account's signed-in devices: every live session with its device
 * label, last use and a Revoke button, so a lost laptop can be ended
 * without signing out the good devices. Revoking the current row is a
 * logout by another name — the server ends the token and the app signs
 * out on the next call. Fails soft: an unreachable service shows a
 * message and Retry instead of blocking the Profile card.
 */
export function SignedInSessions({
  busy,
  setBusy,
}: {
  busy: boolean;
  setBusy: (v: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const [items, setItems] = useState<share.RemoteSession[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await share.listSessions();
      setItems(result.items);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (id: string) => {
    setBusy(true);
    try {
      await share.revokeSession(id);
      notifySuccess(t("settings_page.sessions_revoked"));
      await load();
    } catch (e) {
      notifyError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      id="settings-sessions"
      className="space-y-2 rounded-md border p-3"
      data-testid="settings-sessions"
    >
      <p className="text-sm font-medium">{t("settings_page.sessions_title")}</p>
      {error && (
        <div className="space-y-1">
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
          <Button
            variant="outline"
            size="sm"
            data-testid="settings-sessions-retry"
            onClick={() => void load()}
            disabled={loading}
          >
            {t("settings_page.sessions_retry")}
          </Button>
        </div>
      )}
      {!error && items === null && (
        <p className="text-xs text-muted-foreground">
          {t("settings_page.sessions_loading")}
        </p>
      )}
      {!error && items !== null && items.length === 0 && (
        <p className="text-xs text-muted-foreground">
          {t("settings_page.sessions_empty")}
        </p>
      )}
      {!error && items !== null && items.length > 0 && (
        <ul className="space-y-1">
          {items.map((session) => (
            <li
              key={session.id}
              className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5"
              data-testid="settings-session-row"
            >
              <div className="min-w-0">
                <p className="truncate text-sm">
                  {session.device_label}
                  {session.current && (
                    <span
                      className="ml-2 rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary"
                      data-testid="settings-session-current"
                    >
                      {t("settings_page.sessions_current")}
                    </span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("settings_page.sessions_last_used", {
                    when: formatLastUsed(session.last_used_at, i18n.language),
                  })}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                data-testid="settings-session-revoke"
                onClick={() => void revoke(session.id)}
                disabled={busy || loading}
              >
                {t("settings_page.sessions_revoke")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        {t("settings_page.sessions_hint")}
      </p>
      <Button
        variant="ghost"
        size="sm"
        data-testid="settings-sessions-refresh"
        onClick={() => void load()}
        disabled={busy || loading}
      >
        {t("settings_page.background_refresh")}
      </Button>
    </div>
  );
}
