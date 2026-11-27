import { useTranslation } from "react-i18next";
import { useParams, useSearchParams } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import { ExitViaPcButton } from "@/components/ExitViaPcButton";
import { isPrintViaPc } from "@/lib/printViaPc";
import {
  DESKTOP_QUERY,
  PHONE_QUERY,
  WIDE_QUERY,
  useMediaQuery,
} from "@/lib/hooks/useMediaQuery";
import { useShareStatus } from "@/lib/shell/useShareStatus";
import { isReadOnly } from "@/lib/share/sync";
import { agent } from "@/lib/agent/commands";
import { describeError } from "@/lib/errors";
import { notifyError, notifySuccess } from "@/lib/notify";
import { SampleDataPanel } from "@/components/designer/SampleDataPanel";
import type { PagePreset } from "@/components/designer/ControlsAccordion";
import { DEFAULT_MOCK_DATA } from "@/lib/templates/defaultTemplate";
import { PACKS } from "@/lib/templates/packs";
import { pickCanvasSample } from "@/lib/templates/mustacheCoverage";
import { useSampleDataset } from "./designer/useSampleDataset";
import {
  useDesignerDocument,
  type TemplateRow,
} from "./designer/useDesignerDocument";
import { useTemplateSync } from "./designer/useTemplateSync";
import { useNewTemplate } from "./designer/useNewTemplate";
import { useSceneTemplate } from "./designer/scene/useSceneTemplate";
import { useNewSceneTemplate } from "./designer/scene/NewSceneDialog";
import { useDesignerWorkspace } from "./designer/useDesignerWorkspace";
import { useDebouncedTemplate } from "./designer/useDebouncedTemplate";
import { DesignerTopBar } from "./designer/DesignerTopBar";
import { DesignerBody } from "./designer/DesignerBody";
import { DesignerDialogs } from "./designer/DesignerDialogs";
import type { Controls } from "./designer/DesignerWorkspace";

const PAGE_PRESETS: PagePreset[] = [
  { labelKey: "designer.preset_a4", width: 210, height: 297 },
  { labelKey: "designer.preset_a5", width: 148, height: 210 },
  { labelKey: "designer.preset_letter", width: 216, height: 279 },
  { labelKey: "designer.preset_roll80", width: 80, height: 200 },
  { labelKey: "designer.preset_roll58", width: 58, height: 200 },
  { labelKey: "designer.preset_label4x6", width: 102, height: 152 },
];

export function DesignerPage() {
  const { t } = useTranslation();
  const [barcodeOpen, setBarcodeOpen] = useState(false);
  // Which tab is open on a phone. On desktop the canvas and editor are always both on screen.
  const [activeTab, setActiveTab] = useState("canvas");
  // Print-via-PC mode: templates sync down, they are not drawn here.
  const [viaPc, setViaPc] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void isPrintViaPc()
      .then((v) => {
        if (!cancelled) setViaPc(v);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  // Phones get the read-only viewer (PLAN §6, D4); tablets keep the tabs.
  const isPhone = useMediaQuery(PHONE_QUERY);
  const isWide = useMediaQuery(WIDE_QUERY);
  // Offline the cache is view/print only: the server owns the copies, so
  // Save (and creating) has nowhere to go and stays disabled.
  const shareStatus = useShareStatus();
  const offline = shareStatus.state !== "online";

  const dataset = useSampleDataset();
  // The /template/:id deep link (Templates page Edit/View): open that
  // template instead of the first one.
  const routeId = useParams().id;
  const openTemplateId =
    routeId != null && /^\d+$/.test(routeId) ? Number(routeId) : null;
  const doc = useDesignerDocument(dataset.datasetsDirty, openTemplateId);
  const sync = useTemplateSync(doc, offline, dataset.commitDataset);
  const newTemplate = useNewTemplate({
    templates: doc.templates,
    offline,
    addTemplate: (tpl: TemplateRow) => {
      doc.contentLoaded.current.add(tpl.id);
      doc.setTemplates((prev) => [...prev, tpl]);
      doc.loadTemplate(tpl);
      doc.setCurrentTemplateDbId(tpl.id);
    },
  });
  // The scene track: the same open template, but when the row is a
  // scene the body is the label designer instead of the document
  // workspace (the track follows the printer class, PLAN WP4).
  const scene = useSceneTemplate({
    templates: doc.templates,
    setTemplates: doc.setTemplates,
    currentTemplateId: doc.currentTemplateId,
    setCurrentTemplateId: doc.setCurrentTemplateId,
    currentTemplateDbId: doc.currentTemplateDbId,
    setCurrentTemplateDbId: doc.setCurrentTemplateDbId,
    setTemplateName: doc.setTemplateName,
    sampleJson: dataset.workingDatasetJson,
  });
  const newScene = useNewSceneTemplate({
    templates: doc.templates,
    setTemplates: doc.setTemplates,
    setCurrentTemplateId: doc.setCurrentTemplateId,
    setCurrentTemplateDbId: doc.setCurrentTemplateDbId,
    currentTemplateId: doc.currentTemplateId,
    currentTemplateDbId: doc.currentTemplateDbId,
    scene,
    setSampleJson: dataset.setDraftDatasetJson,
  });
  const isScene = scene.template != null;
  /** Save the label, then fold a pending sample-data edit into the
   * same Save — the document track's Save already does both. */
  const saveScene = async () => {
    const id = await scene.save(doc.templateName, dataset.workingDatasetJson);
    if (id == null) return;
    try {
      if (doc.readme !== doc.savedReadme) {
        await agent("update_readme", { req: { id, readme: doc.readme } });
        doc.setSavedReadme(doc.readme);
      }
      await dataset.commitDataset();
    } catch (e) {
      notifyError(describeError(e));
    }
  };
  // Deep link from the Templates page: ?new=scene opens the new-label
  // dialog, ?new=document the new-document dialog. The param is cleared
  // once handled, so the effect no-ops on later renders.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const which = searchParams.get("new");
    if (which !== "scene" && which !== "document") return;
    if (which === "scene") newScene.openDialog();
    else newTemplate.openNewTemplateDialog();
    const next = new URLSearchParams(searchParams);
    next.delete("new");
    setSearchParams(next, { replace: true });
  });
  /** Run an action, asking first when either track has unsaved edits. */
  const guard = (action: () => void) => {
    const dirty =
      doc.dirty || (isScene && (scene.dirty || dataset.datasetsDirty));
    if (dirty) doc.setDiscardAction(() => action);
    else action();
  };
  // doc.switchTemplate only guards the html-side dirty; a scene edit has
  // its own mark, so the scene switch goes through the guard.
  const handleSwitchTemplate = (id: number) => {
    const tpl = doc.templates.find((r) => r.id === id);
    if (!tpl || id === doc.currentTemplateId) return;
    guard(() => doc.loadTemplate(tpl));
  };
  const workspace = useDesignerWorkspace(isWide);
  const debounced = useDebouncedTemplate(doc.htmlCode, doc.cssCode);
  const readOnly = isReadOnly({ origin: doc.origin });

  const sampleData = useMemo<Record<string, unknown>>(() => {
    try {
      return JSON.parse(dataset.workingDatasetJson);
    } catch {
      return DEFAULT_MOCK_DATA as Record<string, unknown>;
    }
  }, [dataset.workingDatasetJson]);

  // The canvas renders with the account's shared sample data. When that data
  // covers none of the template's mustaches — a kitchen ticket opened
  // against shipping-label data — the canvas would be all blanks, so it
  // falls back to the pack sample data that fits this template, and says
  // so. The moment the account data covers even one mustache it takes
  // over again, so editing the sample data always wins.
  const canvasSample = useMemo(
    () =>
      pickCanvasSample(
        debounced.debouncedHtml,
        sampleData,
        PACKS.map((p) => ({ name: p.name, mockData: p.mockData })),
      ),
    [debounced.debouncedHtml, sampleData],
  );
  const canvasData = canvasSample.data;
  const canvasSampleNote = canvasSample.packName
    ? t("designer.canvas_sample_note", { name: canvasSample.packName })
    : undefined;

  const handleShowCanvas = () => {
    setActiveTab("canvas");
    notifySuccess(t("designer.toast_showing_canvas"));
  };

  const renderSampleDataPanel = (canInsert: boolean) => (
    <SampleDataPanel
      onInsert={canInsert ? workspace.insertHelper : undefined}
      dataset={{
        name: dataset.activeDataset.name,
        json: dataset.workingDatasetJson,
      }}
      onEdit={() => {
        dataset.setEditJson(dataset.workingDatasetJson);
        dataset.setShowEditDataset(true);
      }}
    />
  );

  const controls: Controls = {
    templates: doc.templates,
    currentTemplateId: doc.currentTemplateId,
    loadTemplate: (tpl) => doc.unlessDiscarding(() => doc.loadTemplate(tpl)),
    templateName: doc.templateName,
    setTemplateName: doc.setTemplateName,
    pageWidth: doc.pageWidth,
    setPageWidth: doc.setPageWidth,
    pageHeight: doc.pageHeight,
    setPageHeight: doc.setPageHeight,
    presets: PAGE_PRESETS,
    onBarcode: () => setBarcodeOpen(true),
  };

  return (
    // On desktop the page fills the viewport (see Layout) and each pane scrolls on its own.
    <div className="space-y-4 lg:flex lg:min-h-0 lg:flex-1 lg:flex-col lg:gap-4 lg:space-y-0">
      <DesignerTopBar
        isDesktop={isDesktop}
        isPhone={isPhone}
        templates={doc.templates}
        currentTemplateId={doc.currentTemplateId}
        noTemplate={
          doc.templates.length === 0 || doc.currentTemplateDbId == null
        }
        onSwitchTemplate={isScene ? handleSwitchTemplate : doc.switchTemplate}
        nameError={doc.nameError}
        dirty={
          isScene
            ? scene.dirty ||
              dataset.datasetsDirty ||
              doc.readme !== doc.savedReadme
            : doc.dirty
        }
        layout={workspace.layout}
        onLayoutChange={workspace.setLayout}
        onSave={isScene ? () => void saveScene() : () => void sync.handleSave()}
        saveDisabled={
          isScene ? !!doc.nameError : offline || readOnly || !!doc.nameError
        }
        saveTitle={
          !isScene && offline ? t("designer.save_offline_title") : undefined
        }
        readOnly={readOnly}
        templateName={doc.templateName}
        onTemplateNameChange={doc.setTemplateName}
        remoteId={isScene ? null : doc.remoteId}
        publishedAt={isScene ? null : doc.publishedAt}
        pending={sync.pending}
        onVisibilityChange={sync.handleVisibilityChange}
        onHistory={() => sync.setHistoryOpen(true)}
      />

      {viaPc && (
        <div
          data-testid="designer-via-pc-note"
          className="flex items-center gap-3 rounded-lg border border-info/30 bg-info-soft px-4 py-3 text-info"
        >
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{t("designer.via_pc_note")}</p>
          </div>
          <ExitViaPcButton onExited={() => setViaPc(false)} />
        </div>
      )}

      <DesignerBody
        isDesktop={isDesktop}
        isPhone={isPhone}
        doc={doc}
        sync={sync}
        isScene={isScene}
        scene={scene}
        sampleJson={dataset.workingDatasetJson}
        workspace={workspace}
        debounced={debounced}
        controls={controls}
        samplePanel={renderSampleDataPanel}
        canvasData={canvasData}
        canvasSampleNote={canvasSampleNote}
        sampleData={sampleData}
        offline={offline}
        readOnly={readOnly}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        handleShowCanvas={handleShowCanvas}
        onSceneSave={saveScene}
      />

      <DesignerDialogs
        barcodeOpen={barcodeOpen}
        setBarcodeOpen={setBarcodeOpen}
        doc={doc}
        sync={sync}
        dataset={dataset}
        newTemplate={newTemplate}
        newScene={newScene}
        insertHelper={workspace.insertHelper}
        offline={offline}
        readOnly={readOnly}
      />
    </div>
  );
}
