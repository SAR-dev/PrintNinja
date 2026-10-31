import { describeError } from "@/lib/errors";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { notifyError } from "@/lib/notify";
import { useCanPrint } from "@/lib/hooks/useCanPrint";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { agent } from "@/lib/agent/commands";
import { openExternalUrl } from "@/lib/appUpdate";
import type { ApiStatus } from "@/lib/agent/types";
import { isWebMode } from "@/lib/settings";
import { useApiStatusChanged } from "@/lib/apiServer";
import { cn } from "@/lib/utils";

interface Endpoint {
  method: "GET" | "POST" | "DELETE";
  path: string;
  summaryKey: string;
  descriptionKey: string;
  /** Needs a real-world side effect when executed. */
  mutating: boolean;
  needsId?: boolean;
  hasBody?: boolean;
  /** Prefill for the body box when it still holds another example. */
  bodyExample?: string;
}

/** Minimal claim: the 8-character owner code (or a guest invite) plus
 * this caller's identity. Succeeds only inside an open pairing window
 * (owner) or within the invite's expiry and uses (guest). */
const CLAIM_BODY_EXAMPLE = `{
  "protocol": 1,
  "code": "K7QM4XPD",
  "device_id": "demo-phone",
  "device_name": "Demo phone",
  "platform": "android"
}`;

/**
 * The local API surface the explorer can call. Mirrors
 * `src-tauri/src/api/openapi.rs` — the explorer fetches the live spec for
 * its version banner, but this static list drives the UI so the page also
 * renders when the server is stopped.
 */
const ENDPOINTS: Endpoint[] = [
  {
    method: "GET",
    path: "/v1/health",
    summaryKey: "explorer.endpoint_health",
    descriptionKey: "explorer.endpoint_health_desc",
    mutating: false,
  },
  {
    method: "GET",
    path: "/v1/printers",
    summaryKey: "explorer.endpoint_printers",
    descriptionKey: "explorer.endpoint_printers_desc",
    mutating: false,
  },
  {
    method: "GET",
    path: "/v1/templates",
    summaryKey: "explorer.endpoint_templates",
    descriptionKey: "explorer.endpoint_templates_desc",
    mutating: false,
  },
  {
    method: "GET",
    path: "/v1/jobs",
    summaryKey: "explorer.endpoint_jobs",
    descriptionKey: "explorer.endpoint_jobs_desc",
    mutating: false,
  },
  {
    method: "GET",
    path: "/v1/jobs/{id}",
    summaryKey: "explorer.endpoint_job",
    descriptionKey: "explorer.endpoint_job_desc",
    mutating: false,
    needsId: true,
  },
  {
    method: "GET",
    path: "/v1/metrics",
    summaryKey: "explorer.endpoint_metrics",
    descriptionKey: "explorer.endpoint_metrics_desc",
    mutating: false,
  },
  {
    method: "GET",
    path: "/v1/metrics/prometheus",
    summaryKey: "explorer.endpoint_prom",
    descriptionKey: "explorer.endpoint_prom_desc",
    mutating: false,
  },
  {
    method: "GET",
    path: "/v1/openapi.json",
    summaryKey: "explorer.endpoint_openapi",
    descriptionKey: "explorer.endpoint_openapi_desc",
    mutating: false,
  },
  {
    method: "GET",
    path: "/v1/pair/hello",
    summaryKey: "explorer.endpoint_hello",
    descriptionKey: "explorer.endpoint_hello_desc",
    mutating: false,
  },
  {
    method: "POST",
    path: "/v1/jobs/{id}/retry",
    summaryKey: "explorer.endpoint_retry",
    descriptionKey: "explorer.endpoint_retry_desc",
    mutating: true,
    needsId: true,
  },
  {
    method: "DELETE",
    path: "/v1/jobs/{id}",
    summaryKey: "explorer.endpoint_cancel",
    descriptionKey: "explorer.endpoint_cancel_desc",
    mutating: true,
    needsId: true,
  },
  {
    method: "POST",
    path: "/v1/print",
    summaryKey: "explorer.endpoint_print",
    descriptionKey: "explorer.endpoint_print_desc",
    mutating: true,
    hasBody: true,
  },
  {
    method: "POST",
    path: "/v1/pair/claim",
    summaryKey: "explorer.endpoint_claim",
    descriptionKey: "explorer.endpoint_claim_desc",
    mutating: true,
    hasBody: true,
    bodyExample: CLAIM_BODY_EXAMPLE,
  },
];

const PRINT_BODY_EXAMPLE = `{
  "template": "Receipt",
  "printer": "Front Desk",
  "data": { "order": 1042 }
}`;

const PRINT_URL_EXAMPLE = `{
  "template": "Receipt",
  "printer": "Front Desk",
  "data_url": "https://pos.local/ticket/1042"
}`;

/** Loopback is always reachable; 0.0.0.0 (LAN mode) is not a destination. */
function baseUrl(status: ApiStatus): string {
  return `http://127.0.0.1:${status.port}`;
}

/** Method badges reuse status semantics: safe, side-effecting, destructive. */
function methodVariant(
  method: Endpoint["method"],
): "success" | "warning" | "destructive" {
  switch (method) {
    case "GET":
      return "success";
    case "POST":
      return "warning";
    case "DELETE":
      return "destructive";
  }
}

/**
 * Try-it console for the local API. Read-only with respect to the
 * server: starting, stopping, port and LAN live in the Server tab, so
 * the same switch is never in two places.
 */
export function ApiExplorerPanel({
  onOpenServer,
}: {
  onOpenServer: () => void;
}) {
  const { t } = useTranslation();
  const webMode = isWebMode();
  const [status, setStatus] = useState<ApiStatus | null>(null);
  const [specVersion, setSpecVersion] = useState<string | null>(null);
  const [selected, setSelected] = useState<Endpoint>(ENDPOINTS[0]);
  const [jobId, setJobId] = useState("");
  const [body, setBody] = useState(PRINT_BODY_EXAMPLE);
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [response, setResponse] = useState<{
    status: number;
    text: string;
  } | null>(null);
  // Unpaired Android phones cannot print anywhere, including here.
  const canPrint = useCanPrint();

  const loadStatus = useCallback(async () => {
    if (isWebMode()) return;
    try {
      setStatus(await agent("get_api_status", {}));
    } catch {
      /* backend unavailable */
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);
  useApiStatusChanged(loadStatus);

  // Version banner comes from the live spec, so the explorer visibly
  // tracks the server it talks to.
  useEffect(() => {
    if (!status?.running) {
      setSpecVersion(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        // Through the `api_request` command: a WebView fetch to 127.0.0.1
        // is cross-origin + mixed content and dies with "Failed to fetch".
        const res = await agent("api_request", {
          method: "GET",
          url: `${baseUrl(status)}/v1/openapi.json`,
        });
        if (res.status < 200 || res.status >= 300) return;
        const spec = JSON.parse(res.text) as { info?: { version?: string } };
        if (!cancelled && spec.info?.version) setSpecVersion(spec.info.version);
      } catch {
        /* server stopped mid-load */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status]);

  const resolvedPath = useMemo(
    () => selected.path.replace("{id}", jobId.trim() || "{id}"),
    [selected, jobId],
  );

  const canSend =
    !busy && !!status?.running && (!selected.needsId || jobId.trim() !== "");

  // Unpaired Android phones cannot print anywhere, including here: the
  // side door stays shut with a way to the pairing screen, and the
  // request the person composed stays put.
  const printBlocked = selected.path === "/v1/print" && canPrint === false;

  const send = async () => {
    if (!status?.running) return;
    if (printBlocked) {
      notifyError(t("explorer.print_needs_pair"));
      return;
    }
    if (selected.needsId && !jobId.trim()) {
      notifyError(t("explorer.toast_job_id_required"));
      return;
    }
    let parsed: unknown = undefined;
    if (selected.hasBody) {
      try {
        parsed = JSON.parse(body);
      } catch {
        notifyError(t("explorer.toast_bad_json"));
        return;
      }
    }
    setBusy(true);
    setResponse(null);
    try {
      const url = `${baseUrl(status)}${selected.path.replace("{id}", jobId.trim())}`;
      const headers: Record<string, string> = {};
      let payload: string | undefined;
      if (selected.hasBody) {
        headers["Content-Type"] = "application/json";
        payload = JSON.stringify(parsed);
        if (selected.path === "/v1/print" && idempotencyKey.trim())
          headers["Idempotency-Key"] = idempotencyKey.trim();
      }
      const res = await agent("api_request", {
        method: selected.method,
        url,
        headers,
        body: payload,
      });
      setResponse({ status: res.status, text: res.text });
    } catch (e) {
      notifyError(
        t("explorer.toast_request_failed", { error: describeError(e) }),
      );
    } finally {
      setBusy(false);
    }
  };

  // The browser preview has no Tauri backend and no local server to call.
  if (webMode) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-muted-foreground">
            {t("explorer.web_notice")}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {specVersion && (
          <Badge variant="outline" data-testid="api-explorer-spec-version">
            {t("explorer.spec_version", { version: specVersion })}
          </Badge>
        )}
        <Badge variant={status?.running ? "success" : "secondary"}>
          {status?.running
            ? `${status.address}:${status.port}`
            : t("explorer.stopped")}
        </Badge>
      </div>

      {/* Same curl example the server tab used to carry: this tab is
          where "try it" lives now. Port follows the live server. */}
      <Card>
        <CardContent className="space-y-1 pt-4">
          <p className="text-xs font-medium">
            {t("settings_page.api_curl_title")}
          </p>
          <pre className="text-[11px] overflow-x-auto whitespace-pre-wrap break-all">{`curl -X POST http://127.0.0.1:${
            status?.port ?? 17717
          }/v1/print \\
  -H "Content-Type: application/json" \\
  -d '{"template":"Receipt","printer":"Front Desk","data":{"order":1042}}'`}</pre>
        </CardContent>
      </Card>

      {!status?.running ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("explorer.not_running_title")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {t("explorer.not_running_hint")}
            </p>
            <Button onClick={onOpenServer} data-testid="explorer-open-server">
              {t("explorer.open_server")}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
          {/* Live-spec browser: every local endpoint, grouped by safety. */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {t("explorer.endpoints")}
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  live: {baseUrl(status)}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              {ENDPOINTS.map((ep) => (
                <button
                  key={`${ep.method} ${ep.path}`}
                  type="button"
                  onClick={() => {
                    setSelected(ep);
                    setResponse(null);
                    // A fresh example for endpoints that carry one, but
                    // never clobber something the person typed themselves.
                    if (ep.bodyExample && body === PRINT_BODY_EXAMPLE) {
                      setBody(ep.bodyExample);
                    }
                  }}
                  aria-pressed={selected === ep}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent",
                    selected === ep && "bg-accent",
                  )}
                >
                  <Badge
                    variant={methodVariant(ep.method)}
                    className="w-14 shrink-0 justify-center px-1 font-mono text-[10px]"
                  >
                    {ep.method}
                  </Badge>
                  <span className="min-w-0">
                    <span className="block truncate font-mono text-xs">
                      {ep.path}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {t(ep.summaryKey)}
                    </span>
                  </span>
                </button>
              ))}
              <a
                href={`${baseUrl(status)}/v1/openapi.json`}
                target="_blank"
                rel="noreferrer"
                className="block px-2 pt-2 text-xs text-muted-foreground underline-offset-2 hover:underline"
                onClick={(e) => {
                  // Same as the update badge: the Tauri webview would
                  // navigate itself to the JSON instead of opening it
                  // outside the app.
                  if (isWebMode()) return;
                  e.preventDefault();
                  void openExternalUrl(`${baseUrl(status)}/v1/openapi.json`);
                }}
              >
                {t("explorer.raw_link")}
              </a>
            </CardContent>
          </Card>

          {/* Try-it-out console. */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Badge
                  variant={methodVariant(selected.method)}
                  className="font-mono text-[11px]"
                >
                  {selected.method}
                </Badge>
                <span className="font-mono text-sm">{resolvedPath}</span>
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                {t(selected.summaryKey)} — {t(selected.descriptionKey)}
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              {selected.method === "POST" && selected.path === "/v1/print" && (
                <p
                  role="alert"
                  className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning"
                >
                  {t("explorer.print_warning")}
                </p>
              )}
              {selected.mutating &&
                selected.path !== "/v1/print" &&
                selected.path !== "/v1/pair/claim" && (
                  <p
                    role="alert"
                    className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning"
                  >
                    {t("explorer.mutate_warning")}
                  </p>
                )}
              {selected.path === "/v1/pair/claim" && (
                <p
                  role="alert"
                  className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning"
                >
                  {t("explorer.claim_warning")}
                </p>
              )}

              {selected.needsId && (
                <div className="space-y-1">
                  <Label htmlFor="api-explorer-id">
                    {t("explorer.job_id")}
                  </Label>
                  <Input
                    id="api-explorer-id"
                    data-testid="api-explorer-job-id"
                    inputMode="numeric"
                    placeholder={t("explorer.job_id_example")}
                    value={jobId}
                    onChange={(e) => setJobId(e.target.value)}
                  />
                </div>
              )}

              {selected.hasBody && (
                <>
                  {selected.path === "/v1/print" && (
                    <div
                      role="group"
                      aria-label={t("explorer.fill_example_aria")}
                      className="flex flex-wrap gap-2"
                    >
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setBody(PRINT_BODY_EXAMPLE)}
                      >
                        {t("explorer.example_inline")}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setBody(PRINT_URL_EXAMPLE)}
                      >
                        {t("explorer.example_url")}
                      </Button>
                    </div>
                  )}
                  {selected.path === "/v1/pair/claim" && (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setBody(CLAIM_BODY_EXAMPLE)}
                      >
                        {t("explorer.example_claim")}
                      </Button>
                    </div>
                  )}
                  <div className="space-y-1">
                    <Label htmlFor="api-explorer-body">
                      {t("explorer.body_label")}
                    </Label>
                    <Textarea
                      id="api-explorer-body"
                      data-testid="api-explorer-body"
                      rows={8}
                      className="font-mono text-xs"
                      value={body}
                      onChange={(e) => setBody(e.target.value)}
                    />
                    {selected.path === "/v1/print" && (
                      <p className="text-xs text-muted-foreground">
                        {t("explorer.body_hint")}
                      </p>
                    )}
                  </div>
                  {selected.path === "/v1/print" && (
                    <div className="space-y-1">
                      <Label htmlFor="api-explorer-idempotency">
                        {t("explorer.idem_label")}
                      </Label>
                      <Input
                        id="api-explorer-idempotency"
                        data-testid="api-explorer-idempotency"
                        placeholder={t("explorer.idem_hint")}
                        value={idempotencyKey}
                        onChange={(e) => setIdempotencyKey(e.target.value)}
                      />
                    </div>
                  )}
                </>
              )}

              <Button
                onClick={send}
                disabled={!canSend || printBlocked}
                data-testid="api-explorer-send"
              >
                {busy
                  ? t("explorer.sending")
                  : t("explorer.send", {
                      method: selected.method,
                      path: resolvedPath,
                    })}
              </Button>
              {printBlocked && (
                <p className="text-xs text-muted-foreground">
                  {t("explorer.print_needs_pair")}{" "}
                  <Link
                    to="/pair"
                    state={{ returnTo: "/automation?tab=explorer" }}
                  >
                    {t("explorer.print_pair_now")}
                  </Link>
                </p>
              )}

              {response && (
                <div className="space-y-1">
                  <p className="text-sm font-medium">
                    {t("explorer.response")}
                    <Badge
                      variant={
                        response.status < 400 ? "success" : "destructive"
                      }
                      className="ml-2"
                    >
                      {response.status}
                    </Badge>
                  </p>
                  <pre
                    data-testid="api-explorer-response"
                    className="max-h-96 overflow-auto rounded-md bg-muted p-3 font-mono text-xs"
                    tabIndex={0}
                  >
                    {formatResponse(response.text)}
                  </pre>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

/** Pretty-print JSON bodies; pass anything else through untouched. */
function formatResponse(text: string): string {
  if (!text) return "(empty body — e.g. a 204 cancel)";
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
