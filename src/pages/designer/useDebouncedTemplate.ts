import { useEffect, useState } from "react";
import { useCompiledCss } from "@/lib/templates/useCompiledCss";

/**
 * The canvas and previews render a 300 ms-debounced copy of the editor
 * content so typing does not re-render them per keystroke; the compiled
 * CSS is derived from the debounced HTML.
 */
export function useDebouncedTemplate(htmlCode: string, cssCode: string) {
  const [debouncedHtml, setDebouncedHtml] = useState(htmlCode);
  const [debouncedCss, setDebouncedCss] = useState(cssCode);
  useEffect(() => {
    const id = setTimeout(() => {
      setDebouncedHtml(htmlCode);
      setDebouncedCss(cssCode);
    }, 300);
    return () => clearTimeout(id);
  }, [htmlCode, cssCode]);
  const compiledCss = useCompiledCss(debouncedHtml);

  return { debouncedHtml, debouncedCss, compiledCss };
}
