import { STARTER_TEMPLATES } from "@/lib/templates/defaultTemplate";

/**
 * The bundled starter only fills an empty account. Once there is any
 * other template, hide it from the lists. Hide only: the row is neither
 * deleted nor synced away, so it comes back if the user is left with
 * just that one. Matched by the bundled name.
 */
export function hideStarterWhenOthers<T extends { name: string }>(
  rows: T[],
): T[] {
  if (rows.length <= 1) return rows;
  const starterNames = new Set(STARTER_TEMPLATES.map((t) => t.name));
  const visible = rows.filter((r) => !starterNames.has(r.name));
  return visible.length > 0 ? visible : rows;
}
