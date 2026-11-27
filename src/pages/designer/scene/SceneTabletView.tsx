/**
 * The label track's tablet view: the canvas first, controls in a bottom
 * sheet, and the same sticky view tabs the document designer uses —
 * Canvas / Elements / Selected element / README / Preview.
 */
import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Save, SlidersHorizontal } from "lucide-react";
import { ControlsAccordion } from "@/components/designer/ControlsAccordion";
import { ReadmePanel } from "@/components/designer/ReadmePanel";
import { MM_TO_PX, ZoomStage } from "@/components/designer/ZoomStage";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  allBindings,
  firstRecordOf,
  getAt,
  pageDims,
} from "@/lib/scene/editor-model";
import type { Template } from "@/lib/scene/schema";
import { SceneBitmapPreview } from "./SceneBitmapPreview";
import { SceneCanvas } from "./SceneCanvas";
import { AddElement, ElementList } from "./ElementList";
import { SelectedElementPanel } from "./SelectedElementPanel";
import type { useSceneTemplate } from "./useSceneTemplate";

interface Props {
  scene: ReturnType<typeof useSceneTemplate>;
  template: Template;
  sampleJson: string;
  samplePanel: ReactNode;
  readme: string;
  onReadmeChange: (v: string) => void;
  templateName: string;
  readOnly: boolean;
  dirty: boolean;
  controlsOpen: boolean;
  onControlsOpenChange: (open: boolean) => void;
  activeTab: string;
  onActiveTabChange: (tab: string) => void;
  onSave: () => void;
}

/** The tablet's scene designer, using the document designer's shell. */
export function SceneTabletView({
  scene,
  template,
  sampleJson,
  samplePanel,
  readme,
  onReadmeChange,
  templateName,
  readOnly,
  dirty,
  controlsOpen,
  onControlsOpenChange,
  activeTab,
  onActiveTabChange,
  onSave,
}: Props) {
  const { t } = useTranslation();
  const record = useMemo(() => firstRecordOf(sampleJson), [sampleJson]);
  const bindings = useMemo(() => allBindings(template), [template]);
  const { w, h } = pageDims(template.media);
  const selected = scene.selection
    ? getAt(template, scene.selection.path)
    : null;
  const selectedParent =
    scene.selection && scene.selection.path.length > 1
      ? (getAt(template, scene.selection.path.slice(0, -1)) ?? null)
      : null;

  const controls = (
    <>
      <Button
        variant="outline"
        className="w-full"
        onClick={() => onControlsOpenChange(true)}
      >
        <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
        {t("designer.settings")}
      </Button>
      <Sheet open={controlsOpen} onOpenChange={onControlsOpenChange}>
        <SheetContent
          side="bottom"
          className="flex max-h-[85dvh] w-full flex-col gap-0 p-0 pb-[env(safe-area-inset-bottom)]"
        >
          <DialogHeader className="border-b p-5 pr-12">
            <DialogTitle>{t("designer.settings")}</DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto p-5">
            <ControlsAccordion
              templates={[]}
              currentTemplateId={null}
              loadTemplate={() => undefined}
              templateName={templateName}
              setTemplateName={() => undefined}
              pageWidth={template.media.width_mm}
              setPageWidth={(v) =>
                scene.setMedia({ ...template.media, width_mm: v })
              }
              pageHeight={
                template.media.kind === "roll"
                  ? template.media.label_height_mm
                  : template.media.height_mm
              }
              setPageHeight={(v) =>
                template.media.kind === "roll"
                  ? scene.setMedia({
                      ...template.media,
                      label_height_mm: v,
                    })
                  : scene.setMedia({ ...template.media, height_mm: v })
              }
              presets={[]}
              showTemplates={false}
              showHelpers={false}
              openSections={["page", "sample"]}
              onOpenSectionsChange={() => undefined}
              samplePanel={samplePanel}
              fieldsPanel={
                <div className="flex flex-wrap gap-2">
                  {bindings.map((b) => (
                    <span key={b} className="text-xs text-muted-foreground">
                      {`{{${b}}}`}
                    </span>
                  ))}
                </div>
              }
            />
          </div>
          <DialogFooter className="border-t p-5 sm:space-x-0">
            <Button onClick={() => onControlsOpenChange(false)}>
              {t("designer.sheet_done")}
            </Button>
          </DialogFooter>
        </SheetContent>
      </Sheet>
    </>
  );

  return (
    <div className="space-y-4">
      {controls}
      <Tabs value={activeTab} onValueChange={onActiveTabChange}>
        <div className="sticky top-0 z-10 -mx-4 bg-background/95 px-4 py-2 backdrop-blur">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1 overflow-x-auto">
              <TabsList aria-label={t("designer.views_aria")}>
                <TabsTrigger value="canvas">{t("designer.canvas")}</TabsTrigger>
                <TabsTrigger value="elements">
                  {t("scene.elements")}
                </TabsTrigger>
                <TabsTrigger value="properties">
                  {t("scene.selected_element")}
                </TabsTrigger>
                <TabsTrigger value="readme">{t("scene.readme")}</TabsTrigger>
                <TabsTrigger value="preview">{t("scene.preview")}</TabsTrigger>
              </TabsList>
            </div>
            <Button
              size="sm"
              className="shrink-0"
              onClick={onSave}
              disabled={readOnly || !dirty}
            >
              <Save className="h-4 w-4" aria-hidden="true" />
              {t("common.save")}
            </Button>
          </div>
        </div>
        <TabsContent value="canvas" className="mt-0">
          <ZoomStage pageWidthMm={w} pageHeightMm={h}>
            {(zoom) => (
              <SceneCanvas
                template={template}
                selection={scene.selection}
                onSelect={scene.setSelection}
                onMove={scene.moveElement}
                onDragStart={scene.startDrag}
                onResize={scene.resizeElement}
                record={record}
                showSample
                dpi={scene.dpi}
                scale={MM_TO_PX * zoom}
              />
            )}
          </ZoomStage>
        </TabsContent>
        <TabsContent value="elements" className="mt-0">
          <Card>
            <CardContent className="flex flex-col gap-3 pt-5">
              <ElementList
                elements={template.elements}
                basePath={[]}
                selection={scene.selection}
                onSelect={scene.setSelection}
                onMove={scene.moveSibling}
                onDelete={scene.deleteElement}
              />
              <AddElement
                types={["text", "line", "rect"]}
                onAdd={(type) => scene.addElement([], type)}
              />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="properties" className="mt-0">
          {selected && (
            <SelectedElementPanel
              scene={scene}
              selected={selected}
              selectedParent={selectedParent}
              selectedPath={scene.selection?.path ?? []}
            />
          )}
        </TabsContent>
        <TabsContent value="readme" className="mt-0">
          <Card>
            <CardContent className="p-0">
              <ReadmePanel
                readme={readme}
                onChange={onReadmeChange}
                templateName={templateName}
                readOnly={readOnly}
              />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="preview" className="mt-0">
          <Card>
            <CardContent className="flex flex-col gap-3 pt-5">
              <Button
                variant="secondary"
                onClick={() => void scene.runPreview()}
                disabled={!scene.printerName || scene.preparing}
              >
                {scene.preparing ? t("scene.previewing") : t("scene.preview")}
              </Button>
              {scene.previewError && (
                <p className="text-body-sm text-danger">{scene.previewError}</p>
              )}
              {scene.preview && (
                <SceneBitmapPreview previews={scene.preview.preview ?? []} />
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
