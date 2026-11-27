/**
 * Starter label templates: the ready-made scenes the new-label dialog
 * offers, the label track's counterpart of the document track's packs
 * (`src/lib/templates/packs`). Each one is a complete scene a person
 * edits down — real media geometry, laid-out elements and `{{field}}`
 * bindings — so a new label never starts from an empty canvas unless
 * they pick "Blank".
 *
 * Every starter must pass the scene validation (`pn-scene`): fixed
 * elements inside the media box, frame children inside their frame,
 * flat `{{name}}` bindings. `starters.test.ts` pins those rules.
 *
 * The name and description here are the English fallbacks; the dialog
 * reads `scene.starter_<id>_name` / `scene.starter_<id>_desc` first.
 */
import { blankTemplate, pageDims } from "./editor-model";
import type { Element, Template } from "./schema";

export interface SceneStarter {
  id: string;
  /** English fallback for `scene.starter_<id>_name`. */
  name: string;
  /** English fallback for `scene.starter_<id>_desc`. */
  description: string;
  /** A fresh copy of the scene each call — callers edit it freely. */
  template: () => Template;
  /** Sample records that fill every binding the scene uses: the print
   * screen starts with them and the first one is what the preview shows.
   * Blank has none (it binds nothing). A fresh copy each call. */
  sample: () => Record<string, string>[];
}

/** Shorthand for the text elements the starters are mostly made of. */
function text(
  content: string,
  x_mm: number,
  y_mm: number,
  w_mm: number,
  h_mm: number,
  size_mm: number,
  style: {
    bold?: boolean;
    italic?: boolean;
    align?: "left" | "center" | "right";
  } = {},
): Element {
  return {
    type: "text",
    at: { x_mm, y_mm },
    size: { w_mm, h_mm },
    content,
    style: { size_mm, ...style },
  };
}

function line(
  x_mm: number,
  y_mm: number,
  length_mm: number,
  thickness_mm: number,
): Element {
  return { type: "line", at: { x_mm, y_mm }, length_mm, thickness_mm };
}

/** A 4 × 6 in (102 × 152 mm) parcel label: recipient, sender, service
 * and a tracking barcode. */
function shippingLabel(): Template {
  return {
    format: "scene",
    media: { kind: "label", width_mm: 102, height_mm: 152 },
    fields: [],
    elements: [
      text("SHIP TO", 5, 5, 40, 4, 2.8, { bold: true }),
      text("{{to_name}}", 5, 10, 92, 9, 6, { bold: true }),
      text("{{to_address}}", 5, 20, 92, 9, 4.5),
      text("{{to_city}} {{to_postcode}}", 5, 30, 92, 8, 5),
      text("{{to_country}}", 5, 39, 92, 7, 4.5, { bold: true }),
      line(5, 50, 92, 0.6),
      text("FROM", 5, 54, 40, 4, 2.8, { bold: true }),
      text("{{from_name}}", 5, 59, 92, 6, 3.5),
      text("{{from_address}}", 5, 66, 92, 6, 3.5),
      line(5, 76, 92, 0.6),
      text("{{service}}", 5, 80, 45, 10, 7, { bold: true }),
      text("{{weight}}", 52, 80, 45, 10, 4, { align: "right" }),
      {
        type: "barcode",
        at: { x_mm: 5, y_mm: 98 },
        size: { w_mm: 92, h_mm: 36 },
        kind: "code128",
        value: "{{tracking}}",
        show_text: true,
      },
      text("Order {{order_id}}", 5, 138, 92, 7, 3.5),
    ],
  };
}

/** A 50 × 30 mm shelf/price label: product, price and a SKU barcode. */
function productLabel(): Template {
  return {
    format: "scene",
    media: { kind: "label", width_mm: 50, height_mm: 30 },
    fields: [],
    elements: [
      text("{{product}}", 2, 2, 46, 6, 4, { bold: true }),
      text("{{price}}", 2, 9, 26, 10, 8, { bold: true }),
      text("{{unit}}", 28, 12, 20, 5, 2.8, { align: "right" }),
      {
        type: "barcode",
        at: { x_mm: 2, y_mm: 19 },
        size: { w_mm: 46, h_mm: 9 },
        kind: "code128",
        value: "{{sku}}",
        show_text: true,
      },
    ],
  };
}

/** An 89 × 36 mm address label: four lines of recipient. */
function addressLabel(): Template {
  return {
    format: "scene",
    media: { kind: "label", width_mm: 89, height_mm: 36 },
    fields: [],
    elements: [
      text("{{name}}", 4, 4, 81, 8, 5.5, { bold: true }),
      text("{{street}}", 4, 13, 81, 6, 4),
      text("{{city}} {{postcode}}", 4, 20, 81, 6, 4),
      text("{{country}}", 4, 27, 81, 5, 3.5),
    ],
  };
}

/** A 50 × 30 mm asset tag: a QR code beside the id, name and place. */
function assetTag(): Template {
  return {
    format: "scene",
    media: { kind: "label", width_mm: 50, height_mm: 30 },
    fields: [],
    elements: [
      { type: "qr", at: { x_mm: 2, y_mm: 3 }, h_mm: 24, value: "{{asset_id}}" },
      text("{{asset_id}}", 28, 4, 20, 6, 3.5, { bold: true }),
      text("{{asset_name}}", 28, 11, 20, 10, 3),
      text("{{location}}", 28, 23, 20, 4, 2.5),
    ],
  };
}

/** An 89 × 54 mm name badge: event, a large name, company and role. */
function nameBadge(): Template {
  return {
    format: "scene",
    media: { kind: "label", width_mm: 89, height_mm: 54 },
    fields: [],
    elements: [
      text("{{event}}", 4, 4, 81, 6, 4, { align: "center" }),
      line(4, 12, 81, 0.5),
      text("{{name}}", 4, 16, 81, 14, 10, { bold: true, align: "center" }),
      text("{{company}}", 4, 32, 81, 7, 4.5, { align: "center" }),
      text("{{role}}", 4, 40, 81, 6, 3.5, { italic: true, align: "center" }),
    ],
  };
}

/** The id of the starter the dialog opens on the first time. */
export const DEFAULT_SCENE_STARTER_ID = "blank";

export const SCENE_STARTERS: SceneStarter[] = [
  {
    id: "blank",
    name: "Blank",
    description: "An empty 40 × 50 mm label to design from scratch",
    template: blankTemplate,
    sample: () => [],
  },
  {
    id: "shipping",
    name: "Shipping label",
    description: "4 × 6 in parcel label with addresses and a tracking barcode",
    template: shippingLabel,
    sample: () => [
      {
        to_name: "Aisha Rahman",
        to_address: "45 Oak Lane, Apt 2",
        to_city: "Dhaka",
        to_postcode: "1212",
        to_country: "BANGLADESH",
        from_name: "PrintNinja Cafe",
        from_address: "123 Main Street, Dhaka",
        service: "EXPRESS",
        weight: "1.2 kg",
        tracking: "PN7X9K4242BD",
        order_id: "1042",
      },
      {
        to_name: "John Doe",
        to_address: "8 Harbour Road",
        to_city: "Chattogram",
        to_postcode: "4100",
        to_country: "BANGLADESH",
        from_name: "PrintNinja Cafe",
        from_address: "123 Main Street, Dhaka",
        service: "STANDARD",
        weight: "0.4 kg",
        tracking: "PN3M2Q1187BD",
        order_id: "1043",
      },
    ],
  },
  {
    id: "product",
    name: "Product price",
    description: "Shelf label with product, price and a SKU barcode",
    template: productLabel,
    sample: () => [
      {
        product: "Green Tea 100 g",
        price: "$3.50",
        unit: "per box",
        sku: "4901234567",
      },
      {
        product: "Blueberry Muffin",
        price: "$3.25",
        unit: "each",
        sku: "4909876543",
      },
    ],
  },
  {
    id: "address",
    name: "Address",
    description: "Return or recipient address label",
    template: addressLabel,
    sample: () => [
      {
        name: "Aisha Rahman",
        street: "45 Oak Lane, Apt 2",
        city: "Dhaka",
        postcode: "1212",
        country: "Bangladesh",
      },
      {
        name: "John Doe",
        street: "8 Harbour Road",
        city: "Chattogram",
        postcode: "4100",
        country: "Bangladesh",
      },
    ],
  },
  {
    id: "asset",
    name: "Asset tag",
    description: "Equipment tag with a QR code, id and location",
    template: assetTag,
    sample: () => [
      {
        asset_id: "AST-00123",
        asset_name: "Laptop 14 in",
        location: "Office 2F",
      },
      {
        asset_id: "AST-00124",
        asset_name: "Label printer",
        location: "Store room",
      },
    ],
  },
  {
    id: "badge",
    name: "Name badge",
    description: "Event badge with a large name, company and role",
    template: nameBadge,
    sample: () => [
      {
        event: "PrintNinja Meetup",
        name: "Aisha Rahman",
        company: "PrintNinja Cafe",
        role: "Speaker",
      },
      {
        event: "PrintNinja Meetup",
        name: "John Doe",
        company: "Acme Corp",
        role: "Attendee",
      },
    ],
  },
];

export function getSceneStarter(id: string): SceneStarter | undefined {
  return SCENE_STARTERS.find((s) => s.id === id);
}

/** A starter's page size in mm, from its media. */
export function starterSizeMm(starter: SceneStarter): { w: number; h: number } {
  return pageDims(starter.template().media);
}
