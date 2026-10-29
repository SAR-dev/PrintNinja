import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PrintPreview } from "@/components/PrintPreview";

// jsdom does no layout, so the measured content height is supplied per test:
// 0 means "could not be measured", which keeps a record to one page.
const measured = vi.hoisted(() => ({
  height: ((_doc: string) => 0) as (doc: string) => number,
}));
vi.mock("@/lib/render/paginate", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/render/paginate")>()),
  measureContentHeightPx: async (doc: string) => measured.height(doc),
}));

beforeEach(() => {
  measured.height = () => 0;
});

const MM = 3.7795;
const margins = { top: 5, right: 5, bottom: 5, left: 5 };

function setup(over: Partial<React.ComponentProps<typeof PrintPreview>> = {}) {
  return render(
    <PrintPreview
      pages={["<p>one</p>"]}
      designW={102}
      designH={102}
      paperW={210}
      paperH={297}
      margins={margins}
      fitMode="fit-page"
      title="Print preview"
      {...over}
    />,
  );
}

const px = (v: string) => Number.parseFloat(v);

/** The frames once the measurement has landed and the preview shows `n` of them. */
async function framesOnceThereAre(n: number) {
  await waitFor(() =>
    expect(screen.getAllByTitle(/Print preview/)).toHaveLength(n),
  );
  return screen.getAllByTitle(/Print preview/);
}

describe("PrintPreview", () => {
  it("holds a loading state until every record is measured", async () => {
    setup({ pages: ["<p>a</p>", "<p>b</p>"] });
    // First paint: skeleton, not a premature single sheet.
    expect(screen.getByTestId("print-preview-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("print-sheet")).toBeNull();
    // Then the measured sheets.
    expect(await screen.findAllByTestId("print-sheet")).toHaveLength(2);
    expect(screen.queryByTestId("print-preview-loading")).toBeNull();
  });

  it("draws the sheet at the paper size", async () => {
    setup();
    const sheet = await screen.findByTestId("print-sheet");
    expect(px(sheet.style.width)).toBeCloseTo(210 * MM, 1);
    expect(px(sheet.style.height)).toBeCloseTo(297 * MM, 1);
  });

  it("keeps the design frame at the Designer's size and scales it with a transform", async () => {
    setup();
    const frame = await screen.findByTitle("Print preview");
    // Same px size the Designer canvas gives a 102 x 102 mm page.
    expect(px(frame.style.width)).toBeCloseTo(102 * MM, 1);
    expect(px(frame.style.height)).toBeCloseTo(102 * MM, 1);
    // fit-page on A4 with 5 mm margins: 200 / 102.
    expect(frame.style.transform).toBe(`scale(${200 / 102})`);
  });

  it("keeps the aspect ratio of a square design in every fit mode", async () => {
    for (const mode of ["actual", "fit-width", "fit-page", "shrink", "fill"]) {
      const { unmount } = setup({ fitMode: mode });
      const frame = await screen.findByTitle("Print preview");
      expect(px(frame.style.width)).toBeCloseTo(px(frame.style.height), 3);
      unmount();
    }
  });

  it("scales differently per fit mode", async () => {
    const scale = async (mode: string) => {
      const { unmount } = setup({ fitMode: mode });
      const preview = await screen.findByTestId("print-preview");
      const v = Number(preview.dataset.scale);
      unmount();
      return v;
    };
    expect(await scale("actual")).toBe(1);
    expect(await scale("shrink")).toBe(1);
    expect(await scale("fit-width")).toBeCloseTo(200 / 102, 3);
    expect(await scale("fit-page")).toBeCloseTo(200 / 102, 3);
    expect(await scale("fill")).toBeCloseTo(287 / 102, 3);
  });

  it("clips to the printable area inside the margins", async () => {
    setup({ margins: { top: 10, right: 20, bottom: 30, left: 40 } });
    const area = (await screen.findByTitle("Print preview"))
      .parentElement as HTMLElement;
    expect(area.className).toContain("overflow-hidden");
    expect(px(area.style.left)).toBeCloseTo(40 * MM, 1);
    expect(px(area.style.top)).toBeCloseTo(10 * MM, 1);
    expect(px(area.style.width)).toBeCloseTo(150 * MM, 1);
    expect(px(area.style.height)).toBeCloseTo(257 * MM, 1);
  });

  it("centres fit-page and top-left aligns fit-width", async () => {
    setup({ fitMode: "fit-page" });
    let frame = await screen.findByTitle("Print preview");
    expect(px(frame.style.top)).toBeGreaterThan(0);
    expect(px(frame.style.left)).toBeCloseTo(0, 3);
    document.body.innerHTML = "";
    setup({ fitMode: "fit-width" });
    frame = await screen.findByTitle("Print preview");
    expect(px(frame.style.top)).toBeCloseTo(0, 3);
  });

  it("follows the paper: landscape paper with the design unchanged", async () => {
    setup({ paperW: 297, paperH: 210 });
    const sheet = await screen.findByTestId("print-sheet");
    expect(px(sheet.style.width)).toBeCloseTo(297 * MM, 1);
    const frame = await screen.findByTitle("Print preview");
    expect(px(frame.style.width)).toBeCloseTo(102 * MM, 1);
    // content 287 x 200 → height is the tighter axis
    expect(frame.style.transform).toBe(`scale(${200 / 102})`);
  });

  it("shows one sheet per record", async () => {
    setup({ pages: ["<p>a</p>", "<p>b</p>", "<p>c</p>"] });
    expect(await screen.findAllByTestId("print-sheet")).toHaveLength(3);
    expect(screen.getByTitle("Print preview 2")).toBeTruthy();
  });

  it("continues a tall design on the next sheet in fit-width", async () => {
    setup({ designW: 80, designH: 400, fitMode: "fit-width" });
    const frames = await screen.findAllByTitle(/Print preview/);
    expect(frames.length).toBe(4); // 400 * 2.5 = 1000 mm over 287 mm sheets
    expect(px(frames[1].style.top)).toBeCloseTo(-287 * MM, 1);
  });

  it("applies grayscale to the sheet only when asked", async () => {
    setup({ grayscale: true });
    const paper = (await screen.findByTestId("print-sheet"))
      .firstElementChild as HTMLElement;
    expect(paper.style.filter).toBe("grayscale(1)");
  });

  it("sandboxes the design frame", async () => {
    setup();
    expect(
      (await screen.findByTitle("Print preview")).getAttribute("sandbox"),
    ).toBe("");
  });

  describe("auto-pagination", () => {
    // A 102 mm page; content N mm tall.
    const mm = (v: number) => v * MM;

    it("continues content taller than the page on further sheets", async () => {
      measured.height = () => mm(250); // 3 pages of 102 mm
      setup({ fitMode: "fit-width", paperW: 102, paperH: 102 });
      const frames = await framesOnceThereAre(3);
      // Every frame is all three pages tall; each shows its own page.
      for (const f of frames)
        expect(px(f.style.height)).toBeCloseTo(mm(306), 1);
      expect(frames.map((f) => f.style.clipPath)).toEqual([
        `inset(0px 0 ${mm(204)}px 0)`,
        `inset(${mm(102)}px 0 ${mm(102)}px 0)`,
        `inset(${mm(204)}px 0 0px 0)`,
      ]);
      // fit-width on 102 mm paper with 5 mm margins: 92 / 102.
      const drawH = 102 * (92 / 102);
      expect(frames.map((f) => px(f.style.top))).toEqual([
        expect.closeTo(0, 3),
        expect.closeTo(-mm(drawH), 1),
        expect.closeTo(-mm(2 * drawH), 1),
      ]);
    });

    it("keeps the pages of a record together, in order, before the next record", async () => {
      measured.height = (doc) => (doc.includes("long") ? mm(150) : mm(50));
      setup({
        pages: ["<p>long</p>", "<p>short</p>"],
        fitMode: "fit-width",
        paperW: 102,
        paperH: 102,
      });
      const frames = await framesOnceThereAre(3);
      expect(frames.map((f) => f.getAttribute("srcdoc"))).toEqual([
        "<p>long</p>",
        "<p>long</p>",
        "<p>short</p>",
      ]);
    });

    it("leaves a design that fits exactly as before", async () => {
      measured.height = () => mm(60);
      setup();
      // Give the measurement a chance to land and change nothing.
      await new Promise((r) => setTimeout(r, 300));
      expect(screen.getAllByTestId("print-sheet")).toHaveLength(1);
      const frame = screen.getByTitle("Print preview");
      expect(px(frame.style.height)).toBeCloseTo(mm(102), 1);
      expect(frame.style.clipPath).toBe("");
    });

    it("multiplies with a design page that is taller than the sheet", async () => {
      // 300 mm design on 102 mm paper: 3 sheets a page (existing behavior);
      // content two pages long makes it 6.
      measured.height = () => mm(500);
      setup({
        designW: 102,
        designH: 300,
        paperW: 102,
        paperH: 102,
        fitMode: "fit-width",
      });
      const frames = await framesOnceThereAre(6);
      expect(frames).toHaveLength(6);
    });
  });
});
