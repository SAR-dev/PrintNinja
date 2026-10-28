// The registry of every test id the suite uses (REFACTORING.md section
// 11, D24). Tests import from here and never write a literal id; the app
// side adopts these ids in the testids deliverable, enforced by
// src/test/testids.test.ts.
//
// data-testid is the primary locator; Playwright's default test-id
// attribute is already data-testid, so no configuration is needed.
export const testids = {
  /** The "cannot reach the server" screen of the sign-in gate. */
  gateUnreachable: "gate-unreachable",
  /** The sign-in form itself (server reachable, no live session). */
  signinForm: "signin-form",
  /** Server address field on the sign-in form. */
  authUrl: "auth-url",
  /** Handle field on the sign-in form. */
  authHandle: "auth-handle",
  /** Password field on the sign-in form. */
  authPassword: "auth-password",
  /** The application shell once the gate is open. */
  shellApp: "shell-app",
  /** The sync-state chip in the shell (one wrapper, badge inside varies). */
  syncChip: "sync-chip",
  /** Red topbar alert while the local API is exposed to the LAN. */
  lanIndicator: "lan-indicator",
  /** Green topbar badge while the local API serves loopback. */
  apiIndicator: "api-indicator",
  /** Banner over the content while open but offline. */
  offlineBanner: "offline-banner",
  /** Banner on Templates when rows are conflicted. */
  conflictBanner: "conflict-banner",
  /** Settings font row id (parameterized in the app). */
  fontRow: (id: number | string) => `font-row-${id}`,
  /** Prefix for "any font row" locators. */
  fontRowPrefix: "font-row-",
  /** The three-way conflict dialog (legacy conflicted rows on Templates). */
  conflictDialog: "conflict-dialog",
  /** Conflict dialog: keep pushing the local edits. */
  conflictKeepMine: "conflict-keep-mine",
  /** Conflict dialog: discard local edits for the server copy. */
  conflictTakeServer: "conflict-take-server",
  /** Conflict dialog: duplicate locally, then take the server copy. */
  conflictKeepBoth: "conflict-keep-both",
  /** Designer save-conflict dialog: the server copy moved since last save. */
  saveConflictDialog: "save-conflict-dialog",
  /** Save-conflict dialog: overwrite the server with the editor's copy. */
  saveConflictOverwrite: "save-conflict-overwrite",
  /** Save-conflict dialog: load the server copy into the editor. */
  saveConflictTakeServer: "save-conflict-take-server",
  /** Tailwind warnings panel in the designer. */
  classWarnings: "class-warnings",
  /** Designer toolbar: save the editor to the server. */
  designerSave: "designer-save",
  /** Designer sync bar: visibility switch (Public/Private). */
  templateVisibility: "template-visibility",
  /** Settings appearance: app name field. */
  settingsBrandName: "settings-brand-name",
  /** Settings appearance: density radio group. */
  settingsDensity: "settings-density",
  /** Settings appearance: logo upload button. */
  settingsLogoUpload: "settings-logo-upload",
  /** Automation → API server: port field (device-local, never syncs). */
  settingsApiPort: "settings-api-port",
  /** Automation → API server: the Android background/pinned-notification note. */
  settingsApiBackground: "settings-api-background",
  /** Settings background: launch at startup toggle. */
  settingsLaunchAtStartup: "settings-launch-at-startup",
  /** Settings background: start minimized toggle. */
  settingsStartMinimized: "settings-start-minimized",
  /** Settings background: minimize-to-tray toggle. */
  settingsMinimizeToTray: "settings-minimize-to-tray",
  /** Settings background: close-to-tray toggle. */
  settingsCloseToTray: "settings-close-to-tray",
  /** Settings background (Android only): battery exemption button. */
  settingsBatteryExemption: "settings-battery-exemption",
  /** Settings fonts: upload button. */
  settingsFontUpload: "settings-font-upload",
  /** Settings retention: open the full-reset confirmation. */
  settingsResetDatabase: "settings-reset-database",
  /** Top bar user badge: opens Settings → Profile. */
  topbarProfile: "topbar-profile",
  /** Phone More sheet: account row linking to Settings → Profile. */
  moreAccount: "more-account",
  /** Settings profile: signed-in handle and the sign-out button. */
  profileHandle: "profile-handle",
  profileSignOut: "profile-sign-out",
  /** Settings profile: change-password fields and submit. */
  settingsChangePasswordCurrent: "settings-change-password-current",
  settingsChangePasswordNew: "settings-change-password-new",
  settingsChangePasswordConfirm: "settings-change-password-confirm",
  settingsChangePasswordSubmit: "settings-change-password-submit",
  /** Automation → Try the API: live-spec version badge. */
  apiExplorerSpecVersion: "api-explorer-spec-version",
  /** Automation → Try the API: job-id field for per-job endpoints. */
  apiExplorerJobId: "api-explorer-job-id",
  /** Automation → Try the API: JSON body field for POST /v1/print. */
  apiExplorerBody: "api-explorer-body",
  /** Automation → Try the API: optional Idempotency-Key field. */
  apiExplorerIdempotency: "api-explorer-idempotency",
  /** Automation → Try the API: send the built request. */
  apiExplorerSend: "api-explorer-send",
  /** Automation → Try the API: pretty-printed response. */
  apiExplorerResponse: "api-explorer-response",
  /** Settings API: shared-rendering provider toggle. */
  devicesShareToggle: "devices-share-toggle",
  /** Settings API: pair row for a render provider (parameterized in the app). */
  devicesPair: (id: string) => `devices-pair-${id}`,
  /** Prefix for "any render-provider pair row" locators. */
  devicesPairPrefix: "devices-pair-",
  /** Settings API: test button for a render provider (parameterized in the app). */
  devicesPairTest: (id: string) => `devices-pair-test-${id}`,
  /** Settings API: remove button for a render provider (parameterized in the app). */
  devicesPairRemove: (id: string) => `devices-pair-remove-${id}`,
  /** Settings API (PC): one-tap "turn on Wi-Fi access" for phone pairing. */
  devicesLanEnable: "devices-lan-enable",
  /** Settings API (PC): open or close the pairing-code panel. */
  devicesPairPhone: "devices-pair-phone",
  /** Settings API (PC): the 8-character pairing code. */
  devicesPairingCode: "devices-pairing-code",
  /** Settings API (PC): countdown until the code expires. */
  devicesPairingCountdown: "devices-pairing-countdown",
  /** Settings API (PC): the address shown next to the code. */
  devicesPairingAddress: "devices-pairing-address",
  /** Settings API (PC): mint a fresh code. */
  devicesNewCode: "devices-new-code",
  /** Settings API (PC): paired-phones list. */
  devicesPairedList: "devices-paired-list",
  /** Settings API (PC): remove every paired phone. */
  devicesClearAll: "devices-clear-all",
  /** Settings API (PC): confirm removing every paired phone. */
  devicesClearConfirm: "devices-clear-confirm",
  /** Settings API (phone): 8-character code input. */
  devicesCodeInput: "devices-code-input",
  /** Settings API (phone): pair with the typed code. */
  devicesCodeSubmit: "devices-code-submit",
  /** Settings API (phone): collapsed manual-address section. */
  devicesAdvanced: "devices-advanced",
  /** Settings API (phone): manual PC-address field. */
  devicesAddrInput: "devices-addr-input",
  /** Settings API (phone): pair-again button for an unreachable pair. */
  devicesPairAgain: (id: string) => `devices-pair-again-${id}`,
} as const;
