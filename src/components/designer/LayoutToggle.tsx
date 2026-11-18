import { useTranslation } from "react-i18next";
import { Columns2, PanelTop, Rows2 } from "lucide-react";
import { useRovingRadio } from "@/lib/hooks/useRovingRadio";
import { cn } from "@/lib/utils";

export type DesignerLayout = "side" | "stacked" | "canvas";

export const DESIGNER_LAYOUTS: readonly DesignerLayout[] = [
  "side",
  "stacked",
  "canvas",
];

export function isDesignerLayout(value: unknown): value is DesignerLayout {
  return (
    typeof value === "string" &&
    (DESIGNER_LAYOUTS as readonly string[]).includes(value)
  );
}

const OPTIONS: {
  value: DesignerLayout;
  labelKey: string;
  Icon: typeof Columns2;
}[] = [
  { value: "side", labelKey: "designer.layout_side", Icon: Columns2 },
  { value: "stacked", labelKey: "designer.layout_stacked", Icon: Rows2 },
  { value: "canvas", labelKey: "designer.layout_canvas", Icon: PanelTop },
];

interface Props {
  value: DesignerLayout;
  onChange: (value: DesignerLayout) => void;
}

/** Side by side, stacked (editor above canvas), or canvas only. Desktop
    only. A radiogroup with roving tabindex (DESIGN IMPROVEMENTS 5.7):
    one tab stop, arrows move and select. */
export function LayoutToggle({ value, onChange }: Props) {
  const { t } = useTranslation();
  const radio = useRovingRadio(
    DESIGNER_LAYOUTS.length,
    DESIGNER_LAYOUTS.indexOf(value),
    (i) => onChange(DESIGNER_LAYOUTS[i]),
  );
  return (
    <div
      role="radiogroup"
      aria-label={t("designer.layout_label")}
      className="inline-flex rounded-md border bg-background p-0.5"
    >
      {OPTIONS.map(({ value: v, labelKey, Icon }, i) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-label={t(labelKey)}
          aria-checked={value === v}
          title={t(labelKey)}
          {...radio.register(i)}
          onClick={() => onChange(v)}
          className={cn(
            "flex h-7 w-8 items-center justify-center rounded-sm text-muted-foreground transition-colors",
            value === v ? "bg-accent text-accent-foreground" : "hover:bg-muted",
          )}
        >
          <Icon className="h-4 w-4" aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
