import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { AppLogo } from "@/components/AppLogo";
import { DevicesCard } from "@/components/DevicesCard";
import { usePrefs } from "@/lib/prefs/PrefsProvider";
import { hasPairedProvider } from "@/lib/pairing";
import { getWelcomeName } from "@/lib/share/client";

/**
 * Pairing screen, Android only. Not a wall in front of the app — since
 * PLAN §4 the phone renders thermal jobs itself, so this screen is
 * only the way to PDF printing and Print via PC. The full pairing UI
 * (scan, paste, manual entry, test) is the same `DevicesCard` Settings
 * uses; a poll notices the new pair (and the auto policy the first
 * pair switches on) and returns to where the person came from.
 */
export function PairingGate({ onPaired }: { onPaired: () => void }) {
  const { t } = useTranslation();
  const { appName, logo } = usePrefs();
  // Who is pairing: the session handle, else the guest handle, else no
  // name at all. Read once — this screen never signs anyone in or out.
  const [welcomeName] = useState<string | null>(() => getWelcomeName());

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
              {welcomeName
                ? t("auth.pair_welcome_name", { name: welcomeName })
                : t("auth.pair_required_title", { appName })}
            </CardTitle>
            <p className="text-muted-foreground">
              {t("auth.pair_required_body")}
            </p>
          </CardHeader>
        </Card>
        {/* Pass onPaired so a pair made here leaves the gate in the same
            tick. Without it the only exit is the 2s poll below, which
            leaves the freshly-paired device on screen for up to two
            seconds before /print replaces it. */}
        <DevicesCard onPaired={onPaired} />
      </div>
    </main>
  );
}
