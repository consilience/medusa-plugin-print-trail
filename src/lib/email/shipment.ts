import { escapeHtml, link, orderLabel, textLink, wrap, type EmailContent } from "./html"

// The customer's per-parcel email: one Print Trail fulfilment has been
// dispatched. The data is what buildShipmentNotification sends (unchanged, so
// a template-based provider can render its own). The Print Trail order number
// is internal and isn't shown to the customer.
export type ShipmentData = {
  order?: { id?: string; display_id?: number | string | null }
  carrier?: string | null
  items?: { title?: string | null; quantity?: number | string | null }[]
  tracking?: { number?: string; url?: string | null }[]
  // The parcel waited for its pre-order release at Print Trail.
  pre_order?: boolean
}

// A count to show: a positive finite number, else 1.
const quantityOf = (q: unknown): number => {
  const n = Number(q)
  return q !== null && q !== "" && Number.isFinite(n) && n > 0 ? n : 1
}

export function shipmentSubject(data: ShipmentData = {}): string {
  const label = orderLabel(data.order)
  return (data.pre_order === true ? `Your pre-order from order ${label} has shipped` : `Your order ${label} is on its way`).replace(/\s+/g, " ")
}

const headingOf = (data: ShipmentData, label: string) =>
  (data.pre_order === true ? `Your pre-order from order ${label} is on its way` : `Your order ${label} is on its way`).replace(/\s+/g, " ")

export function shipmentContent(data: ShipmentData = {}): EmailContent {
  const label = orderLabel(data.order)
  const by = data.carrier ? ` by ${data.carrier}` : ""
  const lead =
    data.pre_order === true
      ? `Your pre-order from order ${label} has been released and dispatched${by}.`
      : `A parcel from your order ${label} has been dispatched${by}.`
  const heading = headingOf(data, label)
  const items = (Array.isArray(data.items) ? data.items : []).filter((i) => i?.title)
  const tracking = (Array.isArray(data.tracking) ? data.tracking : []).filter((t) => t?.number)

  const html = wrap(
    [
      `<h2>${escapeHtml(heading)}</h2>`,
      `<p>${escapeHtml(lead)}</p>`,
      items.length
        ? `<p><strong>In this parcel:</strong></p><ul>${items.map((i) => `<li>${escapeHtml(quantityOf(i.quantity))} × ${escapeHtml(i.title)}</li>`).join("")}</ul>`
        : "",
      tracking.length
        ? `<p><strong>Tracking:</strong></p><ul>${tracking.map((t) => `<li>${link(t.url, t.number!)}</li>`).join("")}</ul>`
        : "",
    ].join("")
  )
  const text = [
    heading,
    "",
    lead,
    ...(items.length ? ["", "In this parcel:", ...items.map((i) => `- ${quantityOf(i.quantity)} × ${i.title}`)] : []),
    ...(tracking.length ? ["", "Tracking:", ...tracking.map((t) => `- ${textLink(t.url, t.number!)}`)] : []),
  ].join("\n")
  return { subject: shipmentSubject(data), html, text }
}
