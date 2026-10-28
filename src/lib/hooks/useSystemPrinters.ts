import { useEffect, useState } from "react";
import { agent } from "@/lib/agent/commands";

import type { PrinterRow, SystemPrinterRow } from "@/lib/agent/types";

export type SystemPrinter = SystemPrinterRow;

/**
 * The Print page's printer choices: printers saved on the Printers page
 * (network, USB, Bluetooth and system ones alike) plus whatever the OS
 * reports. Saved printers come first and win a name clash, because printing
 * resolves a printer by name against the saved table.
 *
 * Only the OS scan is cached. Saved printers are a cheap local DB read and
 * change the moment one is added, so they are read on every load — caching
 * them hid a freshly added printer from this page.
 */
let systemCache: SystemPrinter[] | null = null;
let systemCacheAt = 0;
const TTL_MS = 5 * 60 * 1000; // 5 minutes

function fromSaved(p: PrinterRow): SystemPrinter {
  return {
    // Prefixed so a saved id can never collide with a system printer's id.
    id: `saved:${p.id}`,
    name: p.name,
    address: p.address,
    printer_type: p.printer_type,
    language: p.language,
    status: p.status,
  };
}

/** Saved first, then system printers whose name is not already saved. */
export function mergePrinters(
  saved: PrinterRow[],
  system: SystemPrinter[],
): SystemPrinter[] {
  const seen = new Set<string>();
  const out: SystemPrinter[] = [];
  for (const p of [...saved.map(fromSaved), ...system]) {
    const key = p.name.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

async function loadSaved(): Promise<PrinterRow[]> {
  try {
    return (await agent("list_printers", {})) ?? [];
  } catch {
    return [];
  }
}

async function loadSystem(force: boolean): Promise<SystemPrinter[]> {
  if (!force && systemCache && Date.now() - systemCacheAt < TTL_MS) {
    return systemCache;
  }
  try {
    systemCache = (await agent("enumerate_system_printers")) ?? [];
    systemCacheAt = Date.now();
    return systemCache;
  } catch {
    // Discovery can fail (no spooler, no CUPS); saved printers still work.
    return systemCache ?? [];
  }
}

export function useSystemPrinters() {
  const [printers, setPrinters] = useState<SystemPrinter[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [saved, system] = await Promise.all([
        loadSaved(),
        loadSystem(false),
      ]);
      if (cancelled) return;
      setPrinters(mergePrinters(saved, system));
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Re-read everything, including a fresh OS scan. */
  const refresh = async () => {
    const [saved, system] = await Promise.all([loadSaved(), loadSystem(true)]);
    const merged = mergePrinters(saved, system);
    setPrinters(merged);
    return merged;
  };

  return { printers, loading, refresh };
}
