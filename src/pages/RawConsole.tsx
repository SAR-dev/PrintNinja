/**
 * Raw console (developer tools, off by default — Settings → Diagnostics →
 * Developer tools): send hand-written bytes to a printer on its real send
 * path. The template library is the spec's known-good payload table; the
 * data field takes whatever you edit into it. Only byte counts and timings
 * are shown — never the payload itself.
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Textarea } from "@/components/ui/textarea";
import { agent } from "@/lib/agent/commands";
import type { PrinterRow, RawSendReport } from "@/lib/agent/types";
import { describeError } from "@/lib/errors";
import { decodeRaw, toBase64, type RawMode } from "./raw-console/parse";
import {
  RAW_TEMPLATE_CASES,
  RAW_TEMPLATES,
  type RawTemplate,
} from "./raw-console/templates";

const LANGUAGE_LABELS: Record<string, string> = {
  zpl: "ZPL",
  escpos: "ESC/POS",
  tspl: "TSPL",
  cpcl: "CPCL",
};

/** A non-negative whole number, or undefined when the field is empty/invalid. */
function nonNegativeInt(s: string): number | undefined {
  const t = s.trim();
  if (t === "") return undefined;
  const v = Number(t);
  return Number.isInteger(v) && v >= 0 ? v : undefined;
}

export function RawConsolePage() {
  const { t } = useTranslation();
  const [printers, setPrinters] = useState<PrinterRow[] | null>(null);
  const [printerId, setPrinterId] = useState("");
  const [showAllLanguages, setShowAllLanguages] = useState(false);
  const [mode, setMode] = useState<RawMode>("text");
  const [data, setData] = useState("");
  const [chunkBytes, setChunkBytes] = useState("");
  const [chunkPause, setChunkPause] = useState("");
  const [settleMs, setSettleMs] = useState("");
  const [sending, setSending] = useState(false);
  const [report, setReport] = useState<RawSendReport | null>(null);
  const [lastTemplate, setLastTemplate] = useState<RawTemplate | null>(null);

  useEffect(() => {
    void agent("list_printers", {})
      .then(setPrinters)
      .catch(() => setPrinters([]));
  }, []);

  const printer = useMemo(
    () => printers?.find((p) => p.id === Number(printerId)) ?? null,
    [printers, printerId],
  );

  const templates = useMemo(
    () =>
      RAW_TEMPLATES.filter(
        (tpl) => showAllLanguages || tpl.language === printer?.language,
      ),
    [showAllLanguages, printer],
  );
  const caseGroups = useMemo(
    () =>
      RAW_TEMPLATE_CASES.map((c) => ({
        label: c.label,
        items: templates.filter((tpl) => tpl.case === c.id),
      })).filter((g) => g.items.length > 0),
    [templates],
  );

  const parsed = useMemo(() => decodeRaw(data, mode), [data, mode]);
  const expectFailure =
    lastTemplate !== null &&
    lastTemplate.expectedToFail === true &&
    data === lastTemplate.source;

  const applyTemplate = (tpl: RawTemplate) => {
    setData(tpl.source);
    setMode(tpl.mode);
    setLastTemplate(tpl);
    setReport(null);
  };

  const send = async () => {
    if (!printer || !parsed.ok || sending) return;
    const options: {
      chunkBytes?: number;
      chunkPauseMs?: number;
      settleMs?: number;
    } = {};
    const cb = nonNegativeInt(chunkBytes);
    const cp = nonNegativeInt(chunkPause);
    const sm = nonNegativeInt(settleMs);
    if (cb !== undefined) options.chunkBytes = cb;
    if (cp !== undefined) options.chunkPauseMs = cp;
    if (sm !== undefined) options.settleMs = sm;
    setSending(true);
    setReport(null);
    try {
      setReport(
        await agent("send_raw_bytes", {
          printer_id: printer.id,
          data_base64: toBase64(parsed.bytes),
          options: Object.keys(options).length > 0 ? options : null,
        }),
      );
    } catch (e) {
      setReport({
        ok: false,
        error: describeError(e),
        bytesSent: 0,
        timingsMs: {},
        effectiveOptions: {},
      });
    } finally {
      setSending(false);
    }
  };

  const parseErrorKey =
    parsed.ok === false ? `raw_console.error_${parsed.error}` : null;

  const timingStages: [string, number | null | undefined][] = [
    ["open", report?.timingsMs.open],
    ["write", report?.timingsMs.write],
    ["settle", report?.timingsMs.settle],
    ["close", report?.timingsMs.close],
  ];
  const timings = timingStages
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k} ${v} ms`);
  const effective = report
    ? [
        report.effectiveOptions.chunkBytes !== undefined &&
        report.effectiveOptions.chunkBytes !== null
          ? `chunkBytes ${report.effectiveOptions.chunkBytes}`
          : null,
        report.effectiveOptions.chunkPauseMs !== undefined &&
        report.effectiveOptions.chunkPauseMs !== null
          ? `chunkPauseMs ${report.effectiveOptions.chunkPauseMs}`
          : null,
        report.effectiveOptions.settleMs !== undefined &&
        report.effectiveOptions.settleMs !== null
          ? `settleMs ${report.effectiveOptions.settleMs}`
          : null,
      ].filter((s): s is string => s !== null)
    : [];

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 p-4">
      <div>
        <h1 className="text-xl font-semibold">{t("raw_console.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("raw_console.hint")}
        </p>
      </div>

      <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
        {t("raw_console.warning")}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("raw_console.templates")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                id="raw-console-show-all-languages"
                checked={showAllLanguages}
                onChange={(e) => setShowAllLanguages(e.target.checked)}
              />
              {t("raw_console.show_all_languages")}
            </label>
            {caseGroups.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("raw_console.no_templates")}
              </p>
            ) : (
              caseGroups.map((group) => (
                <div key={group.label} className="space-y-1">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {group.label}
                  </p>
                  {group.items.map((tpl) => (
                    <button
                      key={tpl.id}
                      type="button"
                      id={`raw-console-template-${tpl.id}`}
                      onClick={() => applyTemplate(tpl)}
                      className="w-full rounded-md border p-2 text-left text-sm hover:bg-accent"
                    >
                      <span className="flex items-center gap-2">
                        <span className="font-medium">{tpl.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {LANGUAGE_LABELS[tpl.language] ?? tpl.language}
                        </span>
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {tpl.description}
                      </span>
                    </button>
                  ))}
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("raw_console.data")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label htmlFor="raw-console-printer">
                {t("raw_console.printer")}
              </Label>
              <Select
                value={printerId}
                onValueChange={setPrinterId}
                disabled={printers === null}
              >
                <SelectTrigger
                  id="raw-console-printer"
                  className="w-full sm:w-64"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {printers?.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {printers !== null && printers.length === 0 && (
              <p className="text-sm text-muted-foreground">
                {t("raw_console.no_printers")}
              </p>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label htmlFor="raw-console-data">{t("raw_console.data")}</Label>
              <Select value={mode} onValueChange={(v) => setMode(v as RawMode)}>
                <SelectTrigger id="raw-console-mode" className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="text">
                    {t("raw_console.mode_text")}
                  </SelectItem>
                  <SelectItem value="hex">
                    {t("raw_console.mode_hex")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Textarea
              id="raw-console-data"
              value={data}
              onChange={(e) => {
                setData(e.target.value);
                setReport(null);
              }}
              rows={8}
              spellCheck={false}
              className="font-mono text-sm"
            />
            <p
              className="text-xs text-muted-foreground"
              aria-live="polite"
              data-testid="raw-console-parse"
            >
              {parsed.ok
                ? t("raw_console.bytes", { count: parsed.bytes.length })
                : parseErrorKey
                  ? t(parseErrorKey)
                  : ""}
            </p>

            <div className="grid grid-cols-3 gap-2">
              <div className="space-y-1">
                <Label htmlFor="raw-console-chunk-bytes">
                  {t("raw_console.chunk_bytes")}
                </Label>
                <Input
                  id="raw-console-chunk-bytes"
                  type="number"
                  min={0}
                  value={chunkBytes}
                  onChange={(e) => setChunkBytes(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="raw-console-chunk-pause">
                  {t("raw_console.chunk_pause")}
                </Label>
                <Input
                  id="raw-console-chunk-pause"
                  type="number"
                  min={0}
                  value={chunkPause}
                  onChange={(e) => setChunkPause(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="raw-console-settle">
                  {t("raw_console.settle")}
                </Label>
                <Input
                  id="raw-console-settle"
                  type="number"
                  min={0}
                  value={settleMs}
                  onChange={(e) => setSettleMs(e.target.value)}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("raw_console.option_hint")}
            </p>

            {expectFailure && (
              <p
                className="rounded-md border bg-muted p-2 text-xs text-muted-foreground"
                data-testid="raw-console-expect-failure"
              >
                {t("raw_console.expected_failure")}
              </p>
            )}

            <Button
              id="raw-console-send"
              onClick={() => void send()}
              disabled={!parsed.ok || printer === null || sending}
            >
              {sending ? t("raw_console.sending") : t("raw_console.send")}
            </Button>

            {report && (
              <div
                className="space-y-1 rounded-md border p-2 text-sm"
                data-testid="raw-console-report"
              >
                <p className={report.ok ? "" : "text-destructive"}>
                  {report.ok
                    ? t("raw_console.result_ok", { count: report.bytesSent })
                    : `${t("raw_console.result_error")}: ${
                        report.error ?? "?"
                      }`}
                </p>
                {timings.length > 0 && (
                  <p className="font-mono text-xs text-muted-foreground">
                    {t("raw_console.timings")}: {timings.join(" · ")}
                  </p>
                )}
                <p className="font-mono text-xs text-muted-foreground">
                  {t("raw_console.effective")}:{" "}
                  {effective.length > 0
                    ? effective.join(" ")
                    : t("raw_console.applied_none")}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
