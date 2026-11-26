/**
 * The small labelled inputs of the scene designer: a number field, a
 * switch row and the page-placement picker. Ported from
 * PrintNinja-Next's `app/ui/src/components/editor/fields.tsx`.
 */
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
import { Switch } from "@/components/ui/switch";
import type { Placement } from "@/lib/scene/schema";

/** X/Y or any other millimetre measure in the inspector. */
export function NumField({
  id,
  label,
  value,
  onChange,
  step = 0.1,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-caption">
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        step={step}
        min={0}
        value={value}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
      />
    </div>
  );
}

/** A labelled switch for a single element option. */
export function SwitchRow({
  label,
  checked,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-label={label}
      />
      <Label className="cursor-pointer text-body-sm">{label}</Label>
    </div>
  );
}

/** Where an element prints: every page, first, last, or one page only. */
export function PlacementSelect({
  value,
  onChange,
}: {
  value: Placement;
  onChange: (p: Placement) => void;
}) {
  const { t } = useTranslation();
  const isOnly = typeof value === "object";
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-caption">{t("scene.page")}</Label>
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <Select
            value={isOnly ? "only" : value}
            onValueChange={(v) =>
              onChange(v === "only" ? { only: 2 } : (v as Placement))
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="every">{t("scene.page_every")}</SelectItem>
              <SelectItem value="first">{t("scene.page_first")}</SelectItem>
              <SelectItem value="last">{t("scene.page_last")}</SelectItem>
              <SelectItem value="only">{t("scene.page_only")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {isOnly && (
          <div className="flex w-20 flex-col gap-1">
            <Label className="sr-only">{t("scene.page_number")}</Label>
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              value={value.only}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n))
                  onChange({ only: Math.max(1, Math.round(n)) });
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
