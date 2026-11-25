/**
 * The scene track's designer body: the label page's canvas beside the
 * inspector cards (media, elements, the selected element, sample data,
 * the bound fields, and the prepared preview). The name, the save and
 * the template switcher live in the page's top bar. Ported from
 * PrintNinja-Next's `app/ui/src/screens/editor-screen.tsx`.
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Redo2, Undo2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  allBindings,
  elementLabel,
  ELEMENT_TYPES,
  firstRecordOf,
  getAt,
  NESTED_ELEMENT_TYPES,
} from "@/lib/scene/editor-model";
import type { Align, BarcodeKind, Media } from "@/lib/scene/schema";
import { SceneBitmapPreview } from "./SceneBitmapPreview";
import { SceneCanvas } from "./SceneCanvas";
import { AddElement, ElementList } from "./ElementList";
import { NumField, PlacementSelect, SwitchRow } from "./Fields";
import type { useSceneTemplate } from "./useSceneTemplate";

export function SceneDesigner({
  scene,
  sampleJson,
  onSampleJsonChange,
}: {
  scene: ReturnType<typeof useSceneTemplate>;
  sampleJson: string;
  onSampleJsonChange: (v: string) => void;
}) {
  const { t } = useTranslation();
  const template = scene.template;
  const [showSample, setShowSample] = useState(true);

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

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2">
        <Badge>scene</Badge>
        <span className="text-body-sm text-muted-foreground">{sizeLabel}</span>
        <div className="ml-auto flex items-center gap-1">
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
            onClick={() => void scene.runPreview()}
            disabled={scene.preparing}
          >
            {scene.preparing ? t("scene.previewing") : t("scene.preview")}
          </Button>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>{t("scene.page")}</CardTitle>
              <CardDescription>{t("scene.page_note")}</CardDescription>
            </CardHeader>
            <CardContent>
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
              />
              <div className="mt-3">
                <SwitchRow
                  label={
                    showSample
                      ? t("scene.show_sample_data")
                      : t("scene.show_fields")
                  }
                  checked={showSample}
                  onCheckedChange={setShowSample}
                />
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>{t("scene.media")}</CardTitle>
              <CardDescription>{t("scene.media_note")}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
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
                    <SelectItem value="label">
                      {t("scene.kind_label")}
                    </SelectItem>
                    <SelectItem value="roll">{t("scene.kind_roll")}</SelectItem>
                    <SelectItem value="page">{t("scene.kind_page")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <NumField
                  id="m-w"
                  label={t("scene.width_mm")}
                  value={media.width_mm}
                  onChange={(v) => scene.setMedia({ ...media, width_mm: v })}
                />
                <NumField
                  id="m-h"
                  label={
                    media.kind === "roll"
                      ? t("scene.label_height_mm")
                      : t("scene.height_mm")
                  }
                  value={
                    media.kind === "roll"
                      ? media.label_height_mm
                      : media.height_mm
                  }
                  onChange={(v) =>
                    media.kind === "roll"
                      ? scene.setMedia({ ...media, label_height_mm: v })
                      : scene.setMedia({ ...media, height_mm: v })
                  }
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("scene.elements")}</CardTitle>
              <CardDescription>{t("scene.elements_note")}</CardDescription>
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

          {selected && (
            <Card className="max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:z-40 max-md:max-h-[60dvh] max-md:overflow-y-auto max-md:rounded-b-none max-md:border-b-0 max-md:shadow-2xl">
              <CardHeader className="max-md:pt-5">
                <div className="mx-auto mb-1 h-1 w-10 rounded-full bg-muted md:hidden" />
                <CardTitle className="flex items-center justify-between gap-2">
                  {t("scene.selected_element")}
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("common.close")}
                    className="md:hidden"
                    onClick={() => scene.setSelection(null)}
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </CardTitle>
                <CardDescription>
                  {selectedParent
                    ? `${elementLabel(selectedParent)} — ${elementLabel(selected)}`
                    : elementLabel(selected)}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <div className="grid grid-cols-2 gap-3">
                  <NumField
                    id="el-x"
                    label={t("scene.x_mm")}
                    value={selected.at.x_mm}
                    onChange={(v) =>
                      scene.updateSelected((el) => ({
                        ...el,
                        at: { ...el.at, x_mm: v },
                      }))
                    }
                  />
                  <NumField
                    id="el-y"
                    label={t("scene.y_mm")}
                    value={selected.at.y_mm}
                    onChange={(v) =>
                      scene.updateSelected((el) => ({
                        ...el,
                        at: { ...el.at, y_mm: v },
                      }))
                    }
                  />
                </div>
                {selectedParent && (
                  <span className="-mt-2 text-caption text-muted-foreground">
                    {t("scene.coords_relative")}
                  </span>
                )}

                {/* A frame decides which page its children appear on,
                    so a child in a frame cannot choose one. */}
                {selected.type !== "group" &&
                  selectedParent?.type !== "frame" && (
                    <PlacementSelect
                      value={selected.page ?? "every"}
                      onChange={(p) =>
                        scene.updateSelected((el) => ({ ...el, page: p }))
                      }
                    />
                  )}

                {selected.type === "text" && (
                  <div className="flex flex-col gap-3">
                    <div className="flex flex-col gap-1">
                      <Label>{t("scene.content")}</Label>
                      <Textarea
                        rows={2}
                        spellCheck={false}
                        value={selected.content}
                        onChange={(e) =>
                          scene.updateSelected((el) =>
                            el.type === "text"
                              ? { ...el, content: e.target.value }
                              : el,
                          )
                        }
                      />
                      <span className="text-caption text-muted-foreground">
                        {t("scene.content_note", { field: "{{name}}" })}
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                      <NumField
                        id="t-w"
                        label={t("scene.width_mm")}
                        value={selected.size.w_mm}
                        onChange={(v) =>
                          scene.updateSelected((el) =>
                            el.type === "text"
                              ? { ...el, size: { ...el.size, w_mm: v } }
                              : el,
                          )
                        }
                      />
                      <NumField
                        id="t-h"
                        label={t("scene.height_mm")}
                        value={selected.size.h_mm}
                        onChange={(v) =>
                          scene.updateSelected((el) =>
                            el.type === "text"
                              ? { ...el, size: { ...el.size, h_mm: v } }
                              : el,
                          )
                        }
                      />
                      <NumField
                        id="t-size"
                        label={t("scene.text_size_mm")}
                        value={selected.style.size_mm}
                        step={0.5}
                        onChange={(v) =>
                          scene.updateSelected((el) =>
                            el.type === "text"
                              ? {
                                  ...el,
                                  style: { ...el.style, size_mm: v },
                                }
                              : el,
                          )
                        }
                      />
                    </div>
                    <div className="flex items-end gap-3">
                      <div className="flex flex-1 flex-col gap-1">
                        <Label>{t("scene.align")}</Label>
                        <Select
                          value={selected.style.align ?? "left"}
                          onValueChange={(v) =>
                            scene.updateSelected((el) =>
                              el.type === "text"
                                ? {
                                    ...el,
                                    style: { ...el.style, align: v as Align },
                                  }
                                : el,
                            )
                          }
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="left">
                              {t("scene.align_left")}
                            </SelectItem>
                            <SelectItem value="center">
                              {t("scene.align_center")}
                            </SelectItem>
                            <SelectItem value="right">
                              {t("scene.align_right")}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <div className="flex gap-5">
                      <SwitchRow
                        label={t("scene.bold")}
                        checked={!!selected.style.bold}
                        onCheckedChange={(v) =>
                          scene.updateSelected((el) =>
                            el.type === "text"
                              ? { ...el, style: { ...el.style, bold: v } }
                              : el,
                          )
                        }
                      />
                      <SwitchRow
                        label={t("scene.italic")}
                        checked={!!selected.style.italic}
                        onCheckedChange={(v) =>
                          scene.updateSelected((el) =>
                            el.type === "text"
                              ? {
                                  ...el,
                                  style: { ...el.style, italic: v },
                                }
                              : el,
                          )
                        }
                      />
                    </div>
                  </div>
                )}

                {selected.type === "line" && (
                  <div className="flex flex-col gap-3">
                    <div className="grid grid-cols-2 gap-3">
                      <NumField
                        id="l-len"
                        label={t("scene.length_mm")}
                        value={selected.length_mm}
                        onChange={(v) =>
                          scene.updateSelected((el) =>
                            el.type === "line" ? { ...el, length_mm: v } : el,
                          )
                        }
                      />
                      <NumField
                        id="l-th"
                        label={t("scene.thickness_mm")}
                        step={0.05}
                        value={selected.thickness_mm}
                        onChange={(v) =>
                          scene.updateSelected((el) =>
                            el.type === "line"
                              ? { ...el, thickness_mm: v }
                              : el,
                          )
                        }
                      />
                    </div>
                    <SwitchRow
                      label={t("scene.vertical")}
                      checked={!!selected.vertical}
                      onCheckedChange={(v) =>
                        scene.updateSelected((el) =>
                          el.type === "line" ? { ...el, vertical: v } : el,
                        )
                      }
                    />
                  </div>
                )}

                {selected.type === "rect" && (
                  <div className="flex flex-col gap-3">
                    <div className="grid grid-cols-2 gap-3">
                      <NumField
                        id="r-w"
                        label={t("scene.width_mm")}
                        value={selected.size.w_mm}
                        onChange={(v) =>
                          scene.updateSelected((el) =>
                            el.type === "rect"
                              ? { ...el, size: { ...el.size, w_mm: v } }
                              : el,
                          )
                        }
                      />
                      <NumField
                        id="r-h"
                        label={t("scene.height_mm")}
                        value={selected.size.h_mm}
                        onChange={(v) =>
                          scene.updateSelected((el) =>
                            el.type === "rect"
                              ? { ...el, size: { ...el.size, h_mm: v } }
                              : el,
                          )
                        }
                      />
                    </div>
                    <SwitchRow
                      label={t("scene.filled")}
                      checked={!!selected.fill}
                      onCheckedChange={(v) =>
                        scene.updateSelected((el) =>
                          el.type === "rect" ? { ...el, fill: v } : el,
                        )
                      }
                    />
                  </div>
                )}

                {(selected.type === "barcode" || selected.type === "qr") && (
                  <div className="flex flex-col gap-3">
                    {selected.type === "barcode" && (
                      <div className="grid grid-cols-3 gap-3">
                        <NumField
                          id="b-w"
                          label={t("scene.width_mm")}
                          value={selected.size.w_mm}
                          onChange={(v) =>
                            scene.updateSelected((el) =>
                              el.type === "barcode"
                                ? { ...el, size: { ...el.size, w_mm: v } }
                                : el,
                            )
                          }
                        />
                        <NumField
                          id="b-h"
                          label={t("scene.height_mm")}
                          value={selected.size.h_mm}
                          onChange={(v) =>
                            scene.updateSelected((el) =>
                              el.type === "barcode"
                                ? { ...el, size: { ...el.size, h_mm: v } }
                                : el,
                            )
                          }
                        />
                        <div className="flex flex-col gap-1">
                          <Label>{t("scene.kind")}</Label>
                          <Select
                            value={selected.kind ?? "code128"}
                            onValueChange={(v) =>
                              scene.updateSelected((el) =>
                                el.type === "barcode"
                                  ? { ...el, kind: v as BarcodeKind }
                                  : el,
                              )
                            }
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="code128">Code 128</SelectItem>
                              <SelectItem value="code39">Code 39</SelectItem>
                              <SelectItem value="code93">Code 93</SelectItem>
                              <SelectItem value="ean13">EAN-13</SelectItem>
                              <SelectItem value="upca">UPC-A</SelectItem>
                              <SelectItem value="itf">ITF</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    )}
                    {selected.type === "qr" && (
                      <NumField
                        id="q-h"
                        label={t("scene.qr_size_mm")}
                        value={selected.h_mm}
                        onChange={(v) =>
                          scene.updateSelected((el) =>
                            el.type === "qr" ? { ...el, h_mm: v } : el,
                          )
                        }
                      />
                    )}
                    <div className="flex flex-col gap-1">
                      <Label>{t("scene.value")}</Label>
                      <Input
                        spellCheck={false}
                        value={selected.value}
                        onChange={(e) =>
                          scene.updateSelected((el) =>
                            el.type === "barcode" || el.type === "qr"
                              ? { ...el, value: e.target.value }
                              : el,
                          )
                        }
                      />
                    </div>
                    {selected.type === "barcode" && (
                      <SwitchRow
                        label={t("scene.barcode_text")}
                        checked={selected.show_text !== false}
                        onCheckedChange={(v) =>
                          scene.updateSelected((el) =>
                            el.type === "barcode"
                              ? { ...el, show_text: v }
                              : el,
                          )
                        }
                      />
                    )}
                  </div>
                )}

                {selected.type === "image" && (
                  <div className="flex flex-col gap-3">
                    <div className="grid grid-cols-2 gap-3">
                      <NumField
                        id="i-w"
                        label={t("scene.width_mm")}
                        value={selected.size.w_mm}
                        onChange={(v) =>
                          scene.updateSelected((el) =>
                            el.type === "image"
                              ? { ...el, size: { ...el.size, w_mm: v } }
                              : el,
                          )
                        }
                      />
                      <NumField
                        id="i-h"
                        label={t("scene.height_mm")}
                        value={selected.size.h_mm}
                        onChange={(v) =>
                          scene.updateSelected((el) =>
                            el.type === "image"
                              ? { ...el, size: { ...el.size, h_mm: v } }
                              : el,
                          )
                        }
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label>{t("scene.source")}</Label>
                      <Input
                        spellCheck={false}
                        value={selected.src}
                        onChange={(e) =>
                          scene.updateSelected((el) =>
                            el.type === "image"
                              ? { ...el, src: e.target.value }
                              : el,
                          )
                        }
                      />
                    </div>
                  </div>
                )}

                {selected.type === "group" && scene.selection && (
                  <div className="flex flex-col gap-3">
                    <div className="grid grid-cols-2 gap-3">
                      <NumField
                        id="g-w"
                        label={t("scene.column_width_mm")}
                        value={selected.w_mm}
                        onChange={(v) =>
                          scene.updateSelected((el) =>
                            el.type === "group" ? { ...el, w_mm: v } : el,
                          )
                        }
                      />
                      <NumField
                        id="g-gap"
                        label={t("scene.gap_mm")}
                        value={selected.item_gap_mm}
                        onChange={(v) =>
                          scene.updateSelected((el) =>
                            el.type === "group"
                              ? { ...el, item_gap_mm: v }
                              : el,
                          )
                        }
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label>{t("scene.bind")}</Label>
                      <Input
                        spellCheck={false}
                        value={selected.bind}
                        onChange={(e) =>
                          scene.updateSelected((el) =>
                            el.type === "group"
                              ? { ...el, bind: e.target.value }
                              : el,
                          )
                        }
                      />
                      <span className="text-caption text-muted-foreground">
                        {t("scene.rows_from_note")}
                      </span>
                    </div>
                    <AddElement
                      types={NESTED_ELEMENT_TYPES}
                      onAdd={(type) => scene.addElement(selectedPath, type)}
                    />
                  </div>
                )}

                {selected.type === "frame" && scene.selection && (
                  <div className="flex flex-col gap-3">
                    <div className="grid grid-cols-3 gap-3">
                      <NumField
                        id="f-w"
                        label={t("scene.width_mm")}
                        value={selected.size.w_mm}
                        onChange={(v) =>
                          scene.updateSelected((el) =>
                            el.type === "frame"
                              ? { ...el, size: { ...el.size, w_mm: v } }
                              : el,
                          )
                        }
                      />
                      <NumField
                        id="f-h"
                        label={t("scene.height_mm")}
                        value={selected.size.h_mm}
                        onChange={(v) =>
                          scene.updateSelected((el) =>
                            el.type === "frame"
                              ? { ...el, size: { ...el.size, h_mm: v } }
                              : el,
                          )
                        }
                      />
                      <NumField
                        id="f-border"
                        label={t("scene.border_mm")}
                        step={0.05}
                        value={selected.border_mm}
                        onChange={(v) =>
                          scene.updateSelected((el) =>
                            el.type === "frame" ? { ...el, border_mm: v } : el,
                          )
                        }
                      />
                    </div>
                    <AddElement
                      types={NESTED_ELEMENT_TYPES}
                      onAdd={(type) => scene.addElement(selectedPath, type)}
                    />
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>{t("scene.sample_data")}</CardTitle>
              <CardDescription>{t("scene.sample_data_note")}</CardDescription>
            </CardHeader>
            <CardContent>
              <Textarea
                rows={4}
                spellCheck={false}
                className="font-mono text-body-sm"
                value={sampleJson}
                onChange={(e) => onSampleJsonChange(e.target.value)}
              />
            </CardContent>
          </Card>

          {bindings.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>{t("scene.data_fields")}</CardTitle>
                <CardDescription>{t("scene.data_fields_note")}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {bindings.map((b) => (
                  <Badge key={b} variant="outline">
                    {"{{"}
                    {b}
                    {"}}"}
                  </Badge>
                ))}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>{t("scene.preview")}</CardTitle>
              <CardDescription>{t("scene.preview_note")}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Select
                value={scene.printerName}
                onValueChange={scene.setPrinterName}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("scene.pick_printer")} />
                </SelectTrigger>
                <SelectContent>
                  {scene.printers.map((p) => (
                    <SelectItem key={p.id} value={p.name}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {scene.previewError && (
                <div className="rounded-md bg-danger-soft px-3 py-2 text-body-sm text-danger">
                  {scene.previewError}
                </div>
              )}
              {scene.preview && (
                <>
                  <div className="flex flex-wrap items-center gap-2 text-body-sm text-muted-foreground">
                    <Badge variant="outline">{scene.preview.path}</Badge>
                    <Badge variant="outline">{scene.preview.profile}</Badge>
                    <span>
                      {t("scene.pages", { count: scene.preview.pages })} ·{" "}
                      {scene.preview.bytes} B
                    </span>
                  </div>
                  {scene.preview.fallback && (
                    <div className="rounded-md bg-warning-soft px-3 py-2 text-body-sm text-warning">
                      {t("scene.fallback_note", {
                        path: scene.preview.fallback,
                      })}
                    </div>
                  )}
                  {scene.preview.preview && scene.preview.preview.length > 0 ? (
                    <SceneBitmapPreview previews={scene.preview.preview} />
                  ) : (
                    <p className="text-body-sm text-muted-foreground">
                      {t("scene.preview_unavailable")}
                    </p>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
