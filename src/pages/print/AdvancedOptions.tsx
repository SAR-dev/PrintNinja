import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Zap } from "lucide-react";
import { PaperSizeFields } from "@/components/print/PaperSizeFields";
import type { PaperKey } from "@/lib/paperPresets";
import type { PrintState } from "./types";

/**
 * The Advanced fold's contents: the layout and rarely-touched data
 * options. The panel unmounts while folded, so nothing here costs a
 * re-render until opened.
 */
export function AdvancedOptions({
  store,
  field,
  viaPc,
  paperPreset,
  effPaperW,
  effPaperH,
  designW,
  designH,
  previewPaperW,
  previewPaperH,
  handleSpikeTest,
  labelOnly = false,
}: {
  store: PrintState;
  field: string;
  viaPc: boolean;
  paperPreset: PaperKey;
  effPaperW: number;
  effPaperH: number;
  designW: number;
  designH: number;
  previewPaperW: number;
  previewPaperH: number;
  handleSpikeTest: () => void;
  labelOnly?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <div className={field}>
          <Label htmlFor="print-orientation">{t("print.orientation")}</Label>
          <Select
            value={store.orientation}
            onValueChange={(v) =>
              store.setOrientation(v as "portrait" | "landscape")
            }
          >
            <SelectTrigger
              id="print-orientation"
              aria-label={t("print.orientation")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="portrait">{t("designer.portrait")}</SelectItem>
              <SelectItem value="landscape">
                {t("designer.landscape")}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className={field}>
          <Label htmlFor="print-fit">{t("print.fit_mode")}</Label>
          <Select
            value={store.fitMode}
            onValueChange={(v) =>
              store.setFitMode(
                v as "actual" | "fit-width" | "fit-page" | "shrink" | "fill",
              )
            }
          >
            <SelectTrigger id="print-fit" aria-label={t("print.fit_mode")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="actual">{t("print.fit_actual")}</SelectItem>
              <SelectItem value="fit-width">{t("print.fit_width")}</SelectItem>
              <SelectItem value="fit-page">{t("print.fit_page")}</SelectItem>
              <SelectItem value="shrink">{t("print.fit_shrink")}</SelectItem>
              <SelectItem value="fill">{t("print.fit_fill")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      {!labelOnly && (
        <>
          <PaperSizeFields
            ids={{
              select: "print-paper",
              width: "paper-w",
              height: "paper-h",
            }}
            layout="grid"
            paperPreset={paperPreset}
            seedW={effPaperW}
            seedH={effPaperH}
            designW={designW}
            designH={designH}
          />
          <p className="-mt-2 text-xs text-muted-foreground">
            {t("print.paper_note", {
              dw: designW,
              dh: designH,
              pw: previewPaperW,
              ph: previewPaperH,
            })}
          </p>
        </>
      )}
      <fieldset className="space-y-1.5">
        <legend className="text-sm font-medium leading-none">
          {t("print.margins")} (mm)
        </legend>
        <div className="grid grid-cols-4 gap-2 pt-1.5">
          {(
            [
              ["mt", "print.margin_top", store.marginTop, store.setMarginTop],
              [
                "mr",
                "print.margin_right",
                store.marginRight,
                store.setMarginRight,
              ],
              [
                "mb",
                "print.margin_bottom",
                store.marginBottom,
                store.setMarginBottom,
              ],
              [
                "ml",
                "print.margin_left",
                store.marginLeft,
                store.setMarginLeft,
              ],
            ] as const
          ).map(([id, key, value, set]) => (
            <div key={id} className="space-y-1">
              <Label
                htmlFor={id}
                className="text-xs font-normal text-muted-foreground"
              >
                {t(key)}
              </Label>
              <Input
                id={id}
                type="number"
                value={value}
                onChange={(e) => set(Number(e.target.value))}
              />
            </div>
          ))}
        </div>
      </fieldset>
      <div className="flex items-center gap-2">
        <Switch
          id="grayscale"
          checked={store.grayscale}
          onCheckedChange={store.setGrayscale}
        />
        <Label htmlFor="grayscale" className="font-normal">
          {t("print.grayscale")}
        </Label>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className={field}>
          <Label htmlFor="http-method">{t("print.method_aria")}</Label>
          <Select
            value={store.httpMethod}
            onValueChange={(v: "GET" | "POST") => store.setHttpMethod(v)}
            disabled={store.useTestData}
          >
            <SelectTrigger id="http-method" aria-label={t("print.method_aria")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="GET">GET</SelectItem>
              <SelectItem value="POST">POST</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {!labelOnly && (
          <div className={field}>
            <Label htmlFor="pages">{t("print.pages")}</Label>
            <Input
              id="pages"
              type="number"
              min="1"
              max="500"
              value={store.records}
              onChange={(e) => store.setRecords(Number(e.target.value))}
            />
          </div>
        )}
      </div>
      {!labelOnly && (
        <p className="-mt-2 text-xs text-muted-foreground">
          {t("print.pages_hint")}
        </p>
      )}
      <div className="border-t pt-3">
        <p className="mb-2 text-xs text-muted-foreground">
          {t("print.test_hint")}
        </p>
        {/* Local test page: hidden while printing through a PC. */}
        {!viaPc && (
          <Button
            variant="outline"
            size="sm"
            data-testid="print-spike-test"
            onClick={handleSpikeTest}
            disabled={store.status === "printing"}
          >
            <Zap className="h-4 w-4" aria-hidden="true" />
            {t("print.send_test")}
          </Button>
        )}
      </div>
    </>
  );
}
