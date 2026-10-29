/**
 * Print via PC (Release B §3.5), phone-side settings.
 *
 * `print_via_pc` reroutes the print dialog from the local pipeline to
 * the `remote_print` command; `print_via_pc_device` names the PC when
 * more than one is paired. Both live in the Rust settings table (with a
 * localStorage mirror via read/writeSetting), next to `render_pairs`.
 */
import { agent } from "@/lib/agent/commands";
import type { PcPrinterInfo, RenderPair } from "@/lib/agent/types";
import { parsePairs } from "@/lib/pairing";
import { readSetting, writeSetting } from "@/lib/settings";

export const PRINT_VIA_PC_KEY = "print_via_pc";
export const PRINT_VIA_PC_DEVICE_KEY = "print_via_pc_device";

export async function isPrintViaPc(): Promise<boolean> {
  return (await readSetting(PRINT_VIA_PC_KEY)) === "true";
}

export async function setPrintViaPc(on: boolean): Promise<void> {
  await writeSetting(PRINT_VIA_PC_KEY, on ? "true" : "false");
}

export async function getPrintViaPcDevice(): Promise<string | null> {
  return readSetting(PRINT_VIA_PC_DEVICE_KEY);
}

export async function setPrintViaPcDevice(id: string | null): Promise<void> {
  await writeSetting(PRINT_VIA_PC_DEVICE_KEY, id ?? "");
}

/** This phone's paired PCs, newest first (the setting stores them so). */
export async function listPhonePairs(): Promise<RenderPair[]> {
  return parsePairs(await readSetting("render_pairs"));
}

/**
 * Which pair the dialog prints through: the explicit choice, else the
 * stored default, else the only pair. Null when the user must choose —
 * mirroring the backend, which refuses to guess.
 */
export function resolvePhonePair(
  pairs: RenderPair[],
  wanted: string | null,
): RenderPair | null {
  if (pairs.length === 0) return null;
  if (wanted) {
    return (
      pairs.find((p) => p.provider_id === wanted || p.id === wanted) ?? null
    );
  }
  if (pairs.length === 1) return pairs[0];
  return null;
}

/** PC printers for the dialog: live, else the last good list. */
export async function fetchPcPrinters(
  pairId?: string | null,
  refresh?: boolean,
): Promise<{ printers: PcPrinterInfo[]; cached: boolean }> {
  return agent("remote_printers", { pair_id: pairId ?? null, refresh });
}
