import type { CreateNotificationDTO, Logger } from "@medusajs/framework/types"
import type { PrintTrailPluginOptions } from "../config"
import type { PrintTrailClient } from "../modules/printTrail/client/client"
import { ACCESS_REFUSED, PrintTrailApiError, type AccessRefusal } from "../modules/printTrail/client/errors"
import type { PtOrder } from "../modules/printTrail/client/types"
import { printTrailAppUrl } from "./app-url"
import {
  buildCancelTooLateNotifications,
  interpretCancel,
  settlement,
  tooLate,
  type CancelDecision,
} from "./cancel-decisions"
import { ACCESS_ATTENTION, clearRetry, deferralFor, deferRetry, refusalAttention, RETRY_CAPS, RETRY_DELAY_MS, scheduleRetry, zeroAttempts, type Deferral } from "./retry"
import { snapshotFields, type PrintTrailEvent, type PrintTrailOrderRow, type SendStore } from "./send-flow"
import { scheduleRefetch, type SyncStore } from "./sync-flow"

// The logic behind cancelPrintTrailOrder: carries a Medusa cancel to Print
// Trail, and the "cancel too late" note and admin email when Print Trail can
// no longer stop the goods. Free of the workflow SDK, as send-flow is.

export type AdminNotifier = { notify(n: CreateNotificationDTO[]): Promise<void> }

export type CancelContext = {
  store: SyncStore & Pick<SendStore, "listPrintTrailOrders">
  client: PrintTrailClient
  options: PrintTrailPluginOptions
  teamCode: string | null
  notifier: AdminNotifier
  logger: Pick<Logger, "warn" | "info">
  order: { id: string; display_id: number | string | null }
  // false: the Medusa order is live, so a row whose cancel settles (an
  // emptied draft's cancel) gets an amend scheduled to send any lines
  // re-added meanwhile. Unknown (undefined) schedules nothing.
  orderCanceled?: boolean
  now?: () => Date
}

export type CancelOutcome = {
  rowId: string
  decision: CancelDecision["kind"] | "not-sent" | "skipped"
  events: PrintTrailEvent[]
}

type Entry = { kind: string; message: string; data?: Record<string, unknown> }

const nowOf = (ctx: { now?: () => Date }) => (ctx.now ? ctx.now() : new Date())

// Provider errors may quote the recipient: never log an address.
const redact = (text: string) => text.replace(/[^\s@<>"']+@[^\s@<>"']+/g, "[email]")

// Attention a settled cancel makes moot: send-side problems and the refund
// badge. Print Trail and Medusa-side sync codes stay.
const settledByCancel = (attention: string | null | undefined) =>
  !!attention &&
  (attention === "stock-shortfall" ||
    attention === "refunded-not-cancelled" ||
    attention.startsWith("retry-cap:") ||
    ACCESS_ATTENTION.has(attention))

const eventData = (row: PrintTrailOrderRow) => ({
  order_id: row.order_id,
  print_trail_order_id: row.id,
  pt_uuid: row.pt_uuid ?? null,
})

async function getRow(store: SyncStore, rowId: string) {
  const [row] = await store.listPrintTrailOrders({ id: rowId })
  return row ?? null
}

async function writeEntries(ctx: CancelContext, row: PrintTrailOrderRow, entries: Entry[], uuid?: string | null) {
  if (!entries.length) return
  const ptUuid = uuid ?? row.pt_uuid ?? null
  const link = { pt_uuid: ptUuid, pt_url: printTrailAppUrl(ctx.options, ctx.teamCode, ptUuid) }
  await ctx.store.createPrintTrailOrderEvents(
    entries.map((e) => ({
      order_id: row.order_id,
      print_trail_order_id: row.id,
      kind: e.kind,
      message: e.message,
      data: { ...link, ...e.data },
    }))
  )
}

// Writes the cancel intent: before the lock, so a run that can't get it
// loses nothing (the sweep finds cancel_status "requested"). Rows that
// already carry a cancel_status are left alone. A pending send or confirm is
// dropped with its count.
export async function requestCancel(
  store: SyncStore,
  rows: PrintTrailOrderRow[],
  cause: "order-canceled" | "no-pt-lines",
  now: Date
): Promise<string[]> {
  const written: string[] = []
  for (const row of rows) {
    if (row.cancel_status) continue
    const attempts = { ...(row.attempts ?? {}) }
    zeroAttempts(attempts, ["send", "confirm"])
    await store.updatePrintTrailOrders({
      id: row.id,
      cancel_requested: true,
      cancel_status: "requested",
      pending_action: "cancel",
      next_attempt_at: now,
      attempts,
    })
    await store.createPrintTrailOrderEvents([
      {
        order_id: row.order_id,
        print_trail_order_id: row.id,
        kind: "cancel-requested",
        message:
          cause === "order-canceled"
            ? `The order was cancelled in Medusa; cancelling ${row.pt_order_number} at Print Trail`
            : `Every Print Trail item was removed; cancelling ${row.pt_order_number} at Print Trail`,
        data: { cause, pt_uuid: row.pt_uuid ?? null },
      },
    ])
    written.push(row.id)
  }
  return written
}

const describeFulfilments = (d: Extract<CancelDecision, { kind: "too-late" }>) =>
  d.fulfilments
    .map((f) => {
      const tracking = f.tracking.map((t) => t.number).join(", ")
      return `${f.number ?? f.uuid} ${f.status}${tracking ? `, tracking ${tracking}` : ""}`
    })
    .join("; ")

// The note, attention and admin email, once per row: cancel_notified_at (or
// an existing entry) means another path got there first. The email goes out
// last, and its failure never undoes the note.
export async function recordCancelTooLate(
  ctx: CancelContext,
  row: PrintTrailOrderRow,
  tooLate: Extract<CancelDecision, { kind: "too-late" }>
): Promise<{ recorded: boolean; events: PrintTrailEvent[] }> {
  const { store } = ctx
  // The row as stored, not the caller's copy: another path may have noted it.
  const fresh = await getRow(store, row.id)
  const existing = await store.listPrintTrailOrderEvents({ print_trail_order_id: row.id, kind: "cancel-too-late" })
  if (fresh?.cancel_notified_at || row.cancel_notified_at || existing.length) {
    return { recorded: false, events: [] }
  }
  const now = nowOf(ctx)
  await store.updatePrintTrailOrders({
    id: row.id,
    cancel_status: "too-late",
    cancel_notified_at: now,
    attention: "cancel-too-late",
    ...clearRetry(row, "cancel"),
  })
  const ptUrl = printTrailAppUrl(ctx.options, ctx.teamCode, row.pt_uuid)
  await writeEntries(ctx, row, [
    {
      kind: "cancel-too-late",
      message: `Medusa cancelled this order, but Print Trail can't stop ${row.pt_order_number}: ${describeFulfilments(tooLate) || tooLate.why}`,
      data: { why: tooLate.why, fulfilments: tooLate.fulfilments },
    },
  ])
  const events: PrintTrailEvent[] = [
    { name: "print_trail.order.attention", data: { ...eventData(row), attention: "cancel-too-late" } },
  ]
  if (ctx.options.notifications.cancelTooLate === false) {
    return { recorded: true, events }
  }
  if (!ctx.options.notifications.adminEmail.length) {
    ctx.logger.warn(`Print Trail: cancel too late for order ${row.order_id}, but notifications.adminEmail is not set`)
    return { recorded: true, events }
  }
  try {
    await ctx.notifier.notify(
      buildCancelTooLateNotifications({
        options: ctx.options,
        orderId: row.order_id,
        displayId: ctx.order.display_id,
        rowId: row.id,
        ptOrderNumber: row.pt_order_number,
        ptUrl,
        why: tooLate.why,
        fulfilments: tooLate.fulfilments,
      })
    )
  } catch (e) {
    ctx.logger.warn(
      `Print Trail: couldn't send the cancel-too-late email for order ${row.order_id}: ${redact((e as Error)?.message ?? String(e))}`
    )
  }
  return { recorded: true, events }
}

// After a cancel settles on a live order: an amend run, due now, that sends
// lines re-added during the cancel as a new "-n" order (amend-flow's
// remainder). Nothing to schedule for a Medusa-cancelled order.
const releaseFollowUp = (ctx: CancelContext, now: Date) =>
  ctx.orderCanceled === false ? { pending_action: "amend", next_attempt_at: now } : { pending_action: null, next_attempt_at: null }

// Runs the cancel of one row whose cancel_status is "requested". The lease
// counts the attempt up front (a run that dies still reaches the cap); the
// outcome takes it back, as the send path does.
export async function cancelRow(ctx: CancelContext, input: PrintTrailOrderRow): Promise<CancelOutcome> {
  const { store, client } = ctx
  const now = nowOf(ctx)
  const fresh = await getRow(store, input.id)
  if (!fresh || fresh.cancel_status !== "requested") {
    return { rowId: input.id, decision: "skipped", events: [] }
  }
  let row: PrintTrailOrderRow = fresh
  const prior = { attempts: { ...(row.attempts ?? {}) } }
  const out = (decision: CancelOutcome["decision"], events: PrintTrailEvent[] = []): CancelOutcome => ({
    rowId: row.id,
    decision,
    events,
  })

  const retryOrCap = async (detail: string): Promise<CancelOutcome> => {
    const next = scheduleRetry(prior, "cancel", now)
    if (next.attention) {
      await store.updatePrintTrailOrders({
        id: row.id,
        ...next,
        cancel_status: "failed",
        last_error: detail,
      })
      await writeEntries(ctx, row, [
        { kind: "cancel-failed", message: `Couldn't cancel ${row.pt_order_number} at Print Trail after ${next.attempts.cancel} attempts: ${detail}` },
      ])
      return out("transient", [{ name: "print_trail.order.attention", data: { ...eventData(row), attention: next.attention } }])
    }
    await store.updatePrintTrailOrders({ id: row.id, ...next, last_error: detail })
    return out("transient")
  }

  // Access refused, or the client's Retry-After pause: the cancel stays
  // requested and due, with no attempt counted, so a cancelled order is
  // still cancelled at Print Trail once access returns.
  const defer = async (d: Deferral, detail: string): Promise<CancelOutcome> => {
    const attention = refusalAttention(row.attention, d.refusal)
    await store.updatePrintTrailOrders({
      id: row.id,
      ...deferRetry(prior, "cancel", now, d.delayMs),
      last_error: detail,
      ...(attention ? { attention } : {}),
    })
    if (!attention || row.attention === attention) return out("transient")
    await writeEntries(ctx, row, [
      {
        kind: "cancel-waiting",
        message: `Couldn't cancel ${row.pt_order_number} at Print Trail: ${ACCESS_REFUSED[attention]}. It will be retried once access is restored.`,
      },
    ])
    return out("transient", [{ name: "print_trail.order.attention", data: { ...eventData(row), attention } }])
  }

  // Runs that died before recording count toward the cap.
  if ((prior.attempts.cancel ?? 0) >= RETRY_CAPS.cancel) {
    prior.attempts.cancel = RETRY_CAPS.cancel - 1
    return retryOrCap(row.last_error ? String(row.last_error) : "earlier attempts didn't finish")
  }
  await store.updatePrintTrailOrders({
    id: row.id,
    pending_action: "cancel",
    next_attempt_at: new Date(now.getTime() + RETRY_DELAY_MS),
    attempts: { ...prior.attempts, cancel: (prior.attempts.cancel ?? 0) + 1 },
  })

  const settle = async (update: Record<string, unknown>, entries: Entry[], uuid?: string | null) => {
    await store.updatePrintTrailOrders({
      id: row.id,
      ...update,
      attempts: clearRetry(prior, "cancel").attempts,
    })
    await writeEntries(ctx, row, entries, uuid)
  }

  const refuse = async (kind: "refused" | "not-found" | AccessRefusal, detail: string): Promise<CancelOutcome> => {
    await settle(
      { cancel_status: "refused", attention: "cancel-failed", pending_action: null, next_attempt_at: null, last_error: detail },
      [{ kind: "cancel-refused", message: `Print Trail didn't cancel ${row.pt_order_number}: ${detail}` }]
    )
    return out(kind, [{ name: "print_trail.order.attention", data: { ...eventData(row), attention: "cancel-failed" } }])
  }

  // 2. No uuid: a run may have posted the draft without storing it.
  if (!row.pt_uuid) {
    let found: PtOrder | null
    try {
      found = await client.findOrderByNumber(row.pt_order_number)
    } catch (e) {
      const d = deferralFor(e)
      if (d) return defer(d, (e as PrintTrailApiError).detail)
      if (e instanceof PrintTrailApiError && e.isTransient) return retryOrCap(e.detail)
      if (!(e instanceof PrintTrailApiError)) throw e
      return refuse(e.accessRefusal ?? "refused", e.detail)
    }
    if (!found) {
      await settle({ cancel_status: "not-sent", pending_action: null, next_attempt_at: null }, [
        { kind: "cancelled", message: "Nothing was sent to Print Trail, so there is nothing to cancel there" },
      ])
      return out("not-sent")
    }
    const fields = snapshotFields(found, now, row)
    await store.updatePrintTrailOrders({ id: row.id, ...fields })
    row = { ...row, ...fields }
  }

  const tooLateCancel = async (snapshot: PtOrder | null, decision: Extract<CancelDecision, { kind: "too-late" }>) => {
    await store.updatePrintTrailOrders({
      id: row.id,
      ...(snapshot ? snapshotFields(snapshot, now, row) : {}),
      attempts: clearRetry(prior, "cancel").attempts,
    })
    const latest = (await getRow(store, row.id)) ?? row
    const recorded = await recordCancelTooLate(ctx, latest, decision)
    if (!recorded.recorded) {
      // Another path noted it already; just settle this cancel.
      await store.updatePrintTrailOrders({ id: row.id, cancel_status: "too-late", pending_action: null, next_attempt_at: null })
    }
    return out("too-late", recorded.events)
  }

  const cancelled = async (pt: PtOrder | null, decision: "cancelled" | "already-cancelled") => {
    // A cancelled order with a dispatched fulfilment shipped in part: too
    // late, and the row keeps its lines.
    const late = tooLate(pt ?? { status: String(row.status ?? ""), fulfilments: (row.fulfilments ?? []) as never })
    if (late) return tooLateCancel(pt, late)
    await settle(
      {
        ...(pt ? snapshotFields(pt, now, row) : {}),
        cancel_status: "cancelled",
        ...releaseFollowUp(ctx, now),
        last_error: null,
        ...(settledByCancel(row.attention) ? { attention: null } : {}),
      },
      [{ kind: "cancelled", message: `Cancelled ${row.pt_order_number} at Print Trail` }]
    )
    return out(decision, [{ name: "print_trail.order.cancelled", data: { ...eventData(row), initiated_by: "medusa" } }])
  }

  // 3. Already cancelled at Print Trail, as far as the snapshot knows.
  if (row.status === "cancelled") {
    return cancelled(null, "cancelled")
  }

  // 4. Ask Print Trail.
  let result: { status: 200 | 202; order: PtOrder } | PrintTrailApiError
  try {
    result = await client.cancelOrder(row.pt_uuid!)
  } catch (e) {
    if (!(e instanceof PrintTrailApiError)) throw e
    result = e
  }
  const deferral = deferralFor(result)
  if (deferral) return defer(deferral, (result as PrintTrailApiError).detail)
  let current: PtOrder | null = null
  if (result instanceof PrintTrailApiError && result.status === 428) {
    try {
      current = await client.getOrder(row.pt_uuid!)
    } catch {
      current = null
    }
  }
  // A 428 says the order can't be cancelled, not why; without a fresh read
  // the snapshot may predate the dispatch, so try again rather than refuse.
  if (result instanceof PrintTrailApiError && result.status === 428 && !current) {
    return retryOrCap(`Print Trail refused the cancel and its order couldn't be read: ${result.detail}`)
  }
  const snapshot = current ?? (result instanceof PrintTrailApiError ? null : result.order)
  const decision = interpretCancel(
    result,
    current ?? { status: String(row.status ?? ""), fulfilments: (row.fulfilments ?? []) as never }
  )

  // 5. Apply.
  switch (decision.kind) {
    case "cancelled":
    case "already-cancelled":
      return cancelled(snapshot, decision.kind)
    case "awaiting": {
      await settle(
        { ...(snapshot ? snapshotFields(snapshot, now, row) : {}), cancel_status: "awaiting", pending_action: null, next_attempt_at: null },
        [{ kind: "cancel-awaiting", message: `Print Trail is cancelling ${row.pt_order_number}; waiting for it to finish` }]
      )
      // The webhook may be lost: re-fetch to settle it as well.
      await scheduleRefetch(store, row.id, now)
      return out("awaiting")
    }
    case "too-late":
      return tooLateCancel(snapshot, decision)
    case "transient":
      return retryOrCap(decision.detail)
    case "auth-failed":
      return refuse("auth-failed", ACCESS_REFUSED["auth-failed"])
    case "channel-inactive":
      return refuse("channel-inactive", ACCESS_REFUSED["channel-inactive"])
    case "not-found":
    case "refused":
      return refuse(decision.kind, decision.detail)
  }
}

// Run by sync after it stores a fetched order, for a row whose cancel Medusa
// asked for: a dispatch means too late; a 202 that finished means cancelled.
export async function settleCancel(ctx: CancelContext, row: PrintTrailOrderRow, pt: PtOrder): Promise<PrintTrailEvent[]> {
  const s = settlement(row, pt)
  if (s.kind === "too-late") {
    return (await recordCancelTooLate(ctx, row, s)).events
  }
  if (s.kind === "cancelled") {
    const fresh = (await getRow(ctx.store, row.id)) ?? row
    // A pending refetch or the like stays; only a free row gets the release.
    const release = releaseFollowUp(ctx, nowOf(ctx))
    const schedule = !fresh.pending_action && release.pending_action ? release : {}
    await ctx.store.updatePrintTrailOrders({ id: row.id, cancel_status: "cancelled", ...schedule })
    await writeEntries(ctx, row, [{ kind: "cancelled", message: `Print Trail confirmed the cancel of ${row.pt_order_number}` }], pt.uuid)
  }
  return []
}
