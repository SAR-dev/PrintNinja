import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SETTING_KEYS, parseNotifyOn, type NotifyOn } from "@/lib/prefs/prefs";
import {
  readCachedSetting,
  readSetting,
  writeSetting,
} from "@/lib/settings";
import { cn } from "@/lib/utils";

/**
 * When finished background print jobs post a result notification
 * (item 41, Android). Applies immediately and is stored in settings,
 * like the other preference cards.
 */
export function NotifyOnSettings() {
  const { t } = useTranslation();
  // The cached value paints the first frame; the settings store wins
  // once it answers.
  const [notifyOn, setNotifyOn] = useState<NotifyOn>(() =>
    parseNotifyOn(readCachedSetting(SETTING_KEYS.notifyOn)),
  );

  useEffect(() => {
    let live = true;
    void readSetting(SETTING_KEYS.notifyOn).then((v) => {
      if (live) setNotifyOn(parseNotifyOn(v));
    });
    return () => {
      live = false;
    };
  }, []);

  const options: Array<{ value: NotifyOn; label: string; hint: string }> = [
    {
      value: "failures",
      label: t("settings_page.notify_on_failures"),
      hint: t("settings_page.notify_on_failures_hint"),
    },
    {
      value: "all",
      label: t("settings_page.notify_on_all"),
      hint: t("settings_page.notify_on_all_hint"),
    },
    {
      value: "never",
      label: t("settings_page.notify_on_never"),
      hint: t("settings_page.notify_on_never_hint"),
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("settings_page.notify_on")}</CardTitle>
      </CardHeader>
      <CardContent>
        <div
          role="radiogroup"
          aria-label={t("settings_page.notify_on")}
          id="settings-notify-on"
          data-testid="settings-notify-on"
          className="grid gap-2 sm:grid-cols-3"
        >
          {options.map((o) => {
            const selected = notifyOn === o.value;
            return (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={selected}
                data-testid={`settings-notify-on-${o.value}`}
                onClick={() => {
                  setNotifyOn(o.value);
                  void writeSetting(SETTING_KEYS.notifyOn, o.value);
                }}
                className={cn(
                  "rounded-md border p-3 text-left transition-colors",
                  selected
                    ? "border-primary bg-accent"
                    : "border-input bg-card hover:bg-muted",
                )}
              >
                <span className="block font-medium">{o.label}</span>
                <span className="block text-sm text-muted-foreground">
                  {o.hint}
                </span>
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {t("settings_page.notify_on_note")}
        </p>
      </CardContent>
    </Card>
  );
}
