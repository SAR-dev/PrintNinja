import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

const BANNER_TONES = {
  neutral: "border-border bg-muted text-foreground",
  success: "border-success/30 bg-success-soft text-success",
  danger: "border-danger/30 bg-danger-soft text-danger",
  warning: "border-warning/30 bg-warning-soft text-warning",
} as const;

/**
 * The Print page's one status slot. Every state (ready, sent, failed,
 * warned) is the same fixed-height single line, so the form below never
 * jumps when the state changes; whatever does not fit on the line (stage
 * timings, the full error, every warning) opens in place, and only when
 * the person asks for it.
 */
export function StatusBanner({
  tone,
  role,
  icon,
  summary,
  title,
  actions,
  details,
}: {
  tone: keyof typeof BANNER_TONES;
  role: "status" | "alert";
  icon: React.ReactNode;
  summary: React.ReactNode;
  title?: string;
  actions?: React.ReactNode;
  details?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div role={role} className={cn("rounded-lg border", BANNER_TONES[tone])}>
      <div className="flex h-11 items-center gap-3 px-4">
        {icon}
        <p className="min-w-0 flex-1 truncate text-sm" title={title}>
          {summary}
        </p>
        {actions}
        {details && (
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 gap-1 px-2 text-current hover:text-current"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? t("print.details_hide") : t("print.details_show")}
            <ChevronDown
              className={cn(
                "h-4 w-4 transition-transform",
                open && "rotate-180",
              )}
              aria-hidden="true"
            />
          </Button>
        )}
      </div>
      {details && open && (
        <div className="space-y-2 border-t border-current/15 px-4 py-3">
          {details}
        </div>
      )}
    </div>
  );
}
