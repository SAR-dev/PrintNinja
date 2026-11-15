import { Download } from "lucide-react";
import { useTranslation } from "react-i18next";
import { openExternalUrl, useUpdateCheck } from "@/lib/appUpdate";
import { isAndroid } from "@/lib/platform";
import { isWebMode } from "@/lib/settings";

/**
 * Topbar pill, shown only when a newer release exists. Opens the release
 * page so the user can update by hand — no download or install happens
 * here. On Android the badge only appears when the release attaches an
 * APK (see useUpdateCheck), links straight to that file and says what
 * to do with it: a phone installs by opening the download.
 */
export function UpdateBadge() {
  const { t } = useTranslation();
  const update = useUpdateCheck();
  if (!update.available) return null;
  const android = isAndroid();
  const label = android
    ? t("shell.update_android_apk", { version: `v${update.version}` })
    : t("shell.update_available", { version: `v${update.version}` });
  const target = android && update.apkUrl ? update.apkUrl : update.url;
  return (
    <a
      href={target}
      target="_blank"
      rel="noopener noreferrer"
      title={label}
      aria-label={label}
      onClick={(e) => {
        // Web builds: let the anchor open the tab natively. Calling
        // window.open from an async continuation loses the click gesture
        // and trips the popup blocker.
        if (isWebMode()) return;
        // Tauri webviews do not open external anchors on their own.
        e.preventDefault();
        void openExternalUrl(target);
      }}
      className="flex items-center gap-1 rounded-md bg-accent px-2 py-0.5 text-xs font-medium whitespace-nowrap text-accent-foreground hover:opacity-90 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11 [@media(pointer:coarse)]:justify-center"
    >
      <Download className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {/* Phone top bar: icon only (the version is in the label/title); the
          number returns from sm up, like the other header badges. */}
      <span className="hidden sm:inline">v{update.version}</span>
    </a>
  );
}
