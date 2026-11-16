/**
 * Command-palette index for the Automation page and the controls that
 * moved with the old "phones" tab to the Devices page (`?field=`
 * deep links), mirroring `settingsSearch.ts`: individual controls, not
 * just the tabs.
 *
 * The tab type is declared here (and checked against the page's own list
 * in tests) so the shell library does not import a page.
 */
export type AutomationSearchTab = "server" | "explorer" | "links";

export interface AutomationSearchEntry {
  /** Automation tab that owns the control (default). */
  tab?: AutomationSearchTab;
  /** The control's own page, for controls outside the Automation tabs. */
  path?: string;
  /** i18n key of the section label shown beside the control. */
  sectionLabelKey?: string;
  /** DOM id scrolled to and flashed (drives `&field=`). */
  field: string;
  /** i18n key of the control's visible label. */
  labelKey: string;
  /** English, lowercase extra match terms (stable across UI languages). */
  keywords: string[];
  /** The control only renders on Android (hidden elsewhere). */
  androidOnly?: boolean;
}

/** Where a control's deep link goes (`?tab=&field=` or `?field=`). */
export function automationEntryTarget(entry: AutomationSearchEntry): string {
  return entry.path
    ? `${entry.path}?field=${entry.field}`
    : `/automation?tab=${entry.tab}&field=${entry.field}`;
}

/** One entry per tab, so "deep links" also finds the tab. */
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
    path: "/devices",
    sectionLabelKey: "nav.devices",
    field: "devices-share",
    labelKey: "settings_page.devices_provider_title",
    keywords: ["share", "phone", "pair", "render", "provider", "android"],
  },
  {
    path: "/devices",
    sectionLabelKey: "nav.devices",
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
