import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Skeleton } from "@/components/ui/skeleton";

/** How long to wait before painting the skeleton, so a route that resolves
 *  fast never flashes a placeholder. */
const SKELETON_DELAY_MS = 150;

function useDelayed(ms: number): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setReady(true), ms);
    return () => window.clearTimeout(id);
  }, [ms]);
  return ready;
}

/**
 * The page-shaped placeholder shown while a lazy route chunk loads. It fills
 * the content area with a header block and a few card rows — enough to read
 * as "a page is on its way" instead of a bare spinner — and announces
 * "Loading" to screen readers. Nothing paints for the first 150ms, so a
 * quick load never flashes a skeleton.
 */
export function PageLoading() {
  const { t } = useTranslation();
  const ready = useDelayed(SKELETON_DELAY_MS);

  return (
    <div
      className="min-h-dvh-safe bg-background p-4 md:p-6"
      role="status"
      aria-busy="true"
    >
      <span className="sr-only">{t("common.loading")}</span>
      {ready && (
        <div className="mx-auto max-w-3xl space-y-6" aria-hidden="true">
          {/* Page header: title + subtitle */}
          <div className="space-y-2">
            <Skeleton className="h-7 w-48" />
            <Skeleton className="h-4 w-72" />
          </div>
          {/* Content: a few card rows */}
          <div className="space-y-3">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        </div>
      )}
    </div>
  );
}
