import { useTranslation } from "react-i18next";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTheme } from "@/lib/theme/ThemeProvider";
import { Palette, Globe, Key, Link, Shield, Download } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { diagnostics } from "@/lib/diagnostics";

export function SettingsPage() {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  const [apiPort, setApiPort] = useState(17717);
  const [lanAccess, setLanAccess] = useState(false);
  const [apiKey, setApiKey] = useState("pn_live_xxxxxxxx");

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">{t("settings_page.title")}</h1>

      <Tabs defaultValue="general" className="w-full">
        <TabsList>
          <TabsTrigger value="general">
            <Palette className="h-4 w-4" />
            General
          </TabsTrigger>
          <TabsTrigger value="fonts">
            <Globe className="h-4 w-4" />
            {t("settings_page.fonts")}
          </TabsTrigger>
          <TabsTrigger value="api">
            <Key className="h-4 w-4" />
            {t("settings_page.api")}
          </TabsTrigger>
          <TabsTrigger value="deeplinks">
            <Link className="h-4 w-4" />
            {t("settings_page.deep_links")}
          </TabsTrigger>
          <TabsTrigger value="security">
            <Shield className="h-4 w-4" />
            Security
          </TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="mt-4 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("settings_page.theme")}</CardTitle>
            </CardHeader>
            <CardContent>
              <Select value={theme} onValueChange={(v) => setTheme(v as "light" | "dark" | "system")}>
                <SelectTrigger className="w-[200px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="light">{t("settings_page.light")}</SelectItem>
                  <SelectItem value="dark">{t("settings_page.dark")}</SelectItem>
                  <SelectItem value="system">{t("settings_page.system")}</SelectItem>
                </SelectContent>
              </Select>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("settings_page.retention")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Keep history for (days)</Label>
                  <Input type="number" defaultValue="30" />
                </div>
                <div className="space-y-2">
                  <Label>Max records</Label>
                  <Input type="number" defaultValue="10000" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Diagnostics</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Export application logs and diagnostics for troubleshooting.
              </p>
              <Button variant="outline" onClick={() => {
                diagnostics.download();
                toast.success("Diagnostics exported");
              }}>
                <Download className="h-4 w-4 mr-2" />
                Export Diagnostics
              </Button>
              <p className="text-xs text-muted-foreground">
                Secrets and API tokens are redacted from the export.
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="fonts" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("settings_page.fonts")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between p-3 rounded-md border">
                <div>
                  <p className="text-sm font-medium">Noto Sans (Latin)</p>
                  <p className="text-xs text-muted-foreground">Bundled with app</p>
                </div>
                <Badge>Installed</Badge>
              </div>
              <div className="flex items-center justify-between p-3 rounded-md border">
                <div>
                  <p className="text-sm font-medium">Noto Sans CJK</p>
                  <p className="text-xs text-muted-foreground">Japanese, Chinese, Korean</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => toast.info("Downloading CJK fonts...")}>Download</Button>
              </div>
              <Button variant="outline" className="w-full" onClick={() => toast.info("Font upload dialog coming soon")}>
                Upload Font (TTF, OTF, WOFF2)
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="api" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Local REST API</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between p-3 rounded-md border">
                <div>
                  <p className="text-sm font-medium">API Server</p>
                  <p className="text-xs text-muted-foreground">
                    {lanAccess ? "0.0.0.0" : "127.0.0.1"}:{apiPort}
                  </p>
                </div>
                <Badge variant="secondary">Disabled</Badge>
              </div>
              <div className="space-y-2">
                <Label>Port</Label>
                <Input type="number" value={apiPort} onChange={(e) => setApiPort(Number(e.target.value))} />
              </div>
              <div className="space-y-2">
                <Label>API Key</Label>
                <div className="flex gap-2">
                  <Input type="password" value={apiKey} readOnly />
                  <Button variant="outline" onClick={async () => {
                    const key = await invoke<string>("regenerate_api_key");
                    setApiKey(key);
                    toast.success("New API key generated");
                  }}>Regenerate</Button>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Switch id="lan-access" checked={lanAccess} onCheckedChange={setLanAccess} />
                  <Label htmlFor="lan-access">Allow LAN access</Label>
                </div>
                <Button variant="default" onClick={() => {
                  toast.promise(invoke<string>("start_api_server", { port: apiPort, lanAccess }), {
                    loading: "Starting API server...",
                    success: "API server started",
                    error: (e) => `Failed: ${e}`,
                  });
                }}>Start Server</Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="deeplinks" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Trusted Sources</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Manage which apps and domains can trigger prints without confirmation.
              </p>
              <div className="space-y-2">
                <div className="flex items-center justify-between p-3 rounded-md border">
                  <div>
                    <p className="text-sm font-medium">POS System</p>
                    <p className="text-xs text-muted-foreground">pos.local</p>
                  </div>
                  <Badge>Trusted</Badge>
                </div>
              </div>
              <Button variant="outline" className="w-full">
                Add Trusted Source
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="security" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Security</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>{t("settings_page.allowed_domains")}</Label>
                <Input placeholder="api.example.com, pos.local" />
                <p className="text-xs text-muted-foreground">
                  Comma-separated list of allowed domains for data URLs
                </p>
              </div>
              <div className="flex items-center gap-2">
                <input type="checkbox" id="block-private" defaultChecked />
                <Label htmlFor="block-private">Block private IP ranges</Label>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
