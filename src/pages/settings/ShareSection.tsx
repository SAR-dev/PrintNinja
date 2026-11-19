import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SyncStatusCard } from "@/components/SyncStatusCard";
import { HandleSuggestions } from "@/components/HandleSuggestions";
import { describeError } from "@/lib/errors";
import { notifyError, notifySuccess } from "@/lib/notify";
import * as share from "@/lib/share/client";
import { defaultServiceUrl, normalizeServiceUrl } from "@/lib/share/session";

/**
 * Settings → Account & sync: the share-service address and the
 * sign-in on top of it. The session is read on mount; the tab
 * unmounts when inactive, and sign-out/sign-in go through the
 * share client, so nothing here needs to survive a remount.
 */
export function ShareSection() {
  const { t } = useTranslation();

  const [shareUrl, setShareUrl] = useState("");
  const [shareHandle, setShareHandle] = useState("");
  const [sharePassword, setSharePassword] = useState("");
  const [shareUser, setShareUser] = useState<{ handle: string } | null>(null);
  const [shareBusy, setShareBusy] = useState(false);

  useEffect(() => {
    (async () => {
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
    })();
  }, []);

  const saveShareUrl = async () => {
    const typed = shareUrl.trim();
    const next = typed ? normalizeServiceUrl(typed) : null;
    if (typed && !next) {
      notifyError(t("settings_page.toast_bad_url"));
      return;
    }
    const current = await share.getServiceUrl();
    if (next === current) return;
    const hadSession = !!(await share.getSessionToken());
    await share.setServiceUrl(next);
    setShareUrl(next ?? "");
    if (hadSession) {
      // The session token belongs to the old server. Drop it and return to the
      // sign-in screen, which is prefilled with the new address.
      setShareUser(null);
      await share.endSession("signed_out");
    }
    // The address shows in the field above (and a re-sign-in screen when
    // the session is dropped) — visible, so no toast.
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

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("settings_page.share_title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="share-url">{t("settings_page.share_url")}</Label>
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
                  <Label htmlFor="share-handle">{t("auth.handle")}</Label>
                  <Input
                    id="share-handle"
                    placeholder={t("settings_page.share_handle_example")}
                    value={shareHandle}
                    onChange={(e) => setShareHandle(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="share-password">{t("auth.password")}</Label>
                  <Input
                    id="share-password"
                    type="password"
                    value={sharePassword}
                    onChange={(e) => setSharePassword(e.target.value)}
                  />
                </div>
              </div>
              <HandleSuggestions onPick={setShareHandle} disabled={shareBusy} />
              <div className="flex gap-2">
                <Button onClick={doLogin} disabled={shareBusy}>
                  {shareBusy ? "…" : t("auth.sign_in")}
                </Button>
                <Button
                  variant="outline"
                  onClick={doRegister}
                  disabled={shareBusy}
                >
                  {shareBusy ? "…" : t("settings_page.share_register")}
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
                <span className="font-medium">{shareUser.handle}</span>
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
    </>
  );
}
