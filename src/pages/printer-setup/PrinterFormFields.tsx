import type { Dispatch, SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { isAndroid, isLinux } from "@/lib/platform";
import { defaultLanguageFor, type LoosePrinterForm } from "@/lib/printerSchema";
import type { ProbeCapabilitiesResult } from "@/lib/agent/types";
import { AlertTriangle, Info, Scan } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FoldSection } from "@/components/printers/FoldSection";
import { DisabledReason } from "@/components/ui/disabled-reason";
import { PAPERS, isRawWire } from "./constants";

const field = "space-y-1.5";

/**
 * The Add/Edit sheet's form body: identity fields (name, connection,
 * language with the capability probe, address), the per-field error
 * placement, the connection-specific warnings and the folded sections
 * (IPP sign-in, Bluetooth driver mode, advanced paper settings).
 */
export function PrinterFormFields({
  form,
  setForm,
  detecting,
  detectResult,
  runDetect,
  languageTouched,
  dialogTypes,
  visibleLanguages,
  languagesLimited,
  addressLabelKey,
  addressHintKey,
  addressDormant,
  addressDescribedBy,
  showAddressIssue,
  addressIssueKey,
  setAddressTouched,
  formErrorKey,
  formErrorIsAddress,
  formErrorIsPaper,
  formErrorIsDpi,
  formErrorIsGap,
  formErrorIsChunk,
  formErrorIsPause,
  formErrorIsName,
  gdiWarning,
  ippNonPdfWarning,
  rawWirePdfWarning,
  systemAndroidWarning,
  signInOpen,
  setSignInOpen,
  advancedOpen,
  setAdvancedOpen,
}: {
  form: LoosePrinterForm;
  setForm: (update: SetStateAction<LoosePrinterForm>) => void;
  detecting: boolean;
  detectResult: ProbeCapabilitiesResult | null;
  runDetect: () => void;
  languageTouched: { current: boolean };
  dialogTypes: readonly { value: string; labelKey: string }[];
  visibleLanguages: readonly { value: string; labelKey: string }[];
  languagesLimited: boolean;
  addressLabelKey: string;
  addressHintKey: string | null;
  addressDormant: boolean;
  addressDescribedBy: string | undefined;
  showAddressIssue: boolean;
  addressIssueKey: string | null;
  setAddressTouched: (v: boolean) => void;
  formErrorKey: string | null;
  formErrorIsAddress: boolean;
  formErrorIsPaper: boolean;
  formErrorIsDpi: boolean;
  formErrorIsGap: boolean;
  formErrorIsChunk: boolean;
  formErrorIsPause: boolean;
  formErrorIsName: boolean;
  gdiWarning: boolean;
  ippNonPdfWarning: boolean;
  rawWirePdfWarning: boolean;
  systemAndroidWarning: boolean;
  signInOpen: boolean;
  setSignInOpen: Dispatch<SetStateAction<boolean>>;
  advancedOpen: boolean;
  setAdvancedOpen: Dispatch<SetStateAction<boolean>>;
}) {
  const { t } = useTranslation();

  return (
    <>
      <div className={field}>
        <Label htmlFor="printer-name">{t("printers.form_name")}</Label>
        <Input
          id="printer-name"
          value={form.name}
          placeholder={t("printers.form_name_example")}
          aria-invalid={formErrorIsName || undefined}
          aria-describedby={formErrorIsName ? "printer-name-error" : undefined}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        />
        {formErrorIsName && (
          <p
            id="printer-name-error"
            role="alert"
            data-testid="printer-name-error"
            className="text-xs text-destructive"
          >
            {t("printers.err_name_required")}
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className={field}>
          {/* Fixed h-6 header row, matching the Language column's
              label+Detect row, so the two SelectTriggers below line
              up vertically no matter whether the button renders. */}
          <div className="flex h-6 items-center">
            <Label htmlFor="printer-connection">
              {t("printers.form_connection")}
            </Label>
          </div>
          <Select
            value={form.printer_type}
            onValueChange={(v) =>
              setForm((f) => ({
                ...f,
                printer_type: v,
                // New USB/Bluetooth printers send raw bytes on every
                // platform (the WebView rasterizes on Android, the
                // Windows spooler passes the job through as RAW), so
                // a PDF default would put an unreadable page on a
                // thermal head — start at ESC/POS instead. An
                // explicitly chosen language is left alone. Driver
                // mode keeps PDF valid (the driver rasterizes), and
                // leaving Bluetooth clears the flag — it is a
                // Bluetooth-only option.
                language: defaultLanguageFor(v, f.language, f.via_driver),
                via_driver: v === "bluetooth" ? f.via_driver : false,
              }))
            }
          >
            <SelectTrigger
              id="printer-connection"
              aria-label={t("printers.form_connection")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {dialogTypes.map((x) => (
                <SelectItem key={x.value} value={x.value}>
                  {t(x.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className={field}>
          {/* h-6 matches the Connection column's header row (and the
              Detect button), so both selects below start at the same y. */}
          <div className="flex h-6 items-center justify-between gap-2">
            <Label htmlFor="printer-language">
              {t("printers.form_language")}
            </Label>
            {/* TODO 2+4: ask the printer what it speaks before the
                row is saved. System printers convert anything the
                spooler gives them, so there is nothing to ask. */}
            {form.printer_type !== "system" && (
              <DisabledReason
                reason={
                  !detecting && !form.address.trim()
                    ? t("printers.detect_needs_address")
                    : undefined
                }
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-2 text-xs"
                  disabled={detecting || !form.address.trim()}
                  onClick={() => void runDetect()}
                >
                  <Scan className="h-3 w-3" aria-hidden="true" />
                  {detecting ? t("printers.detecting") : t("printers.detect")}
                </Button>
              </DisabledReason>
            )}
          </div>
          <Select
            value={form.language}
            onValueChange={(v) => {
              languageTouched.current = true;
              setForm((f) => ({ ...f, language: v }));
            }}
          >
            <SelectTrigger
              id="printer-language"
              aria-label={t("printers.form_language")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {visibleLanguages.map((x) => (
                <SelectItem key={x.value} value={x.value}>
                  {t(x.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {languagesLimited && (
        <p
          data-testid="printer-language-hint"
          className="text-xs text-muted-foreground"
        >
          {isAndroid()
            ? t("printers.lang_android_hint")
            : t("printers.lang_rawwire_hint")}
        </p>
      )}
      {detectResult && !detecting && (
        <p
          data-testid="printer-detect-result"
          className="text-xs text-muted-foreground"
        >
          {detectResult.detected
            ? t("printers.detect_done", {
                name:
                  detectResult.make_and_model ??
                  detectResult.suggested_language ??
                  "",
              })
            : t("printers.detect_unknown")}
        </p>
      )}
      {/* Names the mode for raw-wire connections (B3): the bytes go
          straight to the printer, and nothing can confirm the paper
          came out, so results read "sent", not "printed". */}
      {isRawWire(form.printer_type, form.via_driver) && (
        <p
          data-testid="printer-direct-mode"
          className="text-xs text-muted-foreground"
        >
          {t("printers.direct_mode")}
        </p>
      )}

      <div className={field}>
        <Label htmlFor="printer-address">{t(addressLabelKey)}</Label>
        <Input
          id="printer-address"
          value={form.address}
          // Dormant, not disabled: the value is still saved, and the
          // row dials it again the moment driver mode is switched off.
          aria-disabled={addressDormant || undefined}
          className={addressDormant ? "opacity-60" : undefined}
          aria-describedby={addressDescribedBy}
          aria-invalid={showAddressIssue || formErrorIsAddress || undefined}
          onBlur={() => setAddressTouched(true)}
          onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
        />
        {addressHintKey && (
          <p
            id="printer-address-hint"
            className="text-xs text-muted-foreground"
          >
            {t(addressHintKey)}
          </p>
        )}
        {showAddressIssue && addressIssueKey && (
          <p
            id="printer-address-error"
            role="alert"
            data-testid="printer-address-error"
            className="text-xs text-destructive"
          >
            {t(addressIssueKey)}
          </p>
        )}
        {formErrorIsAddress && formErrorKey && (
          <p
            id="printer-address-submit-error"
            role="alert"
            data-testid="printer-address-submit-error"
            className="text-xs text-destructive"
          >
            {t(formErrorKey)}
          </p>
        )}
      </div>

      {gdiWarning && (
        <div
          role="alert"
          data-testid="printer-gdi-warning"
          className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-warning"
        >
          <AlertTriangle
            className="mt-0.5 h-4 w-4 shrink-0"
            aria-hidden="true"
          />
          <p className="text-xs">
            {t("printers.gdi_warning", { name: form.name })}
          </p>
        </div>
      )}

      {form.printer_type === "raw_tcp" && (
        <div
          role="note"
          className="flex items-start gap-2 rounded-md border border-info/30 bg-info-soft px-3 py-2 text-info"
        >
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <p className="text-xs">{t("printers.raw_not_encrypted")}</p>
        </div>
      )}

      {ippNonPdfWarning && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-warning"
        >
          <AlertTriangle
            className="mt-0.5 h-4 w-4 shrink-0"
            aria-hidden="true"
          />
          <p className="text-xs">{t("printers.ipp_non_pdf_warning")}</p>
        </div>
      )}

      {rawWirePdfWarning && (
        <div
          role="alert"
          data-testid="printer-raw-pdf-warning"
          className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-warning"
        >
          <AlertTriangle
            className="mt-0.5 h-4 w-4 shrink-0"
            aria-hidden="true"
          />
          <p className="text-xs">{t("printers.raw_wire_pdf_warning")}</p>
        </div>
      )}

      {systemAndroidWarning && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-warning"
        >
          <AlertTriangle
            className="mt-0.5 h-4 w-4 shrink-0"
            aria-hidden="true"
          />
          <p className="text-xs">{t("printers.system_android_warning")}</p>
        </div>
      )}

      {form.printer_type === "ipp" && (
        <FoldSection
          id="printer-signin"
          data-testid="printer-signin-toggle"
          title={t("printers.ipp_signin")}
          summary={
            form.username || form.password || form.skip_tls_verification
              ? t("printers.signin_set")
              : t("printers.signin_unset")
          }
          open={signInOpen}
          onToggle={() => setSignInOpen((v) => !v)}
        >
          <div className="space-y-3">
            <div className={field}>
              <Label htmlFor="printer-username">
                {t("printers.ipp_username")}
              </Label>
              <Input
                id="printer-username"
                autoComplete="off"
                value={form.username}
                aria-describedby="printer-username-hint"
                onChange={(e) =>
                  setForm((f) => ({ ...f, username: e.target.value }))
                }
              />
              <p
                id="printer-username-hint"
                className="text-xs text-muted-foreground"
              >
                {t("printers.ipp_username_hint")}
              </p>
            </div>
            <div className={field}>
              <Label htmlFor="printer-password">
                {t("printers.ipp_password")}
              </Label>
              <Input
                id="printer-password"
                type="password"
                autoComplete="new-password"
                value={form.password}
                aria-describedby="printer-password-hint"
                onChange={(e) =>
                  setForm((f) => ({ ...f, password: e.target.value }))
                }
              />
              <p
                id="printer-password-hint"
                className="text-xs text-muted-foreground"
              >
                {t("printers.ipp_password_hint")}
              </p>
            </div>
            <label className="flex items-start gap-2 text-sm max-md:font-semibold">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4"
                checked={form.skip_tls_verification}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    skip_tls_verification: e.target.checked,
                  }))
                }
              />
              <span>
                {t("printers.ipp_skip_cert")}
                <span className="block text-xs text-muted-foreground">
                  {t("printers.ipp_skip_cert_hint")}
                </span>
              </span>
            </label>
          </div>
        </FoldSection>
      )}

      {/* Manual driver mode: hidden on Android, which has no driver
          path yet (docs/MISSING_FEATURES.md item 16) — offering a
          toggle that always errors would be worse than not showing
          it. On desktop the choice is total: on = the OS queue of
          this printer's name, off = the driverless wire, and the
          app never switches between them on its own. */}
      {form.printer_type === "bluetooth" && !isAndroid() && (
        <div className="rounded-md border p-3">
          <label className="flex items-start gap-2 text-sm max-md:font-semibold">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4"
              checked={form.via_driver}
              aria-describedby="printer-via-driver-hint"
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  via_driver: e.target.checked,
                  // PDF is only valid through the OS driver; going
                  // back to the raw wire restarts at ESC/POS.
                  language: e.target.checked
                    ? f.language
                    : defaultLanguageFor("bluetooth", f.language, false),
                }))
              }
            />
            <span>
              {t("printers.bt_driver")}
              <span
                id="printer-via-driver-hint"
                className="block text-xs text-muted-foreground"
              >
                {isLinux()
                  ? t("printers.bt_driver_hint_linux")
                  : t("printers.bt_driver_hint_windows")}
              </span>
            </span>
          </label>
        </div>
      )}
      {/* Paper width, DPI and the TSPL label gap: set once per printer,
          so they fold away — the header still shows the values. */}
      <FoldSection
        id="printer-advanced"
        data-testid="printer-advanced-toggle"
        title={t("printers.advanced")}
        summary={t("printers.advanced_summary", {
          paper: form.paper_width_mm || "—",
          dpi: form.dpi || "—",
        })}
        open={advancedOpen}
        onToggle={() => setAdvancedOpen((v) => !v)}
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className={field}>
              <Label htmlFor="printer-paper">
                {t("printers.paper_width_mm")}
              </Label>
              <Input
                id="printer-paper"
                type="number"
                min="1"
                max="1000"
                list="printer-paper-widths"
                value={form.paper_width_mm}
                aria-invalid={formErrorIsPaper || undefined}
                aria-describedby={
                  formErrorIsPaper ? "printer-paper-error" : undefined
                }
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    paper_width_mm: e.target.value,
                  }))
                }
              />
              <datalist id="printer-paper-widths">
                {PAPERS.map((x) => (
                  <option key={x.value} value={x.value}>
                    {x.label}
                  </option>
                ))}
              </datalist>
              {formErrorIsPaper && formErrorKey && (
                <p
                  id="printer-paper-error"
                  role="alert"
                  data-testid="printer-paper-error"
                  className="text-xs text-destructive"
                >
                  {t(formErrorKey)}
                </p>
              )}
            </div>
            <div className={field}>
              <Label htmlFor="printer-dpi">{t("printers.dpi")}</Label>
              <Input
                id="printer-dpi"
                type="number"
                min="50"
                max="2400"
                list="printer-dpis"
                value={form.dpi}
                aria-invalid={formErrorIsDpi || undefined}
                aria-describedby={
                  formErrorIsDpi ? "printer-dpi-error" : undefined
                }
                onChange={(e) =>
                  setForm((f) => ({ ...f, dpi: e.target.value }))
                }
              />
              <datalist id="printer-dpis">
                <option value="203" />
                <option value="300" />
                <option value="600" />
              </datalist>
              {formErrorIsDpi && formErrorKey && (
                <p
                  id="printer-dpi-error"
                  role="alert"
                  data-testid="printer-dpi-error"
                  className="text-xs text-destructive"
                >
                  {t(formErrorKey)}
                </p>
              )}
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            {t("printers.paper_width_hint")}
          </p>

          {form.language === "tspl" && (
            <div className={field}>
              <Label htmlFor="printer-label-gap">
                {t("printers.label_gap_mm")}
              </Label>
              <Input
                id="printer-label-gap"
                type="number"
                min="0.1"
                max="50"
                step="0.1"
                value={form.label_gap_mm}
                aria-invalid={formErrorIsGap || undefined}
                aria-describedby={
                  formErrorIsGap
                    ? "printer-label-gap-hint printer-label-gap-error"
                    : "printer-label-gap-hint"
                }
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    label_gap_mm: e.target.value,
                  }))
                }
              />
              <p
                id="printer-label-gap-hint"
                className="text-xs text-muted-foreground"
              >
                {t("printers.label_gap_hint")}
              </p>
              {formErrorIsGap && formErrorKey && (
                <p
                  id="printer-label-gap-error"
                  role="alert"
                  data-testid="printer-label-gap-error"
                  className="text-xs text-destructive"
                >
                  {t(formErrorKey)}
                </p>
              )}
            </div>
          )}

          {/* Bluetooth pacing (B4): only a driverless row dials the
              socket itself, so only it has a pace to tune. */}
          {form.printer_type === "bluetooth" && !form.via_driver && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className={field}>
                  <Label htmlFor="printer-bt-chunk">
                    {t("printers.bt_chunk_bytes")}
                  </Label>
                  <Input
                    id="printer-bt-chunk"
                    type="number"
                    min="32"
                    max="8192"
                    value={form.bt_chunk_bytes}
                    aria-invalid={formErrorIsChunk || undefined}
                    aria-describedby={
                      formErrorIsChunk
                        ? "printer-bt-chunk-hint printer-bt-chunk-error"
                        : "printer-bt-chunk-hint"
                    }
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        bt_chunk_bytes: e.target.value,
                      }))
                    }
                  />
                  {formErrorIsChunk && formErrorKey && (
                    <p
                      id="printer-bt-chunk-error"
                      role="alert"
                      data-testid="printer-bt-chunk-error"
                      className="text-xs text-destructive"
                    >
                      {t(formErrorKey)}
                    </p>
                  )}
                </div>
                <div className={field}>
                  <Label htmlFor="printer-bt-pause">
                    {t("printers.bt_chunk_pause_ms")}
                  </Label>
                  <Input
                    id="printer-bt-pause"
                    type="number"
                    min="0"
                    max="2000"
                    value={form.bt_chunk_pause_ms}
                    aria-invalid={formErrorIsPause || undefined}
                    aria-describedby={
                      formErrorIsPause
                        ? "printer-bt-pause-hint printer-bt-pause-error"
                        : "printer-bt-pause-hint"
                    }
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        bt_chunk_pause_ms: e.target.value,
                      }))
                    }
                  />
                  {formErrorIsPause && formErrorKey && (
                    <p
                      id="printer-bt-pause-error"
                      role="alert"
                      data-testid="printer-bt-pause-error"
                      className="text-xs text-destructive"
                    >
                      {t(formErrorKey)}
                    </p>
                  )}
                </div>
              </div>
              <p
                id="printer-bt-chunk-hint"
                className="text-xs text-muted-foreground"
              >
                {t("printers.bt_chunk_bytes_hint")}
              </p>
              <p
                id="printer-bt-pause-hint"
                className="text-xs text-muted-foreground"
              >
                {t("printers.bt_chunk_pause_hint")}
              </p>
            </div>
          )}
        </div>
      </FoldSection>
    </>
  );
}
