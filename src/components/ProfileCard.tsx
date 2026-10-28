import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ChangePasswordForm } from "@/components/ChangePasswordForm";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SessionExpiredError } from "@/lib/api/errors";
import { describeError } from "@/lib/errors";
import * as share from "@/lib/share/client";

type Account =
  | { kind: "loading" }
  /** No share service address, or no session: nothing to show or sign out of. */
  | { kind: "signed_out" }
  | { kind: "signed_in"; handle: string; createdAt: string }
  /** A session is stored but the service did not answer. Sign out still works. */
  | { kind: "unreachable"; url: string };

/** "2026-03-01T…" → "1 Mar 2026" in the app language; "" when unparseable. */
function formatSince(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Who is signed in on this device, with the one-tap sign out and the
 * password form. The top-bar user badge opens the Settings section that
 * renders this, on desktop and on phones.
 */
export function ProfileCard() {
  const { t, i18n } = useTranslation();
  const [account, setAccount] = useState<Account>({ kind: "loading" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const url = await share.getServiceUrl();
      const token = await share.getSessionToken();
      if (!url || !token) {
        setAccount({ kind: "signed_out" });
        return;
      }
      try {
        const me = await share.fetchMe();
        setAccount({
          kind: "signed_in",
          handle: me.handle,
          createdAt: me.created_at,
        });
      } catch (err) {
        // A 401 already ended the session and the gate takes over.
        setAccount(
          err instanceof SessionExpiredError
            ? { kind: "signed_out" }
            : { kind: "unreachable", url },
        );
      }
    } catch {
      setAccount({ kind: "signed_out" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const signOut = async () => {
    setBusy(true);
    try {
      await share.logout();
      setAccount({ kind: "signed_out" });
      toast.success(t("settings_page.toast_signed_out"));
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const signOutButton = (
    <Button
      variant="outline"
      onClick={() => void signOut()}
      disabled={busy}
      id="profile-sign-out"
      data-testid="profile-sign-out"
      className="w-full sm:w-auto"
    >
      {t("settings_page.share_sign_out")}
    </Button>
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("settings_page.profile_title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {account.kind === "loading" && (
            <p className="text-sm text-muted-foreground" role="status">
              {t("settings_page.profile_loading")}
            </p>
          )}

          {account.kind === "signed_out" && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {t("settings_page.profile_signed_out")}
              </p>
              <Button asChild variant="outline">
                <Link to="/settings?section=share">
                  {t("settings_page.profile_open_share")}
                </Link>
              </Button>
            </div>
          )}

          {account.kind === "signed_in" && (
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <span
                  aria-hidden="true"
                  className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-accent text-lg font-semibold uppercase text-accent-foreground"
                >
                  {account.handle.charAt(0)}
                </span>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">
                    {t("settings_page.share_signed_in")}
                  </p>
                  <p
                    className="truncate text-base font-semibold"
                    data-testid="profile-handle"
                  >
                    {account.handle}
                  </p>
                  {formatSince(account.createdAt, i18n.language) && (
                    <p className="text-xs text-muted-foreground">
                      {t("settings_page.profile_member_since", {
                        date: formatSince(account.createdAt, i18n.language),
                      })}
                    </p>
                  )}
                </div>
              </div>
              {signOutButton}
            </div>
          )}

          {account.kind === "signed_in" && (
            <ChangePasswordForm busy={busy} setBusy={setBusy} />
          )}

          {account.kind === "unreachable" && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {t("settings_page.profile_unreachable", { url: account.url })}
              </p>
              {signOutButton}
              <p className="text-xs text-muted-foreground">
                {t("settings_page.profile_sign_out_offline")}
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
