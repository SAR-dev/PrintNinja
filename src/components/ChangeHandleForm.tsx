import { describeError } from "@/lib/errors";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { HandleSuggestions } from "@/components/HandleSuggestions";
import { notifySuccess, notifyError } from "@/lib/notify";
import * as share from "@/lib/share/client";

// Matches the server's handle rule (shared.ts HANDLE_PATTERN): the
// server is the authority, so the field rejects the same shape up front.
const HANDLE_RE = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Handle change for the signed-in account. The account id never changes,
 * so templates, sessions and the sync cursor are unaffected; only the
 * displayed handle (and the device's greeting) pick up the new name.
 */
export function ChangeHandleForm({
  currentHandle,
  busy,
  setBusy,
  onChanged,
}: {
  currentHandle: string;
  busy: boolean;
  setBusy: (v: boolean) => void;
  onChanged: () => void;
}) {
  const [next, setNext] = useState(currentHandle);
  const [fieldError, setFieldError] = useState("");
  const { t } = useTranslation();

  const submit = async () => {
    const handle = next.trim();
    if (!handle) {
      setFieldError(t("settings_page.change_handle_required"));
      return;
    }
    if (!HANDLE_RE.test(handle)) {
      setFieldError(t("auth.handle_invalid"));
      return;
    }
    if (handle === currentHandle) {
      setFieldError(t("settings_page.change_handle_unchanged"));
      return;
    }
    setFieldError("");
    setBusy(true);
    try {
      await share.changeHandle(handle);
      // The greeting on this device reads the session handle; keep it in
      // step so the new name shows without a re-sign-in.
      share.setSessionHandle(handle);
      notifySuccess(t("settings_page.change_handle_done"));
      onChanged();
    } catch (e) {
      notifyError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      id="settings-change-handle"
      className="space-y-2 rounded-md border p-3"
    >
      <p className="text-sm font-medium">
        {t("settings_page.change_handle_title")}
      </p>
      <div className="space-y-1">
        <Label htmlFor="change-handle-new">
          {t("settings_page.change_handle_new")}
        </Label>
        <Input
          id="change-handle-new"
          data-testid="settings-change-handle-new"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          value={next}
          onChange={(e) => setNext(e.target.value)}
          disabled={busy}
        />
      </div>
      <HandleSuggestions onPick={setNext} disabled={busy} />
      <Button
        variant="outline"
        size="sm"
        data-testid="settings-change-handle-submit"
        onClick={() => void submit()}
        disabled={busy}
      >
        {busy ? "…" : t("settings_page.change_handle_save")}
      </Button>
      {fieldError && (
        <p role="alert" className="text-xs text-danger">
          {fieldError}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {t("settings_page.change_handle_hint")}
      </p>
    </div>
  );
}
