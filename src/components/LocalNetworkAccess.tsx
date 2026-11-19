import { useTranslation } from "react-i18next";
import { WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * The two faces of Android's local network permission.
 *
 * `LocalNetworkNotice` is the inline card that takes a blocked area's
 * place while the permission is off (the network section of the Add
 * sheet): one message, "Allow access" (the system prompt, or the
 * settings screen when Android will not prompt again) and "Open
 * settings" (the settings screen, always).
 *
 * `LocalNetworkPrompt` is the short explanation screen shown before
 * the system prompt fires on an action that needs the LAN (pairing a
 * PC, testing a pair, scanning nearby printers): Allow and Not now.
 *
 * Bluetooth and USB never need the permission, so neither component
 * appears for them.
 */

export function LocalNetworkNotice({
  onAllow,
  onOpenSettings,
}: {
  onAllow: () => void;
  onOpenSettings: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="space-y-2 rounded-md border border-warning/40 p-3"
      data-testid="lan-notice"
      role="alert"
    >
      <p className="flex items-start gap-1.5 text-xs text-warning">
        <WifiOff className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{t("printers.lan_denied")}</span>
      </p>
      <div className="flex gap-1.5">
        <Button size="sm" onClick={onAllow} data-testid="lan-notice-allow">
          {t("printers.lan_allow")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onOpenSettings}
          data-testid="lan-notice-settings"
        >
          {t("printers.lan_open_settings")}
        </Button>
      </div>
    </div>
  );
}

export function LocalNetworkPrompt({
  open,
  onOpenChange,
  canAskAgain,
  onAllow,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** False when Android will not prompt again: Allow then opens the
   * settings screen, and its label says so. */
  canAskAgain: boolean;
  onAllow: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange} data-testid="lan-prompt">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("printers.lan_prompt_title")}</DialogTitle>
          <DialogDescription>{t("printers.lan_prompt_body")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            data-testid="lan-prompt-not-now"
          >
            {t("printers.lan_prompt_not_now")}
          </Button>
          <Button onClick={onAllow} data-testid="lan-prompt-allow">
            {canAskAgain
              ? t("printers.lan_prompt_allow")
              : t("printers.lan_open_settings")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
