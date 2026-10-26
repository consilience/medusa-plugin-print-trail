import type { PrintTrailPluginOptions } from "../../config"
import type { PtFulfilment } from "../../modules/printTrail/client/types"
import type { FulfilmentView, HealthView, OrderRowView, OrderView, ResendRefusal, SendInputDto, TimelineEntry } from "../admin-types"
import { printTrailAppUrl } from "../app-url"
import { printTrailOrderNumber } from "../order-number"
import { backOrderKind, hasStarted, waitsOnInactiveProduct } from "../pre-order"
import type { RetryAction } from "../retry"
import {
  attentionCode,
  DISMISSABLE_REMOTE_ATTENTION,
  FINAL_REMOTE_ATTENTION,
  readDismissed,
  snapshotAttentionKeys,
  writeDismissed,
} from "../sync-decisions"
import type { ConfirmOutcome, CreateOutcome, GateOutcome, PrintTrailOrderRow } from "../send-flow"

// The order widgets' view and the decisions behind Refresh, Resend and
// Dismiss. Free of Medusa: the routes load, these decide.

const TIMELINE_LIMIT = 100

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null)
const iso = (v: unknown): string | null => {
  const d = v ? new Date(v as string) : null
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null
}

export function fulfilmentRows(snapshot: unknown): FulfilmentView[] {
  if (!Array.isArray(snapshot)) return []
  return (snapshot as PtFulfilment[]).flatMap((f) => {
    if (!f || typeof f !== "object") return []
    const tracking = (Array.isArray(f.trackingDetails) ? f.trackingDetails : []).flatMap((t) => {
      const number = str(t?.trackingNumber) ?? str(t?.number)
      const url = str(t?.trackingUrl) ?? str(t?.url)
      if (!number && !url) return []
      return [{ number: number ?? "", url, carrier: str(t?.carrier) ?? str(t?.courier) }]
    })
    return [
      {
        uuid: String(f.uuid ?? ""),
        number: str(f.fulfilmentNumber),
        location: str(f.supplierLocation?.name) ?? str(f.supplierLocation?.code),
        productionMethod: str(f.productionMethod),
        status: String(f.status ?? ""),
        shippingMethod: str(f.requestedShippingMethod),
        tracking,
        back_order: backOrderKind(f),
        product_inactive: waitsOnInactiveProduct(f),
        publication_date: latestPublicationDate(f),
      },
    ]
  })
}

// The latest publication date among the fulfilment's lines (YYYY-MM-DD
// strings compare in order), or null.
function latestPublicationDate(f: PtFulfilment): string | null {
  const dates = (Array.isArray(f.orderLines) ? f.orderLines : [])
    .map((l) => str(l?.product?.publicationDate))
    .filter((d): d is string => !!d)
  return dates.length ? dates.reduce((a, b) => (b > a ? b : a)) : null
}

// Print Trail's cancel returns 200 only before any fulfilment starts: one
// handed to the warehouse (sentToWarehouseAt, API 1.3.0), or past draft
// for an older Print Trail API (hasStarted).
export function startedFulfilments(row: { [k: string]: unknown }): FulfilmentView[] {
  const snapshot = Array.isArray(row.fulfilments) ? (row.fulfilments as PtFulfilment[]) : []
  return fulfilmentRows(snapshot.filter((f) => !!f && typeof f === "object" && hasStarted(f)))
}

// Codes nothing clears on its own: an admin acknowledges them. Of Print
// Trail's own codes (pt-*), only the final ones (returned, partial, a
// returned or failed fulfilment) and a pre-order held on an inactive product
// (DISMISSABLE_REMOTE_ATTENTION); the rest are the sync's to clear. A capped
// retry is Resend's.
const DISMISSABLE = new Set([
  ...DISMISSABLE_REMOTE_ATTENTION,
  "dispatch-mismatch",
  "complete-manually",
  "cancel-too-late",
  "cancel-failed",
  "amend-refused",
  "amend-diverged",
  "amend-unsent-items",
  "refunded-not-cancelled",
  "return-before-dispatch",
  "no-pt-shipping-method",
  "dispatched-after-cancel",
  "reconcile-failed",
])

export function canDismiss(code: string | null | undefined): boolean {
  return !!code && DISMISSABLE.has(code)
}

// Compare and clear: null when the row no longer has that code. Resolving a
// final Print Trail code resolves every final state in the snapshot the admin
// was looking at: a returned order's parcels are returned too, and a partial
// order has a failed parcel, which would otherwise be raised next. They're
// added to what is already remembered, so the sync passes them over
// (pickRemote). A parcel that reaches a final state later is a new key, and
// is still raised.
export function dismissColumns(
  row: PrintTrailOrderRow,
  code: string
): { attention: null; dismissed_attention?: string | null } | null {
  if (!canDismiss(code) || row.attention !== code) return null
  // Remembered by its code: the completion step forgets it once the order
  // completes or there's nothing left to complete.
  if (code === "complete-manually") {
    return { attention: null, dismissed_attention: writeDismissed(row.pt_uuid, [...readDismissed(row), code]) }
  }
  if (!DISMISSABLE_REMOTE_ATTENTION.has(code)) return { attention: null }
  // A final code resolves every final state; the inactive-product code only
  // its own keys (the other parcels held on it).
  const group = FINAL_REMOTE_ATTENTION.has(code) ? FINAL_REMOTE_ATTENTION : new Set([code])
  const keys = snapshotAttentionKeys(row).filter((k) => group.has(attentionCode(k)))
  return { attention: null, dismissed_attention: writeDismissed(row.pt_uuid, [...readDismissed(row), ...keys]) }
}

export type RetryReset = { kind: "capped"; action: RetryAction } | { kind: "send-attempts" }

export type ResendPlan =
  | { kind: "send"; input: SendInputDto; reset: RetryReset | null }
  | { kind: "reissue"; input: SendInputDto }
  | { kind: "cancel" | "amend" | "refetch"; reset: RetryReset }
  | { kind: "refused"; reason: ResendRefusal }

const RETRY_ACTIONS: RetryAction[] = ["send", "confirm", "cancel", "amend", "refetch"]

const cappedAction = (attention: string | null | undefined): RetryAction | null => {
  const m = attention?.match(/^retry-cap:(.+)$/)
  return m && (RETRY_ACTIONS as string[]).includes(m[1]) ? (m[1] as RetryAction) : null
}

const cancelledAtPrintTrail = (row: PrintTrailOrderRow) => row.status === "cancelled" && !row.cancel_status

export function planResend(
  orderId: string,
  row: PrintTrailOrderRow | null,
  ctx: { asNew: boolean; orderCanceled: boolean; now: Date; reissued?: boolean }
): ResendPlan {
  const refused = (reason: ResendRefusal): ResendPlan => ({ kind: "refused", reason })
  if (!row) {
    return ctx.orderCanceled ? refused("order-canceled") : { kind: "send", input: { order_id: orderId }, reset: null }
  }
  if (ctx.asNew) {
    if (!cancelledAtPrintTrail(row)) return refused("not-cancelled-at-print-trail")
    if (ctx.orderCanceled) return refused("order-canceled")
    if (ctx.reissued) return refused("already-reissued")
    return { kind: "reissue", input: { order_id: orderId, reissue_of: row.sequence } }
  }
  const action = cappedAction(row.attention)
  if (action === "cancel") return { kind: "cancel", reset: { kind: "capped", action } }
  if (action === "refetch") return { kind: "refetch", reset: { kind: "capped", action } }
  if (action && row.cancel_status) return refused("cancelled-in-medusa")
  if (action && ctx.orderCanceled) return refused("order-canceled")
  if (action === "amend") return { kind: "amend", reset: { kind: "capped", action } }
  if (action) return { kind: "send", input: { order_id: orderId, sequence: row.sequence }, reset: { kind: "capped", action } }
  if (row.cancel_status) return refused("cancelled-in-medusa")
  if (ctx.orderCanceled) return refused("order-canceled")
  if (row.status === "cancelled") return refused("print-trail-cancelled")
  if (row.confirmed_at) return refused("already-confirmed")
  return { kind: "send", input: { order_id: orderId, sequence: row.sequence }, reset: { kind: "send-attempts" } }
}

// The columns a reset writes, worked out from the row as it is under the
// lock. null: the row no longer matches the plan (another run got there).
// Counts are reset to 0, never deleted: the service update merges JSON
// object columns, so a removed key would keep its old count.
export function resetColumns(row: PrintTrailOrderRow, reset: RetryReset, now: Date): Record<string, unknown> | null {
  const attempts = { ...(row.attempts ?? {}) }
  if (reset.kind === "send-attempts") {
    if (row.confirmed_at || row.cancel_status) return null
    if (!attempts.send && !attempts.confirm) return {}
    return { attempts: { ...attempts, send: 0, confirm: 0 } }
  }
  if (row.attention !== `retry-cap:${reset.action}`) return null
  const base = { attention: null, attempts: { ...attempts, [reset.action]: 0 } }
  switch (reset.action) {
    case "cancel":
      // As requestCancel leaves it: the cancel workflow runs it now.
      return { ...base, cancel_status: "requested", pending_action: "cancel", next_attempt_at: now }
    case "amend":
      return { ...base, pending_action: "amend", next_attempt_at: now }
    default:
      // Due now, as cancel and amend: if Resend's follow-up can't run (a
      // busy lock, a throw), the sweep picks it up rather than nothing.
      return { ...base, pending_action: reset.action, next_attempt_at: now }
  }
}

type ViewEvent = {
  id: string
  created_at: Date | string
  kind: string
  message: string
  print_trail_order_id?: string | null
  data?: Record<string, unknown> | null
}

const heldCount = (held: unknown) =>
  Array.isArray(held) ? held.reduce((n, h) => n + (Number((h as { quantity?: unknown })?.quantity) || 0), 0) : 0

const maxSequence = (rows: PrintTrailOrderRow[]) => rows.reduce((m, r) => Math.max(m, r.sequence), 0)

export function buildOrderView(input: {
  order: { id: string; display_id?: number | null; canceled: boolean; hasPtShippingMethod: boolean }
  rows: PrintTrailOrderRow[]
  events: ViewEvent[]
  options: PrintTrailPluginOptions
  teamCode: string | null
  health: HealthView
  now: Date
}): OrderView {
  const { order, options, teamCode, now } = input
  const rows = [...input.rows].sort((a, b) => a.sequence - b.sequence)
  const reissuedOf = new Set(rows.flatMap((r) => (r.source_ref?.startsWith("reissue:") ? [Number(r.source_ref.slice(8))] : [])))
  const linkOf = (r: PrintTrailOrderRow) => printTrailAppUrl(options, teamCode, r.pt_uuid)

  const rowViews: OrderRowView[] = rows.map((r) => {
    const fulfilments = fulfilmentRows(r.fulfilments)
    const started = startedFulfilments(r)
    const warn = !order.canceled && !r.cancel_status && r.status !== "cancelled" && started.length > 0
    const ctx = { orderCanceled: order.canceled, now, reissued: reissuedOf.has(r.sequence) }
    return {
      id: r.id,
      sequence: r.sequence,
      source_ref: r.source_ref ?? null,
      pt_order_number: r.pt_order_number,
      pt_uuid: r.pt_uuid ?? null,
      pt_url: linkOf(r),
      status: str(r.status),
      fulfillable_status: str(r.fulfillable_status),
      confirmed_at: iso(r.confirmed_at),
      block_reason: r.block_reason ?? null,
      last_error: str(r.last_error),
      attention: r.attention ?? null,
      pending_action: r.pending_action ?? null,
      next_attempt_at: iso(r.next_attempt_at),
      cancel_status: r.cancel_status ?? null,
      held_lines: heldCount(r.held_lines),
      fulfilments,
      cancel_warning: warn ? started : null,
      actions: {
        refresh: !!r.pt_uuid,
        resend: planResend(order.id, r, { ...ctx, asNew: false }).kind !== "refused",
        resend_as_new: planResend(order.id, r, { ...ctx, asNew: true }).kind === "reissue",
        dismiss: canDismiss(r.attention),
      },
    }
  })

  const byId = new Map(rows.map((r) => [r.id, r]))
  const timeline: TimelineEntry[] = [...input.events]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, TIMELINE_LIMIT)
    .map((e) => {
      const r = e.print_trail_order_id ? byId.get(e.print_trail_order_id) : undefined
      return {
        id: e.id,
        at: new Date(e.created_at).toISOString(),
        kind: e.kind,
        message: e.message,
        pt_order_number: r?.pt_order_number ?? null,
        pt_url: str(e.data?.pt_url) ?? (r ? linkOf(r) : null),
      }
    })

  let next: string | null = null
  try {
    next = printTrailOrderNumber(options.orderNumberPrefix, order.display_id, rows.length ? Math.max(2, maxSequence(rows) + 1) : 1)
  } catch {
    next = null
  }

  return {
    order_id: order.id,
    display_id: order.display_id ?? null,
    canceled: order.canceled,
    expected: rows.length === 0 && order.hasPtShippingMethod,
    rows: rowViews,
    timeline,
    health: input.health,
    next_pt_order_number: next,
  }
}

export type SendOutcome = {
  outcome: "confirmed" | "not-confirmed" | "blocked" | "retrying" | "held" | "not-sent"
  reason?: string
}

// What a Resend's send run actually did, for the admin's toast. The send
// workflow treats Print Trail refusals as results, so "done" alone says
// nothing.
export function sendOutcome(result: {
  create: Pick<CreateOutcome, "outcome" | "blockReason" | "cappedAction">
  gate: Pick<GateOutcome, "ok" | "reason">
  confirm: Pick<ConfirmOutcome, "outcome"> | null
}): SendOutcome {
  const { create, gate, confirm } = result
  if (confirm?.outcome === "confirmed" || create.outcome === "skip-confirmed" || create.outcome === "adopted-confirmed") {
    return { outcome: "confirmed" }
  }
  if (confirm?.outcome === "transient" || create.outcome === "transient") return { outcome: "retrying" }
  if (confirm?.outcome === "stock") return { outcome: "retrying", reason: "stock-shortfall" }
  if (confirm) {
    return { outcome: "blocked", reason: confirm.outcome === "shipping-unavailable" ? "shipping-method-unavailable" : confirm.outcome }
  }
  if (create.outcome === "held") return { outcome: "held" }
  if (create.outcome === "blocked") return { outcome: "blocked", reason: create.blockReason ?? "unknown" }
  // As the attention code, so the admin shows its "stopped retrying" label.
  if (create.outcome === "retry-capped") return { outcome: "blocked", reason: `retry-cap:${create.cappedAction ?? "send"}` }
  if (create.outcome === "no-lines") return { outcome: "not-sent", reason: "no-pt-lines" }
  if (create.outcome === "remote-cancelled" || create.outcome === "order-canceled" || create.outcome === "target-refused") {
    return { outcome: "not-sent", reason: gate.reason ?? create.outcome }
  }
  return { outcome: "not-confirmed", reason: (gate.reason ?? "unknown").replace(/^blocked:/, "") }
}
