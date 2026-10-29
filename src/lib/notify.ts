/**
 * The one place that shows toasts (see "Toasts" in docs/UI_GUIDE.md).
 * Nothing else imports `sonner` directly — a guard test enforces it.
 *
 * House rules, so a toast means the same thing everywhere:
 * - success: 3 s, info: 4 s, error: stays until dismissed.
 * - `id` dedupes: a repeat replaces the earlier toast instead of
 *   stacking (loops must summarize first, then notify once).
 * - errors take an optional action (Retry, View, Undo) rather than a
 *   second toast explaining the first.
 */
import { toast } from "sonner";

export interface NotifyAction {
  label: string;
  onClick: () => void;
}

interface NotifyOptions {
  /** Repeat key: a new toast with the same id replaces the old one. */
  id?: string;
  /** Single action button (Retry, View, Undo, …). */
  action?: NotifyAction;
  /** Smaller second line under the message. */
  description?: string;
}

export function notifySuccess(message: string, opts?: NotifyOptions) {
  return toast.success(message, {
    duration: 3000,
    id: opts?.id,
    description: opts?.description,
    action: opts?.action,
  });
}

export function notifyInfo(message: string, opts?: NotifyOptions) {
  return toast.info(message, {
    duration: 4000,
    id: opts?.id,
    description: opts?.description,
    action: opts?.action,
  });
}

export function notifyError(
  message: string,
  opts?: NotifyOptions & { duration?: number },
) {
  return toast.error(message, {
    // Errors wait for the person: swipe, tap ✕, or tap the action.
    duration: opts?.duration ?? Number.POSITIVE_INFINITY,
    id: opts?.id,
    description: opts?.description,
    action: opts?.action,
  });
}

/** Dismiss one toast by the id its notify call returned, or all. */
export function dismissNotify(id?: string | number): void {
  if (id === undefined) toast.dismiss();
  else toast.dismiss(id);
}
