/**
 * Scene format and data model — TypeScript mirror of `pn-scene`
 * (core/scene/src/lib.rs, LABEL_PRINTING_PLAN.md WP4).
 *
 * This file must stay field-for-field identical to the Rust schema:
 * the same tag fields (`kind` on media, `type` on elements), the same
 * snake_case variant names, the same defaults (`format: "scene"`,
 * `page: "every"`, `kind: "code128"`, `align: "left"`, field kind
 * `"string"`). The Rust golden round-trip test pins the wire format;
 * both sides read and write the same JSON.
 *
 * Ported verbatim from PrintNinja-Next's `app/ui/src/scene/schema.ts`;
 * the new repo is frozen as reference — keep the two files in lockstep
 * when either side of the wire format moves.
 *
 * All geometry is in millimetres.
 */

/** Which track renders the template. */
export type Format = "scene" | "html";

/** The media a template prints on, with its geometry in mm. */
export type Media =
  | { kind: "label"; width_mm: number; height_mm: number }
  | { kind: "roll"; width_mm: number; label_height_mm: number }
  | { kind: "page"; width_mm: number; height_mm: number };

/** Where a fixed element sits in a multi-page output. */
export type Placement = "every" | "first" | "last" | "flow" | { only: number };

/** A position in mm from the page's top-left corner. */
export interface At {
  x_mm: number;
  y_mm: number;
}

/** A size in mm. */
export interface Size {
  w_mm: number;
  h_mm: number;
}

/** Horizontal text alignment inside the element's box. */
export type Align = "left" | "center" | "right";

/** Text appearance. Sizes are in mm. */
export interface TextStyle {
  /** Character height, in mm. */
  size_mm: number;
  /** Font family hint; absent lets the renderer choose. */
  font?: string;
  bold?: boolean;
  italic?: boolean;
  align?: Align;
  /** Line height as a multiple of the font size. */
  line_height?: number;
  /** Extra space between glyphs, in millimetres. */
  letter_spacing_mm?: number;
  /** Where lines sit inside the box. */
  vertical_align?: "top" | "middle" | "bottom";
}

/** A 1-D barcode kind. */
export type BarcodeKind =
  | "code128"
  | "code39"
  | "code93"
  | "ean13"
  | "ean8"
  | "upca"
  | "itf"
  | "codabar"
  | "upce"
  | "itf14"
  | "datamatrix"
  | "pdf417"
  | "aztec";

/**
 * One element of a scene. Top-level elements are placed absolutely on
 * the page; elements inside a group are placed relative to that item's
 * top-left.
 */
export type Element =
  | {
      type: "text";
      at: At;
      /** Layout box the text wraps in. */
      size: Size;
      /** The text, with `{{bindings}}` substituted from the record. */
      content: string;
      style: TextStyle;
      page?: Placement;
    }
  | {
      type: "image";
      at: At;
      size: Size;
      /** Resource path or data URI. */
      src: string;
      page?: Placement;
    }
  | {
      type: "barcode";
      at: At;
      size: Size;
      kind?: BarcodeKind;
      /** The encoded value, with `{{bindings}}`. */
      value: string;
      show_text?: boolean;
      page?: Placement;
    }
  | {
      type: "qr";
      at: At;
      /** Module-box height; the QR is square. */
      h_mm: number;
      /** The encoded value, with `{{bindings}}`. */
      value: string;
      page?: Placement;
    }
  | {
      type: "line";
      at: At;
      length_mm: number;
      thickness_mm: number;
      vertical?: boolean;
      page?: Placement;
    }
  | {
      type: "rect";
      at: At;
      size: Size;
      /** Filled instead of outlined. */
      fill?: boolean;
      page?: Placement;
    }
  | {
      type: "frame";
      at: At;
      size: Size;
      /** The outline's thickness in mm; 0 = no border. */
      border_mm: number;
      /** Space between the border and children, in mm. Defaults to 0. */
      padding_mm?: number;
      /** Relative to the frame's top-left, like group items. */
      children: Element[];
      /** The frame's children take this page. */
      page?: Placement;
    }
  | {
      type: "group";
      /** Where the flow starts (top-left of the first item). */
      at: At;
      /** Column width items lay out in. */
      w_mm: number;
      /** Gap between items, in mm. */
      item_gap_mm: number;
      /** The record field holding this group's rows (a list). */
      bind: string;
      items: Element[];
      /** A group must flow. */
      page: Placement;
    };

/** What a field holds. */
export type FieldKind = "string" | "number" | "date" | "boolean" | "list";

/** A data field a template binds to. */
export interface Field {
  name: string;
  kind?: FieldKind;
}

/** The `@font-face` format of an embedded font. */
export type FontFormat = "truetype" | "opentype" | "woff" | "woff2";

/**
 * An embedded font (the previous app's "upload a font"). Document track:
 * the UI turns each entry into an `@font-face` data URI before the HTML
 * reaches the browser. Scene track: the renderer reads TrueType/OpenType
 * bytes and draws text whose `style.font` names `family`. Either way the
 * output carries its own font and nothing is installed on the machine.
 */
export interface TemplateFont {
  /** The `font-family` the template's CSS references. */
  family: string;
  format: FontFormat;
  /** The font file's bytes, base64. */
  data: string;
}

/** One template: the media it prints on and the elements it draws. */
export interface Template {
  /** Which track renders this template (default `scene`). */
  format?: Format;
  /** The document's HTML, when `format: "html"`. */
  html?: string;
  media: Media;
  /** Declared data fields (optional). */
  fields?: Field[];
  elements: Element[];
  /** Embedded fonts: `@font-face` sources (document) or text fonts (scene). */
  fonts?: TemplateFont[];
  /** Sample records saved with a label template for test prints. */
  sample_data?: unknown;
}

/**
 * The `{{name}}` bindings in `s`, filled from `record` — the UI mirror
 * of `pn_scene::substitute_bindings`: a missing field reads as an
 * empty string, and anything that is not a valid binding stays.
 */
export function substituteBindings(
  s: string,
  record: Record<string, unknown> | null,
): string {
  if (!record) return s;
  return s.replace(
    /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g,
    (match, name: string) =>
      name in record ? String(record[name] ?? "") : match,
  );
}

/** The font families the text elements name, first-seen order, trimmed. */
export function fontFamilies(elements: Element[]): string[] {
  const out: string[] = [];
  const walk = (els: Element[]) => {
    for (const el of els) {
      if (el.type === "text") {
        const family = el.style.font?.trim();
        if (
          family &&
          !out.some((f) => f.toLowerCase() === family.toLowerCase())
        ) {
          out.push(family);
        }
      } else if (el.type === "group") walk(el.items);
      else if (el.type === "frame") walk(el.children);
    }
  };
  walk(elements);
  return out;
}

/** The data bindings `{{name}}` in a string, in order of first use. */
export function bindingNames(s: string): string[] {
  const names: string[] = [];
  const re = /\{\{([#/]?)\s*([A-Za-z_][\w.]*)(?:\s+[^}]*)?\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m[2] && !names.includes(m[2])) names.push(m[2]);
  }
  return names;
}

/** Width of one page/label/cut, in mm. */
export function widthMm(media: Media): number {
  return media.width_mm;
}

/** Height of one page/label/cut, in mm. */
export function heightMm(media: Media): number {
  switch (media.kind) {
    case "roll":
      return media.label_height_mm;
    default:
      return media.height_mm;
  }
}

/** Whether one record can span more than one page/label/cut. */
export function flows(media: Media): boolean {
  return media.kind !== "label";
}
