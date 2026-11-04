import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Reads the real stylesheet so the test fails if a token drifts below the
// bar, in either theme.
const css = readFileSync(path.resolve(__dirname, "../index.css"), "utf8");

/** The body of one theme's `:root` block, by brace matching. */
function themeBody(selector: string): string {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`theme block ${selector} not found`);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced braces in the ${selector} block`);
}

function token(body: string, name: string): [number, number, number] {
  const m = body.match(
    new RegExp(
      `--${name}:\\s*(\\d+(?:\\.\\d+)?)\\s+(\\d+(?:\\.\\d+)?)%\\s+(\\d+(?:\\.\\d+)?)%`,
    ),
  );
  if (!m) throw new Error(`token --${name} not found`);
  return [Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100];
}

function toRgb([h, s, l]: [number, number, number]): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

function luminance(body: string, name: string): number {
  const [r, g, b] = toRgb(token(body, name)).map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(body: string, a: string, b: string): number {
  const [hi, lo] = [luminance(body, a), luminance(body, b)].sort(
    (x, y) => y - x,
  );
  return (hi + 0.05) / (lo + 0.05);
}

// Text pairs need 4.5:1 (WCAG 1.4.3).
const TEXT_PAIRS: Array<[string, string]> = [
  ["foreground", "background"],
  ["foreground", "card"],
  ["primary-foreground", "primary"],
  ["destructive-foreground", "destructive"],
  ["secondary-foreground", "secondary"],
  ["muted-foreground", "background"],
  ["muted-foreground", "card"],
  ["muted-foreground", "muted"],
  ["accent-foreground", "accent"],
  ["primary", "background"],
  ["primary", "card"],
  ["success", "success-soft"],
  ["warning", "warning-soft"],
  ["danger", "danger-soft"],
  ["info", "info-soft"],
  ["neutral", "neutral-soft"],
];

// Non-text UI (form control borders, focus ring) needs 3:1 (WCAG 1.4.11).
const NON_TEXT_PAIRS: Array<[string, string]> = [
  ["input", "card"],
  ["input", "background"],
  ["ring", "background"],
];

describe("design tokens", () => {
  for (const [name, selector] of [
    ["light", ":root"],
    ["dark", ':root[data-theme="dark"]'],
  ] as const) {
    describe(`${name} theme`, () => {
      const body = themeBody(selector);
      it.each(TEXT_PAIRS)("%s on %s meets 4.5:1", (fg, bg) => {
        expect(contrast(body, fg, bg)).toBeGreaterThanOrEqual(4.5);
      });
      it.each(NON_TEXT_PAIRS)("%s against %s meets 3:1", (a, b) => {
        expect(contrast(body, a, b)).toBeGreaterThanOrEqual(3);
      });
    });
  }

  it("defaults to the light theme", () => {
    expect(css).toMatch(/color-scheme:\s*light/);
  });

  it("declares the dark theme on data-theme with its own color-scheme", () => {
    const dark = themeBody(':root[data-theme="dark"]');
    expect(dark).toMatch(/color-scheme:\s*dark/);
  });
});
