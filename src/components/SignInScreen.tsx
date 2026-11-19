import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AppLogo } from "@/components/AppLogo";
import { RecoveryCodeBox } from "@/components/RecoveryCodeBox";
import { Button } from "@/components/ui/button";
import { HandleSuggestions } from "@/components/HandleSuggestions";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { usePrefs } from "@/lib/prefs/PrefsProvider";
import { randomHandle } from "@/lib/randomHandle";
import * as share from "@/lib/share/client";
import { normalizeServiceUrl } from "@/lib/share/session";

interface SignInScreenProps {
  /** Address saved from an earlier run, if any. */
  initialUrl: string | null;
  /** Shown above the form, for example when the session ended. */
  notice?: string;
  onSignedIn: (handle: string) => void;
  /** Enter without an account: pair over LAN, server features stay signed out. */
  onGuest: (handle: string) => void;
}

// Same rules the server enforces on register.
const HANDLE_RE = /^[\p{L}\p{N}_-]{1,32}$/u;

/** Full-screen sign-in and register form, shown before the app when there is no valid session. */
export function SignInScreen({
  initialUrl,
  notice,
  onSignedIn,
  onGuest,
}: SignInScreenProps) {
  const { t } = useTranslation();
  const { appName, logo } = usePrefs();
  const [mode, setMode] = useState<"login" | "register" | "reset">("login");
  const [recoveryCode, setRecoveryCode] = useState("");
  // A recovery code the server just handed out. It is shown once, so the
  // screen holds here until the person says they saved it.
  const [saveCode, setSaveCode] = useState<{
    code: string;
    handle: string;
    afterReset: boolean;
  } | null>(null);
  const [url, setUrl] = useState(initialUrl ?? "");
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const [guestHandle, setGuestHandle] = useState("");
  // Example handles for the placeholders. Picked once per mount so they
  // don't change while the person types or switches between steps.
  const [handleExample] = useState(() => randomHandle());
  const [guestExample] = useState(() => randomHandle());
  // The name field lives on its own step: the sign-in form shows only
  // the entry button, and clicking it swaps the card to ask for the
  // handle before continuing.
  const [guestStep, setGuestStep] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const registering = mode === "register";
  const resetting = mode === "reset";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;

    const address = normalizeServiceUrl(url);
    if (!address) return setError(t("auth.server_address_invalid"));
    const name = handle.trim();
    if (resetting) {
      if (!name || !recoveryCode.trim() || !password) {
        return setError(t("auth.reset_required"));
      }
      if (password.length < 8) return setError(t("auth.password_short"));
    } else {
      if (!name || !password) return setError(t("auth.required"));
      if (registering) {
        if (!HANDLE_RE.test(name)) return setError(t("auth.handle_invalid"));
        if (password.length < 8) return setError(t("auth.password_short"));
      }
    }

    setError("");
    setBusy(true);
    try {
      await share.setServiceUrl(address);
      if (resetting) {
        const reset = await share.resetPassword(name, recoveryCode, password);
        setPassword("");
        setRecoveryCode("");
        setSaveCode({
          code: reset.recovery_code,
          handle: name,
          afterReset: true,
        });
        setBusy(false);
        return;
      }
      if (registering) {
        const res = await share.register(name, password);
        setPassword("");
        // An older server sends no code: carry on as before.
        if (res.recovery_code) {
          setSaveCode({
            code: res.recovery_code,
            handle: res.user.handle,
            afterReset: false,
          });
          setBusy(false);
          return;
        }
        onSignedIn(res.user.handle);
        return;
      }
      const res = await share.login(name, password);
      setPassword("");
      onSignedIn(res.user.handle);
    } catch (err) {
      if (err instanceof share.ServerUnreachableError) {
        setError(t("auth.unreachable_inline", { url: err.url }));
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
      setBusy(false);
    }
  };

  const toggleMode = () => {
    setMode(registering ? "login" : "register");
    setError("");
  };

  const goTo = (next: "login" | "reset") => {
    setMode(next);
    setPassword("");
    setRecoveryCode("");
    setError("");
  };

  const enterGuestStep = () => {
    if (busy) return;
    setError("");
    setGuestStep(true);
  };

  const enterAsGuest = () => {
    if (busy) return;
    const name = guestHandle.trim();
    if (!name) {
      setError(t("auth.guest_handle_required"));
      return;
    }
    if (!HANDLE_RE.test(name)) {
      setError(t("auth.handle_invalid"));
      return;
    }
    setError("");
    onGuest(name);
  };

  if (saveCode) {
    const { afterReset } = saveCode;
    return (
      <main
        data-testid="signin-form"
        className="flex min-h-dvh-safe items-center justify-center bg-background p-4"
      >
        <Card className="w-full max-w-md">
          <CardHeader className="space-y-3">
            {/* Brand moment: the mark sits on a brand-soft tile. */}
            <div className="flex h-14 w-14 items-center justify-center rounded-lg bg-accent">
              <AppLogo src={logo} className="h-9 w-9" />
            </div>
            <h1 className="text-xl font-semibold leading-none tracking-tight">
              {afterReset
                ? t("auth.recovery_save_reset_title")
                : t("auth.recovery_save_title")}
            </h1>
            <CardDescription>
              {afterReset
                ? t("auth.recovery_save_reset_body")
                : t("auth.recovery_save_body")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <RecoveryCodeBox code={saveCode.code} />
            <Button
              type="button"
              className="w-full"
              data-testid="recovery-continue"
              onClick={() => {
                if (afterReset) {
                  // The reset signed every device out: back to sign-in,
                  // handle still filled in.
                  setSaveCode(null);
                  setMode("login");
                } else {
                  onSignedIn(saveCode.handle);
                }
              }}
            >
              {afterReset
                ? t("auth.recovery_continue_sign_in")
                : t("auth.recovery_continue")}
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  if (guestStep) {
    return (
      <main
        data-testid="signin-form"
        className="flex min-h-dvh-safe items-center justify-center bg-background p-4"
      >
        <Card className="w-full max-w-md">
          <CardHeader className="space-y-3">
            {/* Brand moment: the mark sits on a brand-soft tile. */}
            <div className="flex h-14 w-14 items-center justify-center rounded-lg bg-accent">
              <AppLogo src={logo} className="h-9 w-9" />
            </div>
            <h1 className="text-xl font-semibold leading-none tracking-tight">
              {t("auth.continue_as_guest")}
            </h1>
            <CardDescription>{t("auth.guest_hint")}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="auth-guest-handle">
                  {t("auth.guest_handle")}
                </Label>
                <Input
                  id="auth-guest-handle"
                  data-testid="auth-guest-handle"
                  autoComplete="nickname"
                  autoCapitalize="none"
                  spellCheck={false}
                  autoFocus
                  placeholder={t("auth.guest_handle_placeholder", {
                    example: guestExample,
                  })}
                  value={guestHandle}
                  onChange={(e) => setGuestHandle(e.target.value)}
                  disabled={busy}
                />
              </div>

              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}

              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="flex-1"
                  onClick={() => {
                    setGuestStep(false);
                    setError("");
                  }}
                  disabled={busy}
                >
                  {t("common.back")}
                </Button>
                <Button
                  type="button"
                  className="flex-1"
                  data-testid="auth-guest-continue"
                  onClick={enterAsGuest}
                  disabled={busy}
                >
                  {t("auth.continue_as_guest")}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main
      data-testid="signin-form"
      className="flex min-h-dvh-safe items-center justify-center bg-background p-4"
    >
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-3">
          {/* Brand moment: the mark sits on a brand-soft tile. */}
          <div className="flex h-14 w-14 items-center justify-center rounded-lg bg-accent">
            <AppLogo src={logo} className="h-9 w-9" />
          </div>
          <h1 className="text-xl font-semibold leading-none tracking-tight">
            {resetting
              ? t("auth.reset_title")
              : registering
                ? t("auth.register_title")
                : t("auth.sign_in_title", { appName })}
          </h1>
          <CardDescription>
            {resetting
              ? t("auth.reset_description")
              : t("auth.sign_in_description")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4" noValidate>
            {notice && (
              <p
                role="status"
                className="rounded-md border border-border bg-muted p-3 text-sm"
              >
                {notice}
              </p>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="auth-url">{t("auth.server_address")}</Label>
              <Input
                id="auth-url"
                data-testid="auth-url"
                type="url"
                inputMode="url"
                autoComplete="url"
                spellCheck={false}
                placeholder="https://printninja.example.com"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                aria-describedby="auth-url-hint"
                disabled={busy}
              />
              <p id="auth-url-hint" className="text-xs text-muted-foreground">
                {t("auth.server_address_hint")}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="auth-handle">{t("auth.handle")}</Label>
              <Input
                id="auth-handle"
                data-testid="auth-handle"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                autoFocus={!!initialUrl}
                placeholder={t("auth.handle_placeholder", {
                  example: handleExample,
                })}
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                disabled={busy}
              />
              {registering && (
                <HandleSuggestions onPick={setHandle} disabled={busy} />
              )}
            </div>

            {resetting && (
              <div className="space-y-1.5">
                <Label htmlFor="auth-recovery-code">
                  {t("auth.recovery_code")}
                </Label>
                <Input
                  id="auth-recovery-code"
                  data-testid="auth-recovery-code"
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  className="font-mono"
                  placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
                  value={recoveryCode}
                  onChange={(e) => setRecoveryCode(e.target.value)}
                  disabled={busy}
                />
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="auth-password">
                {resetting ? t("auth.new_password") : t("auth.password")}
              </Label>
              <PasswordInput
                // Remount on mode switch so the field goes back to hidden.
                key={mode}
                id="auth-password"
                data-testid="auth-password"
                autoComplete={
                  registering || resetting ? "new-password" : "current-password"
                }
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-describedby={
                  registering || resetting ? "auth-password-hint" : undefined
                }
                disabled={busy}
              />
              {(registering || resetting) && (
                <p
                  id="auth-password-hint"
                  className="text-xs text-muted-foreground"
                >
                  {t("auth.password_hint")}
                </p>
              )}
            </div>

            {mode === "login" && (
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs"
                data-testid="auth-forgot-password"
                onClick={() => goTo("reset")}
                disabled={busy}
              >
                {t("auth.forgot_password")}
              </Button>
            )}

            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}

            <Button type="submit" className="w-full" disabled={busy}>
              {resetting
                ? busy
                  ? t("auth.resetting")
                  : t("auth.reset_submit")
                : registering
                  ? busy
                    ? t("auth.registering")
                    : t("auth.register")
                  : busy
                    ? t("auth.signing_in")
                    : t("auth.sign_in")}
            </Button>
            <Button
              type="button"
              variant="link"
              className="w-full"
              onClick={resetting ? () => goTo("login") : toggleMode}
              disabled={busy}
            >
              {resetting
                ? t("auth.back_to_sign_in")
                : registering
                  ? t("auth.switch_to_sign_in")
                  : t("auth.switch_to_register")}
            </Button>
            {!resetting && (
              <div className="space-y-1">
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  data-testid="auth-guest"
                  onClick={enterGuestStep}
                  disabled={busy}
                >
                  {t("auth.continue_as_guest")}
                </Button>
                <p className="text-center text-xs text-muted-foreground">
                  {t("auth.guest_hint")}
                </p>
              </div>
            )}
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
