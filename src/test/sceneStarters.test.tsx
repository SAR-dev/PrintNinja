import { describe, it, expect } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import "@/lib/i18n";
import en from "@/lib/i18n/locales/en";
import ja from "@/lib/i18n/locales/ja";
import { SceneStarterChooser } from "@/components/designer/SceneStarterChooser";
import { allBindings, withSyncedFields } from "@/lib/scene/editor-model";
import type { Element, Template } from "@/lib/scene/schema";
import {
  DEFAULT_SCENE_STARTER_ID,
  SCENE_STARTERS,
  getSceneStarter,
} from "@/lib/scene/starters";

const sizeOf = (el: Element): { w: number; h: number } => {
  switch (el.type) {
    case "qr":
      return { w: el.h_mm, h: el.h_mm };
    case "line":
      return el.vertical
        ? { w: el.thickness_mm, h: el.length_mm }
        : { w: el.length_mm, h: el.thickness_mm };
    case "group":
      return { w: el.w_mm, h: 0 };
    default:
      return { w: el.size.w_mm, h: el.size.h_mm };
  }
};

/** The scene validation's geometry rules (pn-scene): fixed elements stay
 * on the page, frame children stay inside their frame and never pick a
 * page of their own, and a frame holds no group. */
function geometryProblems(
  els: Element[],
  w: number,
  h: number,
  where: string,
): string[] {
  const out: string[] = [];
  for (const el of els) {
    const s = sizeOf(el);
    if (el.at.x_mm < 0 || el.at.y_mm < 0)
      out.push(`${where}: ${el.type} starts off the page`);
    if (el.at.x_mm + s.w > w || (el.type !== "group" && el.at.y_mm + s.h > h))
      out.push(
        `${where}: ${el.type} at ${el.at.x_mm},${el.at.y_mm} leaves ${w}×${h}`,
      );
    if (el.type === "frame") {
      out.push(
        ...geometryProblems(el.children, el.size.w_mm, el.size.h_mm, "frame"),
      );
    }
  }
  return out;
}

describe("starter label templates", () => {
  it("has unique ids, led by the blank starter", () => {
    const ids = SCENE_STARTERS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe(DEFAULT_SCENE_STARTER_ID);
    expect(getSceneStarter("nope")).toBeUndefined();
  });

  it.each(SCENE_STARTERS.map((s) => [s.id, s] as const))(
    "%s is a valid scene that fits its media",
    (_id, starter) => {
      const t: Template = starter.template();
      expect(t.format).toBe("scene");
      expect(t.media.kind).toBe("label");
      const w = t.media.width_mm;
      const h = t.media.kind === "label" ? t.media.height_mm : 0;
      expect(w).toBeGreaterThan(0);
      expect(h).toBeGreaterThan(0);
      expect(geometryProblems(t.elements, w, h, "page")).toEqual([]);
      // Declared fields follow the bindings in use, so a save never
      // trips the "unknown binding" rule.
      expect(withSyncedFields(t).fields?.map((f) => f.name)).toEqual(
        allBindings(t),
      );
      // The wire format is plain JSON.
      expect(JSON.parse(JSON.stringify(t))).toEqual(t);
    },
  );

  it("every starter beyond blank has real content with bindings", () => {
    for (const s of SCENE_STARTERS.filter((x) => x.id !== "blank")) {
      const t = s.template();
      expect(t.elements.length).toBeGreaterThan(2);
      expect(allBindings(t).length).toBeGreaterThan(0);
    }
  });

  it("each starter's sample records fill every binding it uses", () => {
    for (const s of SCENE_STARTERS) {
      const bindings = allBindings(s.template());
      const records = s.sample();
      if (bindings.length === 0) {
        expect(records, s.id).toEqual([]);
        continue;
      }
      expect(records.length, s.id).toBeGreaterThanOrEqual(2);
      for (const r of records) {
        for (const b of bindings)
          expect(r[b]?.trim(), `${s.id}.${b}`).toBeTruthy();
      }
    }
    // A fresh copy each call, like the scene.
    const a = getSceneStarter("badge")?.sample();
    a?.pop();
    expect(getSceneStarter("badge")?.sample().length).toBe(2);
  });

  it("hands out a fresh copy each call", () => {
    const starter = getSceneStarter("shipping");
    const a = starter?.template();
    const b = starter?.template();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    a?.elements.pop();
    expect(starter?.template().elements.length).toBe(b?.elements.length);
  });

  it("has an English and a Japanese name and description for each", () => {
    const en_ = en.scene as Record<string, string>;
    const ja_ = ja.scene as Record<string, string>;
    for (const s of SCENE_STARTERS) {
      for (const suffix of ["name", "desc"]) {
        const key = `starter_${s.id}_${suffix}`;
        expect(en_[key], `en ${key}`).toBeTruthy();
        expect(ja_[key], `ja ${key}`).toBeTruthy();
      }
    }
  });
});

describe("SceneStarterChooser", () => {
  it("lists every starter and reports the pick", () => {
    const picked: string[] = [];
    render(
      <SceneStarterChooser
        selectedId="blank"
        onSelect={(id) => picked.push(id)}
      />,
    );
    const list = screen.getByRole("listbox");
    expect(within(list).getAllByRole("option")).toHaveLength(
      SCENE_STARTERS.length,
    );
    expect(screen.getByTestId("scene-starter-blank")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.click(screen.getByTestId("scene-starter-shipping"));
    expect(picked).toEqual(["shipping"]);
  });

  it("moves the selection with the arrow keys, wrapping around", () => {
    const picked: string[] = [];
    render(
      <SceneStarterChooser
        selectedId="blank"
        onSelect={(id) => picked.push(id)}
      />,
    );
    const list = screen.getByRole("listbox");
    fireEvent.keyDown(list, { key: "ArrowRight" });
    fireEvent.keyDown(list, { key: "ArrowLeft" });
    expect(picked).toEqual([
      SCENE_STARTERS[1].id,
      SCENE_STARTERS[SCENE_STARTERS.length - 1].id,
    ]);
  });
});
