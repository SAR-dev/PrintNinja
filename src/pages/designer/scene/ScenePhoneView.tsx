/**
 * The label track's phone view: read-only like the document viewer, with
 * the same section picker — Preview / Sample data / README. Editing happens
 * on a computer; the one phone edit is the sample data.
 */
import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { InfoNotice } from "@/components/InfoNotice";
import { MarkdownPreview } from "@/components/ReadmeEditor";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { firstRecordOf, pageDims } from "@/lib/scene/editor-model";
import type { Template } from "@/lib/scene/schema";
import { SceneCanvas } from "./SceneCanvas";

interface Props {
  template: Template;
  templateName: string;
  sampleJson: string;
  samplePanel: ReactNode;
  readme: string;
  dpi: number | null;
  dirty: boolean;
  onSave: () => void;
  canSave: boolean;
}

type Section = "preview" | "sample" | "readme";

/** The phone's read-only label viewer, matching the document viewer's shell. */
export function ScenePhoneView({
  template,
  templateName,
  sampleJson,
  samplePanel,
  readme,
  dpi,
  dirty,
  onSave,
  canSave,
}: Props) {
  const { t } = useTranslation();
  const [section, setSection] = useState<Section>("preview");
  const record = useMemo(() => firstRecordOf(sampleJson), [sampleJson]);
  const { w, h } = pageDims(template.media);

  return (
    <div className="space-y-4">
      <InfoNotice id="designer.viewer_notice">
        {t("designer.viewer_notice")}
      </InfoNotice>
      <Select value={section} onValueChange={(v) => setSection(v as Section)}>
        <SelectTrigger
          aria-label={t("designer.viewer_section_aria")}
          className="w-full"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="preview">
            {t("designer.viewer_preview")}
          </SelectItem>
          <SelectItem value="sample">{t("designer.sampleData")}</SelectItem>
          <SelectItem value="readme">README</SelectItem>
        </SelectContent>
      </Select>

      {section === "preview" && (
        <div role="region" aria-label={t("designer.viewer_preview_title")}>
          <Card>
            <CardContent className="flex flex-col gap-3 pt-5">
              <p className="text-sm font-medium">{templateName}</p>
              <p className="text-xs text-muted-foreground">
                {w} × {h} mm
                {dirty ? ` · ${t("scene.unsaved")}` : ""}
              </p>
              <SceneCanvas
                template={template}
                selection={null}
                onSelect={() => undefined}
                record={record}
                showSample
                dpi={dpi}
              />
            </CardContent>
          </Card>
        </div>
      )}
      {section === "sample" && (
        <div className="space-y-4">
          <Card>
            <CardContent className="pt-5">
              <div className="viewer-sample space-y-4">{samplePanel}</div>
            </CardContent>
          </Card>
          <div className="sticky bottom-0 z-10 -mx-4 border-t bg-background/95 px-4 py-3 backdrop-blur">
            <Button className="w-full" onClick={onSave} disabled={!canSave}>
              {t("common.save")}
            </Button>
          </div>
        </div>
      )}
      {section === "readme" && (
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            <div className="px-6 py-5">
              <MarkdownPreview
                text={readme}
                emptyHint={t("readme.empty_hint")}
              />
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
