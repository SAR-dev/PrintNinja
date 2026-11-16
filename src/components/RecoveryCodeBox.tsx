import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

/**
 * A recovery code, shown big and selectable with a copy button. The
 * server returns a code only once, so every place that shows one also
 * tells the person to save it.
 */
export function RecoveryCodeBox({ code }: { code: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      // No clipboard access: the code is selectable text, so the person
      // can still copy it by hand.
    }
  };

  return (
    <div className="space-y-2">
      <p
        data-testid="recovery-code"
        className="select-all rounded-md border bg-muted p-3 text-center font-mono text-lg tracking-wider"
      >
        {code}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full"
        data-testid="recovery-code-copy"
        onClick={() => void copy()}
      >
        {copied ? t("auth.recovery_copied") : t("auth.recovery_copy")}
      </Button>
    </div>
  );
}
