import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Trash2, Plus } from "lucide-react";
import { agent } from "@/lib/agent/commands";
import type {
  PairedDevice,
  PairingState,
  PeerCapabilities,
  RenderPair,
  RenderShareStatus,
} from "@/lib/agent/types";
import { describeError } from "@/lib/errors";
import { isAndroid } from "@/lib/android/background";
import {
  startApiServer,
  stopApiServer,
  useApiStatusChanged,
} from "@/lib/apiServer";
import {
  filterPairingInput,
  formatPairingCode,
  isCompletePairingCode,
  normalizePairingCode,
  parsePairs,
} from "@/lib/pairing";
import { isWebMode, readSetting, writeSetting } from "@/lib/settings";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";

const PAIRS_KEY = "render_pairs";

/** How long the PC panel keeps regenerating an expired code by itself. */
const PAIRING_AUTO_REGEN_MS = 5 * 60 * 1000;

type TestState =
  | { state: "idle" }
  | { state: "busy" }
  | { state: "ok"; caps: PeerCapabilities }
  | { state: "error"; message: string };

/**
 * Automation → Phones tab: shared rendering (see docs/ARCHITECTURE.md §9).
 *
 * One direction only: a phone asks a PC to make its PDFs. So each device
 * shows just its own half. The PC opens a 30-second pairing window and
 * shows an 8-character code; the phone types that code and is done. When
 * the PC is off or away the phone prints on its own exactly as before.
 */
/** `onPaired` is supplied only by the Android PairingGate: it lets a
 * pair made on that screen leave immediately instead of waiting for the
 * gate's 2s poll (which briefly shows the paired device on the welcome
 * screen). Settings/Automation omit it and keep normal behaviour. */
export function DevicesCard({ onPaired }: { onPaired?: () => void } = {}) {
  const { t } = useTranslation();
  const phone = isAndroid();

  if (isWebMode()) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("settings_page.devices_title")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {t("settings_page.devices_web_notice")}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {t("settings_page.devices_title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <p className="text-sm text-muted-foreground">
          {phone
            ? t("settings_page.devices_phone_hint")
            : t("settings_page.devices_pc_hint")}
        </p>
        {phone ? <PhoneSection onPaired={onPaired} /> : <PcSection />}
      </CardContent>
    </Card>
  );
}

/** Relative "2 min ago" for paired/last-seen timestamps. */
function timeAgo(
  iso: string,
  t: (k: string, o?: Record<string, unknown>) => string,
): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return t("settings_page.devices_time_unknown");
  const secs = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (secs < 60) return t("settings_page.devices_time_just_now");
  const mins = Math.floor(secs / 60);
  if (mins < 60)
    return t("settings_page.devices_time_min_ago", { count: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24)
    return t("settings_page.devices_time_hour_ago", { count: hours });
  const days = Math.floor(hours / 24);
  return t("settings_page.devices_time_day_ago", { count: days });
}

/** PC: share this device's renderer, show pairing codes, list phones. */
function PcSection() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<RenderShareStatus | null>(null);
  const [pairing, setPairing] = useState<PairingState | null>(null);
  const [showPair, setShowPair] = useState(false);
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const panelOpenedAt = useRef(0);
  const prevOpen = useRef(false);
  const prevCount = useRef(0);

  // Sharing is only live while the local server is running and open to
  // the LAN. The saved preference alone is not enough: with the server
  // stopped or LAN access off, no phone can reach this PC, so the switch
  // must not claim it is on.
  const sharing =
    (status?.enabled ?? false) &&
    (status?.running ?? false) &&
    (status?.lan_access ?? false);

  const load = useCallback(async () => {
    try {
      setStatus(await agent("get_render_status", {}));
    } catch {
      /* backend unavailable */
    }
  }, []);

  const loadDevices = useCallback(async () => {
    try {
      setDevices(await agent("list_paired_devices", {}));
    } catch {
      /* backend unavailable */
    }
  }, []);

  useEffect(() => {
    void load();
    void loadDevices();
  }, [load, loadDevices]);
  // The server can be started or stopped from the API card above or the
  // Explorer; keep the LAN warning in step with it.
  useApiStatusChanged(load);
  // Another screen may change the list; refresh when the window regains
  // focus.
  useEffect(() => {
    const onFocus = () => {
      void loadDevices();
      void load();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load, loadDevices]);

  /** Phones reach this PC over the LAN, so the API server must be up
   * and listening beyond loopback. One tap instead of a hunt through
   * the server settings above. */
  const ensureLanServer = async () => {
    const st = await agent("get_api_status", {});
    if (st.running && st.lan_access) return;
    if (st.running) await stopApiServer();
    await startApiServer(st.port, true);
    await writeSetting("api_lan_access", "true");
  };

  const toggleSharing = async (enabled: boolean) => {
    setBusy(true);
    try {
      await agent("set_render_sharing", { enabled });
      if (enabled) {
        try {
          await ensureLanServer();
        } catch (e) {
          // Sharing stays on; the warning below offers a retry.
          toast.error(describeError(e));
        }
      } else {
        setShowPair(false);
        try {
          await agent("cancel_pairing", {});
        } catch {
          /* nothing open */
        }
      }
      await load();
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const enableLan = async () => {
    setBusy(true);
    try {
      await ensureLanServer();
      await load();
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  // While the panel is open, poll the window once a second: tick the
  // countdown, regenerate an expired code by itself (up to ~5 minutes),
  // and notice when a phone claims the code.
  useEffect(() => {
    if (!sharing || !showPair) {
      prevOpen.current = false;
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const state = await agent("get_pairing_state", {});
        if (cancelled) return;
        setPairing(state);
        if (prevOpen.current && !state.open) {
          // The window closed: either a phone claimed it or it
          // expired/locked. A grown device list means a pairing.
          const before = prevCount.current;
          const list = await agent("list_paired_devices", {});
          if (cancelled) return;
          setDevices(list);
          if (list.length > before) {
            const fresh = list.find(
              (d) => !devices.some((old) => old.id === d.id),
            );
            const name =
              fresh?.display_name ||
              fresh?.name ||
              t("settings_page.devices_phone_fallback");
            toast.success(t("settings_page.devices_paired_phone", { name }));
            setShowPair(false);
            setPairing(null);
            prevOpen.current = false;
            await load();
            return;
          }
          // Expired or locked while the panel is open: regenerate by
          // itself for a while, then leave the last state on screen.
          if (Date.now() - panelOpenedAt.current < PAIRING_AUTO_REGEN_MS) {
            try {
              const next = await agent("start_pairing", {});
              if (!cancelled) {
                setPairing(next);
                prevOpen.current = next.open;
              }
              return;
            } catch (e) {
              if (!cancelled) toast.error(describeError(e));
            }
          }
        }
        prevOpen.current = state.open;
      } catch {
        /* backend unavailable; keep the last state */
      }
    };
    const id = setInterval(() => void tick(), 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // `devices` is read for the fresh-name lookup; `load` refreshes counts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharing, showPair, t]);

  const openPanel = async () => {
    setBusy(true);
    try {
      const state = await agent("start_pairing", {});
      setPairing(state);
      prevOpen.current = state.open;
      panelOpenedAt.current = Date.now();
      try {
        const list = await agent("list_paired_devices", {});
        setDevices(list);
        prevCount.current = list.length;
      } catch {
        prevCount.current = 0;
      }
      setShowPair(true);
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const closePanel = async () => {
    setShowPair(false);
    setPairing(null);
    try {
      await agent("cancel_pairing", {});
    } catch {
      /* nothing open */
    }
  };

  const newCode = async () => {
    setBusy(true);
    try {
      const state = await agent("start_pairing", {});
      setPairing(state);
      prevOpen.current = state.open;
      panelOpenedAt.current = Date.now();
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const removeDevice = async (id: string) => {
    setBusy(true);
    try {
      await agent("revoke_paired_device", { id });
      await loadDevices();
      await load();
      setRemoving(null);
      toast.success(t("settings_page.devices_removed"));
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const clearAll = async () => {
    setBusy(true);
    try {
      await agent("clear_paired_devices", {});
      setConfirmClear(false);
      await loadDevices();
      await load();
      toast.success(t("settings_page.devices_cleared"));
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const saveRename = async (id: string) => {
    setBusy(true);
    try {
      const updated = await agent("rename_paired_device", {
        id,
        name: renameValue,
      });
      setDevices((prev) => prev.map((d) => (d.id === id ? updated : d)));
      setRenaming(null);
      setRenameValue("");
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label htmlFor="devices-share">
          {t("settings_page.devices_provider_title")}
        </Label>
        <Switch
          id="devices-share"
          data-testid="devices-share-toggle"
          checked={sharing}
          disabled={busy}
          onCheckedChange={(v) => void toggleSharing(v)}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {t("settings_page.devices_provider_hint")}
      </p>

      {status?.enabled && !sharing && (
        <div className="space-y-2 rounded-md border border-warning/40 p-3">
          <p className="text-xs text-warning">
            {t("settings_page.devices_lan_warning")}
          </p>
          <Button
            variant="outline"
            size="sm"
            data-testid="devices-lan-enable"
            disabled={busy}
            onClick={() => void enableLan()}
          >
            {t("settings_page.devices_lan_enable")}
          </Button>
        </div>
      )}

      {sharing && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {!showPair ? (
              <Button
                variant="outline"
                size="sm"
                data-testid="devices-pair-phone"
                disabled={busy}
                onClick={() => void openPanel()}
              >
                {t("settings_page.devices_pair_phone")}
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                data-testid="devices-pair-phone-hide"
                onClick={() => void closePanel()}
              >
                {t("settings_page.devices_pair_phone_hide")}
              </Button>
            )}
          </div>

          {showPair && (
            <div className="space-y-3 rounded-md border p-3">
              <p className="text-xs text-muted-foreground">
                {t("settings_page.devices_code_hint")}
              </p>
              {pairing?.open ? (
                <>
                  <p
                    className="text-center font-mono text-4xl font-bold tracking-widest"
                    data-testid="devices-pairing-code"
                  >
                    {pairing.code}
                  </p>
                  <p
                    className="text-center text-sm text-muted-foreground"
                    data-testid="devices-pairing-countdown"
                  >
                    {t("settings_page.devices_code_expires", {
                      count: pairing.expires_in,
                    })}
                  </p>
                  <p
                    className="text-center font-mono text-xs text-muted-foreground"
                    data-testid="devices-pairing-address"
                  >
                    {pairing.host}:{pairing.port}
                  </p>
                  <div className="flex justify-center">
                    <Button
                      variant="ghost"
                      size="sm"
                      data-testid="devices-new-code"
                      disabled={busy}
                      onClick={() => void newCode()}
                    >
                      {t("settings_page.devices_new_code")}
                    </Button>
                  </div>
                </>
              ) : (
                <p className="text-center text-sm text-muted-foreground">
                  {t("settings_page.devices_code_gone")}
                </p>
              )}
            </div>
          )}

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">
                {t("settings_page.devices_paired_title", {
                  count: devices.length,
                })}
              </h3>
              {devices.length > 0 && !confirmClear && (
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="devices-clear-all"
                  disabled={busy}
                  onClick={() => setConfirmClear(true)}
                >
                  {t("settings_page.devices_clear_all")}
                </Button>
              )}
            </div>

            {confirmClear && (
              <div
                role="alert"
                className="space-y-2 rounded-md border border-danger/40 p-3"
              >
                <p className="text-xs">
                  {t("settings_page.devices_clear_confirm")}
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="destructive"
                    size="sm"
                    data-testid="devices-clear-confirm"
                    disabled={busy}
                    onClick={() => void clearAll()}
                  >
                    {t("settings_page.devices_clear_yes")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirmClear(false)}
                  >
                    {t("settings_page.devices_cancel")}
                  </Button>
                </div>
              </div>
            )}

            {devices.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t("settings_page.devices_no_phones")}
              </p>
            ) : (
              <ul data-testid="devices-paired-list" className="space-y-2">
                {devices.map((d) => {
                  const name = d.display_name || d.name;
                  return (
                    <li
                      key={d.id}
                      data-testid={`devices-paired-${d.id}`}
                      className="rounded-md border p-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">
                            <span
                              className="mr-1 inline-block h-2 w-2 rounded-full bg-success"
                              aria-hidden="true"
                            />
                            {name}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {d.platform ? `${d.platform} · ` : ""}
                            {t("settings_page.devices_paired_on", {
                              date: new Date(d.paired_at).toLocaleDateString(),
                            })}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {t("settings_page.devices_last_seen", {
                              when: timeAgo(d.last_seen_at, t),
                            })}
                          </span>
                        </span>
                        <span className="flex shrink-0 items-center gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            data-testid={`devices-rename-${d.id}`}
                            onClick={() => {
                              setRenaming(d.id);
                              setRenameValue(d.display_name || "");
                            }}
                          >
                            {t("settings_page.devices_rename")}
                          </Button>
                          {removing === d.id ? (
                            <>
                              <Button
                                variant="destructive"
                                size="sm"
                                data-testid={`devices-remove-confirm-${d.id}`}
                                disabled={busy}
                                onClick={() => void removeDevice(d.id)}
                              >
                                {t("settings_page.devices_remove_yes")}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setRemoving(null)}
                              >
                                {t("settings_page.devices_cancel")}
                              </Button>
                            </>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              data-testid={`devices-remove-${d.id}`}
                              aria-label={t("settings_page.devices_remove", {
                                name,
                              })}
                              onClick={() => setRemoving(d.id)}
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          )}
                        </span>
                      </div>
                      {renaming === d.id && (
                        <div className="mt-2 flex gap-2">
                          <Input
                            data-testid={`devices-rename-input-${d.id}`}
                            value={renameValue}
                            maxLength={64}
                            placeholder={d.name}
                            onChange={(e) => setRenameValue(e.target.value)}
                          />
                          <Button
                            variant="outline"
                            size="sm"
                            data-testid={`devices-rename-save-${d.id}`}
                            disabled={busy}
                            onClick={() => void saveRename(d.id)}
                          >
                            {t("settings_page.devices_rename_save")}
                          </Button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Phone: type the PC's code. Renders always go to the paired PC. */
function PhoneSection({ onPaired }: { onPaired?: () => void }) {
  const { t } = useTranslation();
  const [pairs, setPairs] = useState<RenderPair[]>([]);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [address, setAddress] = useState("");
  const codeInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setPairs(parsePairs(await readSetting(PAIRS_KEY)));
    } catch {
      /* backend unavailable */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const savePairs = async (next: RenderPair[]) => {
    setPairs(next);
    await writeSetting(PAIRS_KEY, JSON.stringify(next));
  };

  const testPair = async (pair: RenderPair) => {
    setTests((prev) => ({ ...prev, [pair.id]: { state: "busy" } }));
    try {
      const caps = await agent("peer_capabilities", {
        host: pair.host,
        port: pair.port,
        secret: pair.secret,
        name: pair.name,
      });
      setTests((prev) => ({ ...prev, [pair.id]: { state: "ok", caps } }));
    } catch (e) {
      setTests((prev) => ({
        ...prev,
        [pair.id]: { state: "error", message: describeError(e) },
      }));
    }
  };

  /** Save a pair (replacing the same PC) and prove it works straight
   * away, so a bad code shows up now, not at the first print. */
  const addPair = async (pair: RenderPair) => {
    const others = pairs.filter((p) => {
      const sameProvider =
        pair.provider_id && p.provider_id === pair.provider_id;
      return !sameProvider && !(p.host === pair.host && p.port === pair.port);
    });
    await savePairs([...others, pair]);
    await testPair(pair);
  };

  const pairAgain = (_pair: RenderPair) => {
    setCode("");
    setAddress("");
    setFormError("");
    codeInputRef.current?.focus();
    codeInputRef.current?.scrollIntoView({ block: "center" });
  };

  const submit = async () => {
    setFormError("");
    const normalized = normalizePairingCode(code);
    if (!isCompletePairingCode(code)) {
      setFormError(t("settings_page.devices_code_invalid"));
      return;
    }
    setBusy(true);
    try {
      const trimmedAddr = address.trim();
      const pair = await agent("pair_with_code", {
        code: normalized,
        ...(trimmedAddr ? { host: trimmedAddr } : {}),
      });
      await addPair(pair);
      toast.success(t("settings_page.devices_paired_ok", { name: pair.name }));
      setCode("");
      setAddress("");
      // The pairing gate used to notice this only on its next 2s poll,
      // which left the freshly-paired device sitting on the welcome
      // screen for up to two seconds before /print replaced it. Leave as
      // soon as the pair (and its test) is done; undefined outside the
      // gate, so Settings/Automation are unaffected.
      onPaired?.();
    } catch (e) {
      setFormError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const removePair = async (id: string) => {
    await savePairs(pairs.filter((p) => p.id !== id));
  };

  const complete = isCompletePairingCode(code);

  return (
    <div className="space-y-3">
      {pairs.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("settings_page.devices_no_pairs")}
        </p>
      ) : (
        pairs.map((pair) => {
          const test = tests[pair.id] ?? { state: "idle" as const };
          const removed =
            test.state === "error" &&
            /removed this phone|pair again/i.test(test.message);
          const unreachable =
            test.state === "error" &&
            /blocked or unreachable|refused the connection|unreachable|timed out|failed/i.test(
              test.message,
            ) &&
            !removed;
          return (
            <div
              key={pair.id}
              data-testid={`devices-pair-${pair.id}`}
              className="flex items-center justify-between gap-2 rounded-md border p-3"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">
                  {pair.name}
                </span>
                <span className="block truncate font-mono text-xs text-muted-foreground">
                  {pair.host}:{pair.port}
                </span>
                {pair.platform && (
                  <span className="block truncate text-xs text-muted-foreground">
                    {pair.platform}
                    {pair.paired_at
                      ? ` · ${new Date(pair.paired_at).toLocaleDateString()}`
                      : ""}
                  </span>
                )}
                {test.state === "ok" && (
                  <span className="block text-xs text-muted-foreground">
                    {t("settings_page.devices_test_ok", {
                      score: test.caps.score,
                      cores: test.caps.cores,
                      platform: test.caps.platform,
                    })}
                  </span>
                )}
                {test.state === "error" && removed && (
                  <span role="alert" className="block text-xs text-danger">
                    {t("settings_page.devices_removed_by_pc", {
                      name: pair.name,
                    })}
                  </span>
                )}
                {test.state === "error" && unreachable && (
                  <span role="alert" className="block text-xs text-warning">
                    {t("settings_page.devices_address_changed", {
                      name: pair.name,
                    })}
                  </span>
                )}
                {test.state === "error" && !removed && !unreachable && (
                  <span role="alert" className="block text-xs text-danger">
                    {test.message}
                  </span>
                )}
              </span>
              <span className="flex shrink-0 items-center gap-2">
                {test.state === "ok" && (
                  <Badge variant="success">{test.caps.score}</Badge>
                )}
                {(removed || unreachable) && (
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid={`devices-pair-again-${pair.id}`}
                    onClick={() => pairAgain(pair)}
                  >
                    {t("settings_page.devices_pair_again")}
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  data-testid={`devices-pair-test-${pair.id}`}
                  disabled={test.state === "busy"}
                  onClick={() => void testPair(pair)}
                >
                  {test.state === "busy"
                    ? t("settings_page.devices_testing")
                    : t("settings_page.devices_test")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid={`devices-pair-remove-${pair.id}`}
                  aria-label={t("settings_page.devices_remove", {
                    name: pair.name,
                  })}
                  onClick={() => void removePair(pair.id)}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </span>
            </div>
          );
        })
      )}

      <div className="space-y-2 rounded-md border p-3">
        <Label htmlFor="devices-code">
          {t("settings_page.devices_code_entry_label")}
        </Label>
        <div className="flex gap-2">
          <Input
            id="devices-code"
            ref={codeInputRef}
            data-testid="devices-code-input"
            placeholder="XYZX-YZZY"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            className="font-mono uppercase placeholder:opacity-50"
            value={code}
            onChange={(e) => {
              setCode(filterPairingInput(e.target.value));
              setFormError("");
            }}
          />
          <Button
            data-testid="devices-code-submit"
            disabled={busy || !complete}
            onClick={() => void submit()}
          >
            <Plus className="h-4 w-4" />
            {busy
              ? t("settings_page.devices_pairing_searching")
              : t("settings_page.devices_pair_submit")}
          </Button>
        </div>
        {busy && (
          <p className="text-xs text-muted-foreground">
            {t("settings_page.devices_pairing_searching")}
          </p>
        )}
        {code && !complete && (
          <p className="text-xs text-muted-foreground">
            {t("settings_page.devices_code_hint_short", {
              code: formatPairingCode(code),
            })}
          </p>
        )}

        <details
          className="rounded-md border p-3"
          data-testid="devices-advanced"
          open={showAdvanced}
          onToggle={(e) =>
            setShowAdvanced((e.target as HTMLDetailsElement).open)
          }
        >
          <summary className="cursor-pointer text-sm">
            {t("settings_page.devices_advanced_address")}
          </summary>
          <div className="mt-3 space-y-1">
            <Label htmlFor="devices-addr">
              {t("settings_page.devices_addr_label")}
            </Label>
            <Input
              id="devices-addr"
              data-testid="devices-addr-input"
              placeholder="192.168.1.9:17717"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t("settings_page.devices_advanced_hint")}
            </p>
          </div>
        </details>
      </div>

      {formError && (
        <p role="alert" className="text-xs text-danger">
          {formError}
        </p>
      )}
    </div>
  );
}
