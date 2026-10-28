import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { AppLogo } from "@/components/AppLogo";
import { DevicesCard } from "@/components/DevicesCard";
import { usePrefs } from "@/lib/prefs/PrefsProvider";
import { hasPairedProvider } from "@/lib/pairing";

/**
 * Mandatory pairing screen, Android only. The phone never renders
 * locally — every print is bought from the paired PC — so an unpaired
 * phone cannot print at all, and the app opens here until one is
 * paired. The full pairing UI (scan, paste, manual entry, test) is the
 * same `DevicesCard` Settings uses; a poll notices the new pair (and
 * the auto policy the first pair switches on) and lets the app through.
 */
export function PairingGate({ onPaired }: { onPaired: () => void }) {
  const { t } = useTranslation();
  const { appName, logo } = usePrefs();

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      if (!cancelled && (await hasPairedProvider())) onPaired();
    };
    void check();
    const id = setInterval(() => void check(), 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [onPaired]);

  return (
    <main className="flex min-h-dvh-safe items-start justify-center bg-background p-4 sm:items-center">
      <div className="w-full max-w-md space-y-4 py-6">
        <Card>
          <CardHeader className="space-y-3">
            <AppLogo src={logo} className="h-10 w-10" />
            <CardTitle className="text-xl">
              {t("auth.pair_required_title", { appName })}
            </CardTitle>
            <p className="text-muted-foreground">
              {t("auth.pair_required_body")}
            </p>
          </CardHeader>
        </Card>
        <DevicesCard />
      </div>
    </main>
  );
}
