/** Pure helpers for the density and branding preferences (no React, easy to test). */

export type Density = "comfortable" | "compact";

/** The user's theme choice; "system" resolves against the OS preference. */
export type Theme = "light" | "dark" | "system";

export const DEFAULT_APP_NAME = "PrintNinja";
export const MAX_APP_NAME_LENGTH = 40;
export const MAX_LOGO_BYTES = 256 * 1024;
export const LOGO_TYPES = [
  "image/png",
  "image/jpeg",
  "image/svg+xml",
  "image/webp",
] as const;

export const SETTING_KEYS = {
  density: "ui_density",
  theme: "ui_theme",
  appName: "brand_name",
  logo: "brand_logo",
} as const;

export function parseDensity(value: string | null | undefined): Density {
  return value === "compact" ? "compact" : "comfortable";
}

/** Unknown or empty values fall back to the light default. */
export function parseTheme(value: string | null | undefined): Theme {
  return value === "dark" || value === "system" ? value : "light";
}

/** The concrete theme that goes on <html>: "system" follows the OS. */
export function resolveTheme(
  theme: Theme,
  systemIsDark: boolean,
): "light" | "dark" {
  return theme === "system" ? (systemIsDark ? "dark" : "light") : theme;
}

/** The OS dark-mode preference. False wherever matchMedia is unavailable. */
export function systemIsDark(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
    );
  } catch {
    return false;
  }
}

/** Trim, collapse whitespace, cap the length. Empty falls back to the default name. */
export function sanitizeAppName(value: string | null | undefined): string {
  const name = (value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_APP_NAME_LENGTH)
    .trim();
  return name || DEFAULT_APP_NAME;
}

/** Only image data URLs of the allowed types are accepted from storage. */
export function isValidLogoDataUrl(
  value: string | null | undefined,
): value is string {
  if (!value) return false;
  return /^data:image\/(png|jpeg|svg\+xml|webp);base64,[A-Za-z0-9+/=]+$/.test(
    value,
  );
}

export type LogoCheck =
  | { ok: true }
  | {
      ok: false;
      /** i18n key for the failure, rendered by the caller with t(). */
      messageKey: string;
      messageValues?: Record<string, string | number>;
    };

export function checkLogoFile(file: { type: string; size: number }): LogoCheck {
  if (!(LOGO_TYPES as readonly string[]).includes(file.type)) {
    return {
      ok: false,
      messageKey: "settings_page.appearance_logo_bad_type",
    };
  }
  if (file.size > MAX_LOGO_BYTES) {
    return {
      ok: false,
      messageKey: "settings_page.appearance_logo_too_big",
      messageValues: { kb: MAX_LOGO_BYTES / 1024 },
    };
  }
  return { ok: true };
}

export function windowTitle(appName: string): string {
  return appName;
}
