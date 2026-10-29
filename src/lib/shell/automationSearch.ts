/**
 * Command-palette index for the Automation page, mirroring
 * `settingsSearch.ts`: individual controls, not just the tabs. Selecting
 * an entry opens the tab and flashes the control (`?tab=&field=`).
 *
 * The tab type is declared here (and checked against the page's own list
 * in tests) so the shell library does not import a page.
 */
export type AutomationSearchTab = "server" | "explorer" | "phones" | "links";

export interface AutomationSearchEntry {
  tab: AutomationSearchTab;
  /** DOM id scrolled to and flashed (drives `&field=`). */
  field: string;
  /** i18n key of the control's visible label. */
  labelKey: string;
  /** English, lowercase extra match terms (stable across UI languages). */
  keywords: string[];
  /** The control only renders on Android (hidden elsewhere). */
  androidOnly?: boolean;
}

/** One entry per tab, so "phones" or "deep links" also finds the tab. */
export const AUTOMATION_TAB_ENTRIES: Array<{
  tab: AutomationSearchTab;
  labelKey: string;
  keywords: string[];
}> = [
  {
    tab: "server",
    labelKey: "automation.tab_server",
    keywords: ["api", "server", "local", "rest", "http"],
  },
  {
    tab: "explorer",
    labelKey: "automation.tab_explorer",
    keywords: ["api", "try", "explorer", "request", "endpoint", "openapi"],
  },
  {
    tab: "phones",
    labelKey: "automation.tab_phones",
    keywords: ["phones", "android", "pair", "pairing", "devices", "render"],
  },
  {
    tab: "links",
    labelKey: "automation.tab_links",
    keywords: ["deep link", "printninja://", "trusted", "confirmation"],
  },
];

export const AUTOMATION_SEARCH_ENTRIES: AutomationSearchEntry[] = [
  {
    tab: "server",
    field: "api-port",
    labelKey: "settings_page.api_port",
    keywords: ["api", "port", "server", "17717"],
  },
  {
    tab: "server",
    field: "lan-access",
    labelKey: "settings_page.api_lan",
    keywords: ["lan", "network", "expose", "bind", "0.0.0.0", "remote"],
  },
  {
    tab: "server",
    field: "api-autostart",
    labelKey: "settings_page.api_autostart",
    keywords: ["autostart", "start", "launch", "startup", "boot", "api"],
  },
  {
    tab: "phones",
    field: "devices-share",
    labelKey: "settings_page.devices_provider_title",
    keywords: ["share", "phone", "pair", "render", "provider", "android"],
  },
  {
    tab: "phones",
    field: "via-pc-switch",
    labelKey: "settings_page.via_pc_switch",
    keywords: ["print", "pc", "computer", "remote", "phone"],
    androidOnly: true,
  },
  {
    tab: "links",
    field: "trusted-source-input",
    labelKey: "automation.links_title",
    keywords: ["trusted", "deep link", "printninja://", "source", "skip"],
  },
];
