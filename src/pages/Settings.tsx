import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import {
  Type,
  UserRound,
  Archive,
  Activity,
  AppWindow,
  Globe,
  Shield,
  ListChecks,
  ArrowLeft,
  ChevronRight,
  type LucideIcon,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { SetupChecklist } from "@/components/SetupChecklist";
import { ProfileCard } from "@/components/ProfileCard";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { PHONE_QUERY, useMediaQuery } from "@/lib/hooks/useMediaQuery";
import { useFlashField } from "@/lib/hooks/useFlashField";
import { parseSection, type SettingsSection } from "@/lib/setup/checklist";
import { useRenderEngine } from "@/lib/render/useRenderEngine";
import { GeneralSection } from "./settings/GeneralSection";
import { BackgroundSection } from "./settings/BackgroundSection";
import { ShareSection } from "./settings/ShareSection";
import { DataSection } from "./settings/DataSection";
import { RetentionSection } from "./settings/RetentionSection";
import { DiagnosticsSection } from "./settings/DiagnosticsSection";

/** Phone list → detail navigation: icon, label and a
    one-line summary per section. Labels match the desktop tab strip. */
const SECTION_META: Array<{
  key: SettingsSection;
  icon: LucideIcon;
  labelKey: string;
  summaryKey: string;
}> = [
  {
    key: "general",
    icon: Type,
    labelKey: "section_general",
    summaryKey: "hint_general",
  },
  {
    key: "setup",
    icon: ListChecks,
    labelKey: "section_setup",
    summaryKey: "hint_setup",
  },
  {
    key: "profile",
    icon: UserRound,
    labelKey: "section_profile",
    summaryKey: "hint_profile",
  },
  {
    key: "background",
    icon: AppWindow,
    labelKey: "section_background",
    summaryKey: "hint_background",
  },
  {
    key: "share",
    icon: Globe,
    labelKey: "section_share",
    summaryKey: "hint_share",
  },
  {
    key: "data",
    icon: Shield,
    labelKey: "section_data",
    summaryKey: "hint_data",
  },
  {
    key: "retention",
    icon: Archive,
    labelKey: "section_retention",
    summaryKey: "hint_retention",
  },
  {
    key: "diagnostics",
    icon: Activity,
    labelKey: "section_diagnostics",
    summaryKey: "hint_diagnostics",
  },
];

/**
 * Settings page: section navigation only. Each section owns its own
 * state and markup in `src/pages/settings/`; sections initialize from
 * the local settings cache (synchronous, no flicker) and reconcile
 * with the DB on mount, so no page-level loading gate is needed.
 * The render-engine status is fetched once here and shared.
 */
export function SettingsPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const section = parseSection(searchParams.get("section"));
  const isPhone = useMediaQuery(PHONE_QUERY);
  // Phone list → detail: the list shows when no section is selected.
  const hasSection = searchParams.has("section");
  const openSection = (next: SettingsSection) => {
    const params = new URLSearchParams(searchParams);
    // "general" is the default, so desktop drops the param; phones always
    // set it, or tapping General would land back on the section list.
    if (next === "general" && !isPhone) params.delete("section");
    else params.set("section", next);
    setSearchParams(params, { replace: true });
  };
  const closeSection = () => {
    const params = new URLSearchParams(searchParams);
    params.delete("section");
    setSearchParams(params, { replace: true });
  };

  // One fetch for every section that needs the render engine.
  const { status: engine, recheck: recheckEngine } = useRenderEngine();

  // Palette deep-link (`?section=&field=`). The section re-mounts when
  // the tab changes, and the flash retries for ~2s, so no loading gate.
  useFlashField(searchParams.get("field"), hasSection, [section]);

  return (
    <div className="space-y-4">
      {/* A phone inside a section shows the section's own title bar
          below instead: the page title would only push content down. */}
      {!(isPhone && hasSection) && (
        <PageHeader
          title={t("settings_page.title")}
          description={t("pages.settings")}
        />
      )}

      {isPhone && !hasSection ? (
        /* Phone section list: tapping one opens it with a back arrow. */
        <ul className="space-y-2">
          {SECTION_META.map((s) => (
            <li key={s.key}>
              <button
                type="button"
                onClick={() => openSection(s.key)}
                className="flex min-h-16 w-full items-center gap-3.5 rounded-lg border bg-card p-3 text-left"
              >
                <span
                  aria-hidden="true"
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-foreground"
                >
                  <s.icon className="h-5 w-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[0.9375rem] font-semibold">
                    {t(`settings_page.${s.labelKey}`)}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {t(`settings_page.${s.summaryKey}`)}
                  </span>
                </span>
                <ChevronRight
                  className="h-4 w-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <Tabs
          value={section}
          onValueChange={(v) => openSection(v as SettingsSection)}
          orientation="vertical"
          className="flex flex-col gap-4 md:flex-row md:items-start md:gap-8"
        >
          {isPhone ? (
            <div className="flex items-center gap-1 border-b pb-3">
              <Button
                variant="ghost"
                size="icon"
                className="-ml-2 shrink-0"
                onClick={closeSection}
                aria-label={t("common.back")}
              >
                <ArrowLeft className="h-5 w-5" aria-hidden="true" />
              </Button>
              <h1 className="truncate text-xl font-semibold leading-tight tracking-tight">
                {t(`settings_page.section_${section}`, section)}
              </h1>
            </div>
          ) : (
            // Desktop/tablet only (phones take the back-button branch
            // above): a vertical section rail.
            <TabsList
              aria-label={t("settings_page.sections_aria")}
              className="h-auto w-full shrink-0 gap-1 bg-transparent p-0 md:w-56 md:flex-col"
            >
              {SECTION_META.map((s) => (
                <TabsTrigger
                  key={s.key}
                  value={s.key}
                  className="w-full justify-start gap-2 data-[state=active]:bg-accent data-[state=active]:text-accent-foreground data-[state=active]:shadow-none"
                >
                  <s.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  {t(`settings_page.${s.labelKey}`)}
                </TabsTrigger>
              ))}
            </TabsList>
          )}

          <div className="min-w-0 max-w-3xl flex-1">
            <TabsContent value="setup" className="mt-0 space-y-4">
              <SetupChecklist onOpenSection={openSection} />
            </TabsContent>

            <TabsContent value="profile" className="mt-0 space-y-4">
              <ProfileCard />
            </TabsContent>

            <TabsContent value="general" className="mt-0 space-y-4">
              <GeneralSection engine={engine} />
            </TabsContent>

            <TabsContent value="background" className="mt-0 space-y-4">
              <BackgroundSection />
            </TabsContent>

            <TabsContent value="share" className="mt-0 space-y-4">
              <ShareSection />
            </TabsContent>

            <TabsContent value="data" className="mt-0 space-y-4">
              <DataSection />
            </TabsContent>

            <TabsContent value="retention" className="mt-0 space-y-4">
              <RetentionSection />
            </TabsContent>

            <TabsContent value="diagnostics" className="mt-0 space-y-4">
              <DiagnosticsSection
                engine={engine}
                recheckEngine={recheckEngine}
              />
            </TabsContent>
          </div>
        </Tabs>
      )}
    </div>
  );
}
