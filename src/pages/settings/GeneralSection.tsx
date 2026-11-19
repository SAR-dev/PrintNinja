import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Trash2, Upload } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AppearanceSettings } from "@/components/AppearanceSettings";
import { agent } from "@/lib/agent/commands";
import type { FontRow, RenderEngineStatus } from "@/lib/agent/types";
import { describeError } from "@/lib/errors";
import { notifyError, notifySuccess } from "@/lib/notify";
import { readCachedSetting, readSetting, writeSetting } from "@/lib/settings";

/**
 * Settings → General: appearance (delegated to `AppearanceSettings`),
 * the CUPS daemon address on Linux, and the installed fonts. State is
 * section-local: the tab unmounts when inactive, and every control
 * saves on blur/change, so re-reading on mount is always fresh.
 */
export function GeneralSection({
  engine,
}: {
  engine: RenderEngineStatus | null;
}) {
  const { t } = useTranslation();

  // The CUPS daemon address (Linux): a device-local setting that wins
  // over the PRINTNINJA_CUPS_URL environment variable.
  const [cupsUrl, setCupsUrl] = useState(
    () => readCachedSetting("cups-url") ?? "",
  );
  useEffect(() => {
    void readSetting("cups-url").then((v) => {
      if (v) setCupsUrl(v);
    });
  }, []);

  const [fonts, setFonts] = useState<FontRow[]>([]);
  const [fontUploadError, setFontUploadError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const loadFonts = useCallback(async () => {
    try {
      setFonts((await agent("list_fonts", {})) ?? []);
    } catch {
      /* backend unavailable */
    }
  }, []);

  useEffect(() => {
    void loadFonts();
    // A completed pull may bring another PC's fonts (or confirm a
    // delete); reload so the list shows it with no manual step (F10).
    const onPulled = () => {
      void loadFonts();
    };
    window.addEventListener("sync:pulled", onPulled);
    return () => window.removeEventListener("sync:pulled", onPulled);
  }, [loadFonts]);

  const uploadFont = async (file: File) => {
    setFontUploadError("");
    try {
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      await agent("upload_font", {
        file_name: file.name,
        file_data: bytes,
        family: null,
      });
      notifySuccess(
        t("settings_page.toast_font_uploaded", { name: file.name }),
      );
      await loadFonts();
      // Stored locally for now; sending fonts to the server gets its own
      // explicit action in phase 2.
    } catch (e) {
      // The wrong content (a non-font with a font extension) must read
      // inline, not just in a toast (F10).
      setFontUploadError(
        t("designer.custom_font_failed", { error: describeError(e) }),
      );
    }
  };

  return (
    <>
      {engine?.platform === "linux" && (
        /* Linux only: system printers are served through CUPS,
           and a non-local daemon needs its address here. */
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("settings_page.cups_title")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              <Label htmlFor="cups-url">{t("settings_page.cups_url")}</Label>
              <Input
                id="cups-url"
                data-testid="settings-cups-url"
                placeholder="http://localhost:631"
                value={cupsUrl}
                onChange={(e) => setCupsUrl(e.target.value)}
                onBlur={() => void writeSetting("cups-url", cupsUrl.trim())}
              />
              <p className="text-xs text-muted-foreground">
                {t("settings_page.cups_url_hint")}
              </p>
            </div>
          </CardContent>
        </Card>
      )}
      <AppearanceSettings />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("settings_page.fonts_installed")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {fonts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("settings_page.fonts_empty")}
            </p>
          ) : (
            fonts.map((f) => (
              <div
                key={f.id}
                data-testid={`font-row-${f.id}`}
                className="flex items-center justify-between p-3 rounded-md border"
              >
                <div>
                  <p className="text-sm font-medium">{f.family}</p>
                  <p className="text-xs text-muted-foreground uppercase">
                    {f.format}
                  </p>
                  <p
                    data-testid={`font-state-${f.id}`}
                    className="text-xs text-muted-foreground"
                  >
                    {f.state === "ready"
                      ? t("settings_page.font_ready")
                      : f.state === "error"
                        ? t("settings_page.font_error")
                        : t("settings_page.font_downloading")}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t("settings_page.font_remove", {
                    name: f.family,
                  })}
                  data-testid={`font-delete-${f.id}`}
                  onClick={async () => {
                    try {
                      await agent("delete_font", { id: f.id });
                      await loadFonts();
                      notifySuccess(
                        t("settings_page.toast_font_removed", {
                          name: f.family,
                        }),
                      );
                    } catch (e) {
                      notifyError(
                        t("settings_page.toast_failed", {
                          error: describeError(e),
                        }),
                      );
                    }
                  }}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))
          )}

          <input
            ref={fileRef}
            type="file"
            aria-label={t("settings_page.font_upload_label")}
            tabIndex={-1}
            accept=".ttf,.otf,.woff,.woff2"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) uploadFont(f);
              e.target.value = "";
            }}
          />
          <Button
            variant="outline"
            id="settings-font-upload"
            data-testid="settings-font-upload"
            onClick={() => fileRef.current?.click()}
          >
            <Upload className="h-4 w-4" />
            {t("settings_page.font_upload")}
          </Button>
          {fontUploadError && (
            <p role="alert" className="text-sm text-danger">
              {fontUploadError}
            </p>
          )}
        </CardContent>
      </Card>
    </>
  );
}
