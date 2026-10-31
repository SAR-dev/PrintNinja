import { ApiError } from "@/lib/api/errors";
import { describeError } from "@/lib/errors";
import { useTranslation } from "react-i18next";
import { PageHeader } from "@/components/PageHeader";
import { ExitViaPcButton } from "@/components/ExitViaPcButton";
import { isPrintViaPc } from "@/lib/printViaPc";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ControlsAccordion } from "@/components/designer/ControlsAccordion";
import { CanvasWorkspace } from "@/components/designer/CanvasWorkspace";
import {
  CodeEditors,
  EditorPane,
  type EditorPaneHandle,
} from "@/components/designer/EditorPane";
import {
  ControlsRail,
  type ControlsSection,
} from "@/components/designer/ControlsRail";
import {
  isDesignerLayout,
  type DesignerLayout,
} from "@/components/designer/LayoutToggle";
import { DesignerActions } from "@/components/designer/DesignerActions";
import { DesignerOverflowMenu } from "@/components/designer/DesignerOverflowMenu";
import { DesignerToolbar } from "@/components/designer/DesignerToolbar";
import { HelpersPanel } from "@/components/designer/HelpersPanel";
import { ReadmePanel } from "@/components/designer/ReadmePanel";
import { README_MAX_BYTES } from "@/components/ReadmeEditor";
import {
  SampleDataPanel,
  type Dataset,
  DATASET_NAME_MAX,
} from "@/components/designer/SampleDataPanel";
import { ClassWarnings } from "@/components/designer/ClassWarnings";
import { OfflinePrintHint } from "@/components/designer/OfflinePrintHint";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  DESKTOP_QUERY,
  WIDE_QUERY,
  useMediaQuery,
} from "@/lib/hooks/useMediaQuery";
import { usePersistentState } from "@/lib/hooks/usePersistentState";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { agent } from "@/lib/agent/commands";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { PanelLeftClose, QrCode, Save, SlidersHorizontal } from "lucide-react";
import { notifySuccess, notifyError } from "@/lib/notify";
import CodeMirror from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import {
  BARCODE_TYPES,
  buildBarcodeSnippet,
  isHelperSymbology,
} from "@/lib/utils/barcode";
import {
  DEFAULT_TEMPLATE_HTML,
  DEFAULT_TEMPLATE_CSS,
  DEFAULT_MOCK_DATA,
  NEW_TEMPLATE_PAGE_W_MM,
  NEW_TEMPLATE_PAGE_H_MM,
  newTemplateContent,
} from "@/lib/templates/defaultTemplate";
import { useCompiledCss } from "@/lib/templates/useCompiledCss";
import { listTemplates } from "@/lib/templates/listTemplates";
import { formatCss, formatHtml } from "@/lib/utils/format";
import * as share from "@/lib/share/client";
import { useShareStatus } from "@/lib/shell/useShareStatus";
import { getLocalTemplate, isReadOnly } from "@/lib/share/sync";
import {
  createTemplateOnServer,
  saveTemplateToServer,
  overwriteWithMine,
  takeServerCopy,
  TemplateConflictError,
  type TemplateContent,
} from "@/lib/share/save";

const PAGE_PRESETS = [
  { labelKey: "designer.preset_a4", width: 210, height: 297 },
  { labelKey: "designer.preset_a5", width: 148, height: 210 },
  { labelKey: "designer.preset_letter", width: 216, height: 279 },
  { labelKey: "designer.preset_roll80", width: 80, height: 200 },
  { labelKey: "designer.preset_roll58", width: 58, height: 200 },
  { labelKey: "designer.preset_label4x6", width: 102, height: 152 },
];

/** Which sync action is running. */
type SyncAction = "save" | "visibility";

export function DesignerPage() {
  const { t } = useTranslation();
  const [showBarcodeDialog, setShowBarcodeDialog] = useState(false);
  const [barcodeType, setBarcodeType] = useState("code128");
  const [barcodeValue, setBarcodeValue] = useState("");
  // On: the value is a data field (order.id) read at print time. Off: fixed text.
  const [barcodeFromData, setBarcodeFromData] = useState(true);
  const [barcodeError, setBarcodeError] = useState<string | null>(null);
  const [showNewTemplateDialog, setShowNewTemplateDialog] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState("");
  // The create round-trip (server PUT + local cache) is async: while it
  // runs the dialog holds still so a second click cannot double-create.
  const [creatingTemplate, setCreatingTemplate] = useState(false);
  // Name problems show under the field, not as a toast.
  const [newNameError, setNewNameError] = useState("");
  const [htmlCode, setHtmlCode] = useState(DEFAULT_TEMPLATE_HTML);
  const [cssCode, setCssCode] = useState(DEFAULT_TEMPLATE_CSS);
  // No template exists until one is opened or made: an empty Designer is
  // the honest starting point, not a bundled example nobody asked for.
  const [templateName, setTemplateName] = useState("");
  const [pageWidth, setPageWidth] = useState(NEW_TEMPLATE_PAGE_W_MM);
  const [pageHeight, setPageHeight] = useState(NEW_TEMPLATE_PAGE_H_MM);
  // Print-via-PC mode: templates sync down, they are not drawn here.
  const [viaPc, setViaPc] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void isPrintViaPc()
      .then((v) => {
        if (!cancelled) setViaPc(v);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  // Which tab is open on a phone. On desktop the canvas and editor are always both on screen.
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  // Desktop workspace preferences, remembered across launches.
  const [layout, setLayout] = usePersistentState<DesignerLayout>(
    "printninja.designer.layout",
    "side",
    isDesignerLayout,
  );
  const [openSections, setOpenSections] = usePersistentState<string[]>(
    "printninja.designer.openSections",
    ["page", "sample"],
    (v): v is string[] =>
      Array.isArray(v) && v.every((x) => typeof x === "string"),
  );
  // Below ~1440 px the controls column shrinks to an icon rail. Crossing that
  // width in either direction resets it; the person can still toggle it by hand.
  const isWide = useMediaQuery(WIDE_QUERY);
  const [controlsExpanded, setControlsExpanded] = useState(isWide);
  useEffect(() => setControlsExpanded(isWide), [isWide]);
  const editorRef = useRef<EditorPaneHandle>(null);
  const pendingInsert = useRef<{ text: string; back: number } | null>(null);
  useEffect(() => {
    const pending = pendingInsert.current;
    if (pending && editorRef.current) {
      pendingInsert.current = null;
      editorRef.current.insertAtCursor(pending.text, pending.back);
    }
  }, [layout]);
  const openControlsSection = (section: ControlsSection) => {
    setOpenSections(
      openSections.includes(section)
        ? openSections
        : [...openSections, section],
    );
    setControlsExpanded(true);
  };
  const [activeTab, setActiveTab] = useState("canvas");
  // Phone: Templates / Page Setup / Custom input live in a bottom sheet
  // opened from a single Settings button.
  const [controlsOpen, setControlsOpen] = useState(false);
  // What the editor held when the template was last opened or saved. The
  // difference from the live values is the "Unsaved" mark, and it asks before
  // a switch throws the edits away. The README is tracked beside it
  // (`savedReadme`) because it loads asynchronously, after the rest.
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
  const [pending, setPending] = useState<SyncAction | null>(null);
  // A save the server refused because its copy moved since this PC last
  // synced it. The dialog resolves it: take the server copy, or overwrite.
  const [conflict, setConflict] = useState<{
    rowId: number;
    serverId: string;
  } | null>(null);
  // Offline the cache is view/print only: the server owns the copies, so
  // Save (and creating) has nowhere to go and stays disabled.
  const shareStatus = useShareStatus();
  const offline = shareStatus.state !== "online";
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

  // Templates available in the designer — persisted in SQLite via
  // `list_templates` / `create_template`. Nothing is seeded: an empty
  // list means no templates yet, and the accordion shows the New action.
  // Local working copies: content for the editor plus the server link
  // when the row came from a full template (nulls when it did not).
  const [templates, setTemplates] = useState<
    Array<{
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
    }>
  >([]);
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

  // Sample datasets (variables). Persisted through the agent and
  // synced like templates; the built-in Sample Order is the fallback
  // when the cache holds none yet.
  const [datasets, setDatasets] = useState<
    Array<Dataset & { id?: number | null }>
  >([]);

  const loadDatasets = useCallback(async () => {
    try {
      const rows = (await agent("list_datasets", {})) ?? [];
      setDatasets(
        rows.map((r) => ({
          id: r.id,
          name: r.name,
          json: r.data_json,
          isDefault: false,
        })),
      );
    } catch {
      /* web mode or backend unavailable: the fallback below applies */
    }
  }, []);

  useEffect(() => {
    void loadDatasets();
  }, [loadDatasets]);

  // A completed pull lands rows after mount; reload so the new content
  // shows with no manual step.
  useEffect(() => {
    const onPulled = () => void loadDatasets();
    window.addEventListener("sync:pulled", onPulled);
    return () => window.removeEventListener("sync:pulled", onPulled);
  }, [loadDatasets]);

  // Add, edit and delete only change this local draft. `null` means no
  // pending change, so the list shown is the saved one. Save writes the draft
  // to the database; discarding the edits drops it.
  const [draftDatasets, setDraftDatasets] = useState<Array<
    Dataset & { id?: number | null }
  > | null>(null);

  const fallbackDataset: Dataset & { id?: number | null } = {
    name: "Sample Order",
    json: JSON.stringify(DEFAULT_MOCK_DATA, null, 2),
    isDefault: true,
  };
  const withFallback = (list: Array<Dataset & { id?: number | null }>) =>
    list.length > 0 ? list : [fallbackDataset];
  const workingDatasets = withFallback(draftDatasets ?? datasets);
  const visibleDatasets: Dataset[] = workingDatasets;
  const datasetKey = (list: Array<Dataset & { id?: number | null }>) =>
    JSON.stringify(list.map((d) => [d.id ?? null, d.name, d.json]));
  const datasetsDirty =
    draftDatasets !== null &&
    datasetKey(withFallback(draftDatasets)) !==
      datasetKey(withFallback(datasets));

  /** Write the draft to the database: delete removed rows, create new ones,
   * update edited ones. The untouched built-in fallback is never stored. */
  const commitDatasets = async () => {
    if (draftDatasets === null) return;
    const keep = new Set(
      draftDatasets.map((d) => d.id).filter((id) => id != null),
    );
    for (const row of datasets) {
      if (row.id != null && !keep.has(row.id)) {
        await agent("delete_dataset", { id: row.id });
      }
    }
    for (const d of draftDatasets) {
      const saved = d.id != null ? datasets.find((x) => x.id === d.id) : null;
      if (d.id == null) {
        if (d.isDefault && d.json === fallbackDataset.json) continue;
        await agent("save_dataset", {
          req: { name: d.name, data_json: d.json },
        });
      } else if (saved && saved.json !== d.json) {
        await agent("save_dataset", {
          req: { id: d.id, name: d.name, data_json: d.json },
        });
      }
    }
    setDraftDatasets(null);
    await loadDatasets();
  };

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
    // Content now lives on the template row itself; nothing more to load.
    notifySuccess(t("designer.toast_loaded", { name: tpl.name }));
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

  // The name is edited in one place (the top row), so its problems show there,
  // live, rather than as a toast on Save.
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

  // Anything that would replace the editor asks first when edits are unsaved.
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

  /**
   * Save is the one way content reaches the server: a manual, blocking
   * push of the editor's state. Success records the copy the server
   * accepted; a revision conflict asks the user which copy wins; a
   * failed save leaves nothing behind to rot (the edit stays in the
   * editor, and the row keeps its old synced content).
   */
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

  const handleSave = async () => {
    if (!currentTemplateDbId) {
      notifyError(t("designer.toast_no_template"));
      return;
    }
    if (offline) {
      notifyError(t("designer.toast_offline_save"));
      return;
    }
    // Names are unique per owner on the server (case-insensitive). Check
    // here first so a taken name never reaches the local row, which would
    // otherwise show the rejected name on the Templates page as a draft.
    const wanted = templateName.trim();
    if (!wanted) {
      notifyError(t("designer.toast_name_required"));
      return;
    }
    if (
      templates.some(
        (x) =>
          x.id !== currentTemplateDbId &&
          x.name.trim().toLowerCase() === wanted.toLowerCase(),
      )
    ) {
      notifyError(t("designer.toast_name_exists"));
      return;
    }
    if (new TextEncoder().encode(readme).length > README_MAX_BYTES) {
      notifyError(t("designer.toast_readme_too_big"));
      return;
    }
    setPending("save");
    try {
      const row = await getLocalTemplate(currentTemplateDbId);
      if (isReadOnly(row)) {
        notifyError(t("designer.toast_readonly"));
        return;
      }
      const content = { ...(await buildContent()), name: wanted };
      const result = await saveTemplateToServer(row, content);
      setRemoteId(result.remoteId);
      setPublishedAt(result.published ? result.updatedAt : null);
      setTemplates((prev) =>
        prev.map((t) =>
          t.id === currentTemplateDbId
            ? {
                ...t,
                name: content.name,
                html: content.html,
                css: content.css,
                page_w_mm: content.page_w_mm,
                page_h_mm: content.page_h_mm,
                orientation:
                  content.page_w_mm > content.page_h_mm
                    ? "landscape"
                    : "portrait",
              }
            : t,
        ),
      );
      setTemplateName(content.name);
      setBaseline({
        name: content.name,
        html: content.html,
        css: content.css,
        w: content.page_w_mm,
        h: content.page_h_mm,
      });
      setSavedReadme(content.readme);
      try {
        await commitDatasets();
      } catch (e) {
        // The template is saved; the datasets stay in the draft to retry.
        notifyError(
          t("designer.toast_save_failed", { error: describeError(e) }),
        );
        return;
      }
      window.dispatchEvent(new Event("sync:pulled"));
      notifySuccess(
        result.published
          ? "Saved — the published copy is updated"
          : "Saved to the server",
      );
    } catch (e) {
      if (e instanceof TemplateConflictError) {
        setConflict({ rowId: currentTemplateDbId, serverId: e.serverId });
        return;
      }
      if (e instanceof ApiError && e.code === "template_name_taken") {
        notifyError(t("designer.toast_name_exists"));
        return;
      }
      notifyError(describeError(e));
    } finally {
      setPending(null);
    }
  };

  /**
   * Publish is visibility-only: the switch calls publish/unpublish
   * immediately and updates the badge. Content still goes through Save,
   * except a never-pushed row is saved first so the server has a copy
   * to show or hide.
   */
  const handleVisibilityChange = async (makePublic: boolean) => {
    if (!currentTemplateDbId || offline) return;
    const row = await getLocalTemplate(currentTemplateDbId);
    if (isReadOnly(row)) return;
    const serverId = row.server_id ?? row.remote_id;
    if (!serverId) return;
    setPending("visibility");
    /** Write the publish state onto the local row too: the switch is the
     * source of truth on screen, but after a relogin the row is rebuilt
     * from the DB — state-only updates made this vanish back to private. */
    const persistPublish = async (id: string, published: string | null) => {
      setPublishedAt(published);
      setRemoteId(id);
      try {
        await agent("set_publish_info", {
          req: {
            id: currentTemplateDbId,
            remote_id: id,
            published_at: published,
          },
        });
      } catch {
        /* offline race: the next pull repairs it from the server */
      }
    };
    try {
      let id = serverId;
      if (row.base_revision == null) {
        const content = await buildContent();
        const saved = await saveTemplateToServer(row, content);
        id = saved.remoteId;
        await persistPublish(
          saved.remoteId,
          saved.published ? saved.updatedAt : null,
        );
        setTemplates((prev) =>
          prev.map((t) =>
            t.id === currentTemplateDbId
              ? {
                  ...t,
                  name: content.name,
                  html: content.html,
                  css: content.css,
                  page_w_mm: content.page_w_mm,
                  page_h_mm: content.page_h_mm,
                  orientation:
                    content.page_w_mm > content.page_h_mm
                      ? "landscape"
                      : "portrait",
                }
              : t,
          ),
        );
      }
      if (makePublic) {
        const remote = await share.publishRemoteTemplate(id);
        await persistPublish(
          id,
          remote.published_at ?? remote.updated_at ?? null,
        );
        notifySuccess(t("designer.toast_now_public"));
      } else {
        await share.unpublishRemoteTemplate(id);
        await persistPublish(id, null);
        notifySuccess(t("designer.toast_now_private"));
      }
      window.dispatchEvent(new Event("sync:pulled"));
    } catch (e) {
      notifyError(describeError(e));
    } finally {
      setPending(null);
    }
  };

  /** Resolve a save conflict by taking the server's copy into the editor. */
  const resolveTakeServer = async () => {
    if (!conflict) return;
    const row = await getLocalTemplate(conflict.rowId);
    setPending("save");
    try {
      const taken = await takeServerCopy(row);
      setHtmlCode(formatHtml(taken.html));
      setCssCode(formatCss(taken.css));
      setTemplateName(taken.name);
      setPageWidth(taken.page_w_mm);
      setPageHeight(taken.page_h_mm);
      loadReadme(taken.readme);
      setBaseline({
        name: taken.name,
        html: formatHtml(taken.html),
        css: formatCss(taken.css),
        w: taken.page_w_mm,
        h: taken.page_h_mm,
      });
      setRemoteId(conflict.serverId);
      setPublishedAt(taken.updatedAt);
      setConflict(null);
      notifySuccess(t("designer.toast_server_copy"));
    } catch (e) {
      notifyError(describeError(e));
    } finally {
      setPending(null);
    }
  };

  /** Resolve a save conflict by overwriting the server with this copy. */
  const resolveOverwrite = async () => {
    if (!conflict) return;
    setPending("save");
    try {
      const row = await getLocalTemplate(conflict.rowId);
      const content = await buildContent();
      const result = await overwriteWithMine(row, content);
      setBaseline({
        name: content.name,
        html: content.html,
        css: content.css,
        w: content.page_w_mm,
        h: content.page_h_mm,
      });
      setSavedReadme(content.readme);
      setRemoteId(result.remoteId);
      setPublishedAt(result.published ? result.updatedAt : null);
      setConflict(null);
      notifySuccess(t("designer.toast_overwrote"));
    } catch (e) {
      if (e instanceof TemplateConflictError) {
        notifyError(t("designer.toast_moved_again"));
        return;
      }
      notifyError(describeError(e));
    } finally {
      setPending(null);
    }
  };

  const createNewTemplate = async () => {
    const name = newTemplateName.trim();
    if (!name) {
      setNewNameError(t("designer.toast_name_required"));
      return;
    }
    if (templates.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
      setNewNameError(t("designer.toast_name_exists"));
      return;
    }
    setNewNameError("");
    // Server-first: the server owns the copies, so a new template starts
    // there and is cached locally synced. Offline there is no creation.
    if (offline) {
      notifyError(t("designer.toast_offline_create"));
      return;
    }
    let keepDialogOpen = false;
    setCreatingTemplate(true);
    try {
      const start = newTemplateContent(name);
      const created = await createTemplateOnServer({
        name,
        page_w_mm: start.page_w_mm,
        page_h_mm: start.page_h_mm,
        orientation: "portrait",
        html: start.html,
        css: start.css,
        readme: start.readme,
      });
      const tpl = {
        id: created.id,
        name: created.name,
        html: DEFAULT_TEMPLATE_HTML,
        css: DEFAULT_TEMPLATE_CSS,
        page_w_mm: created.page_w_mm,
        page_h_mm: created.page_h_mm,
        orientation: created.orientation,
      };
      contentLoaded.current.add(tpl.id);
      setTemplates((prev) => [...prev, tpl]);
      loadTemplate(tpl);
      setCurrentTemplateDbId(tpl.id);
      notifySuccess(t("designer.toast_created_server", { name }));
    } catch (e) {
      // The server already has a template with this name (another PC, or
      // a name this list has not synced yet). Not a fallback case: show
      // it on the field and keep the dialog open.
      if (e instanceof ApiError && e.code === "template_name_taken") {
        keepDialogOpen = true;
        setNewNameError(t("designer.toast_name_exists"));
        return;
      }
      // Web mode / DB unavailable — keep in-memory fallback so UI stays usable.
      const id = templates.length
        ? Math.max(...templates.map((t) => t.id)) + 1
        : 1;
      const start = newTemplateContent(name);
      const tpl = {
        id,
        name,
        html: start.html,
        css: start.css,
        page_w_mm: start.page_w_mm,
        page_h_mm: start.page_h_mm,
        orientation: "portrait",
      };
      contentLoaded.current.add(tpl.id);
      setTemplates((prev) => [...prev, tpl]);
      loadTemplate(tpl);
      setCurrentTemplateDbId(tpl.id);
      notifySuccess(t("designer.toast_created_local", { name }));
    } finally {
      setCreatingTemplate(false);
      if (!keepDialogOpen) {
        setNewTemplateName("");
        setShowNewTemplateDialog(false);
      }
    }
  };
  const [selectedDatasetName, setSelectedDatasetName] =
    useState("Sample Order");
  const [showDatasetDialog, setShowDatasetDialog] = useState(false);
  const [datasetName, setDatasetName] = useState("");
  const [datasetJson, setDatasetJson] = useState("{\n  \n}");
  const [editingDataset, setEditingDataset] = useState<string | null>(null);
  const [editJson, setEditJson] = useState("");
  const [showEditDataset, setShowEditDataset] = useState(false);

  // Load the template list from SQLite on mount. Nothing is seeded: an
  // empty list means no templates yet, and the empty state offers the
  // one action that matters — make one.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await listTemplates();
        if (cancelled) return;
        const hydrated = rows.map((r) => ({
          id: r.id,
          name: r.name,
          html: r.html || "",
          css: r.css || "",
          page_w_mm: r.page_w_mm,
          page_h_mm: r.page_h_mm,
          orientation: r.orientation,
          origin: r.origin ?? null,
        }));
        setTemplates(hydrated);
        const first = hydrated[0];
        if (!first) return;
        setCurrentTemplateId(first.id);
        setTemplateName(first.name);
        setHtmlCode(formatHtml(first.html));
        setCssCode(formatCss(first.css));
        setPageWidth(first.page_w_mm ?? NEW_TEMPLATE_PAGE_W_MM);
        setPageHeight(first.page_h_mm ?? NEW_TEMPLATE_PAGE_H_MM);
        setBaseline({
          name: first.name,
          html: formatHtml(first.html),
          css: formatCss(first.css),
          w: first.page_w_mm ?? NEW_TEMPLATE_PAGE_W_MM,
          h: first.page_h_mm ?? NEW_TEMPLATE_PAGE_H_MM,
        });
        setCurrentTemplateDbId(first.id);
        // README and publish info live on the full row.
        try {
          const full = await agent("get_template", { id: first.id });
          loadReadme(full.readme ?? "");
          setRemoteId(full.server_id ?? full.remote_id ?? null);
          setPublishedAt(full.published_at ?? null);
          setOrigin(full.origin === "saved" ? "saved" : "own");
        } catch {
          loadReadme("");
          setRemoteId(null);
          setPublishedAt(null);
        }
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

  // Templates reload on sync pulls so a save on another PC (or the
  // topbar sync button) refreshes this list without a remount.
  const currentTemplateDbIdRef = useRef(currentTemplateDbId);
  currentTemplateDbIdRef.current = currentTemplateDbId;
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

  const handleInsertBarcode = () => {
    const snippet = buildBarcodeSnippet(
      barcodeType,
      barcodeValue,
      barcodeFromData && isHelperSymbology(barcodeType),
    );
    if (!snippet.ok) {
      setBarcodeError(
        t(
          snippet.messageKey,
          snippet.messageParams as Record<string, string> | undefined,
        ),
      );
      return;
    }
    insertHelper(
      snippet.kind === "static" ? "\n" + snippet.text : snippet.text,
    );
    setShowBarcodeDialog(false);
    setBarcodeValue("");
    setBarcodeError(null);
    notifySuccess(t("designer.toast_barcode_inserted", { type: barcodeType }));
  };

  const sampleData = useMemo<Record<string, unknown>>(() => {
    try {
      const ds =
        visibleDatasets.find((d) => d.name === selectedDatasetName) ??
        visibleDatasets[0];
      return JSON.parse(ds.json);
    } catch {
      return DEFAULT_MOCK_DATA as Record<string, unknown>;
    }
  }, [visibleDatasets, selectedDatasetName]);

  const handleShowCanvas = () => {
    setActiveTab("canvas");
    notifySuccess(t("designer.toast_showing_canvas"));
  };

  // Live check for the Add Dataset name: length cap and no duplicates.
  const datasetNameError = (() => {
    const n = datasetName.trim();
    if (!n) return "";
    if (n.length > DATASET_NAME_MAX) {
      return t("designer.toast_dataset_name_too_long", {
        max: DATASET_NAME_MAX,
      });
    }
    const taken = workingDatasets.some(
      (d) => d.name.trim().toLowerCase() === n.toLowerCase(),
    );
    return taken ? t("designer.toast_dataset_name_exists") : "";
  })();

  // `canInsert`: the desktop editor is beside the panel, so a click inserts at
  // its cursor. A phone shows the panel on its own tab with no editor mounted,
  // so there a click copies instead.
  const renderSampleDataPanel = (canInsert: boolean) => (
    <SampleDataPanel
      onInsert={canInsert ? insertHelper : undefined}
      datasets={visibleDatasets}
      selectedName={selectedDatasetName}
      onSelect={setSelectedDatasetName}
      onAdd={() => {
        setDatasetName("");
        setDatasetJson("{\n  \n}");
        setShowDatasetDialog(true);
      }}
      onEdit={(ds) => {
        setEditingDataset(ds.name);
        setEditJson(ds.json);
        setShowEditDataset(true);
      }}
      onDelete={(ds) => {
        const next = workingDatasets.filter((d) => d.name !== ds.name);
        setDraftDatasets(next);
        if (selectedDatasetName === ds.name) {
          setSelectedDatasetName(next[0]?.name ?? fallbackDataset.name);
        }
        notifySuccess(t("designer.toast_dataset_deleted"));
      }}
    />
  );

  const controls = {
    templates,
    currentTemplateId,
    loadTemplate: (tpl: (typeof templates)[number]) =>
      unlessDiscarding(() => loadTemplate(tpl)),
    onNew: () => setShowNewTemplateDialog(true),
    templateName,
    setTemplateName,
    pageWidth,
    setPageWidth,
    pageHeight,
    setPageHeight,
    presets: PAGE_PRESETS,
    onBarcode: () => setShowBarcodeDialog(true),
  };

  const insertHelper = (text: string, back = 0) => {
    if (editorRef.current) {
      editorRef.current.insertAtCursor(text, back);
      return;
    }
    // Canvas only: no editor is mounted. Bring it back, then insert once it is.
    pendingInsert.current = { text, back };
    setLayout("side");
  };

  const editorPane = (padding: string) => (
    <div className={`flex h-full min-h-0 flex-col gap-2 ${padding}`}>
      <EditorPane
        ref={editorRef}
        className="flex-1"
        templateName={templateName}
        htmlCode={htmlCode}
        cssCode={cssCode}
        onHtmlChange={setHtmlCode}
        onCssChange={setCssCode}
        readme={readme}
        onReadmeChange={setReadme}
        readmeReadOnly={isReadOnly({ origin })}
        notices={
          <>
            <ClassWarnings html={debouncedHtml} />
            <div className="mt-1.5">
              <OfflinePrintHint />
            </div>
          </>
        }
      />
    </div>
  );

  const canvas = (fill: boolean) => (
    <CanvasWorkspace
      fill={fill}
      html={debouncedHtml}
      css={debouncedCss}
      compiledCss={compiledCss}
      data={sampleData}
      pageWidthMm={pageWidth}
      pageHeightMm={pageHeight}
    />
  );

  return (
    // On desktop the page fills the viewport (see Layout) and each pane scrolls on its own.
    <div className="space-y-4 lg:flex lg:min-h-0 lg:flex-1 lg:flex-col lg:gap-4 lg:space-y-0">
      {isDesktop ? (
        // The top row replaces the page header: it names, switches and saves
        // the open template. The sidebar already says which page this is, so
        // the title stays for screen readers only.
        <div data-slot="page-header" className="border-b pb-4">
          <h1 className="sr-only">{t("designer.title")}</h1>
          <DesignerToolbar
            templates={templates}
            currentTemplateId={currentTemplateId}
            onSelectTemplate={switchTemplate}
            noTemplate={templates.length === 0 || currentTemplateDbId == null}
            nameError={nameError}
            dirty={dirty}
            layout={layout}
            onLayoutChange={setLayout}
            onNew={() => unlessDiscarding(() => setShowNewTemplateDialog(true))}
            onSave={() => void handleSave()}
            saveDisabled={offline || isReadOnly({ origin }) || !!nameError}
            saveTitle={
              offline ? "Offline — connect to save to the server" : undefined
            }
            templateName={templateName}
            onTemplateNameChange={setTemplateName}
            remoteId={remoteId}
            publishedAt={publishedAt}
            readOnly={isReadOnly({ origin })}
            pending={pending}
            onVisibilityChange={(v) => void handleVisibilityChange(v)}
          />
        </div>
      ) : (
        <PageHeader
          title={t("designer.title")}
          description={t("pages.designer")}
        >
          <DesignerOverflowMenu
            onNew={() => setShowNewTemplateDialog(true)}
            published={!!remoteId && !!publishedAt}
            remoteId={remoteId}
            readOnly={isReadOnly({ origin })}
            busy={pending != null}
            onVisibilityChange={(v) => void handleVisibilityChange(v)}
          />
        </PageHeader>
      )}

      {viaPc && (
        <div
          data-testid="designer-via-pc-note"
          className="flex items-center gap-3 rounded-lg border border-info/30 bg-info-soft px-4 py-3 text-info"
        >
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{t("designer.via_pc_note")}</p>
          </div>
          <ExitViaPcButton onExited={() => setViaPc(false)} />
        </div>
      )}

      {/* The list is still loading: hold a neutral state so a new
          account never flashes the full editor before the empty state.
          No templates yet: the one action is making one. The toolbar's
          New button stays, but the nameless editor and canvas wait until
          there is something to edit. */}
      {templatesLoading ? (
        <p className="text-sm text-muted-foreground" role="status">
          {t("common.loading")}
        </p>
      ) : templates.length === 0 ? (
        <Card>
          <EmptyState
            title={t("designer.no_templates_yet")}
            description={t("designer.no_templates_hint")}
            action={{
              label: t("designer.newTemplate"),
              onClick: () => setShowNewTemplateDialog(true),
            }}
          />
        </Card>
      ) : isDesktop ? (
        <div className="flex min-h-0 flex-1 gap-4">
          {controlsExpanded ? (
            // One full-height panel, like the editor and canvas beside it: the
            // collapse button lives in its header so all three tops line up,
            // and the sections scroll inside it instead of leaving a gap below.
            <aside
              aria-label={t("designer.controls_expanded")}
              className="flex w-[300px] shrink-0 flex-col overflow-hidden rounded-lg border bg-card"
            >
              <div className="flex h-11 shrink-0 items-center border-b px-2">
                <button
                  type="button"
                  aria-label={t("designer.collapse_controls")}
                  title={t("designer.collapse_controls")}
                  onClick={() => setControlsExpanded(false)}
                  className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <PanelLeftClose className="h-3.5 w-3.5" aria-hidden="true" />
                  {t("designer.collapse_short")}
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <ControlsAccordion
                  {...controls}
                  showTemplates={false}
                  openSections={openSections}
                  onOpenSectionsChange={setOpenSections}
                  onInsertHelper={insertHelper}
                  samplePanel={renderSampleDataPanel(true)}
                  className="rounded-none border-0 bg-transparent"
                />
              </div>
            </aside>
          ) : (
            <ControlsRail
              onOpenSection={openControlsSection}
              onExpand={() => setControlsExpanded(true)}
            />
          )}
          {layout === "canvas" ? (
            <div className="min-h-0 min-w-0 flex-1">{canvas(true)}</div>
          ) : (
            <ResizablePanelGroup
              key={layout}
              direction={layout === "stacked" ? "vertical" : "horizontal"}
              autoSaveId={`printninja.designer.split.v2.${layout}`}
              className="min-w-0 flex-1"
            >
              <ResizablePanel
                id="editor"
                order={1}
                defaultSize={layout === "stacked" ? 55 : 58}
                minSize={30}
              >
                {editorPane(layout === "stacked" ? "pb-2" : "pr-2")}
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel
                id="canvas"
                order={2}
                defaultSize={layout === "stacked" ? 45 : 42}
                minSize={25}
              >
                <div
                  className={
                    layout === "stacked" ? "h-full pt-2" : "h-full pl-2"
                  }
                >
                  {canvas(true)}
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {/* The canvas is the first thing on screen: controls live in a
              bottom sheet opened from this single button. */}
          <Button
            variant="outline"
            className="w-full"
            onClick={() => setControlsOpen(true)}
          >
            <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
            {t("designer.settings")}
          </Button>
          <Sheet open={controlsOpen} onOpenChange={setControlsOpen}>
            <SheetContent
              side="bottom"
              className="flex max-h-[85dvh] w-full flex-col gap-0 p-0 pb-[env(safe-area-inset-bottom)]"
            >
              <DialogHeader className="border-b p-5 pr-12">
                <DialogTitle>{t("designer.settings")}</DialogTitle>
                <DialogDescription>
                  {t("designer.settings_description")}
                </DialogDescription>
              </DialogHeader>
              <div className="flex-1 overflow-y-auto p-5">
                <ControlsAccordion
                  {...controls}
                  showHelpers={false}
                  defaultOpen={[]}
                />
              </div>
              <DialogFooter className="gap-2 border-t p-5 sm:space-x-0">
                <Button onClick={() => setControlsOpen(false)}>
                  {t("designer.sheet_done")}
                </Button>
              </DialogFooter>
            </SheetContent>
          </Sheet>

          <Tabs
            value={activeTab}
            onValueChange={setActiveTab}
            className="space-y-4"
          >
            {/* Sticky view tabs + Save, so switching views and saving the
                tweak never need a scroll-up. The header
                keeps the full toolbar; this is the reachable shortcut. */}
            <div className="sticky top-0 z-10 -mx-4 bg-background/95 px-4 py-2 backdrop-blur">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1 overflow-x-auto">
                  <TabsList
                    aria-label={t("designer.views_aria")}
                    className="min-h-8 w-max gap-0.5 p-0.5"
                  >
                    <TabsTrigger
                      value="canvas"
                      className="min-h-11 px-3 text-xs"
                    >
                      {t("designer.canvas")}
                    </TabsTrigger>
                    <TabsTrigger value="code" className="min-h-11 px-3 text-xs">
                      {t("designer.code")}
                    </TabsTrigger>
                    <TabsTrigger
                      value="readme"
                      className="min-h-11 px-3 text-xs"
                    >
                      README
                    </TabsTrigger>
                    <TabsTrigger
                      value="sample-data"
                      className="min-h-11 px-3 text-xs"
                    >
                      {t("designer.sampleData")}
                    </TabsTrigger>
                  </TabsList>
                </div>
                {!isReadOnly({ origin }) && (
                  <Button
                    size="sm"
                    className="shrink-0"
                    onClick={() => void handleSave()}
                    disabled={offline || pending != null}
                  >
                    <Save className="h-4 w-4" aria-hidden="true" />
                    {t("common.save")}
                  </Button>
                )}
              </div>
            </div>

            <TabsContent value={activeTab} className="mt-0 space-y-4">
              {(activeTab === "canvas" || activeTab === "code") && (
                <ClassWarnings html={debouncedHtml} />
              )}
              {activeTab === "canvas" && canvas(false)}
              {activeTab === "code" && (
                <CodeEditors
                  templateName={templateName}
                  htmlCode={htmlCode}
                  cssCode={cssCode}
                  onHtmlChange={setHtmlCode}
                  onCssChange={setCssCode}
                />
              )}
              {activeTab === "readme" && (
                <Card className="overflow-hidden">
                  <CardContent className="p-0">
                    <ReadmePanel
                      readme={readme}
                      onChange={setReadme}
                      templateName={templateName}
                      readOnly={isReadOnly({ origin })}
                    />
                  </CardContent>
                </Card>
              )}
              {activeTab === "sample-data" && (
                <Card>
                  <CardContent className="space-y-4 pt-5">
                    {renderSampleDataPanel(false)}
                    <div className="space-y-2 border-t pt-3">
                      <h3 className="text-xs font-semibold">
                        {t("designer.helpers")}
                      </h3>
                      <HelpersPanel />
                    </div>
                  </CardContent>
                </Card>
              )}
            </TabsContent>

            <DesignerActions onShowCanvas={handleShowCanvas} />
          </Tabs>
        </div>
      )}

      {/* Barcode Dialog */}
      <Dialog open={showBarcodeDialog} onOpenChange={setShowBarcodeDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("designer.barcode_title")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="barcode-type">{t("designer.barcode_type")}</Label>
              <Select value={barcodeType} onValueChange={setBarcodeType}>
                <SelectTrigger id="barcode-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BARCODE_TYPES.map((bc) => (
                    <SelectItem key={bc.value} value={bc.value}>
                      {bc.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="barcode-from-data" className="text-sm">
                {t("designer.barcode_from_data")}
              </Label>
              <Switch
                id="barcode-from-data"
                checked={barcodeFromData && isHelperSymbology(barcodeType)}
                disabled={!isHelperSymbology(barcodeType)}
                onCheckedChange={(on) => {
                  setBarcodeFromData(on);
                  setBarcodeError(null);
                }}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="barcode-value">
                {barcodeFromData && isHelperSymbology(barcodeType)
                  ? t("designer.barcode_field")
                  : t("designer.barcode_value")}
              </Label>
              <Input
                id="barcode-value"
                placeholder={
                  barcodeFromData && isHelperSymbology(barcodeType)
                    ? t("designer.barcode_field_example")
                    : t("designer.barcode_value_hint")
                }
                value={barcodeValue}
                onChange={(e) => {
                  setBarcodeValue(e.target.value);
                  setBarcodeError(null);
                }}
              />
              <p className="text-xs text-muted-foreground">
                {!isHelperSymbology(barcodeType)
                  ? t("designer.barcode_fixed_hint")
                  : barcodeFromData
                    ? t("designer.barcode_per_print")
                    : t("designer.barcode_same")}
              </p>
              {barcodeError && (
                <p
                  id="barcode-error"
                  role="alert"
                  className="text-xs text-danger"
                >
                  {barcodeError}
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowBarcodeDialog(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              id="barcode-insert"
              onClick={handleInsertBarcode}
              disabled={!barcodeValue}
            >
              <QrCode className="h-4 w-4" />
              {t("designer.barcode_insert")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Dataset Dialog */}
      <Dialog open={showDatasetDialog} onOpenChange={setShowDatasetDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("designer.sample_add_title")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>{t("common.name")}</Label>
              <Input
                value={datasetName}
                onChange={(e) => setDatasetName(e.target.value)}
                placeholder={t("designer.sample_name_example")}
                aria-invalid={datasetNameError ? true : undefined}
              />
              <div className="flex justify-between text-xs">
                <span className="text-danger">{datasetNameError}</span>
                <span
                  className={
                    datasetName.trim().length > DATASET_NAME_MAX
                      ? "text-danger"
                      : "text-muted-foreground"
                  }
                >
                  {datasetName.trim().length}/{DATASET_NAME_MAX}
                </span>
              </div>
            </div>
            <div className="space-y-1">
              <Label>{t("designer.sample_json_label")}</Label>
              <div className="rounded-md border overflow-hidden">
                <CodeMirror
                  value={datasetJson}
                  height="160px"
                  extensions={[json()]}
                  onChange={setDatasetJson}
                  theme="light"
                  basicSetup={{ lintKeymap: true }}
                />
              </div>
              {(() => {
                try {
                  JSON.parse(datasetJson);
                  return null;
                } catch (e) {
                  return (
                    <p className="text-xs text-danger">
                      {describeError(e).split("\n")[0]}
                    </p>
                  );
                }
              })()}
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowDatasetDialog(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => {
                const name = datasetName.trim();
                if (!name) {
                  notifyError(t("designer.toast_dataset_name_required"));
                  return;
                }
                if (datasetNameError) {
                  notifyError(datasetNameError);
                  return;
                }
                try {
                  JSON.parse(datasetJson);
                } catch {
                  notifyError(t("designer.toast_invalid_json"));
                  return;
                }
                setDraftDatasets([
                  ...workingDatasets,
                  { id: null, name, json: datasetJson, isDefault: false },
                ]);
                setSelectedDatasetName(name);
                setShowDatasetDialog(false);
                notifySuccess(t("designer.toast_dataset_added", { name }));
              }}
              disabled={datasetNameError !== ""}
            >
              {t("common.add")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dataset Dialog */}
      <Dialog open={showEditDataset} onOpenChange={setShowEditDataset}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("designer.sample_edit_title", { name: editingDataset })}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-md border overflow-hidden">
              <CodeMirror
                value={editJson}
                height="200px"
                extensions={[json()]}
                onChange={setEditJson}
                theme="light"
              />
            </div>
            {(() => {
              try {
                JSON.parse(editJson);
                return null;
              } catch (e) {
                return (
                  <p className="text-xs text-danger">
                    {describeError(e).split("\n")[0]}
                  </p>
                );
              }
            })()}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEditDataset(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => {
                try {
                  JSON.parse(editJson);
                } catch {
                  notifyError(t("designer.toast_invalid_json"));
                  return;
                }
                setDraftDatasets(
                  workingDatasets.map((d) =>
                    d.name === editingDataset ? { ...d, json: editJson } : d,
                  ),
                );
                setShowEditDataset(false);
                notifySuccess(t("designer.toast_dataset_updated"));
              }}
            >
              {t("designer.sample_save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New Template Dialog */}
      <Dialog
        open={showNewTemplateDialog}
        onOpenChange={setShowNewTemplateDialog}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("designer.newTemplate")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="new-template-name">
                {t("designer.template_name")}
              </Label>
              <Input
                id="new-template-name"
                placeholder={t("designer.new_name_example")}
                value={newTemplateName}
                onChange={(e) => {
                  setNewTemplateName(e.target.value);
                  setNewNameError("");
                }}
                aria-describedby={
                  newNameError ? "new-template-name-error" : undefined
                }
                disabled={creatingTemplate}
              />
              {newNameError && (
                <p
                  id="new-template-name-error"
                  role="alert"
                  className="text-xs text-danger"
                >
                  {newNameError}
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowNewTemplateDialog(false)}
              disabled={creatingTemplate}
            >
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => void createNewTemplate()}
              disabled={creatingTemplate}
            >
              {creatingTemplate
                ? t("designer.new_creating")
                : t("designer.new_create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={discardAction !== null}
        onOpenChange={(open) => {
          if (!open) setDiscardAction(null);
        }}
        title={t("designer.discard_title")}
        description={t("designer.discard_body")}
        confirmLabel={t("designer.discard_confirm")}
        cancelLabel={t("common.cancel")}
        destructive
        onConfirm={() => {
          const action = discardAction;
          setDiscardAction(null);
          setDraftDatasets(null);
          action?.();
        }}
      />

      {/* Save conflict: the server copy moved since this PC last synced
          it. Two ways out, both explicit — nothing is chosen for the
          user, and nothing is queued to resolve later. */}
      <Dialog
        open={conflict !== null}
        onOpenChange={(open) => {
          if (!open) setConflict(null);
        }}
      >
        <DialogContent data-testid="save-conflict-dialog">
          <DialogHeader>
            <DialogTitle>{t("designer.conflict_title")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t("designer.conflict_body")}
          </p>
          <DialogFooter className="flex-col gap-2 sm:flex-col">
            <Button
              data-testid="save-conflict-overwrite"
              onClick={() => void resolveOverwrite()}
              disabled={pending !== null}
            >
              {pending === "save"
                ? t("designer.conflict_overwriting")
                : t("designer.conflict_overwrite")}
            </Button>
            <Button
              data-testid="save-conflict-take-server"
              variant="outline"
              onClick={() => void resolveTakeServer()}
              disabled={pending !== null}
            >
              {pending === "save"
                ? t("designer.conflict_loading")
                : t("designer.conflict_take_server")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
