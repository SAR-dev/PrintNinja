import { useTranslation } from "react-i18next";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Plus, Printer, Wifi, Usb, Bluetooth, Monitor, Trash2, TestTube } from "lucide-react";

const printerIcons: Record<string, React.ElementType> = {
  wifi: Wifi,
  usb: Usb,
  bluetooth: Bluetooth,
  system: Monitor,
};

export function PrinterSetupPage() {
  const { t } = useTranslation();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">{t("printers.title")}</h1>
        <Button size="sm">
          <Plus className="h-4 w-4" />
          {t("printers.add_printer")}
        </Button>
      </div>

      <Tabs defaultValue="all" className="w-full">
        <TabsList>
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="wifi">Wi-Fi / LAN</TabsTrigger>
          <TabsTrigger value="usb">USB</TabsTrigger>
          <TabsTrigger value="bluetooth">Bluetooth</TabsTrigger>
          <TabsTrigger value="system">System</TabsTrigger>
        </TabsList>
        <TabsContent value="all" className="mt-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {/* Sample Printer Cards */}
            {[
              { name: "Front Desk", type: "wifi", language: "pdf", address: "192.168.1.100", status: "online" },
              { name: "Kitchen Receipt", type: "usb", language: "escpos", address: "USB\\VID_04B8&PID_0202", status: "online" },
              { name: "Label Printer 1", type: "bluetooth", language: "tspl", address: "00:11:22:33:44:55", status: "offline" },
              { name: "Office Laser", type: "system", language: "pdf", address: "HP LaserJet Pro", status: "online" },
            ].map((printer) => {
              const Icon = printerIcons[printer.type] || Printer;
              return (
                <Card key={printer.name}>
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="p-2 rounded-md bg-secondary">
                          <Icon className="h-5 w-5" />
                        </div>
                        <div>
                          <CardTitle className="text-base">{printer.name}</CardTitle>
                          <p className="text-xs text-muted-foreground">{printer.address}</p>
                        </div>
                      </div>
                      <Badge
                        variant={printer.status === "online" ? "success" : "secondary"}
                      >
                        {printer.status}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex gap-2">
                      <Badge variant="outline">{printer.type}</Badge>
                      <Badge variant="outline">{printer.language}</Badge>
                    </div>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" className="flex-1">
                        <TestTube className="h-3 w-3" />
                        {t("printers.test_print")}
                      </Button>
                      <Button variant="ghost" size="sm">
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </TabsContent>
        <TabsContent value="wifi" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="base">Add Wi-Fi / LAN Printer</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Printer Name</Label>
                  <Input placeholder="e.g. Front Desk" />
                </div>
                <div className="space-y-2">
                  <Label>IP Address</Label>
                  <Input placeholder="192.168.1.100" />
                </div>
                <div className="space-y-2">
                  <Label>{t("printers.language")}</Label>
                  <Select>
                    <SelectTrigger>
                      <SelectValue placeholder="Select language" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="pdf">PDF</SelectItem>
                      <SelectItem value="escpos">ESC/POS</SelectItem>
                      <SelectItem value="tspl">TSPL</SelectItem>
                      <SelectItem value="zpl">ZPL</SelectItem>
                      <SelectItem value="cpcl">CPCL</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>{t("printers.paper_width_mm")}</Label>
                  <Input type="number" placeholder="80" />
                </div>
              </div>
              <div className="flex gap-2">
                <Button>Save Printer</Button>
                <Button variant="outline">Discover</Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="usb" className="mt-4">
          <Card>
            <CardContent className="pt-6 text-center text-muted-foreground">
              <Usb className="h-12 w-12 mx-auto mb-2 opacity-50" />
              <p>USB printer setup will detect connected devices.</p>
              <p className="text-sm mt-1">Connect a USB printer and click Discover.</p>
              <Button variant="outline" className="mt-4">Discover USB Printers</Button>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="bluetooth" className="mt-4">
          <Card>
            <CardContent className="pt-6 text-center text-muted-foreground">
              <Bluetooth className="h-12 w-12 mx-auto mb-2 opacity-50" />
              <p>Bluetooth printer setup will scan for nearby devices.</p>
              <Button variant="outline" className="mt-4">Scan Bluetooth</Button>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="system" className="mt-4">
          <Card>
            <CardContent className="pt-6 text-center text-muted-foreground">
              <Monitor className="h-12 w-12 mx-auto mb-2 opacity-50" />
              <p>System printers are managed by the operating system.</p>
              <Button variant="outline" className="mt-4">Refresh List</Button>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
