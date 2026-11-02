/**
 * Backwards-compatible re-export from packs.
 * New code should import from "@/lib/templates/packs" directly,
 * but existing imports keep working.
 */
import {
  SHIPPING_LABEL_HTML,
  SHIPPING_LABEL_CSS,
  shippingLabelReadme,
  SHIPPING_LABEL_MOCK_DATA,
} from "./packs/shippingLabel";
import { getPack } from "./packs";

/** HTML of the bundled example, Shipping Label 4x6. Every new template
 * starts from it, and the README's template-design section walks it. */
export const DEFAULT_TEMPLATE_HTML = SHIPPING_LABEL_HTML;

export const DEFAULT_TEMPLATE_CSS = SHIPPING_LABEL_CSS;

/**
 * README for the bundled label. Plain Markdown only (headings, lists,
 * GFM tables, fenced code, inline code): the README preview renders
 * exactly that, with raw HTML shown as text and comments dropped, so
 * nothing here depends on styles the preview cannot draw. The data
 * contract and placeholder table mirror DEFAULT_TEMPLATE_HTML; the
 * default-template test fails if they drift apart.
 */
export function defaultTemplateReadme(name: string): string {
  return shippingLabelReadme(name);
}

export const DEFAULT_MOCK_DATA = SHIPPING_LABEL_MOCK_DATA;

// Nothing is seeded on first run: the Designer opens with a template list
// that is genuinely empty until the person makes one. A new template starts
// from this bundled example, so there is always real content to learn from.
export const NEW_TEMPLATE_PAGE_W_MM = 102;
export const NEW_TEMPLATE_PAGE_H_MM = 152;

/** The starting content of a newly created template: the bundled shipping
 * label example at thermal-paper size, with a README to edit down.
 * When `packId` is provided the content of that pack is returned;
 * without it the shipping label is used for backwards compatibility. */
export function newTemplateContent(name: string, packId?: string) {
  if (packId) {
    const pack = getPack(packId);
    if (pack) {
      return {
        page_w_mm: pack.page_w_mm,
        page_h_mm: pack.page_h_mm,
        html: pack.html,
        css: pack.css,
        readme: pack.readme(name),
      };
    }
  }
  return {
    page_w_mm: NEW_TEMPLATE_PAGE_W_MM,
    page_h_mm: NEW_TEMPLATE_PAGE_H_MM,
    html: DEFAULT_TEMPLATE_HTML,
    css: DEFAULT_TEMPLATE_CSS,
    readme: defaultTemplateReadme(name),
  };
}

// Re-export packs for consumers that import via defaultTemplate
export { PACKS, getPack } from "./packs";
export type { TemplatePack } from "./packs";
