import { describe, expect, it } from "vitest";
import {
  allBindings,
  blankTemplate,
  boundsMm,
  clampToBounds,
  defaultElement,
  elementsOf,
  getAt,
  insertAt,
  pageDims,
  placementWord,
  removeAt,
  resizeBox,
  samePath,
  updateAt,
  withSyncedFields,
} from "@/lib/scene/editor-model";
import type { Element, Template } from "@/lib/scene/schema";

describe("blankTemplate / defaultElement", () => {
  it("starts a 40x50 label with no elements", () => {
    const t = blankTemplate();
    expect(t.format).toBe("scene");
    expect(t.media).toEqual({ kind: "label", width_mm: 40, height_mm: 50 });
    expect(t.elements).toEqual([]);
  });

  it("gives every type an element of that type", () => {
    for (const type of [
      "text",
      "line",
      "rect",
      "frame",
      "barcode",
      "qr",
      "image",
      "group",
    ]) {
      expect(defaultElement(type).type).toBe(type);
    }
    expect(defaultElement("nonsense").type).toBe("text");
  });
});

describe("bindings", () => {
  const template: Template = {
    format: "scene",
    media: { kind: "label", width_mm: 40, height_mm: 50 },
    elements: [
      {
        type: "text",
        at: { x_mm: 0, y_mm: 0 },
        size: { w_mm: 10, h_mm: 4 },
        content: "{{name}}",
        style: { size_mm: 3 },
      },
      {
        type: "barcode",
        at: { x_mm: 0, y_mm: 6 },
        size: { w_mm: 20, h_mm: 8 },
        value: "{{code}}",
      },
      {
        type: "frame",
        at: { x_mm: 0, y_mm: 16 },
        size: { w_mm: 20, h_mm: 10 },
        border_mm: 0.2,
        children: [
          {
            type: "qr",
            at: { x_mm: 0, y_mm: 0 },
            h_mm: 8,
            value: "{{code}}-{{name}}",
          },
        ],
      },
      {
        type: "group",
        at: { x_mm: 0, y_mm: 28 },
        w_mm: 20,
        item_gap_mm: 1,
        bind: "rows",
        page: "flow",
        items: [
          {
            type: "text",
            at: { x_mm: 0, y_mm: 0 },
            size: { w_mm: 18, h_mm: 4 },
            content: "{{item}}",
            style: { size_mm: 3 },
          },
        ],
      },
    ],
  };

  it("finds every binding the elements use, in first-use order", () => {
    expect(allBindings(template)).toEqual(["name", "code", "rows", "item"]);
  });

  it("syncs the declared fields to the bindings in use", () => {
    const synced = withSyncedFields(template);
    expect(synced.fields?.map((f) => f.name)).toEqual([
      "name",
      "code",
      "rows",
      "item",
    ]);
  });
});

describe("element paths", () => {
  const withGroup: Template = {
    ...blankTemplate(),
    elements: [
      {
        type: "text",
        at: { x_mm: 0, y_mm: 0 },
        size: { w_mm: 10, h_mm: 4 },
        content: "first",
        style: { size_mm: 3 },
      },
      {
        type: "group",
        at: { x_mm: 0, y_mm: 6 },
        w_mm: 20,
        item_gap_mm: 1,
        bind: "rows",
        page: "flow",
        items: [
          {
            type: "text",
            at: { x_mm: 0, y_mm: 0 },
            size: { w_mm: 18, h_mm: 4 },
            content: "row",
            style: { size_mm: 3 },
          },
        ],
      },
    ],
  };

  it("reads an element at a nested path", () => {
    expect(getAt(withGroup, [0])?.type).toBe("text");
    expect(getAt(withGroup, [1, 0])?.type).toBe("text");
    expect(getAt(withGroup, [9])).toBeUndefined();
    expect(getAt(withGroup, [1, 9])).toBeUndefined();
  });

  it("lists the elements of a container", () => {
    expect(elementsOf(withGroup, []).length).toBe(2);
    expect(elementsOf(withGroup, [1]).length).toBe(1);
  });

  it("updates one element in place, leaving the rest", () => {
    const next = updateAt(withGroup, [1, 0], (el) => {
      if (el.type !== "text") throw new Error("expected a text");
      return { ...el, content: "edited" };
    });
    expect((getAt(next, [1, 0]) as Element & { content: string }).content).toBe(
      "edited",
    );
    expect((getAt(next, [0]) as Element & { content: string }).content).toBe(
      "first",
    );
    // The original is untouched: the editor model is pure.
    expect(
      (getAt(withGroup, [1, 0]) as Element & { content: string }).content,
    ).toBe("row");
  });

  it("inserts at the spot the path names, then removes it", () => {
    const added = insertAt(withGroup, [1, 1], defaultElement("line"));
    expect(elementsOf(added, [1]).length).toBe(2);
    expect(elementsOf(added, [1])[1].type).toBe("line");
    const removed = removeAt(added, [1, 1]);
    expect(elementsOf(removed, [1]).length).toBe(1);
  });

  it("removes a nested element", () => {
    const removed = removeAt(withGroup, [1, 0]);
    expect(elementsOf(removed, [1]).length).toBe(0);
  });

  it("compares paths by content", () => {
    expect(samePath([1, 0], [1, 0])).toBe(true);
    expect(samePath([1, 0], [1, 1])).toBe(false);
    expect(samePath([1], [1, 0])).toBe(false);
  });
});

describe("bounds and resize", () => {
  it("measures each element's box", () => {
    const text = defaultElement("text");
    expect(boundsMm(text)).toEqual([2, 2, 30, 4]);
    const qr = defaultElement("qr");
    expect(boundsMm(qr)).toEqual([30, 30, 10, 10]);
    const line = defaultElement("line");
    expect(boundsMm(line)).toEqual([2, 8, 36, 0.2]);
    const vertical: Element = {
      type: "line",
      at: { x_mm: 2, y_mm: 8 },
      length_mm: 36,
      thickness_mm: 0.2,
      vertical: true,
    };
    expect(boundsMm(vertical)).toEqual([2, 8, 0.2, 36]);
  });

  it("sizes a group from its rows and gaps", () => {
    const group = defaultElement("group");
    // One 4 mm row: at least the 4 mm floor, the column wide.
    expect(boundsMm(group)).toEqual([2, 2, 36, 4]);
  });

  it("resizes from the handle the pointer holds", () => {
    // Drag the south-east corner of a 10x10 box at the origin by (3, -2).
    expect(resizeBox(0, 0, 10, 10, "se", 3, -2)).toEqual([0, 0, 13, 8]);
    // Drag the north edge: the top moves down, the height shrinks.
    expect(resizeBox(0, 0, 10, 10, "n", 0, 4)).toEqual([0, 4, 10, 6]);
  });

  it("keeps at least 1 mm in each direction", () => {
    // Drag the west edge 20 mm right, past the east edge: the width
    // floors at 1 mm and the west edge stops just inside it.
    expect(resizeBox(0, 0, 10, 10, "w", 20, 0)).toEqual([9, 0, 1, 10]);
    // The same from the north edge.
    expect(resizeBox(0, 0, 10, 10, "n", 0, 20)).toEqual([0, 9, 10, 1]);
  });

  it("never leaves the parent frame", () => {
    const [x, y, w, h] = resizeBox(0, 0, 10, 10, "se", 40, 40, {
      w: 12,
      h: 8,
    });
    expect(x + w).toBeLessThanOrEqual(12);
    expect(y + h).toBeLessThanOrEqual(8);
    expect([x, y, w, h]).toEqual([0, 0, 12, 8]);
  });

  it("clamps a moved box into its limit", () => {
    expect(clampToBounds(-5, 0, 4, 4, { w: 10, h: 10 })).toEqual({
      x_mm: 0,
      y_mm: 0,
    });
    expect(clampToBounds(9, 9, 4, 4, { w: 10, h: 10 })).toEqual({
      x_mm: 6,
      y_mm: 6,
    });
  });

  it("rounds to a tenth of a millimetre", () => {
    expect(resizeBox(0, 0, 10, 10, "e", 0.333, 0)).toEqual([0, 0, 10.3, 10]);
  });
});

describe("page geometry helpers", () => {
  it("gives a roll its label height", () => {
    expect(
      pageDims({ kind: "roll", width_mm: 58, label_height_mm: 30 }),
    ).toEqual({ w: 58, h: 30 });
    expect(pageDims({ kind: "page", width_mm: 210, height_mm: 297 })).toEqual({
      w: 210,
      h: 297,
    });
  });

  it("renders a placement in words", () => {
    expect(placementWord("every")).toBe("every");
    expect(placementWord({ only: 2 })).toBe("only page 2");
  });
});

describe("save/load round trip", () => {
  it("survives a JSON round trip, the wire format", () => {
    const template: Template = {
      ...blankTemplate(),
      elements: [defaultElement("text"), defaultElement("group")],
    };
    const parsed = JSON.parse(JSON.stringify(template)) as Template;
    expect(parsed).toEqual(template);
  });
});
