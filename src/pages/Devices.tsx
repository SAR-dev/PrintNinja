import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { DevicesCard } from "@/components/DevicesCard";
import { PrintViaPcCard } from "@/components/PrintViaPcCard";
import { PageHeader } from "@/components/PageHeader";
import { useFlashField } from "@/lib/hooks/useFlashField";
import { PHONE_QUERY, useMediaQuery } from "@/lib/hooks/useMediaQuery";

/**
 * Pairing and device sharing, on its own page: a PC lists the phones
 * that borrow it to render; a phone finds and pairs with a PC
 * (docs/architecture/PHONE_AND_PC_SHARING.md). Formerly the "phones"
 * tab of the Automation page, which kept the programmatic surface
 * (API server, explorer, deep links) focused.
 */
export function DevicesPage() {
  const { t } = useTranslation();
  const isPhone = useMediaQuery(PHONE_QUERY);
  const [searchParams] = useSearchParams();
  // Palette deep-link (`?field=`): some cards load before they render,
  // so the flash retries until the control is in the DOM.
  useFlashField(searchParams.get("field"), true);
  return (
    <div className="space-y-4">
      <PageHeader
        title={t(isPhone ? "nav.connect_pc" : "nav.devices")}
        description={t("pages.devices")}
      />
      <div className="space-y-4">
        <DevicesCard />
        <PrintViaPcCard />
      </div>
    </div>
  );
}
