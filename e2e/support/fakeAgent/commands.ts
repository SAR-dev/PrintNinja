import { getSetting, seedPrinters, setSetting } from "./store.js";
import { createFakeCache, type SyncChangeIn } from "./cache.js";

// In-memory implementation of the IPC commands. Phase 1 implements the
// commands the sign-in and shell screens need; every other command the
// Rust backend offers is registered as an acknowledged stub (warn and
// null) so the agent contract test pins the full surface and drift is
// visible. Real behavior lands here with the screen that calls it,
// never ahead of it — the F-series specs prove each phase's behavior.
//
// The sync cache is the exception: one module holds the whole behavior
// so the shared cache_cases.json runs identically here and in Rust.

/**
 * Mirrors parse_deep_link in src-tauri/src/deeplink.rs: same actions,
 * same defaults (confirm unless 0/false, test only on 1/true, copies
 * parsed or dropped), same unknown-action error. Serde's externally
 * tagged enum shape is reproduced ({ Print: {...} } etc.) so specs
 * assert the exact wire the app would get.
 */
function parseDeepLink(url: string): unknown {
  const rest = url.startsWith("printninja://")
    ? url.slice("printninja://".length)
    : url;
  const queryIndex = rest.indexOf("?");
  const path = queryIndex === -1 ? rest : rest.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : rest.slice(queryIndex + 1);
  const params = new Map<string, string>();
  for (const pair of query.split("&")) {
    const equals = pair.indexOf("=");
    if (equals !== -1) {
      params.set(
        decodeQueryComponent(pair.slice(0, equals)),
        decodeQueryComponent(pair.slice(equals + 1)),
      );
    }
  }
  if (path === "print") {
    // Rust parses copies as u32: digits only, in range, else dropped.
    const copiesRaw = params.get("copies");
    const copiesNum =
      copiesRaw !== undefined && /^\d+$/.test(copiesRaw)
        ? Number.parseInt(copiesRaw, 10)
        : NaN;
    const testFlag = params.get("test");
    const confirmFlag = params.get("confirm");
    return {
      Print: {
        preset: params.get("preset") ?? null,
        template: params.get("template") ?? null,
        printer: params.get("printer") ?? null,
        url: params.get("url") ?? null,
        copies:
          Number.isInteger(copiesNum) && copiesNum <= 4294967295
            ? copiesNum
            : null,
        orientation: params.get("orientation") ?? null,
        fit: params.get("fit") ?? null,
        test: testFlag === "1" || testFlag === "true",
        confirm: !(confirmFlag === "0" || confirmFlag === "false"),
        callback: params.get("callback") ?? null,
      },
    };
  }
  if (path.startsWith("open/")) {
    return { Open: path.slice("open/".length) };
  }
  if (path.startsWith("template/")) {
    return { Template: path.slice("template/".length) };
  }
  throw new Error(`Unknown deep link action: ${path}`);
}

function decodeQueryComponent(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s.replace(/\+/g, " ");
  }
}

const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Mirrors normalize/valid_format in src-tauri/src/api/pair_code.rs. */
function normalizePairingCode(raw: string): string {
  return raw.toUpperCase().replace(/\s/g, "");
}

function validPairingCode(code: string): boolean {
  return (
    code.length === 8 &&
    code.split("").every((c) => PAIRING_ALPHABET.includes(c))
  );
}

type Handler = (args: Record<string, unknown>) => unknown;

// One cache per browser context (module scope = the injected page).
const cache = createFakeCache();

// Printers are snapshotted at bundle evaluation, when the one-shot
// seed is still present (index.ts consumes it after every module has
// evaluated). Unit tests that seed after importing get nothing from
// the snapshot, so enumerate also merges a live read — empty in the
// browser, since the key is already consumed there.
const seededPrinters = seedPrinters();
function allSeededPrinters(): Array<Record<string, unknown>> {
  const live = seedPrinters().filter(
    (p) => !seededPrinters.some((s) => s["name"] === p["name"]),
  );
  return [...seededPrinters, ...live];
}

const implemented: Record<string, Handler> = {
  get_setting: (args) => getSetting(String(args.key ?? "")),
  set_setting: (args) => {
    const value = args.value;
    const key = String(args.key ?? "");
    setSetting(key, typeof value === "string" ? value : null);
    // Mirror Rust: account keys go dirty (or tombstoned when reset);
    // device keys never leave the PC.
    cache.library.markSettingDirty(key, typeof value === "string" ? value : "");
    return null;
  },
  reset_database: () => {
    return cache.resetDatabase();
  },
  ping: () => null,
  // Backend log tail for the Diagnostics viewer/download. The real agent
  // reads the size-rotated file; here a canned two-liner proves the
  // plumbing without touching the disk.
  read_app_logs: () =>
    "2026-01-01T00:00:00Z  INFO printninja_lib: fake agent log line one\n2026-01-01T00:00:00Z  INFO printninja_lib: fake agent log line two\n",
  // Phone side of pairing: the 8-character code flow. The fake agent
  // accepts the well-known e2e code and mints a canned pair; anything
  // else is a wrong code. The subnet probe is Rust-only.
  pair_with_code: (args) => {
    const code = normalizePairingCode(String(args["code"] ?? ""));
    if (!validPairingCode(code)) {
      throw new Error("Enter the 8-character code shown on the PC.");
    }
    if (code !== "K7QM4XPD") {
      throw new Error("Wrong code (4 tries left). Check the PC and try again.");
    }
    return {
      id: "e2e-provider",
      name: "Studio PC",
      host: "192.168.1.9",
      port: 17717,
      secret: "e2e-token",
      fingerprint: "",
      provider_id: "e2e-provider",
      platform: "linux",
      paired_at: new Date().toISOString(),
      device_id: "e2e-phone",
    };
  },
  start_pairing: () => ({
    open: true,
    code: "K7QM4XPD",
    expires_in: 30,
    host: "192.168.1.9",
    port: 17717,
  }),
  cancel_pairing: () => null,
  get_pairing_state: () => ({
    open: false,
    code: "",
    expires_in: 0,
    host: "192.168.1.9",
    port: 17717,
  }),
  list_paired_devices: () => [],
  revoke_paired_device: () => null,
  clear_paired_devices: () => 0,
  rename_paired_device: (args) => ({
    id: String(args["id"] ?? ""),
    name: "Phone",
    display_name: String(args["name"] ?? ""),
    platform: "android",
    paired_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    can_print: true,
    account_id: "user-1",
    role: "owner",
    expires_at: null,
  }),
  set_paired_can_print: (args) => ({
    id: String(args["id"] ?? ""),
    name: "Phone",
    display_name: null,
    platform: "android",
    paired_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    can_print: Boolean(args["can_print"] ?? true),
    account_id: "user-1",
    role: "owner",
    expires_at: null,
  }),
  // Print via PC: the dialog round-trips in the browser against this
  // canned PC. The real POST/poll/history path is covered in Rust
  // (remote_print round-trips against a live loopback PC).
  remote_printers: () => ({
    printers: [{ name: "PC Printer", printer_type: "ipp", language: "pdf" }],
    cached: false,
  }),
  pc_templates: () => ({
    templates: [
      { name: "PC Receipt", server_id: "srv-pc-1", server_revision: 3 },
    ],
    cached: false,
  }),
  remote_print: () => ({
    success: true,
    status: "success",
    pc_job_id: "7",
    duration_ms: 12,
    error: null,
    code: null,
    pc_name: "Studio PC",
  }),
  create_pairing_invite: () => ({
    id: "inv-1",
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    uses_left: null,
    can_print: true,
    created_at: new Date().toISOString(),
    created_by: "user-1",
    code: "12345678",
  }),
  list_pairing_invites: () => [],
  revoke_pairing_invite: () => null,
  // Canned provider for the Devices UI "test" button: proves the pairing
  // form round-trips in the browser. Real capability/render behavior is
  // covered by the Rust suites (api_routes.rs, peer_consume.rs).
  peer_capabilities: () => ({
    protocol: 1,
    can_render: true,
    score: 800,
    cores: 8,
    platform: "linux",
    max_concurrent_renders: 2,
  }),
  enumerate_system_printers: () =>
    allSeededPrinters().map((p, i) => ({
      id: `printer-${i + 1}`,
      name: String(p["name"] ?? `E2E Printer ${i + 1}`),
      address: String(p["address"] ?? "usb:e2e"),
      printer_type: String(p["printer_type"] ?? "label"),
      language: String(p["language"] ?? "zpl"),
      status: "idle",
    })),
  cache_apply_changes: (args) =>
    cache.applyChanges(
      (args["changes"] as SyncChangeIn[] | undefined) ?? [],
      String(args["new_cursor"] ?? ""),
    ),
  cache_get_sync_state: () => cache.getSyncState(),
  cache_list_dirty: () => cache.listDirty(),
  cache_mark_pushed: (args) => {
    cache.markPushed(
      String(args["server_id"] ?? ""),
      Number(args["revision"] ?? 0),
    );
    return null;
  },
  cache_mark_conflicted: (args) => {
    cache.markConflicted(String(args["server_id"] ?? ""));
    return null;
  },
  cache_resolve_conflict: (args) => {
    const resolution = args["resolution"];
    if (resolution !== "theirs" && resolution !== "mine") {
      throw new Error(`unknown resolution: ${String(resolution)}`);
    }
    cache.resolveConflict(
      String(args["server_id"] ?? ""),
      resolution,
      args["server_copy"] as Record<string, unknown> | undefined,
      args["rebase_to"] === undefined ? undefined : Number(args["rebase_to"]),
    );
    return null;
  },
  cache_queue_use: (args) => {
    return cache.queueUse(
      String(args["server_id"] ?? ""),
      Number(args["delta"] ?? 0),
    );
  },
  cache_list_queued_uses: () => cache.listQueuedUses(),
  cache_clear_account: () => cache.clearAccount(),
  cache_list_tombstoned: () => cache.listTombstoned(),
  cache_list_synced: () => cache.listSynced(),
  cache_forget_template: (args) => {
    return cache.forgetTemplate(String(args["server_id"] ?? ""));
  },
  cache_list_conflicted: () => cache.listConflicted(),
  // Template reads/writes over the same cache rows (dirty-write rules
  // mirror the Rust commands; tombstones stay hidden from lists).
  list_templates: () => cache.listTemplates(),
  get_template: (args) => cache.getTemplate(Number(args["id"] ?? 0)),
  set_publish_info: (args) => {
    const req = (args["req"] ?? args) as Record<string, unknown>;
    cache.setPublishInfo(
      Number(req["id"] ?? 0),
      String(req["remote_id"] ?? ""),
      (req["published_at"] as string | null) ?? null,
    );
    return cache.getTemplate(Number(req["id"] ?? 0));
  },
  create_template: (args) => {
    const req = (args["req"] ?? args) as Record<string, unknown>;
    const row = cache.createTemplate(req);
    return cache.listTemplates().find((t) => t["id"] === row.id);
  },
  update_template_meta: (args) => {
    const req = (args["req"] ?? args) as Record<string, unknown>;
    cache.updateTemplateMeta(Number(req["id"] ?? 0), req);
    return cache
      .listTemplates()
      .find((t) => t["id"] === Number(req["id"] ?? 0));
  },
  update_readme: (args) => {
    const req = (args["req"] ?? args) as Record<string, unknown>;
    cache.updateReadme(Number(req["id"] ?? 0), String(req["readme"] ?? ""));
    return cache
      .listTemplates()
      .find((t) => t["id"] === Number(req["id"] ?? 0));
  },
  list_versions: (args) => cache.listVersions(Number(args["template_id"] ?? 0)),
  list_latest_versions: (args) =>
    cache.listLatestVersions(
      Array.isArray(args["template_ids"])
        ? (args["template_ids"] as unknown[]).map(Number)
        : [],
    ),
  create_version: (args) => {
    const req = (args["req"] ?? args) as Record<string, unknown>;
    return cache.createVersion(Number(req["template_id"] ?? 0), req);
  },
  set_version_compiled: (args) =>
    cache.setVersionCompiled(
      Number(args["id"] ?? 0),
      String(args["compiled_css"] ?? ""),
      String(args["compiled_key"] ?? ""),
    ),
  delete_template: (args) => {
    cache.deleteTemplate(Number(args["id"] ?? 0));
    return null;
  },
  update_template_origin: (args) => {
    const req = (args["req"] ?? args) as Record<string, unknown>;
    cache.updateTemplateOrigin(Number(req["id"] ?? 0), req);
    return cache
      .listTemplates()
      .find((t) => t["id"] === Number(req["id"] ?? 0));
  },
  // Printers are device-local rows (never synced); profiles resolve
  // them by current name, so renames and deletes leave dormancy.
  list_printers: () => cache.library.listPrinters(),
  // The e2e browser has no print engine to be missing.
  get_render_engine_status: () => ({
    platform: "other",
    available: true,
    path: null,
    searched: [],
    distro: [],
    distro_name: null,
    appimage: false,
  }),
  add_printer: (args) => {
    const req = (args["req"] ?? args) as Record<string, unknown>;
    return cache.library.addPrinter({
      name: String(req["name"] ?? "Printer"),
      printer_type:
        req["printer_type"] === undefined
          ? undefined
          : String(req["printer_type"]),
      address:
        req["address"] === undefined ? undefined : String(req["address"]),
      language:
        req["language"] === undefined ? undefined : String(req["language"]),
    });
  },
  update_printer: (args) => {
    const req = (args["req"] ?? args) as Record<string, unknown>;
    return cache.library.updatePrinter(Number(args["id"] ?? NaN), {
      name: String(req["name"] ?? ""),
      printer_type: String(req["printer_type"] ?? ""),
      address: String(req["address"] ?? ""),
      language: String(req["language"] ?? ""),
    });
  },
  delete_printer: (args) => {
    cache.library.deletePrinter(Number(args["id"] ?? 0));
    return null;
  },
  get_printer: (args) => {
    const row = cache.library
      .listPrinters()
      .find((p) => p.id === Number(args["id"] ?? 0));
    if (!row) throw new Error(`Printer ${String(args["id"])} not found`);
    return row;
  },
  // Sample datasets: the Designer's panel persists through these.
  list_datasets: () =>
    cache.library
      .listDatasets()
      .map((r) => ({ ...r, created_at: r.updated_at })),
  save_dataset: (args) => {
    const req = (args["req"] ?? args) as Record<string, unknown>;
    const row = cache.library.saveDataset({
      id:
        req["id"] === undefined || req["id"] === null
          ? null
          : Number(req["id"]),
      name: String(req["name"] ?? ""),
      data_json: String(req["data_json"] ?? "{}"),
    });
    return { ...row, created_at: row.updated_at };
  },
  delete_dataset: (args) => {
    cache.library.deleteDataset(Number(args["id"] ?? 0));
    return null;
  },
  cache_list_dirty_datasets: () => cache.library.listDirtyDatasets(),
  cache_mark_dataset_pushed: (args) => {
    cache.library.markDatasetPushed(
      String(args["server_id"] ?? ""),
      Number(args["revision"] ?? 0),
    );
    return null;
  },
  cache_list_tombstoned_datasets: () => cache.library.listTombstonedDatasets(),
  cache_list_synced_datasets: () => cache.library.listSyncedDatasets(),
  cache_forget_dataset: (args) =>
    cache.library.forgetDataset(String(args["server_id"] ?? "")),
  // Printer profiles, keyed by template and printer name on the wire.
  list_profiles: (args) =>
    cache.library
      .listProfiles({
        printer_id:
          args["printer_id"] === undefined || args["printer_id"] === null
            ? null
            : Number(args["printer_id"]),
        template_id:
          args["template_id"] === undefined || args["template_id"] === null
            ? null
            : Number(args["template_id"]),
      })
      .map((r) => ({ ...r, created_at: r.updated_at })),
  save_profile: (args) => {
    const req = (args["req"] ?? args) as Record<string, unknown>;
    const row = cache.library.saveProfile({
      printer_id: Number(req["printer_id"] ?? 0),
      template_id: Number(req["template_id"] ?? 0),
      settings_json: String(req["settings_json"] ?? "{}"),
    });
    return { ...row, created_at: row.updated_at };
  },
  delete_profile: (args) => {
    cache.library.deleteProfile(Number(args["id"] ?? 0));
    return null;
  },
  cache_list_dirty_profiles: () => cache.library.listDirtyProfiles(),
  cache_mark_profile_pushed: (args) => {
    cache.library.markProfilePushed(
      String(args["server_id"] ?? ""),
      Number(args["revision"] ?? 0),
    );
    return null;
  },
  cache_list_tombstoned_profiles: () => cache.library.listTombstonedProfiles(),
  cache_list_synced_profiles: () => cache.library.listSyncedProfiles(),
  cache_forget_profile: (args) =>
    cache.library.forgetProfile(String(args["server_id"] ?? "")),
  discover_network_printers: () => [],
  discover_network_printers_mdns: () => [],
  discover_peers_mdns: () => [],
  // Fonts: metadata plus in-memory bytes (test files are tiny).
  list_fonts: () =>
    cache.library.listFonts().map((r) => ({
      id: r.id,
      family: r.family,
      style: "normal",
      weight: "400",
      file_path: "",
      format: r.format,
      created_at: r.updated_at,
      server_id: r.server_id,
      sync_state: r.sync_state,
      sha256: r.sha256,
      size_bytes: r.size_bytes,
      state: r.state,
    })),
  upload_font: (args) =>
    cache.library.uploadFont({
      file_name: String(args["file_name"] ?? ""),
      file_data: (args["file_data"] as number[] | undefined) ?? [],
      family: (args["family"] as string | null | undefined) ?? null,
    }),
  delete_font: (args) => {
    cache.library.deleteFont(Number(args["id"] ?? 0));
    return null;
  },
  cache_list_dirty_fonts: () => cache.library.listDirtyFonts(),
  cache_mark_font_pushed: (args) => {
    cache.library.markFontPushed(
      String(args["server_id"] ?? ""),
      Number(args["revision"] ?? 0),
    );
    return null;
  },
  cache_list_tombstoned_fonts: () => cache.library.listTombstonedFonts(),
  cache_list_synced_fonts: () => cache.library.listSyncedFonts(),
  cache_forget_font: (args) =>
    cache.library.forgetFont(String(args["server_id"] ?? "")),
  cache_read_font_file: (args) =>
    cache.library.readFontFile(String(args["server_id"] ?? "")),
  cache_download_pending_fonts: () => cache.library.downloadPendingFonts(),
  // Account preferences: the allow-list syncs, device keys never do.
  cache_list_dirty_settings: () => cache.library.listDirtySettings(),
  cache_mark_setting_pushed: (args) => {
    cache.library.markSettingPushed(String(args["key"] ?? ""));
    return null;
  },
  cache_list_tombstoned_settings: () => cache.library.listTombstonedSettings(),
  cache_list_synced_settings: () => cache.library.listSyncedSettings(),
  cache_forget_setting: (args) =>
    cache.library.forgetSetting(String(args["key"] ?? "")),
};

/** Every Rust command without real behavior yet (src-tauri/src/lib.rs).
 * Keep this list in sync with generate_handler! — the contract test
 * fails when a Rust command is neither implemented nor acknowledged. */
const acknowledgedStubs: string[] = [
  "test_printer",
  "clear_publish_info",
  "list_jobs",
  "get_job",
  "reprint_job",
  "retry_job",
  "delete_job",
  "get_trusted_sources",
  "set_trusted_sources",
  "print_html",
  "spike_test_print",
  "delete_version",
  "restore_version",
  "diff_versions",
  "start_api_server",
  "stop_api_server",
  "get_api_status",
  // Loopback HTTP client: no local API server stands behind the fake
  // agent, so the explorer's calls have nothing to reach in the browser.
  "api_request",
  // Render-sharing provider (the PC half of Settings → Devices): the
  // pairing window and device registry live in Rust, so the browser only
  // acknowledges the sharing toggle and the contract test pins the rest.
  "get_render_status",
  "set_render_sharing",
  // Render-sharing consumer: the Devices UI "test" button works in e2e
  // against this canned provider; the pipeline path is covered in Rust.
  "peer_render_request",
  "refresh_background",
  // mDNS discovery is implemented above
];

const commands: Record<string, Handler> = {
  ...implemented,
  parse_deeplink: (args) => parseDeepLink(String(args["url"] ?? "")),
};
for (const name of acknowledgedStubs) {
  commands[name] = () => {
    console.warn(`[fake-agent] ${name} has no behavior yet (Phase 1 stub)`);
    return null;
  };
}

export function commandNames(): string[] {
  return Object.keys(commands);
}

export function handleCommand(cmd: string, args: unknown): unknown {
  const handler = commands[cmd];
  if (!handler) {
    console.warn("[fake-agent] unhandled command", cmd, args);
    return null;
  }
  const record =
    typeof args === "object" && args !== null
      ? (args as Record<string, unknown>)
      : {};
  return handler(record);
}
