import { invoke } from "@/lib/invoke";
import { buildTemplateCss } from "@/lib/templates/templateCss";
import { sanitizeForRender } from "./sanitize";

/**
 * The Rust-side template preview: the print renderer is the only renderer
 * that ships, so previews call the same engine through the
 * `render_template_preview` command (src-tauri/src/commands/print.rs). This
 * module is the frontend half of that call and keeps the preview's old
 * contract:
 *
 * - a broken template never throws; each record falls back to a document
 *   that shows the raw source, so printing never crashes;
 * - `error` is the one-line reason (first and last line of the engine
 *   message) the Designer banner shows while the person is still typing.
 */

/**
 * Content-Security-Policy meta for the sandboxed preview iframe. Must stay
 * byte-identical to `PREVIEW_CSP_META` in src-tauri/src/commands/print.rs.
 */
const CSP_META =
  "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:\">";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The document a record renders to when the template cannot be rendered:
 * the raw source in a `<pre>`. The same fallback the old JS preview used,
 * so a broken template shows its source instead of an empty page.
 */
export function rawSourceDocument(
  html: string,
  css: string,
  compiledCss?: string | null,
): string {
  const body = sanitizeForRender(
    `<pre style="white-space:pre-wrap">${escapeHtml(html)}</pre>`,
  );
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
${CSP_META}
<style data-printninja>${buildTemplateCss(css, compiledCss)}</style>
</head>
<body>
${body}
</body>
</html>`;
}

/**
 * Collapse a (possibly multi-line) engine error to the one-line,
 * banner-friendly reason the old `getTemplateError` showed: first line and
 * last line, since parse errors span several lines (message, source line,
 * caret pointer).
 */
export function shortTemplateError(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  const lines = message
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length <= 1) return lines[0] ?? "Unknown template error";
  return `${lines[0]} ${lines[lines.length - 1]}`;
}

export interface RenderedDesignPages {
  /** One complete document per record (raw source for failed ones). */
  pages: string[];
  /** Why the template failed to render, one line; null when it rendered. */
  error: string | null;
}

/**
 * Render one design document per record with the Rust print engine.
 *
 * Never throws: a template that fails to render produces raw-source
 * documents for its records, and the reason lands in `error`.
 */
export async function renderDesignPagesRust(
  html: string,
  css: string,
  records: unknown[],
  /** The template's compiled Tailwind CSS; blank until compiled. */
  compiledCss?: string | null,
): Promise<RenderedDesignPages> {
  try {
    const res = await invoke<unknown>("render_template_preview", {
      html,
      css,
      compiled_css: compiledCss ?? "",
      records,
    });
    // The command's contract is a list of documents; anything else (a stale
    // binary, a mocked IPC that resolves null) falls through to the same
    // raw-source fallback as a render failure instead of crashing the UI.
    if (
      !Array.isArray(res) ||
      !res.every((p): p is string => typeof p === "string")
    ) {
      throw new Error("render_template_preview returned no documents");
    }
    return { pages: res, error: null };
  } catch (e) {
    return {
      pages: records.map(() => rawSourceDocument(html, css, compiledCss)),
      error: shortTemplateError(e),
    };
  }
}

/** The single-record variant for one-shot previews (the Templates picker). */
export async function renderTemplateRust(
  html: string,
  css: string,
  data: Record<string, unknown>,
  compiledCss?: string | null,
): Promise<string> {
  const { pages } = await renderDesignPagesRust(html, css, [data], compiledCss);
  return pages[0] ?? "";
}
