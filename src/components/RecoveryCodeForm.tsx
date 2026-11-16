import { useState } from "react";
import { useTranslation } from "react-i18next";
import { RecoveryCodeBox } from "@/components/RecoveryCodeBox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { describeError } from "@/lib/errors";
import { notifyError } from "@/lib/notify";
import * as share from "@/lib/share/client";

/**
 * Makes the signed-in account's recovery code: the first one for an
 * account that predates them, or a replacement for a lost one (the old
 * code stops working). The current password is required. The code is
 * shown once, here, and never fetched again.
 */
export function RecoveryCodeForm({
  busy,
  setBusy,
}: {
  busy: boolean;
  setBusy: (v: boolean) => void;
}) {
  const [current, setCurrent] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState("");
  const { t } = useTranslation();

  const submit = async () => {
    if (!current) {
      setFieldError(t("settings_page.change_password_current_required"));
      return;
    }
    setFieldError("");
    setBusy(true);
    try {
      const res = await share.issueRecoveryCode(current);
      setCurrent("");
      setCode(res.recovery_code);
    } catch (e) {
      notifyError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      id="settings-recovery-code"
      className="space-y-2 rounded-md border p-3"
    >
      <p className="text-sm font-medium">{t("settings_page.recovery_title")}</p>
      <p className="text-xs text-muted-foreground">
        {t("settings_page.recovery_hint")}
      </p>
      {code ? (
        <div className="space-y-2">
          <RecoveryCodeBox code={code} />
          <p role="status" className="text-xs text-muted-foreground">
            {t("settings_page.recovery_saved_note")}
          </p>
          <Button
            variant="outline"
            size="sm"
            data-testid="settings-recovery-done"
            onClick={() => setCode(null)}
          >
            {t("settings_page.recovery_done")}
          </Button>
        </div>
      ) : (
        <>
          <div className="max-w-xs space-y-1">
            <Label htmlFor="recovery-current">
              {t("settings_page.recovery_password")}
            </Label>
            <Input
              id="recovery-current"
              data-testid="settings-recovery-current"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              disabled={busy}
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            data-testid="settings-recovery-submit"
            onClick={() => void submit()}
            disabled={busy}
          >
            {t("settings_page.recovery_generate")}
          </Button>
          {fieldError && (
            <p role="alert" className="text-xs text-danger">
              {fieldError}
            </p>
          )}
        </>
      )}
    </div>
  );
}
