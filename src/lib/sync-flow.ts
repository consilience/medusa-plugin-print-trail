import type { Logger } from "@medusajs/framework/types"
import { MedusaError } from "@medusajs/framework/utils"
import type { PrintTrailPluginOptions } from "../config"
import type { PrintTrailClient } from "../modules/printTrail/client/client"
import { PrintTrailApiError, type AccessRefusal } from "../modules/printTrail/client/errors"
import type { PtFulfilment, PtOrder } from "../modules/printTrail/client/types"
import { backOrderKind, markWaitingSkus, wasPreOrder } from "./pre-order"
import { normaliseSku } from "./sku"
import { printTrailAppUrl } from "./app-url"
import { settleCancel, type AdminNotifier, type CancelContext } from "./cancel-flow"
import { clearReconcileFailure } from "./reconcile"
import type { StateStore } from "./team-code"
import { ACCESS_ATTENTION, clearRetry, deferralFor, RETRY_CAPS, scheduleRetry, zeroAttempts } from "./retry"
import {
  adoptConfirmation,
  ADOPTED_MESSAGE,
  adoptedLines,
  snapshotFields,
  type PrintTrailEvent,
  type PrintTrailOrderRow,
} from "./send-flow"
import { confirmedAtPrintTrail } from "./send-decisions"
import {
  completionDecision,
  diffRemote,
  isSyncAttention,
  keepDismissed,
  nextAttention,
  pickRemote,
  readDismissed,
  remoteAttentionKeys,
  writeDismissed,
  OVERRIDING_ATTENTION,
  planDispatch,
  remoteAttention,
  type CreateDispatch,
  type DispatchOrder,
  type Label,
  type RemoteChange,
} from "./sync-decisions"

// The logic behind the syncPrintTrailOrder steps: re-fetch the Print Trail
// order and record it, create and ship Medusa fulfilments for what has
// dispatched, and complete the order. Free of the workflow SDK so it runs
// against the mock with an in-memory store and a fake Medusa port. Print
// Trail and Medusa refusals are results; only an unexpected store error throws.

export type SyncSource = "webhook" | "retry" | "reconcile" | "admin"

export type SyncStore = {
  listPrintTrailOrders(filters: Record<string, unknown>): Promise<PrintTrailOrderRow[]>
  updatePrintTrailOrders(data: Record<string, unknown>): Promise<PrintTrailOrderRow>
  createPrintTrailOrderEvents(data: Record<string, unknown>[]): Promise<unknown>
  listPrintTrailOrderEvents(filters: Record<string, unknown>): Promise<{ kind: string; data?: any }[]>
  // The activation scan's add-only record: a sync that sees a waiting
  // fulfilment marks its SKUs.
  markPreOrderSeen(skus: string[]): Promise<void>
}

// What sync needs from Medusa. The real adapter runs core-flows workflows.
export type MedusaOrderPort = {
  loadDispatchOrder(orderId: string): Promise<DispatchOrder | null>
  createFulfilment(orderId: string, c: CreateDispatch): Promise<{ id: string }>
  createShipment(
    orderId: string,
    fulfillmentId: string,
    items: { id: string; quantity: number }[],
    labels: Label[]
  ): Promise<void>
  // Then sends the tracking email for the added labels.
  addLabels(fulfillmentId: string, keep: { id: string }[], added: Label[]): Promise<void>
  completeOrder(orderId: string): Promise<void>
}

export type SyncContext = {
  store: SyncStore
  client: PrintTrailClient
  options: PrintTrailPluginOptions
  medusa: MedusaOrderPort
  teamCode: string | null
  // Where reconcile keeps its failure records; a clean sync clears the order's.
  state?: StateStore
  logger?: Pick<Logger, "warn">
  // For the "cancel too late" email when a fetch settles a Medusa cancel.
  // Without one, the note is still written and the email skipped.
  notifier?: AdminNotifier
  orderDisplayId?: (orderId: string) => Promise<number | string | null>
  now?: () => Date
}

export type RefetchOutcome = {
  rowId: string
  orderId: string
  outcome: "synced" | "transient" | "not-found" | AccessRefusal | "no-uuid" | "hint-mismatch" | "missing-row"
  pt: PtOrder | null
  changes: RemoteChange[]
  events: PrintTrailEvent[]
  detail?: string
}

export type DispatchOutcome = {
  created: string[]
  shipped: string[]
  trackingAdded: string[]
  failures: { ptFulfilment: string; detail: string }[]
  events: PrintTrailEvent[]
}

export type CompletionOutcome = { action: string; completed: boolean; events: PrintTrailEvent[] }

type Entry = { kind: string; message: string; data?: Record<string, unknown> }

const nowOf = (ctx: { now?: () => Date }) => (ctx.now ? ctx.now() : new Date())

const errorText = (e: unknown) =>
  e instanceof PrintTrailApiError ? e.detail : ((e as Error)?.message ?? String(e)).slice(0, 300)

async function getRow(store: SyncStore, rowId: string) {
  const [row] = await store.listPrintTrailOrders({ id: rowId })
  return row ?? null
}

async function writeEntries(store: SyncStore, row: PrintTrailOrderRow, entries: Entry[]) {
  if (entries.length) {
    await store.createPrintTrailOrderEvents(
      entries.map((e) => ({
        order_id: row.order_id,
        print_trail_order_id: row.id,
        kind: e.kind,
        message: e.message,
        data: e.data ?? null,
      }))
    )
  }
}

// True when the row's timeline already has an entry of this kind with this
// key, so a re-run of the same state writes nothing new.
async function recorded(store: SyncStore, rowId: string, kind: string, key: string) {
  const existing = await store.listPrintTrailOrderEvents({ print_trail_order_id: rowId, kind })
  return existing.some((e) => e.data?.key === key)
}

// A Medusa-side sync code replaces another sync code or nothing, never a send
// block or other non-sync attention.
// A Print Trail cancel or full edit keeps showing.
const localAttention = (current: string | null | undefined, code: string) =>
  !current || (isSyncAttention(current) && !OVERRIDING_ATTENTION.has(current)) ? code : current

const eventData = (row: PrintTrailOrderRow) => ({
  order_id: row.order_id,
  print_trail_order_id: row.id,
  pt_uuid: row.pt_uuid ?? null,
})

function describe(change: RemoteChange): Entry {
  switch (change.kind) {
    case "order-status":
      return { kind: "pt-status", message: `Print Trail status: ${change.from ?? "none"} → ${change.to}`, data: change }
    case "fulfillable-status":
      return {
        kind: "pt-fulfillable-status",
        message: `Print Trail fulfillable status: ${change.from ?? "none"} → ${change.to ?? "none"}`,
        data: change,
      }
    case "fulfilment-status": {
      const n = change.number ?? change.uuid
      const message = change.waiting && change.to === "back-order"
        ? `Print Trail fulfilment ${n} is waiting for the pre-order release`
        : change.released && change.to === "holding"
          ? `Print Trail fulfilment ${n} was released and is on hold at Print Trail: ${change.from ?? "new"} → ${change.to} (Print Trail may retry the warehouse send)`
          : change.released
          ? `Print Trail fulfilment ${n} was released: ${change.from ?? "new"} → ${change.to}`
          : `Print Trail fulfilment ${n}: ${change.from ?? "new"} → ${change.to}`
      return { kind: "pt-fulfilment-status", message, data: change }
    }
    case "back-order-reason": {
      const n = change.number ?? change.uuid
      return {
        kind: "pt-back-order-reason",
        message: change.from === "pre-order" && change.to === "out-of-stock"
          ? `Print Trail fulfilment ${n} is now out of stock (the product went live before its stock arrived)`
          : change.from === "out-of-stock" && change.to === "pre-order"
            ? `Print Trail fulfilment ${n} is waiting for the pre-order release again (its product is no longer active)`
            : `Print Trail fulfilment ${n} back-order: ${change.from} → ${change.to}`,
        data: change,
      }
    }
    case "tracking-added":
      return {
        kind: "pt-tracking",
        message: `Tracking for Print Trail fulfilment ${change.number ?? change.uuid}: ${change.tracking
          .map((t) => [t.carrier ?? t.courier, t.trackingNumber ?? t.number].filter(Boolean).join(" "))
          .join(", ")}`,
        data: change,
      }
    case "shipping-method":
      return {
        kind: "pt-shipping-method",
        message: `Print Trail changed the shipping method of fulfilment ${change.number ?? change.uuid}: ${change.from} → ${change.to}`,
        data: change,
      }
    case "errors":
      return {
        kind: "pt-errors",
        message: change.errors.length
          ? `Print Trail reports: ${change.errors.map((e) => e.message ?? e.code).join("; ")}`
          : "Print Trail no longer reports errors",
        data: change,
      }
  }
}

// A Print Trail cancel the admin answered with "Resend as a new Print
// Trail order" no longer needs attention, once that reissue has reached
// Print Trail (has a uuid: the condition recordOutcome clears it on). A
// reissue row that timed out, was blocked or capped answers nothing.
// A key an admin dismissed is passed over for the next one (pickRemote); the
// refetch forgets a dismissed key once Print Trail no longer calls for it.
async function remoteAttentionFor(
  store: Pick<SyncStore, "listPrintTrailOrders">,
  row: PrintTrailOrderRow,
  pt: PtOrder
): Promise<string | null> {
  const code = pickRemote(remoteAttentionKeys(row, pt), readDismissed(row))
  if (code !== "pt-cancelled") return code
  const reissues = await store.listPrintTrailOrders({ order_id: row.order_id, source_ref: `reissue:${row.sequence}` })
  return reissues.some((r) => !!r.pt_uuid) ? null : code
}

const COMPLETE_MANUALLY = "complete-manually"

const ATTENTION_MESSAGES: Record<string, string> = {
  "pt-cancelled": "Print Trail has cancelled this order; it won't be confirmed again",
  "pt-draft-after-confirm": "This order is back in draft at Print Trail (edited in the Print Trail app) after it was confirmed",
  "pt-fulfilment-cancelled": "Print Trail has cancelled part of this order",
  "pt-order-missing": "Print Trail can't find this order",
  "pt-returned": "Print Trail has this order as returned; nothing more will ship",
  "pt-pre-order-inactive":
    "A pre-order product on this order isn't active at Print Trail; Print Trail holds the order until the product is made active",
}

const attentionMessage = (code: string) =>
  ATTENTION_MESSAGES[code] ?? `Needs attention at Print Trail: ${code.replace(/^pt-/, "")}`

// attempts.refetch counts failed syncs (a failed GET, a Medusa refusal or a
// failed completion) and is reset only by a sync that finishes cleanly.
const REFETCH_RETRY_DELAY_MS = 60_000
// Bumped by every scheduleRefetch, so a lock holder can tell its own dispatch
// lease from a refetch someone asked for meanwhile.
const REQUESTS = "refetch_requests"
const requested = (row: PrintTrailOrderRow) => ({ ...(row.attempts ?? {}), [REQUESTS]: (row.attempts?.[REQUESTS] ?? 0) + 1 })

// The Locking Module's message when acquireLockStep gives up (in-memory and
// Redis providers, 2.17.2).
export const isLockTimeout = (e: unknown) => /failed to acquire lock/i.test((e as Error)?.message ?? "")

const refetchCapped = (row: PrintTrailOrderRow) => (row.attempts?.refetch ?? 0) > RETRY_CAPS.refetch

// Schedules a refetch retry (60/300/900 s, then stop). Never replaces a
// pending send, confirm, cancel or amend, and does nothing once capped
// (unless `reset`): returns false then.
// `counted: false` is for a lock timeout: another run is syncing the order
// right now, so a burst of webhooks mustn't use up a healthy order's retries.
// `mark` sets that key in attempts in the same write (a marker that a caller
// scheduled this row; every attempts write keeps the other keys).
// `reset` (with `counted: false` only; ignored otherwise) schedules a capped
// row too, its refetch count reset to 0 in the same write: a new sync cycle,
// as the send path's adoption starts one. A retry-cap:refetch attention is
// left to the refetch, whose sync replaces it.
export async function scheduleRefetch(
  store: SyncStore,
  rowId: string,
  now: Date,
  lastError?: string | null,
  opts: { counted?: boolean; dueAt?: Date; mark?: string; reset?: boolean } = {}
): Promise<boolean> {
  const reset = !!opts.reset && opts.counted === false
  const row = await getRow(store, rowId)
  if (!row || (row.pending_action && row.pending_action !== "refetch") || (refetchCapped(row) && !reset)) {
    return false
  }
  const marked = (attempts: Record<string, number>) => (opts.mark ? { ...attempts, [opts.mark]: 1 } : attempts)
  if (opts.counted === false) {
    const attempts = marked(requested(row))
    await store.updatePrintTrailOrders({
      id: row.id,
      pending_action: "refetch",
      next_attempt_at: opts.dueAt ?? new Date(now.getTime() + REFETCH_RETRY_DELAY_MS),
      attempts: reset ? zeroAttempts(attempts, ["refetch"]) : attempts,
      last_error: lastError ?? row.last_error ?? null,
    })
    return true
  }
  const next = scheduleRetry(row, "refetch", now)
  const update: Record<string, unknown> = {
    id: row.id,
    pending_action: next.pending_action,
    attempts: marked({ ...next.attempts, [REQUESTS]: requested(row)[REQUESTS] }),
    next_attempt_at: next.next_attempt_at,
    last_error: lastError ?? row.last_error ?? null,
  }
  if (next.attention) {
    update.attention = localAttention(row.attention, next.attention)
  }
  await store.updatePrintTrailOrders(update)
  if (next.attention) {
    await writeEntries(store, row, [
      { kind: "retry-capped", message: `Stopped retrying the Print Trail re-fetch after ${next.attempts.refetch} attempts` },
    ])
  }
  return true
}

// API 1.3.0: a product's status change moves held fulfilments with no order
// webhook, only stock-level-updated. Schedules a refetch (run by the sweep
// under the order lock) of each confirmed, unfinished row whose snapshot is
// stale for one of the SKUs:
// - active: a fulfilment waiting for release on it whose line doesn't say
//   active yet may have switched to out-of-stock (the product went live
//   before its stock);
// - held (pre-order or inactive): a back-order Print Trail holds on it
//   (waiting or out-of-stock) whose line's activeState isn't that status. An
//   out-of-stock one is now pre-order again (no order webhook says so), and a
//   waiting one's product was set inactive or back. Once refetched, the
//   snapshot says so, and the next event for the SKU finds nothing.
// Not counted against the refetch cap (nothing failed), and due at once:
// the next sweep runs it. One query for both. Returns the scheduled row ids.
const WAITING_STATUSES = ["queued", "scheduled", "processing", "back-order"]

export type WaitingTargets = { active?: string[]; held?: { sku: string; status: string }[] }

export async function scheduleWaitingRefetches(store: SyncStore, targets: WaitingTargets, now: Date): Promise<string[]> {
  const active = new Set((targets.active ?? []).map(normaliseSku).filter(Boolean))
  const held = new Map((targets.held ?? []).map((h) => [normaliseSku(h.sku), h.status] as const).filter(([k]) => k))
  if (!active.size && !held.size) return []
  const stale = (f: PtFulfilment) => {
    const kind = backOrderKind(f)
    if (kind !== "pre-order" && kind !== "out-of-stock") return false
    return (f.orderLines ?? []).some((l) => {
      // A line with no activeState can't be compared, and a refetch
      // wouldn't add one: never stale, or it would refetch on every event.
      const state = l.product?.activeState
      if (!state) return false
      const sku = normaliseSku(l.product?.sku ?? "")
      // A waiting fulfilment's other lines can already be active.
      if (kind === "pre-order" && active.has(sku) && state !== "active") return true
      const status = held.get(sku)
      return status !== undefined && state !== status
    })
  }
  const rows = await store.listPrintTrailOrders({ status: WAITING_STATUSES })
  const scheduled: string[] = []
  for (const row of rows) {
    // A row with any pending action (a send, confirm, cancel, amend or a
    // refetch already scheduled) is left alone: its own run re-reads the
    // order. scheduleRefetch re-reads the row and refuses a pending action
    // too; the window between that read and its write is unlocked (the
    // sweep's run takes the order lock), so a flow that sets one in between
    // can be overwritten. A cancel survives that (the sweep reads
    // cancel_status); an amend's intent is its pending_action, so it would
    // wait for the next order edit or a Resend. The window is one row's
    // read-then-write.
    if (!row.confirmed_at || row.pending_action) continue
    const fulfilments = Array.isArray(row.fulfilments) ? (row.fulfilments as PtFulfilment[]) : []
    if (fulfilments.some(stale) && (await scheduleRefetch(store, row.id, now, null, { counted: false, dueAt: now }))) {
      scheduled.push(row.id)
    }
  }
  return scheduled
}

// Statuses only a confirmed order reaches, after the waiting ones.
const FINISHED_STATUSES = ["complete", "partial", "returned", "failed"]
// Set in attempts on a row scheduleConfirmationRefetches has scheduled.
export const CONFIRM_REFETCH = "confirm_refetch"

// Before 1.0.2 the sync stored Print Trail's status for an order confirmed in
// the Print Trail app after the send blocked it, but not the confirmation, so
// the block stayed. Such an order may not change again (and send a webhook)
// for weeks. Schedules a refetch, run by the sweep, of each unconfirmed row
// with a block whose stored status says Print Trail confirmed it. The
// refetch records the confirmation (clearing the send block), after which
// the row isn't picked again. A stored draft or holding order may never have
// been confirmed (holding can come first); its next status change brings a
// webhook. A row with a pending action is left to it: a send or confirm
// retry adopts the confirmation itself. Not counted against the refetch cap
// (nothing failed), and a count capped earlier (webhooks that came while
// Print Trail couldn't be reached, say) is reset, as the send path's
// adoption resets it. Due at once. Returns the scheduled row ids.
//
// Once per row (CONFIRM_REFETCH, written with the schedule): a refetch that
// records no confirmation would otherwise leave the row to be scheduled on
// every sweep. That happens when Print Trail no longer has the order (404),
// or when it reads unconfirmed (an order confirmed before Print Trail
// recorded confirmedAt, with a back-order or finished status, reads null).
// A refetch that fails is retried as any refetch is (the row keeps
// pending_action refetch: 60/300/900 s, then capped with attention).
export async function scheduleConfirmationRefetches(store: SyncStore, now: Date): Promise<string[]> {
  const rows = await store.listPrintTrailOrders({ status: [...WAITING_STATUSES, ...FINISHED_STATUSES], confirmed_at: null })
  const scheduled: string[] = []
  for (const row of rows) {
    if (row.confirmed_at || !row.block_reason || !row.pt_uuid || row.pending_action || row.attempts?.[CONFIRM_REFETCH]) continue
    if (await scheduleRefetch(store, row.id, now, null, { counted: false, dueAt: now, mark: CONFIRM_REFETCH, reset: true })) {
      scheduled.push(row.id)
    }
  }
  return scheduled
}

// Ends a pending refetch that can't achieve anything (nothing to fetch, or
// Print Trail doesn't have it): no retry, count cleared.
async function endPendingRefetch(store: SyncStore, row: PrintTrailOrderRow, extra: Record<string, unknown> = {}) {
  if (row.pending_action === "refetch" || row.attempts?.refetch) {
    await store.updatePrintTrailOrders({ id: row.id, ...clearRetry(row, "refetch"), ...extra })
    return true
  }
  return false
}

export async function refetch(
  ctx: SyncContext,
  input: { rowId: string; source: SyncSource; ptUuidHint?: string; pt?: PtOrder; listedAt?: Date | string }
): Promise<RefetchOutcome> {
  const { store } = ctx
  const now = nowOf(ctx)
  const row = await getRow(store, input.rowId)
  if (!row) {
    return { rowId: input.rowId, orderId: "", outcome: "missing-row", pt: null, changes: [], events: [] }
  }
  const base = { rowId: row.id, orderId: row.order_id, pt: null, changes: [], events: [] as PrintTrailEvent[] }
  const hinted = !row.pt_uuid
  const uuid = row.pt_uuid ?? input.ptUuidHint ?? input.pt?.uuid
  if (!uuid) {
    if (await endPendingRefetch(store, row)) {
      await writeEntries(store, row, [
        { kind: "refetch-skipped", message: "No Print Trail order to re-fetch yet; the retry was dropped" },
      ])
    }
    return { ...base, outcome: "no-uuid" }
  }

  let pt = input.pt ?? null
  // A listed resource older than the last sync (a webhook got there first)
  // would roll the snapshot back: read the order again instead.
  if (pt && input.listedAt && row.last_synced_at && new Date(row.last_synced_at as string) > new Date(input.listedAt)) {
    pt = null
  }
  if (!pt) {
    try {
      pt = await ctx.client.getOrder(uuid)
    } catch (e) {
      if (!(e instanceof PrintTrailApiError)) {
        throw e
      }
      const deferral = deferralFor(e)
      if (deferral) {
        // Not counted: it runs once access returns (or the pause ends).
        await scheduleRefetch(store, row.id, now, e.detail, { counted: false, dueAt: new Date(now.getTime() + deferral.delayMs) })
        return { ...base, outcome: deferral.refusal ?? "transient", detail: e.detail }
      }
      if (e.status === 404) {
        await endPendingRefetch(store, row)
        if (!hinted && row.attention !== "pt-order-missing") {
          const attention = nextAttention(row.attention ?? null, "pt-order-missing")
          if (attention !== row.attention) {
            await store.updatePrintTrailOrders({ id: row.id, attention, last_error: e.detail })
          }
          await writeEntries(store, row, [
            { kind: "pt-order-missing", message: attentionMessage("pt-order-missing"), data: { pt_uuid: uuid } },
          ])
        }
        return { ...base, outcome: "not-found", detail: e.detail }
      }
      await scheduleRefetch(store, row.id, now, e.detail)
      return { ...base, outcome: "transient", detail: e.detail }
    }
  }
  // A hint (our own create whose uuid was never stored) is trusted only when
  // Print Trail's order carries our order number.
  if (hinted && pt.orderNumber !== row.pt_order_number) {
    await endPendingRefetch(store, row)
    return {
      ...base,
      outcome: "hint-mismatch",
      detail: `Print Trail order ${pt.uuid} is ${pt.orderNumber ?? "unnumbered"}, not ${row.pt_order_number}`,
    }
  }

  const changes = diffRemote(
    {
      status: row.status as string | null | undefined,
      fulfillable_status: row.fulfillable_status as string | null | undefined,
      fulfilments: row.fulfilments,
      errors: row.errors,
    },
    pt
  )
  // Confirmed at Print Trail but not here (confirmed in the Print Trail app
  // after the send was blocked, say): recorded as the send path records an
  // order it finds confirmed, clearing the send block it outdates. The
  // remote attention below is then read as for a confirmed order.
  const adoption =
    !row.confirmed_at && confirmedAtPrintTrail(pt)
      ? await adoptConfirmation(store, row, pt, now, { orderCanceled: !!(await medusaOrderCanceled(ctx, row.order_id)) })
      : null
  const basis = adoption ? ({ ...row, ...adoption.columns } as PrintTrailOrderRow) : row
  // Print Trail answered, so a refusal recorded on the row (a send, cancel
  // or edit waiting on access) is over, whatever settles the row next.
  const current = basis.attention && ACCESS_ATTENTION.has(basis.attention) ? null : (basis.attention ?? null)
  const attention = nextAttention(current, await remoteAttentionFor(store, basis, pt))
  // An adopted row records the lines Print Trail has when it stored none (its
  // create response was lost), as the send path's adoption does.
  const update: Record<string, unknown> = {
    id: row.id,
    ...snapshotFields(pt, now, row),
    ...(adoption ? { ...adoptedLines(row, pt), ...adoption.columns } : {}),
    attention,
  }
  const dismissed = writeDismissed(pt.uuid, keepDismissed(readDismissed(row), remoteAttentionKeys(basis, pt)))
  if (dismissed !== (row.dismissed_attention ?? null)) {
    update.dismissed_attention = dismissed
  }
  // The attempt count stays until the whole sync has finished cleanly
  // (complete() resets it), so a refusal further on still reaches the cap.
  // A send or confirm retry ends with the adoption: this sync records the
  // order (the send path, adopting, turns its lease into a sync). Left, the
  // sweep would run it on every pass, and a refetch couldn't be scheduled.
  // The adoption decides from the row as stored now, not as read before the
  // GET: a cancel is written outside the lock, and one that landed meanwhile
  // is kept. A refetch is ended, as without an adoption, only when this run
  // was one.
  const stored = adoption?.pendingAction
  const ends = adoption
    ? stored === "send" || stored === "confirm" || (stored === "refetch" && row.pending_action === "refetch")
    : row.pending_action === "refetch"
  if (ends) {
    Object.assign(update, { pending_action: null, next_attempt_at: null })
  }
  await store.updatePrintTrailOrders(update)
  // Logged, not thrown: the snapshot is already stored, and reconcile is the
  // activation scan's backstop.
  await markWaitingSkus(store, pt).catch((e) =>
    ctx.logger?.warn(`Print Trail: couldn't record pre-order SKUs for order ${row.order_id}: ${(e as Error)?.message ?? e}`)
  )

  const ptUrl = printTrailAppUrl(ctx.options, ctx.teamCode, pt.uuid)
  const stamp = (e: Entry): Entry => ({ ...e, data: { pt_url: ptUrl, pt_uuid: pt!.uuid, ...e.data } })
  const entries = changes.map(describe)
  if (adoption) {
    entries.push({ kind: "adopted", message: ADOPTED_MESSAGE }, ...adoption.entries)
  }
  const attentionChanged = attention !== (row.attention ?? null)
  if (attentionChanged && attention?.startsWith("pt-")) {
    entries.push({ kind: attention, message: attentionMessage(attention) })
  }
  const synced = { ...row, ...update } as PrintTrailOrderRow
  await writeEntries(store, row, entries.map(stamp))

  const events: PrintTrailEvent[] = []
  // A cancel Medusa asked for: the fetched order may settle it (cancelled
  // after a 202) or show it came too late.
  if (synced.cancel_requested) {
    events.push(...(await settleCancel(await cancelContext(ctx, synced), synced, pt)))
  }
  if (changes.some((c) => c.kind === "order-status" && c.to === "cancelled")) {
    events.push({
      name: "print_trail.order.cancelled",
      data: { ...eventData(synced), initiated_by: row.cancel_requested ? "medusa" : "print-trail" },
    })
  }
  if (attentionChanged && attention && isSyncAttention(attention)) {
    events.push({ name: "print_trail.order.attention", data: { ...eventData(synced), attention } })
  }
  // A full refund's block the adoption turned into attention, as the send
  // path announces it.
  if (adoption?.raised && attention === adoption.raised) {
    events.push({ name: "print_trail.order.attention", data: { ...eventData(synced), attention } })
  }
  return { ...base, outcome: "synced", pt, changes, events }
}

// Whether the Medusa order is cancelled; undefined when it can't be read.
function medusaOrderCanceled(ctx: SyncContext, orderId: string): Promise<boolean | undefined> {
  return ctx.medusa
    .loadDispatchOrder(orderId)
    .then((o) => (o ? !!o.canceled_at || o.status === "canceled" : undefined))
    .catch(() => undefined)
}

async function cancelContext(ctx: SyncContext, row: PrintTrailOrderRow): Promise<CancelContext> {
  const warn = (m: string) => ctx.logger?.warn(m)
  return {
    store: ctx.store,
    client: ctx.client,
    options: ctx.options,
    teamCode: ctx.teamCode,
    notifier: ctx.notifier ?? {
      async notify() {
        throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "no notification module available")
      },
    },
    logger: { warn, info: () => {} } as unknown as CancelContext["logger"],
    order: { id: row.order_id, display_id: ctx.orderDisplayId ? await ctx.orderDisplayId(row.order_id) : null },
    orderCanceled: await medusaOrderCanceled(ctx, row.order_id),
    now: ctx.now,
  }
}

export async function dispatch(ctx: SyncContext, r: RefetchOutcome): Promise<DispatchOutcome> {
  const out: DispatchOutcome = { created: [], shipped: [], trackingAdded: [], failures: [], events: [] }
  if (!r.pt || r.outcome !== "synced") {
    return out
  }
  const { store, medusa } = ctx
  const row = await getRow(store, r.rowId)
  const order = row ? await medusa.loadDispatchOrder(row.order_id) : null
  if (!row || !order) {
    return out
  }
  const pt = r.pt
  const plan = planDispatch(pt, order, row)
  const ptUrl = printTrailAppUrl(ctx.options, ctx.teamCode, pt.uuid)
  const entries: Entry[] = []
  let attention = row.attention ?? null

  // A lease before any Medusa write, so a run that dies half-way is picked up
  // by the sweep. Never over another pending action.
  const work = plan.create.length + plan.ship.length + plan.addTracking.length
  const leased = work > 0 && !row.pending_action && !refetchCapped(row)
  const lease = { next_attempt_at: new Date(nowOf(ctx).getTime() + 60_000), requests: row.attempts?.[REQUESTS] ?? 0 }
  if (leased) {
    await store.updatePrintTrailOrders({ id: row.id, pending_action: "refetch", next_attempt_at: lease.next_attempt_at })
  }

  // A cancel Medusa asked for is reported by settleCancel (cancel-flow.ts),
  // unless it ended failed or refused: then nothing else notes the dispatch.
  const cancelSettled = row.cancel_status === "failed" || row.cancel_status === "refused"
  if (plan.orderCanceled && (!row.cancel_requested || cancelSettled)) {
    const dispatched = (pt.fulfilments ?? []).filter((f) => f.status === "dispatched")
    const key = dispatched.map((f) => f.uuid).sort().join(",")
    if (dispatched.length && !(await recorded(store, row.id, "dispatched-after-cancel", key))) {
      entries.push({
        kind: "dispatched-after-cancel",
        message: `Print Trail dispatched ${dispatched.map((f) => f.fulfilmentNumber ?? f.uuid).join(", ")} after this order was cancelled in Medusa`,
        data: { key, fulfilments: dispatched.map((f) => ({ uuid: f.uuid, number: f.fulfilmentNumber ?? null, tracking: f.trackingDetails ?? [] })) },
      })
      attention = localAttention(attention, "dispatched-after-cancel")
    }
  }

  const fail = async (ptFulfilment: string, e: unknown) => {
    const detail = errorText(e)
    out.failures.push({ ptFulfilment, detail })
    const key = `${ptFulfilment}:${detail}`
    if (!(await recorded(store, row.id, "dispatch-failed", key))) {
      entries.push({
        kind: "dispatch-failed",
        message: `Medusa refused the fulfilment for Print Trail parcel ${ptFulfilment}: ${detail}`,
        data: { key, pt_fulfilment_uuid: ptFulfilment, detail },
      })
    }
    attention = localAttention(attention, "medusa-fulfilment-failed")
  }
  const dispatchedEvent = (ptFulfilment: string, fulfillmentId: string) =>
    out.events.push({
      name: "print_trail.order.dispatched",
      // was_pre_order: the parcel waited for its pre-order release.
      data: { ...eventData(row), pt_fulfilment_uuid: ptFulfilment, fulfillment_id: fulfillmentId, was_pre_order: wasPreOrder(row, ptFulfilment) },
    })

  for (const c of plan.create) {
    let id: string
    try {
      id = (await medusa.createFulfilment(row.order_id, c)).id
    } catch (e) {
      await fail(c.ptFulfilmentUuid, e)
      continue
    }
    out.created.push(id)
    try {
      await medusa.createShipment(row.order_id, id, c.items, c.labels)
    } catch (e) {
      // The next sync finds the fulfilment by its metadata and ships it.
      await fail(c.ptFulfilmentUuid, e)
      continue
    }
    out.shipped.push(id)
    entries.push({
      kind: "medusa-shipped",
      message: `Shipped Print Trail parcel ${c.ptFulfilmentNumber ?? c.ptFulfilmentUuid}${c.labels.length ? ` (${c.labels.map((l) => l.tracking_number).filter(Boolean).join(", ")})` : ""}`,
      data: { pt_fulfilment_uuid: c.ptFulfilmentUuid, fulfillment_id: id },
    })
    dispatchedEvent(c.ptFulfilmentUuid, id)
  }

  for (const s of plan.ship) {
    const ptFulfilment = String(order.fulfillments.find((f) => f.id === s.fulfillmentId)?.metadata?.print_trail_fulfilment_uuid ?? s.fulfillmentId)
    try {
      await medusa.createShipment(row.order_id, s.fulfillmentId, s.items, s.labels)
    } catch (e) {
      await fail(ptFulfilment, e)
      continue
    }
    out.shipped.push(s.fulfillmentId)
    entries.push({
      kind: "medusa-shipped",
      message: `Shipped Print Trail parcel ${ptFulfilment}`,
      data: { pt_fulfilment_uuid: ptFulfilment, fulfillment_id: s.fulfillmentId },
    })
    dispatchedEvent(ptFulfilment, s.fulfillmentId)
  }

  for (const t of plan.addTracking) {
    try {
      await medusa.addLabels(t.fulfillmentId, t.keep, t.added)
    } catch (e) {
      await fail(t.fulfillmentId, e)
      continue
    }
    out.trackingAdded.push(t.fulfillmentId)
  }

  if (plan.mismatches.length) {
    const key = JSON.stringify(plan.mismatches)
    if (!(await recorded(store, row.id, "dispatch-mismatch", key))) {
      entries.push({
        kind: "dispatch-mismatch",
        message: `Print Trail dispatched lines Medusa can't fulfil: ${plan.mismatches
          .map((m) => `${m.lineNumber ?? "?"} (${m.reason})`)
          .join(", ")}`,
        data: { key, mismatches: plan.mismatches },
      })
    }
    attention = localAttention(attention, "dispatch-mismatch")
  }

  // A run with nothing refused clears an earlier refusal.
  if (!out.failures.length && attention === "medusa-fulfilment-failed") {
    attention = nextAttention(null, await remoteAttentionFor(store, row, pt))
  }
  if (attention !== (row.attention ?? null)) {
    await store.updatePrintTrailOrders({ id: row.id, attention })
    if (attention && isSyncAttention(attention)) {
      out.events.push({ name: "print_trail.order.attention", data: { ...eventData(row), attention } })
    }
  }
  await writeEntries(
    store,
    row,
    entries.map((e) => ({ ...e, data: { pt_url: ptUrl, pt_uuid: pt.uuid, ...e.data } }))
  )
  // "Dispatched" is final at Print Trail, so no webhook may follow: retry a
  // refusal ourselves.
  if (out.failures.length) {
    await scheduleRefetch(store, row.id, nowOf(ctx), out.failures[0].detail)
  } else if (leased) {
    // Clear only our own lease: a refetch scheduled meanwhile (a webhook that
    // timed out on the lock) changed the count or the time, and may carry a
    // change this run's GET predates.
    const now = await getRow(store, row.id)
    const ours =
      now?.pending_action === "refetch" &&
      (now.attempts?.[REQUESTS] ?? 0) === lease.requests &&
      new Date(now.next_attempt_at as string).getTime() === lease.next_attempt_at.getTime()
    if (ours) {
      await store.updatePrintTrailOrders({ id: row.id, pending_action: null, next_attempt_at: null })
    }
  }
  return out
}

export async function complete(ctx: SyncContext, r: RefetchOutcome, d: DispatchOutcome): Promise<CompletionOutcome> {
  const result = await completeOrder(ctx, r, d)
  if (r.outcome === "synced" && !d.failures.length && !result.failed) {
    // A clean sync: the retry count starts again. A refetch someone asked for
    // meanwhile keeps its count.
    const row = await getRow(ctx.store, r.rowId)
    if (row?.attempts?.refetch && row.pending_action !== "refetch") {
      await ctx.store.updatePrintTrailOrders({ id: row.id, attempts: clearRetry(row, "refetch").attempts, last_error: null })
    }
    if (ctx.state && r.pt) {
      // Housekeeping only: never fail the sync over it.
      try {
        await clearReconcileFailure(ctx.state, r.pt.uuid)
      } catch (e) {
        ctx.logger?.warn(`Print Trail: couldn't clear the reconcile record of ${r.pt.uuid}: ${(e as Error).message}`)
      }
    }
  }
  delete result.failed
  return result
}

async function completeOrder(
  ctx: SyncContext,
  r: RefetchOutcome,
  d: DispatchOutcome
): Promise<CompletionOutcome & { failed?: boolean }> {
  const none: CompletionOutcome = { action: "none", completed: false, events: [] }
  if (!r.pt || r.outcome !== "synced") {
    return none
  }
  // Never complete while a parcel has no shipped Medusa fulfilment.
  if (d.failures.length) {
    return { ...none, action: "wait" }
  }
  const { store, medusa } = ctx
  const row = await getRow(store, r.rowId)
  const order = row ? await medusa.loadDispatchOrder(row.order_id) : null
  if (!row || !order) {
    return none
  }
  // Nothing left for the plugin to complete: an earlier refusal no longer
  // needs attention.
  const settled = ["completed", "canceled", "archived"].includes(order.status ?? "")
  if (row.attention === "medusa-complete-failed" && (settled || !ctx.options.autoComplete)) {
    await store.updatePrintTrailOrders({ id: row.id, attention: nextAttention(null, await remoteAttentionFor(store, row, r.pt)) })
    return none
  }
  // Every dispatched Print Trail line needs its shipped Medusa fulfilment.
  const pending = planDispatch(r.pt, order, row)
  if (pending.create.length || pending.ship.length) {
    return { ...none, action: "wait" }
  }
  const rows = await store.listPrintTrailOrders({ order_id: row.order_id })
  if (rows.some((x) => x.attention === "dispatch-mismatch" || x.attention === "medusa-fulfilment-failed")) {
    return { ...none, action: "blocked" }
  }
  const decision = completionDecision({
    autoComplete: ctx.options.autoComplete,
    orderStatus: order.status,
    orderItems: order.items,
    rows,
  })
  const ptUrl = printTrailAppUrl(ctx.options, ctx.teamCode, r.pt.uuid)
  const data = { pt_url: ptUrl, pt_uuid: r.pt.uuid }

  // A complete-manually an admin dismissed isn't raised again while
  // completion still calls for it; it's forgotten once the order completes
  // or there's nothing left to complete. A wait (a parcel not yet
  // dispatched) keeps it.
  const dismissed = readDismissed(row)
  const manualDismissed = dismissed.includes(COMPLETE_MANUALLY)
  if (manualDismissed && (decision.action === "complete" || decision.action === "none")) {
    await store.updatePrintTrailOrders({
      id: row.id,
      dismissed_attention: writeDismissed(row.pt_uuid, dismissed.filter((k) => k !== COMPLETE_MANUALLY)),
    })
  }

  if (decision.action === "complete") {
    try {
      await medusa.completeOrder(row.order_id)
    } catch (e) {
      const detail = errorText(e)
      // Its own code: dispatch clears medusa-fulfilment-failed, which would
      // make this flap on every retry.
      const attention = localAttention(row.attention, "medusa-complete-failed")
      if (!(await recorded(store, row.id, "complete-failed", detail))) {
        await writeEntries(store, row, [
          { kind: "complete-failed", message: `Medusa refused to complete the order: ${detail}`, data: { ...data, key: detail } },
        ])
      }
      const events: PrintTrailEvent[] = []
      if (attention !== row.attention) {
        await store.updatePrintTrailOrders({ id: row.id, attention })
        events.push({ name: "print_trail.order.attention", data: { ...eventData(row), attention } })
      }
      await scheduleRefetch(store, row.id, nowOf(ctx), detail)
      return { action: "complete", completed: false, events, failed: true }
    }
    await writeEntries(store, row, [
      { kind: "completed", message: "Every Print Trail line has dispatched; order completed", data },
    ])
    if (row.attention === "medusa-complete-failed") {
      await store.updatePrintTrailOrders({ id: row.id, attention: nextAttention(null, await remoteAttentionFor(store, row, r.pt)) })
    }
    return { action: "complete", completed: true, events: [] }
  }

  if (decision.action === "attention") {
    const events: PrintTrailEvent[] = []
    if (row.attention !== COMPLETE_MANUALLY && !manualDismissed) {
      const attention = localAttention(row.attention, COMPLETE_MANUALLY)
      if (!(await recorded(store, row.id, "complete-manually", decision.reason))) {
        await writeEntries(store, row, [
          {
            kind: "complete-manually",
            message:
              decision.reason === "other-items"
                ? "Print Trail has dispatched its lines; the order has other items, so complete it by hand"
                : "Print Trail hasn't dispatched every line; check the order and complete it by hand",
            data: { ...data, key: decision.reason },
          },
        ])
      }
      if (attention !== row.attention) {
        await store.updatePrintTrailOrders({ id: row.id, attention })
        events.push({ name: "print_trail.order.attention", data: { ...eventData(row), attention } })
      }
    }
    return { action: "attention", completed: false, events }
  }
  return { action: decision.action, completed: false, events: [] }
}

// One timeline entry on the original order for a copy made in the Print Trail
// app. The copy is never adopted, synced or flagged.
export async function recordCopySeen(
  ctx: Pick<SyncContext, "store" | "options" | "teamCode">,
  input: { rowId: string; orderId: string; copyUuid: string; copyOrderNumber: string }
): Promise<boolean> {
  const existing = await ctx.store.listPrintTrailOrderEvents({ print_trail_order_id: input.rowId, kind: "pt-copy" })
  if (existing.some((e) => e.data?.copy_uuid === input.copyUuid)) {
    return false
  }
  await ctx.store.createPrintTrailOrderEvents([
    {
      order_id: input.orderId,
      print_trail_order_id: input.rowId,
      kind: "pt-copy",
      message: `Print Trail order ${input.copyOrderNumber} is a copy of this order made in Print Trail. Medusa doesn't track the copy.`,
      data: { copy_uuid: input.copyUuid, pt_url: printTrailAppUrl(ctx.options, ctx.teamCode, input.copyUuid) },
    },
  ])
  return true
}

// A poison order reconcile skipped after failing several runs in a row.
export async function flagReconcileFailure(
  ctx: Pick<SyncContext, "store" | "options" | "teamCode">,
  input: { rowId: string; ptUuid: string; detail: string }
): Promise<void> {
  const row = await getRow(ctx.store, input.rowId)
  if (!row) return
  const attention = localAttention(row.attention, "reconcile-failed")
  if (attention !== row.attention) {
    await ctx.store.updatePrintTrailOrders({ id: row.id, attention, last_error: input.detail })
  }
  if (!(await recorded(ctx.store, row.id, "reconcile-failed", input.detail))) {
    await writeEntries(ctx.store, row, [
      {
        kind: "reconcile-failed",
        message: `Reconciling with Print Trail keeps failing for this order, so it was skipped: ${input.detail}`,
        data: { key: input.detail, pt_uuid: input.ptUuid, pt_url: printTrailAppUrl(ctx.options, ctx.teamCode, input.ptUuid) },
      },
    ])
  }
}

