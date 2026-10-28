import { useEffect, useState } from "react";

/**
 * Manual update check (no auto-download, no Tauri updater): compare the
 * running app version against the latest forge Release and, when newer,
 * point the user at the release page to update by hand.
 */

/**
 * Where releases live. Any host answering `{tag_name, html_url}` on
 * `GET {api}/repos/{repo}/releases/latest` works, so only the base
 * changes, e.g. `VITE_UPDATE_API=https://ghe.example.com/api/v3` plus
 * `VITE_UPDATE_REPO=owner/PrintNinja` moves the badge off github.com.
 * The GitHub defaults keep existing installs and tests working untouched.
 */
export function buildUpdateCheckUrl(apiBase: string, repo: string): string {
  return `${apiBase.replace(/\/+$/, "")}/repos/${repo}/releases/latest`;
}

/** GitHub repo whose releases are the update source. */
const UPDATE_REPO = import.meta.env.VITE_UPDATE_REPO ?? "SAR-dev/PrintNinja";
const UPDATE_API = import.meta.env.VITE_UPDATE_API ?? "https://api.github.com";
const CHECK_URL = buildUpdateCheckUrl(UPDATE_API, UPDATE_REPO);
const CACHE_KEY = "printninja-update-check";
const FETCH_TIMEOUT_MS = 10_000;

export interface UpdateInfo {
  /** Normalised version without a leading v, e.g. "3.2.0". */
  version: string;
  /** Release page to open for a manual update. */
  url: string;
}

/** "v3.2.0" -> "3.2.0". */
export function normalizeVersion(v: string): string {
  return v.trim().replace(/^v/i, "");
}

/**
 * Current app version. Tauri builds read it from the bundle; web builds use
 * the package.json version baked in by vite (see vite.config.ts), so the
 * value always tracks what release.mjs bumps.
 */
export async function getAppVersion(): Promise<string> {
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    const v = await getVersion();
    if (typeof v === "string" && v.trim()) return normalizeVersion(v);
  } catch {
    // Web mode (or mocked Tauri): fall through to the baked version.
  }
  const baked =
    typeof __APP_VERSION__ === "string" && __APP_VERSION__
      ? __APP_VERSION__
      : "0.0.0";
  return normalizeVersion(baked);
}

/** True when `latest` is a strictly higher dotted version than `current`. */
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) =>
    normalizeVersion(v)
      .split(".")
      .map((p) => {
        const n = parseInt(p, 10);
        return Number.isNaN(n) ? 0 : n;
      });
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

interface CacheEntry extends UpdateInfo {
  checkedAt: number;
}

function readCache(): UpdateInfo | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw) as Partial<CacheEntry>;
    if (typeof entry.version !== "string" || typeof entry.url !== "string")
      return null;
    return { version: entry.version, url: entry.url };
  } catch {
    return null;
  }
}

function writeCache(info: UpdateInfo): void {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ ...info, checkedAt: Date.now() }),
    );
  } catch {
    // Storage full or private mode: the check just runs again next boot.
  }
}

/** Latest published release, or null when it cannot be determined. Never throws. */
export async function fetchLatestRelease(
  signal?: AbortSignal,
): Promise<UpdateInfo | null> {
  try {
    const res = await fetch(CHECK_URL, {
      signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      tag_name?: unknown;
      html_url?: unknown;
    };
    if (typeof body.tag_name !== "string" || typeof body.html_url !== "string")
      return null;
    return { version: normalizeVersion(body.tag_name), url: body.html_url };
  } catch {
    // Offline, DNS, CORS, timeout, abort: an update check never blocks the UI.
    return null;
  }
}

/**
 * Background update state for the topbar badge. Paints from the cache
 * instantly (if any), then always revalidates: the cache may name a
 * release that has since been superseded, and showing that older "next"
 * version instead of the newest one is exactly the staleness to avoid.
 * Failures stay silent and keep the cached paint as the offline fallback.
 */
export function useUpdateCheck(): {
  available: boolean;
  version: string;
  url: string;
} {
  const [info, setInfo] = useState<UpdateInfo | null>(() => readCache());

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    (async () => {
      const current = await getAppVersion();
      if (cancelled) return;
      // The app may have been updated since the cache was written.
      setInfo((prev) =>
        prev && !isNewer(prev.version, current) ? null : prev,
      );
      // No fresh-cache shortcut: a cached newer version may itself be
      // stale (a newer release published after the check ran). The fetch
      // is once per mount — the badge lives in the top bar, so that is
      // once per app start, far under the API rate limit.
      const latest = await fetchLatestRelease(controller.signal);
      clearTimeout(timer);
      if (cancelled || !latest) return;
      if (isNewer(latest.version, current)) {
        writeCache(latest);
        setInfo(latest);
      } else {
        setInfo(null);
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, []);

  return {
    available: info != null,
    version: info?.version ?? "",
    url: info?.url ?? "",
  };
}

/**
 * Open a URL outside the app. Tauri webviews do not open external anchors
 * on their own, so the opener plugin handles it there; browsers use a tab.
 * (Link opening only — this is not the Tauri updater.)
 */
export async function openExternalUrl(url: string): Promise<void> {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
