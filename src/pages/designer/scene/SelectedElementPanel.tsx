/**
 * The selected element's properties, shared by the desktop inspector and
 * the tablet Properties tab.
 */
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
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
  elementLabel,
  NESTED_ELEMENT_TYPES,
  type Path,
} from "@/lib/scene/editor-model";
import { useUploadedSceneFonts } from "@/lib/scene/fonts";
import type { Align, BarcodeKind, Element } from "@/lib/scene/schema";
import { AddElement } from "./ElementList";
import { NumField, PlacementSelect, SwitchRow } from "./Fields";
import type { useSceneTemplate } from "./useSceneTemplate";

/** The select's value for "no font chosen" (an empty value is not allowed). */
const DEFAULT_FONT_VALUE = "__default__";

export function SelectedElementPanel({
  scene,
  selected,
  selectedParent,
  selectedPath,
}: {
  scene: ReturnType<typeof useSceneTemplate>;
  selected: Element;
  selectedParent: Element | null;
  selectedPath: Path;
}) {
  const t = useTranslation().t;
  const uploadedFonts = useUploadedSceneFonts();
  return (
    <Card>
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
        {selected.type !== "group" && selectedParent?.type !== "frame" && (
          <PlacementSelect
            value={selected.page ?? "every"}
            onChange={(p) =>
              scene.updateSelected((el) => ({
                ...el,
                page: p,
              }))
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
            <div className="flex flex-col gap-1">
              <Label>{t("scene.font")}</Label>
              <Select
                value={selected.style.font?.trim() || DEFAULT_FONT_VALUE}
                onValueChange={(v) =>
                  scene.updateSelected((el) => {
                    if (el.type !== "text") return el;
                    const { font: _drop, ...rest } = el.style;
                    return {
                      ...el,
                      style:
                        v === DEFAULT_FONT_VALUE ? rest : { ...rest, font: v },
                    };
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_FONT_VALUE}>
                    {t("scene.font_default")}
                  </SelectItem>
                  {uploadedFonts.map((row) => (
                    <SelectItem key={row.server_id} value={row.family.trim()}>
                      {row.family.trim()}
                    </SelectItem>
                  ))}
                  {selected.style.font?.trim() &&
                    !uploadedFonts.some(
                      (row) =>
                        row.family.trim().toLowerCase() ===
                        selected.style.font?.trim().toLowerCase(),
                    ) && (
                      <SelectItem value={selected.style.font.trim()}>
                        {t("scene.font_missing", {
                          name: selected.style.font.trim(),
                        })}
                      </SelectItem>
                    )}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {t("scene.font_note")}
              </p>
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
                            style: {
                              ...el.style,
                              align: v as Align,
                            },
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
            <div className="grid grid-cols-3 gap-3">
              <NumField
                id="t-line-height"
                label={t("scene.line_height")}
                value={selected.style.line_height ?? 1}
                step={0.1}
                onChange={(v) =>
                  scene.updateSelected((el) =>
                    el.type === "text"
                      ? { ...el, style: { ...el.style, line_height: v } }
                      : el,
                  )
                }
              />
              <NumField
                id="t-letter-spacing"
                label={t("scene.letter_spacing")}
                value={selected.style.letter_spacing_mm ?? 0}
                step={0.1}
                onChange={(v) =>
                  scene.updateSelected((el) =>
                    el.type === "text"
                      ? {
                          ...el,
                          style: { ...el.style, letter_spacing_mm: v },
                        }
                      : el,
                  )
                }
              />
              <div className="flex flex-col gap-1">
                <Label>{t("scene.vertical_align")}</Label>
                <Select
                  value={selected.style.vertical_align ?? "top"}
                  onValueChange={(v) =>
                    scene.updateSelected((el) =>
                      el.type === "text"
                        ? {
                            ...el,
                            style: {
                              ...el.style,
                              vertical_align: v as "top" | "middle" | "bottom",
                            },
                          }
                        : el,
                    )
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="top">{t("scene.valign_top")}</SelectItem>
                    <SelectItem value="middle">
                      {t("scene.valign_middle")}
                    </SelectItem>
                    <SelectItem value="bottom">
                      {t("scene.valign_bottom")}
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
                      ? {
                          ...el,
                          style: { ...el.style, bold: v },
                        }
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
                    el.type === "line" ? { ...el, thickness_mm: v } : el,
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
                        ? {
                            ...el,
                            size: { ...el.size, w_mm: v },
                          }
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
                        ? {
                            ...el,
                            size: { ...el.size, h_mm: v },
                          }
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
                      <SelectItem value="ean8">EAN-8</SelectItem>
                      <SelectItem value="upca">UPC-A</SelectItem>
                      <SelectItem value="itf">ITF</SelectItem>
                      <SelectItem value="codabar">Codabar</SelectItem>
                      <SelectItem value="upce">UPC-E</SelectItem>
                      <SelectItem value="itf14">ITF-14</SelectItem>
                      <SelectItem value="datamatrix">Data Matrix</SelectItem>
                      <SelectItem value="pdf417">PDF417</SelectItem>
                      <SelectItem value="aztec">Aztec</SelectItem>
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
                    el.type === "barcode" ? { ...el, show_text: v } : el,
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
                    el.type === "image" ? { ...el, src: e.target.value } : el,
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
                    el.type === "group" ? { ...el, item_gap_mm: v } : el,
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
                    el.type === "group" ? { ...el, bind: e.target.value } : el,
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
              <NumField
                id="f-padding"
                label={t("scene.padding_mm")}
                step={0.05}
                value={selected.padding_mm ?? 0}
                onChange={(v) =>
                  scene.updateSelected((el) =>
                    el.type === "frame" ? { ...el, padding_mm: v } : el,
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
  );
}
