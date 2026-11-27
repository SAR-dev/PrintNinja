import { useTranslation } from "react-i18next";
import { useState } from "react";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/EmptyState";
import { PhoneDesignerViewer } from "@/components/designer/PhoneDesignerViewer";
import { DesignerWorkspace, type Controls } from "./DesignerWorkspace";
import { TabletView } from "./TabletView";
import { SceneDesigner } from "./scene/SceneDesigner";
import { ScenePreview } from "./scene/ScenePreview";
import type { useDesignerDocument } from "./useDesignerDocument";
import type { useTemplateSync } from "./useTemplateSync";
import type { useDesignerWorkspace } from "./useDesignerWorkspace";
import type { useDebouncedTemplate } from "./useDebouncedTemplate";
import type { useSceneTemplate } from "./scene/useSceneTemplate";

/**
 * The main body under the top bar: the list-loading and no-template
 * states, then the desktop workspace, the phone's read-only viewer, or
 * the tablet's tabs. The phone's controls sheet is local state; the
 * tablet's active tab lives on the page so Show-canvas can jump to it.
 */
export function DesignerBody({
  isDesktop,
  isPhone,
  doc,
  sync,
  isScene,
  scene,
  sampleJson,
  workspace,
  debounced,
  controls,
  samplePanel,
  canvasData,
  canvasSampleNote,
  sampleData,
  offline,
  readOnly,
  activeTab,
  setActiveTab,
  handleShowCanvas,
}: {
  isDesktop: boolean;
  isPhone: boolean;
  doc: ReturnType<typeof useDesignerDocument>;
  sync: ReturnType<typeof useTemplateSync>;
  /** The open template is a scene (label) track row: the body is the
   * label designer (canvas + inspector) instead of the document views. */
  isScene: boolean;
  scene: ReturnType<typeof useSceneTemplate>;
  /** The sample data as the dataset edits it; the scene track edits it
   * in a plain textarea, the document track in the dataset dialog. */
  sampleJson: string;
  workspace: ReturnType<typeof useDesignerWorkspace>;
  debounced: ReturnType<typeof useDebouncedTemplate>;
  controls: Controls;
  samplePanel: (canInsert: boolean) => React.ReactNode;
  canvasData: Record<string, unknown>;
  canvasSampleNote: string | undefined;
  sampleData: Record<string, unknown>;
  offline: boolean;
  readOnly: boolean;
  activeTab: string;
  setActiveTab: (tab: string) => void;
  handleShowCanvas: () => void;
}) {
  const { t } = useTranslation();
  // Phone: Templates / Page Setup / Custom input live in a bottom sheet
  // opened from a single Settings button.
  const [controlsOpen, setControlsOpen] = useState(false);
  const sceneTemplate = isScene ? scene.template : null;

  return doc.templatesLoading ? (
    <p className="text-sm text-muted-foreground" role="status">
      {t("common.loading")}
    </p>
  ) : doc.templates.length === 0 ? (
    <Card>
      {/* The Designer opens and edits templates; it no longer creates
          them. Creation lives on the Templates page (the single
          creation point), which deep-links back here with
          ?new=scene|document. */}
      <EmptyState
        title={t("designer.no_templates_yet")}
        description={t("designer.no_templates_hint")}
      />
    </Card>
  ) : sceneTemplate ? (
    // The scene track: phones see the label page read-only, desktop and
    // tablet the full designer (the canvas beside the inspector cards).
    isPhone ? (
      <ScenePreview
        template={sceneTemplate}
        dpi={scene.dpi}
        sampleJson={sampleJson}
        samplePanel={samplePanel(false)}
        dirty={scene.dirty}
        templateName={doc.templateName}
      />
    ) : (
      <div className="min-h-0 flex-1 pb-4">
        <SceneDesigner
          scene={scene}
          sampleJson={sampleJson}
          readme={doc.readme}
          onReadmeChange={doc.setReadme}
          templateName={doc.templateName}
          readOnly={readOnly}
          layout={workspace.layout}
          workspace={workspace}
          samplePanel={samplePanel(false)}
        />
      </div>
    )
  ) : isDesktop ? (
    <DesignerWorkspace
      controls={controls}
      openSections={workspace.openSections}
      onOpenSectionsChange={workspace.setOpenSections}
      controlsExpanded={workspace.controlsExpanded}
      onControlsExpandedChange={workspace.setControlsExpanded}
      onOpenSection={workspace.openControlsSection}
      onInsertHelper={workspace.insertHelper}
      samplePanel={samplePanel(true)}
      layout={workspace.layout}
      editorRef={workspace.editorRef}
      templateName={doc.templateName}
      htmlCode={doc.htmlCode}
      cssCode={doc.cssCode}
      onHtmlChange={doc.setHtmlCode}
      onCssChange={doc.setCssCode}
      readme={doc.readme}
      onReadmeChange={doc.setReadme}
      readmeReadOnly={readOnly}
      debouncedHtml={debounced.debouncedHtml}
      debouncedCss={debounced.debouncedCss}
      compiledCss={debounced.compiledCss}
      canvasData={canvasData}
      canvasSampleNote={canvasSampleNote}
      pageWidthMm={doc.pageWidth}
      pageHeightMm={doc.pageHeight}
    />
  ) : isPhone ? (
    // Phones: read-only viewer — preview, sample data (the one edit a
    // phone makes), README, code and details. PLAN §6, D4.
    <PhoneDesignerViewer
      templateName={doc.templateName}
      pageWidthMm={doc.pageWidth}
      pageHeightMm={doc.pageHeight}
      html={doc.htmlCode}
      css={doc.cssCode}
      debouncedHtml={debounced.debouncedHtml}
      debouncedCss={debounced.debouncedCss}
      compiledCss={debounced.compiledCss}
      sampleData={sampleData}
      samplePanel={samplePanel(false)}
      readme={doc.readme}
      dirty={doc.dirty}
      offline={offline}
      readOnly={readOnly}
      nameError={doc.nameError}
      hasTemplate={doc.currentTemplateDbId != null}
      published={!!doc.remoteId && !!doc.publishedAt}
      publishedAt={doc.publishedAt}
      saving={sync.pending === "save"}
      onSave={() => void sync.handleSave()}
    />
  ) : (
    <TabletView
      controls={controls}
      controlsOpen={controlsOpen}
      onControlsOpenChange={setControlsOpen}
      activeTab={activeTab}
      onActiveTabChange={setActiveTab}
      templateName={doc.templateName}
      htmlCode={doc.htmlCode}
      cssCode={doc.cssCode}
      onHtmlChange={doc.setHtmlCode}
      onCssChange={doc.setCssCode}
      readme={doc.readme}
      onReadmeChange={doc.setReadme}
      readOnly={readOnly}
      offline={offline}
      pending={sync.pending}
      onSave={() => void sync.handleSave()}
      debouncedHtml={debounced.debouncedHtml}
      debouncedCss={debounced.debouncedCss}
      compiledCss={debounced.compiledCss}
      canvasData={canvasData}
      canvasSampleNote={canvasSampleNote}
      pageWidthMm={doc.pageWidth}
      pageHeightMm={doc.pageHeight}
      samplePanel={samplePanel(false)}
      onShowCanvas={handleShowCanvas}
    />
  );
}
