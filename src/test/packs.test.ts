import { describe, it, expect } from "vitest";
import { PACKS, getPack } from "@/lib/templates/packs";
import {
  newTemplateContent,
  DEFAULT_TEMPLATE_HTML,
} from "@/lib/templates/defaultTemplate";
import { compileTemplateCss } from "@/lib/templates/compileTemplateCss";
import { extractClasses } from "@/lib/templates/extractClasses";

/**
 * The pack templates are rendered by the Rust engine (tested in src-tauri),
 * so the JS-side guarantee here is static: every mustache is well-formed,
 * uses a helper the engine registers, and reads only data paths the pack's
 * mock data provides — the same "renders without leftover mustache" property
 * the old renderTemplate test checked, minus the render itself.
 */
const HELPER_NAMES = new Set([
  "currency",
  "date",
  "upper",
  "lower",
  "number",
  "padLeft",
  "barcode",
  "qrcode",
]);
const BLOCK_NAMES = new Set(["each", "if", "unless"]);
const PATH_RE = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/;

function tokenize(inner: string): string[] {
  const tokens: string[] = [];
  for (const m of inner.matchAll(/"[^"]*"|'[^']*'|[^\s]+/g)) tokens.push(m[0]);
  return tokens;
}

function isQuoted(tok: string): boolean {
  return (
    tok.length > 1 &&
    ((tok.startsWith('"') && tok.endsWith('"')) ||
      (tok.startsWith("'") && tok.endsWith("'")))
  );
}

function isOption(tok: string): boolean {
  return /^[A-Za-z_]\w*=/.test(tok);
}

/** The per-item context of an `{{#each}}`: the union of every element's keys. */
function elementContext(arr: unknown): Record<string, unknown> {
  const ctx: Record<string, unknown> = {};
  if (!Array.isArray(arr)) return ctx;
  for (const el of arr) {
    if (el && typeof el === "object" && !Array.isArray(el)) {
      for (const k of Object.keys(el)) {
        if (ctx[k] === undefined) ctx[k] = (el as Record<string, unknown>)[k];
      }
    }
  }
  return ctx;
}

/**
 * Mustaches in `html` that the Rust engine could not fill from `root`:
 * unknown helpers, malformed paths, or data paths the mock data lacks.
 * Tracks the `{{#each}}` context, so item fields resolve against the items.
 */
function unresolvedMustaches(html: string, root: unknown): string[] {
  const problems: string[] = [];
  const stack: Record<string, unknown>[] = [
    (root ?? {}) as Record<string, unknown>,
  ];
  const ctx = () => stack[stack.length - 1];

  let openedEach = 0;
  const walk = (path: string): unknown => {
    let cur: unknown = ctx();
    for (const part of path.split(".")) {
      if (cur == null || typeof cur !== "object") return undefined;
      cur = (cur as Record<string, unknown>)[part];
    }
    return cur;
  };
  const has = (path: string): boolean => {
    let cur: unknown = ctx();
    for (const part of path.split(".")) {
      if (cur == null || typeof cur !== "object" || !(part in (cur as object)))
        return false;
      cur = (cur as Record<string, unknown>)[part];
    }
    return true;
  };
  const require = (path: string) => {
    if (!has(path)) problems.push(path);
  };

  for (const m of html.matchAll(/\{\{([^{}]*)\}\}/g)) {
    const inner = m[1].trim();
    if (inner === "" || inner.startsWith("!")) continue;
    // `{{/each}}` closes the item context opened by `{{#each ...}}`.
    if (inner.startsWith("/")) {
      if (inner.slice(1).trim() === "each" && openedEach > 0) {
        stack.pop();
        openedEach--;
      }
      continue;
    }
    const tokens = tokenize(inner);
    const head = tokens[0] ?? "";

    if (head.startsWith("#")) {
      // Slice `inner`, not `head` (the first token): the block name and its
      // argument are both inside the original mustache.
      const btokens = tokenize(inner.slice(1));
      const block = btokens[0] ?? "";
      const path = btokens[1] ?? "";
      if (!BLOCK_NAMES.has(block)) {
        problems.push(inner);
        continue;
      }
      if (block === "each") {
        if (!PATH_RE.test(path)) {
          problems.push(inner);
          continue;
        }
        require(path);
        stack.push(elementContext(has(path) ? walk(path) : null));
        openedEach++;
      }
      // `#if` / `#unless` conditions are optional by definition (a missing
      // key is falsy), so only the shape of the argument is checked.
      else if (path !== "" && !path.startsWith("@") && !PATH_RE.test(path)) {
        problems.push(inner);
      }
      continue;
    }

    if (head === "this" || head.startsWith("@")) continue;

    if (HELPER_NAMES.has(head)) {
      for (const tok of tokens.slice(1)) {
        if (
          isQuoted(tok) ||
          isOption(tok) ||
          tok.startsWith("@") ||
          tok === "this"
        )
          continue;
        if (!PATH_RE.test(tok)) {
          problems.push(inner);
          break;
        }
        require(tok);
      }
    } else if (!PATH_RE.test(head)) {
      // Neither a known helper nor a data path: the engine would fail to
      // compile this and leave the raw mustache in the output.
      problems.push(inner);
    } else {
      require(head);
    }
  }
  return problems;
}

describe("packs", () => {
  it("has 6 packs", () => expect(PACKS.length).toBe(6));
  it("getPack works", () => expect(getPack("receipt")?.id).toBe("receipt"));
  it("backwards compat", () => {
    expect(newTemplateContent("Test").html).toBe(DEFAULT_TEMPLATE_HTML);
    expect(newTemplateContent("Test", "receipt").html).not.toBe(
      DEFAULT_TEMPLATE_HTML,
    );
    expect(newTemplateContent("Test", "blank").html).toContain("{{message}}");
    expect(newTemplateContent("Test", "unknown").html).toBe(
      DEFAULT_TEMPLATE_HTML,
    );
  });
  for (const p of PACKS) {
    it(`${p.id} reads only data paths its mock data provides`, () => {
      const missing = unresolvedMustaches(p.html, p.mockData);
      expect(missing, `${p.id}: ${missing.join(", ")}`).toEqual([]);
    });
    it(`${p.id} compiles CSS`, async () => {
      const { css } = await compileTemplateCss(p.html);
      const { candidates } = extractClasses(p.html);
      // at least some candidates should compile
      if (candidates.length > 0) expect(css.length).toBeGreaterThan(0);
    });
    it(`${p.id} readme covers every placeholder`, () => {
      const readme = p.readme("Test");
      const paths = new Set<string>();
      for (const m of p.html.matchAll(/\{\{\s*([a-z]+(?:\.[a-z]+)+)[\s}]/g))
        paths.add(m[1]);
      for (const path of paths)
        expect(readme, `missing ${path} in ${p.id}`).toContain(`{{${path}}}`);
      // also contains valid JSON
      const block = /```json\n([\s\S]*?)```/.exec(readme)?.[1];
      expect(block, `${p.id} JSON block`).toBeDefined();
      expect(() => JSON.parse(block!), `${p.id} JSON valid`).not.toThrow();
    });
  }
});
