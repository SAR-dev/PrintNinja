/** Physical paper sheets offered as one-tap presets (mm). */
export const PAPER_PRESETS = [
  { key: "a4", w: 210, h: 297, labelKey: "print.paper_a4" },
  { key: "letter", w: 216, h: 279, labelKey: "print.paper_letter" },
  { key: "photo", w: 100, h: 150, labelKey: "print.paper_photo" },
] as const;
