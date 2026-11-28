/**
 * Uploaded fonts for the scene (label) track. The label renderer reads
 * TrueType and OpenType only — WOFF/WOFF2 uploads stay document-only — and
 * matches a text element's `style.font` to an uploaded family without
 * regard to case. The canvas registers the same fonts with the browser so
 * its SVG text looks like what the backend renders.
 */
import { useEffect, useState } from "react";
import { agent } from "@/lib/agent/commands";
import type { FontRow } from "@/lib/agent/types";

/** The uploads the label renderer can draw with: TrueType/OpenType, on
 *  disk, one row per family (the first upload wins, like the backend). */
export function sceneFontRows(rows: FontRow[]): FontRow[] {
  const seen = new Set<string>();
  const out: FontRow[] = [];
  for (const row of rows) {
    const format = row.format.toLowerCase();
    const key = row.family.trim().toLowerCase();
    if (!key || !row.file_path || row.sync_state === "deleted_pending")
      continue;
    if (format !== "ttf" && format !== "otf") continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/** The uploaded fonts a label can use; refreshed after a sync pull. */
export function useUploadedSceneFonts(): FontRow[] {
  const [rows, setRows] = useState<FontRow[]>([]);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const all = (await agent("list_fonts", {})) ?? [];
        if (alive) setRows(sceneFontRows(all));
      } catch {
        /* backend unavailable: no custom fonts to offer */
      }
    };
    void load();
    const onPulled = () => void load();
    window.addEventListener("sync:pulled", onPulled);
    return () => {
      alive = false;
      window.removeEventListener("sync:pulled", onPulled);
    };
  }, []);
  return rows;
}

const registered = new Map<string, Promise<void>>();

/** Register an uploaded font with the browser (once per file) so SVG text
 *  can use it. Never throws: a font that fails to load just leaves the
 *  browser's fallback in the preview. */
export function ensureFontFace(row: FontRow): Promise<void> {
  if (typeof FontFace === "undefined" || typeof document === "undefined") {
    return Promise.resolve();
  }
  const key = `${row.server_id}:${row.sha256}:${row.family.trim()}`;
  let pending = registered.get(key);
  if (!pending) {
    pending = (async () => {
      try {
        const bytes = await agent("cache_read_font_file", {
          server_id: row.server_id,
        });
        const face = new FontFace(
          row.family.trim(),
          new Uint8Array(bytes).buffer,
        );
        await face.load();
        document.fonts.add(face);
      } catch {
        registered.delete(key); // try again next time
      }
    })();
    registered.set(key, pending);
  }
  return pending;
}

/** A CSS `font-family` value for an uploaded family, with a fallback. */
export function cssFontFamily(family: string): string {
  return `"${family.replace(/["\\]/g, "")}", sans-serif`;
}
