import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { usePcStatus } from "@/lib/shell/usePcStatus";

/**
 * Phone only: a thin strip under the top bar while no paired PC answers.
 * Every print from a phone is rendered by the PC, so this is the warning
 * that prints will fail, shown before the person tries one. It goes away
 * on its own once a PC answers.
 *
 * Two outages, two strips: a removed phone gets "Pair again" (probing
 * cannot help it), anything else gets "Check again" with the reason one
 * tap behind the text. One line, truncated, controls 44px on touch.
 * Dismiss mutes only the current outage episode: any change (a PC
 * recovers, another fails, a new outage after recovery) is a new episode
 * that shows again, and an app restart restores the warning. There is
 * deliberately no permanent hide: this is the only pre-print warning,
 * and without it the person learns printing is broken only from a
 * failed job.
 */
export function PcStatusBanner() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const { status, episodeKey, recheck, refresh } = usePcStatus();
  const [mutedKey, setMutedKey] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  // Moving between pages is when people are about to print; the hook
  // throttles this so it is not a probe per tap.
  useEffect(() => {
    refresh();
  }, [pathname, refresh]);

  if (status.state !== "down") return null;
  // Muted for this outage episode: a recheck with the same failing PCs
  // keeps it hidden; a changed episode shows it again.
  if (episodeKey !== null && episodeKey === mutedKey) return null;
  const unpaired = status.kind === "unpaired";
  return (
    <div
      data-testid="pc-down-banner"
      role="status"
      className="flex items-center gap-3 border-b border-warning/30 bg-warning-soft px-3 py-1 text-xs text-warning"
    >
      <div className="min-w-0 flex-1">
        {unpaired ? (
          <p className="truncate font-medium">
            {t("shell.pc_unpaired_title", { name: status.name })}
          </p>
        ) : (
          <button
            type="button"
            data-testid="pc-down-details"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="block w-full truncate text-left font-medium underline-offset-2 [@media(pointer:coarse)]:min-h-11"
          >
            {status.total > 1
              ? t("shell.pc_unreachable_plural", { count: status.total })
              : t("shell.pc_unreachable_title", { name: status.name })}
          </button>
        )}
        {expanded && !unpaired && status.reason && <p>{status.reason}</p>}
      </div>
      {unpaired ? (
        <Link
          to="/automation?tab=phones"
          data-testid="pc-down-open"
          className="shrink-0 underline underline-offset-2 [@media(pointer:coarse)]:flex [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11 [@media(pointer:coarse)]:items-center"
        >
          {t("shell.pc_pair_again")}
        </Link>
      ) : (
        <button
          type="button"
          data-testid="pc-down-retry"
          onClick={recheck}
          className="shrink-0 underline underline-offset-2 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
        >
          {t("shell.pc_check_again")}
        </button>
      )}
      <button
        type="button"
        data-testid="pc-down-dismiss"
        aria-label={t("shell.pc_down_dismiss")}
        onClick={() => episodeKey !== null && setMutedKey(episodeKey)}
        className="shrink-0 underline underline-offset-2 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
      >
        {"✕"}
      </button>
    </div>
  );
}
