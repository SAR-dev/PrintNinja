import { useEffect } from "react";
import { useNavigate, type NavigateFunction } from "react-router-dom";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import i18n from "@/lib/i18n";
import { agent } from "@/lib/agent/commands";
import type { DeeplinkPrint, DeeplinkResult } from "@/lib/agent/types";
import { listTemplates } from "@/lib/templates/listTemplates";
import { usePrintStore } from "@/lib/store/printStore";
import { notifyError } from "@/lib/notify";
import { isNativeAvailable } from "@/lib/tauriGuard";

/**
 * `printninja://` deep links, frontend side (MISSING_FEATURES #42).
 *
 * Delivery, both platforms:
 * - Warm start — the OS hands the URL to the running app. On desktop the
 *   second instance's CLI args are re-parsed and forwarded to the first
 *   instance by single-instance's `deep-link` feature; on Android
 *   `onNewIntent` pushes the intent. Both surface as the
 *   `deep-link://new-url` event, which `onOpenUrl` below receives.
 * - Cold start — the native side learns the URL before the webview's JS
 *   is ready, so the event fires before anyone is listening.
 *   `getCurrent()` returns it once, at start-up.
 *
 * Dispatch: `parse_deeplink` turns the URL into an action (the same Rust
 * parser the e2e spec pins). `Open` and `Template` just navigate. `Print`
 * is prefill-only: the values land in the print store and the Print page
 * opens, so the person sees what will print and presses Print — that
 * press is the confirmation the README promises for untrusted sources,
 * and it applies to every source, because a link does not carry the
 * caller's identity.
 */

/** The store values a `print` link carries, plus the resolved row id. */
export type PendingDeepLinkPrint = DeeplinkPrint & {
  /** Resolved from the link's template NAME (names are unique in the app). */
  template_id: string | null;
};

/* ------------------------------------------------------------------ */
/* Pending-print slot                                                  */
/*                                                                     */
/* The link is dispatched before the Print page is mounted (navigate   */
/* first, page second), so the values are stashed here and the page    */
/* consumes them once, after its own load effects have run. A tiny     */
/* external store instead of module state + events: `useSyncExternal-  */
/* Store` gives the page a dependency to key its apply effect on.      */
/* ------------------------------------------------------------------ */

let pendingPrint: PendingDeepLinkPrint | null = null;
const pendingListeners = new Set<() => void>();

function emitPending() {
  for (const l of pendingListeners) l();
}

export function setPendingDeepLinkPrint(p: PendingDeepLinkPrint): void {
  pendingPrint = p;
  emitPending();
}

/** Read-and-clear. Returns `null` when nothing is waiting. */
export function takePendingDeepLinkPrint(): PendingDeepLinkPrint | null {
  const v = pendingPrint;
  if (pendingPrint === v) pendingPrint = null;
  emitPending();
  return v;
}

export function subscribePendingPrint(l: () => void): () => void {
  pendingListeners.add(l);
  return () => {
    pendingListeners.delete(l);
  };
}

export function getPendingPrint(): PendingDeepLinkPrint | null {
  return pendingPrint;
}

/* ------------------------------------------------------------------ */
/* Dispatch                                                            */
/* ------------------------------------------------------------------ */

/** Route prefixes `printninja://open/<dest>` may name. */
const OPEN_DESTINATIONS = new Set([
  "",
  "print",
  "printers",
  "templates",
  "history",
  "automation",
  "api-explorer",
  "pair",
  "settings",
]);

/** The print store's fit modes — anything else in a link is dropped. */
const FIT_MODES = [
  "actual",
  "fit-width",
  "fit-page",
  "shrink",
  "fill",
] as const;
type FitMode = (typeof FIT_MODES)[number];

/**
 * Dedupe delivered URLs. A link can arrive twice in one start-up — via
 * `getCurrent()` and via the `new-url` event racing each other — and the
 * in-memory set also covers the listener mounting twice. The
 * sessionStorage copy survives a webview reload within the same session
 * (the plugin's Android side does not clear its last URL, so a reloaded
 * webview would otherwise re-dispatch it from `getCurrent()`).
 */
const dispatchedThisRun = new Set<string>();
const DISPATCHED_STORAGE_KEY = "printninja-deeplink-dispatched";

function alreadyDispatched(url: string): boolean {
  if (dispatchedThisRun.has(url)) return true;
  try {
    const list = JSON.parse(
      sessionStorage.getItem(DISPATCHED_STORAGE_KEY) ?? "[]",
    ) as string[];
    return list.includes(url);
  } catch {
    return false;
  }
}

function markDispatched(url: string): void {
  dispatchedThisRun.add(url);
  try {
    const list = JSON.parse(
      sessionStorage.getItem(DISPATCHED_STORAGE_KEY) ?? "[]",
    ) as string[];
    if (!list.includes(url)) {
      list.push(url);
      // Bounded: only the recent few matter for the reload case.
      sessionStorage.setItem(
        DISPATCHED_STORAGE_KEY,
        JSON.stringify(list.slice(-20)),
      );
    }
  } catch {
    /* private mode: the in-memory set still covers this session */
  }
}

/**
 * Parse one delivered URL and act on it. Safe to call with duplicates —
 * a URL is dispatched at most once per session.
 */
export async function dispatchDeepLink(
  url: string,
  navigate: NavigateFunction,
): Promise<void> {
  if (!url || alreadyDispatched(url)) return;
  markDispatched(url);

  let action: DeeplinkResult;
  try {
    action = await agent("parse_deeplink", { url });
  } catch (e) {
    notifyError(
      i18n.t("deeplink.error_parse", {
        message: e instanceof Error ? e.message : String(e),
      }),
      { id: "deeplink-error" },
    );
    return;
  }

  if ("Open" in action) {
    const dest = action.Open;
    if (OPEN_DESTINATIONS.has(dest)) {
      navigate(dest === "" ? "/" : `/${dest}`);
    } else {
      notifyError(i18n.t("deeplink.error_unknown_destination", { dest }), {
        id: "deeplink-error",
      });
    }
    return;
  }

  if ("Template" in action) {
    navigate(`/template/${encodeURIComponent(action.Template)}`);
    return;
  }

  // Print: prefill the store, then go to the page that consumes it.
  const print = action.Print;
  let templateId: string | null = null;
  if (print.template) {
    // The link names the template; the store selects by row id.
    const rows = await listTemplates().catch((): [] => []);
    const row = rows.find((r) => r.name === print.template);
    if (row) {
      templateId = String(row.id);
    } else {
      notifyError(
        i18n.t("deeplink.error_unknown_template", { name: print.template }),
        { id: "deeplink-error" },
      );
    }
  }
  setPendingDeepLinkPrint({ ...print, template_id: templateId });
  navigate("/print");
}

/**
 * Stash a pending `print` link's values into the print store. Called
 * exactly once from the Print page, after its load effects — and after
 * the template-orientation effect — have run for this render, so it
 * wins over both (see the apply effect in PrintForm).
 */
export function applyPendingDeepLinkPrint(p: PendingDeepLinkPrint): void {
  const st = usePrintStore.getState();
  if (p.template_id) st.setTemplateId(p.template_id);
  if (p.printer) st.setPrinterId(p.printer);
  if (p.url) {
    st.setDataUrl(p.url);
    st.setUseTestData(false);
  }
  if (p.copies != null) st.setCopies(p.copies);
  if (p.orientation === "portrait" || p.orientation === "landscape")
    st.setOrientation(p.orientation);
  const fit = p.fit as FitMode | null;
  if (fit && FIT_MODES.includes(fit)) st.setFitMode(fit);
  if (p.page_range) st.setPageRange(p.page_range);
  if (p.grayscale != null) st.setGrayscale(p.grayscale);
  if (p.margin_top != null) st.setMarginTop(p.margin_top);
  if (p.margin_right != null) st.setMarginRight(p.margin_right);
  if (p.margin_bottom != null) st.setMarginBottom(p.margin_bottom);
  if (p.margin_left != null) st.setMarginLeft(p.margin_left);
  // `preset`, `test`, `confirm`, `callback` have no UI counterpart in the
  // prefill flow: the page IS the confirmation, and there is no preset,
  // test-data or callback selection to flip here.
}

/* ------------------------------------------------------------------ */
/* Listener                                                            */
/* ------------------------------------------------------------------ */

/**
 * Mounted inside the router. Subscribes to `deep-link://new-url` for the
 * app's whole lifetime and reads `getCurrent()` once for a cold start.
 * In e2e (fake agent) both are acknowledged stubs that resolve `null`,
 * so everything is best-effort and swallowed.
 */
export function DeepLinkListener() {
  const navigate = useNavigate();

  useEffect(() => {
    if (!isNativeAvailable()) return;
    void onOpenUrl((urls) => {
      for (const u of urls ?? [])
        if (typeof u === "string") void dispatchDeepLink(u, navigate);
    }).catch(() => {});
    void getCurrent()
      .then((urls) => {
        for (const u of urls ?? [])
          if (typeof u === "string") void dispatchDeepLink(u, navigate);
      })
      .catch(() => {});
  }, [navigate]);

  return null;
}
