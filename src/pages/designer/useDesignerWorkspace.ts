import { useEffect, useRef, useState } from "react";
import {
  isDesignerLayout,
  type DesignerLayout,
} from "@/components/designer/LayoutToggle";
import type { EditorPaneHandle } from "@/components/designer/EditorPane";
import type { ControlsSection } from "@/components/designer/ControlsRail";
import { usePersistentState } from "@/lib/hooks/usePersistentState";

/**
 * The desktop workspace: which layout is active, which controls sections
 * are open, whether the controls column is expanded, and the editor ref
 * used for helper inserts. The layout and the open sections are
 * remembered across launches.
 */
export function useDesignerWorkspace(isWide: boolean) {
  // Desktop workspace preferences, remembered across launches.
  const [layout, setLayout] = usePersistentState<DesignerLayout>(
    "printninja.designer.layout",
    "side",
    isDesignerLayout,
  );
  const [openSections, setOpenSections] = usePersistentState<string[]>(
    "printninja.designer.openSections",
    // Page setup stays open; Sample data starts collapsed so the controls
    // column doesn't scroll before a template is even loaded (DESIGN
    // IMPROVEMENTS 4.8).
    ["page"],
    (v): v is string[] =>
      Array.isArray(v) && v.every((x) => typeof x === "string"),
  );
  // Below ~1440 px the controls column shrinks to an icon rail. Crossing
  // that width in either direction resets it; the person can still toggle
  // it by hand.
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
  // `canInsert`: the desktop editor is beside the panel, so a click
  // inserts at its cursor. A phone shows the panel on its own tab with
  // no editor mounted, so there a click copies instead.
  const insertHelper = (text: string, back = 0) => {
    if (editorRef.current) {
      editorRef.current.insertAtCursor(text, back);
      return;
    }
    // Canvas only: no editor is mounted. Bring it back, then insert once it is.
    pendingInsert.current = { text, back };
    setLayout("side");
  };

  return {
    layout,
    setLayout,
    openSections,
    setOpenSections,
    controlsExpanded,
    setControlsExpanded,
    editorRef,
    openControlsSection,
    insertHelper,
  };
}
