import type { CreateNotificationDTO } from "@medusajs/framework/types"
import type { PrintTrailPluginOptions } from "../config"
import { PrintTrailApiError, type AccessRefusal } from "../modules/printTrail/client/errors"
import type { PtFulfilment, PtOrder } from "../modules/printTrail/client/types"
import { cancelTooLateContent } from "./email/cancel-too-late"

// What a Medusa cancel's PUT /orders/{uuid}/cancel (and the later fetches
// that settle a 202) mean for the row. Pure.

export type TooLateFulfilment = {
  uuid: string
  number: string | null
  status: string
  tracking: { number: string; url: string; carrier: string | null }[]
}

export type CancelDecision =
  | { kind: "cancelled" }
  | { kind: "awaiting" }
  | { kind: "already-cancelled" }
  | { kind: "too-late"; why: "dispatched" | "complete" | "partial"; fulfilments: TooLateFulfilment[] }
  | { kind: "refused"; detail: string }
  | { kind: "not-found"; detail: string }
  | { kind: AccessRefusal }
  | { kind: "transient"; detail: string }

type Shape = Pick<PtOrder, "status" | "fulfilments">

function tooLateFulfilments(pt: Shape): TooLateFulfilment[] {
  return (pt.fulfilments ?? [])
    .filter((f) => f.status !== "cancelled")
    .map((f: PtFulfilment) => ({
      uuid: f.uuid,
      number: f.fulfilmentNumber ?? null,
      status: f.status,
      tracking: (f.trackingDetails ?? []).flatMap((t) => {
        const number = t.trackingNumber ?? t.number ?? null
        return number ? [{ number, url: t.trackingUrl ?? t.url ?? "", carrier: t.carrier ?? t.courier ?? null }] : []
      }),
    }))
}

// Goods Print Trail can no longer stop: a dispatched fulfilment, or a
// complete order.
export function tooLate(pt: Shape): Extract<CancelDecision, { kind: "too-late" }> | null {
  const fulfilments = pt.fulfilments ?? []
  const dispatched = fulfilments.some((f) => f.status === "dispatched")
  if (dispatched) {
    const cancelled = fulfilments.some((f) => f.status === "cancelled")
    return { kind: "too-late", why: cancelled ? "partial" : "dispatched", fulfilments: tooLateFulfilments(pt) }
  }
  if (pt.status === "complete") {
    return { kind: "too-late", why: "complete", fulfilments: tooLateFulfilments(pt) }
  }
  return null
}

// `current` is a fresh GET after a 428, else the row's snapshot.
export function interpretCancel(
  result: { status: 200 | 202; order: PtOrder } | PrintTrailApiError,
  current: Shape | null
): CancelDecision {
  if (!(result instanceof PrintTrailApiError)) {
    return result.status === 202 ? { kind: "awaiting" } : { kind: "cancelled" }
  }
  if (result.isTransient) return { kind: "transient", detail: result.detail }
  const refusal = result.accessRefusal
  if (refusal) return { kind: refusal }
  if (result.status === 404) return { kind: "not-found", detail: result.detail }
  if (result.status !== 428) return { kind: "refused", detail: result.detail }
  if (!current) {
    return { kind: "refused", detail: `Print Trail can't cancel this order: ${result.detail}` }
  }
  if (current.status === "cancelled" && !(current.fulfilments ?? []).some((f) => f.status === "dispatched")) {
    return { kind: "already-cancelled" }
  }
  const late = tooLate(current)
  if (late) return late
  return { kind: "refused", detail: `Print Trail can't cancel this order: it is ${current.status}` }
}

// After a cancel the plugin asked for, what a fetched order settles: too late
// (something dispatched or the order completed), cancelled (a 202 that
// finished), or nothing yet.
export function settlement(
  row: { cancel_status?: string | null; cancel_requested?: boolean | null },
  pt: PtOrder
): { kind: "none" } | { kind: "cancelled" } | Extract<CancelDecision, { kind: "too-late" }> {
  if (!row.cancel_requested || !["requested", "awaiting", "cancelled"].includes(row.cancel_status ?? "")) {
    return { kind: "none" }
  }
  const late = tooLate(pt)
  if (late) return late
  if (row.cancel_status === "awaiting" && pt.status === "cancelled") return { kind: "cancelled" }
  return { kind: "none" }
}

// One email per admin address (Medusa's `to` is a single address), each
// with its own idempotency key so a provider retry can't send it twice.
export function buildCancelTooLateNotifications(input: {
  options: PrintTrailPluginOptions
  orderId: string
  displayId: number | string | null
  rowId: string
  ptOrderNumber: string
  ptUrl: string | null
  why: string
  fulfilments: TooLateFulfilment[]
}): CreateNotificationDTO[] {
  const template = input.options.notifications.cancelTooLate
  if (template === false) return []
  const data = {
    order: { id: input.orderId, display_id: input.displayId },
    print_trail_order_number: input.ptOrderNumber,
    pt_url: input.ptUrl,
    admin_order_url: input.options.adminUrl ? `${input.options.adminUrl}/orders/${input.orderId}` : null,
    why: input.why,
    fulfilments: input.fulfilments.map((f) => ({ number: f.number, status: f.status, tracking: f.tracking })),
  }
  // The plugin renders the email itself (content), so a provider without
  // templates sends it as is; a template-based provider can render its own
  // from template and data instead.
  const content = input.options.notifications.render === false ? null : cancelTooLateContent(data)
  return input.options.notifications.adminEmail.map((to) => ({
    to,
    channel: "email",
    template,
    data,
    ...(content ? { content } : {}),
    trigger_type: "print_trail.cancel_too_late",
    resource_type: "order",
    resource_id: input.orderId,
    idempotency_key: `print-trail-cancel-too-late:${input.rowId}:${to}`,
  }))
}
