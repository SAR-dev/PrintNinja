// Label track (WP2–WP4) behavior for the fake agent: the five label
// commands (save/prepare/print/list-profiles) plus the model pick and
// the designer's preview and symbol encoding. The Rust side
// (src-tauri/src/label_pipeline.rs + commands/label.rs) is the source of
// truth; this module mirrors its wire shapes, its resolution order and
// its error strings so the e2e specs see the same rejections the
// backend gives. The fake cannot run the render/encode pipeline, so the
// report numbers (bytes, pages, preview bitmaps) are deterministic
// fakes: specs assert shapes and routing, never exact pixels (the Rust
// integration tests pin those).

import type { FakeCache } from "./cache.js";

// ── bundled profiles ──
// Canned table over core/profiles/profiles/*.toml, in the EMBEDDED
// ship order (bf-p2d … zt411). can_confirm = the profile answers a
// status dialect AND keeps the socket open for it (gk420d, zd421,
// zt411).

interface BundledProfile {
  id: string;
  model: string;
  aliases: string[];
  language: "pdf" | "zpl" | "tspl" | "cpcl" | "escpos";
  media: string[];
  dpi: number | null;
  head_width_dots: number | null;
  delivery: { chunk_bytes: number; pause_ms: number; close_delay_ms: number };
  answers_status: boolean;
  keep_open_for_status: boolean;
}

const BUNDLED: BundledProfile[] = [
  {
    id: "bf-p2d",
    model: "B-FP2D",
    aliases: ["bf fp2d"],
    language: "zpl",
    media: ["label"],
    dpi: null,
    head_width_dots: null,
    delivery: { chunk_bytes: 512, pause_ms: 50, close_delay_ms: 0 },
    answers_status: false,
    keep_open_for_status: true,
  },
  {
    id: "ct-s500",
    model: "CT-S500",
    aliases: ["citizen ct-s500"],
    language: "cpcl",
    media: ["label"],
    dpi: 200,
    head_width_dots: 800,
    delivery: { chunk_bytes: 512, pause_ms: 50, close_delay_ms: 0 },
    answers_status: false,
    keep_open_for_status: false,
  },
  {
    id: "generic-thermal-58mm",
    model: "Generic Thermal Printer 58mm",
    aliases: ["thermal 58mm", "pos-58"],
    language: "escpos",
    media: ["continuous"],
    dpi: 203,
    head_width_dots: 384,
    delivery: { chunk_bytes: 512, pause_ms: 50, close_delay_ms: 0 },
    answers_status: false,
    keep_open_for_status: true,
  },
  {
    id: "gk420d",
    model: "GK420d",
    aliases: ["zebra gk420"],
    language: "zpl",
    media: ["label"],
    dpi: 203,
    head_width_dots: 864,
    delivery: { chunk_bytes: 1024, pause_ms: 10, close_delay_ms: 500 },
    answers_status: true,
    keep_open_for_status: true,
  },
  {
    id: "office-laser-cups",
    model: "Office Laser (CUPS)",
    aliases: ["office laser"],
    language: "pdf",
    media: ["page"],
    dpi: null,
    head_width_dots: null,
    // The TOML omits the three delivery keys — serde defaults.
    delivery: { chunk_bytes: 1024, pause_ms: 10, close_delay_ms: 500 },
    answers_status: false,
    keep_open_for_status: false,
  },
  {
    id: "ql-820nwb",
    model: "QL-820NWB",
    aliases: ["brother ql-820"],
    language: "escpos",
    media: ["label"],
    dpi: null,
    head_width_dots: null,
    delivery: { chunk_bytes: 512, pause_ms: 50, close_delay_ms: 0 },
    answers_status: false,
    keep_open_for_status: true,
  },
  {
    id: "rp325",
    model: "RP325",
    aliases: ["ruijie rp325"],
    language: "escpos",
    media: ["continuous"],
    dpi: null,
    head_width_dots: null,
    delivery: { chunk_bytes: 512, pause_ms: 50, close_delay_ms: 0 },
    answers_status: false,
    keep_open_for_status: true,
  },
  {
    id: "tm-t88vii",
    model: "TM-T88VII",
    aliases: ["epson tm-t88"],
    language: "escpos",
    media: ["continuous"],
    dpi: 203,
    head_width_dots: 576,
    delivery: { chunk_bytes: 512, pause_ms: 50, close_delay_ms: 0 },
    answers_status: false,
    keep_open_for_status: true,
  },
  {
    id: "ttp-244-pro",
    model: "TTP-244 Pro",
    aliases: ["tsc ttp-244"],
    language: "tspl",
    media: ["label"],
    dpi: 203,
    head_width_dots: 812,
    delivery: { chunk_bytes: 512, pause_ms: 50, close_delay_ms: 0 },
    answers_status: false,
    keep_open_for_status: true,
  },
  {
    id: "zd421",
    model: "ZD421",
    aliases: ["zebra zd421"],
    language: "zpl",
    media: ["label"],
    dpi: 203,
    head_width_dots: 812,
    delivery: { chunk_bytes: 512, pause_ms: 50, close_delay_ms: 0 },
    answers_status: true,
    keep_open_for_status: true,
  },
  {
    id: "zt411",
    model: "ZT411",
    aliases: ["zebra zt411"],
    language: "zpl",
    media: ["label"],
    dpi: 203,
    head_width_dots: 812,
    delivery: { chunk_bytes: 512, pause_ms: 50, close_delay_ms: 0 },
    answers_status: true,
    keep_open_for_status: true,
  },
];

export interface ProfileInfo {
  id: string;
  model: string;
  aliases: string[];
  language: string;
  media: string[];
  dpi: number | null;
  head_width_dots: number | null;
  can_confirm: boolean;
  delivery: { chunk_bytes: number; pause_ms: number; close_delay_ms: number };
}

export function listProfiles(): ProfileInfo[] {
  return BUNDLED.map((p) => ({
    id: p.id,
    model: p.model,
    aliases: [...p.aliases],
    language: p.language,
    media: [...p.media],
    dpi: p.dpi,
    head_width_dots: p.head_width_dots,
    can_confirm: p.answers_status && p.keep_open_for_status,
    delivery: { ...p.delivery },
  }));
}

// ── model pick (WP3) ──
// Two separate tables, like Rust: the default model per row language
// and the expected language family a pick must speak. A `raster` row
// takes the ESC/POS family.

const DEFAULT_MODEL: Record<string, string> = {
  pdf: "office-laser-cups",
  zpl: "zt411",
  tspl: "ql-820nwb",
  cpcl: "ct-s500",
  escpos: "generic-thermal-58mm",
  raster: "generic-thermal-58mm",
};

const FAMILY: Record<string, string> = {
  pdf: "pdf",
  zpl: "zpl",
  tspl: "tspl",
  cpcl: "cpcl",
  escpos: "escpos",
  raster: "escpos",
};

export function defaultModelForLanguage(language: string): string {
  return DEFAULT_MODEL[language] ?? "office-laser-cups";
}

/** Mirrors validate_profile_pick: bundled id + language family. */
export function validateProfilePick(profileId: string, rowLanguage: string) {
  const profile = BUNDLED.find((p) => p.id === profileId);
  if (!profile) {
    throw new Error(
      `no bundled profile '${profileId}'; the ids the app knows: ${BUNDLED.map((p) => p.id).join(", ")}`,
    );
  }
  const want = FAMILY[rowLanguage];
  if (profile.language !== want) {
    throw new Error(
      `profile '${profileId}' speaks ${profile.language}, but this printer's language is ${want}`,
    );
  }
  return profile;
}

// ── effective profile resolution ──
// Mirrors resolve_profile_for_printer: a user pick takes the profile's
// own language + media with the row's geometry applied on top (the fake
// printer rows carry no dpi, so only the paper width applies); no pick
// forces the language family's media on a 203 dpi baseline.

interface EffectiveProfile {
  id: string;
  model: string;
  user_chosen: boolean;
  language: string;
  media: string[];
  dpi: number;
  width_mm: number | null;
}

function resolveProfile(row: {
  language: string;
  paper_width_mm: number | null;
  label_profile: string | null;
}): EffectiveProfile {
  const pick = row.label_profile;
  if (pick !== null) {
    const p = validateProfilePick(pick, row.language);
    if (row.paper_width_mm != null && p.dpi != null) {
      return {
        id: p.id,
        model: p.model,
        user_chosen: true,
        language: p.language,
        media: [...p.media],
        dpi: p.dpi,
        width_mm: row.paper_width_mm,
      };
    }
    // The base profile geometry, as shipped in its TOML.
    const baseWidth =
      p.head_width_dots != null && p.dpi != null
        ? Math.round((p.head_width_dots * 25.4) / p.dpi)
        : null;
    return {
      id: p.id,
      model: p.model,
      user_chosen: true,
      language: p.language,
      media: [...p.media],
      dpi: p.dpi ?? 203,
      width_mm: baseWidth,
    };
  }
  const language = FAMILY[row.language];
  const id = DEFAULT_MODEL[row.language];
  const base = BUNDLED.find((p) => p.id === id);
  return {
    id,
    model: base?.model ?? "",
    user_chosen: false,
    language,
    media: language === "pdf" ? ["page"] : ["label", "continuous"],
    dpi: 203,
    width_mm: row.paper_width_mm ?? null,
  };
}

// ── plan (core/planner) ──
// Media check first, then the track/format routing. The fake cannot run
// the native encoder's fits check, so thermal-language scenes plan
// "native" and ESC/POS plans "raster" deterministically.

interface Plan {
  path: "native" | "raster" | "pdf" | "browser";
  fallback: string | null;
}

function plan(templateMediaKind: string, profile: EffectiveProfile): Plan {
  // Roll templates print on continuous media.
  const wanted =
    templateMediaKind === "roll" ? "continuous" : templateMediaKind;
  if (!profile.media.includes(wanted)) {
    throw new Error(
      `the template's ${templateMediaKind} media is not this printer's media (${profile.media.join(", ")}) — no output path can print it`,
    );
  }
  if (profile.language === "pdf") {
    if (templateMediaKind === "page") return { path: "pdf", fallback: null };
    return {
      path: "pdf",
      fallback: `the ${templateMediaKind} scene needs raster output and this printer speaks pdf, not a thermal language — rendered to PDF and sent through the OS print path instead`,
    };
  }
  if (profile.language === "escpos") return { path: "raster", fallback: null };
  return { path: "native", fallback: null };
}

// ── scene + records validation ──
// The Rust side is the engine; the fake keeps the shape checks whose
// errors the UI surfaces (parse, media kind, positive dimensions,
// records grammar). Element-level checks stay with the Rust tests.

interface Scene {
  format: "scene" | "html";
  media: {
    kind: string;
    width_mm: number;
    height_mm: number | null;
    label_height_mm?: number | null;
  };
  elements: unknown[];
  html?: unknown;
}

function mediaHeight(media: Scene["media"]): number {
  return media.kind === "roll"
    ? (media.label_height_mm ?? 0)
    : (media.height_mm ?? 0);
}

export function parseScene(raw: string): Scene {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    throw new Error(`the template is not valid JSON: ${e}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `the template is not valid JSON: the template must be a JSON object`,
    );
  }
  const t = value as Record<string, unknown>;
  const format = (t["format"] as string) ?? "scene";
  const media = t["media"] as Record<string, unknown> | undefined;
  if (!media || typeof media !== "object") {
    throw new Error(`the template is not valid JSON: missing media`);
  }
  const kind = String(media["kind"] ?? "");
  if (!["label", "roll", "page"].includes(kind)) {
    throw new Error(
      `this template uses "${kind}", which needs a newer PrintNinja — update the app to open it`,
    );
  }
  const width = Number(media["width_mm"]);
  const height = Number(media["label_height_mm"] ?? media["height_mm"]);
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error(
      `the media size must be a positive number of millimetres (got ${width}×${height})`,
    );
  }
  const elements = t["elements"];
  if (!Array.isArray(elements)) {
    throw new Error(
      `the template is not valid JSON: elements must be an array`,
    );
  }
  if (format === "html") {
    if (kind !== "page") {
      throw new Error(
        `an HTML template needs page media (A4, letter, …); this one is ${width}×${height} mm thermal media — use format "scene"`,
      );
    }
    if (typeof t["html"] !== "string") {
      throw new Error(
        `the format is "html" but the template carries no HTML document — put the document in the "html" field`,
      );
    }
  }
  return {
    format: format as "scene" | "html",
    media: {
      kind,
      width_mm: width,
      height_mm: kind === "roll" ? null : height,
      label_height_mm: kind === "roll" ? height : null,
    },
    elements,
    html: t["html"],
  };
}

/** Mirrors Records::from_json; returns the record count. */
export function parseRecords(raw: string): number {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    throw new Error(`the data is not valid JSON: ${e}`);
  }
  if (Array.isArray(value)) {
    value.forEach((el, i) => {
      if (typeof el !== "object" || el === null || Array.isArray(el)) {
        throw new Error(
          `record ${i} is not an object (a row is one object per record)`,
        );
      }
    });
    return value.length;
  }
  if (typeof value === "object" && value !== null) return 1;
  throw new Error(`the data must be a JSON object or an array of objects`);
}

// ── report + preview ──
// One page per record. Bytes and the bitmap previews are deterministic
// fakes sized like the real thing (dots at the profile dpi, 8 dots per
// byte, row by row — the Rust test pins 40×50 mm @ 203 dpi as a 320×400
// bitmap of 16 000 bytes).

interface Preview {
  kind: "bitmap" | "pdf";
  width?: number;
  height?: number;
  packed?: number[];
  width_mm?: number;
  height_mm?: number;
  pdf?: number[];
}

interface Report {
  path: string;
  fallback: string | null;
  records: number;
  pages: number;
  units: number;
  bytes: number;
  preview: Preview[];
}

const PDF_BYTES = [..."%PDF-1.4 fake preview page\n"].map((c) =>
  c.charCodeAt(0),
);

function bitmapFor(widthMm: number, heightMm: number, dpi: number): Preview {
  const width = Math.max(1, Math.round((widthMm * dpi) / 25.4));
  const height = Math.max(1, Math.round((heightMm * dpi) / 25.4));
  const rowBytes = Math.ceil(width / 8);
  // A deterministic diagonal, so a spec can tell two sheets apart
  // without asserting pixels.
  const packed: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((x + y) % 7 === 0) {
        const i = y * rowBytes + Math.floor(x / 8);
        packed[i] = (packed[i] ?? 0) | (1 << (7 - (x % 8)));
      }
    }
  }
  return {
    kind: "bitmap",
    width,
    height,
    packed,
    width_mm: widthMm,
    height_mm: heightMm,
  };
}

function buildReport(
  plan: Plan,
  scene: Scene,
  profile: EffectiveProfile,
  records: number,
  copies: number,
): Report {
  const widthMm = scene.media.width_mm;
  const heightMm = mediaHeight(scene.media);
  const pages = records;
  if (plan.path === "pdf" || plan.path === "browser") {
    const once = plan.path === "browser" ? records : 1;
    return {
      path: plan.path,
      fallback: plan.fallback,
      records,
      pages,
      units: once * copies,
      bytes: once * copies * (PDF_BYTES.length + 64),
      preview: Array.from({ length: once }, () => ({
        kind: "pdf",
        pdf: [...PDF_BYTES, 37, 0, 0, 255],
      })),
    };
  }
  const units = plan.path === "native" ? copies : pages * copies;
  // A deterministic per-unit byte count at the profile dpi.
  const dotBytes =
    Math.ceil(Math.max(1, Math.round((widthMm * profile.dpi) / 25.4)) / 8) *
    Math.max(1, Math.round((heightMm * profile.dpi) / 25.4));
  const unitBytes = plan.path === "native" ? 128 + records * 32 : dotBytes;
  return {
    path: plan.path,
    fallback: plan.fallback,
    records,
    pages,
    units,
    bytes: units * unitBytes,
    preview: Array.from({ length: pages }, () =>
      bitmapFor(widthMm, heightMm, profile.dpi),
    ),
  };
}

// ── job plumbing ──
// label_prepare / label_print resolve the job the way Rust does
// (template row → track check → scene payload → printer lookup →
// profile → records), prepare, and print reports the honest canned
// result: the fake transport has no status reply, so every job ends
// sent_unconfirmed.

let nextJobId = 1;

function lookupPrinter(cache: FakeCache, name: string) {
  const row = cache.library
    .listPrinters()
    .find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (!row) {
    throw new Error(`Printer '${name}' is not saved; add it in Settings`);
  }
  return row;
}

function sceneTemplateRow(cache: FakeCache, id: number) {
  // getTemplate throws `Template ${id} not found` (also for rows
  // pending deletion) — the order Rust's resolve_scene_job checks.
  const row = cache.getTemplate(id) as Record<string, unknown>;
  if (row["track"] !== "scene") {
    throw new Error(
      `Template ${id} is on the '${String(row["track"])}' track; the label commands take scene templates`,
    );
  }
  if (row["scene_json"] == null) {
    throw new Error(`this scene template has no scene_json payload`);
  }
  return row;
}

function prepareFromInputs(
  cache: FakeCache,
  sceneRaw: string,
  printerName: string,
  recordsRaw: string,
  copies: number | null,
): Record<string, unknown> {
  const printer = lookupPrinter(cache, printerName);
  const profile = resolveProfile(printer);
  const scene = parseScene(sceneRaw);
  const records = parseRecords(recordsRaw);
  const n = Math.max(1, copies ?? 1);
  if (records === 0) {
    throw new Error(
      `the data is not records: 0 records — a label job prints at least one`,
    );
  }
  const p: Plan =
    scene.format === "html"
      ? { path: "browser", fallback: null }
      : plan(scene.media.kind, profile);
  const report = buildReport(p, scene, profile, records, n);
  return {
    profile: profile.model,
    profile_source: profile.user_chosen ? "user" : "default",
    ...report,
  };
}

export function prepareScene(
  cache: FakeCache,
  req: Record<string, unknown>,
): Record<string, unknown> {
  return prepareFromInputs(
    cache,
    String(req["scene"] ?? ""),
    String(req["printer"] ?? ""),
    String(req["records"] ?? ""),
    req["copies"] == null ? null : Number(req["copies"]),
  );
}

export function prepareJob(
  cache: FakeCache,
  req: Record<string, unknown>,
): Record<string, unknown> {
  const row = sceneTemplateRow(cache, Number(req["template_id"] ?? 0));
  return prepareFromInputs(
    cache,
    String(row["scene_json"]),
    String(req["printer"] ?? ""),
    String(req["records"] ?? ""),
    req["copies"] == null ? null : Number(req["copies"]),
  );
}

export function printJob(
  cache: FakeCache,
  req: Record<string, unknown>,
): Record<string, unknown> {
  // Resolve + prepare first (every rejection Rust raises before the
  // delivery), then the canned delivery result.
  prepareJob(cache, req);
  return {
    job_id: nextJobId++,
    report: { result: "sent_unconfirmed", counts: null, reason: null },
    duration_ms: 120,
  };
}

// ── scene templates (label_save_template) ──
// The row itself is created on the cache (its name-uniqueness and local
// sync identity rules are the cache's); this side validates the scene
// payload first and hands back the wire row.

function wireRow(cache: FakeCache, id: number): Record<string, unknown> {
  return cache.listTemplates().find((t) => t["id"] === id) ?? {};
}

export function saveSceneTemplate(
  cache: FakeCache,
  req: { name: string; scene: string },
): Record<string, unknown> {
  parseScene(req.scene);
  const row = cache.createSceneTemplate(req.name, req.scene);
  return wireRow(cache, row.id);
}

export function updateSceneTemplate(
  cache: FakeCache,
  id: number,
  req: { name: string; scene: string },
): Record<string, unknown> {
  parseScene(req.scene);
  const row = cache.updateSceneTemplate(id, req.name, req.scene);
  return wireRow(cache, row.id);
}

// ── symbol encoding (designer canvas) ──
// Mirrors label_encode_symbol: trim, empty → null, qr → a 21×21 matrix
// (quiet 4, side present), linear kinds → a single flat row of modules
// (quiet 10, no side), values the symbology cannot carry → null. The
// matrix is a deterministic pattern, not a real encoding — specs assert
// the shape, the Rust side pins real bytes.

function ean13Digits(value: string): boolean {
  // 12 or 13 digits (the 13th may be a check digit).
  return /^\d{12}$/.test(value) || /^\d{13}$/.test(value);
}

function upcaDigits(value: string): boolean {
  return /^\d{11}$/.test(value) || /^\d{12}$/.test(value);
}

export function encodeSymbol(
  kind: string,
  value: string,
): { quiet: number; modules: number[]; side?: number } | null {
  const v = value.trim();
  if (v === "") return null;
  if (kind === "qr") {
    const side = 21;
    const modules: number[] = [];
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        // Finder-corner pattern plus a deterministic body.
        const corner =
          (x < 7 && y < 7) ||
          (x >= side - 7 && y < 7) ||
          (x < 7 && y >= side - 7);
        let on: boolean;
        if (corner) {
          const lx = x < 7 ? x : x - (side - 7);
          const ly = y < 7 ? y : y - (side - 7);
          const ring = Math.max(Math.abs(lx - 3), Math.abs(ly - 3));
          on = ring <= 3 && ring !== 1;
        } else {
          on = (x * 7 + y * 3 + v.charCodeAt(0)) % 5 < 2;
        }
        modules.push(on ? 1 : 0);
      }
    }
    return { quiet: 4, modules, side };
  }
  // Linear barcodes: code39, code93, ean13, upca, itf, and the default
  // (Code128 for "_").
  const linear =
    kind === "code39" ||
    kind === "code93" ||
    kind === "ean13" ||
    kind === "upca" ||
    kind === "itf" ||
    kind === "_" ||
    kind === "code128";
  if (!linear) return null;
  if (kind === "ean13" && !ean13Digits(v)) return null;
  if (kind === "upca" && !upcaDigits(v)) return null;
  if (kind === "itf" && (!/^\d+$/.test(v) || v.length % 2 !== 0)) return null;
  // A deterministic start/stop-framed run of modules.
  const modules: number[] = [1, 0, 1];
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    for (let b = 3; b >= 0; b--) {
      modules.push(((c >> b) & 1) === 1 ? 1 : 0);
    }
    modules.push(0);
  }
  modules.push(1, 0, 1);
  return { quiet: 10, modules };
}
