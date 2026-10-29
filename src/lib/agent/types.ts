/**
 * Canonical IPC row shapes (REFACTORING.md P18). These mirror the Rust
 * structs in src-tauri/src/commands/ field for field — one definition
 * instead of a copy per screen — and the fake agent speaks them too.
 * Server data is NOT here: that comes from the generated OpenAPI types
 * in src/lib/api/schema.d.ts.
 */

export interface TemplateRow {
  id: number;
  name: string;
  page_w_mm: number;
  page_h_mm: number;
  orientation: string;
  html: string;
  css: string;
  compiled_css: string;
  compiled_key: string;
  readme: string;
  summary: string;
  remote_id: string | null;
  /** The sync identity; the only id pushes may use. */
  server_id: string | null;
  published_at: string | null;
  origin: string;
  origin_owner: string | null;
  withdrawn: boolean;
  /** The server revision this copy was last synced at. Saves send it as
   * a guard; null means the server has never seen this row. */
  base_revision: number | null;
  /** `synced` | `dirty` | `deleted_pending` | `conflict`. A `dirty`
   * row is a draft: edits not yet saved to the server. */
  sync_state: string;
  created_at: string;
  updated_at: string;
}

export interface DirtyRow {
  id: number;
  server_id: string | null;
  name: string;
  summary: string;
  page_w_mm: number;
  page_h_mm: number;
  readme: string;
  html: string;
  css: string;
  base_revision: number | null;
}

export interface SystemPrinterRow {
  id: string;
  name: string;
  address: string;
  printer_type: string;
  language: string;
  status?: string;
}

export interface SyncStateRow {
  account_handle: string | null;
  server_url: string | null;
  cursor: string;
  last_pull_at: string | null;
  last_error: string | null;
}

export interface ConflictedRow {
  id: number;
  server_id: string | null;
  name: string;
}

export interface QueuedUseRow {
  server_template_id: string;
  count: number;
}

export interface HistoryJob {
  id: number;
  batch_id: number | null;
  record_index: number | null;
  template_id: number | null;
  printer_id: number | null;
  source: "ui" | "api" | "deeplink" | "batch" | "test";
  source_url: string | null;
  status: "queued" | "printing" | "success" | "failed" | "cancelled";
  error: string | null;
  copies: number;
  settings_json: string | null;
  rendered_html: string | null;
  idempotency_key: string | null;
  is_test: boolean;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  /** JSON of `StageTimings`; null for a job that has not run or predates timings. */
  timings_json: string | null;
  /** Paired phone that asked for this print; null for local prints. */
  requested_by_device_id: string | null;
  /** Template `server_revision` that printed; null for raw HTML or old rows. */
  template_revision: number | null;
  /** Paired PC that printed this job; null when printed locally. */
  printed_by: string | null;
}

export interface ApplyReport {
  applied_upserts: number;
  applied_deletes: number;
  skipped_dirty: number;
}

export interface PrinterRow {
  id: number;
  name: string;
  address: string;
  printer_type: string;
  language: string;
  paper_width_mm?: number | null;
  dpi?: number | null;
  /** UI-only: last test-print outcome, not stored server-side. */
  status?: string;
}

export interface AddPrinterReq {
  name: string;
  printer_type: string;
  address: string;
  language: string;
  paper_width_mm?: number;
  dpi?: number;
}

export interface SystemPrinterRow {
  id: string;
  name: string;
  address: string;
  printer_type: string;
  language: string;
  status?: string;
}

export interface PrintHtmlReq {
  printer_name: string;
  html: string;
  page_width_mm?: number | null;
  page_height_mm?: number | null;
  orientation?: string | null;
  copies?: number | null;
  /** Pages per print: a single object repeats this many times (max 500). Arrays ignore it. */
  records?: number | null;
  margin_top?: number | null;
  margin_right?: number | null;
  margin_bottom?: number | null;
  margin_left?: number | null;
  fit_mode?: string | null;
  page_range?: string | null;
  grayscale?: boolean | null;
  template_id?: number | null;
  data?: unknown;
  data_url?: string | null;
  http_method?: string | null;
  test?: boolean | null;
  source?: string | null;
  idempotency_key?: string | null;
}

/** Where one print job's time went, in ms per pipeline stage (0 = not reached). */
export interface StageTimings {
  fetch_ms: number;
  template_ms: number;
  layout_ms: number;
  render_ms: number;
  send_ms: number;
  history_ms: number;
  total_ms: number;
}

export interface PrintResponse {
  success: boolean;
  job_id: string;
  duration_ms: number;
  error: string | null;
  /** Null when the job failed before any stage ran. */
  timings?: StageTimings | null;
  /** Paired provider that rendered the document, if shared rendering was used. */
  rendered_by?: string | null;
}

/** One guest invite. The code itself is shown once and never listed. */
export interface PairingInvite {
  id: string;
  expires_at: string;
  /** Remaining redemptions; null means unlimited. */
  uses_left: number | null;
  can_print: boolean;
  created_at: string;
  created_by: string | null;
}

/** A minted invite, including its one-time code. */
export interface NewPairingInvite {
  id: string;
  expires_at: string;
  uses_left: number | null;
  can_print: boolean;
  created_at: string;
  created_by: string | null;
  code: string;
}

/** One print through a paired PC (see `remote_print`). Field names mirror
 * the local print request; `template_id` is this phone's local id. */
export interface RemotePrintArgs {
  template_id: number;
  printer_name: string;
  data?: unknown;
  data_url?: string;
  http_method?: string;
  copies?: number;
  records?: number;
  orientation?: string;
  fit_mode?: string;
  page_range?: string;
  grayscale?: boolean;
  test?: boolean;
  /** Caller-generated key; retries of one attempt reuse it. */
  idempotency_key?: string;
  /** Which PC by provider id; defaults to the stored choice or the only pair. */
  pair_id?: string;
}

/** Outcome of one print through a paired PC. `code` carries a 409
 * `template_missing`/`template_stale` for the Sync-templates action. */
export interface RemotePrintResult {
  success: boolean;
  status: string;
  pc_job_id: string | null;
  duration_ms: number;
  error: string | null;
  code: string | null;
  pc_name: string;
}

/** One PC printer, as its `GET /v1/printers` reports it. */
export interface PcPrinterInfo {
  name: string;
  printer_type: string;
  language: string;
}

export interface RemotePrintersResult {
  printers: PcPrinterInfo[];
  /** True when the PC did not answer and this is the last good list. */
  cached: boolean;
}

export interface FontRow {
  id: number;
  family: string;
  style: string;
  weight: string;
  file_path: string;
  format: string;
  created_at: string;
  /** The sync identity; every row has one. */
  server_id: string;
  sync_state: string;
  /** Hex SHA-256 of the stored bytes; empty until bytes land. */
  sha256: string;
  size_bytes: number;
  /** Download state: pending | ready | error. */
  state: string;
}

export interface UploadFontReq {
  file_name: string;
  file_data: number[];
  family?: string | null;
}

export interface ProfileRow {
  id: number;
  /** Local linkage, resolved from the server key. Null when this PC
   * has no such printer or template: the row is dormant, not broken. */
  printer_id: number | null;
  template_id: number | null;
  /** The sync identity; every row has one. */
  server_id: string;
  template_server_id: string;
  /** Lowercase printer name: the server key. */
  printer_name: string;
  settings_json: string;
  created_at: string;
  updated_at: string;
}

export interface SyncedDatasetRow {
  id: number;
  /** The sync identity; every row has one. */
  server_id: string;
  name: string;
  data_json: string;
  server_revision: number | null;
  base_revision: number | null;
  sync_state: string;
  created_at: string;
  updated_at: string;
}

export interface SaveDatasetReq {
  id?: number | null;
  name: string;
  data_json: string;
}

export interface DirtyDatasetRow {
  server_id: string;
  name: string;
  data_json: string;
  base_revision: number | null;
}

export interface DirtyProfileRow {
  server_id: string;
  template_id: string;
  printer_name: string;
  settings_json: string;
  base_revision: number | null;
}

export interface DirtySettingRow {
  key: string;
  value: string;
  tombstone: boolean;
}

export interface DirtyFontRow {
  server_id: string;
  name: string;
  base_revision: number | null;
}

export interface FontDownloadReport {
  downloaded: number;
  failed: number;
}

/** Counts from a full local wipe: everything the app owned on this PC. */
export interface ResetReport {
  templates: number;
  template_versions: number;
  print_jobs: number;
  fonts: number;
  datasets: number;
  profiles: number;
  printers: number;
  batches: number;
}

export interface SaveProfileReq {
  printer_id: number;
  template_id: number;
  settings_json: string;
}

export interface ApiStatus {
  running: boolean;
  address: string;
  port: number;
  lan_access: boolean;
}

/** One loopback HTTP round-trip from the `api_request` command. */
export interface ApiHttpResponse {
  status: number;
  text: string;
}

/** Render-sharing provider state (see docs/ARCHITECTURE.md §9). */
export interface RenderShareStatus {
  enabled: boolean;
  secret_set: boolean;
  port: number;
  lan_access: boolean;
  /** The local API server is up. Sharing only works while it is. */
  running: boolean;
  /** Phones currently paired with this PC. */
  paired_count: number;
}

/** The PC's open pairing window: the code to show, seconds left, and the
 * PC's address for the manual-address fallback. */
export interface PairingState {
  open: boolean;
  /** The 8-character code to show, e.g. `K7QM4XPD`. Empty when no window is open. */
  code: string;
  expires_in: number;
  host: string;
  port: number;
}

/** One row of the PC's "Paired phones" list. `display_name` is the PC
 * user's rename and wins over the phone-reported `name`. */
export interface PairedDevice {
  id: string;
  name: string;
  display_name: string | null;
  platform: string;
  paired_at: string;
  last_seen_at: string;
  can_print: boolean;
  /** Account both devices were signed in to at claim time, if any. */
  account_id: string | null;
  /** `owner` or `guest` (guests pair by invite, need no account). */
  role: string;
  /** Invite expiry for guests (RFC-3339); null never expires. */
  expires_at: string | null;
}

/** One paired render provider (stored as JSON in the `render_pairs` setting).
 *
 * `secret` holds the per-device token minted by the claim (the name is
 * kept so nothing else changes). Newer fields are optional so pairs
 * stored by older versions still load — they fail auth until re-paired.
 */
export interface RenderPair {
  id: string;
  name: string;
  host: string;
  port: number;
  secret: string;
  fingerprint: string;
  /** The PC's stable id: re-pairing it replaces the old entry. */
  provider_id?: string;
  /** The PC's platform. */
  platform?: string;
  /** RFC-3339 timestamp of the claim. */
  paired_at?: string;
  /** This phone's id, as the PC has it. */
  device_id?: string;
  /** True when this claim replaced a differently-identified entry for
   * the same address (reset/reinstalled PC): announce it. */
  replaced_stale?: boolean;
}

/** Provider capability advertisement from `peer_capabilities`. */
export interface PeerCapabilities {
  protocol: number;
  can_render: boolean;
  score: number;
  cores: number;
  platform: string;
  max_concurrent_renders: number;
}

/** Arguments for a one-off peer render (mirrors the Rust struct). */
export interface PeerRenderArgs {
  host: string;
  port: number;
  secret: string;
  html: string;
  paper_w_mm: number;
  paper_h_mm: number;
  orientation: string;
  language: string;
  dpi: number;
}

/** One bought render (mirrors the provider's response shape). */
export interface PeerRenderResult {
  bytes_b64: string;
  mime: string;
  render_ms: number;
}

export interface DeeplinkResult {
  action: string;
  [key: string]: unknown;
}
