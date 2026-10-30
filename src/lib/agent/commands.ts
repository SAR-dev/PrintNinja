import { invoke } from "@/lib/invoke";
import type {
  AddPrinterReq,
  ApiHttpResponse,
  ApiStatus,
  ApplyReport,
  ConflictedRow,
  DeeplinkResult,
  DirtyDatasetRow,
  DirtyFontRow,
  DirtyProfileRow,
  DirtyRow,
  DirtySettingRow,
  FontDownloadReport,
  FontRow,
  HistoryJob,
  PrintHtmlReq,
  PrinterRow,
  PrintResponse,
  ProfileRow,
  PairedDevice,
  PairingInvite,
  NewPairingInvite,
  PairingState,
  PeerCapabilities,
  PeerRenderArgs,
  PeerRenderResult,
  PcTemplatesResult,
  QueuedUseRow,
  RemotePrintArgs,
  RemotePrintResult,
  RemotePrintersResult,
  RenderPair,
  RenderShareStatus,
  ResetReport,
  SaveDatasetReq,
  SaveProfileReq,
  SyncStateRow,
  SyncedDatasetRow,
  SystemPrinterRow,
  TemplateRow,
  UploadFontReq,
} from "./types";

/**
 * The typed IPC surface (REFACTORING.md P18, Q11). Every Tauri command
 * the app calls is a key here with its args and result, so a renamed
 * command or a wrong payload fails the build instead of failing at
 * runtime. Thin wrappers give each call site a plain function.
 */

export interface CreateTemplateReq {
  name: string;
  page_w_mm?: number;
  page_h_mm?: number;
  orientation?: string;
  html?: string;
  css?: string;
  compiled_css?: string;
  compiled_key?: string;
  readme?: string;
  summary?: string;
  server_id?: string;
  sync_state?: string;
  kind?: string;
  owner_handle?: string | null;
  server_revision?: number;
  base_revision?: number;
}

/** Command name → [args, result]. Args are what goes after the name. */
export interface AgentCommands {
  // Templates
  list_templates: [{}, TemplateRow[]];
  get_template: [{ id: number }, TemplateRow];
  create_template: [{ req: CreateTemplateReq }, TemplateRow];
  update_template_meta: [
    {
      req: {
        id: number;
        name: string;
        page_w_mm: number;
        page_h_mm: number;
        summary?: string;
        html?: string;
        css?: string;
        compiled_css?: string;
        compiled_key?: string;
      };
    },
    TemplateRow,
  ];
  update_readme: [{ req: { id: number; readme: string } }, TemplateRow];
  update_template_origin: [
    { req: { id: number; origin: string; origin_owner?: string | null } },
    TemplateRow,
  ];
  delete_template: [{ id: number }, null];
  set_publish_info: [
    { req: { id: number; remote_id: string; published_at: string | null } },
    TemplateRow,
  ];
  clear_publish_info: [{ req: { id: number } }, TemplateRow];
  // Sync cache
  cache_apply_changes: [
    { changes: unknown[]; new_cursor: string },
    ApplyReport,
  ];
  cache_get_sync_state: [{}, SyncStateRow];
  cache_list_dirty: [{}, DirtyRow[]];
  cache_mark_pushed: [{ server_id: string; revision: number }, null];
  cache_mark_conflicted: [{ server_id: string }, null];
  cache_resolve_conflict: [
    {
      server_id: string;
      resolution: "mine" | "theirs";
      server_copy?: unknown;
      rebase_to?: number;
    },
    null,
  ];
  cache_queue_use: [{ server_id: string; delta: number }, number];
  cache_list_queued_uses: [{}, QueuedUseRow[]];
  cache_clear_account: [{}, number];
  reset_database: [{}, ResetReport];
  cache_list_tombstoned: [{}, string[]];
  cache_list_synced: [{}, string[]];
  cache_forget_template: [{ server_id: string }, boolean];
  cache_list_conflicted: [{}, ConflictedRow[]];
  // Settings
  get_setting: [{ key: string }, string | null];
  set_setting: [{ key: string; value: string }, null];
  get_trusted_sources: [{}, string[]];
  set_trusted_sources: [{ sources: string[] }, null];
  refresh_background: [{}, null];
  // Printers
  list_printers: [{}, PrinterRow[]];
  add_printer: [{ req: AddPrinterReq }, PrinterRow];
  update_printer: [{ id: number; req: AddPrinterReq }, PrinterRow];
  delete_printer: [{ id: number }, null];
  get_printer: [{ id: number }, PrinterRow];
  test_printer: [{ id: number }, null];
  enumerate_system_printers: [{}, SystemPrinterRow[]];
  discover_network_printers: [{ timeout_secs?: number }, SystemPrinterRow[]];
  // Printing
  print_html: [{ req: PrintHtmlReq }, PrintResponse];
  spike_test_print: [{}, PrintResponse];
  /** Print one job through a paired PC instead of the local pipeline. */
  remote_print: [{ args: RemotePrintArgs }, RemotePrintResult];
  /** The paired PC's printers (live, else the last good list). */
  remote_printers: [
    { pair_id?: string | null; refresh?: boolean | null },
    RemotePrintersResult,
  ];
  /** The paired PC's printable templates (live, else the last good list). */
  pc_templates: [
    { pair_id?: string | null; refresh?: boolean | null },
    PcTemplatesResult,
  ];
  // Fonts
  list_fonts: [{}, FontRow[]];
  upload_font: [UploadFontReq, FontRow];
  delete_font: [{ id: number }, null];
  cache_list_dirty_fonts: [{}, DirtyFontRow[]];
  cache_mark_font_pushed: [{ server_id: string; revision: number }, null];
  cache_list_tombstoned_fonts: [{}, string[]];
  cache_list_synced_fonts: [{}, string[]];
  cache_forget_font: [{ server_id: string }, boolean];
  cache_read_font_file: [{ server_id: string }, number[]];
  cache_download_pending_fonts: [{}, FontDownloadReport];
  // Datasets
  list_datasets: [{}, SyncedDatasetRow[]];
  save_dataset: [{ req: SaveDatasetReq }, SyncedDatasetRow];
  delete_dataset: [{ id: number }, null];
  cache_list_dirty_datasets: [{}, DirtyDatasetRow[]];
  cache_mark_dataset_pushed: [{ server_id: string; revision: number }, null];
  cache_list_tombstoned_datasets: [{}, string[]];
  cache_list_synced_datasets: [{}, string[]];
  cache_forget_dataset: [{ server_id: string }, boolean];
  // Profiles
  list_profiles: [
    { printer_id?: number | null; template_id?: number | null },
    ProfileRow[],
  ];
  save_profile: [{ req: SaveProfileReq }, ProfileRow];
  delete_profile: [{ id: number }, null];
  cache_list_dirty_profiles: [{}, DirtyProfileRow[]];
  cache_mark_profile_pushed: [{ server_id: string; revision: number }, null];
  cache_list_tombstoned_profiles: [{}, string[]];
  cache_list_synced_profiles: [{}, string[]];
  cache_forget_profile: [{ server_id: string }, boolean];
  // Account preferences
  cache_list_dirty_settings: [{}, DirtySettingRow[]];
  cache_mark_setting_pushed: [{ key: string }, null];
  cache_list_tombstoned_settings: [{}, string[]];
  cache_list_synced_settings: [{}, string[]];
  cache_forget_setting: [{ key: string }, boolean];
  // History and batches
  list_jobs: [{}, HistoryJob[]];
  get_job: [{ id: number }, HistoryJob];
  reprint_job: [{ id: number }, HistoryJob];
  retry_job: [{ id: number }, HistoryJob];
  delete_job: [{ id: number }, null];
  // Local API server (loopback by default, LAN only when enabled;
  // there is no key — binding is the entire security boundary)
  start_api_server: [{ port: number; lan_access: boolean }, string];
  stop_api_server: [{}, null];
  get_api_status: [{}, ApiStatus];
  // The Explorer's HTTP client. Requests go through Rust, not the WebView:
  // the page's fetch to 127.0.0.1 is cross-origin (no ACAO on a loopback
  // bind) and mixed content (Android refuses cleartext from https).
  api_request: [
    {
      method: string;
      url: string;
      headers?: Record<string, string>;
      body?: string;
    },
    ApiHttpResponse,
  ];
  // Shared rendering: this device as a render provider for a paired
  // device on the same LAN (see docs/ARCHITECTURE.md §9). Pairing is a
  // one-time 8-character code; each phone gets its own token.
  get_render_status: [{}, RenderShareStatus];
  set_render_sharing: [{ enabled: boolean }, string];
  /** Open a pairing window (90 s default); returns the code to show. */
  start_pairing: [{}, PairingState];
  /** Close the pairing window without claiming it. */
  cancel_pairing: [{}, null];
  /** The open window (code, seconds left, PC address). */
  get_pairing_state: [{}, PairingState];
  /** Phones paired with this PC. */
  list_paired_devices: [{}, PairedDevice[]];
  /** Remove one paired phone; its token fails from its next request. */
  revoke_paired_device: [{ id: string }, null];
  /** Remove every paired phone. Returns the rows removed. */
  clear_paired_devices: [{}, number];
  /** Rename a paired phone (empty clears the override). */
  rename_paired_device: [{ id: string; name: string }, PairedDevice];
  /** Allow or forbid printing for one paired phone. Render-only phones
   * keep rendering; the main routes refuse them. */
  set_paired_can_print: [{ id: string; can_print: boolean }, PairedDevice];
  /** Mint a guest invite code (shown once, never stored). */
  create_pairing_invite: [
    {
      expires_in_hours?: number | null;
      max_uses?: number | null;
      can_print?: boolean | null;
    },
    NewPairingInvite,
  ];
  /** Active and spent guest invites, newest first. No codes. */
  list_pairing_invites: [{}, PairingInvite[]];
  /** Delete an invite. Pairs it already minted keep their own expiry. */
  revoke_pairing_invite: [{ id: string }, null];
  /** Pair this phone with a PC using its 8-character code. */
  pair_with_code: [{ code: string; host?: string; port?: number }, RenderPair];
  // Shared rendering: this device as a consumer (buys renders).
  peer_capabilities: [
    { host: string; port: number; secret: string; name?: string },
    PeerCapabilities,
  ];
  peer_render_request: [{ req: PeerRenderArgs }, PeerRenderResult];
  // Misc
  ping: [{}, null];
  parse_deeplink: [{ url: string }, DeeplinkResult];
  /** Recent backend log text (size-rotated file), oldest first. Empty
   * when file logging never started. */
  read_app_logs: [{ max_kb?: number }, string];
}

type Args<K extends keyof AgentCommands> = AgentCommands[K][0];
type Result<K extends keyof AgentCommands> = AgentCommands[K][1];

/** One typed call to the local agent. Command names come from the table above. */
export function agent<K extends keyof AgentCommands>(
  cmd: K,
  args: Args<K> = {} as Args<K>,
): Promise<Result<K>> {
  return invoke(cmd as string, args as Record<string, unknown>) as Promise<
    Result<K>
  >;
}
