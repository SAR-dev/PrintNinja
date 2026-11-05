import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  PAPER_PRESETS,
  parsePaperInput,
  type PaperKey,
} from "@/lib/paperPresets";
import { usePrintStore } from "@/lib/store/printStore";

/**
 * The paper-size dropdown plus the custom width/height inputs, shared by the
 * desktop Print page and the phone layout sheet so the two can't drift.
 *
 * `paperPreset` is the key the page worked out (auto / a preset / custom).
 * "Custom…" is remembered in the store (`paperCustom`), so choosing it from a
 * preset keeps the inputs open instead of snapping back to the preset whose
 * size they were seeded with.
 */
export function PaperSizeFields({
  ids,
  layout,
  paperPreset,
  seedW,
  seedH,
  designW,
  designH,
}: {
  ids: { select: string; width: string; height: string };
  /** `grid`: width and height side by side; `stack`: one per row. */
  layout: "grid" | "stack";
  paperPreset: PaperKey;
  /** Size "Custom…" starts from (the effective, unswapped paper size). */
  seedW: number;
  seedH: number;
  designW: number;
  designH: number;
}) {
  const { t } = useTranslation();
  const paperW = usePrintStore((s) => s.paperW);
  const paperH = usePrintStore((s) => s.paperH);
  const selectPaper = usePrintStore((s) => s.selectPaper);
  const setPaperW = usePrintStore((s) => s.setPaperW);
  const setPaperH = usePrintStore((s) => s.setPaperH);

  const onSize = (set: (v: number | null) => void) => (raw: string) => {
    const v = parsePaperInput(raw);
    if (v !== undefined) set(v);
  };
  const full = layout === "stack";

  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor={ids.select}>{t("print.paper_size")}</Label>
        <Select
          value={paperPreset}
          onValueChange={(v) =>
            selectPaper(v as PaperKey, { w: seedW, h: seedH })
          }
        >
          <SelectTrigger
            id={ids.select}
            aria-label={t("print.paper_size")}
            className={full ? "w-full" : undefined}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">{t("print.paper_auto")}</SelectItem>
            {PAPER_PRESETS.map((x) => (
              <SelectItem key={x.key} value={x.key}>
                {t(x.labelKey)}
              </SelectItem>
            ))}
            <SelectItem value="custom">{t("print.paper_custom")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {paperPreset === "custom" && (
        <div className={full ? "space-y-4" : "grid grid-cols-2 gap-3"}>
          <div className="space-y-1.5">
            <Label htmlFor={ids.width}>{t("print.paper_width")}</Label>
            <Input
              id={ids.width}
              type="number"
              min="1"
              max="5000"
              value={paperW ?? ""}
              placeholder={String(designW)}
              onChange={(e) => onSize(setPaperW)(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={ids.height}>{t("print.paper_height")}</Label>
            <Input
              id={ids.height}
              type="number"
              min="1"
              max="5000"
              value={paperH ?? ""}
              placeholder={String(designH)}
              onChange={(e) => onSize(setPaperH)(e.target.value)}
            />
          </div>
        </div>
      )}
    </>
  );
}
