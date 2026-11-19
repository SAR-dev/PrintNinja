import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles } from "lucide-react";
import { hasSeenFirstPrint, markFirstPrintSeen } from "@/lib/firstPrint";

/**
 * The one-time brand moment after the very first successful print: a
 * highlight pill on the success banner (desktop and phone). Shown once
 * per device; the flag persists in localStorage.
 */
export function FirstPrintMoment() {
  const { t } = useTranslation();
  const [seen] = useState(() => hasSeenFirstPrint());
  useEffect(() => {
    if (!seen) markFirstPrintSeen();
  }, [seen]);
  if (seen) return null;
  return (
    <span
      data-testid="first-print-moment"
      className="inline-flex items-center gap-1 rounded-full bg-highlight-soft px-2 py-0.5 text-xs font-medium text-highlight"
    >
      <Sparkles className="h-3 w-3 shrink-0" aria-hidden="true" />
      {t("print.first_print")}
    </span>
  );
}
