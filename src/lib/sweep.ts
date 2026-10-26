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
