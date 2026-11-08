// The sweep runs due retries and finds orders whose order.placed was lost
// (an in-memory event bus restart, or a crash before the subscriber ran).

const SETTLE_MS = 5 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

export function sweepWindow(now: Date, lookbackDays: number) {
  return {
    from: new Date(now.getTime() - lookbackDays * DAY_MS),
    // Leave the subscriber time to run before treating an order as missed.
    to: new Date(now.getTime() - SETTLE_MS),
  }
}

export type SweepOrder = {
  id: string
  created_at: Date | string
  canceled_at?: Date | string | null
  hasPrintTrailMethod: boolean
}

export function findOrdersMissingRows(
  orders: SweepOrder[],
  rowOrderIds: Set<string>,
  now: Date,
  lookbackDays: number
): string[] {
  const { from, to } = sweepWindow(now, lookbackDays)
  return orders
    .filter((o) => {
      const created = new Date(o.created_at)
      return (
        created >= from &&
        created <= to &&
        !o.canceled_at &&
        o.hasPrintTrailMethod &&
        !rowOrderIds.has(o.id)
      )
    })
    .map((o) => o.id)
}

type RetryRow = { pending_action?: string | null; next_attempt_at?: Date | string | null }

export function dueRows<T extends RetryRow>(rows: T[], now: Date): T[] {
  return rows.filter(
    (r) => !!r.pending_action && !!r.next_attempt_at && new Date(r.next_attempt_at) <= now
  )
}

// Orders with a Medusa cancel still to carry to Print Trail. Found by
// cancel_status, not pending_action, which a send may have rewritten.
// next_attempt_at holds a cancel back only when it is the cancel's own
// (pending_action "cancel"): another flow's lease never delays it.
export function dueCancels<
  T extends {
    cancel_status?: string | null
    next_attempt_at?: Date | string | null
    pending_action?: string | null
    order_id: string
  },
>(rows: T[], now: Date): string[] {
  const ids = rows
    .filter(
      (r) =>
        r.cancel_status === "requested" &&
        (r.pending_action !== "cancel" || !r.next_attempt_at || new Date(r.next_attempt_at) <= now)
    )
    .map((r) => r.order_id)
  return [...new Set(ids)]
}

// Cancelled orders whose order.canceled never reached the plugin: a row that
// reached Print Trail and was never asked to cancel.
export function ordersMissingCancel(
  orders: { id: string; canceled_at?: Date | string | null }[],
  rows: { order_id: string; cancel_requested?: boolean | null; pt_uuid?: string | null }[]
): string[] {
  const cancelled = new Set(orders.filter((o) => !!o.canceled_at).map((o) => o.id))
  const ids = rows.filter((r) => cancelled.has(r.order_id) && !!r.pt_uuid && !r.cancel_requested).map((r) => r.order_id)
  return [...new Set(ids)]
}

// Whether an order is recent enough to send for the first time from an event
// other than order.placed (a payment capture): the sweep's lookback.
export function withinLookback(createdAt: Date | string | null | undefined, now: Date, lookbackDays: number): boolean {
  return !!createdAt && new Date(createdAt) >= sweepWindow(now, lookbackDays).from
}

export const AWAITING_PAYMENT = "awaiting-payment"

type AwaitingRow = {
  order_id: string
  sequence: number
  block_reason?: string | null
  confirmed_at?: Date | string | null
  pending_action?: string | null
  cancel_status?: string | null
  cancel_requested?: boolean | null
  status?: string | null
}

// Rows the confirm gate held for a payment capture, to send again now that
// orders are confirmed when placed: an unpaid order has no capture to run
// it. The send's gate then decides, by the setting in force. placedSince:
// when the admin made the switch (the confirmOn record's placed_since); only
// orders placed before it, which the admin was asked to confirm, are picked.
// A switch in the plugin options records none, and those orders wait for
// their Resend as before. Only orders created within the lookback window:
// an old unpaid order isn't printed because a setting changed (its Resend
// sends it). Rows with a pending action, a cancel or a confirmation are left
// alone.
export function awaitingPaymentRows<T extends AwaitingRow>(
  rows: T[],
  orders: { id: string; created_at?: Date | string | null }[],
  now: Date,
  lookbackDays: number,
  placedSince: Date
): { order_id: string; sequence: number }[] {
  const recent = new Set(
    orders
      .filter((o) => withinLookback(o.created_at, now, lookbackDays) && new Date(o.created_at!) < placedSince)
      .map((o) => o.id)
  )
  return rows
    .filter(
      (r) =>
        r.block_reason === AWAITING_PAYMENT &&
        !r.confirmed_at &&
        !r.pending_action &&
        !r.cancel_status &&
        !r.cancel_requested &&
        r.status !== "cancelled" &&
        recent.has(r.order_id)
    )
    .map((r) => ({ order_id: r.order_id, sequence: r.sequence }))
}
