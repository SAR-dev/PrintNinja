import Handlebars from "handlebars";

const TAILWIND_CDN = `<script src="https://cdn.tailwindcss.com"></script>`;

export function renderTemplate(
  html: string,
  css: string,
  data: Record<string, unknown>,
): string {
  // Register helpers
  Handlebars.registerHelper("currency", (value: number, symbol?: string) => {
    const sym = symbol || "$";
    return `${sym}${Number(value || 0).toFixed(2)}`;
  });

  Handlebars.registerHelper("date", (value: string, format?: string) => {
    if (!value) return "";
    const d = new Date(value);
    if (format === "short") return d.toLocaleDateString();
    if (format === "time") return d.toLocaleTimeString();
    return d.toLocaleString();
  });

  Handlebars.registerHelper("upper", (value: string) => value?.toUpperCase() || "");
  Handlebars.registerHelper("lower", (value: string) => value?.toLowerCase() || "");
  Handlebars.registerHelper("number", (value: number, decimals?: number) => {
    return Number(value || 0).toFixed(decimals || 0);
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
