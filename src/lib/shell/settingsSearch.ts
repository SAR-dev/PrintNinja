import type { SettingsSection } from "@/lib/setup/checklist";

/**
 * Deep search index for the command palette: individual Settings
 * controls, not just the section titles. Selecting an entry opens the
 * section and flashes the control (`?section=&field=`).
 */
export interface SettingSearchEntry {
  /** Tab the control lives on (drives `?section=`). */
  section: SettingsSection;
  /** DOM id scrolled to and flashed (drives `&field=`). */
  field: string;
  /** i18n key of the control's visible label. */
  labelKey: string;
  /**
   * Extra match terms. English and lowercase: cmdk matches value and
   * keywords case-insensitively, and keywords stay stable when the UI
   * language changes.
   */
  keywords: string[];
}

export const SETTING_SEARCH_ENTRIES: SettingSearchEntry[] = [
  {
    section: "general",
    field: "settings-language",
    labelKey: "settings_page.appearance_language",
    keywords: ["language", "locale", "english", "japanese"],
  },
  {
    section: "general",
    field: "settings-density",
    labelKey: "settings_page.appearance_density",
    keywords: ["density", "comfortable", "compact", "spacing"],
  },
  {
    section: "general",
    field: "brand-name",
    labelKey: "settings_page.appearance_app_name",
    keywords: ["brand", "name", "title", "app name"],
  },
  {
    section: "general",
    field: "settings-logo-upload",
    labelKey: "settings_page.appearance_logo",
    keywords: ["logo", "icon", "branding", "image", "picture"],
  },
  {
    section: "general",
    field: "settings-font-upload",
    labelKey: "settings_page.font_upload",
    keywords: ["font", "fonts", "typeface", "ttf", "otf", "woff"],
  },
  {
    section: "background",
    field: "launch-at-startup",
    labelKey: "settings_page.background_launch",
    keywords: ["launch", "startup", "boot", "autostart", "login"],
  },
  {
    section: "background",
    field: "start-minimized",
    labelKey: "settings_page.background_minimized",
    keywords: ["minimized", "minimize", "hidden", "tray"],
  },
  {
    section: "background",
    field: "minimize-to-tray",
    labelKey: "settings_page.background_minimize_tray",
    keywords: ["tray", "minimize"],
  },
  {
    section: "background",
    field: "close-to-tray",
    labelKey: "settings_page.background_close_tray",
    keywords: ["close", "tray", "quit", "exit"],
  },
  {
    section: "share",
    field: "share-url",
    labelKey: "settings_page.share_url",
    keywords: [
      "server",
      "url",
      "address",
      "service",
      "share",
      "self-host",
      "host",
    ],
  },
  {
    section: "share",
    field: "share-handle",
    labelKey: "settings_page.share_signin_title",
    keywords: ["sign in", "login", "register", "account", "password"],
  },
  {
    section: "data",
    field: "allowed-domains",
    labelKey: "settings_page.allowed_domains",
    keywords: ["domains", "allowed", "network", "lan", "data"],
  },
  {
    section: "data",
    field: "block-private",
    labelKey: "settings_page.block_private",
    keywords: ["private", "block", "security", "ip", "lan"],
  },
  {
    section: "retention",
    field: "retention-days",
    labelKey: "settings_page.retention_days",
    keywords: ["retention", "history", "days", "cleanup", "delete"],
  },
  {
    section: "retention",
    field: "max-records",
    labelKey: "settings_page.max_records",
    keywords: ["records", "max", "limit", "history", "storage"],
  },
  {
    section: "retention",
    field: "settings-reset-database",
    labelKey: "settings_page.reset_title",
    keywords: ["reset", "wipe", "erase", "database", "fresh", "factory"],
  },
  {
    section: "diagnostics",
    field: "settings-diag-export",
    labelKey: "settings_page.diag_export",
    keywords: [
      "diagnostics",
      "export",
      "download",
      "debug",
      "report",
      "support",
    ],
  },
  {
    section: "profile",
    field: "settings-change-password",
    labelKey: "settings_page.change_password_title",
    keywords: ["password", "change", "credentials", "account"],
  },
  {
    section: "profile",
    field: "profile-sign-out",
    labelKey: "settings_page.share_sign_out",
    keywords: ["sign out", "logout", "log out", "exit"],
  },
];
