import type { ReactNode } from "react";
import { ArrowLeftRight, FileText, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { HelpersPanel } from "./HelpersPanel";
import { CustomInputPanel } from "./CustomInputPanel";

export interface PagePreset {
  /** i18n key for the preset name shown on its button. */
  labelKey: string;
  width: number;
  height: number;
}

interface Props<
  T extends { id: number; name: string; origin?: string | null },
> {
  templates: T[];
  currentTemplateId: number | null;
  loadTemplate: (tpl: T) => void;
  /** Open the New-template dialog. Shown as the empty state when there
   * is no template to list yet. */
  onNew?: () => void;
  templateName: string;
  setTemplateName: (v: string) => void;
  pageWidth: number;
  setPageWidth: (v: number) => void;
  pageHeight: number;
  setPageHeight: (v: number) => void;
  presets: PagePreset[];
  /** Show the Templates section and the name field. The desktop Designer
   * turns this off: its top row switches and renames templates. A phone has
   * no such row, so it keeps both here. Defaults to on. */
  showTemplates?: boolean;
  /** Show the Helpers section. A phone shows the helpers inside the Sample data tab instead. */
  showHelpers?: boolean;
  /** Open the barcode dialog. Renders the "Custom input" section (barcode + font). */
  onBarcode?: () => void;
  /** Section ids open at first: "templates", "page", "sample", "helpers", "custom". Desktop opens only "page"; a phone opens none. */
  defaultOpen?: string[];
  /** Controlled open sections. When given, the parent owns (and can remember) which are open. */
  openSections?: string[];
  onOpenSectionsChange?: (sections: string[]) => void;
  /** Click-to-insert for the Helpers section; without it the helpers are only a reference. */
  onInsertHelper?: (text: string) => void;
  /** The sample datasets. When given, a Sample data section is listed after Page Setup. */
  samplePanel?: ReactNode;
  /** Extra classes for the accordion; the desktop column drops the card frame it draws itself. */
  className?: string;
}

/**
 * The controls column: template list, page setup, sample data, helpers
 * and custom input, as accordion sections. Several can be open at once.
 */
export function ControlsAccordion<
  T extends { id: number; name: string; origin?: string | null },
>({
  templates,
  currentTemplateId,
  loadTemplate,
  onNew,
  templateName,
  setTemplateName,
  pageWidth,
  setPageWidth,
  pageHeight,
  setPageHeight,
  presets: PAGE_PRESETS,
  showTemplates = true,
  showHelpers = true,
  defaultOpen = ["page"],
  openSections,
  onOpenSectionsChange,
  onInsertHelper,
  onBarcode,
  samplePanel,
  className,
}: Props<T>) {
  const { t } = useTranslation();
  const open = openSections
    ? { value: openSections, onValueChange: onOpenSectionsChange }
    : { defaultValue: defaultOpen };
  // The list grouped into Mine / Saved. Built outside the JSX: a
  // block-body arrow inside a nested ternary does not parse as TSX.
  const templateGroups = (
    [
      ["own", "templates.tab_mine"],
      ["saved", "templates.tab_saved"],
    ] as const
  ).map(([origin, labelKey]) => {
    const group = templates.filter((tpl) =>
      origin === "saved" ? tpl.origin === "saved" : tpl.origin !== "saved",
    );
    if (group.length === 0) return null;
    return (
      <div key={origin} className="space-y-1">
        <p className="px-2 text-xs font-medium text-muted-foreground">
          {t(labelKey)}
        </p>
        {group.map((tpl) => {
          const active = tpl.id === currentTemplateId;
          return (
            <button
              key={tpl.id}
              type="button"
              onClick={() => loadTemplate(tpl)}
              aria-current={active ? "true" : undefined}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors [@media(pointer:coarse)]:min-h-11",
                active
                  ? "bg-accent font-medium text-accent-foreground"
                  : "hover:bg-muted",
              )}
            >
              <FileText className="h-4 w-4 shrink-0" />
              <span className="truncate">{tpl.name}</span>
            </button>
          );
        })}
      </div>
    );
  });
  return (
    <Accordion
      type="multiple"
      {...open}
      className={cn("rounded-lg border bg-card px-3", className)}
    >
      {showTemplates && (
        <AccordionItem value="templates">
          <AccordionTrigger>{t("designer.templates")}</AccordionTrigger>
          <AccordionContent className="space-y-3">
            {templates.length === 0 ? (
              <div className="space-y-2 px-1 py-1">
                <p className="text-xs text-muted-foreground">
                  {t("designer.no_templates_yet")}
                </p>
                {onNew && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={onNew}
                  >
                    <Plus className="h-4 w-4" aria-hidden="true" />
                    {t("designer.newTemplate")}
                  </Button>
                )}
              </div>
            ) : (
              templateGroups
            )}
          </AccordionContent>
        </AccordionItem>
      )}

      <AccordionItem value="page">
        <AccordionTrigger>{t("designer.pageSetup")}</AccordionTrigger>
        <AccordionContent className="space-y-3 px-1">
          {showTemplates && (
            <div className="space-y-1">
              <Label htmlFor="designer-template-name" className="text-xs">
                {t("designer.template_name")}
              </Label>
              <Input
                id="designer-template-name"
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
              />
            </div>
          )}
          <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor="designer-width" className="text-xs">
                {t("designer.width_mm")}
              </Label>
              <Input
                id="designer-width"
                type="number"
                value={pageWidth}
                onChange={(e) => setPageWidth(Number(e.target.value))}
              />
            </div>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={t("designer.swap_dimensions")}
              title={t("designer.swap_dimensions")}
              onClick={() => {
                setPageWidth(pageHeight);
                setPageHeight(pageWidth);
              }}
            >
              <ArrowLeftRight className="h-4 w-4" aria-hidden="true" />
            </Button>
            <div className="space-y-1">
              <Label htmlFor="designer-height" className="text-xs">
                {t("designer.height_mm")}
              </Label>
              <Input
                id="designer-height"
                type="number"
                value={pageHeight}
                onChange={(e) => setPageHeight(Number(e.target.value))}
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t("designer.presets")}</Label>
            <div className="grid grid-cols-3 gap-1">
              {PAGE_PRESETS.map((preset) => (
                <Button
                  key={preset.labelKey}
                  variant="outline"
                  size="sm"
                  className="h-7 px-1 text-xs"
                  title={`${preset.width} × ${preset.height} mm`}
                  onClick={() => {
                    setPageWidth(preset.width);
                    setPageHeight(preset.height);
                  }}
                >
                  {t(preset.labelKey)}
                </Button>
              ))}
            </div>
          </div>
        </AccordionContent>
      </AccordionItem>

      {samplePanel !== undefined && (
        <AccordionItem value="sample">
          <AccordionTrigger>{t("designer.sampleData")}</AccordionTrigger>
          <AccordionContent>{samplePanel}</AccordionContent>
        </AccordionItem>
      )}

      {showHelpers && (
        <AccordionItem value="helpers">
          <AccordionTrigger>{t("designer.helpers")}</AccordionTrigger>
          <AccordionContent>
            <HelpersPanel onInsert={onInsertHelper} />
          </AccordionContent>
        </AccordionItem>
      )}

      {onBarcode && (
        <AccordionItem value="custom">
          <AccordionTrigger>{t("designer.custom_input")}</AccordionTrigger>
          <AccordionContent>
            <CustomInputPanel onBarcode={onBarcode} />
          </AccordionContent>
        </AccordionItem>
      )}
    </Accordion>
  );
}
