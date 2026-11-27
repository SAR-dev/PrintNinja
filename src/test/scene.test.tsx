import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import "@/lib/i18n";
import { useSceneTemplate } from "@/pages/designer/scene/useSceneTemplate";
import { useNewSceneTemplate } from "@/pages/designer/scene/NewSceneDialog";
import { blankTemplate } from "@/lib/scene/editor-model";
import type { Template } from "@/lib/scene/schema";
import type { TemplateRow } from "@/pages/designer/useDesignerDocument";

// The scene track talks to the label pipeline over IPC; only the
// JS-side behaviour (hydration, dirty mark, undo/redo, the save and
// preview round-trips) is under test, so the agent is mocked.
const agentMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agent/commands", () => ({
  agent: (...args: unknown[]) => agentMock(...args),
}));
const notify = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/lib/notify", () => ({
  notifySuccess: (...args: unknown[]) => notify.success(...args),
  notifyError: (...args: unknown[]) => notify.error(...args),
}));

const sceneRow = (over: Partial<TemplateRow> = {}): TemplateRow => ({
  id: 7,
  name: "Shipping",
  html: "",
  css: "",
  page_w_mm: 40,
  page_h_mm: 50,
  orientation: "portrait",
  track: "scene",
  scene_json: JSON.stringify(blankTemplate()),
  origin: "own",
  ...over,
});

const printer = {
  id: 1,
  name: "Zebra",
  address: "192.168.0.10:9100",
  printer_type: "label",
  language: "ZPL",
  dpi: 203,
};

const savedRow = {
  id: 7,
  name: "Shipping",
  scene_json: JSON.stringify(blankTemplate()),
  page_w_mm: 40,
  page_h_mm: 50,
  orientation: "portrait",
};

const prepared = {
  path: "native",
  fallback: null,
  records: 1,
  pages: 1,
  units: 1,
  bytes: 256,
  preview: [],
  profile: "zebra-zd421",
  profile_source: "default",
};

type SceneArgs = Parameters<typeof useSceneTemplate>[0];

const renderScene = (over: Partial<SceneArgs> = {}) =>
  renderHook(
    ({
      templates = [sceneRow()],
      currentTemplateId = 7,
      currentTemplateDbId = 7,
      sampleJson = '{"name":"A"}',
      ...rest
    }) =>
      useSceneTemplate({
        templates,
        setTemplates: rest.setTemplates ?? vi.fn(),
        currentTemplateId,
        setCurrentTemplateId: rest.setCurrentTemplateId ?? vi.fn(),
        currentTemplateDbId,
        setCurrentTemplateDbId: rest.setCurrentTemplateDbId ?? vi.fn(),
        setTemplateName: rest.setTemplateName ?? vi.fn(),
        sampleJson,
      }),
    {
      initialProps: over as SceneArgs,
    },
  );

beforeEach(() => {
  vi.clearAllMocks();
  agentMock.mockImplementation((cmd: string) => {
    if (cmd === "list_printers") return Promise.resolve([printer]);
    if (cmd === "label_save_template") return Promise.resolve(savedRow);
    if (cmd === "delete_template") return Promise.resolve(null);
    if (cmd === "label_preview") return Promise.resolve(prepared);
    return Promise.reject(new Error(`unmocked ${cmd}`));
  });
});

describe("useSceneTemplate", () => {
  it("hydrates the open scene row clean, and stays empty when nothing is open", () => {
    const { result } = renderScene();
    expect(result.current.template).not.toBeNull();
    expect(result.current.dirty).toBe(false);
    const closed = renderScene({ currentTemplateId: null });
    expect(closed.result.current.template).toBeNull();
    expect(closed.result.current.dirty).toBe(false);
  });

  it("ignores an html row at the same id, and a row without scene_json", () => {
    const { result } = renderScene({
      templates: [sceneRow({ track: "html", scene_json: null })],
    });
    expect(result.current.template).toBeNull();
    const { result: r2 } = renderScene({
      templates: [sceneRow({ scene_json: null })],
    });
    expect(r2.current.template).toBeNull();
  });

  it("marks the scene dirty on an edit, and undo and redo walk the baseline", () => {
    const { result } = renderScene();
    expect(result.current.dirty).toBe(false);
    act(() => result.current.addElement([], "text"));
    expect(result.current.dirty).toBe(true);
    expect(result.current.canUndo).toBe(true);
    act(() => result.current.undo());
    expect(result.current.dirty).toBe(false);
    expect(result.current.canRedo).toBe(true);
    act(() => result.current.redo());
    expect(result.current.dirty).toBe(true);
    expect(result.current.canRedo).toBe(false);
  });

  it("adds an element at the end of the container and selects it", () => {
    const { result } = renderScene();
    act(() => result.current.addElement([], "text"));
    expect(result.current.selection).toEqual({ path: [0] });
    expect(result.current.template?.elements[0].type).toBe("text");
    act(() => result.current.addElement([], "line"));
    expect(result.current.selection).toEqual({ path: [1] });
  });

  it("moves the selected element with the arrow-key nudge", () => {
    const { result } = renderScene();
    act(() => result.current.addElement([], "text"));
    const x0 = result.current.template!.elements[0].at.x_mm;
    const y0 = result.current.template!.elements[0].at.y_mm;
    act(() => result.current.nudge(1, 2));
    const el = result.current.template!.elements[0];
    expect(el.at.x_mm).toBeCloseTo(x0 + 1, 5);
    expect(el.at.y_mm).toBeCloseTo(y0 + 2, 5);
  });

  it("deletes the element at a path and clears the selection", () => {
    const { result } = renderScene();
    act(() => result.current.addElement([], "text"));
    act(() => result.current.addElement([], "rect"));
    expect(result.current.template?.elements).toHaveLength(2);
    act(() => result.current.deleteElement([0]));
    expect(result.current.template?.elements).toHaveLength(1);
    expect(result.current.template?.elements[0].type).toBe("rect");
    expect(result.current.selection).toBeNull();
  });

  it("reorders siblings, moving the selection with them", () => {
    const { result } = renderScene();
    act(() => result.current.addElement([], "text"));
    act(() => result.current.addElement([], "rect"));
    expect(result.current.selection).toEqual({ path: [1] });
    act(() => result.current.moveSibling([1], -1));
    expect(result.current.template?.elements[0].type).toBe("rect");
    expect(result.current.template?.elements[1].type).toBe("text");
    expect(result.current.selection).toEqual({ path: [0] });
    // Past the end of the siblings it stays put.
    act(() => result.current.moveSibling([0], -1));
    expect(result.current.template?.elements[0].type).toBe("rect");
    expect(result.current.selection).toEqual({ path: [0] });
  });

  it("writes media changes straight to the template", () => {
    const { result } = renderScene();
    act(() =>
      result.current.setMedia({ kind: "label", width_mm: 100, height_mm: 100 }),
    );
    expect(result.current.template?.media).toEqual({
      kind: "label",
      width_mm: 100,
      height_mm: 100,
    });
  });

  it("clamps a frame child's move inside the frame", () => {
    const t: Template = {
      format: "scene",
      media: { kind: "label", width_mm: 40, height_mm: 50 },
      fields: [],
      elements: [
        {
          type: "frame",
          at: { x_mm: 0, y_mm: 0 },
          size: { w_mm: 20, h_mm: 20 },
          border_mm: 0.2,
          children: [
            {
              type: "text",
              at: { x_mm: 0, y_mm: 0 },
              size: { w_mm: 10, h_mm: 5 },
              content: "x",
              style: { size_mm: 3 },
            },
          ],
        },
      ],
    };
    const { result } = renderScene({
      templates: [sceneRow({ scene_json: JSON.stringify(t) })],
    });
    act(() => result.current.moveElement([0, 0], 100, 100));
    const child = result.current.template!.elements[0];
    if (child.type !== "frame") throw new Error("expected a frame");
    // 20 mm frame, 10 × 5 child: the top-left corner may not leave the
    // frame's right or bottom edge.
    expect(child.children[0].at.x_mm).toBe(10);
    expect(child.children[0].at.y_mm).toBe(15);
  });

  it("saves through the label pipeline and resets the baseline", async () => {
    const setTemplates = vi.fn();
    const setTemplateName = vi.fn();
    const { result } = renderScene({ setTemplates, setTemplateName });
    act(() => result.current.addElement([], "text"));
    expect(result.current.dirty).toBe(true);

    let id: number | null | undefined;
    await act(async () => {
      id = await result.current.save("Shipping");
    });
    expect(id).toBe(7);
    expect(agentMock).toHaveBeenCalledWith("label_save_template", {
      req: expect.objectContaining({ name: "Shipping", id: 7 }),
    });
    expect(setTemplates).toHaveBeenCalled();
    expect(result.current.dirty).toBe(false);
    // The header name follows the row the save now carries.
    expect(setTemplateName).toHaveBeenCalledWith("Shipping");
    expect(notify.success).toHaveBeenCalled();
  });

  it("saves the sample data with the scene", async () => {
    const { result } = renderScene();
    act(() => result.current.addElement([], "text"));
    await act(async () => {
      await result.current.save("Shipping", '[{"name":"Aiko"}]');
    });
    const call = agentMock.mock.calls.find(
      (args: unknown[]) => args[0] === "label_save_template",
    );
    expect(call).toBeDefined();
    const saved = JSON.parse(call![1].req.scene);
    expect(saved.sample_data).toEqual([{ name: "Aiko" }]);
  });

  it("keeps the scene dirty and reports an error when the save fails", async () => {
    agentMock.mockImplementation((cmd: string) =>
      cmd === "list_printers"
        ? Promise.resolve([printer])
        : Promise.reject(new Error("disk full")),
    );
    const { result } = renderScene();
    act(() => result.current.addElement([], "text"));

    let id: number | null | undefined;
    await act(async () => {
      id = await result.current.save("Shipping");
    });
    expect(id).toBeNull();
    expect(result.current.dirty).toBe(true);
    expect(notify.error).toHaveBeenCalled();
    expect(notify.success).not.toHaveBeenCalled();
  });

  it("creates a blank scene as its own row and opens it", async () => {
    const setTemplates = vi.fn();
    const setCurrentTemplateId = vi.fn();
    const setCurrentTemplateDbId = vi.fn();
    const setTemplateName = vi.fn();
    const { result } = renderScene({
      setTemplates,
      setCurrentTemplateId,
      setCurrentTemplateDbId,
      setTemplateName,
    });
    agentMock.mockImplementation((cmd: string) =>
      cmd === "label_save_template"
        ? Promise.resolve({ ...savedRow, name: "New label" })
        : Promise.reject(new Error(`unmocked ${cmd}`)),
    );

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.create("New label");
    });
    expect(ok).toBe(true);
    expect(agentMock).toHaveBeenCalledWith("label_save_template", {
      req: expect.objectContaining({ name: "New label", id: null }),
    });
    // The header name moves to the new row's name — the bug was that it
    // kept showing the previous template's name after a create.
    expect(setTemplateName).toHaveBeenCalledWith("New label");
    expect(setCurrentTemplateId).toHaveBeenCalledWith(7);
    expect(setCurrentTemplateDbId).toHaveBeenCalledWith(7);
    // The row lands in the list under the saved id.
    expect(setTemplates).toHaveBeenCalledWith(expect.any(Function));
    const fn = setTemplates.mock.calls[0][0] as (
      prev: TemplateRow[],
    ) => TemplateRow[];
    const next = fn([]);
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe(7);
    expect(next[0].track).toBe("scene");
    expect(notify.success).toHaveBeenCalled();
  });

  it("lists the printers and picks the first one for the preview", async () => {
    const { result } = renderScene({ sampleJson: '{"name":"A"}' });
    await waitFor(() => expect(result.current.printers).toHaveLength(1));
    expect(result.current.printerName).toBe("Zebra");
    expect(result.current.dpi).toBe(203);
  });

  it("previews through the label pipeline with the chosen printer", async () => {
    const { result } = renderScene({ sampleJson: '{"name":"A"}' });
    await waitFor(() => expect(result.current.printerName).toBe("Zebra"));

    await act(async () => {
      await result.current.runPreview();
    });
    expect(agentMock).toHaveBeenCalledWith("label_preview", {
      req: expect.objectContaining({
        printer: "Zebra",
        records: '{"name":"A"}',
        copies: 1,
      }),
    });
    expect(result.current.preview?.path).toBe("native");
    expect(result.current.previewError).toBeNull();
    expect(result.current.preparing).toBe(false);
  });

  it("reports a preview failure as its error", async () => {
    const { result } = renderScene();
    await waitFor(() => expect(result.current.printerName).toBe("Zebra"));
    agentMock.mockImplementation((cmd: string) =>
      cmd === "list_printers"
        ? Promise.resolve([printer])
        : cmd === "label_preview"
          ? Promise.reject(new Error("no paper"))
          : Promise.resolve(null),
    );
    await act(async () => {
      await result.current.runPreview();
    });
    expect(result.current.preview).toBeNull();
    expect(result.current.previewError).toContain("no paper");
  });
});

type NewSceneArgs = Parameters<typeof useNewSceneTemplate>[0];

describe("useNewSceneTemplate", () => {
  beforeEach(() => window.localStorage.clear());

  const baseDeps = (
    scene: { create: ReturnType<typeof vi.fn> },
    over: Partial<NewSceneArgs> = {},
  ): NewSceneArgs => ({
    templates: [sceneRow()],
    setTemplates: vi.fn(),
    setCurrentTemplateId: vi.fn(),
    setCurrentTemplateDbId: vi.fn(),
    currentTemplateId: 7,
    currentTemplateDbId: 7,
    scene: scene as unknown as NewSceneArgs["scene"],
    ...over,
  });

  const renderNew = (d: NewSceneArgs) =>
    renderHook(() => useNewSceneTemplate(d));

  it("refuses a blank or clashing name under the field, without creating", async () => {
    const scene = { create: vi.fn().mockResolvedValue(true) };
    const { result } = renderNew(baseDeps(scene));
    await act(async () => {
      await result.current.create();
    });
    expect(result.current.nameError).not.toBe("");
    expect(scene.create).not.toHaveBeenCalled();

    act(() => result.current.setName("Shipping "));
    await act(async () => {
      await result.current.create();
    });
    expect(result.current.nameError).not.toBe("");
    expect(scene.create).not.toHaveBeenCalled();
  });

  it("creates through the scene hook and closes on success", async () => {
    const scene = { create: vi.fn().mockResolvedValue(true) };
    const setSampleBlank = vi.fn();
    const { result } = renderNew(
      baseDeps(scene, { setSampleJson: setSampleBlank }),
    );
    act(() => {
      result.current.openDialog();
      result.current.setName("New label");
    });
    await act(async () => {
      await result.current.create();
    });
    // No starter picked: Blank, the same empty label as before.
    expect(scene.create).toHaveBeenCalledWith(
      "New label",
      blankTemplate(),
      undefined,
    );
    // Blank binds nothing, so the account's sample data is left alone.
    expect(setSampleBlank).not.toHaveBeenCalled();
    expect(result.current.showDialog).toBe(false);
  });

  it("creates from the chosen starter and suggests its name", async () => {
    const scene = { create: vi.fn().mockResolvedValue(true) };
    const setSampleJson = vi.fn();
    const { result } = renderNew(baseDeps(scene, { setSampleJson }));
    act(() => result.current.openDialog());
    expect(result.current.starterId).toBe("blank");
    expect(result.current.name).toBe("");

    act(() => result.current.selectStarter("shipping"));
    expect(result.current.starterId).toBe("shipping");
    expect(result.current.name).toBe("Shipping label");
    // The suggestion follows the pick while it is untouched…
    act(() => result.current.selectStarter("badge"));
    expect(result.current.name).toBe("Name badge");
    // …but a name the person typed is kept.
    act(() => result.current.setName("Front desk"));
    act(() => result.current.selectStarter("asset"));
    expect(result.current.name).toBe("Front desk");

    await act(async () => {
      await result.current.create();
    });
    const [name, start] = scene.create.mock.calls[0] as [string, Template];
    expect(name).toBe("Front desk");
    expect(start.media).toEqual({ kind: "label", width_mm: 50, height_mm: 30 });
    expect(start.elements.some((e) => e.type === "qr")).toBe(true);
    // The starter's own records are handed to the sample-data draft.
    const sample = JSON.parse(setSampleJson.mock.calls[0][0] as string);
    expect(sample[0].asset_id).toBe("AST-00123");
    // The next dialog opens on the last starter used.
    act(() => result.current.openDialog());
    expect(result.current.starterId).toBe("asset");
  });

  it("deletes the open scene row, and resets the open template when it was the one", async () => {
    const scene = { create: vi.fn().mockResolvedValue(true) };
    const setTemplates = vi.fn();
    const setCurrentTemplateId = vi.fn();
    const setCurrentTemplateDbId = vi.fn();
    const { result } = renderNew(
      baseDeps(scene, {
        setTemplates,
        setCurrentTemplateId,
        setCurrentTemplateDbId,
      }),
    );
    await act(async () => {
      await result.current.remove();
    });
    expect(agentMock).toHaveBeenCalledWith("delete_template", { id: 7 });
    expect(setTemplates).toHaveBeenCalled();
    expect(setCurrentTemplateId).toHaveBeenCalledWith(null);
    expect(setCurrentTemplateDbId).toHaveBeenCalledWith(null);
    expect(notify.success).toHaveBeenCalled();
    expect(result.current.showDialog).toBe(false);
  });

  it("keeps the dialog open and reports the error when the delete fails", async () => {
    agentMock.mockImplementation((cmd: string) =>
      cmd === "delete_template"
        ? Promise.reject(new Error("locked"))
        : Promise.resolve(null),
    );
    const scene = { create: vi.fn().mockResolvedValue(true) };
    const { result } = renderNew(baseDeps(scene));
    act(() => result.current.openDialog());
    await act(async () => {
      await result.current.remove();
    });
    expect(notify.error).toHaveBeenCalled();
    expect(result.current.showDialog).toBe(true);
  });
});
