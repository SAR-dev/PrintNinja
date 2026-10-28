import { useTranslation } from "react-i18next";
import { WifiOff } from "lucide-react";

/**
 * Standing note under the HTML/CSS editors: printing never touches the
 * network, so remote images, fonts and stylesheets silently don't load.
 * Always visible (not conditional like ClassWarnings) because it states
 * a guarantee, not a problem with this template. The save-time check
 * rejects remote refs with the same "use data: URIs" advice; this is the
 * explanation authors see before they hit it.
 */
export function OfflinePrintHint() {
  const { t } = useTranslation();
  return (
    <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
      <WifiOff className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{t("designer.offline_print_hint")}</span>
    </p>
  );
}
