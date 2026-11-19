/** A community template published within this many days is "new". */
export const NEW_WINDOW_DAYS = 14;

/**
 * True when the ISO timestamp is inside the "new" window. Null,
 * unparseable or future-dated values never qualify.
 */
export function isRecentlyPublished(
  publishedAt: string | null,
  now: number = Date.now(),
): boolean {
  if (!publishedAt) return false;
  const t = Date.parse(publishedAt);
  if (Number.isNaN(t)) return false;
  const age = now - t;
  return age >= 0 && age <= NEW_WINDOW_DAYS * 86_400_000;
}
