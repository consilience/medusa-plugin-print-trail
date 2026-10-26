import { escapeHtml, isHttpUrl, link, orderLabel, textLink, wrap, type EmailContent } from "./html"

// The admin's "cancel too late" email: an order was cancelled in Medusa after
// Print Trail had dispatched some or all of it. The data is what
// buildCancelTooLateNotifications sends (unchanged, so a template-based
// provider can render its own).
export type CancelTooLateData = {
  order?: { id?: string; display_id?: number | string | null }
  print_trail_order_number?: string | null
  pt_url?: string | null
  admin_order_url?: string | null
  why?: "dispatched" | "complete" | "partial" | string
  fulfilments?: {
    number?: string | null
    status?: string
    tracking?: { number?: string; url?: string | null; carrier?: string | null }[]
  }[]
}

const WHY: Record<string, string> = {
  dispatched: "Some or all of it has shipped.",
  complete: "Print Trail has finished it.",
  partial: "Print Trail has finished it: some parcels shipped and some failed.",
}
const WHY_FALLBACK = "Print Trail had already dispatched some or all of it."
const NEXT = "Contact the customer, then refund the order or arrange a return as agreed."

export function cancelTooLateSubject(data: CancelTooLateData = {}): string {
  return `Order ${orderLabel(data.order)} was cancelled but has already shipped`.replace(/\s+/g, " ")
}

const fulfilmentsOf = (data: CancelTooLateData) => (Array.isArray(data.fulfilments) ? data.fulfilments : [])
const trackingOf = (f: NonNullable<CancelTooLateData["fulfilments"]>[0]) => (Array.isArray(f?.tracking) ? f.tracking : [])
const carrier = (c: string | null | undefined) => (c ? ` (${c})` : "")

export function cancelTooLateContent(data: CancelTooLateData = {}): EmailContent {
  const label = orderLabel(data.order)
  const why = WHY[data.why ?? ""] ?? WHY_FALLBACK
  const ptNumber = data.print_trail_order_number ? link(data.pt_url, data.print_trail_order_number) : ""

  const fulfilments = fulfilmentsOf(data)
    .map((f) => {
      const tracking = trackingOf(f)
        .map((t) => `<li>${link(t.url, t.number ?? "")}${t.carrier ? ` (${escapeHtml(t.carrier)})` : ""}</li>`)
        .join("")
      return `<li>${f.number ? `${escapeHtml(f.number)}: ` : ""}${escapeHtml(f.status)}${tracking ? `<ul>${tracking}</ul>` : " (no tracking)"}</li>`
    })
    .join("")

  const links = [
    isHttpUrl(data.admin_order_url) ? link(data.admin_order_url, "Order in Medusa admin") : "",
    isHttpUrl(data.pt_url) ? link(data.pt_url, "Order in Print Trail") : "",
  ].filter(Boolean)

  const html = wrap(
    [
      `<h2>Order ${escapeHtml(label)} was cancelled too late</h2>`,
      `<p>The order was cancelled in Medusa, but Print Trail can't stop it. ${escapeHtml(why)}</p>`,
      ptNumber ? `<p><strong>Print Trail order:</strong> ${ptNumber}</p>` : "",
      fulfilments ? `<p><strong>Fulfilments:</strong></p><ul>${fulfilments}</ul>` : "",
      `<p><strong>Next:</strong> ${escapeHtml(NEXT)}</p>`,
      links.length ? `<p>${links.join(" · ")}</p>` : "",
    ].join("")
  )

  const textFulfilments = fulfilmentsOf(data).flatMap((f) => {
    const tracking = trackingOf(f)
    const head = `- ${f.number ? `${f.number}: ` : ""}${f.status ?? ""}${tracking.length ? "" : " (no tracking)"}`
    return [head, ...tracking.map((t) => `  - ${textLink(t.url, t.number ?? "")}${carrier(t.carrier)}`)]
  })
  const text = [
    `Order ${label} was cancelled too late`,
    "",
    `The order was cancelled in Medusa, but Print Trail can't stop it. ${why}`,
    ...(data.print_trail_order_number ? ["", `Print Trail order: ${textLink(data.pt_url, data.print_trail_order_number)}`] : []),
    ...(textFulfilments.length ? ["", "Fulfilments:", ...textFulfilments] : []),
    "",
    `Next: ${NEXT}`,
    ...(isHttpUrl(data.admin_order_url) || isHttpUrl(data.pt_url) ? [""] : []),
    ...(isHttpUrl(data.admin_order_url) ? [`Order in Medusa admin: ${data.admin_order_url}`] : []),
    ...(isHttpUrl(data.pt_url) ? [`Order in Print Trail: ${data.pt_url}`] : []),
  ].join("\n")

  return { subject: cancelTooLateSubject(data), html, text }
}
