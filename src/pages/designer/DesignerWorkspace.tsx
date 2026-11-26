import type { ReactNode, Ref } from "react";
import { useTranslation } from "react-i18next";
import { PanelLeftClose } from "lucide-react";
import { CanvasWorkspace } from "@/components/designer/CanvasWorkspace";
import {
  EditorPane,
  type EditorPaneHandle,
} from "@/components/designer/EditorPane";
import {
  ControlsAccordion,
  type PagePreset,
} from "@/components/designer/ControlsAccordion";
import {
  ControlsRail,
  type ControlsSection,
} from "@/components/designer/ControlsRail";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import type { DesignerLayout } from "@/components/designer/LayoutToggle";
import { ClassWarnings } from "@/components/designer/ClassWarnings";
import { OfflinePrintHint } from "@/components/designer/OfflinePrintHint";
import type { TemplateRow } from "./useDesignerDocument";

/** The controls column's inputs; the tablet sheet takes the same object. */
export type Controls = {
  templates: TemplateRow[];
  currentTemplateId: number | null;
  loadTemplate: (tpl: TemplateRow) => void;
  templateName: string;
  setTemplateName: (v: string) => void;
  pageWidth: number;
  setPageWidth: (v: number) => void;
  pageHeight: number;
  setPageHeight: (v: number) => void;
  presets: PagePreset[];
  onBarcode: () => void;
};

/**
 * The desktop workspace: the controls column (or its icon rail) beside
 * the canvas and the editor, which the person can stack, split or hide
 * with the layout toggle. Each pane scrolls on its own.
 */
export function DesignerWorkspace({
  controls,
  openSections,
  onOpenSectionsChange,
  controlsExpanded,
  onControlsExpandedChange,
  onOpenSection,
  onInsertHelper,
  samplePanel,
  layout,
  editorRef,
  templateName,
  htmlCode,
  cssCode,
  onHtmlChange,
  onCssChange,
  readme,
  onReadmeChange,
  readmeReadOnly,
  debouncedHtml,
  debouncedCss,
  compiledCss,
  canvasData,
  canvasSampleNote,
  pageWidthMm,
  pageHeightMm,
}: {
  controls: Controls;
  openSections: string[];
  onOpenSectionsChange: (sections: string[]) => void;
  controlsExpanded: boolean;
  onControlsExpandedChange: (expanded: boolean) => void;
  onOpenSection: (section: ControlsSection) => void;
  onInsertHelper: (text: string) => void;
  samplePanel: ReactNode;
  layout: DesignerLayout;
  editorRef: Ref<EditorPaneHandle>;
  templateName: string;
  htmlCode: string;
  cssCode: string;
  onHtmlChange: (v: string) => void;
  onCssChange: (v: string) => void;
  readme: string;
  onReadmeChange: (v: string) => void;
  readmeReadOnly: boolean;
  debouncedHtml: string;
  debouncedCss: string;
  compiledCss: string;
  canvasData: Record<string, unknown>;
  canvasSampleNote?: string;
  pageWidthMm: number;
  pageHeightMm: number;
}) {
  const { t } = useTranslation();

  const editorPane = (padding: string) => (
    <div className={`flex h-full min-h-0 flex-col gap-2 ${padding}`}>
      <EditorPane
        ref={editorRef}
        className="flex-1"
        templateName={templateName}
        htmlCode={htmlCode}
        cssCode={cssCode}
        onHtmlChange={onHtmlChange}
        onCssChange={onCssChange}
        readme={readme}
        onReadmeChange={onReadmeChange}
        readmeReadOnly={readmeReadOnly}
        notices={
          <>
            <ClassWarnings html={debouncedHtml} />
            <div className="mt-1.5">
              <OfflinePrintHint />
            </div>
          </>
        }
      />
    </div>
  );

  const canvas = (fill: boolean) => (
    <CanvasWorkspace
      fill={fill}
      html={debouncedHtml}
      css={debouncedCss}
      compiledCss={compiledCss}
      data={canvasData}
      sampleNote={canvasSampleNote}
      pageWidthMm={pageWidthMm}
      pageHeightMm={pageHeightMm}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 gap-4">
      {controlsExpanded ? (
        // One full-height panel, like the editor and canvas beside it: the
        // collapse button lives in its header so all three tops line up,
        // and the sections scroll inside it instead of leaving a gap below.
        <aside
          aria-label={t("designer.controls_expanded")}
          className="flex w-panel shrink-0 flex-col overflow-hidden rounded-lg border bg-card"
        >
          <div className="flex h-11 shrink-0 items-center border-b px-2">
            <button
              type="button"
              aria-label={t("designer.collapse_controls")}
              title={t("designer.collapse_controls")}
              onClick={() => onControlsExpandedChange(false)}
              className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <PanelLeftClose className="h-3.5 w-3.5" aria-hidden="true" />
              {t("designer.collapse_short")}
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ControlsAccordion
              {...controls}
              showTemplates={false}
              openSections={openSections}
              onOpenSectionsChange={onOpenSectionsChange}
              onInsertHelper={onInsertHelper}
              samplePanel={samplePanel}
              className="rounded-none border-0 bg-transparent"
            />
          </div>
        </aside>
      ) : (
        <ControlsRail
          onOpenSection={onOpenSection}
          onExpand={() => onControlsExpandedChange(true)}
        />
      )}
      {layout === "canvas" ? (
        <div className="min-h-0 min-w-0 flex-1">{canvas(true)}</div>
      ) : (
        <ResizablePanelGroup
          key={layout}
          direction={layout === "stacked" ? "vertical" : "horizontal"}
          autoSaveId={`printninja.designer.split.v3.${layout}`}
          className="min-w-0 flex-1"
        >
          <ResizablePanel
            id="editor"
            order={1}
            defaultSize={layout === "stacked" ? 55 : 45}
            minSize={30}
          >
            {editorPane(layout === "stacked" ? "pb-2" : "pr-2")}
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel
            id="canvas"
            order={2}
            defaultSize={layout === "stacked" ? 45 : 55}
            minSize={25}
          >
            <div
              className={layout === "stacked" ? "h-full pt-2" : "h-full pl-2"}
            >
              {canvas(true)}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      )}
    </div>
  );
}
