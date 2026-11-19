import { useTranslation } from "react-i18next";
import { CheckCircle2, Loader2, TriangleAlert, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TimingBreakdown } from "@/components/TimingBreakdown";
import { formatSeconds } from "@/lib/timings";
import type { PrintState } from "./types";
import { StatusBanner } from "./StatusBanner";

/**
 * The one place a print's outcome is reported: a banner of constant
 * height while printing and for the result (see StatusBanner), so
 * the form below never moves. Being ready is the normal state, so
 * it gets a quiet chip next to the printer select, not a banner.
 */
export function PrintResultBanners({
  store,
  printedVia,
  remoteCode,
  canPrint,
  handleSyncTemplates,
  handlePrint,
}: {
  store: PrintState;
  printedVia: string | null;
  remoteCode: string | null;
  canPrint: boolean;
  handleSyncTemplates: () => void;
  handlePrint: (retry?: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {store.status === "printing" && (
        <StatusBanner
          tone="neutral"
          role="status"
          icon={
            <Loader2
              className="h-5 w-5 shrink-0 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          }
          summary={
            <>
              <span className="font-medium">{t("print.printing")}</span>
              {store.printerId &&
                ` ${t("print.printing_detail", { printer: store.printerId })}`}
            </>
          }
        />
      )}
      {store.status === "success" && (
        <StatusBanner
          tone={store.warnings.length > 0 ? "warning" : "success"}
          role={store.warnings.length > 0 ? "alert" : "status"}
          icon={
            store.warnings.length > 0 ? (
              <TriangleAlert className="h-5 w-5 shrink-0" aria-hidden="true" />
            ) : (
              <CheckCircle2 className="h-5 w-5 shrink-0" aria-hidden="true" />
            )
          }
          summary={
            <>
              <span className="font-medium">{t("print.sent")}</span>
              {" · "}
              {store.timings
                ? `${t("common.total")} ${formatSeconds(store.timings.total_ms)}`
                : t("print.finished", {
                    seconds: formatSeconds(store.durationMs),
                  })}
              {store.renderedBy &&
                ` · ${t("print.rendered_on", { peer: store.renderedBy })}`}
              {printedVia && (
                <span data-testid="print-printed-via">
                  {" · "}
                  {t("print.printed_via", { pc: printedVia })}
                </span>
              )}
              {store.warnings.length > 0 &&
                ` · ${t("print.warnings_title")}: ${store.warnings[0]}`}
            </>
          }
          details={
            store.timings || store.warnings.length > 0 ? (
              <>
                {store.warnings.length > 0 && (
                  <div data-testid="print-warnings" className="space-y-1">
                    <p className="text-sm font-medium">
                      {t("print.warnings_title")}
                    </p>
                    {store.warnings.map((w) => (
                      <p key={w} className="break-words text-xs">
                        {w}
                      </p>
                    ))}
                  </div>
                )}
                {store.timings && <TimingBreakdown timings={store.timings} />}
              </>
            ) : undefined
          }
        />
      )}
      {store.status === "failed" && (
        <StatusBanner
          tone="danger"
          role="alert"
          icon={<XCircle className="h-5 w-5 shrink-0" aria-hidden="true" />}
          title={store.error || t("print.unknown_error")}
          summary={
            <>
              <span className="font-medium">{t("print.failed_title")}</span>
              {" — "}
              {store.error || t("print.unknown_error")}
            </>
          }
          actions={
            <>
              {/* Sync refreshes this phone only: it can heal a stale
                  revision, never a template missing on the PC — whose
                  message now names the PC. */}
              {remoteCode === "template_stale" && (
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  data-testid="print-sync-templates"
                  onClick={handleSyncTemplates}
                >
                  {t("print.sync_templates")}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => void handlePrint(true)}
                disabled={!canPrint}
              >
                {t("print.retry")}
              </Button>
            </>
          }
          details={
            <>
              <p className="break-words text-xs">
                {store.error || t("print.unknown_error")}
              </p>
              {store.warnings.length > 0 && (
                <div data-testid="print-warnings" className="space-y-1">
                  <p className="text-sm font-medium">
                    {t("print.warnings_title")}
                  </p>
                  {store.warnings.map((w) => (
                    <p key={w} className="break-words text-xs">
                      {w}
                    </p>
                  ))}
                </div>
              )}
              {store.timings && <TimingBreakdown timings={store.timings} />}
            </>
          }
        />
      )}
    </>
  );
}
