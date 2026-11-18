import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AppLogo } from "@/components/AppLogo";
import { SUPPORTED_LANGUAGES, currentLanguage, setLanguage } from "@/lib/i18n";
import { useRovingRadio } from "@/lib/hooks/useRovingRadio";
import { usePrefs } from "@/lib/prefs/PrefsProvider";
import {
  DEFAULT_APP_NAME,
  MAX_APP_NAME_LENGTH,
  checkLogoFile,
  type Density,
  type Theme,
} from "@/lib/prefs/prefs";
import { cn } from "@/lib/utils";

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** Filled radio mark in the corner of the selected card (4.10). */
function SelectedMark() {
  return (
    <span
      aria-hidden="true"
      className="absolute right-2 top-2 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-primary-foreground"
    >
      <Check className="h-3 w-3" strokeWidth={3} />
    </span>
  );
}

/** Shared look of an appearance option card: 2px border, light teal
    fill and a check mark when selected (DESIGN IMPROVEMENTS 4.10). */
const optionCardClass =
  "relative rounded-md border-2 p-3 text-left transition-colors";
const selectedCardClass = "border-primary bg-accent";
const unselectedCardClass = "border-input bg-card hover:bg-muted";

/** Density and optional branding. Both apply immediately and are stored in settings. */
export function AppearanceSettings() {
  // useTranslation re-renders this component when the language changes.
  const { t } = useTranslation();
  const language = currentLanguage();
  const {
    density,
    theme,
    appName,
    logo,
    setDensity,
    setTheme,
    setAppName,
    setLogo,
  } = usePrefs();
  const [name, setName] = useState(appName);
  const [logoError, setLogoError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const densities: Array<{ value: Density; label: string; hint: string }> = [
    {
      value: "comfortable",
      label: t("settings_page.appearance_density_comfortable"),
      hint: t("settings_page.appearance_density_comfortable_hint"),
    },
    {
      value: "compact",
      label: t("settings_page.appearance_density_compact"),
      hint: t("settings_page.appearance_density_compact_hint"),
    },
  ];

  const themes: Array<{ value: Theme; label: string; hint: string }> = [
    {
      value: "light",
      label: t("settings_page.appearance_theme_light"),
      hint: t("settings_page.appearance_theme_light_hint"),
    },
    {
      value: "dark",
      label: t("settings_page.appearance_theme_dark"),
      hint: t("settings_page.appearance_theme_dark_hint"),
    },
    {
      value: "system",
      label: t("settings_page.appearance_theme_system"),
      hint: t("settings_page.appearance_theme_system_hint"),
    },
  ];

  // Roving tabindex per group: one tab stop, arrows move and select.
  const langRadio = useRovingRadio(
    SUPPORTED_LANGUAGES.length,
    SUPPORTED_LANGUAGES.findIndex((l) => l.code === language),
    (i) => {
      void setLanguage(SUPPORTED_LANGUAGES[i].code);
    },
  );
  const themeRadio = useRovingRadio(
    themes.length,
    themes.findIndex((th) => th.value === theme),
    (i) => setTheme(themes[i].value),
  );
  const densityRadio = useRovingRadio(
    densities.length,
    densities.findIndex((d) => d.value === density),
    (i) => setDensity(densities[i].value),
  );

  useEffect(() => setName(appName), [appName]);

  // No toast: the typed name stays in the field — the save is visible.
  const saveName = async () => {
    if (name.trim() === appName) return;
    await setAppName(name);
  };

  const pickLogo = async (file: File) => {
    const check = checkLogoFile(file);
    if (!check.ok) {
      setLogoError(t(check.messageKey, check.messageValues));
      return;
    }
    setLogoError("");
    try {
      // No toast: the preview above swaps to the new logo.
      await setLogo(await readAsDataUrl(file));
    } catch {
      setLogoError(t("settings_page.appearance_logo_unreadable"));
    }
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("settings_page.appearance_language")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div
            role="radiogroup"
            aria-label={t("settings_page.appearance_language")}
            id="settings-language"
            data-testid="settings-language"
            className="grid gap-2 sm:grid-cols-2"
          >
            {SUPPORTED_LANGUAGES.map((l, i) => {
              const selected = language === l.code;
              const radio = langRadio.register(i);
              return (
                <button
                  key={l.code}
                  ref={radio.ref}
                  type="button"
                  role="radio"
                  lang={l.code}
                  tabIndex={radio.tabIndex}
                  aria-checked={selected}
                  data-testid={`settings-language-${l.code}`}
                  onClick={() => void setLanguage(l.code)}
                  onKeyDown={radio.onKeyDown}
                  className={cn(
                    optionCardClass,
                    "font-medium",
                    selected ? selectedCardClass : unselectedCardClass,
                  )}
                >
                  {selected && <SelectedMark />}
                  <span className={cn("block", selected && "pr-6")}>
                    {l.label}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {t("settings_page.appearance_language_hint")}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("settings_page.appearance_theme")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div
            role="radiogroup"
            aria-label={t("settings_page.appearance_theme")}
            id="settings-theme"
            data-testid="settings-theme"
            className="grid gap-2 sm:grid-cols-3"
          >
            {themes.map((th, i) => {
              const selected = theme === th.value;
              const radio = themeRadio.register(i);
              return (
                <button
                  key={th.value}
                  ref={radio.ref}
                  type="button"
                  role="radio"
                  aria-label={th.label}
                  aria-checked={selected}
                  tabIndex={radio.tabIndex}
                  data-testid={`settings-theme-${th.value}`}
                  onClick={() => setTheme(th.value)}
                  onKeyDown={radio.onKeyDown}
                  className={cn(
                    optionCardClass,
                    selected ? selectedCardClass : unselectedCardClass,
                  )}
                >
                  {selected && <SelectedMark />}
                  <span className={cn("block font-medium", selected && "pr-6")}>
                    {th.label}
                  </span>
                  <span className="block text-sm text-muted-foreground">
                    {th.hint}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {t("settings_page.appearance_theme_note")}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("settings_page.appearance_density")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div
            role="radiogroup"
            aria-label={t("settings_page.appearance_density")}
            id="settings-density"
            data-testid="settings-density"
            className="grid gap-2 sm:grid-cols-2"
          >
            {densities.map((d, i) => {
              const selected = density === d.value;
              const radio = densityRadio.register(i);
              return (
                <button
                  key={d.value}
                  ref={radio.ref}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  tabIndex={radio.tabIndex}
                  onClick={() => setDensity(d.value)}
                  onKeyDown={radio.onKeyDown}
                  className={cn(
                    optionCardClass,
                    selected ? selectedCardClass : unselectedCardClass,
                  )}
                >
                  {selected && <SelectedMark />}
                  <span className={cn("block font-medium", selected && "pr-6")}>
                    {d.label}
                  </span>
                  <span className="block text-sm text-muted-foreground">
                    {d.hint}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {t("settings_page.appearance_density_note")}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("settings_page.appearance_branding")}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {t("settings_page.appearance_branding_hint")}
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="brand-name">
              {t("settings_page.appearance_app_name")}
            </Label>
            <Input
              id="brand-name"
              data-testid="settings-brand-name"
              value={name}
              maxLength={MAX_APP_NAME_LENGTH}
              placeholder={DEFAULT_APP_NAME}
              onChange={(e) => setName(e.target.value)}
              onBlur={saveName}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveName();
              }}
            />
          </div>

          <div className="space-y-1.5">
            <Label>{t("settings_page.appearance_logo")}</Label>
            <div className="flex flex-wrap items-center gap-3">
              <AppLogo src={logo} className="h-10 w-10" />
              <input
                ref={fileRef}
                type="file"
                aria-label={t("settings_page.appearance_upload_logo_label")}
                tabIndex={-1}
                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void pickLogo(f);
                  e.target.value = "";
                }}
              />
              <Button
                variant="outline"
                id="settings-logo-upload"
                data-testid="settings-logo-upload"
                onClick={() => fileRef.current?.click()}
              >
                <Upload className="h-4 w-4" aria-hidden="true" />
                {t("settings_page.appearance_upload_logo")}
              </Button>
              {logo && (
                <Button
                  variant="ghost"
                  onClick={async () => {
                    await setLogo(null);
                  }}
                >
                  {t("settings_page.appearance_remove_logo")}
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {t("settings_page.appearance_logo_hint")}
            </p>
            {logoError && (
              <p role="alert" className="text-sm text-danger">
                {logoError}
              </p>
            )}
          </div>

          {(appName !== DEFAULT_APP_NAME || logo) && (
            <Button
              variant="outline"
              onClick={async () => {
                await setAppName(DEFAULT_APP_NAME);
                await setLogo(null);
              }}
            >
              {t("settings_page.appearance_reset", { name: DEFAULT_APP_NAME })}
            </Button>
          )}
        </CardContent>
      </Card>
    </>
  );
}
