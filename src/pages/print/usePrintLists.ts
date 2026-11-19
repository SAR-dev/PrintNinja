import { useEffect, useState } from "react";
import { useSystemPrinters } from "@/lib/hooks/useSystemPrinters";
import { usePrintStore } from "@/lib/store/printStore";
import {
  loadPaperWidthDismissed,
  loadPrintAdvancedOpen,
  loadPrintPrefs,
  prefsKey,
  savePrintAdvancedOpen,
  type PrintPrefsMap,
} from "@/lib/printPrefs";
import { listTemplates } from "@/lib/templates/listTemplates";
import type { TemplateListRow } from "@/lib/templates/listTemplates";

/**
 * The page's local lists and remembered UI state: the printer and
 * template lists (refetched on mount, sync pull and window focus), the
 * per-printer remembered choices (F3) and the two small persisted UI
 * preferences (the dismissed paper-width prompts, the Advanced fold).
 */
export function usePrintLists() {
  const { printers, refresh: refreshSystemPrinters } = useSystemPrinters();
  const [templates, setTemplates] = useState<TemplateListRow[]>([]);
  const [loading, setLoading] = useState(true);
  // Per-printer remembered choices (F3); persisted under PRINT_PREFS_KEY.
  const [printerPrefs, setPrinterPrefs] = useState<PrintPrefsMap>({});
  // Printers whose "no paper width saved" prompt was dismissed (asked once).
  const [paperPromptDismissed, setPaperPromptDismissed] = useState<string[]>(
    [],
  );
  useEffect(() => {
    let alive = true;
    void loadPaperWidthDismissed().then((v) => {
      if (alive) setPaperPromptDismissed(v);
    });
    return () => {
      alive = false;
    };
  }, []);
  // The Advanced fold: closed by default, its state remembered globally
  // (not per printer) so the choice survives navigation.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void loadPrintAdvancedOpen()
      .then((open) => {
        if (!cancelled) setAdvancedOpen(open);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const toggleAdvanced = () => {
    const next = !advancedOpen;
    setAdvancedOpen(next);
    void savePrintAdvancedOpen(next);
  };

  // Fetch printers + templates fresh every time (mount, sync pull,
  // window focus) so a height saved in Designer is visible here.
  useEffect(() => {
    let cancelled = false;
    const load = async (first: boolean) => {
      try {
        // Saved printers plus OS ones, merged by the hook; this also
        // updates the list the dropdown shows.
        const [p, tpl, prefs] = await Promise.all([
          refreshSystemPrinters().catch(() => []),
          listTemplates().catch(() => []),
          loadPrintPrefs().catch((): PrintPrefsMap => ({})),
        ]);
        if (cancelled) return;
        setTemplates(tpl);
        setPrinterPrefs(prefs);
        const st = usePrintStore.getState();
        // The preselected printer's remembered template beats the plain
        // first-template fallback; its paper is restored on the first load
        // only, and only over an unset paper (a focus/pull reload must not
        // clobber a live session's explicit choice).
        const hadPaper = st.paperW != null || st.paperH != null;
        const effPrinter = st.printerId || (p.length > 0 ? p[0].name : "");
        if (effPrinter) st.setPrinterId(effPrinter);
        const remembered = effPrinter ? prefs[prefsKey(effPrinter)] : undefined;
        const rememberedTplOk =
          !!remembered &&
          tpl.some((x) => String(x.id) === remembered.template_id);
        if (
          tpl.length > 0 &&
          !tpl.some((x) => String(x.id) === String(st.templateId))
        )
          st.setTemplateId(
            rememberedTplOk ? remembered.template_id : String(tpl[0].id),
          );
        if (first && rememberedTplOk && !hadPaper) {
          st.setPaper(remembered.paper_w, remembered.paper_h);
        }
      } catch (e) {
        console.error("Failed to load printers/templates:", e);
      } finally {
        if (first && !cancelled) setLoading(false);
      }
    };
    void load(true);
    const onPulled = () => void load(false);
    const onFocus = () => void load(false);
    window.addEventListener("sync:pulled", onPulled);
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("sync:pulled", onPulled);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  return {
    printers,
    refreshSystemPrinters,
    templates,
    loading,
    printerPrefs,
    setPrinterPrefs,
    advancedOpen,
    toggleAdvanced,
    paperPromptDismissed,
    setPaperPromptDismissed,
  };
}
