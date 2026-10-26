import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { sendPrintTrailShipmentEmail } from "../lib/notify-shipment"

// Medusa sends no shipment email itself. This sends one per Print Trail parcel
// (fulfilments created by the plugin at dispatch); others are ignored.
export default async function printTrailShipmentCreatedHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string; no_notification?: boolean }>) {
  if (data.no_notification) {
    return
  }
  await sendPrintTrailShipmentEmail(container, data.id)
}

export const config: SubscriberConfig = {
  event: "shipment.created",
}
