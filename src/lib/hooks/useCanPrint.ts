import { useEffect, useState } from "react";
import { isAndroid } from "@/lib/platform";
import { hasPairedProvider } from "@/lib/pairing";

/**
 * Whether this Android phone may print: desktop never needs a pair,
 * and a paired phone is free to go. Null while undecided — callers
 * hold a spinner so the print UI never flashes before the redirect.
 */
export function useCanPrint(): boolean | null {
  const [canPrint, setCanPrint] = useState<boolean | null>(() =>
    isAndroid() ? null : true,
  );
  useEffect(() => {
    if (!isAndroid()) return;
    let cancelled = false;
    void hasPairedProvider().then((paired) => {
      if (!cancelled) setCanPrint(paired);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return canPrint;
}
