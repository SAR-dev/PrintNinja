import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useManualRefresh } from "@/lib/refresh/manual";
import { cn } from "@/lib/utils";

/**
 * The shared manual refresh as a page-header control: one icon, spinning
 * while any refresh runs, the result reported by the shared toast. Every
 * header instance triggers the same single refresh — a second tap is
 * ignored while one runs.
 */
export function RefreshButton() {
  const { t } = useTranslation();
  const { refreshing, run } = useManualRefresh();
  return (
    <Button
      variant="outline"
      size="icon"
      aria-label={t("shell.refresh")}
      title={t("shell.refresh")}
      onClick={run}
      disabled={refreshing}
    >
      <RefreshCw
        className={cn("h-4 w-4", refreshing && "animate-spin")}
        aria-hidden="true"
      />
    </Button>
  );
}
