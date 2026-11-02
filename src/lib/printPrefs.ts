import { readSetting } from "@/lib/settings";

/**
 * Per-printer print preferences (F3 – smart printer/template matching).
 * After a local print, the chosen template and paper size are remembered
 * for that printer so the Print page can preselect them when the printer
 * is picked again. Stored as one device setting (JSON map keyed by
 * printer name — the name is what print jobs are addressed by), via the
 * same readSetting/writeSetting path as every other setting, so it works
 * in the Tauri app and the browser preview alike.
 */

export const PRINT_PREFS_KEY = "print_prefs";

/** The last local print settings remembered for one printer. */
export type PrinterPrefs = {
  /** Local template row id (string, like store.templateId). */
  template_id: string;
  /** Explicit paper size in mm; null = the template's design size. */
  paper_w: number | null;
  paper_h: number | null;
};

export type PrintPrefsMap = Record<string, PrinterPrefs>;

/** Map key: the printer name, compared like every other name match here. */
export function prefsKey(name: string): string {
  return name.trim().toLowerCase();
}

/** Defensive parse: corrupt or wrong-shaped values yield an empty (or
 * partial) map rather than throwing — a bad prefs value must never break
 * the Print page. */
export function parsePrintPrefs(raw: string | null): PrintPrefsMap {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return {};
    }
    const out: PrintPrefsMap = {};
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (typeof entry !== "object" || entry === null) continue;
      const p = entry as Record<string, unknown>;
      if (typeof p.template_id !== "string" || !p.template_id) continue;
      out[key] = {
        template_id: p.template_id,
        paper_w:
          typeof p.paper_w === "number" && p.paper_w > 0 ? p.paper_w : null,
        paper_h:
          typeof p.paper_h === "number" && p.paper_h > 0 ? p.paper_h : null,
      };
    }
    return out;
  } catch {
    return {};
  }
}

export async function loadPrintPrefs(): Promise<PrintPrefsMap> {
  return parsePrintPrefs(await readSetting(PRINT_PREFS_KEY));
}
