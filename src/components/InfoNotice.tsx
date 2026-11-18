import { useState, type HTMLAttributes, type ReactNode } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

const storageKey = (id: string) => `printninja.notice.dismissed.${id}`;

const readDismissed = (id: string) => {
  try {
    return localStorage.getItem(storageKey(id)) === "1";
  } catch {
    return false;
  }
};

/**
 * An informational banner (as opposed to a status banner) that the user can
 * hide for good. The dismissal is remembered per `id` (DESIGN_IMPROVEMENTS
 * 4.5): pages reuse the same `id` only when the notice means the same thing
 * there, so dismissing it on one page does not hide it on another.
 */
export function InfoNotice({
  id,
  children,
  ...rest
}: {
  id: string;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, "id">) {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(() => readDismissed(id));
  if (dismissed) return null;
  return (
    <div
      role="note"
      {...rest}
      className={cn(
        "relative rounded-lg border border-info/30 bg-info-soft px-4 py-3 pr-11 text-sm text-info",
        rest.className,
      )}
    >
      {children}
      <button
        type="button"
        aria-label={t("common.close")}
        title={t("common.close")}
        onClick={() => {
          try {
            localStorage.setItem(storageKey(id), "1");
          } catch {
            // Storage unavailable: the notice still dismisses for this visit.
          }
          setDismissed(true);
        }}
        className="absolute right-2 top-1/2 inline-flex -translate-y-1/2 items-center justify-center rounded-md p-1 text-info/70 hover:bg-info/10 hover:text-info [@media(pointer:coarse)]:right-0 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
