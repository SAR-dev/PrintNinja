import { describe, expect, it } from "vitest";
import {
  MAX_PAGES_PER_DESIGN,
  MM_TO_PX,
  pageCount,
  pageWindow,
} from "@/lib/render/paginate";

const PAGE = 102 * MM_TO_PX; // a 102 mm design page, in px

describe("pageCount", () => {
  it("is one page when the content fits, or the page is merely padded up to the frame", () => {
    expect(pageCount(0, PAGE)).toBe(1);
    expect(pageCount(PAGE, PAGE)).toBe(1);
    expect(pageCount(PAGE / 2, PAGE)).toBe(1);
  });

  it("tolerates a pixel of rounding, like the PDF's script does", () => {
    // scrollHeight is a whole number of px; a page is rarely one.
    expect(pageCount(Math.ceil(PAGE), PAGE)).toBe(1);
    expect(pageCount(PAGE + 1, PAGE)).toBe(1);
    expect(pageCount(PAGE + 2, PAGE)).toBe(2);
  });

  it("adds a page for every page of content", () => {
    expect(pageCount(134 * MM_TO_PX, PAGE)).toBe(2);
    expect(pageCount(204 * MM_TO_PX, PAGE)).toBe(2);
    expect(pageCount(204.5 * MM_TO_PX, PAGE)).toBe(3);
    expect(pageCount(612 * MM_TO_PX, PAGE)).toBe(6);
  });

  it("is capped, and never fails on bad input", () => {
    expect(pageCount(1e9, PAGE)).toBe(MAX_PAGES_PER_DESIGN);
    expect(pageCount(1e9, PAGE, 7)).toBe(7);
    expect(pageCount(1e9, PAGE, 0)).toBe(1);
    expect(pageCount(Number.NaN, PAGE)).toBe(1);
    expect(pageCount(500, 0)).toBe(1);
    expect(pageCount(Number.POSITIVE_INFINITY, PAGE)).toBe(1);
  });
});

describe("pageWindow", () => {
  it("leaves a single page alone", () => {
    expect(pageWindow(0, 1, 102, "mm")).toEqual({
      frameHeight: 102,
      shift: 0,
      clipPath: "",
    });
  });

  it("cuts page k out of a frame n pages tall", () => {
    expect(pageWindow(0, 3, 102, "mm")).toEqual({
      frameHeight: 306,
      shift: 0,
      clipPath: "inset(0mm 0 204mm 0)",
    });
    expect(pageWindow(1, 3, 102, "mm")).toEqual({
      frameHeight: 306,
      shift: 102,
      clipPath: "inset(102mm 0 102mm 0)",
    });
    expect(pageWindow(2, 3, 102, "mm")).toEqual({
      frameHeight: 306,
      shift: 204,
      clipPath: "inset(204mm 0 0mm 0)",
    });
  });

  it("works in px too, matching the PDF's whole-number-of-mm output", () => {
    expect(pageWindow(1, 2, 400, "px").clipPath).toBe("inset(400px 0 0px 0)");
  });
});
