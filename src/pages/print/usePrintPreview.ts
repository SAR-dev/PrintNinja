import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { agent } from "@/lib/agent/commands";
import { describeError } from "@/lib/errors";
import {
  applyPendingDeepLinkPrint,
  getPendingPrint,
  subscribePendingPrint,
  takePendingDeepLinkPrint,
} from "@/lib/deeplink";
import { renderDesignPagesRust } from "@/lib/render/rustPreview";
import type { PrintState } from "./types";
import { DEFAULT_MOCK_DATA } from "@/lib/templates/defaultTemplate";
import { compileTemplateCss } from "@/lib/templates/compileTemplateCss";
import type { TemplateListRow } from "@/lib/templates/listTemplates";
import type {
  LabelPreview,
  PcTemplateInfo,
  RenderPair,
} from "@/lib/agent/types";
import type { PrintPagePrinter } from "@/lib/hooks/useSystemPrinters";
import { usePrintStore } from "@/lib/store/printStore";

/**
 * The preview: what will print for the selected template and data
 * source. Owns the rendered pages, the template selection (local row or
 * the PC's server_id), the template-orientation default, the deep-link
 * print apply and the debounced data fetch that feeds the render.
 */
export function usePrintPreview(
  store: PrintState,
  templates: TemplateListRow[],
  viaPc: boolean,
  pcTemplates: PcTemplateInfo[],
  pcTemplate: string,
  viaPcPair: RenderPair | null,
  resetOutcome: () => void,
  /** The local row behind `store.printerId`: a scene preview prepares
   * against it (its saved profile), so the hook takes it as a
   * parameter rather than looking it up. */
  selectedPrinter: PrintPagePrinter | undefined,
) {
  const { t } = useTranslation();

  // One complete design document per record, laid out as in the Designer.
  // Paper, orientation, fit mode and margins are applied when drawing, so
  // changing them never re-renders the template.
  const [previewPages, setPreviewPages] = useState<string[]>([]);
  const [previewError, setPreviewError] = useState<string>("");
  const [previewNotice, setPreviewNotice] = useState<string>("");
  // The label track's prepared preview: the 1-bit sheets (or pdf pages)
  // `label_prepare` returned for the selected scene template.
  const [scenePreviews, setScenePreviews] = useState<LabelPreview[] | null>(
    null,
  );
  // Version ids already backfilled with compiled CSS this session, so the
  // preview effect does not write a "Compiled Tailwind CSS" version on
  // every render of the same template.
  const cssBackfilled = useRef<Set<number>>(new Set());

  const selectedTemplate = useMemo(
    () => templates.find((x) => String(x.id) === store.templateId),
    [templates, store.templateId],
  );

  // Via-PC prints choose from the PC's listing: the preview can only
  // render a local copy, so it uses the same-named one when there is
  // one — print identity always comes from the PC's server_id.
  const selectedPcTemplate = useMemo(
    () =>
      viaPc ? pcTemplates.find((x) => x.server_id === pcTemplate) : undefined,
    [viaPc, pcTemplates, pcTemplate],
  );
  const previewTemplate = viaPc
    ? selectedPcTemplate &&
      templates.find((x) => x.name === selectedPcTemplate.name)
    : selectedTemplate;

  const selectedTemplateId = selectedTemplate?.id;
  // The template's orientation is the default; flipping the selector below
  // overrides it for this print only (never written back).
  const previewTemplateKey = viaPc
    ? `pc:${pcTemplate}`
    : `local:${selectedTemplateId ?? ""}`;
  useEffect(() => {
    if (previewTemplate) {
      store.setOrientation(
        previewTemplate.orientation === "landscape" ? "landscape" : "portrait",
      );
    }
    // Keyed on the template only: a reload must not clobber a manual flip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewTemplateKey]);

  // A `printninja://print` deep link: dispatch stashes the values here
  // before navigating, and this form consumes them. The apply lands
  // after the page's own load (which re-defaults the template when the
  // store's id is unknown to the fresh list) and after the
  // template-orientation reset above, so the link's values win.
  // `deepLinkAppliedKey` records which template key the apply happened
  // for: setting the template id changes that key, which runs the reset
  // above for the new template — so the link is applied once more
  // (idempotently) and only then consumed.
  const pendingDeepLink = useSyncExternalStore(
    subscribePendingPrint,
    getPendingPrint,
    getPendingPrint,
  );
  const [deepLinkAppliedKey, setDeepLinkAppliedKey] = useState<string | null>(
    null,
  );
  useEffect(() => {
    if (!pendingDeepLink || !previewTemplate) return;
    if (deepLinkAppliedKey !== previewTemplateKey) {
      applyPendingDeepLinkPrint(pendingDeepLink);
      setDeepLinkAppliedKey(previewTemplateKey);
    } else {
      // Applied for this template, and its orientation reset already ran:
      // consume so the effect settles.
      takePendingDeepLinkPrint();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingDeepLink, previewTemplateKey, deepLinkAppliedKey]);

  // The preview follows the selected template and data source, so
  // operators see what will print. With test data it renders the bundled
  // mock; otherwise it fetches the data URL (same GET/POST choice the
  // pipeline uses) and falls back to the mock with a notice when the
  // fetch fails.
  const dataUrl = store.dataUrl;
  // A deep link's `data` (WP5): inline records for the scene track.
  const dataJson = store.dataJson;
  const useTestData = store.useTestData;
  const httpMethod = store.httpMethod;
  const pageCount = Math.min(500, Math.max(1, Math.floor(store.records || 1)));
  const PREVIEW_PAGE_CAP = 10;
  /** A hanging data URL stalls the preview; the print fetches server-side. */
  const PREVIEW_DATA_TIMEOUT_MS = 10_000;
  // The preview fetches on every keystroke without this — with POST that
  // repeats a side-effecting call against the user's endpoint.
  const [debouncedDataUrl, setDebouncedDataUrl] = useState(dataUrl);
  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedDataUrl(dataUrl), 500);
    return () => window.clearTimeout(id);
  }, [dataUrl]);
  // Pages rendered for one template must never be drawn with another
  // template's geometry (or under its error/notice) while the new render is
  // still running — a slow data URL can take up to 10 s.
  const renderedPreviewKey = useRef<string | null>(null);
  // The pages the preview shows, capped: one object repeats `pageCount`
  // times, an array prints its own length — the same records a print
  // would send. Shared by both tracks; the scene branch hands them to
  // `label_prepare`, the html branch to the Rust renderer.
  const loadShownData = async (): Promise<{
    shown: unknown[];
    notice: string;
    empty: boolean;
  }> => {
    let data: unknown = DEFAULT_MOCK_DATA;
    let notice = "";
    if (dataJson.trim()) {
      // The link's records win over the URL and the test data alike.
      try {
        data = JSON.parse(dataJson);
      } catch (e) {
        notice = t("print.preview_data_failed", { error: describeError(e) });
      }
    } else if (!useTestData && debouncedDataUrl.trim()) {
      const ctrl = new AbortController();
      const timeout = window.setTimeout(
        () => ctrl.abort(),
        PREVIEW_DATA_TIMEOUT_MS,
      );
      try {
        const res = await fetch(
          debouncedDataUrl.trim(),
          httpMethod === "POST"
            ? {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: "{}",
                signal: ctrl.signal,
              }
            : { signal: ctrl.signal },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = await res.json();
      } catch (e) {
        notice =
          e instanceof DOMException && e.name === "AbortError"
            ? t("print.preview_data_timeout")
            : t("print.preview_data_failed", {
                error: describeError(e),
              });
        data = DEFAULT_MOCK_DATA;
      } finally {
        window.clearTimeout(timeout);
      }
    }
    if (Array.isArray(data) && data.length === 0) {
      return { shown: [], notice, empty: true };
    }
    const totalPages = Array.isArray(data) ? data.length : pageCount;
    const shown = Array.isArray(data)
      ? data.slice(0, PREVIEW_PAGE_CAP)
      : Array<unknown>(Math.min(pageCount, PREVIEW_PAGE_CAP)).fill(data);
    if (totalPages > shown.length) {
      notice += `${notice ? " " : ""}${t("print.preview_truncated", {
        shown: shown.length,
        total: totalPages,
      })}`;
    }
    return { shown, notice, empty: false };
  };

  useEffect(() => {
    const template = previewTemplate;
    if (renderedPreviewKey.current !== previewTemplateKey) {
      renderedPreviewKey.current = previewTemplateKey;
      setPreviewPages([]);
      setScenePreviews(null);
      setPreviewError("");
      setPreviewNotice("");
    }
    if (!template) {
      setPreviewPages([]);
      setPreviewError("");
      // A PC template with no local same-named copy has nothing to
      // render from — but it still prints; say so instead of blankness.
      setPreviewNotice(
        viaPc && pcTemplate
          ? t("print.preview_pc_template", {
              pc: viaPcPair?.name ?? t("print.via_pc_no_pair"),
            })
          : "",
      );
      return;
    }
    if (template.track === "scene") return;
    let cancelled = false;
    (async () => {
      try {
        const html = template.html ?? "";
        const css = template.css ?? "";
        if (!html.trim()) {
          if (!cancelled) {
            setPreviewPages([]);
            setPreviewError(t("print.preview_empty_template"));
          }
          return;
        }
        // Templates saved before per-template compilation have no stored
        // Tailwind CSS. Compile on the fly so the preview matches.
        let compiledCss = template.compiled_css ?? "";
        if (!compiledCss.trim() && !cssBackfilled.current.has(template.id)) {
          cssBackfilled.current.add(template.id);
          const built = await compileTemplateCss(html);
          compiledCss = built.css;
          if (built.css.trim() && !cancelled) {
            agent("update_template_meta", {
              req: {
                id: template.id,
                name: template.name,
                page_w_mm: template.page_w_mm,
                page_h_mm: template.page_h_mm,
                compiled_css: built.css,
                compiled_key: built.key,
              },
            }).catch((e) => console.warn("Could not store compiled CSS:", e));
          }
        }

        const { shown: shownData, notice, empty } = await loadShownData();
        if (empty) {
          if (!cancelled) {
            setPreviewPages([]);
            setPreviewError(t("print.preview_empty_data"));
            setPreviewNotice(notice);
          }
          return;
        }

        // The Rust engine is the one that prints, so the preview is what
        // will print; a broken template falls back to raw-source pages
        // instead of throwing.
        const { pages } = await renderDesignPagesRust(
          html,
          css,
          shownData,
          compiledCss,
        );
        if (!cancelled) {
          setPreviewPages(pages);
          setPreviewError("");
          setPreviewNotice(notice);
        }
      } catch (e) {
        if (!cancelled) {
          setPreviewPages([]);
          setPreviewError(
            t("print.preview_unavailable", { error: describeError(e) }),
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    previewTemplate,
    dataJson,
    debouncedDataUrl,
    useTestData,
    httpMethod,
    pageCount,
    viaPc,
    pcTemplate,
    viaPcPair?.name,
  ]);

  // The label track's preview: the same `label_prepare` the print
  // runs, drawn as 1-bit sheets. The printer must be a saved row — an
  // unsaved printer has no profile to plan against, so the backend
  // would refuse the job anyway.
  useEffect(() => {
    const template = previewTemplate;
    if (!template || template.track !== "scene" || viaPc) {
      setScenePreviews(null);
      return;
    }
    const printer = selectedPrinter;
    if (!printer || !printer.id.startsWith("saved:")) {
      setScenePreviews(null);
      setPreviewError("");
      setPreviewNotice(t("print.preview_scene_saved_printer"));
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { shown, notice, empty } = await loadShownData();
        if (cancelled) return;
        if (empty) {
          setScenePreviews(null);
          setPreviewError(t("print.preview_empty_data"));
          setPreviewNotice(notice);
          return;
        }
        const resp = await agent("label_prepare", {
          req: {
            template_id: template.id,
            printer: printer.name,
            records: JSON.stringify(shown),
            copies: 1,
          },
        });
        if (!cancelled) {
          setScenePreviews(resp.preview);
          setPreviewError("");
          setPreviewNotice(notice);
        }
      } catch (e) {
        if (!cancelled) {
          setScenePreviews(null);
          setPreviewError(
            t("print.preview_unavailable", { error: describeError(e) }),
          );
          setPreviewNotice("");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    previewTemplate,
    dataJson,
    debouncedDataUrl,
    useTestData,
    httpMethod,
    pageCount,
    selectedPrinter,
    viaPc,
  ]);

  // A page range like "3-4" is meant for one document: a different template
  // starts from all pages again instead of printing (or failing on) pages
  // that were typed for the previous one.
  const changeTemplate = (id: string) => {
    if (id === usePrintStore.getState().templateId) return;
    store.setTemplateId(id);
    store.setPageRange("");
    resetOutcome();
  };

  return {
    selectedTemplate,
    selectedPcTemplate,
    previewTemplate,
    changeTemplate,
    previewPages,
    scenePreviews,
    previewError,
    previewNotice,
  };
}
