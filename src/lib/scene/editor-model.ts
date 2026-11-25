/**
 * Scene editor state helpers (plan phase 7, scene editor v1): defaults
 * for a new element, the selection (an element at the root, or inside a
 * repeating group), and the rule that the template's declared fields
 * follow the bindings its elements actually use.
 *
 * Ported from PrintNinja-Next's `app/ui/src/scene/editor-model.ts`; the
 * element-label locale keys live under `scene.el_*` here (the old app's
 * HTML designer owns the `designer:` namespace).
 */
import i18n from "@/lib/i18n";
import {
  bindingNames,
  type Element,
  type Field,
  type Media,
  type Placement,
  type Template,
} from "./schema";

/**
 * Where an element lives: the path of indices from the root.
 * `[2]` is the third root element; `[2, 0]` the first item of the
 * group at `[2]`. A container is a path to the element holding the
 * children (`[]` = root, `[2]` = the group at index 2).
 */
export type Path = number[];

export interface Selection {
  path: Path;
}

/** What the user can add, in the order the list offers them. */
export const ELEMENT_TYPES = [
  "text",
  "line",
  "rect",
  "frame",
  "barcode",
  "qr",
  "image",
  "group",
] as const;

/** What can sit inside a group row or a frame (everything but a group —
 * a group cannot sit in a frame, v1). */
export const NESTED_ELEMENT_TYPES = [
  "text",
  "line",
  "rect",
  "frame",
  "barcode",
  "qr",
  "image",
] as const;

/** A blank label to start a new scene template from. */
export function blankTemplate(): Template {
  return {
    format: "scene",
    media: { kind: "label", width_mm: 40, height_mm: 50 },
    fields: [],
    elements: [],
  };
}

/** A sensible first version of each element type, for a 40 mm page. */
export function defaultElement(type: string): Element {
  switch (type) {
    case "line":
      return {
        type: "line",
        at: { x_mm: 2, y_mm: 8 },
        length_mm: 36,
        thickness_mm: 0.2,
      };
    case "rect":
      return {
        type: "rect",
        at: { x_mm: 2, y_mm: 12 },
        size: { w_mm: 16, h_mm: 8 },
      };
    case "frame":
      return {
        type: "frame",
        at: { x_mm: 2, y_mm: 2 },
        size: { w_mm: 30, h_mm: 16 },
        border_mm: 0.3,
        children: [],
      };
    case "barcode":
      return {
        type: "barcode",
        at: { x_mm: 2, y_mm: 30 },
        size: { w_mm: 30, h_mm: 10 },
        value: "{{code}}",
      };
    case "qr":
      return {
        type: "qr",
        at: { x_mm: 30, y_mm: 30 },
        h_mm: 10,
        value: "{{code}}",
      };
    case "image":
      return {
        type: "image",
        at: { x_mm: 2, y_mm: 12 },
        size: { w_mm: 16, h_mm: 16 },
        src: "logo.png",
      };
    case "group":
      return {
        type: "group",
        at: { x_mm: 2, y_mm: 2 },
        w_mm: 36,
        item_gap_mm: 1,
        bind: "rows",
        page: "flow",
        items: [
          {
            type: "text",
            at: { x_mm: 0, y_mm: 0 },
            size: { w_mm: 34, h_mm: 4 },
            content: "{{item}}",
            style: { size_mm: 3 },
          },
        ],
      };
    default:
      return {
        type: "text",
        at: { x_mm: 2, y_mm: 2 },
        size: { w_mm: 30, h_mm: 4 },
        content: "Text",
        style: { size_mm: 3 },
      };
  }
}

/** A short, human line for the element list, in the UI language. */
export function elementLabel(el: Element): string {
  switch (el.type) {
    case "text":
      return i18n.t("scene.el_text", { content: el.content });
    case "barcode":
      return i18n.t("scene.el_barcode", {
        kind: el.kind ?? "code128",
        value: el.value,
      });
    case "qr":
      return i18n.t("scene.el_qr", { value: el.value });
    case "image":
      return i18n.t("scene.el_image", { src: el.src });
    case "line":
      return el.vertical
        ? i18n.t("scene.el_line_vertical")
        : i18n.t("scene.el_line");
    case "rect":
      return el.fill ? i18n.t("scene.el_rect_filled") : i18n.t("scene.el_rect");
    case "group":
      return i18n.t("scene.el_group", { bind: el.bind });
    case "frame":
      return i18n.t("scene.el_frame");
  }
}

/** Every `{{name}}` the template uses, in order of first use. */
export function allBindings(template: Template): string[] {
  const names: string[] = [];
  const add = (s: string) => {
    for (const n of bindingNames(s)) if (!names.includes(n)) names.push(n);
  };
  const walk = (els: Element[]) => {
    for (const el of els) {
      if (el.type === "text") add(el.content);
      else if (el.type === "barcode" || el.type === "qr") add(el.value);
      else if (el.type === "group") {
        if (!names.includes(el.bind)) names.push(el.bind);
        walk(el.items);
      } else if (el.type === "frame") {
        walk(el.children);
      }
    }
  };
  walk(template.elements);
  return names;
}

/** The template with its declared fields synced to the bindings in use. */
export function withSyncedFields(template: Template): Template {
  return {
    ...template,
    fields: allBindings(template).map((name): Field => ({ name })),
  };
}

/** Page dimensions in mm for any media kind. */
export function pageDims(media: Media): { w: number; h: number } {
  return {
    w: media.width_mm,
    h: media.kind === "roll" ? media.label_height_mm : media.height_mm,
  };
}

/** Whether two paths point at the same place. */
export function samePath(a: Path, b: Path): boolean {
  return a.length === b.length && a.every((n, i) => n === b[i]);
}

/** The children of a container element — a group's items, a frame's
 * children — or `undefined` when the element holds no children. */
function childrenOf(el: Element): Element[] | undefined {
  switch (el.type) {
    case "group":
      return el.items;
    case "frame":
      return el.children;
    default:
      return undefined;
  }
}

/** The element at a path, if the template has one there. */
export function getAt(template: Template, path: Path): Element | undefined {
  let els: Element[] = template.elements;
  let node: Element | undefined;
  for (const i of path) {
    node = els[i];
    if (!node) return undefined;
    els = childrenOf(node) ?? [];
  }
  return node;
}

/** The elements living in a container (root, or the group/frame at a
 * path). */
export function elementsOf(template: Template, container: Path): Element[] {
  if (container.length === 0) return template.elements;
  const el = getAt(template, container);
  return el ? (childrenOf(el) ?? []) : [];
}

/** Run `fn` on the children of the container at a path ([] = root). */
function withChildren(
  template: Template,
  container: Path,
  fn: (els: Element[]) => Element[],
): Template {
  const rewrite = (els: Element[], rest: Path): Element[] => {
    if (rest.length === 0) return fn(els);
    const [i, ...deeper] = rest;
    return els.map((el, j) => {
      if (j !== i) return el;
      if (el.type === "group")
        return { ...el, items: rewrite(el.items, deeper) };
      if (el.type === "frame")
        return { ...el, children: rewrite(el.children, deeper) };
      return el;
    });
  };
  return { ...template, elements: rewrite(template.elements, container) };
}

/** Rewrite the element at a path, leaving everything else as is. */
export function updateAt(
  template: Template,
  path: Path,
  fn: (el: Element) => Element,
): Template {
  const container = path.slice(0, -1);
  const index = path[path.length - 1];
  return withChildren(template, container, (els) =>
    els.map((el, i) => (i === index ? fn(el) : el)),
  );
}

/** Insert an element; the path is the spot it takes after the insert. */
export function insertAt(
  template: Template,
  path: Path,
  el: Element,
): Template {
  const container = path.slice(0, -1);
  const index = path[path.length - 1];
  return withChildren(template, container, (els) => {
    const next = els.slice();
    next.splice(index, 0, el);
    return next;
  });
}

/** Remove the element at a path. */
export function removeAt(template: Template, path: Path): Template {
  const container = path.slice(0, -1);
  const index = path[path.length - 1];
  return withChildren(template, container, (els) =>
    els.filter((_, i) => i !== index),
  );
}

/** A placement rendered in words. */
export function placementWord(p: Placement): string {
  return typeof p === "object" ? `only page ${p.only}` : p;
}

/** An element's bounds in its parent's coordinates, in mm:
 * `[x, y, w, h]` — the selection ring, the nudge clamp and the
 * resize handles all measure from it. */
export function boundsMm(el: Element): [number, number, number, number] {
  const { x_mm: x, y_mm: y } = el.at;
  switch (el.type) {
    case "text":
    case "barcode":
    case "image":
    case "rect":
    case "frame":
      return [x, y, el.size.w_mm, el.size.h_mm];
    case "qr":
      return [x, y, el.h_mm, el.h_mm];
    case "line":
      return el.vertical
        ? [x, y, el.thickness_mm, el.length_mm]
        : [x, y, el.length_mm, el.thickness_mm];
    case "group": {
      const h =
        el.items.reduce((sum, it) => sum + rowHeightMm(it), 0) +
        Math.max(0, el.items.length - 1) * el.item_gap_mm;
      return [x, y, el.w_mm, Math.max(4, h)];
    }
  }
}

/**
 * The new box of a resize, from its original box, the handle under
 * the pointer (`nw` … `se`, or an edge: `n`, `s`, `e`, `w`) and the
 * movement in mm. The box keeps at least 1 mm in each direction, and
 * when `within` is given (the parent frame's size) it never leaves
 * that box — a frame's children must stay inside it.
 */
export function resizeBox(
  ox: number,
  oy: number,
  ow: number,
  oh: number,
  handle: string,
  dx: number,
  dy: number,
  within?: { w: number; h: number },
): [number, number, number, number] {
  const MIN = 1;
  let x = ox;
  let y = oy;
  let w = ow;
  let h = oh;
  if (handle.includes("e")) w = ow + dx;
  if (handle.includes("s")) h = oh + dy;
  if (handle.includes("w")) {
    x = ox + dx;
    w = ow - dx;
  }
  if (handle.includes("n")) {
    y = oy + dy;
    h = oh - dy;
  }
  if (w < MIN) {
    if (handle.includes("w")) x -= MIN - w;
    w = MIN;
  }
  if (h < MIN) {
    if (handle.includes("n")) y -= MIN - h;
    h = MIN;
  }
  if (within) {
    x = Math.max(0, x);
    y = Math.max(0, y);
    w = Math.min(w, within.w - x);
    h = Math.min(h, within.h - y);
  }
  return [
    Math.round(x * 10) / 10,
    Math.round(y * 10) / 10,
    Math.round(w * 10) / 10,
    Math.round(h * 10) / 10,
  ];
}

/**
 * A position clamped so the box `[0,0,w,h]` at the origin stays
 * inside `limit` — used to keep a frame's children in the frame when
 * they are moved or nudged.
 */
export function clampToBounds(
  x: number,
  y: number,
  w: number,
  h: number,
  limit: { w: number; h: number },
): { x_mm: number; y_mm: number } {
  return {
    x_mm: Math.min(Math.max(0, x), Math.max(0, limit.w - w)),
    y_mm: Math.min(Math.max(0, y), Math.max(0, limit.h - h)),
  };
}

/**
 * The first record of a sample-data JSON string: the first element of a
 * parsed array, or a parsed object sample. `null` when the sample is not
 * a record — the canvas has nothing to substitute the bindings from.
 */
export function firstRecordOf(sample: string): Record<string, unknown> | null {
  try {
    const arr: unknown = JSON.parse(sample);
    if (
      Array.isArray(arr) &&
      arr.length > 0 &&
      typeof arr[0] === "object" &&
      arr[0] !== null
    ) {
      return arr[0] as Record<string, unknown>;
    }
    if (typeof arr === "object" && arr !== null) {
      return arr as Record<string, unknown>;
    }
  } catch {
    // not JSON — nothing to substitute from
  }
  return null;
}

/** How tall one group row is, in mm — an estimate for the canvas. */
export function rowHeightMm(item: Element): number {
  switch (item.type) {
    case "text":
    case "frame":
      return item.size.h_mm;
    case "barcode":
    case "image":
    case "rect":
      return item.size.h_mm;
    case "qr":
      return item.h_mm;
    case "line":
      return item.vertical ? item.length_mm : item.thickness_mm;
    case "group":
      return 4;
  }
}
