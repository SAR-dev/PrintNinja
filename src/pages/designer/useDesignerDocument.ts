import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import { agent } from "@/lib/agent/commands";
import {
  DEFAULT_TEMPLATE_HTML,
  DEFAULT_TEMPLATE_CSS,
  NEW_TEMPLATE_PAGE_W_MM,
  NEW_TEMPLATE_PAGE_H_MM,
} from "@/lib/templates/defaultTemplate";
import { listTemplates } from "@/lib/templates/listTemplates";
import { formatCss, formatHtml } from "@/lib/utils/format";
import { getLocalTemplate } from "@/lib/share/sync";
import type { TemplateContent } from "@/lib/share/save";

/** The local working copy of a template: content for the editor plus
 * the server link when the row came from a full template (nulls when
 * it did not). */
export type TemplateRow = {
  id: number;
  name: string;
  html: string;
  css: string;
  page_w_mm?: number;
  page_h_mm?: number;
  orientation?: string;
  readme?: string;
  summary?: string;
  remote_id?: string | null;
  server_id?: string | null;
  published_at?: string | null;
  origin?: string | null;
  /** The print track: `html` (document) or `scene` (label). */
  track?: string;
  /** The scene template's JSON; null for `html` rows. */
  scene_json?: string | null;
};

/**
 * The open template's document state: the editor content, its name and
 * page size, the unsaved "baseline", the README and publish info, the
 * local template rows and which one is open. The sync/save actions that
 * write this state live in `useTemplateSync`.
 *
 * `datasetsDirty` comes from `useSampleDataset`: a pending sample-data
 * edit is part of the document's unsaved state.
 */
export function useDesignerDocument(
  datasetsDirty: boolean,
  /** The `/template/:id` deep link: open that template on mount. */
  openTemplateId: number | null = null,
) {
  const { t } = useTranslation();
  const [htmlCode, setHtmlCode] = useState(DEFAULT_TEMPLATE_HTML);
  const [cssCode, setCssCode] = useState(DEFAULT_TEMPLATE_CSS);
  // No template exists until one is opened or made: an empty Designer is
  // the honest starting point, not a bundled example nobody asked for.
  const [templateName, setTemplateName] = useState("");
  const [pageWidth, setPageWidth] = useState(NEW_TEMPLATE_PAGE_W_MM);
  const [pageHeight, setPageHeight] = useState(NEW_TEMPLATE_PAGE_H_MM);
  // What the editor held when the template was last opened or saved. The
  // difference from the live values is the "Unsaved" mark, and it asks
  // before a switch throws the edits away. The README is tracked beside
  // it (`savedReadme`) because it loads asynchronously, after the rest.
  const [baseline, setBaseline] = useState<{
    name: string;
    html: string;
    css: string;
    w: number;
    h: number;
  } | null>(null);
  const [readme, setReadme] = useState("");
  const [savedReadme, setSavedReadme] = useState("");
  /** Put README text into the editor as the saved copy (open, take server, load). */
  const loadReadme = (value: string) => {
    setReadme(value);
    setSavedReadme(value);
  };
  const [remoteId, setRemoteId] = useState<string | null>(null);
  const [publishedAt, setPublishedAt] = useState<string | null>(null);
  const [origin, setOrigin] = useState<"own" | "saved">("own");

  // Templates available in the designer — persisted in SQLite via
  // `list_templates` / `create_template`. Nothing is seeded: an empty
  // list means no templates yet, and the accordion shows the New action.
  // Local working copies: content for the editor plus the server link
  // when the row came from a full template (nulls when it did not).
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [currentTemplateId, setCurrentTemplateId] = useState<number | null>(
    null,
  );

  // The active template's DB row id (null until a template is opened or
  // made — the Designer starts empty).
  const [currentTemplateDbId, setCurrentTemplateDbId] = useState<number | null>(
    null,
  );
  const [templatesLoading, setTemplatesLoading] = useState(true);

  // Template ids whose html/css in `templates` is already loaded into
  // the editor. `loadTemplate` writes content directly since rows carry
  // their own html/css.
  const contentLoaded = useRef<Set<number>>(new Set());

  // Mirrors `currentTemplateDbId` for the async effects below: null means
  // nothing is open yet, so the list load may open the first template.
  const currentTemplateDbIdRef = useRef(currentTemplateDbId);
  currentTemplateDbIdRef.current = currentTemplateDbId;

  const loadTemplate = (tpl: {
    id: number;
    name: string;
    html: string;
    css: string;
    page_w_mm?: number;
    page_h_mm?: number;
    orientation?: string;
    readme?: string;
    summary?: string;
    remote_id?: string | null;
    server_id?: string | null;
    published_at?: string | null;
    origin?: string | null;
    updated_at?: string;
    track?: string;
    scene_json?: string | null;
  }) => {
    const html = formatHtml(tpl.html);
    const css = formatCss(tpl.css);
    const w = tpl.page_w_mm || pageWidth;
    const h = tpl.page_h_mm || pageHeight;
    setCurrentTemplateId(tpl.id);
    setTemplateName(tpl.name);
    setHtmlCode(html);
    setCssCode(css);
    contentLoaded.current.add(tpl.id);
    setPageWidth(w);
    setPageHeight(h);
    setBaseline({ name: tpl.name, html, css, w, h });
    setCurrentTemplateDbId(tpl.id);
    // Load readme and publish info if provided, otherwise fetch from DB
    if (tpl.readme !== undefined) {
      loadReadme(tpl.readme);
      setRemoteId(tpl.server_id ?? tpl.remote_id ?? null);
      setPublishedAt(tpl.published_at ?? null);
      setOrigin((tpl.origin ?? "own") === "saved" ? "saved" : "own");
    } else {
      (async () => {
        try {
          const full = await agent("get_template", { id: tpl.id });
          loadReadme(full.readme ?? "");
          setRemoteId(full.server_id ?? full.remote_id ?? null);
          setPublishedAt(full.published_at ?? null);
          setOrigin(full.origin === "saved" ? "saved" : "own");
        } catch {
          loadReadme("");
          setRemoteId(null);
          setPublishedAt(null);
          setOrigin("own");
        }
      })();
    }
    // Content now lives on the template row itself; the canvas and the
    // row update visibly, so the load stays quiet.
  };

  const dirty =
    baseline !== null &&
    (templateName !== baseline.name ||
      htmlCode !== baseline.html ||
      cssCode !== baseline.css ||
      pageWidth !== baseline.w ||
      pageHeight !== baseline.h ||
      readme !== savedReadme ||
      datasetsDirty);

  // The name is edited in one place (the top row), so its problems show
  // there, live, rather than as a toast on Save.
  const nameError = (() => {
    if (currentTemplateDbId == null) return "";
    const wanted = templateName.trim();
    if (!wanted) return t("designer.toast_name_required");
    const taken = templates.some(
      (x) =>
        x.id !== currentTemplateDbId &&
        x.name.trim().toLowerCase() === wanted.toLowerCase(),
    );
    return taken ? t("designer.toast_name_exists") : "";
  })();

  // Anything that would replace the editor asks first when edits are
  // unsaved.
  const [discardAction, setDiscardAction] = useState<(() => void) | null>(null);
  const unlessDiscarding = (action: () => void) => {
    if (dirty) setDiscardAction(() => action);
    else action();
  };
  const switchTemplate = (id: number) => {
    if (id === currentTemplateId) return;
    const tpl = templates.find((x) => x.id === id);
    if (tpl) unlessDiscarding(() => loadTemplate(tpl));
  };

  /** Save is the one way content reaches the server: a manual, blocking
   * push of the editor's state. Success records the copy the server
   * accepted; a revision conflict asks the user which copy wins; a
   * failed save leaves nothing behind to rot (the edit stays in the
   * editor, and the row keeps its old synced content). */
  const buildContent = async (): Promise<TemplateContent> => {
    const row = await getLocalTemplate(currentTemplateDbId!);
    return {
      name: templateName,
      summary: row.summary ?? "",
      page_w_mm: pageWidth,
      page_h_mm: pageHeight,
      html: htmlCode,
      css: cssCode,
      readme,
    };
  };

  /** Merge freshly read rows into the working list: update the rows that
   * are there, append the new ones, and keep rows the read doesn't know
   * about (created while the read was in flight). The same rule the
   * sync:pulled handler applies. */
  const mergeRows = (prev: TemplateRow[], next: TemplateRow[]) => {
    const byId = new Map(next.map((r) => [r.id, r]));
    const merged = prev.map((t) => {
      const r = byId.get(t.id);
      if (!r) return t;
      return {
        ...t,
        name: r.name,
        html: r.html || t.html,
        css: r.css || t.css,
        page_w_mm: r.page_w_mm,
        page_h_mm: r.page_h_mm,
        orientation: r.orientation,
        origin: r.origin ?? t.origin ?? null,
        track: r.track ?? t.track ?? "html",
        scene_json: r.scene_json ?? t.scene_json ?? null,
      };
    });
    for (const r of next) {
      if (!merged.some((t) => t.id === r.id)) merged.push(r);
    }
    return merged;
  };

  // Load the template list from SQLite on mount. Nothing is seeded: an
  // empty list means no templates yet, and the empty state offers the
  // one action that matters — make one.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await listTemplates();
        if (cancelled) return;
        const hydrated: TemplateRow[] = rows.map((r) => ({
          id: r.id,
          name: r.name,
          html: r.html || "",
          css: r.css || "",
          page_w_mm: r.page_w_mm,
          page_h_mm: r.page_h_mm,
          orientation: r.orientation,
          origin: r.origin ?? null,
          track: r.track ?? "html",
          scene_json: r.scene_json ?? null,
        }));
        // Merge instead of replacing: a template created while this fetch
        // was in flight (the new-label dialog from the Templates page)
        // must not be wiped from the list when the stale snapshot
        // resolves.
        setTemplates((prev) => mergeRows(prev, hydrated));
        // Open one only if the user hasn't already opened or created one
        // while the fetch was in flight; the /template/:id deep link
        // wins over the first row.
        if (currentTemplateDbIdRef.current != null) return;
        const target =
          (openTemplateId != null
            ? hydrated.find((r) => r.id === openTemplateId)
            : undefined) ?? hydrated[0];
        if (target) loadTemplate(target);
      } catch {
        /* web mode / backend unavailable: the empty state applies */
      } finally {
        if (!cancelled) setTemplatesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A /template/:id deep link that arrives while the page is already
  // mounted (the routes share the component): open that template. The
  // mount effect owns the fresh-mount load, so this only acts on a
  // param change once the list is in state.
  useEffect(() => {
    if (openTemplateId == null) return;
    const row = templates.find((t) => t.id === openTemplateId);
    if (!row) return;
    loadTemplate(row);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTemplateId]);

  // Templates reload on sync pulls so a save on another PC (or the
  // topbar sync button) refreshes this list without a remount.
  useEffect(() => {
    const onPulled = async () => {
      try {
        const rows = await listTemplates();
        if (rows.length === 0) return;
        setTemplates((prev) => {
          const byId = new Map(rows.map((r) => [r.id, r]));
          const next = prev.map((t) => {
            const r = byId.get(t.id);
            if (!r) return t;
            if (r.id === currentTemplateDbIdRef.current) {
              return {
                ...t,
                name: r.name,
                page_w_mm: r.page_w_mm,
                page_h_mm: r.page_h_mm,
                orientation: r.orientation,
                track: r.track ?? t.track ?? "html",
                scene_json: r.scene_json ?? t.scene_json ?? null,
              };
            }
            return {
              ...t,
              name: r.name,
              html: r.html || t.html,
              css: r.css || t.css,
              page_w_mm: r.page_w_mm,
              page_h_mm: r.page_h_mm,
              orientation: r.orientation,
              origin: r.origin ?? t.origin ?? null,
              track: r.track ?? t.track ?? "html",
              scene_json: r.scene_json ?? t.scene_json ?? null,
            };
          });
          for (const r of rows) {
            if (!next.some((t) => t.id === r.id)) {
              next.push({
                id: r.id,
                name: r.name,
                html: r.html || "",
                css: r.css || "",
                page_w_mm: r.page_w_mm,
                page_h_mm: r.page_h_mm,
                orientation: r.orientation,
                origin: r.origin ?? null,
                track: r.track ?? "html",
                scene_json: r.scene_json ?? null,
              });
            }
          }
          return next;
        });
        // Publish state is owned by the server, so a publish made on
        // another PC lands here: refresh it for the open template.
        const openId = currentTemplateDbIdRef.current;
        if (openId != null) {
          try {
            const full = await agent("get_template", { id: openId });
            setRemoteId(full.server_id ?? full.remote_id ?? null);
            setPublishedAt(full.published_at ?? null);
            setOrigin(full.origin === "saved" ? "saved" : "own");
          } catch {
            /* row gone or backend busy: keep the state we have */
          }
        }
      } catch {
        /* keep current list on failure */
      }
    };
    window.addEventListener("sync:pulled", onPulled);
    return () => window.removeEventListener("sync:pulled", onPulled);
  }, []);

  return {
    htmlCode,
    setHtmlCode,
    cssCode,
    setCssCode,
    templateName,
    setTemplateName,
    pageWidth,
    setPageWidth,
    pageHeight,
    setPageHeight,
    baseline,
    setBaseline,
    readme,
    setReadme,
    savedReadme,
    setSavedReadme,
    loadReadme,
    remoteId,
    setRemoteId,
    publishedAt,
    setPublishedAt,
    origin,
    setOrigin,
    templates,
    setTemplates,
    currentTemplateId,
    setCurrentTemplateId,
    currentTemplateDbId,
    setCurrentTemplateDbId,
    templatesLoading,
    contentLoaded,
    loadTemplate,
    dirty,
    nameError,
    discardAction,
    setDiscardAction,
    unlessDiscarding,
    switchTemplate,
    buildContent,
  };
}
