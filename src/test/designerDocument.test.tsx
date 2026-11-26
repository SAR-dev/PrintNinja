import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import "@/lib/i18n";
import { useDesignerDocument } from "@/pages/designer/useDesignerDocument";
import type { TemplateListRow } from "@/lib/templates/listTemplates";

// The template list is the one async seam: hold its promise so a test can
// create a row while the mount fetch is still in flight, and let the
// deep-link target be picked among several rows.
const listState = vi.hoisted(() => ({
  impl: () => Promise.resolve<TemplateListRow[]>([]),
}));
vi.mock("@/lib/templates/listTemplates", () => ({
  listTemplates: () => listState.impl(),
}));
// loadTemplate fetches the README for rows the list doesn't carry it on;
// nothing here cares, so the agent just refuses.
vi.mock("@/lib/agent/commands", () => ({
  agent: (...args: unknown[]) =>
    Promise.reject(new Error(`unmocked ${String(args[0])}`)),
}));

const row = (id: number, name: string): TemplateListRow => ({
  id,
  name,
  page_w_mm: 58,
  page_h_mm: 40,
  orientation: "portrait",
  html: `<html><body><h1>${name}</h1></body></html>`,
  css: "body { color: red; }",
  compiled_css: "",
  compiled_key: "",
  track: "html",
  scene_json: null,
  origin: "own",
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const renderDoc = (openTemplateId: number | null = null) =>
  renderHook(() => useDesignerDocument(false, openTemplateId));

beforeEach(() => {
  listState.impl = () => Promise.resolve<TemplateListRow[]>([]);
});

describe("useDesignerDocument", () => {
  it("opens the /template/:id deep-link target on mount, not the first row", async () => {
    listState.impl = () => Promise.resolve([row(1, "First"), row(2, "Second")]);
    const { result } = renderDoc(2);

    await waitFor(() => expect(result.current.templatesLoading).toBe(false));
    expect(result.current.currentTemplateDbId).toBe(2);
    expect(result.current.templateName).toBe("Second");
  });

  it("keeps a row created while the list fetch was in flight", async () => {
    const d = deferred<TemplateListRow[]>();
    listState.impl = () => d.promise;
    const { result } = renderDoc();

    // A create (new-label dialog from the Templates page) lands in the
    // working list before the stale snapshot resolves.
    act(() => {
      result.current.setTemplates([row(3, "Mid-fetch")]);
    });

    await act(async () => {
      d.resolve([row(1, "First"), row(2, "Second")]);
    });
    await waitFor(() => expect(result.current.templatesLoading).toBe(false));

    const ids = result.current.templates.map((t) => t.id).sort();
    expect(ids).toEqual([1, 2, 3]);
    expect(result.current.templates.find((t) => t.id === 3)?.name).toBe(
      "Mid-fetch",
    );
  });
});
