import { agent } from "@/lib/agent/commands";

/** A template row as the pages need it: content plus the server link. */
export interface TemplateListRow {
  id: number;
  name: string;
  page_w_mm: number;
  page_h_mm: number;
  orientation: string;
  html: string;
  css: string;
  compiled_css: string;
  compiled_key: string;
  /** Local origin when the row came from the DB (`own` / `saved`). */
  origin?: string | null;
}

const toRow = (row: {
  id: number;
  name: string;
  page_w_mm: number;
  page_h_mm: number;
  orientation: string;
  html?: string;
  css?: string;
  compiled_css?: string;
  compiled_key?: string;
  origin?: string | null;
}): TemplateListRow => ({
  id: row.id,
  name: row.name,
  page_w_mm: row.page_w_mm,
  page_h_mm: row.page_h_mm,
  orientation: row.orientation,
  html: row.html ?? "",
  css: row.css ?? "",
  compiled_css: row.compiled_css ?? "",
  compiled_key: row.compiled_key ?? "",
  origin: row.origin ?? null,
});

/**
 * The real template list, straight from SQLite. Nothing is seeded on
 * first run — an empty list is a genuinely empty account, and each page
 * decides what to show for it. Always reads fresh (no module memo), so a
 * height saved in Designer is visible in Print without a reload. A
 * missing backend (web mode) reads as an empty list, not a throw.
 */
export async function listTemplates(): Promise<TemplateListRow[]> {
  try {
    const rows = await agent("list_templates", {});
    return (rows ?? []).map(toRow);
  } catch (e) {
    console.warn("Template list unavailable:", e);
    return [];
  }
}
