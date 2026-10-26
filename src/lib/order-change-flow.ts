import type { PrintTrailPluginOptions } from "../config"
import { printTrailAppUrl } from "./app-url"
import type { GraphOrder } from "./lines"
import { addressFingerprint, submittedQuantities } from "./order-scope"
import { buildShippingDetails } from "./payload"
import type { PrintTrailEvent, PrintTrailOrderRow, SendStore } from "./send-flow"
import { FINISHED_ORDER_STATUSES } from "./sync-decisions"
import type { SyncStore } from "./sync-flow"

// What the plugin does with Medusa-side changes that need no Print Trail
// call: address changes (a draft is re-sent), refunds and returns (timeline
// entries, and a full refund blocks a confirm). Free of the workflow SDK.

export type ChangeContext = {
  store: SyncStore & Pick<SendStore, "listPrintTrailOrders">
  options: PrintTrailPluginOptions
  teamCode: string | null
  now?: () => Date
}

export type ChangeOutcome = { resend: number[]; events: PrintTrailEvent[] }

export type RefundInfo = { id: string; amount: number; currency_code: string | null; created_at?: string | Date | null }

type Entry = { kind: string; message: string; data?: Record<string, unknown> }

const bySequence = (rows: PrintTrailOrderRow[]) => [...rows].sort((a, b) => a.sequence - b.sequence)

const attentionEvent = (row: PrintTrailOrderRow, attention: string): PrintTrailEvent => ({
  name: "print_trail.order.attention",
  data: { order_id: row.order_id, print_trail_order_id: row.id, pt_uuid: row.pt_uuid ?? null, attention },
})

async function write(ctx: ChangeContext, row: PrintTrailOrderRow, entry: Entry) {
  await ctx.store.createPrintTrailOrderEvents([
    {
      order_id: row.order_id,
      print_trail_order_id: row.id,
      kind: entry.kind,
      message: entry.message,
      data: { pt_uuid: row.pt_uuid ?? null, pt_url: printTrailAppUrl(ctx.options, ctx.teamCode, row.pt_uuid), ...entry.data },
    },
  ])
}

async function recordedValues(ctx: ChangeContext, rowId: string, kind: string, field: string) {
  const existing = await ctx.store.listPrintTrailOrderEvents({ print_trail_order_id: rowId, kind })
  return new Set(existing.map((e) => e.data?.[field]))
}

// order.updated carries no diff: compare the address fingerprint with the
// one last posted (contact details and the note don't count).
export async function recordAddressChange(
  ctx: ChangeContext,
  rows: PrintTrailOrderRow[],
  order: GraphOrder
): Promise<ChangeOutcome> {
  const out: ChangeOutcome = { resend: [], events: [] }
  const details = buildShippingDetails({
    shippingAddress: order.shipping_address,
    billingAddress: order.billing_address,
    email: order.email,
    note: typeof order.metadata?.note === "string" ? order.metadata.note : null,
  })
  // Below the minimum: the next send blocks it, as a first send does.
  if (!details.ok) return out
  const hash = addressFingerprint(details.shippingDetails)
  for (const row of bySequence(rows)) {
    if (!row.pt_uuid || row.cancel_status || row.address_hash === hash) continue
    if (!row.confirmed_at) {
      // The re-post stores the new hash.
      out.resend.push(row.sequence)
      continue
    }
    await ctx.store.updatePrintTrailOrders({ id: row.id, address_hash: hash })
    // A row from before address hashes: its first hash is just recorded.
    if (!row.address_hash) continue
    await write(ctx, row, {
      kind: "address-changed",
      message: `The delivery address changed in Medusa after Print Trail confirmed ${row.pt_order_number}. Change it in the Print Trail app.`,
    })
  }
  return out
}

const money = (amount: number, currency: string | null) => `${amount}${currency ? ` ${currency.toUpperCase()}` : ""}`

// payment.refunded: money only. Each refund is noted once, on the lowest
// sequence row. A full refund (refunded ≥ captured > 0) blocks rows not yet
// confirmed and flags confirmed ones that may still ship.
export async function recordRefunds(
  ctx: ChangeContext,
  rows: PrintTrailOrderRow[],
  // orderCanceled: Medusa's own cancel refunds captured payments, so a full
  // refund of a cancelled order is the cancel, not something to flag.
  input: { refunds: RefundInfo[]; captured: number; refunded: number; orderCanceled?: boolean }
): Promise<ChangeOutcome> {
  const out: ChangeOutcome = { resend: [], events: [] }
  const sorted = bySequence(rows)
  const first = sorted[0]
  if (!first) return out
  const seen = await recordedValues(ctx, first.id, "refund", "refund_id")
  for (const refund of input.refunds) {
    if (seen.has(refund.id)) continue
    seen.add(refund.id)
    await write(ctx, first, {
      kind: "refund",
      message: `A refund of ${money(refund.amount, refund.currency_code)} was recorded in Medusa. Print Trail isn't changed: cancel the order or edit items out to stop goods shipping.`,
      data: { refund_id: refund.id, amount: refund.amount, currency_code: refund.currency_code },
    })
  }
  if (input.orderCanceled || !(input.captured > 0 && input.refunded >= input.captured)) return out

  for (const row of sorted) {
    if (row.cancel_status) continue
    if (!row.confirmed_at) {
      if (row.block_reason === "fully-refunded") continue
      const ownsPending = !row.pending_action || row.pending_action === "send" || row.pending_action === "confirm"
      await ctx.store.updatePrintTrailOrders({
        id: row.id,
        block_reason: "fully-refunded",
        ...(ownsPending ? { pending_action: null, next_attempt_at: null } : {}),
      })
      await write(ctx, row, { kind: "not-confirmed", message: "Not confirmed: fully-refunded" })
      continue
    }
    // Finished at Print Trail: there is nothing left to cancel.
    if (FINISHED_ORDER_STATUSES.has(String(row.status ?? "")) || row.attention === "refunded-not-cancelled") continue
    const noted = await recordedValues(ctx, row.id, "refunded-not-cancelled", "kind")
    if (noted.size) continue
    await ctx.store.updatePrintTrailOrders({ id: row.id, attention: "refunded-not-cancelled" })
    await write(ctx, row, {
      kind: "refunded-not-cancelled",
      message: `The order was refunded in full in Medusa, but Print Trail may still ship ${row.pt_order_number}. Cancel the order to stop it.`,
      data: { kind: "refunded-not-cancelled" },
    })
    out.events.push(attentionEvent(row, "refunded-not-cancelled"))
  }
  return out
}

type SnapshotFulfilment = { status?: string; orderLines?: { lineNumber?: string | null }[] }

// order.return_requested: returns aren't sent to Print Trail. Medusa allows
// a return only of fulfilled quantity, and Print Trail lines are fulfilled
// at dispatch, so a return of a line Print Trail hasn't dispatched means it
// was fulfilled by hand: flagged.
export async function recordReturn(
  ctx: ChangeContext,
  rows: PrintTrailOrderRow[],
  input: { returnId: string; items: { item_id: string; quantity: number }[] }
): Promise<ChangeOutcome> {
  const out: ChangeOutcome = { resend: [], events: [] }
  const returned = new Set(input.items.filter((i) => i.quantity > 0).map((i) => i.item_id))
  for (const row of bySequence(rows)) {
    const sent = submittedQuantities({ submitted_lines: row.submitted_lines })
    const items = [...returned].filter((id) => sent.has(id))
    if (!items.length) continue
    if ((await recordedValues(ctx, row.id, "return-requested", "return_id")).has(input.returnId)) continue
    await write(ctx, row, {
      kind: "return-requested",
      message: "Return requested in Medusa; returns aren't sent to Print Trail.",
      data: { return_id: input.returnId, item_ids: items },
    })
    const fulfilments = (Array.isArray(row.fulfilments) ? row.fulfilments : []) as SnapshotFulfilment[]
    const undispatched = items.some((id) =>
      fulfilments.some((f) => f.status !== "dispatched" && (f.orderLines ?? []).some((l) => l.lineNumber === id))
    )
    if (undispatched && row.attention !== "return-before-dispatch") {
      await ctx.store.updatePrintTrailOrders({ id: row.id, attention: "return-before-dispatch" })
      out.events.push(attentionEvent(row, "return-before-dispatch"))
    }
  }
  return out
}
