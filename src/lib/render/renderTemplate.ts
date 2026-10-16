import Handlebars from "handlebars";

const TAILWIND_CDN = `<script src="https://cdn.tailwindcss.com"></script>`;

export function renderTemplate(
  html: string,
  css: string,
  data: Record<string, unknown>,
): string {
  // Register helpers
  Handlebars.registerHelper("currency", function (value: number, symbol?: string) {
    // Handlebars passes options as the last argument
    const realSymbol = typeof symbol === "string" ? symbol : "$";
    return `${realSymbol}${Number(value || 0).toFixed(2)}`;
  });

  Handlebars.registerHelper("date", function (value: string, format?: string) {
    if (!value) return "";
    const realFormat = typeof format === "string" ? format : undefined;
    const d = new Date(value);
    if (realFormat === "short") return d.toLocaleDateString();
    if (realFormat === "time") return d.toLocaleTimeString();
    return d.toLocaleString();
  });

  Handlebars.registerHelper("upper", function (value: string) {
    return value?.toUpperCase() || "";
  });

  Handlebars.registerHelper("lower", function (value: string) {
    return value?.toLowerCase() || "";
  });

  Handlebars.registerHelper("number", function (value: number, decimals?: number) {
    const realDecimals = typeof decimals === "number" ? decimals : 0;
    return Number(value || 0).toFixed(realDecimals);
  });

  // Compile and render
  const template = Handlebars.compile(html);
  const bodyContent = template(data);

  // Wrap with full HTML document + Tailwind
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  ${TAILWIND_CDN}
  <style>${css}</style>
</head>
${bodyContent}
</html>`;
}

export function wrapWithTailwind(html: string, css: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  ${TAILWIND_CDN}
  <style>${css}</style>
</head>
<body>
${html}
</body>
</html>`;
}
