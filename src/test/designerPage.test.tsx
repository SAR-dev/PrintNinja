import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
} from "vitest";
import {
  act,
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@/lib/i18n";
import { EditorView } from "@uiw/react-codemirror";
import { DesignerPage } from "@/pages/Designer";

// The page reads templates and versions over IPC on mount. These tests
// cover the editing workspace, so answer with one real row (an empty
// account shows the New-template empty state instead — see smoke).
const TEMPLATE_ROW = {
  id: 1,
  name: "Receipt",
  page_w_mm: 80,
  page_h_mm: 200,
  orientation: "portrait",
  html: "<p>hi</p>",
  css: "",
  compiled_css: "",
  compiled_key: "",
};
const EMPTY_LISTS = new Set([
  "list_fonts",
  "list_printers",
  "list_datasets",
  "list_profiles",
]);
const invoke = vi.fn(defaultImpl);
async function defaultImpl(...args: any[]): Promise<any> {
  const cmd = args[0] as string;
  if (EMPTY_LISTS.has(cmd)) return [];
  if (cmd === "list_templates") return [{ ...TEMPLATE_ROW }];
  if (cmd === "get_template")
    return {
      ...TEMPLATE_ROW,
      summary: "",
      readme: "",
      remote_id: null,
      published_at: null,
      origin: "own",
      withdrawn: false,
    };
  return null;
}
vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, invoke: (...a: unknown[]) => invoke(...a) };
});

// Which layout the page renders: `lg` and up is the desktop workspace, below it the tabs.
let desktop = false;
// `wide` is the 1440 px breakpoint above which the controls column is not an icon rail.
let wide = true;
const setViewport = (kind: "phone" | "desktop" | "narrow-desktop") => {
  desktop = kind !== "phone";
  wide = kind === "desktop";
};

beforeAll(() => {
  window.matchMedia = ((q: string) =>
    ({
      matches: q.includes("min-width: 1440px")
        ? desktop && wide
        : q.includes("min-width: 1024px")
          ? desktop
          : false,
      media: q,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
  (globalThis as any).ResizeObserver =
    (globalThis as any).ResizeObserver ||
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  Element.prototype.scrollIntoView =
    Element.prototype.scrollIntoView || (() => {});
  Element.prototype.hasPointerCapture =
    Element.prototype.hasPointerCapture || (() => false);
  // CodeMirror measures text with Range rects, which jsdom does not implement.
  const noRects = () =>
    ({
      length: 0,
      item: () => null,
      [Symbol.iterator]: function* () {},
    }) as unknown as DOMRectList;
  Range.prototype.getClientRects = Range.prototype.getClientRects || noRects;
  Range.prototype.getBoundingClientRect =
    Range.prototype.getBoundingClientRect || (() => new DOMRect());
});

function renderDesigner() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<DesignerPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// Radix Tabs switch on mousedown, not click.
const openTab = (name: string) => {
  const tab = screen.getByRole("tab", { name });
  fireEvent.mouseDown(tab, { button: 0 });
  fireEvent.click(tab);
};

describe("Designer page layout on a phone", () => {
  beforeEach(() => setViewport("phone"));

  it("holds a loading state instead of flashing the workspace", async () => {
    invoke.mockImplementation(async (...args: any[]): Promise<any> => {
      const cmd = args[0] as string;
      if (EMPTY_LISTS.has(cmd)) return [];
      // The template list never answers: the page must wait, not guess.
      if (cmd === "list_templates") return new Promise(() => {});
      return null;
    });
    try {
      renderDesigner();
      expect(await screen.findByRole("status")).toHaveTextContent("Loading…");
      expect(screen.queryByText("No templates yet")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("tablist", { name: "Designer views" }),
      ).not.toBeInTheDocument();
      expect(screen.queryByTitle("Canvas preview")).not.toBeInTheDocument();
    } finally {
      invoke.mockImplementation(defaultImpl);
    }
  });

  it("shows an empty state with a New action when the account has no templates", async () => {
    invoke.mockImplementation(async (...args: any[]): Promise<any> => {
      const cmd = args[0] as string;
      if (EMPTY_LISTS.has(cmd)) return [];
      if (cmd === "list_templates") return [];
      return null;
    });
    try {
      renderDesigner();
      // The workspace waits: no canvas, no tabs, just the way forward.
      expect(await screen.findByText("No templates yet")).toBeInTheDocument();
      expect(
        screen.queryByRole("tablist", { name: "Designer views" }),
      ).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "New Template" }));
      expect(await screen.findByRole("dialog")).toBeInTheDocument();
      expect(
        screen.getByLabelText("Template name", { selector: "input" }),
      ).toBeInTheDocument();
    } finally {
      invoke.mockImplementation(defaultImpl);
    }
  });

  it("offers Canvas, Code, README and Sample data, and no Visual or Preview tab", async () => {
    renderDesigner();
    const tablist = await screen.findByRole("tablist", {
      name: "Designer views",
    });
    const names = Array.from(tablist.querySelectorAll('[role="tab"]')).map(
      (t) => t.textContent,
    );
    expect(names).toEqual(["Canvas", "Code", "README", "Sample data"]);
    expect(
      screen.queryByRole("tab", { name: "Visual" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("tab", { name: "Preview" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("tab", { name: "Variables" }),
    ).not.toBeInTheDocument();
  });

  it("keeps Templates and Page Setup in a Settings sheet above the tabs", async () => {
    renderDesigner();
    await screen.findByRole("tablist", { name: "Designer views" });
    // The inline accordion is gone; a single Settings button opens the sheet.
    expect(screen.queryByRole("button", { name: "Templates" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog");
    for (const name of ["Templates", "Page Setup"]) {
      expect(within(dialog).getByRole("button", { name })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
    }
    expect(
      within(dialog).queryByLabelText("Width (mm)"),
    ).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Page Setup" }));
    expect(within(dialog).getByLabelText("Width (mm)")).toBeInTheDocument();
  });

  it("no longer shows the Properties card, and keeps the helpers in the Sample data tab", async () => {
    renderDesigner();
    await screen.findByRole("tablist", { name: "Designer views" });
    expect(screen.queryByText("Properties")).not.toBeInTheDocument();
    openTab("Sample data");
    expect(await screen.findByText("Available helpers:")).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: "Use dataset Sample Order" }),
    ).toBeChecked();
  });

  it("keeps the sync bar in the page header area, outside the tabs", async () => {
    renderDesigner();
    const tablist = await screen.findByRole("tablist", {
      name: "Designer views",
    });
    expect(screen.getByText("Only on this computer")).toBeInTheDocument();
    // TabsList carries data-orientation too, so start from its parent to reach the Tabs root.
    const tabsRoot = tablist.parentElement?.closest("[data-orientation]");
    expect(tabsRoot).not.toBeNull();
    expect(tabsRoot?.contains(tablist)).toBe(true);
    // Phones keep one Save: the sticky shortcut. The header toolbar
    // lives behind the overflow menu instead.
    expect(screen.getByRole("button", { name: "More" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Save" })).toHaveLength(1);
  });

  it("starts on the canvas, with its zoom controls, and shows the code editors on the Code tab", async () => {
    renderDesigner();
    await screen.findByTitle("Canvas preview");
    expect(
      screen.getByRole("combobox", { name: "Zoom level" }),
    ).toHaveTextContent("Fit");
    expect(screen.queryByText("CSS")).not.toBeInTheDocument();
    openTab("Code");
    await waitFor(() =>
      expect(screen.getByText(/^HTML — /)).toBeInTheDocument(),
    );
    expect(screen.getByText("CSS")).toBeInTheDocument();
    expect(screen.queryByTitle("Canvas preview")).not.toBeInTheDocument();
  });

  it("Save & Preview returns to the canvas", async () => {
    renderDesigner();
    await screen.findByTitle("Canvas preview");
    openTab("Code");
    await waitFor(() =>
      expect(screen.getByText(/^HTML — /)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Save & Preview/ }));
    expect(await screen.findByTitle("Canvas preview")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Canvas" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("saves the README from its tab", async () => {
    renderDesigner();
    await screen.findByTitle("Canvas preview");
    openTab("README");
    fireEvent.click(await screen.findByRole("button", { name: "Save README" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("update_readme", expect.anything()),
    );
  });

  it("loads row content directly with the template list", async () => {
    vi.resetModules();
    const { DesignerPage: FreshDesigner } = await import("@/pages/Designer");
    invoke.mockImplementation(async (...args: any[]): Promise<any> => {
      const cmd = args[0] as string;
      if (cmd === "list_templates")
        return [
          { ...TEMPLATE_ROW, id: 1, name: "One" },
          { ...TEMPLATE_ROW, id: 2, name: "Two" },
          { ...TEMPLATE_ROW, id: 3, name: "Three" },
        ];
      if (cmd === "get_template")
        return {
          ...TEMPLATE_ROW,
          summary: "",
          readme: "",
          remote_id: null,
          published_at: null,
          origin: "own",
          withdrawn: false,
        };
      return null;
    });
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route path="/" element={<FreshDesigner />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByTitle("Canvas preview");
    await waitFor(() =>
      expect(
        invoke.mock.calls.filter((c) => c[0] === "list_templates").length,
      ).toBeGreaterThan(0),
    );
    expect(
      invoke.mock.calls.filter((c) => c[0] === "list_versions"),
    ).toHaveLength(0);
    expect(
      invoke.mock.calls.filter((c) => c[0] === "list_latest_versions"),
    ).toHaveLength(0);
  });
});

describe("Designer page layout on desktop", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setViewport("desktop");
  });
  afterEach(() => setViewport("phone"));

  it("shows the editor and the canvas together, with no view tabs", async () => {
    renderDesigner();
    expect(await screen.findByTitle("Canvas preview")).toBeInTheDocument();
    expect(
      screen.queryByRole("tablist", { name: "Designer views" }),
    ).not.toBeInTheDocument();
    const files = screen.getByRole("tablist", { name: "Editor files" });
    expect(
      Array.from(files.querySelectorAll('[role="tab"]')).map(
        (t) => t.textContent,
      ),
    ).toEqual(["HTML", "CSS", "README", "Sample data"]);
    // Both are on screen at once: no switching tabs to see an edit.
    expect(screen.getByLabelText("HTML editor")).toBeInTheDocument();
    expect(screen.getByTitle("Canvas preview")).toBeInTheDocument();
  });

  it("has no Visual, Preview, Canvas or Code tab and no Properties card", async () => {
    renderDesigner();
    await screen.findByTitle("Canvas preview");
    for (const name of ["Visual", "Preview", "Canvas", "Code", "Variables"]) {
      expect(screen.queryByRole("tab", { name })).not.toBeInTheDocument();
    }
    expect(screen.queryByText("Properties")).not.toBeInTheDocument();
  });

  it("puts the controls in an accordion with only Page Setup open", async () => {
    renderDesigner();
    await screen.findByTitle("Canvas preview");
    const controls = within(
      screen.getByRole("complementary", { name: "Designer controls" }),
    );
    const states = ["Page Setup", "Helpers"].map((name) => [
      name,
      controls.getByRole("button", { name }).getAttribute("aria-expanded"),
    ]);
    expect(states).toEqual([
      ["Page Setup", "true"],
      ["Helpers", "false"],
    ]);
    // Templates are switched, and renamed, from the top row instead.
    expect(
      controls.queryByRole("button", { name: "Templates" }),
    ).not.toBeInTheDocument();
    expect(controls.queryByLabelText("Template name")).not.toBeInTheDocument();
    expect(controls.getByLabelText("Width (mm)")).toBeInTheDocument();
  });

  it("shows the sample datasets in the editor, after the README tab, where they drive the canvas", async () => {
    renderDesigner();
    await screen.findByTitle("Canvas preview");
    openTab("Sample data");
    expect(
      await screen.findByRole("radio", { name: "Use dataset Sample Order" }),
    ).toBeChecked();
  });

  it("changing the page size in the accordion resizes the canvas without leaving the editor", async () => {
    renderDesigner();
    const frame = await screen.findByTitle("Canvas preview");
    const width = screen.getByLabelText("Width (mm)");
    fireEvent.change(width, { target: { value: "100" } });
    await waitFor(() =>
      expect(frame.parentElement).toHaveStyle({
        width: `${Math.round(100 * 3.7795 * 10000) / 10000}px`,
      }),
    );
    expect(screen.getByLabelText("HTML editor")).toBeInTheDocument();
  });

  it("typing in the HTML or CSS editor updates the canvas without changing tabs", async () => {
    renderDesigner();
    const frame = await screen.findByTitle("Canvas preview");
    const editorOf = (label: string) => {
      const view = EditorView.findFromDOM(
        screen.getByLabelText(label).querySelector(".cm-editor") as HTMLElement,
      );
      if (!view) throw new Error(`no editor for ${label}`);
      return view;
    };

    const htmlView = editorOf("HTML editor");
    act(() =>
      htmlView.dispatch({
        changes: {
          from: 0,
          to: htmlView.state.doc.length,
          insert: "<p>live-edit-marker</p>",
        },
      }),
    );
    // The canvas re-renders 300 ms after typing stops.
    await waitFor(() =>
      expect(frame.getAttribute("srcdoc")).toContain("live-edit-marker"),
    );
    expect(screen.getByRole("tab", { name: "HTML" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // The CSS editor is mounted behind its tab, so it keeps working and feeds the canvas too.
    const cssView = editorOf("CSS editor");
    act(() =>
      cssView.dispatch({
        changes: {
          from: 0,
          to: cssView.state.doc.length,
          insert: "p{color:#123456}",
        },
      }),
    );
    await waitFor(() =>
      expect(frame.getAttribute("srcdoc")).toContain("color:#123456"),
    );
    expect(screen.getByRole("tab", { name: "HTML" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("opens the README as a tab of the editor pane", async () => {
    renderDesigner();
    await screen.findByTitle("Canvas preview");
    openTab("README");
    expect(
      await screen.findByRole("button", { name: "Save README" }),
    ).toBeInTheDocument();
    expect(screen.getByTitle("Canvas preview")).toBeInTheDocument();
  });

  it("keeps Barcode and Font in the Custom input section, without a Save & Preview button", async () => {
    renderDesigner();
    await screen.findByTitle("Canvas preview");
    const aside = await screen.findByRole("complementary", {
      name: "Designer controls",
    });
    fireEvent.click(
      within(aside).getByRole("button", { name: "Custom input" }),
    );
    for (const name of ["Barcode", "Font"]) {
      expect(within(aside).getByRole("button", { name })).toBeInTheDocument();
    }
    expect(
      screen.queryByRole("button", { name: /Save & Preview/ }),
    ).not.toBeInTheDocument();
  });

  it("keeps the sync bar and toolbar in the header area", async () => {
    renderDesigner();
    await screen.findByTitle("Canvas preview");
    expect(screen.getByTestId("designer-save")).toBeInTheDocument();
    expect(screen.getByText("Only on this computer")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /New/ })).toBeInTheDocument();
  });
});

describe("Designer page, phase 3 polish on desktop", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setViewport("desktop");
  });
  afterEach(() => setViewport("phone"));

  it("starts side by side and switches to canvas only and back, remembering the choice", async () => {
    const first = renderDesigner();
    await screen.findByTitle("Canvas preview");
    expect(
      screen.getByRole("button", { name: "Side by side" }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Canvas only" }));
    expect(screen.queryByLabelText("HTML editor")).not.toBeInTheDocument();
    expect(await screen.findByTitle("Canvas preview")).toBeInTheDocument();
    first.unmount();

    // A new visit comes back in the layout it was left in.
    renderDesigner();
    await screen.findByTitle("Canvas preview");
    expect(screen.getByRole("button", { name: "Canvas only" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.queryByLabelText("HTML editor")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stacked" }));
    expect(screen.getByLabelText("HTML editor")).toBeInTheDocument();
    expect(await screen.findByTitle("Canvas preview")).toBeInTheDocument();
  });

  it("has no layout toggle on a phone", async () => {
    setViewport("phone");
    renderDesigner();
    await screen.findByRole("tablist", { name: "Designer views" });
    expect(
      screen.queryByRole("group", { name: "Workspace layout" }),
    ).not.toBeInTheDocument();
  });

  it("remembers which accordion sections are open", async () => {
    const first = renderDesigner();
    const aside = await screen.findByRole("complementary", {
      name: "Designer controls",
    });
    fireEvent.click(within(aside).getByRole("button", { name: "Helpers" }));
    first.unmount();

    renderDesigner();
    const again = await screen.findByRole("complementary", {
      name: "Designer controls",
    });
    expect(
      within(again).getByRole("button", { name: "Helpers" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(
      within(again).getByRole("button", { name: "Page Setup" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(
      within(again).queryByRole("button", { name: "Templates" }),
    ).not.toBeInTheDocument();
  });

  it("clicking a helper inserts it into the HTML editor", async () => {
    renderDesigner();
    const aside = await screen.findByRole("complementary", {
      name: "Designer controls",
    });
    fireEvent.click(within(aside).getByRole("button", { name: "Helpers" }));
    const before = EditorView.findFromDOM(
      screen.getByLabelText("HTML editor") as HTMLElement,
    )!.state.doc.toString();
    await act(async () => {
      fireEvent.click(
        within(aside).getByRole("button", { name: "Insert currency helper" }),
      );
    });
    const after = EditorView.findFromDOM(
      screen.getByLabelText("HTML editor") as HTMLElement,
    )!.state.doc.toString();
    expect(after.length).toBe(before.length + "{{currency }}".length);
    expect(after).toContain("{{currency }}");
  });

  it("clicking a helper in canvas-only layout brings the editor back and inserts there", async () => {
    renderDesigner();
    const aside = await screen.findByRole("complementary", {
      name: "Designer controls",
    });
    fireEvent.click(within(aside).getByRole("button", { name: "Helpers" }));
    fireEvent.click(screen.getByRole("button", { name: "Canvas only" }));
    expect(screen.queryByLabelText("HTML editor")).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(
        within(aside).getByRole("button", { name: "Insert upper helper" }),
      );
    });
    const doc = EditorView.findFromDOM(
      screen.getByLabelText("HTML editor") as HTMLElement,
    )!.state.doc.toString();
    expect(doc).toContain("{{upper }}");
  });

  it("collapses the controls to an icon rail on a narrow desktop and opens a section from it", async () => {
    setViewport("narrow-desktop");
    renderDesigner();
    await screen.findByTitle("Canvas preview");
    expect(
      screen.queryByRole("complementary", { name: "Designer controls" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Helpers" }));
    const aside = await screen.findByRole("complementary", {
      name: "Designer controls",
    });
    expect(
      within(aside).getByRole("button", { name: "Helpers" }),
    ).toHaveAttribute("aria-expanded", "true");
    // It can be collapsed again by hand.
    fireEvent.click(
      within(aside).getByRole("button", { name: "Collapse controls" }),
    );
    expect(
      screen.queryByRole("complementary", { name: "Designer controls" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Expand controls" }),
    ).toBeInTheDocument();
  });

  it("shows the full controls column on a wide desktop, with no rail", async () => {
    renderDesigner();
    await screen.findByRole("complementary", { name: "Designer controls" });
    expect(
      screen.queryByRole("button", { name: "Expand controls" }),
    ).not.toBeInTheDocument();
  });

  it("shows an error banner while typing an unclosed block, and clears it once fixed", async () => {
    renderDesigner();
    await screen.findByTitle("Canvas preview");
    const view = EditorView.findFromDOM(
      screen.getByLabelText("HTML editor") as HTMLElement,
    )!;
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await act(async () => {
      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: "{{#each items}}<p>",
        },
      });
    });
    await waitFor(
      () =>
        expect(screen.getByRole("alert")).toHaveTextContent(/Template error/),
      { timeout: 2000 },
    );
    await act(async () => {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: "<p>ok</p>" },
      });
    });
    await waitFor(
      () => expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
      { timeout: 2000 },
    );
  });
});

describe("Designer top row on desktop", () => {
  const ROWS = [
    { ...TEMPLATE_ROW, id: 1, name: "Receipt", origin: "own" },
    {
      ...TEMPLATE_ROW,
      id: 2,
      name: "Shipping label",
      html: "<p>label</p>",
      origin: "own",
    },
    {
      ...TEMPLATE_ROW,
      id: 3,
      name: "Community tag",
      html: "<p>tag</p>",
      origin: "saved",
    },
  ];
  const twoTemplates = async (...args: any[]): Promise<any> => {
    const cmd = args[0] as string;
    if (EMPTY_LISTS.has(cmd)) return [];
    if (cmd === "list_templates") return ROWS.map((r) => ({ ...r }));
    if (cmd === "get_template") {
      const row = ROWS.find((r) => r.id === args[1]?.id) ?? ROWS[0];
      return {
        ...row,
        summary: "",
        readme: "",
        remote_id: null,
        published_at: null,
        withdrawn: false,
      };
    }
    return null;
  };

  beforeEach(() => {
    window.localStorage.clear();
    setViewport("desktop");
    invoke.mockImplementation(twoTemplates);
  });
  afterEach(() => {
    setViewport("phone");
    invoke.mockImplementation(defaultImpl);
  });

  const nameField = () =>
    screen.getByRole("textbox", { name: "Template name" }) as HTMLInputElement;
  const openSwitcher = () =>
    fireEvent.click(screen.getByRole("button", { name: "Switch template" }));

  it("renames a template from one field only, in the top row", async () => {
    renderDesigner();
    await screen.findByTitle("Canvas preview");
    expect(screen.getAllByLabelText("Template name")).toHaveLength(1);
    const aside = screen.getByRole("complementary", {
      name: "Designer controls",
    });
    expect(
      within(aside).queryByLabelText("Template name"),
    ).not.toBeInTheDocument();
    expect(nameField()).toHaveValue("Receipt");
  });

  it("lists the templates in a searchable switcher, grouped Mine and Saved", async () => {
    renderDesigner();
    await screen.findByTitle("Canvas preview");
    openSwitcher();
    const list = await screen.findByRole("listbox");
    expect(within(list).getByText("Mine")).toBeInTheDocument();
    expect(within(list).getByText("Saved")).toBeInTheDocument();
    expect(
      within(list).getByRole("option", { name: /Shipping label/ }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("Search templates…"), {
      target: { value: "tag" },
    });
    await waitFor(() =>
      expect(
        within(screen.getByRole("listbox")).queryByRole("option", {
          name: /Shipping label/,
        }),
      ).not.toBeInTheDocument(),
    );
    expect(
      within(screen.getByRole("listbox")).getByRole("option", {
        name: /Community tag/,
      }),
    ).toBeInTheDocument();
  });

  it("switches to the chosen template straight away when nothing is unsaved", async () => {
    renderDesigner();
    await screen.findByTitle("Canvas preview");
    openSwitcher();
    fireEvent.click(
      await screen.findByRole("option", { name: /Shipping label/ }),
    );
    await waitFor(() => expect(nameField()).toHaveValue("Shipping label"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
  });

  it("marks a rename as unsaved, and asks before a switch throws it away", async () => {
    renderDesigner();
    await screen.findByTitle("Canvas preview");
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
    fireEvent.change(nameField(), { target: { value: "Receipt v2" } });
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();

    openSwitcher();
    fireEvent.click(
      await screen.findByRole("option", { name: /Shipping label/ }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("Discard unsaved changes?"),
    ).toBeInTheDocument();

    // Cancel keeps the edit and the template.
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(nameField()).toHaveValue("Receipt v2");

    // Discard switches, and the new template starts clean.
    openSwitcher();
    fireEvent.click(
      await screen.findByRole("option", { name: /Shipping label/ }),
    );
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Discard changes",
      }),
    );
    await waitFor(() => expect(nameField()).toHaveValue("Shipping label"));
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
  });

  it("shows a name that is empty or already taken under the field", async () => {
    renderDesigner();
    await screen.findByTitle("Canvas preview");
    fireEvent.change(nameField(), { target: { value: "shipping LABEL" } });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Template name taken",
    );
    expect(nameField()).toHaveAttribute("aria-invalid", "true");

    fireEvent.change(nameField(), { target: { value: "  " } });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Template name required",
    );

    fireEvent.change(nameField(), { target: { value: "Receipt 2" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(nameField()).not.toHaveAttribute("aria-invalid");
  });

  it("shows the name of a saved (read-only) copy in a disabled field", async () => {
    renderDesigner();
    await screen.findByTitle("Canvas preview");
    openSwitcher();
    fireEvent.click(
      await screen.findByRole("option", { name: /Community tag/ }),
    );
    await waitFor(() => expect(nameField()).toHaveValue("Community tag"));
    expect(nameField()).toBeDisabled();
    expect(screen.getByText("Read-only")).toBeInTheDocument();
  });
});
