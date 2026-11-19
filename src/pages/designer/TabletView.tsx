import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Save, SlidersHorizontal } from "lucide-react";
import { CanvasWorkspace } from "@/components/designer/CanvasWorkspace";
import { CodeEditors } from "@/components/designer/EditorPane";
import { ControlsAccordion } from "@/components/designer/ControlsAccordion";
import { ReadmePanel } from "@/components/designer/ReadmePanel";
import { HelpersPanel } from "@/components/designer/HelpersPanel";
import { DesignerActions } from "@/components/designer/DesignerActions";
import { ClassWarnings } from "@/components/designer/ClassWarnings";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { SyncAction } from "./useTemplateSync";
import type { Controls } from "./DesignerWorkspace";

/**
 * The tablet view: the canvas is the first thing on screen, the controls
 * live in a bottom sheet opened from a single button, and the rest of
 * the page is a set of sticky view tabs (canvas / code / README / sample
 * data) with a reachable Save.
 */
export function TabletView({
  controls,
  controlsOpen,
  onControlsOpenChange,
  activeTab,
  onActiveTabChange,
  templateName,
  htmlCode,
  cssCode,
  onHtmlChange,
  onCssChange,
  readme,
  onReadmeChange,
  readOnly,
  offline,
  pending,
  onSave,
  debouncedHtml,
  debouncedCss,
  compiledCss,
  canvasData,
  canvasSampleNote,
  pageWidthMm,
  pageHeightMm,
  samplePanel,
  onShowCanvas,
}: {
  controls: Controls;
  controlsOpen: boolean;
  onControlsOpenChange: (open: boolean) => void;
  activeTab: string;
  onActiveTabChange: (tab: string) => void;
  templateName: string;
  htmlCode: string;
  cssCode: string;
  onHtmlChange: (v: string) => void;
  onCssChange: (v: string) => void;
  readme: string;
  onReadmeChange: (v: string) => void;
  readOnly: boolean;
  offline: boolean;
  pending: SyncAction | null;
  onSave: () => void;
  debouncedHtml: string;
  debouncedCss: string;
  compiledCss: string;
  canvasData: Record<string, unknown>;
  canvasSampleNote?: string;
  pageWidthMm: number;
  pageHeightMm: number;
  samplePanel: ReactNode;
  onShowCanvas: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="space-y-4">
      {/* The canvas is the first thing on screen: controls live in a
          bottom sheet opened from this single button. */}
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
            <DialogDescription>
              {t("designer.settings_description")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto p-5">
            <ControlsAccordion
              {...controls}
              showHelpers={false}
              defaultOpen={[]}
            />
          </div>
          <DialogFooter className="gap-2 border-t p-5 sm:space-x-0">
            <Button onClick={() => onControlsOpenChange(false)}>
              {t("designer.sheet_done")}
            </Button>
          </DialogFooter>
        </SheetContent>
      </Sheet>

      <Tabs
        value={activeTab}
        onValueChange={onActiveTabChange}
        className="space-y-4"
      >
        {/* Sticky view tabs + Save, so switching views and saving the
            tweak never need a scroll-up. The header
            keeps the full toolbar; this is the reachable shortcut. */}
        <div className="sticky top-0 z-10 -mx-4 bg-background/95 px-4 py-2 backdrop-blur">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1 overflow-x-auto">
              <TabsList
                aria-label={t("designer.views_aria")}
                className="min-h-8 w-max gap-0.5 p-0.5"
              >
                <TabsTrigger value="canvas" className="min-h-11 px-3 text-xs">
                  {t("designer.canvas")}
                </TabsTrigger>
                <TabsTrigger value="code" className="min-h-11 px-3 text-xs">
                  {t("designer.code")}
                </TabsTrigger>
                <TabsTrigger value="readme" className="min-h-11 px-3 text-xs">
                  README
                </TabsTrigger>
                <TabsTrigger
                  value="sample-data"
                  className="min-h-11 px-3 text-xs"
                >
                  {t("designer.sampleData")}
                </TabsTrigger>
              </TabsList>
            </div>
            {!readOnly && (
              <Button
                size="sm"
                className="shrink-0"
                onClick={onSave}
                disabled={offline || pending != null}
              >
                <Save className="h-4 w-4" aria-hidden="true" />
                {t("common.save")}
              </Button>
            )}
          </div>
        </div>

        <TabsContent value={activeTab} className="mt-0 space-y-4">
          {(activeTab === "canvas" || activeTab === "code") && (
            <ClassWarnings html={debouncedHtml} />
          )}
          {activeTab === "canvas" && (
            <CanvasWorkspace
              fill={false}
              html={debouncedHtml}
              css={debouncedCss}
              compiledCss={compiledCss}
              data={canvasData}
              sampleNote={canvasSampleNote}
              pageWidthMm={pageWidthMm}
              pageHeightMm={pageHeightMm}
            />
          )}
          {activeTab === "code" && (
            <CodeEditors
              templateName={templateName}
              htmlCode={htmlCode}
              cssCode={cssCode}
              onHtmlChange={onHtmlChange}
              onCssChange={onCssChange}
            />
          )}
          {activeTab === "readme" && (
            <Card className="overflow-hidden">
              <CardContent className="p-0">
                <ReadmePanel
                  readme={readme}
                  onChange={onReadmeChange}
                  templateName={templateName}
                  readOnly={readOnly}
                />
              </CardContent>
            </Card>
          )}
          {activeTab === "sample-data" && (
            <Card>
              <CardContent className="space-y-4 pt-5">
                {samplePanel}
                <div className="space-y-2 border-t pt-3">
                  <h3 className="text-xs font-semibold">
                    {t("designer.helpers")}
                  </h3>
                  <HelpersPanel />
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <DesignerActions onShowCanvas={onShowCanvas} />
      </Tabs>
    </div>
  );
}
