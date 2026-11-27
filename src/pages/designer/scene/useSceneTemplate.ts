/**
 * The scene track's designer state: the open scene template, its
 * unsaved baseline, undo/redo, the element edits, and the prepare
 * preview through the label pipeline. The scene row is local-only (the
 * sync skips it) — saving is a manual push to SQLite, the same shape as
 * the document track's.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { agent } from "@/lib/agent/commands";
import type { LabelPrepareResponse, PrinterRow } from "@/lib/agent/types";
import { describeError } from "@/lib/errors";
import { notifyError, notifySuccess } from "@/lib/notify";
import {
  blankTemplate,
  boundsMm,
  clampToBounds,
  defaultElement,
  elementsOf,
  getAt,
  insertAt,
  pageDims,
  removeAt,
  samePath,
  updateAt,
  withSyncedFields,
  type Path,
  type Selection,
} from "@/lib/scene/editor-model";
import type { Element, Media, Template } from "@/lib/scene/schema";
import type { TemplateRow } from "../useDesignerDocument";

const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Where an element at `path` goes when moved to (x_mm, y_mm): when it
 * sits in a frame, clamped so it stays inside the frame's size — the
 * scene validation rejects a child that leaves its frame.
 */
function frameClamped(
  t: Template,
  path: Path,
  el: Element,
  x_mm: number,
  y_mm: number,
): { x_mm: number; y_mm: number } {
  const parent = getAt(t, path.slice(0, -1));
  if (parent?.type !== "frame")
    return { x_mm: round1(x_mm), y_mm: round1(y_mm) };
  const [, , bw, bh] = boundsMm(el);
  return clampToBounds(round1(x_mm), round1(y_mm), bw, bh, {
    w: parent.size.w_mm,
    h: parent.size.h_mm,
  });
}

interface SceneTemplateArgs {
  templates: TemplateRow[];
  setTemplates: (fn: (prev: TemplateRow[]) => TemplateRow[]) => void;
  currentTemplateId: number | null;
  setCurrentTemplateId: (id: number) => void;
  currentTemplateDbId: number | null;
  setCurrentTemplateDbId: (id: number) => void;
  /** Keep the shared header name in sync after a create or re-save;
   * without it the header keeps showing the previous template's name,
   * and the next Save would rename the row back to that stale value. */
  setTemplateName: (name: string) => void;
  /** The sample data as the dataset edits it; the preview sends it
   * verbatim — the backend accepts one record or an array of them. */
  sampleJson: string;
}

export function useSceneTemplate({
  templates,
  setTemplates,
  currentTemplateId,
  setCurrentTemplateId,
  currentTemplateDbId,
  setCurrentTemplateDbId,
  setTemplateName,
  sampleJson,
}: SceneTemplateArgs) {
  const { t } = useTranslation();
  const [template, setTemplate] = useState<Template | null>(null);
  /** The scene as it last opened or saved — the diff is the unsaved
   * mark. The name and the sample data have their own dirty tracking
   * on the document side. */
  const [baseline, setBaseline] = useState<Template | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);

  // -- undo/redo: one step per action, bursts of the same key (a drag,
  // typing in one field) coalesced within 800 ms.
  const [past, setPast] = useState<Template[]>([]);
  const [future, setFuture] = useState<Template[]>([]);
  const lastPush = useRef<{ key: string; at: number } | null>(null);
  const pushHistory = (key: string) => {
    const now = Date.now();
    const last = lastPush.current;
    if (last && last.key === key && now - last.at < 800) return;
    lastPush.current = { key, at: now };
    if (template === null) return;
    setPast((p) => [...p.slice(-99), template]);
    setFuture([]);
  };
  const commit = (fn: (t: Template) => Template, key: string) => {
    pushHistory(key);
    setTemplate((t) => (t === null ? t : fn(t)));
  };
  const undo = () => {
    if (past.length === 0 || template === null) return;
    lastPush.current = null;
    setFuture((f) => [template, ...f]);
    setTemplate(past[past.length - 1]);
    setPast((p) => p.slice(0, -1));
  };
  const redo = () => {
    if (future.length === 0 || template === null) return;
    lastPush.current = null;
    setPast((p) => [...p, template]);
    setTemplate(future[0]);
    setFuture((f) => f.slice(1));
  };

  // Hydrate when the open template changes. The list itself is read
  // through a ref: a save rewrites it, and a list refresh must not
  // re-hydrate the open template (that would clear the undo stacks).
  const templatesRef = useRef<TemplateRow[]>(templates);
  templatesRef.current = templates;
  useEffect(() => {
    if (currentTemplateId == null) {
      setTemplate(null);
      setBaseline(null);
      return;
    }
    const row = templatesRef.current.find(
      (r) => r.id === currentTemplateId && r.track === "scene" && r.scene_json,
    );
    let next: Template | null = null;
    if (row?.scene_json) {
      try {
        next = JSON.parse(row.scene_json) as Template;
      } catch {
        next = blankTemplate();
      }
    }
    setTemplate(next);
    setBaseline(next ? structuredClone(next) : null);
    setSelection(null);
    setPast([]);
    setFuture([]);
    lastPush.current = null;
    setPreview(null);
    setPreviewError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTemplateId]);

  const dirty = useMemo(
    () =>
      template !== null &&
      baseline !== null &&
      JSON.stringify(withSyncedFields(template)) !==
        JSON.stringify(withSyncedFields(baseline)),
    [template, baseline],
  );

  /** Move an element one place among its siblings (draw order). */
  const moveSibling = (path: Path, delta: number) => {
    if (template === null) return;
    const index = path[path.length - 1];
    const parent = path.slice(0, -1);
    const target = index + delta;
    if (target < 0 || target >= elementsOf(template, parent).length) return;
    commit(
      (t) => {
        const el = getAt(t, path);
        return el ? insertAt(removeAt(t, path), [...parent, target], el) : t;
      },
      `move:${path.join("/")}`,
    );
    if (selection && samePath(selection.path, path))
      setSelection({ path: [...parent, target] });
  };

  const setMedia = (media: Media) => commit((t) => ({ ...t, media }), "media");

  /** The canvas drag: the position update is a direct write — the
   * gesture's one history step was pushed at drag start. */
  const moveElement = (path: Path, x_mm: number, y_mm: number) =>
    setTemplate((t) =>
      t
        ? updateAt(t, path, (el) => {
            const at = frameClamped(t, path, el, x_mm, y_mm);
            return { ...el, at };
          })
        : t,
    );
  const startDrag = (path: Path) => pushHistory(`drag:${path.join("/")}`);
  const resizeElement = (
    path: Path,
    x_mm: number,
    y_mm: number,
    w_mm: number,
    h_mm: number,
  ) =>
    commit(
      (t) =>
        updateAt(t, path, (el) => {
          if (!("size" in el)) return el;
          const parent = getAt(t, path.slice(0, -1));
          let x = x_mm;
          let y = y_mm;
          let w = w_mm;
          let h = h_mm;
          if (parent?.type === "frame") {
            x = Math.max(0, x);
            y = Math.max(0, y);
            w = Math.min(w, parent.size.w_mm - x);
            h = Math.min(h, parent.size.h_mm - y);
          }
          return {
            ...el,
            at: { x_mm: round1(x), y_mm: round1(y) },
            size: { ...el.size, w_mm: round1(w), h_mm: round1(h) },
          };
        }),
      `resize:${path.join("/")}`,
    );
  /** The selected element's position, for the arrow-key nudge. */
  const nudge = (dx: number, dy: number) => {
    if (!selection || template === null) return;
    const path = selection.path;
    commit(
      (t) =>
        updateAt(t, path, (el) => {
          const at = frameClamped(
            t,
            path,
            el,
            el.at.x_mm + dx,
            el.at.y_mm + dy,
          );
          return { ...el, at };
        }),
      `nudge:${path.join("/")}`,
    );
  };
  const updateSelected = (fn: (el: Element) => Element) => {
    if (!selection) return;
    const key = `sel:${selection.path.join("/")}`;
    commit((t) => updateAt(t, selection.path, fn), key);
  };
  const addElement = (container: Path, type: string) => {
    if (template === null) return;
    const path = [...container, elementsOf(template, container).length];
    const newEl = defaultElement(type);
    commit((t) => insertAt(t, path, newEl), `add:${container.join("/")}`);
    setSelection({ path });
  };
  const deleteElement = (path: Path) => {
    commit((t) => removeAt(t, path), `del:${path.join("/")}`);
    setSelection(null);
  };

  // -- saving: the scene row is local-only; a save is a manual push to
  // SQLite. `id: null` makes the command create the row.
  const persist = async (
    name: string,
    t: Template,
    id: number | null,
    sampleJson?: string,
  ): Promise<number | null> => {
    let withData = t;
    if (sampleJson?.trim()) {
      try {
        withData = { ...t, sample_data: JSON.parse(sampleJson) };
      } catch (e) {
        notifyError(
          describeError(e instanceof Error ? e : new Error(String(e))),
        );
        return null;
      }
    }
    const scene = JSON.stringify(withSyncedFields(withData));
    try {
      const saved = await agent("label_save_template", {
        req: { name, scene, id },
      });
      const dims = pageDims(t.media);
      const row: TemplateRow = {
        id: saved.id,
        name: saved.name,
        html: "",
        css: "",
        page_w_mm: saved.page_w_mm ?? dims.w,
        page_h_mm: saved.page_h_mm ?? dims.h,
        orientation: saved.orientation,
        track: "scene",
        scene_json: saved.scene_json ?? scene,
        origin: "own",
      };
      setTemplates((prev) => {
        const i = prev.findIndex((x) => x.id === saved.id);
        if (i === -1) return [...prev, row];
        const next = [...prev];
        next[i] = row;
        return next;
      });
      setBaseline(structuredClone(t));
      // The header name is the document's; a create or re-save must move
      // it to the name the row now carries, or Save would persist the
      // previous template's name over it.
      setTemplateName(saved.name);
      // The row is local-only, so no server pull will ever carry it:
      // broadcast the same list-changed signal the sync uses, and the
      // other pages (Templates, Print) re-read the fresh local list.
      window.dispatchEvent(new Event("sync:pulled"));
      if (id === null) {
        setCurrentTemplateId(saved.id);
        setCurrentTemplateDbId(saved.id);
      }
      return saved.id;
    } catch (e) {
      notifyError(describeError(e));
      return null;
    }
  };

  const save = async (
    name: string,
    sampleJson?: string,
  ): Promise<number | null> => {
    if (template === null) return null;
    const id = await persist(name, template, currentTemplateDbId, sampleJson);
    if (id != null) notifySuccess(t("scene.saved"));
    return id;
  };
  /** A new label template saved as its own row: the chosen starter's
   * scene, or a blank one when none is given. Its sample records go into
   * the saved scene so the template prints with its own data. */
  const create = async (
    name: string,
    start?: Template,
    sampleJson?: string,
  ) => {
    const id = await persist(name, start ?? blankTemplate(), null, sampleJson);
    if (id != null) notifySuccess(t("scene.created"));
    return id != null;
  };

  // -- the preview: prepared with the same path as the print, on the
  // chosen printer at its own dpi.
  const [printers, setPrinters] = useState<PrinterRow[]>([]);
  const [printerName, setPrinterName] = useState("");
  const [preview, setPreview] = useState<LabelPrepareResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  useEffect(() => {
    agent("list_printers", {})
      .then((ps) => {
        // An unseeded device answers null instead of an empty list.
        const list: PrinterRow[] = Array.isArray(ps) ? ps : [];
        setPrinters(list);
        setPrinterName((p) => p || list[0]?.name || "");
      })
      .catch(() => setPreviewError(t("scene.printer_list_error")));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const dpi = printers.find((p) => p.name === printerName)?.dpi ?? null;

  const runPreview = async () => {
    if (template === null || !printerName) return;
    setPreparing(true);
    setPreviewError(null);
    try {
      setPreview(
        await agent("label_preview", {
          req: {
            scene: JSON.stringify(withSyncedFields(template)),
            printer: printerName,
            records: sampleJson,
            copies: 1,
          },
        }),
      );
    } catch (e) {
      setPreview(null);
      setPreviewError(describeError(e));
    } finally {
      setPreparing(false);
    }
  };

  return {
    template,
    dirty,
    selection,
    setSelection,
    undo,
    redo,
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    moveSibling,
    setMedia,
    moveElement,
    startDrag,
    resizeElement,
    nudge,
    updateSelected,
    addElement,
    deleteElement,
    save,
    create,
    printers,
    printerName,
    setPrinterName,
    dpi,
    preview,
    previewError,
    preparing,
    runPreview,
  };
}
