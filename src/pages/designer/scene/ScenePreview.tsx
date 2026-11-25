/**
 * The scene track's phone view: the label page as a read-only canvas
 * (sample data substituted where it is available) with the sample-data
 * panel below. The top bar keeps the name and the save.
 */
import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { firstRecordOf } from "@/lib/scene/editor-model";
import type { Template } from "@/lib/scene/schema";
import { SceneCanvas } from "./SceneCanvas";

export function ScenePreview({
  template,
  dpi,
  sampleJson,
  samplePanel,
  dirty,
  templateName,
}: {
  template: Template;
  dpi: number | null;
  sampleJson: string;
  /** The page's sample-data panel, rendered read-only. */
  samplePanel: ReactNode;
  dirty: boolean;
  templateName: string;
}) {
  const { t } = useTranslation();
  const record = useMemo(() => firstRecordOf(sampleJson), [sampleJson]);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span className="truncate">{templateName}</span>
          <Badge>scene</Badge>
          {dirty && (
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
              aria-label={t("scene.unsaved")}
            />
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <SceneCanvas
          template={template}
          selection={null}
          onSelect={() => {}}
          record={record}
          showSample
          dpi={dpi}
        />
        {samplePanel}
      </CardContent>
    </Card>
  );
}
