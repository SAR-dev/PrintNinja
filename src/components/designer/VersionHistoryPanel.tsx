import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, RotateCcw } from "lucide-react";
import { describeError } from "@/lib/errors";
import { currentLanguage } from "@/lib/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  fetchRemoteTemplateVersions,
  type RemoteTemplateVersionSummary,
} from "@/lib/share/client";

interface Props {
  remoteId: string;
  /** Bump after a successful restore so the new version shows at the top. */
  refreshKey?: number;
  /** While a restore is running, or when the row cannot be changed. */
  disabled?: boolean;
  onRestore: (versionNo: number) => void;
}

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(currentLanguage());
};

/**
 * One template's version history, newest first, with a Restore per row.
 * The list lives on the server (owner-only); restoring writes the
 * chosen version back as a new revision, so it always shows up here
 * again at the top as a "Restore" entry.
 */
export function VersionHistoryPanel({
  remoteId,
  refreshKey = 0,
  disabled = false,
  onRestore,
}: Props) {
  const { t } = useTranslation();
  const [items, setItems] = useState<RemoteTemplateVersionSummary[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (targetPage: number, append: boolean) => {
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError(null);
      try {
        const res = await fetchRemoteTemplateVersions(remoteId, targetPage);
        setItems((prev) => (append ? [...prev, ...res.items] : res.items));
        setPage(res.page);
        setHasMore(res.has_more);
      } catch (e) {
        setError(describeError(e));
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [remoteId],
  );

  useEffect(() => {
    void load(1, false);
  }, [load, refreshKey]);

  if (loading) {
    return (
      <p
        className="flex items-center gap-2 p-4 text-sm text-muted-foreground"
        role="status"
      >
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        {t("designer.history_loading")}
      </p>
    );
  }

  if (error) {
    return (
      <div className="space-y-3 p-4">
        <p className="text-sm text-danger">{error}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void load(page, false)}
        >
          {t("designer.history_retry")}
        </Button>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        {t("designer.history_empty")}
      </p>
    );
  }

  const newest = items[0].version_no;

  return (
    <div className="p-4">
      <ul className="divide-y">
        {items.map((v) => {
          const isCurrent = v.version_no === newest;
          return (
            <li
              key={`${v.version_no}-${v.created_at}`}
              className="flex items-start justify-between gap-3 py-2.5"
            >
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-sm font-medium">
                    {t("designer.history_version", { n: v.version_no })}
                  </span>
                  {isCurrent ? (
                    <Badge variant="outline">
                      {t("designer.history_current")}
                    </Badge>
                  ) : null}
                  <Badge variant="secondary">
                    {t(`designer.history_by_${v.created_by}`)}
                  </Badge>
                  {v.label ? (
                    <span className="text-xs text-muted-foreground">
                      {v.label}
                    </span>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  {fmtDate(v.created_at)}
                </p>
                {v.note ? (
                  <p className="text-xs text-muted-foreground">{v.note}</p>
                ) : null}
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={disabled || isCurrent}
                onClick={() => onRestore(v.version_no)}
                data-testid={`history-restore-${v.version_no}`}
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                {t("designer.history_restore")}
              </Button>
            </li>
          );
        })}
      </ul>
      {hasMore && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 w-full"
          disabled={loadingMore}
          onClick={() => void load(page + 1, true)}
        >
          {loadingMore ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {t("designer.history_load_more")}
        </Button>
      )}
    </div>
  );
}
