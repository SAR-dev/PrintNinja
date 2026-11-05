/** Physical paper sheets offered as one-tap presets (mm). */
export const PAPER_PRESETS = [
  { key: "a4", w: 210, h: 297, labelKey: "print.paper_a4" },
  { key: "letter", w: 216, h: 279, labelKey: "print.paper_letter" },
  { key: "photo", w: 100, h: 150, labelKey: "print.paper_photo" },
] as const;

/** Largest paper edge the custom inputs accept (mm). */
export const MAX_PAPER_MM = 5000;

/** What the paper dropdown shows. */
export type PaperKey =
  | "auto"
  | "custom"
  | (typeof PAPER_PRESETS)[number]["key"];

/**
 * The dropdown key for an explicit paper size when the user has not asked
 * for "Custom" explicitly: nothing set -> auto, an exact preset -> that
 * preset, anything else -> custom. "Custom" being chosen on purpose is kept
 * in the print store (`paperCustom`) so it survives values that happen to
 * look like a preset or like "unset".
 */
export function derivePaperKey(w: number | null, h: number | null): PaperKey {
  if (w == null && h == null) return "auto";
  return PAPER_PRESETS.find((x) => x.w === w && x.h === h)?.key ?? "custom";
}

/**
 * One custom width/height input: "" clears the axis (null = design size),
 * a positive number is clamped to MAX_PAPER_MM, and anything else (0,
 * negatives, NaN) is rejected (undefined) so the field keeps its last
 * valid value instead of jumping to 1 mid-typing.
 */
export function parsePaperInput(raw: string): number | null | undefined {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(n, MAX_PAPER_MM);
}
