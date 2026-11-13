import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

/**
 * The paper-width box under the printer picker, shared by the desktop and
 * phone layouts.
 *
 * - "mismatch": the sheet is wider than the printer's saved width. One tap
 *   sets the saved width to the sheet's; "Other…" opens the dialog for a
 *   different number.
 * - "missing": a saved printer has no width yet. The same one-tap fix is
 *   offered once ("Not now" is remembered).
 *
 * OS printers have no saved width to change, so they get the message only.
 */
export function PaperWidthNotice({
  kind,
  message,
  width,
  busy,
  onApply,
  onOther,
  onDismiss,
}: {
  kind: "mismatch" | "missing";
  message: string;
  /** The whole-mm width the one-tap action saves; null when it cannot be one. */
  width: number | null;
  busy: boolean;
  /** Absent for printers without an editable saved width. */
  onApply?: () => void;
  onOther?: () => void;
  onDismiss?: () => void;
}) {
  const { t } = useTranslation();
  const warn = kind === "mismatch";
  return (
    <div
      data-testid={warn ? "paper-mismatch" : "paper-width-missing"}
      className={
        warn
          ? "mt-1.5 flex flex-wrap items-center gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2"
          : "mt-1.5 flex flex-wrap items-center gap-2 rounded-md border bg-muted px-3 py-2"
      }
    >
      <p
        role="status"
        className={`min-w-0 flex-1 basis-48 text-xs ${warn ? "text-warning" : "text-muted-foreground"}`}
      >
        {message}
      </p>
      {onApply && (
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={busy}
            onClick={onApply}
            data-testid={warn ? "set-paper-size" : "paper-width-set"}
          >
            {width != null
              ? t("print.paper_set_to", { w: width })
              : t("print.paper_size_action")}
          </Button>
          {warn && width != null && onOther && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              disabled={busy}
              onClick={onOther}
              data-testid="set-paper-size-other"
            >
              {t("print.paper_other")}
            </Button>
          )}
          {!warn && onDismiss && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              disabled={busy}
              onClick={onDismiss}
              data-testid="paper-width-dismiss"
            >
              {t("print.paper_not_now")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
