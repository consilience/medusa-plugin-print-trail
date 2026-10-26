import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { PRINT_TRAIL_MODULE } from "../modules/printTrail"
import type PrintTrailModuleService from "../modules/printTrail/service"
import { wasPreOrder } from "./pre-order"
import { buildShipmentNotification, type ShipmentFulfillment, type ShipmentOrder } from "./shipment-email"
import type { Label } from "./sync-decisions"

const FULFILLMENT_FIELDS = [
  "id",
  "metadata",
  "items.line_item_id",
  "items.title",
  "items.quantity",
  "labels.tracking_number",
  "labels.tracking_url",
]

// Sends the customer the Print Trail parcel email through the store's
// notification provider. Deduped by idempotency key; a failure is logged and
// never retried.
export async function sendPrintTrailShipmentEmail(
  container: MedusaContainer,
  fulfillmentId: string,
  opts: { only?: Label[] } = {}
): Promise<"sent" | "skipped" | "failed"> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const service = container.resolve<PrintTrailModuleService>(PRINT_TRAIL_MODULE)
  const options = await service.getOptions()
  const template = options.notifications.shipment
  if (template === false) {
    return "skipped"
  }
  try {
    const { data: fulfillments } = await query.graph({
      entity: "fulfillment",
      fields: FULFILLMENT_FIELDS,
      filters: { id: fulfillmentId },
    })
    const fulfillment = fulfillments[0] as unknown as ShipmentFulfillment | undefined
    const meta = fulfillment?.metadata ?? {}
    if (!fulfillment || !meta.print_trail_fulfilment_uuid || typeof meta.order_id !== "string") {
      return "skipped"
    }
    // The order id comes from the plugin's own metadata, so the email doesn't
    // depend on the fulfilment↔order link's direction.
    const { data: orders } = await query.graph({
      entity: "order",
      fields: ["id", "display_id", "email"],
      filters: { id: meta.order_id },
    })
    const order = orders[0] as unknown as ShipmentOrder | undefined
    if (!order) {
      return "skipped"
    }
    const rowId = typeof meta.print_trail_order_id === "string" ? meta.print_trail_order_id : null
    const [row] = rowId ? await service.listPrintTrailOrders({ id: rowId }) : []
    const notification = buildShipmentNotification({
      fulfillment,
      order,
      template,
      render: options.notifications.render,
      ptOrderNumber: row?.pt_order_number ?? null,
      only: opts.only,
      preOrder: wasPreOrder(row, String(meta.print_trail_fulfilment_uuid)),
    })
    if (!notification) {
      return "skipped"
    }
    const notifications = container.resolve(Modules.NOTIFICATION)
    await notifications.createNotifications([notification])
    return "sent"
  } catch (e) {
    logger.warn(
      `Print Trail: couldn't send the shipment email for fulfillment ${fulfillmentId}: ${(e as Error).message}`
    )
    return "failed"
  }
}
