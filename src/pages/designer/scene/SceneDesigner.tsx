/**
 * The scene track's designer body: the label page's canvas beside the
 * inspector cards (media, elements, the selected element, sample data,
 * the bound fields, and the prepared preview). The name, the save and
 * the template switcher live in the page's top bar. Ported from
 * PrintNinja-Next's `app/ui/src/screens/editor-screen.tsx`.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  Braces,
  Database,
  PanelLeftClose,
  Redo2,
  RefreshCw,
  Ruler,
  Undo2,
} from "lucide-react";
import { ReadmePanel } from "@/components/designer/ReadmePanel";
import { ControlsAccordion } from "@/components/designer/ControlsAccordion";
import {
  ControlsRail,
  type RailSection,
} from "@/components/designer/ControlsRail";
import type { DesignerLayout } from "@/components/designer/LayoutToggle";
import { MM_TO_PX, ZoomStage } from "@/components/designer/ZoomStage";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { useDesignerWorkspace } from "../useDesignerWorkspace";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  allBindings,
  ELEMENT_TYPES,
  firstRecordOf,
  getAt,
  pageDims,
} from "@/lib/scene/editor-model";
import type { Media } from "@/lib/scene/schema";
import { SceneBitmapPreview } from "./SceneBitmapPreview";
import { SceneCanvas } from "./SceneCanvas";
import { AddElement, ElementList } from "./ElementList";
import { SwitchRow } from "./Fields";
import { SelectedElementPanel } from "./SelectedElementPanel";
import type { useSceneTemplate } from "./useSceneTemplate";

export function SceneDesigner({
  scene,
  sampleJson,
  readme,
  onReadmeChange,
  templateName,
  readOnly = false,
  layout,
  workspace,
  samplePanel,
}: {
  scene: ReturnType<typeof useSceneTemplate>;
  sampleJson: string;
  readme: string;
  onReadmeChange: (v: string) => void;
  templateName: string;
  readOnly?: boolean;
  layout: DesignerLayout;
  workspace: ReturnType<typeof useDesignerWorkspace>;
  samplePanel: ReactNode;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const template = scene.template;
  const [showSample, setShowSample] = useState(true);
  const [preparedOn, setPreparedOn] = useState(false);
  const [stale, setStale] = useState(false);
  const runPreviewRef = useRef(scene.runPreview);
  runPreviewRef.current = scene.runPreview;

  const bindings = useMemo(
    () => (template ? allBindings(template) : []),
    [template],
  );
  const selected =
    template && scene.selection
      ? (getAt(template, scene.selection.path) ?? null)
      : null;
  /** The group or frame the selected element sits in, when not at the
   * root — its name goes in the panel header and its coordinates are
   * relative to it. */
  const selectedParent =
    template && scene.selection && scene.selection.path.length > 1
      ? (getAt(template, scene.selection.path.slice(0, -1)) ?? null)
      : null;
  /** The selected element's path; the element branches that need it only
   * render while the selection exists, so the fallback never runs. */
  const selectedPath = scene.selection?.path ?? [];
  const sampleRecord = useMemo(() => firstRecordOf(sampleJson), [sampleJson]);
  const previewInput = JSON.stringify(template);

  // Prepared preview follows edits, sample data and printer choice, with
  // the same debounce the document canvas uses. Off by default: opening a
  // label never runs the pipeline until the toggle is switched on.
  useEffect(() => {
    if (!preparedOn || !scene.printerName || !template) return;
    setStale(true);
    const timer = window.setTimeout(async () => {
      await runPreviewRef.current();
      setStale(false);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [preparedOn, previewInput, sampleJson, scene.printerName, template]);

  // Ctrl/Cmd+Z / Shift+Z (or Ctrl+Y) undo/redo; Delete removes the
  // selection; the arrow keys nudge it 0.1 mm (Shift: 1 mm).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) scene.redo();
        else scene.undo();
        return;
      }
      if (mod && (e.key === "y" || e.key === "Y") && !e.shiftKey) {
        e.preventDefault();
        scene.redo();
        return;
      }
      // Never steal keys from a text input.
      if (
        e.target instanceof HTMLElement &&
        e.target.closest("input, textarea, select")
      )
        return;
      if (!scene.selection) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        scene.deleteElement(scene.selection.path);
        return;
      }
      const step = e.shiftKey ? 1 : 0.1;
      let dx = 0;
      let dy = 0;
      if (e.key === "ArrowLeft") dx = -step;
      else if (e.key === "ArrowRight") dx = step;
      else if (e.key === "ArrowUp") dy = -step;
      else if (e.key === "ArrowDown") dy = step;
      else return;
      e.preventDefault();
      scene.nudge(dx, dy);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!template) return null;

  const media = template.media;
  const sizeLabel = t("scene.template_size", {
    w: media.width_mm,
    h: media.kind === "roll" ? media.label_height_mm : media.height_mm,
  });
  const changeMediaKind = (kind: Media["kind"]) => {
    if (kind === "roll")
      scene.setMedia({ kind, width_mm: media.width_mm, label_height_mm: 30 });
    else if (kind === "page")
      scene.setMedia({ kind, width_mm: 210, height_mm: 297 });
    else
      scene.setMedia({
        kind: "label",
        width_mm: media.width_mm,
        height_mm: 50,
      });
  };

  const railSections: RailSection[] = [
    { id: "page", labelKey: "designer.pageSetup", Icon: Ruler },
    { id: "sample", labelKey: "designer.sampleData", Icon: Database },
    { id: "fields", labelKey: "scene.data_fields", Icon: Braces },
  ];
  const mediaPanel = (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <Label>{t("scene.kind")}</Label>
        <Select
          value={media.kind}
          onValueChange={(v) => changeMediaKind(v as Media["kind"])}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="label">{t("scene.kind_label")}</SelectItem>
            <SelectItem value="roll">{t("scene.kind_roll")}</SelectItem>
            <SelectItem value="page">{t("scene.kind_page")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
  const fieldsPanel = (
    <div className="flex flex-wrap gap-2">
      {bindings.length === 0 ? (
        <p className="text-caption text-muted-foreground">
          {t("scene.data_fields_note")}
        </p>
      ) : (
        bindings.map((b) => (
          <Badge key={b} variant="outline">
            {`{{${b}}}`}
          </Badge>
        ))
      )}
    </div>
  );
  const controls = workspace.controlsExpanded ? (
    <aside
      aria-label={t("designer.controls_expanded")}
      className="flex w-panel shrink-0 flex-col overflow-hidden rounded-lg border bg-card"
    >
      <div className="flex h-11 shrink-0 items-center border-b px-2">
        <button
          type="button"
          aria-label={t("designer.collapse_controls")}
          title={t("designer.collapse_controls")}
          onClick={() => workspace.setControlsExpanded(false)}
          className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <PanelLeftClose className="h-3.5 w-3.5" aria-hidden="true" />
          {t("designer.collapse_short")}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ControlsAccordion
          templates={[]}
          currentTemplateId={null}
          loadTemplate={() => undefined}
          templateName={templateName}
          setTemplateName={() => undefined}
          pageWidth={media.width_mm}
          setPageWidth={(v) => scene.setMedia({ ...media, width_mm: v })}
          pageHeight={
            media.kind === "roll" ? media.label_height_mm : media.height_mm
          }
          setPageHeight={(v) =>
            media.kind === "roll"
              ? scene.setMedia({ ...media, label_height_mm: v })
              : scene.setMedia({ ...media, height_mm: v })
          }
          presets={[]}
          showTemplates={false}
          showHelpers={false}
          openSections={
            workspace.openSections.includes("sample")
              ? workspace.openSections
              : [...workspace.openSections, "sample"]
          }
          onOpenSectionsChange={workspace.setOpenSections}
          samplePanel={samplePanel}
          fieldsPanel={fieldsPanel}
          pageExtra={mediaPanel}
          className="rounded-none border-0 bg-transparent"
        />
      </div>
    </aside>
  ) : (
    <ControlsRail
      onOpenSection={workspace.openControlsSection}
      onExpand={() => workspace.setControlsExpanded(true)}
      sections={railSections}
    />
  );
  const canvas = (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-2">
      <ZoomStage
        pageWidthMm={pageDims(template.media).w}
        pageHeightMm={pageDims(template.media).h}
        fill
        toolbar={
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-body-sm text-muted-foreground">
              {sizeLabel}
            </span>
            <SwitchRow
              label={
                showSample
                  ? t("scene.show_sample_data")
                  : t("scene.show_fields")
              }
              checked={showSample}
              onCheckedChange={setShowSample}
            />
            {scene.printers.length === 0 ? (
              <Button
                variant="link"
                size="sm"
                className="h-8 px-1"
                onClick={() => navigate("/printers")}
              >
                {t("scene.add_printer")}
              </Button>
            ) : (
              <Select
                value={scene.printerName}
                onValueChange={scene.setPrinterName}
              >
                <SelectTrigger
                  aria-label={t("scene.pick_printer")}
                  className="h-8 w-44 text-xs"
                  title={t("scene.prepared_preview")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {scene.printers.map((p) => (
                    <SelectItem key={p.name} value={p.name}>
                      {p.name} · {p.dpi ?? 203} dpi
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <SwitchRow
              label={t("scene.prepared_preview")}
              checked={preparedOn}
              onCheckedChange={(on) => {
                if (on && !scene.printerName) return;
                setPreparedOn(on);
              }}
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("scene.undo")}
              onClick={scene.undo}
              disabled={!scene.canUndo}
            >
              <Undo2 className="h-4 w-4" aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("scene.redo")}
              onClick={scene.redo}
              disabled={!scene.canRedo}
            >
              <Redo2 className="h-4 w-4" aria-hidden="true" />
            </Button>
            <Button
              variant="secondary"
              size="icon"
              aria-label={t("scene.preview")}
              title={t("scene.preview")}
              onClick={() => {
                setStale(true);
                void scene.runPreview().then(() => setStale(false));
              }}
              disabled={!preparedOn || !scene.printerName || scene.preparing}
            >
              <RefreshCw
                className={scene.preparing ? "h-4 w-4 animate-spin" : "h-4 w-4"}
                aria-hidden="true"
              />
            </Button>
          </div>
        }
      >
        {(zoom) => (
          <SceneCanvas
            template={template}
            selection={scene.selection}
            onSelect={scene.setSelection}
            onMove={scene.moveElement}
            onDragStart={scene.startDrag}
            onResize={scene.resizeElement}
            record={sampleRecord}
            showSample={showSample}
            dpi={scene.dpi}
            scale={MM_TO_PX * zoom}
          />
        )}
      </ZoomStage>
    </div>
  );

  return (
    <div className="flex min-h-0 w-full flex-1 gap-4">
      {controls}
      {layout === "canvas" ? (
        <div className="min-h-0 min-w-0 flex-1">{canvas}</div>
      ) : (
        <ResizablePanelGroup
          key={`scene-${layout}`}
          direction={layout === "stacked" ? "vertical" : "horizontal"}
          autoSaveId={`printninja.scene.split.v1.${layout}`}
          className="min-w-0 flex-1"
        >
          <ResizablePanel
            id="inspector"
            order={1}
            defaultSize={45}
            minSize={25}
          >
            <div className="h-full min-h-0 pr-2">
              <Tabs defaultValue="elements" className="h-full">
                <TabsList aria-label={t("designer.views_aria")}>
                  <TabsTrigger value="elements">
                    {t("scene.elements")}
                  </TabsTrigger>
                  <TabsTrigger value="properties">
                    {t("scene.selected_element")}
                  </TabsTrigger>
                  <TabsTrigger value="readme">{t("scene.readme")}</TabsTrigger>
                  <TabsTrigger value="preview">
                    {t("scene.preview")}
                  </TabsTrigger>
                </TabsList>
                <TabsContent
                  value="readme"
                  className="mt-2 h-[calc(100%-2.5rem)] overflow-y-auto"
                >
                  <Card>
                    <CardHeader>
                      <CardTitle>{t("scene.readme")}</CardTitle>
                      <CardDescription>
                        {t("scene.readme_note")}
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <ReadmePanel
                        readme={readme}
                        onChange={onReadmeChange}
                        templateName={templateName}
                        readOnly={readOnly}
                      />
                    </CardContent>
                  </Card>
                </TabsContent>
                <TabsContent
                  value="elements"
                  className="mt-2 h-[calc(100%-2.5rem)] overflow-y-auto"
                >
                  <Card>
                    <CardHeader>
                      <CardTitle>{t("scene.elements")}</CardTitle>
                      <CardDescription>
                        {t("scene.elements_note")}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-3">
                      <ElementList
                        elements={template.elements}
                        basePath={[]}
                        selection={scene.selection}
                        onSelect={scene.setSelection}
                        onMove={scene.moveSibling}
                        onDelete={scene.deleteElement}
                      />
                      <AddElement
                        types={ELEMENT_TYPES}
                        onAdd={(type) => scene.addElement([], type)}
                      />
                    </CardContent>
                  </Card>
                </TabsContent>
                <TabsContent
                  value="properties"
                  className="mt-2 h-[calc(100%-2.5rem)] overflow-y-auto"
                >
                  {selected && (
                    <SelectedElementPanel
                      scene={scene}
                      selected={selected}
                      selectedParent={selectedParent}
                      selectedPath={selectedPath}
                    />
                  )}
                </TabsContent>
                <TabsContent
                  value="preview"
                  className="mt-2 h-[calc(100%-2.5rem)] overflow-y-auto"
                >
                  <Card>
                    <CardHeader>
                      <CardTitle>{t("scene.preview")}</CardTitle>
                      <CardDescription>
                        {t("scene.preview_note")}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-3">
                      {!preparedOn && (
                        <p className="text-body-sm text-muted-foreground">
                          {t("scene.prepared_preview")} —{" "}
                          {t("scene.preview_note")}
                        </p>
                      )}
                      {scene.printers.length === 0 && (
                        <div className="rounded-md bg-muted px-3 py-2 text-body-sm text-muted-foreground">
                          {t("scene.no_printers_preview")}
                        </div>
                      )}
                      {preparedOn && stale && (
                        <p className="text-body-sm text-muted-foreground">
                          {scene.preparing
                            ? t("scene.previewing")
                            : t("scene.preview_stale")}
                        </p>
                      )}
                      {scene.previewError && (
                        <div className="rounded-md bg-danger-soft px-3 py-2 text-body-sm text-danger">
                          {scene.previewError}
                        </div>
                      )}
                      {scene.preview && (
                        <>
                          <p className="text-body-sm text-muted-foreground">
                            {t("scene.pages", {
                              count: scene.preview.pages,
                            })}
                          </p>
                          <details className="text-caption text-muted-foreground">
                            <summary className="cursor-pointer">
                              {t("scene.preview_details")}
                            </summary>
                            <p className="mt-1 break-words">
                              {scene.preview.profile} · {scene.preview.path} ·{" "}
                              {scene.preview.bytes} B
                            </p>
                          </details>
                          {scene.preview.fallback && (
                            <div className="rounded-md bg-warning-soft px-3 py-2 text-body-sm text-warning">
                              {t("scene.fallback_note", {
                                path: t(
                                  `scene.path_${scene.preview.fallback === "pdf" ? "pdf" : scene.preview.fallback === "raster" ? "raster" : scene.preview.fallback === "browser" ? "browser" : "native"}`,
                                ),
                              })}
                            </div>
                          )}
                          {scene.preview.preview &&
                          scene.preview.preview.length > 0 ? (
                            <SceneBitmapPreview
                              previews={scene.preview.preview}
                            />
                          ) : (
                            <p className="text-body-sm text-muted-foreground">
                              {t("scene.preview_unavailable")}
                            </p>
                          )}
                        </>
                      )}
                    </CardContent>
                  </Card>
                </TabsContent>
              </Tabs>
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="canvas" order={2} defaultSize={55} minSize={25}>
            <div className="h-full pl-2">{canvas}</div>
          </ResizablePanel>
        </ResizablePanelGroup>
      )}
    </div>
  );
}
