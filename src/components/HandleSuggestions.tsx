import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { suggestHandles } from "@/lib/share/handleSuggest";

interface HandleSuggestionsProps {
  /** Fills the parent's handle field with the picked suggestion. */
  onPick: (handle: string) => void;
  disabled?: boolean;
}

/**
 * A "Suggest" button that proposes name-style handles and lets the user tap
 * one to fill the handle field. Used by both register forms.
 */
export function HandleSuggestions({
  onPick,
  disabled = false,
}: HandleSuggestionsProps) {
  const { t } = useTranslation();
  const [suggestions, setSuggestions] = useState<string[]>([]);

  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled}
        onClick={() => setSuggestions(suggestHandles(3))}
      >
        <Sparkles className="h-4 w-4" aria-hidden="true" />
        {t("auth.suggest")}
      </Button>
      {suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {suggestions.map((s) => (
            <Button
              key={s}
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => onPick(s)}
            >
              {s}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
