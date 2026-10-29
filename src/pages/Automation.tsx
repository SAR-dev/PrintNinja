import { Link2, Play, Server, Smartphone } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { ApiServerPanel } from "@/components/automation/ApiServerPanel";
import { TrustedSourcesPanel } from "@/components/automation/TrustedSourcesPanel";
import { DevicesCard } from "@/components/DevicesCard";
import { PrintViaPcCard } from "@/components/PrintViaPcCard";
import { PageHeader } from "@/components/PageHeader";
import { isAndroid } from "@/lib/platform";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiExplorerPanel } from "@/pages/ApiExplorer";

export const AUTOMATION_TABS = [
  "server",
  "explorer",
  "phones",
  "links",
] as const;
export type AutomationTab = (typeof AUTOMATION_TABS)[number];

/** Unknown or missing `?tab=` lands on the server, where everything starts. */
export function parseAutomationTab(raw: string | null): AutomationTab {
  return (AUTOMATION_TABS as readonly string[]).includes(raw ?? "")
    ? (raw as AutomationTab)
    : "server";
}

/**
 * Everything that lets another program or device drive PrintNinja, in
 * one page: the local API server, a console to try it, phones that
 * borrow this PC to render, and which `printninja://` links skip the
 * confirmation sheet. Each switch lives in exactly one tab.
 */
export function AutomationPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = parseAutomationTab(searchParams.get("tab"));
  const openTab = (next: AutomationTab) => {
    const params = new URLSearchParams(searchParams);
    if (next === "server") params.delete("tab");
    else params.set("tab", next);
    setSearchParams(params, { replace: true });
  };

  const TAB_META: Array<{
    key: AutomationTab;
    label: string;
    icon: typeof Server;
  }> = [
    { key: "server", label: t("automation.tab_server"), icon: Server },
    { key: "explorer", label: t("automation.tab_explorer"), icon: Play },
    // A phone pairs with a computer here; a PC lists its phones.
    {
      key: "phones",
      label: isAndroid()
        ? t("automation.tab_computer")
        : t("automation.tab_phones"),
      icon: Smartphone,
    },
    { key: "links", label: t("automation.tab_links"), icon: Link2 },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("nav.automation")}
        description={t("pages.automation")}
      />
      <Tabs
        value={tab}
        onValueChange={(v) => openTab(v as AutomationTab)}
        className="space-y-4"
      >
        <TabsList
          aria-label={t("automation.tabs_aria")}
          className="h-auto w-full flex-wrap justify-start"
        >
          {TAB_META.map(({ key, label, icon: Icon }) => (
            <TabsTrigger
              key={key}
              value={key}
              data-testid={`automation-tab-${key}`}
              className="gap-1.5"
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="server" className="mt-0 space-y-4">
          <ApiServerPanel onOpenExplorer={() => openTab("explorer")} />
        </TabsContent>
        <TabsContent value="explorer" className="mt-0 space-y-4">
          <ApiExplorerPanel onOpenServer={() => openTab("server")} />
        </TabsContent>
        <TabsContent value="phones" className="mt-0 space-y-4">
          <DevicesCard />
          <PrintViaPcCard />
        </TabsContent>
        <TabsContent value="links" className="mt-0 space-y-4">
          <TrustedSourcesPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
