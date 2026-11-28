import { describe, expect, it } from "vitest";
import {
  bindingNames,
  flows,
  heightMm,
  substituteBindings,
  widthMm,
} from "@/lib/scene/schema";

describe("substituteBindings", () => {
  it("fills the fields the record carries", () => {
    expect(
      substituteBindings("Hi {{name}}, {{qty}} pcs", { name: "Ada", qty: 2 }),
    ).toBe("Hi Ada, 2 pcs");
  });

  it("blanks a field whose value is null, but keeps one the record lacks", () => {
    expect(substituteBindings("{{name}}/{{other}}", { name: "Ada" })).toBe(
      "Ada/{{other}}",
    );
    expect(
      substituteBindings("{{name}}/{{other}}", { name: "Ada", other: null }),
    ).toBe("Ada/");
  });

  it("leaves a null record untouched", () => {
    expect(substituteBindings("{{name}}", null)).toBe("{{name}}");
  });

  it("keeps anything that is not a valid binding", () => {
    expect(
      substituteBindings("{{ name }} and {x} and {{9bad}}", { name: "A" }),
    ).toBe("{{ name }} and {x} and {{9bad}}");
  });
});

describe("bindingNames", () => {
  it("lists the bindings in order of first use, once each", () => {
    expect(bindingNames("{{b}} then {{a}} then {{b}}")).toEqual(["b", "a"]);
  });

  it("returns the data field of a helper call, not the helper name", () => {
    expect(bindingNames('{{upper name}} {{padLeft n 5 "0"}}')).toEqual([
      "name",
      "n",
    ]);
  });

  it("is empty for a string without bindings", () => {
    expect(bindingNames("plain text")).toEqual([]);
  });
});

describe("media geometry", () => {
  const label = { kind: "label" as const, width_mm: 40, height_mm: 50 };
  const roll = {
    kind: "roll" as const,
    width_mm: 58,
    label_height_mm: 30,
  };
  const page = { kind: "page" as const, width_mm: 210, height_mm: 297 };

  it("measures the width from width_mm for every kind", () => {
    expect(widthMm(label)).toBe(40);
    expect(widthMm(roll)).toBe(58);
    expect(widthMm(page)).toBe(210);
  });

  it("measures a roll's height from its label height", () => {
    expect(heightMm(label)).toBe(50);
    expect(heightMm(roll)).toBe(30);
    expect(heightMm(page)).toBe(297);
  });

  it("flows only when the media is not a fixed label", () => {
    expect(flows(label)).toBe(false);
    expect(flows(roll)).toBe(true);
    expect(flows(page)).toBe(true);
  });
});
