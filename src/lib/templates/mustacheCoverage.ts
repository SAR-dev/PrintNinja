/**
 * Static mustache coverage: which data paths a template's mustaches need, and
 * whether a given dataset provides them.
 *
 * The templates are rendered by the Rust engine (tested in src-tauri), so the
 * JS-side guarantee is static: a mustache is covered when it is well-formed,
 * uses a helper the engine registers, and reads a data path the dataset
 * provides — the same "renders without leftover mustache" property the old
 * renderTemplate test checked, minus the render itself.
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
 * unknown helpers, malformed paths, or data paths the data lacks.
 * Tracks the `{{#each}}` context, so item fields resolve against the items.
 * `{{#if}}` / `{{#unless}}` conditions are optional by definition (a missing
 * key is falsy), so only the shape of their argument is checked.
 */
export function unresolvedMustaches(html: string, root: unknown): string[] {
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
      } else if (path !== "" && !path.startsWith("@") && !PATH_RE.test(path)) {
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

export interface PackSample {
  name: string;
  mockData: unknown;
}

export interface CanvasSample {
  /** The data the canvas should render with. */
  data: Record<string, unknown>;
  /** Name of the pack whose sample data the canvas fell back to, or null. */
  packName: string | null;
}

/**
 * Pick the data the canvas should render `html` with.
 *
 * Normally the account's sample data. But when that data covers **none** of
 * the template's mustaches — a kitchen ticket opened against shipping-label
 * data — the canvas would be all blanks, so fall back to the pack sample
 * data that fits the template best. The moment the account data covers even
 * one mustache it takes over again, so editing the sample data always wins.
 */
export function pickCanvasSample(
  html: string,
  data: Record<string, unknown>,
  packs: PackSample[],
): CanvasSample {
  // What no data at all would cover: every mustache that needs a data path.
  const bare = unresolvedMustaches(html, {}).length;
  const unresolved = unresolvedMustaches(html, data).length;
  if (unresolved === 0 || unresolved < bare) {
    return { data, packName: null };
  }
  let best: { name: string; mockData: unknown; count: number } | null = null;
  for (const pack of packs) {
    const count = unresolvedMustaches(html, pack.mockData).length;
    if (best === null || count < best.count) {
      best = { name: pack.name, mockData: pack.mockData, count };
    }
  }
  // No pack fits better than the (uncovering) account data: keep the account
  // data so the user sees exactly what their own values would print.
  if (best === null || best.count >= bare) {
    return { data, packName: null };
  }
  return {
    data: (best.mockData ?? {}) as Record<string, unknown>,
    packName: best.name,
  };
}
