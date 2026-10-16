import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { Printer, Eye, Zap, CheckCircle2, XCircle, Play } from "lucide-react";
import { toast } from "sonner";
import { usePrintStore } from "@/lib/store/printStore";
import { DEFAULT_MOCK_DATA } from "@/lib/templates/defaultTemplate";
import { renderTemplate } from "@/lib/render/renderTemplate";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

interface PrintResponse {
  success: boolean;
  job_id: string;
  duration_ms: number;
  error?: string;
}

interface PrinterInfo {
  id: string;
  name: string;
  address: string;
  printer_type: string;
  language: string;
}

export function PrintPage() {
  const { t } = useTranslation();
  const store = usePrintStore();
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [showBatchDialog, setShowBatchDialog] = useState(false);
  const [batchInput, setBatchInput] = useState("");
  const [showPreview, setShowPreview] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const list = await invoke<PrinterInfo[]>("enumerate_system_printers");
        setPrinters(list);
        if (list.length > 0 && !store.printerId) {
          store.setPrinterId(list[0].name);
        }
      } catch (e) {
        console.error("Failed to load printers:", e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleBatchPrint = async () => {
    if (!batchInput.trim()) {
      toast.error("Please enter batch data");
      return;
    }
    try {
      const data = JSON.parse(batchInput);
      await invoke("create_batch", {
        req: { template_id: 1, printer_id: 1, data, mode: store.batchMode2 },
      });
      toast.success("Batch created");
      setShowBatchDialog(false);
    } catch (e) {
      toast.error(`Invalid JSON: ${e}`);
    }
  };

  const loadPrinters = async () => {
    try {
      const list = await invoke<PrinterInfo[]>("enumerate_system_printers");
      setPrinters(list);
    } catch (e) {
      console.error("Failed to load printers:", e);
    }
  };

  const handlePrint = async () => {
    if (!store.printerId) {
      toast.error("Please select a printer");
      return;
    }
    store.setStatus("printing");
    store.setError("");

    try {
      const data = store.useTestData ? DEFAULT_MOCK_DATA : {};

      const result = await invoke<PrintResponse>("print_html", {
        req: {
          printer_name: store.printerId,
          html: `<html><body><pre>${JSON.stringify(data, null, 2)}</pre></body></html>`,
          page_width_mm: 210,
          page_height_mm: 297,
          orientation: store.orientation,
          copies: store.copies,
        },
      });

      store.setDurationMs(result.duration_ms);

      if (result.success) {
        store.setStatus("success");
        toast.success(`Printed in ${result.duration_ms}ms`);
      } else {
        store.setStatus("failed");
        store.setError(result.error || "Unknown error");
        toast.error(`Print failed: ${result.error}`);
      }
    } catch (e) {
      store.setStatus("failed");
      store.setError(String(e));
      toast.error(`Print failed: ${e}`);
    }
  };

  const handleSpikeTest = async () => {
    store.setStatus("printing");
    store.setError("");

    try {
      const result = await invoke<PrintResponse>("spike_test_print");
      store.setDurationMs(result.duration_ms);

      if (result.success) {
        store.setStatus("success");
        toast.success(`Spike test printed in ${result.duration_ms}ms`);
      } else {
        store.setStatus("failed");
        store.setError(result.error || "Unknown error");
      }
    } catch (e) {
      store.setStatus("failed");
      store.setError(String(e));
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">{t("print.title")}</h1>
        <Button variant="outline" size="sm" onClick={loadPrinters}>
          Refresh Printers
        </Button>
      </div>

      {/* Phase 1 Spike */}
      <Card className="border-2 border-dashed border-yellow-500/50 bg-yellow-50/50 dark:bg-yellow-950/20">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-yellow-600 dark:text-yellow-400" />
            <CardTitle className="text-base text-yellow-800 dark:text-yellow-200">
              Phase 1 Spike: Silent Print Test
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-yellow-700 dark:text-yellow-300">
            Tests the core pipeline: HTML to PDF to silent print on Windows.
          </p>
          <div className="flex gap-3">
            <Button onClick={handleSpikeTest} disabled={store.status === "printing"} className="bg-yellow-600 hover:bg-yellow-700">
              <Zap className="h-4 w-4" />
              {store.status === "printing" ? "Printing..." : "Spike Test Print"}
            </Button>
          </div>
          {store.status !== "idle" && (
            <div className="flex items-center gap-3 p-3 rounded-md bg-white/50 dark:bg-black/20">
              {store.status === "success" && (
                <>
                  <CheckCircle2 className="h-5 w-5 text-green-600" />
                  <div>
                    <p className="text-sm font-medium text-green-700 dark:text-green-400">Print successful</p>
                    <p className="text-xs text-muted-foreground">Duration: {store.durationMs}ms</p>
                  </div>
                </>
              )}
              {store.status === "failed" && (
                <>
                  <XCircle className="h-5 w-5 text-red-600" />
                  <div>
                    <p className="text-sm font-medium text-red-700 dark:text-red-400">Print failed</p>
                    <p className="text-xs text-muted-foreground">{store.error}</p>
                  </div>
                </>
              )}
              {store.status === "printing" && (
                <>
                  <div className="h-5 w-5 border-2 border-yellow-600 border-t-transparent rounded-full animate-spin" />
                  <p className="text-sm text-yellow-700 dark:text-yellow-300">Printing...</p>
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Print Form */}
        <div className="lg:col-span-2 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Print Settings</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>{t("print.printer")}</Label>
                  <Select value={store.printerId} onValueChange={store.setPrinterId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select printer" />
                    </SelectTrigger>
                    <SelectContent>
                      {printers.map((p) => (
                        <SelectItem key={p.id} value={p.name}>{p.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>{t("print.template")}</Label>
                  <Select value={store.templateId} onValueChange={store.setTemplateId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select template" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="receipt-80">Receipt 80mm</SelectItem>
                      <SelectItem value="label-4x6">Shipping Label 4x6</SelectItem>
                      <SelectItem value="invoice-a4">Invoice A4</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="data-url">{t("print.data_url")}</Label>
                  <div className="flex items-center gap-2">
                    <Label htmlFor="test-data" className="text-xs text-muted-foreground">Test Data</Label>
                    <Switch id="test-data" checked={store.useTestData} onCheckedChange={store.setUseTestData} />
                  </div>
                </div>
                <Input
                  id="data-url"
                  placeholder="https://api.example.com/orders/123"
                  value={store.dataUrl}
                  onChange={(e) => store.setDataUrl(e.target.value)}
                  disabled={store.useTestData}
                />
                {store.useTestData && (
                  <p className="text-xs text-muted-foreground">
                    Using mock data: {DEFAULT_MOCK_DATA.store.name} - Order #{DEFAULT_MOCK_DATA.order.id}
                  </p>
                )}
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="space-y-2">
                  <Label>{t("print.orientation")}</Label>
                  <Select value={store.orientation} onValueChange={(v) => store.setOrientation(v as "portrait" | "landscape")}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="portrait">Portrait</SelectItem>
                      <SelectItem value="landscape">Landscape</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>{t("print.fit_mode")}</Label>
                  <Select value={store.fitMode} onValueChange={(v) => store.setFitMode(v as "actual" | "fit-width" | "fit-page" | "shrink" | "fill")}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="actual">{t("print.fit_actual")}</SelectItem>
                      <SelectItem value="fit-width">{t("print.fit_width")}</SelectItem>
                      <SelectItem value="fit-page">{t("print.fit_page")}</SelectItem>
                      <SelectItem value="shrink">{t("print.fit_shrink")}</SelectItem>
                      <SelectItem value="fill">{t("print.fit_fill")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="copies">{t("print.copies")}</Label>
                  <Input id="copies" type="number" min="1" value={store.copies} onChange={(e) => store.setCopies(Number(e.target.value))} />
                </div>
                <div className="space-y-2">
                  <Label>Page Range</Label>
                  <Input placeholder="e.g. 1-5" value={store.pageRange} onChange={(e) => store.setPageRange(e.target.value)} />
                </div>
              </div>

              <div className="space-y-2">
                <Label>{t("print.margins")}</Label>
                <div className="grid grid-cols-4 gap-2">
                  <div className="space-y-1">
                    <Label htmlFor="mt" className="text-xs text-muted-foreground">{t("print.margin_top")}</Label>
                    <Input id="mt" type="number" value={store.marginTop} onChange={(e) => store.setMarginTop(Number(e.target.value))} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="mr" className="text-xs text-muted-foreground">{t("print.margin_right")}</Label>
                    <Input id="mr" type="number" value={store.marginRight} onChange={(e) => store.setMarginRight(Number(e.target.value))} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="mb" className="text-xs text-muted-foreground">{t("print.margin_bottom")}</Label>
                    <Input id="mb" type="number" value={store.marginBottom} onChange={(e) => store.setMarginBottom(Number(e.target.value))} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="ml" className="text-xs text-muted-foreground">{t("print.margin_left")}</Label>
                    <Input id="ml" type="number" value={store.marginLeft} onChange={(e) => store.setMarginLeft(Number(e.target.value))} />
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Switch id="grayscale" checked={store.grayscale} onCheckedChange={store.setGrayscale} />
                <Label htmlFor="grayscale">Grayscale</Label>
              </div>
            </CardContent>
          </Card>

          {/* Batch Print */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Batch Print</CardTitle>
                <Button variant="outline" size="sm" onClick={() => setShowBatchDialog(true)}>
                  <Play className="h-4 w-4" />
                  New Batch
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Mode</Label>
                  <Select value={store.batchMode2} onValueChange={(v) => store.setBatchMode2(v as "single_job" | "per_record")}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="single_job">Single Job</SelectItem>
                      <SelectItem value="per_record">Per Record</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Status</Label>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">No batch</Badge>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Actions */}
          <div className="flex gap-3">
            <Button size="lg" className="flex-1" onClick={handlePrint} disabled={store.status === "printing"}>
              <Printer className="h-5 w-5" />
              {t("print.print")}
            </Button>
            <Button size="lg" variant="outline" onClick={() => setShowPreview(true)}>
              <Eye className="h-5 w-5" />
              {t("print.preview")}
            </Button>
          </div>
        </div>

        {/* Preview & Status */}
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("print.preview")}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-center min-h-[300px] bg-white rounded-lg border">
                <div className="text-center text-gray-400">
                  <Eye className="h-10 w-10 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">Preview</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("print.live_status")}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <Badge variant="secondary">{t("print.queued")}</Badge>
                <span className="text-sm text-muted-foreground">Waiting to print...</span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Preview Dialog */}
      <Dialog open={showPreview} onOpenChange={setShowPreview}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Print Preview</DialogTitle>
          </DialogHeader>
          <div className="border rounded-md overflow-auto bg-gray-100 dark:bg-gray-900 p-4 max-h-[70vh]">
            <div className="mx-auto bg-white shadow" style={{ width: 80 * 3.78, minHeight: 200 * 3.78 }}>
              <iframe
                srcDoc={renderTemplate("<div class=\"p-4\"><h1>Print preview</h1><p>Mock data loaded.</p></div>", "", DEFAULT_MOCK_DATA as any)}
                className="w-full border-0"
                style={{ height: 200 * 3.78 }}
                title="Print preview"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPreview(false)}>Close</Button>
            <Button onClick={() => { setShowPreview(false); handlePrint(); }}>Print</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Batch Dialog */}
      <Dialog open={showBatchDialog} onOpenChange={setShowBatchDialog}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Batch Print</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>JSON Array</Label>
              <Textarea
                placeholder='[{"name":"Tea","qty":2},{"name":"Coffee","qty":1}]'
                value={batchInput}
                onChange={(e) => setBatchInput(e.target.value)}
                rows={8}
                className="font-mono text-xs"
              />
            </div>
            <div className="flex items-center gap-4">
              <div className="flex-1">
                <Label className="text-xs">Mode</Label>
                <Select value={store.batchMode2} onValueChange={(v) => store.setBatchMode2(v as "single_job" | "per_record")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="single_job">Single Job</SelectItem>
                    <SelectItem value="per_record">Per Record</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBatchDialog(false)}>Cancel</Button>
            <Button onClick={handleBatchPrint}>
              <Play className="h-4 w-4" />
              Start Batch
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
