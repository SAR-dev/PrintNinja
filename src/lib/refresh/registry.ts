import { describeError } from "@/lib/errors";
import { isSignedIn } from "@/lib/share/client";
import type { RefreshOutcome } from "@/lib/sync/scheduler";
import { cacheNow } from "@/lib/sync/useSyncStatus";

export type PartStatus = "succeeded" | "failed" | "skipped";

export interface RefreshPartResult {
  id: string;
  label: string;
  status: PartStatus;
  /** The failure, or why the part declined to run. */
  detail: string | null;
}

export interface RefreshAllResult {
  /** The server cache sync; `attempted` is false when signed out. */
  core: RefreshOutcome & { attempted: boolean };
  /** Every registered page part, in registration order. */
  parts: RefreshPartResult[];
}

export interface RefreshPart {
  id: string;
  /** Display name for toasts ("Templates", "Printers", …). */
  label: () => string;
  run: () => Promise<void> | void;
  /** A part may decline with a message instead of dialing a network it
   *  cannot use (e.g. the local network permission is off on Android). */
  skipReason?: () => string | null;
  /** A part may not apply at all right now (Print via PC is off); it is
   *  skipped silently, without a message. */
  active?: () => boolean;
}

const parts = new Map<string, RefreshPart>();

/**
 * Register a page (or one part of a page) with the shared manual refresh.
 * Returns the unregister function — `useRefreshable` wraps this for a
 * component's lifetime, so pages only participate while on screen.
 */
export function registerRefreshable(part: RefreshPart): () => void {
  parts.set(part.id, part);
  return () => {
    if (parts.get(part.id) === part) parts.delete(part.id);
  };
}

/**
 * One manual refresh: the server cache sync first (only when signed in —
 * a signed-out pull would just earn 401 backoff), then every registered
 * part in parallel. A part's failure never blocks the others, and a part
 * may skip with a reason instead of failing.
 */
export async function refreshAll(opts?: {
  force?: boolean;
}): Promise<RefreshAllResult> {
  const signedIn = await isSignedIn().catch(() => false);
  const core: RefreshAllResult["core"] = signedIn
    ? { ...(await cacheNow({ force: opts?.force ?? true })), attempted: true }
    : { ok: true, error: null, attempted: false };

  const partsResult = (
    await Promise.all(
      [...parts.values()].map(async (p): Promise<RefreshPartResult | null> => {
        if (p.active && !p.active()) return null;
        const label = p.label();
        const skip = p.skipReason?.();
        if (skip) {
          return { id: p.id, label, status: "skipped", detail: skip };
        }
        try {
          await p.run();
          return { id: p.id, label, status: "succeeded", detail: null };
        } catch (e) {
          return {
            id: p.id,
            label,
            status: "failed",
            detail: describeError(e),
          };
        }
      }),
    )
  ).filter((p): p is RefreshPartResult => p !== null);

  return { core, parts: partsResult };
}

/** Reset for tests. */
export function _clearRefreshables(): void {
  parts.clear();
}
