import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Plus,
  FileText,
  Download,
  Upload,
  RotateCcw,
  ZoomIn,
  ZoomOut,
  Save,
  History,
  Type,
  QrCode,
  Check,
} from "lucide-react";
import { useTemplateStore, type Template, type TemplateVersion } from "@/lib/store/templateStore";
import { toast } from "sonner";
import CodeMirror from "@uiw/react-codemirror";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { BARCODE_TYPES, validateBarcode, generateBarcodeSvg } from "@/lib/utils/barcode";
import { DEFAULT_TEMPLATE_HTML, DEFAULT_TEMPLATE_CSS, DEFAULT_MOCK_DATA } from "@/lib/templates/defaultTemplate";

const PAGE_PRESETS = [
  { label: "A4", width: 210, height: 297 },
  { label: "A5", width: 148, height: 210 },
  { label: "Letter", width: 216, height: 279 },
  { label: "80mm Roll", width: 80, height: 200 },
  { label: "58mm Roll", width: 58, height: 200 },
  { label: "4x6 Label", width: 102, height:152 },
];

const MM_TO_PX = 3.7795;

export function DesignerPage() {
  const { t } = useTranslation();
  const store = useTemplateStore();
  const [versions, setVersions] = useState<TemplateVersion[]>([]);
  const [showVersionDialog, setShowVersionDialog] = useState(false);
  const [versionLabel, setVersionLabel] = useState("");
  const [versionNote, setVersionNote] = useState("");
  const [showBarcodeDialog, setShowBarcodeDialog] = useState(false);
  const [barcodeType, setBarcodeType] = useState("code128");
  const [barcodeValue, setBarcodeValue] = useState("");
  const [barcodeError, setBarcodeError] = useState<string | null>(null);
  const [showNewTemplateDialog, setShowNewTemplateDialog] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState("");
  const [htmlCode, setHtmlCode] = useState(DEFAULT_TEMPLATE_HTML);
  const [cssCode, setCssCode] = useState(DEFAULT_TEMPLATE_CSS);
  const [templateName, setTemplateName] = useState("Sample Receipt");
  const [pageWidth, setPageWidth] = useState(80);
  const [pageHeight, setPageHeight] = useState(200);
  const [orientation, setOrientation] = useState<"portrait" | "landscape">("portrait");
  const [zoom, setZoom] = useState(1);
  const [activeTab, setActiveTab] = useState("canvas");

  const canvasRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const template: Template = {
      id: 1,
      name: templateName,
      current_version_id: null,
      page_w_mm: pageWidth,
      page_h_mm: pageHeight,
      orientation,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    store.setCurrentTemplate(template);
  }, []);

  const handleSaveVersion = async () => {
    try {
      const version = await invoke<TemplateVersion>("create_version", {
        req: {
          template_id: 1,
          html: htmlCode,
          css: cssCode,
          label: versionLabel || null,
          note: versionNote || null,
          created_by: "manual",
        },
      });
      setVersions((prev) => [...prev, version]);
      setShowVersionDialog(false);
      setVersionLabel("");
      setVersionNote("");
      toast.success(`Version ${version.version_no} saved`);
    } catch (e) {
      toast.error(`Failed to save version: ${e}`);
    }
  };

  const handleInsertBarcode = () => {
    const error = validateBarcode(barcodeType, barcodeValue);
    if (error) {
      setBarcodeError(error);
      return;
    }
    const svg = generateBarcodeSvg({ type: barcodeType, value: barcodeValue });
    if (svg) {
      const barcodeHtml = `<img src="${svg}" alt="${barcodeType}" style="max-width: 100%;" />`;
      setHtmlCode((prev) => prev + "\n" + barcodeHtml);
      setShowBarcodeDialog(false);
      setBarcodeValue("");
      setBarcodeError(null);
    }
  };

  const handleRestoreVersion = (version: TemplateVersion) => {
    setHtmlCode(version.html);
    setCssCode(version.css);
    toast.success(`Restored version ${version.version_no}`);
  };

  const canvasWidth = pageWidth * MM_TO_PX * zoom;
  const canvasHeight = pageHeight * MM_TO_PX * zoom;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t("designer.title")}</h1>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowNewTemplateDialog(true)}>
            <Plus className="h-4 w-4" />
            {t("designer.newTemplate")}
          </Button>
          <Button variant="outline" size="sm">
            <Upload className="h-4 w-4" />
            Import
          </Button>
          <Button variant="outline" size="sm">
            <Download className="h-4 w-4" />
            Export
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        {/* Left Panel - Template List & Page Setup */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Templates</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              <div className="flex items-center gap-2 p-2 rounded-md bg-secondary">
                <FileText className="h-4 w-4" />
                <span className="text-sm">{templateName}</span>
              </div>
              <div className="flex items-center gap-2 p-2 rounded-md hover:bg-muted cursor-pointer">
                <FileText className="h-4 w-4" />
                <span className="text-sm">Shipping Label</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">{t("designer.pageSetup")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1">
                <Label className="text-xs">{t("designer.template_name")}</Label>
                <Input value={templateName} onChange={(e) => setTemplateName(e.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs">Width (mm)</Label>
                  <Input type="number" value={pageWidth} onChange={(e) => setPageWidth(Number(e.target.value))} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Height (mm)</Label>
                  <Input type="number" value={pageHeight} onChange={(e) => setPageHeight(Number(e.target.value))} />
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Presets</Label>
                <div className="flex flex-wrap gap-1">
                  {PAGE_PRESETS.map((preset) => (
                    <Button
                      key={preset.label}
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => {
                        setPageWidth(preset.width);
                        setPageHeight(preset.height);
                      }}
                    >
                      {preset.label}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t("designer.orientation")}</Label>
                <Select value={orientation} onValueChange={(v) => setOrientation(v as "portrait" | "landscape")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="portrait">{t("designer.portrait")}</SelectItem>
                    <SelectItem value="landscape">{t("designer.landscape")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>

          {/* Versions Panel */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm">{t("designer.versions")}</CardTitle>
                <Button variant="ghost" size="sm" className="h-6" onClick={() => setShowVersionDialog(true)}>
                  <Plus className="h-3 w-3" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-1 max-h-48 overflow-y-auto">
              {versions.length === 0 ? (
                <p className="text-xs text-muted-foreground">No versions yet</p>
              ) : (
                versions.map((v) => (
                  <div key={v.id} className="flex items-center justify-between p-2 rounded-md border">
                    <div>
                      <p className="text-xs font-medium">v{v.version_no}</p>
                      {v.label && <p className="text-xs text-muted-foreground">{v.label}</p>}
                    </div>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="sm" className="h-6" onClick={() => handleRestoreVersion(v)}>
                        <RotateCcw className="h-3 w-3" />
                      </Button>
                      <Button variant="ghost" size="sm" className="h-6" onClick={() => handleRestoreVersion(v)}>
                        <History className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>

        {/* Main Canvas + Code */}
        <div className="lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <Tabs value={activeTab} onValueChange={setActiveTab} className="w-[320px]">
              <TabsList className="grid w-full grid-cols-4">
                <TabsTrigger value="canvas" className="text-xs">{t("designer.canvas")}</TabsTrigger>
                <TabsTrigger value="code" className="text-xs">{t("designer.code")}</TabsTrigger>
                <TabsTrigger value="preview" className="text-xs">{t("designer.preview")}</TabsTrigger>
                <TabsTrigger value="variables" className="text-xs">{t("designer.variables")}</TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))}>
                <ZoomOut className="h-4 w-4" />
              </Button>
              <span className="text-xs w-12 text-center">{Math.round(zoom * 100)}%</span>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setZoom((z) => Math.min(3, z + 0.25))}>
                <ZoomIn className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {activeTab === "canvas" && (
            <Card>
              <CardContent className="p-0">
                <div className="flex items-center justify-center min-h-[500px] bg-gray-100 dark:bg-gray-900 rounded-b-lg overflow-auto">
                  <div
                    ref={canvasRef}
                    className="bg-white shadow-lg border border-gray-200 relative"
                    style={{ width: canvasWidth, height: canvasHeight }}
                  >
                    <div className="absolute inset-0 p-4 text-xs text-gray-800" style={{ fontSize: `${12 * zoom}px` }}>
                      <h1 className="text-lg font-bold" style={{ fontSize: `${18 * zoom}px` }}>{"{{store.name}}"}</h1>
                      <p>{"Order #{{order.id}}"}</p>
                      <div className="mt-2 space-y-1">
                        <div className="flex justify-between"><span>Tea x2</span><span>$7.00</span></div>
                        <div className="flex justify-between"><span>Coffee x1</span><span>$4.50</span></div>
                      </div>
                      <hr className="my-2" />
                      <div className="flex justify-between font-bold"><span>Total</span><span>$11.50</span></div>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {activeTab === "code" && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">HTML</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <CodeMirror
                    value={htmlCode}
                    height="500px"
                    extensions={[html()]}
                    onChange={setHtmlCode}
                    theme="dark"
                  />
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">CSS</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <CodeMirror
                    value={cssCode}
                    height="500px"
                    extensions={[css()]}
                    onChange={setCssCode}
                    theme="dark"
                  />
                </CardContent>
              </Card>
            </div>
          )}

          {activeTab === "preview" && (
            <Card>
              <CardContent className="p-0">
                <div className="flex items-center justify-center min-h-[500px] bg-gray-100 dark:bg-gray-900 rounded-b-lg">
                  <div className="bg-white shadow-lg border p-6 text-sm" style={{ width: pageWidth * MM_TO_PX, minHeight: pageHeight * MM_TO_PX }}>
                    <div className="flex justify-between items-center mb-4">
                      <h1 className="text-lg font-bold">{DEFAULT_MOCK_DATA.store.name}</h1>
                      <span className="text-gray-500">#{DEFAULT_MOCK_DATA.order.id}</span>
                    </div>
                    <div className="mb-4">
                      <p className="text-gray-600">{DEFAULT_MOCK_DATA.order.date}</p>
                      <p className="text-gray-600">Customer: {DEFAULT_MOCK_DATA.order.customer}</p>
                    </div>
                    <table className="w-full mb-4">
                      <thead>
                        <tr className="border-b-2 border-gray-300">
                          <th className="text-left py-1">Item</th>
                          <th className="text-right py-1">Qty</th>
                          <th className="text-right py-1">Price</th>
                          <th className="text-right py-1">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {DEFAULT_MOCK_DATA.order.items.map((item, i) => (
                          <tr key={i} className="border-b border-gray-100">
                            <td className="py-1">{item.name}</td>
                            <td className="text-right py-1">{item.qty}</td>
                            <td className="text-right py-1">${item.price.toFixed(2)}</td>
                            <td className="text-right py-1">${item.total.toFixed(2)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="flex justify-end">
                      <div className="text-right">
                        <p className="text-gray-600">Subtotal: ${DEFAULT_MOCK_DATA.order.subtotal.toFixed(2)}</p>
                        <p className="text-gray-600">Tax: ${DEFAULT_MOCK_DATA.order.tax.toFixed(2)}</p>
                        <p className="text-lg font-bold">Total: ${DEFAULT_MOCK_DATA.order.total.toFixed(2)}</p>
                      </div>
                    </div>
                    <div className="mt-6 text-center text-gray-400 text-xs">
                      <p>Thank you for your business!</p>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {activeTab === "variables" && (
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm">{t("designer.variables")}</CardTitle>
                  <Button variant="outline" size="sm" className="h-7 text-xs">
                    <Plus className="h-3 w-3" />
                    Add Dataset
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex items-center justify-between p-2 rounded-md border bg-secondary">
                  <div>
                    <p className="text-sm font-medium">Sample Order</p>
                    <p className="text-xs text-muted-foreground">{"{{store}}, {{order}}, {{order.items}}"}</p>
                  </div>
                  <Badge>Default</Badge>
                </div>
                <div className="flex items-center justify-between p-2 rounded-md border">
                  <div>
                    <p className="text-sm font-medium">Empty Order</p>
                    <p className="text-xs text-muted-foreground">{"{{store}}, {{order}}"}</p>
                  </div>
                  <Button variant="ghost" size="sm" className="h-6 text-xs">Load</Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Action Bar */}
          <div className="flex items-center justify-between">
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setShowBarcodeDialog(true)}>
                <QrCode className="h-4 w-4" />
                Barcode
              </Button>
              <Button variant="outline" size="sm">
                <Type className="h-4 w-4" />
                Font
              </Button>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setShowVersionDialog(true)}>
                <Save className="h-4 w-4" />
                Save Version
              </Button>
              <Button size="sm">
                <Check className="h-4 w-4" />
                Save & Preview
              </Button>
            </div>
          </div>
        </div>

        {/* Right Panel - Properties */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Properties</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1">
                <Label className="text-xs">Page</Label>
                <div className="text-sm">{pageWidth} x {pageHeight} mm</div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Orientation</Label>
                <div className="text-sm">{orientation}</div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Zoom</Label>
                <div className="text-sm">{Math.round(zoom * 100)}%</div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Quick Helpers</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="text-xs text-muted-foreground">
                Available helpers:
              </div>
              <div className="flex flex-wrap gap-1">
                {["currency", "date", "upper", "lower", "padLeft", "number"].map((helper) => (
                  <Badge key={helper} variant="outline" className="text-xs font-mono">
                    {`{{${helper}}}`}
                  </Badge>
                ))}
              </div>
              <div className="text-xs text-muted-foreground">
                Barcode types:
              </div>
              <div className="flex flex-wrap gap-1">
                {BARCODE_TYPES.slice(0, 5).map((bc) => (
                  <Badge key={bc.value} variant="outline" className="text-xs">
                    {bc.label}
                  </Badge>
                ))}
                <Badge variant="outline" className="text-xs">+{BARCODE_TYPES.length - 5} more</Badge>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Save Version Dialog */}
      <Dialog open={showVersionDialog} onOpenChange={setShowVersionDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save Version</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Label</Label>
              <Input placeholder="e.g. Added logo" value={versionLabel} onChange={(e) => setVersionLabel(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Note</Label>
              <Input placeholder="Optional note" value={versionNote} onChange={(e) => setVersionNote(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowVersionDialog(false)}>Cancel</Button>
            <Button onClick={handleSaveVersion}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Barcode Dialog */}
      <Dialog open={showBarcodeDialog} onOpenChange={setShowBarcodeDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Insert Barcode</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Type</Label>
              <Select value={barcodeType} onValueChange={setBarcodeType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BARCODE_TYPES.map((bc) => (
                    <SelectItem key={bc.value} value={bc.value}>{bc.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Value</Label>
              <Input placeholder="Enter barcode value" value={barcodeValue} onChange={(e) => { setBarcodeValue(e.target.value); setBarcodeError(null); }} />
              {barcodeError && <p className="text-xs text-red-500">{barcodeError}</p>}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBarcodeDialog(false)}>Cancel</Button>
            <Button onClick={handleInsertBarcode} disabled={!barcodeValue}>
              <QrCode className="h-4 w-4" />
              Insert
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New Template Dialog */}
      <Dialog open={showNewTemplateDialog} onOpenChange={setShowNewTemplateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Template</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Template Name</Label>
              <Input placeholder="My Template" value={newTemplateName} onChange={(e) => setNewTemplateName(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowNewTemplateDialog(false)}>Cancel</Button>
            <Button onClick={() => {
              if (newTemplateName) {
                setTemplateName(newTemplateName);
                setShowNewTemplateDialog(false);
                toast.success(`Template "${newTemplateName}" created`);
              }
            }}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
