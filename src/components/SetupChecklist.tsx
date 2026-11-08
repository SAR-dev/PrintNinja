import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { readSetting } from "@/lib/settings";
import * as share from "@/lib/share/client";
import {
  buildChecklist,
  summarize,
  type ChecklistInput,
  type ChecklistItem,
  type SettingsSection,
} from "@/lib/setup/checklist";
import { tauriInvoke } from "@/lib/tauriGuard";
import { agent } from "@/lib/agent/commands";

const EMPTY: ChecklistInput = {
  printers: null,
  templates: null,
  jobs: null,
  shareConfigured: null,
  apiRunning: null,
  retentionReviewed: null,
};

async function countOf(cmd: string): Promise<number | null> {
  try {
    const rows = await tauriInvoke<unknown>(cmd);
    return Array.isArray(rows) ? rows.length : null;
  } catch {
    return null;
  }
}

async function loadStatus(): Promise<ChecklistInput> {
  const [printers, templates, jobs, retention, url] = await Promise.all([
    countOf("list_printers"),
    countOf("list_templates"),
    countOf("list_jobs"),
    readSetting("retention_days").catch(() => null),
    share.getServiceUrl().catch(() => null),
  ]);
  let apiRunning: boolean | null = null;
  try {
    // Static command: typed. countOf above keeps the raw invoke on
    // purpose — its command name is dynamic.
    const status = await agent("get_api_status", {});
    apiRunning = status ? Boolean(status.running) : null;
  } catch {
    apiRunning = null;
  }
  const native = printers !== null || templates !== null || jobs !== null;
  return {
    printers,
    templates,
    jobs,
    shareConfigured: Boolean(url),
    apiRunning,
    // Retention and share can be read in the browser preview too.
    retentionReviewed: native || retention !== null ? retention !== null : null,
  };
}

export function SetupChecklist({
  onOpenSection,
}: {
  onOpenSection: (s: SettingsSection) => void;
}) {
  const [status, setStatus] = useState<ChecklistInput>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const { t } = useTranslation();

  useEffect(() => {
    let cancelled = false;
    loadStatus().then((s) => {
      if (!cancelled) {
        setStatus(s);
        setLoaded(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const items = buildChecklist(status, t);
  const sum = summarize(items);
  // Phones highlight the first required step still to do, so the next
  // action is obvious without reading the whole list.
  const nextIndex = loaded
    ? items.findIndex((i) => i.required && i.done === false)
    : -1;
  const percent =
    sum.requiredTotal > 0
      ? Math.round((sum.requiredDone / sum.requiredTotal) * 100)
      : 0;

  // Layout note: everything prefixed `max-md:` applies on phones only
  // (the app's phone query is max-width: 767px). From md up the classes
  // are the original ones, so tablets and desktops look as before.
  return (
    <Card className="max-md:overflow-hidden">
      <CardHeader className="max-md:px-4 max-md:pt-4">
        <CardTitle className="text-base">{t("checklist.title")}</CardTitle>
        <p role="status" className="text-sm text-muted-foreground">
          {!loaded
            ? t("checklist.checking")
            : sum.unknown
              ? t("checklist.browser_preview")
              : sum.complete
                ? t("checklist.all_done")
                : t("checklist.progress", {
                    done: sum.requiredDone,
                    total: sum.requiredTotal,
                  })}
        </p>
        {loaded && !sum.unknown && sum.requiredTotal > 0 && (
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={sum.requiredTotal}
            aria-valuenow={sum.requiredDone}
            className="!mt-3 h-1.5 overflow-hidden rounded-full bg-muted md:hidden"
          >
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${percent}%` }}
            />
          </div>
        )}
      </CardHeader>
      <CardContent className="max-md:px-0 max-md:pb-0">
        <ol className="divide-y rounded-md border max-md:rounded-none max-md:border-x-0 max-md:border-b-0">
          {items.map((item, index) => {
            const isNext = index === nextIndex;
            return (
              <li
                key={item.id}
                className={cn(
                  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 p-3 max-md:px-4 md:flex md:gap-4",
                  isNext && "max-md:bg-primary/5",
                  loaded && item.done === true && "max-md:opacity-75",
                )}
              >
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {item.title}
                    {!item.required && (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        {t("checklist.optional")}
                      </span>
                    )}
                  </p>
                  <p className="text-sm text-muted-foreground max-md:line-clamp-2">
                    {item.description}
                    {item.detail ? ` ${item.detail}.` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2 md:gap-3">
                  {loaded && item.done === true && (
                    <StatusBadge status="success" label={t("checklist.done")} />
                  )}
                  {loaded && item.done === false && item.required && (
                    <StatusBadge status="queued" label={t("checklist.todo")} />
                  )}
                  {loaded && item.done === null && (
                    <span className="text-xs text-muted-foreground">
                      {t("checklist.unchecked")}
                    </span>
                  )}
                  <RowAction
                    item={item}
                    isNext={isNext}
                    onOpenSection={onOpenSection}
                  />
                </div>
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}

/**
 * The row's action. On desktop it is the labelled outline button it
 * always was. On phones it shrinks to a chevron (the label stays in the
 * DOM for screen readers and for the accessible name), with a larger
 * touch target, and the next step to do gets the primary colour.
 */
function RowAction({
  item,
  isNext,
  onOpenSection,
}: {
  item: ChecklistItem;
  isNext: boolean;
  onOpenSection: (s: SettingsSection) => void;
}) {
  const className = cn(
    "max-md:h-10 max-md:w-10 max-md:px-0",
    isNext &&
      "max-md:border-primary max-md:bg-primary max-md:text-primary-foreground max-md:hover:bg-primary/90 max-md:hover:text-primary-foreground",
  );
  const content = (
    <>
      <span className="max-md:sr-only">{item.action}</span>
      <ChevronRight className="h-4 w-4 md:hidden" aria-hidden="true" />
    </>
  );
  if (item.target.kind === "page") {
    return (
      <Button asChild variant="outline" size="sm" className={className}>
        <Link to={item.target.path}>{content}</Link>
      </Button>
    );
  }
  return (
    <Button
      variant="outline"
      size="sm"
      className={className}
      onClick={() =>
        item.target.kind === "section" && onOpenSection(item.target.section)
      }
    >
      {content}
    </Button>
  );
}
