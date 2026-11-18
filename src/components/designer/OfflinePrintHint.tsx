import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Info, WifiOff } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const SEEN_KEY = "printninja.designer.offline_hint_seen";

const readSeen = () => {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
};

/**
 * Standing note under the HTML/CSS editors: printing never touches the
 * network, so remote images, fonts and stylesheets silently don't load.
 * Always visible (not conditional like ClassWarnings) because it states
 * a guarantee, not a problem with this template. The save-time check
 * rejects remote refs with the same "use data: URIs" advice; this is the
 * explanation authors see before they hit it.
 *
 * Once read, it tucks away behind an info icon that carries the same text
 * in a tooltip (DESIGN IMPROVEMENTS 4.8): a note the author has already
 * seen should not keep taking editor space.
 */
export function OfflinePrintHint() {
  const { t } = useTranslation();
  const [seen, setSeen] = useState(readSeen);
  const text = t("designer.offline_print_hint");

  // First encounter: show the full note long enough to read, then remember
  // it and collapse to the icon. Re-encounters start collapsed.
  useEffect(() => {
    if (seen) return;
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(SEEN_KEY, "1");
      } catch {
        // No storage: the note stays full this visit, icon next time.
      }
      setSeen(true);
    }, 10_000);
    return () => window.clearTimeout(timer);
  }, [seen]);

  if (!seen) {
    return (
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <WifiOff className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{text}</span>
      </p>
    );
  }

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            className="inline-flex items-center rounded-md text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <Info className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="sr-only">{text}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
