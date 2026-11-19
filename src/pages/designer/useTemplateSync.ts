import { useTranslation } from "react-i18next";
import { useState } from "react";
import { ApiError } from "@/lib/api/errors";
import { describeError } from "@/lib/errors";
import { agent } from "@/lib/agent/commands";
import { README_MAX_BYTES } from "@/components/ReadmeEditor";
import { notifySuccess, notifyError } from "@/lib/notify";
import { getLocalTemplate, isReadOnly } from "@/lib/share/sync";
import {
  saveTemplateToServer,
  overwriteWithMine,
  restoreTemplateVersion,
  takeServerCopy,
  TemplateConflictError,
} from "@/lib/share/save";
import * as share from "@/lib/share/client";
import { formatCss, formatHtml } from "@/lib/utils/format";
import type { useDesignerDocument } from "./useDesignerDocument";

/** Which sync action is running. */
export type SyncAction = "save" | "visibility";

type Doc = ReturnType<typeof useDesignerDocument>;

/**
 * The sync actions that write the open document: Save (the one way
 * content reaches the server), the publish/unpublish switch, the save
 * conflict resolution and the version restore. `offline` gates the
 * server-bound actions; `commitDataset` folds a pending sample-data
 * edit into a successful Save.
 */
export function useTemplateSync(
  doc: Doc,
  offline: boolean,
  commitDataset: () => Promise<void>,
) {
  const { t } = useTranslation();
  const [pending, setPending] = useState<SyncAction | null>(null);
  // A save the server refused because its copy moved since this PC last
  // synced it. The dialog resolves it: take the server copy, or overwrite.
  const [conflict, setConflict] = useState<{
    rowId: number;
    serverId: string;
  } | null>(null);
  // Version history: the sheet shows the server's list for the open
  // template; a restore asks once, then writes the chosen version back
  // into the editor like a taken server copy.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [restorePending, setRestorePending] = useState<number | null>(null);
  // Bumped after a successful restore so the new version shows at the top.
  const [historyRefresh, setHistoryRefresh] = useState(0);

  const handleSave = async () => {
    if (!doc.currentTemplateDbId) {
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
    const wanted = doc.templateName.trim();
    if (!wanted) {
      notifyError(t("designer.toast_name_required"));
      return;
    }
    if (
      doc.templates.some(
        (x) =>
          x.id !== doc.currentTemplateDbId &&
          x.name.trim().toLowerCase() === wanted.toLowerCase(),
      )
    ) {
      notifyError(t("designer.toast_name_exists"));
      return;
    }
    if (new TextEncoder().encode(doc.readme).length > README_MAX_BYTES) {
      notifyError(t("designer.toast_readme_too_big"));
      return;
    }
    setPending("save");
    try {
      const row = await getLocalTemplate(doc.currentTemplateDbId);
      if (isReadOnly(row)) {
        notifyError(t("designer.toast_readonly"));
        return;
      }
      const content = { ...(await doc.buildContent()), name: wanted };
      const result = await saveTemplateToServer(row, content);
      doc.setRemoteId(result.remoteId);
      doc.setPublishedAt(result.published ? result.updatedAt : null);
      doc.setTemplates((prev) =>
        prev.map((t) =>
          t.id === doc.currentTemplateDbId
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
      doc.setTemplateName(content.name);
      doc.setBaseline({
        name: content.name,
        html: content.html,
        css: content.css,
        w: content.page_w_mm,
        h: content.page_h_mm,
      });
      doc.setSavedReadme(content.readme);
      try {
        await commitDataset();
      } catch (e) {
        // The template is saved; the dataset edit stays in the draft to retry.
        notifyError(
          t("designer.toast_save_failed", { error: describeError(e) }),
        );
        return;
      }
      window.dispatchEvent(new Event("sync:pulled"));
      notifySuccess(
        result.published
          ? t("designer.toast_saved_published")
          : t("designer.toast_saved"),
      );
    } catch (e) {
      if (e instanceof TemplateConflictError) {
        setConflict({ rowId: doc.currentTemplateDbId, serverId: e.serverId });
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
    if (!doc.currentTemplateDbId || offline) return;
    const currentTemplateDbId = doc.currentTemplateDbId;
    const row = await getLocalTemplate(currentTemplateDbId);
    if (isReadOnly(row)) return;
    const serverId = row.server_id ?? row.remote_id;
    if (!serverId) return;
    setPending("visibility");
    /** Write the publish state onto the local row too: the switch is the
     * source of truth on screen, but after a relogin the row is rebuilt
     * from the DB — state-only updates made this vanish back to private. */
    const persistPublish = async (id: string, published: string | null) => {
      doc.setPublishedAt(published);
      doc.setRemoteId(id);
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
        const content = await doc.buildContent();
        const saved = await saveTemplateToServer(row, content);
        id = saved.remoteId;
        await persistPublish(
          saved.remoteId,
          saved.published ? saved.updatedAt : null,
        );
        doc.setTemplates((prev) =>
          prev.map((t) =>
            t.id === doc.currentTemplateDbId
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
        // The visibility switch flips to match — visible, no toast.
      } else {
        await share.unpublishRemoteTemplate(id);
        await persistPublish(id, null);
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
      doc.setHtmlCode(formatHtml(taken.html));
      doc.setCssCode(formatCss(taken.css));
      doc.setTemplateName(taken.name);
      doc.setPageWidth(taken.page_w_mm);
      doc.setPageHeight(taken.page_h_mm);
      doc.loadReadme(taken.readme);
      doc.setBaseline({
        name: taken.name,
        html: formatHtml(taken.html),
        css: formatCss(taken.css),
        w: taken.page_w_mm,
        h: taken.page_h_mm,
      });
      doc.setRemoteId(conflict.serverId);
      doc.setPublishedAt(taken.publishedAt);
      setConflict(null);
      // The canvas re-renders with the server copy — visible, no toast.
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
      const content = await doc.buildContent();
      const result = await overwriteWithMine(row, content);
      doc.setBaseline({
        name: content.name,
        html: content.html,
        css: content.css,
        w: content.page_w_mm,
        h: content.page_h_mm,
      });
      doc.setSavedReadme(content.readme);
      doc.setRemoteId(result.remoteId);
      doc.setPublishedAt(result.published ? result.updatedAt : null);
      setConflict(null);
      // The overwrite lands on the server — a new version no other
      // screen shows, like a normal server save.
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

  /**
   * Restore a version: the server copies its body and CSS into the
   * template as a new revision, and the returned copy takes over the
   * editor exactly like a taken server copy. A conflict (another PC
   * saved meanwhile) opens the usual resolve dialog instead of losing
   * either copy.
   */
  const handleRestoreVersion = async (versionNo: number) => {
    if (!doc.currentTemplateDbId) return;
    if (offline) {
      notifyError(t("designer.toast_offline_save"));
      return;
    }
    setPending("save");
    try {
      const row = await getLocalTemplate(doc.currentTemplateDbId);
      if (isReadOnly(row)) {
        notifyError(t("designer.toast_readonly"));
        return;
      }
      const taken = await restoreTemplateVersion(row, versionNo);
      doc.setHtmlCode(formatHtml(taken.html));
      doc.setCssCode(formatCss(taken.css));
      doc.setTemplateName(taken.name);
      doc.setPageWidth(taken.page_w_mm);
      doc.setPageHeight(taken.page_h_mm);
      doc.loadReadme(taken.readme);
      doc.setBaseline({
        name: taken.name,
        html: formatHtml(taken.html),
        css: formatCss(taken.css),
        w: taken.page_w_mm,
        h: taken.page_h_mm,
      });
      doc.setRemoteId(row.server_id ?? row.remote_id ?? doc.remoteId);
      doc.setPublishedAt(taken.publishedAt);
      doc.setTemplates((prev) =>
        prev.map((t) =>
          t.id === doc.currentTemplateDbId
            ? {
                ...t,
                name: taken.name,
                html: taken.html,
                css: taken.css,
                page_w_mm: taken.page_w_mm,
                page_h_mm: taken.page_h_mm,
                orientation:
                  taken.page_w_mm > taken.page_h_mm ? "landscape" : "portrait",
              }
            : t,
        ),
      );
      // The restore lands as a new version — the list shows it on top.
      setHistoryRefresh((k) => k + 1);
      notifySuccess(t("designer.history_restored", { n: versionNo }));
    } catch (e) {
      if (e instanceof TemplateConflictError) {
        setConflict({ rowId: doc.currentTemplateDbId, serverId: e.serverId });
        return;
      }
      notifyError(describeError(e));
    } finally {
      setPending(null);
      setRestorePending(null);
    }
  };

  return {
    pending,
    conflict,
    setConflict,
    historyOpen,
    setHistoryOpen,
    restorePending,
    setRestorePending,
    historyRefresh,
    handleSave,
    handleVisibilityChange,
    resolveTakeServer,
    resolveOverwrite,
    handleRestoreVersion,
  };
}
