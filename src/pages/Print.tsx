import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Printer, Eye, Zap, CheckCircle2, XCircle } from "lucide-react";
import { toast } from "sonner";

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
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [selectedPrinter, setSelectedPrinter] = useState<string>("");
  const [status, setStatus] = useState<"idle" | "printing" | "success" | "failed">("idle");
  const [duration, setDuration] = useState<number>(0);
  const [error, setError] = useState<string>("");

  const loadPrinters = async () => {
    try {
      const list = await invoke<PrinterInfo[]>("enumerate_system_printers");
      setPrinters(list);
      if (list.length > 0 && !selectedPrinter) {
        setSelectedPrinter(list[0].name);
      }
    } catch (e) {
      console.error("Failed to load printers:", e);
    }
  };

  const handleSpikeTest = async () => {
    setStatus("printing");
    setError("");
    try {
      const result = await invoke<PrintResponse>("spike_test_print");
      setDuration(result.duration_ms);

      if (result.success) {
        setStatus("success");
        toast.success(`Printed successfully in ${result.duration_ms}ms`);
      } else {
        setStatus("failed");
        setError(result.error || "Unknown error");
        toast.error(`Print failed: ${result.error}`);
      }
    } catch (e) {
      setStatus("failed");
      setError(String(e));
      toast.error(`Print failed: ${e}`);
    }
  };

  const handlePrint = async () => {
    if (!selectedPrinter) {
      toast.error("Please select a printer");
      return;
    }
    setStatus("printing");
    setError("");

    try {
      const testHtml = `
<!DOCTYPE html>
<html>
<head><title>PrintNinja</title></head>
<body>
    <h1>PrintNinja Print Test</h1>
    <p>Printer: ${selectedPrinter}</p>
    <p>Time: ${new Date().toLocaleString()}</p>
    <hr>
    <p>This is a test print from PrintNinja.</p>
</body>
</html>`;

      const result = await invoke<PrintResponse>("print_html", {
        req: {
          printer_name: selectedPrinter,
          html: testHtml,
          page_width_mm: 210,
          page_height_mm: 297,
          orientation: "portrait",
          copies: 1,
        },
      });

      setDuration(result.duration_ms);

      if (result.success) {
        setStatus("success");
        toast.success(`Printed successfully in ${result.duration_ms}ms`);
      } else {
        setStatus("failed");
        setError(result.error || "Unknown error");
        toast.error(`Print failed: ${result.error}`);
      }
    } catch (e) {
      setStatus("failed");
      setError(String(e));
      toast.error(`Print failed: ${e}`);
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

      {/* Phase 1 Spike Section */}
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
            This tests the core pipeline: HTML to PDF to silent print on Windows.
          </p>

          <div className="flex flex-wrap gap-3">
            <Button
              onClick={handleSpikeTest}
              disabled={status === "printing"}
              className="bg-yellow-600 hover:bg-yellow-700"
            >
              <Zap className="h-4 w-4" />
              {status === "printing" ? "Printing..." : "Spike Test Print"}
            </Button>
          </div>

          {status !== "idle" && (
            <div className="flex items-center gap-3 p-3 rounded-md bg-white/50 dark:bg-black/20">
              {status === "success" && (
                <>
                  <CheckCircle2 className="h-5 w-5 text-green-600" />
                  <div>
                    <p className="text-sm font-medium text-green-700 dark:text-green-400">
                      Print successful
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Duration: {duration}ms
                    </p>
                  </div>
                </>
              )}
              {status === "failed" && (
                <>
                  <XCircle className="h-5 w-5 text-red-600" />
                  <div>
                    <p className="text-sm font-medium text-red-700 dark:text-red-400">
                      Print failed
                    </p>
                    <p className="text-xs text-muted-foreground">{error}</p>
                  </div>
                </>
              )}
              {status === "printing" && (
                <>
                  <div className="h-5 w-5 border-2 border-yellow-600 border-t-transparent rounded-full animate-spin" />
                  <p className="text-sm text-yellow-700 dark:text-yellow-300">
                    Printing...
                  </p>
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
                  <Select value={selectedPrinter} onValueChange={setSelectedPrinter}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select printer" />
                    </SelectTrigger>
                    <SelectContent>
                      {printers.map((p) => (
                        <SelectItem key={p.id} value={p.name}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>{t("print.template")}</Label>
                  <Select>
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
                <Label htmlFor="data-url">{t("print.data_url")}</Label>
                <Input
                  id="data-url"
                  placeholder="https://api.example.com/orders/123"
                />
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="space-y-2">
                  <Label>{t("print.orientation")}</Label>
                  <Select defaultValue="portrait">
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="portrait">Portrait</SelectItem>
                      <SelectItem value="landscape">Landscape</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>{t("print.fit_mode")}</Label>
                  <Select defaultValue="fit-width">
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
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
                  <Input id="copies" type="number" min="1" defaultValue="1" />
                </div>
                <div className="space-y-2">
                  <Label>{t("print.test_data")}</Label>
                  <Button variant="outline" className="w-full">
                    {t("print.test_data")}
                  </Button>
                </div>
              </div>

              {/* Margins */}
              <div className="space-y-2">
                <Label>{t("print.margins")}</Label>
                <div className="grid grid-cols-4 gap-2">
                  <div className="space-y-1">
                    <Label htmlFor="mt" className="text-xs text-muted-foreground">
                      {t("print.margin_top")}
                    </Label>
                    <Input id="mt" type="number" defaultValue="5" />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="mr" className="text-xs text-muted-foreground">
                      {t("print.margin_right")}
                    </Label>
                    <Input id="mr" type="number" defaultValue="5" />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="mb" className="text-xs text-muted-foreground">
                      {t("print.margin_bottom")}
                    </Label>
                    <Input id="mb" type="number" defaultValue="5" />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="ml" className="text-xs text-muted-foreground">
                      {t("print.margin_left")}
                    </Label>
                    <Input id="ml" type="number" defaultValue="5" />
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Actions */}
          <div className="flex gap-3">
            <Button size="lg" className="flex-1" onClick={handlePrint} disabled={status === "printing"}>
              <Printer className="h-5 w-5" />
              {t("print.print")}
            </Button>
            <Button size="lg" variant="outline">
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
                <Badge variant="secondary">
                  {t("print.queued")}
                </Badge>
                <span className="text-sm text-muted-foreground">
                  Waiting to print...
                </span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
