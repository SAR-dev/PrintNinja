import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { agent } from "@/lib/agent/commands";
import { isWebMode, settingsLsKey } from "@/lib/settings";

/** Which apps may open `printninja://` links without the confirmation sheet. */
export function TrustedSourcesPanel() {
  const { t } = useTranslation();
  const [trusted, setTrusted] = useState<string[]>([]);
  const [newTrusted, setNewTrusted] = useState("");

  useEffect(() => {
    (async () => {
      try {
        if (isWebMode()) {
          const raw = localStorage.getItem(settingsLsKey("trusted_sources"));
          setTrusted(raw ? (JSON.parse(raw) as string[]) : []);
        } else {
          setTrusted((await agent("get_trusted_sources", {})) ?? []);
        }
      } catch {
        setTrusted([]);
      }
    })();
  }, []);

  // Single write path for trusted sources: the dedicated command in
  // app mode, localStorage in web mode (or when the backend is down).
  const persistTrusted = async (next: string[]) => {
    const clean = [...new Set(next.map((s) => s.trim()).filter(Boolean))];
    if (isWebMode()) {
      localStorage.setItem(
        settingsLsKey("trusted_sources"),
        JSON.stringify(clean),
      );
    } else {
      try {
        await agent("set_trusted_sources", { sources: clean });
      } catch {
        localStorage.setItem(
          settingsLsKey("trusted_sources"),
          JSON.stringify(clean),
        );
      }
    }
    setTrusted(clean);
  };

  const addTrusted = async () => {
    const value = newTrusted.trim();
    if (!value) return;
    if (trusted.includes(value)) {
      toast.info(t("settings_page.toast_already_trusted"));
      return;
    }
    await persistTrusted([...trusted, value]);
    setNewTrusted("");
    toast.success(t("settings_page.toast_trusted_added"));
  };

  const removeTrusted = async (value: string) => {
    await persistTrusted(trusted.filter((x) => x !== value));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {t("automation.links_title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {t("settings_page.trusted_hint")}
        </p>
        {trusted.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No trusted sources yet — every deep link asks for confirmation.
          </p>
        ) : (
          trusted.map((src) => (
            <div
              key={src}
              className="flex items-center justify-between p-3 rounded-md border"
            >
              <span className="text-sm font-mono">{src}</span>
              <div className="flex items-center gap-2">
                <Badge variant="success">
                  {t("settings_page.trusted_badge")}
                </Badge>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${src}`}
                  onClick={() => removeTrusted(src)}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            </div>
          ))
        )}

        <div className="flex gap-2">
          <Input
            aria-label={t("settings_page.trusted_input_aria")}
            placeholder={t("settings_page.trusted_input_example")}
            value={newTrusted}
            onChange={(e) => setNewTrusted(e.target.value)}
          />
          <Button variant="outline" onClick={addTrusted}>
            <Plus className="h-4 w-4" />
            {t("common.add")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
