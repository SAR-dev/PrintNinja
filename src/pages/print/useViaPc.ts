import { useEffect, useRef, useState } from "react";
import { describeError } from "@/lib/errors";
import { notifyError } from "@/lib/notify";
import {
  fetchPcPrinters,
  fetchPcTemplates,
  getPrintViaPcDevice,
  isPrintViaPc,
  listPhonePairs,
  resolvePhonePair,
  setPrintViaPcDevice,
} from "@/lib/printViaPc";
import type {
  PcPrinterInfo,
  PcTemplateInfo,
  RenderPair,
} from "@/lib/agent/types";
import { usePcStatus } from "@/lib/shell/usePcStatus";
import { isAndroid } from "@/lib/platform";
import { hasPairedProvider } from "@/lib/pairing";
import { usePrintStore } from "@/lib/store/printStore";

/**
 * Print via PC (ARCHITECTURE §9): when the flag is on, the dialog talks to
 * the chosen paired PC instead of the local pipeline — no local transport
 * call happens while it is on.
 */
export function useViaPc(resetOutcome: () => void) {
  const store = usePrintStore();
  const [viaPc, setViaPc] = useState(false);
  const [pairs, setPairs] = useState<RenderPair[]>([]);
  const [viaPcDevice, setViaPcDevice] = useState<string | null>(null);
  const [pcPrinters, setPcPrinters] = useState<PcPrinterInfo[]>([]);
  const [pcCached, setPcCached] = useState(false);
  // Via-PC template picker: the PC's printable rows, not this phone's.
  // Chosen by server_id; history links a local row only when one exists.
  const [pcTemplates, setPcTemplates] = useState<PcTemplateInfo[]>([]);
  const [pcTemplate, setPcTemplate] = useState("");
  const [pcTemplatesCached, setPcTemplatesCached] = useState(false);
  // The initial list fetch fails quietly: hammering an unreachable PC
  // with an error toast on every page open is noise — the banner below
  // already says the PC did not answer. Manual refreshes still toast.
  const [pcFailed, setPcFailed] = useState(false);
  const viaPcPair = resolvePhonePair(pairs, viaPcDevice);
  const { status: pcStatus } = usePcStatus();
  const pcUnpaired = pcStatus.state === "down" && pcStatus.kind === "unpaired";
  // "Never paired" state for the PDF blocker below (a removed pair
  // already shows through `pcUnpaired`). Desktop renders PDF locally,
  // so it never checks.
  const [hasPair, setHasPair] = useState<boolean | null>(null);
  useEffect(() => {
    if (!isAndroid()) return;
    let cancelled = false;
    void hasPairedProvider().then((paired) => {
      if (!cancelled) setHasPair(paired);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshPcPrinters = async (pairId?: string | null) => {
    try {
      const r = await fetchPcPrinters(pairId ?? viaPcDevice, true);
      setPcPrinters(r.printers);
      setPcCached(r.cached);
      setPcFailed(false);
    } catch (e) {
      setPcFailed(true);
      notifyError(describeError(e));
    }
  };

  const refreshPcTemplates = async (pairId?: string | null, quiet = false) => {
    try {
      const r = await fetchPcTemplates(pairId ?? viaPcDevice, true);
      setPcTemplates(r.templates);
      setPcTemplatesCached(r.cached);
      if (!quiet) setPcFailed(false);
      if (
        r.templates.length > 0 &&
        !r.templates.some((x) => x.server_id === pcTemplate)
      ) {
        setPcTemplate(r.templates[0].server_id);
      }
    } catch (e) {
      if (!quiet) {
        setPcFailed(true);
        notifyError(describeError(e));
      }
    }
  };

  // Choosing here resolves the block in place: no trip to Automation.
  const pickViaPcDevice = async (id: string) => {
    resetOutcome();
    try {
      await setPrintViaPcDevice(id);
      setViaPcDevice(id);
      await refreshPcPrinters(id);
      await refreshPcTemplates(id);
    } catch (e) {
      notifyError(describeError(e));
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [flag, list, chosen] = await Promise.all([
          isPrintViaPc(),
          listPhonePairs(),
          getPrintViaPcDevice(),
        ]);
        if (cancelled) return;
        setViaPc(flag);
        setPairs(list);
        setViaPcDevice(chosen);
        if (flag) {
          try {
            const r = await fetchPcPrinters(chosen, false);
            if (!cancelled) {
              setPcPrinters(r.printers);
              setPcCached(r.cached);
              setPcFailed(false);
            }
          } catch {
            if (!cancelled) setPcFailed(true);
          }
          try {
            const r = await fetchPcTemplates(chosen, false);
            if (!cancelled) {
              setPcTemplates(r.templates);
              setPcTemplatesCached(r.cached);
              if (r.templates.length > 0) {
                setPcTemplate((cur) =>
                  cur && r.templates.some((x) => x.server_id === cur)
                    ? cur
                    : r.templates[0].server_id,
                );
              }
            }
          } catch {
            /* printers path already flagged the PC */
          }
        }
      } catch {
        /* settings unreadable: stay local */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The printer name belongs to one list or the other: flipping the
  // mode clears the other side's choice, and a landed PC list snaps an
  // empty choice to its first entry. The local list keeps its own
  // mount-time preselect below, untouched. Templates work the same way:
  // via-PC prints choose by the PC's server_id, local prints by row id.
  const prevViaPc = useRef(viaPc);
  useEffect(() => {
    if (prevViaPc.current !== viaPc) {
      prevViaPc.current = viaPc;
      usePrintStore.getState().setPrinterId("");
      setPcTemplate("");
      if (viaPc) void refreshPcTemplates(null, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viaPc]);
  useEffect(() => {
    if (
      viaPc &&
      pcPrinters.length > 0 &&
      !pcPrinters.some((p) => p.name === store.printerId)
    ) {
      usePrintStore.getState().setPrinterId(pcPrinters[0].name);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viaPc, pcPrinters]);

  const changePcTemplate = (serverId: string) => {
    if (serverId === pcTemplate) return;
    setPcTemplate(serverId);
    store.setPageRange("");
    resetOutcome();
  };

  return {
    viaPc,
    setViaPc,
    pairs,
    viaPcDevice,
    viaPcPair,
    pcUnpaired,
    pcPrinters,
    pcCached,
    pcTemplates,
    pcTemplate,
    pcTemplatesCached,
    pcFailed,
    hasPair,
    refreshPcPrinters,
    refreshPcTemplates,
    pickViaPcDevice,
    changePcTemplate,
  };
}
