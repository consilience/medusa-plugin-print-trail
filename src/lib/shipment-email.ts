import type { CreateNotificationDTO } from "@medusajs/framework/types"
import { shipmentContent } from "./email/shipment"
import type { Label } from "./sync-decisions"

// The per-parcel shipment email, sent only for fulfilments this plugin
// created at dispatch (they carry metadata.print_trail_fulfilment_uuid).

export type ShipmentFulfillment = {
  id: string
  metadata?: Record<string, unknown> | null
  items: { line_item_id?: string | null; title?: string | null; quantity: number | string }[]
  labels: { tracking_number: string; tracking_url: string }[]
}

export type ShipmentOrder = { id: string; display_id?: number | string | null; email?: string | null }

export function buildShipmentNotification(input: {
  fulfillment: ShipmentFulfillment
  order: ShipmentOrder
  template: string
  // false: template and data only (a store rendering its own, e.g. SendGrid,
  // which drops the template when content is present).
  render?: boolean
  ptOrderNumber?: string | null
  // Late tracking: only these labels, and the key is built from them.
  only?: Label[]
  // The parcel waited for its pre-order release (the row's
  // pre_order_fulfilments): pre-order wording, and data.pre_order.
  preOrder?: boolean
}): CreateNotificationDTO | null {
  const { fulfillment, order } = input
  if (!fulfillment.metadata?.print_trail_fulfilment_uuid || !order.email) {
    return null
  }
  const tracking = (input.only ?? fulfillment.labels)
    .filter((l) => !!l.tracking_number)
    .map((l) => ({ number: l.tracking_number, url: l.tracking_url || null }))
  if (!tracking.length) {
    return null
  }
  const numbers = tracking.map((t) => t.number).sort()
  const carrier = fulfillment.metadata.carrier
  const data = {
    order: { id: order.id, display_id: order.display_id ?? null },
    print_trail_order_number: input.ptOrderNumber ?? null,
    carrier: typeof carrier === "string" ? carrier : null,
    items: fulfillment.items.map((i) => ({
      line_item_id: i.line_item_id ?? null,
      title: i.title ?? null,
      quantity: Number(i.quantity),
    })),
    tracking,
    pre_order: input.preOrder === true,
  }
  // Rendered by the plugin (content); template and data stay for a
  // template-based provider that renders its own.
  return {
    to: order.email,
    channel: "email",
    template: input.template,
    trigger_type: "shipment.created",
    resource_type: "fulfillment",
    resource_id: fulfillment.id,
    idempotency_key: `print-trail-shipment:${fulfillment.id}:${numbers.join(",")}`,
    data,
    ...(input.render === false ? {} : { content: shipmentContent(data) }),
  }
}
