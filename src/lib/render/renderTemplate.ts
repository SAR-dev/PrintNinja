import Handlebars from "handlebars";
import { buildTemplateCss, injectStyles } from "@/lib/templates/templateCss";

/**
 * Register the shared helper set once.
 *
 * Handlebars' global registry is a singleton, so re-registering on every
 * render leaks helpers and makes rendering order-dependent.
 */
let helpersRegistered = false;

function registerHelpers() {
  if (helpersRegistered) return;
  helpersRegistered = true;

  // Handlebars passes the options object as the last argument, so any
  // optional param must be type-checked rather than assumed.
  Handlebars.registerHelper("currency", function (
    value: unknown,
    symbol?: unknown,
  ) {
    const sym = typeof symbol === "string" ? symbol : "$";
    return `${sym}${Number(value ?? 0).toFixed(2)}`;
  });

  Handlebars.registerHelper("date", function (value: unknown, format?: unknown) {
    if (!value) return "";
    const d = new Date(String(value));
    if (Number.isNaN(d.getTime())) return String(value);
    const fmt = typeof format === "string" ? format : undefined;
    if (fmt === "short") return d.toLocaleDateString();
    if (fmt === "time") return d.toLocaleTimeString();
    return d.toLocaleString();
  });

  Handlebars.registerHelper("upper", (v: unknown) =>
    String(v ?? "").toUpperCase(),
  );
  Handlebars.registerHelper("lower", (v: unknown) =>
    String(v ?? "").toLowerCase(),
  );

  Handlebars.registerHelper("number", function (value: unknown, decimals?: unknown) {
    const d = typeof decimals === "number" ? decimals : 0;
    return Number(value ?? 0).toFixed(d);
  });

  Handlebars.registerHelper("padLeft", function (
    value: unknown,
    width?: unknown,
    pad?: unknown,
  ) {
    const w = typeof width === "number" ? width : 0;
    const filler = typeof pad === "string" && pad.length > 0 ? pad[0] : " ";
    const s = String(value ?? "");
    return filler.repeat(Math.max(0, w - s.length)) + s;
  });
}

/**
 * Compile a Handlebars template, render it with `data`, and wrap the result
 * in a complete HTML document with the bundled print stylesheet inlined.
 */
export function renderTemplate(
  html: string,
  css: string,
  data: Record<string, unknown>,
): string {
  registerHelpers();

  let body: string;
  try {
    body = Handlebars.compile(html)(data);
  } catch {
    // A broken template must still produce a printable document showing the
    // raw source, rather than crashing the preview/print pipeline.
    body = `<pre style="white-space:pre-wrap">${html}</pre>`;
  }

  const combined = buildTemplateCss(css);

  // If the template is already a full document, inject into it rather than
  // nesting a second <html>.
  if (/<html[\s>]/i.test(body)) {
    return injectStyles(body, combined);
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style data-printninja>${combined}</style>
</head>
<body>
${body}
</body>
</html>`;
}

/** Wrap a fragment in a full document with the bundled print stylesheet. */
export function wrapWithTailwind(html: string, css: string): string {
  return renderTemplate(html, css, {});
}
