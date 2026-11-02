import { RECEIPT_PACK } from "./receipt";
import { DELIVERY_SLIP_PACK } from "./deliverySlip";
import { INVOICE_PACK } from "./invoice";
import { SHIPPING_LABEL_PACK } from "./shippingLabel";
import { KITCHEN_TICKET_PACK } from "./kitchenTicket";
import { BLANK_PACK } from "./blank";

export type TemplatePack = {
  id: string;
  name: string;
  description: string;
  page_w_mm: number;
  page_h_mm: number;
  html: string;
  css: string;
  readme: (name: string) => string;
  mockData: unknown;
};

export const PACKS: TemplatePack[] = [
  RECEIPT_PACK,
  DELIVERY_SLIP_PACK,
  INVOICE_PACK,
  SHIPPING_LABEL_PACK,
  KITCHEN_TICKET_PACK,
  BLANK_PACK,
];

export function getPack(id: string): TemplatePack | undefined {
  return PACKS.find((p) => p.id === id);
}

export { RECEIPT_PACK, DELIVERY_SLIP_PACK, INVOICE_PACK, SHIPPING_LABEL_PACK, KITCHEN_TICKET_PACK, BLANK_PACK };
