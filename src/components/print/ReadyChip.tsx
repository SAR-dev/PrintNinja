import { useTranslation } from "react-i18next";

/**
 * The quiet mark that a printer is ready, shown next to the printer
 * select. Ready is the normal state, so it gets a chip, not a banner;
 * the banner slot is kept for printing, the result and problems.
 */
export function ReadyChip() {
  const { t } = useTranslation();
  return (
    <span
      role="status"
      data-testid="print-ready-chip"
      className="inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success-soft px-2 py-0.5 text-body-sm font-medium text-success"
    >
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full bg-success"
        aria-hidden="true"
      />
      {t("print.ready_chip")}
    </span>
  );
}
