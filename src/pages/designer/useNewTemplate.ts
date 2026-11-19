import { useTranslation } from "react-i18next";
import { useCallback, useState } from "react";
import { ApiError } from "@/lib/api/errors";
import { notifySuccess, notifyError } from "@/lib/notify";
import { newTemplateContent } from "@/lib/templates/defaultTemplate";
import { createTemplateOnServer } from "@/lib/share/save";
import type { TemplateRow } from "./useDesignerDocument";

/**
 * The two-step "new template" dialog state (pack choice, then name) and
 * the create round-trip. `addTemplate` lands a created row the same way
 * the list loads one: mark the content loaded, append the row, open it.
 */
export function useNewTemplate(deps: {
  templates: TemplateRow[];
  offline: boolean;
  addTemplate: (tpl: TemplateRow) => void;
}) {
  const { t } = useTranslation();
  const [showNewTemplateDialog, setShowNewTemplateDialog] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState("");
  // The create round-trip (server PUT + local cache) is async: while it
  // runs the dialog holds still so a second click cannot double-create.
  const [creatingTemplate, setCreatingTemplate] = useState(false);
  // Name problems show under the field, not as a toast.
  const [newNameError, setNewNameError] = useState("");
  const [newTemplatePackId, setNewTemplatePackId] = useState(() => {
    try {
      return localStorage.getItem("printninja.last_pack") || "receipt";
    } catch {
      return "receipt";
    }
  });
  const [newTemplateStep, setNewTemplateStep] = useState<"pack" | "name">(
    "pack",
  );
  const openNewTemplateDialog = useCallback(() => {
    try {
      const last = localStorage.getItem("printninja.last_pack");
      if (last) setNewTemplatePackId(last);
      else setNewTemplatePackId("receipt");
    } catch {
      setNewTemplatePackId("receipt");
    }
    setNewTemplateStep("pack");
    setNewNameError("");
    setShowNewTemplateDialog(true);
  }, []);
  // Closing the dialog resets it to the first step.
  const handleNewTemplateDialogOpenChange = (open: boolean) => {
    setShowNewTemplateDialog(open);
    if (!open) {
      setNewTemplateStep("pack");
      setNewNameError("");
    }
  };

  const createNewTemplate = async () => {
    const name = newTemplateName.trim();
    if (!name) {
      setNewNameError(t("designer.toast_name_required"));
      return;
    }
    if (
      deps.templates.some((t) => t.name.toLowerCase() === name.toLowerCase())
    ) {
      setNewNameError(t("designer.toast_name_exists"));
      return;
    }
    setNewNameError("");
    // Server-first: the server owns the copies, so a new template starts
    // there and is cached locally synced. Offline there is no creation.
    if (deps.offline) {
      notifyError(t("designer.toast_offline_create"));
      return;
    }
    let keepDialogOpen = false;
    setCreatingTemplate(true);
    try {
      const start = newTemplateContent(name, newTemplatePackId);
      try {
        localStorage.setItem("printninja.last_pack", newTemplatePackId);
      } catch {
        /* ignore */
      }
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
        html: start.html,
        css: start.css,
        page_w_mm: created.page_w_mm,
        page_h_mm: created.page_h_mm,
        orientation: created.orientation,
      };
      deps.addTemplate(tpl);
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
      const id = deps.templates.length
        ? Math.max(...deps.templates.map((t) => t.id)) + 1
        : 1;
      const start = newTemplateContent(name, newTemplatePackId);
      try {
        localStorage.setItem("printninja.last_pack", newTemplatePackId);
      } catch {
        /* ignore */
      }
      const tpl = {
        id,
        name,
        html: start.html,
        css: start.css,
        page_w_mm: start.page_w_mm,
        page_h_mm: start.page_h_mm,
        orientation: "portrait",
      };
      deps.addTemplate(tpl);
      // The new row appears in the list and the canvas opens on it —
      // visible, no toast.
    } finally {
      setCreatingTemplate(false);
      if (!keepDialogOpen) {
        setNewTemplateName("");
        setShowNewTemplateDialog(false);
      }
    }
  };

  return {
    showNewTemplateDialog,
    newTemplateName,
    setNewTemplateName,
    creatingTemplate,
    newNameError,
    setNewNameError,
    newTemplatePackId,
    setNewTemplatePackId,
    newTemplateStep,
    setNewTemplateStep,
    openNewTemplateDialog,
    handleNewTemplateDialogOpenChange,
    createNewTemplate,
  };
}
