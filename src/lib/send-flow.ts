import type { PrintTrailPluginOptions } from "../config"
import type { PrintTrailClient } from "../modules/printTrail/client/client"
import { ACCESS_REFUSED, PrintTrailApiError } from "../modules/printTrail/client/errors"
import type { PtConfirmRequest, PtOrder, PtOrderLineInput } from "../modules/printTrail/client/types"
import { buildConfirmBody, evaluateGate } from "./gate"
import { orderOverLimits, OVER_LIMITS } from "./input-limits"
import { paymentTotals, type GraphOrder, type SelectedLine } from "./lines"
import { printTrailOrderNumber } from "./order-number"
import { markWaitingSkus, outOfStockSkus, rememberWaiting, waitingFulfilments } from "./pre-order"
import { FINISHED_ORDER_STATUSES, remoteAttention } from "./sync-decisions"
import { preparePayload, type PreparedPayload } from "./hooks"
import {
  ACCESS_ATTENTION,
  clearRetry,
  refusalAttention,
  deferralFor,
  deferRetry,
  lease,
  RETRY_CAPS,
  scheduleRetry,
  uncount,
  type Deferral,
  type RetryAction,
  zeroAttempts,
} from "./retry"
import { confirmedAtOf, decideCreate, interpretConfirmError } from "./send-decisions"

// The logic behind the sendOrderToPrintTrail steps, kept free of the workflow
// SDK so it can run against the mock with an in-memory store. Print Trail
// refusals are returned as outcomes; only unexpected errors throw.

export type PrintTrailOrderRow = {
  id: string
  order_id: string
  sequence: number
  pt_order_number: string
  pt_uuid?: string | null
  confirmed_at?: Date | string | null
  attempts?: Record<string, number> | null
  block_reason?: string | null
  attention?: string | null
  dismissed_attention?: string | null
  pending_action?: string | null
  source_ref?: string | null
  cancel_status?: CancelStatus | null
  cancel_requested?: boolean | null
  cancel_notified_at?: Date | string | null
  address_hash?: string | null
  held_lines?: { lineItemId: string; quantity: number }[] | null
  // Print Trail fulfilment uuids seen waiting for a pre-order release.
  pre_order_fulfilments?: string[] | null
  [k: string]: unknown
}

export type CancelStatus = "requested" | "awaiting" | "cancelled" | "too-late" | "refused" | "failed" | "not-sent"

export type SendStore = {
  listPrintTrailOrders(filters: Record<string, unknown>): Promise<PrintTrailOrderRow[]>
  createPrintTrailOrders(data: Record<string, unknown>): Promise<PrintTrailOrderRow>
  updatePrintTrailOrders(data: Record<string, unknown>): Promise<PrintTrailOrderRow>
  createPrintTrailOrderEvents(data: Record<string, unknown>[]): Promise<unknown>
  listPrintTrailOrderEvents(filters: Record<string, unknown>): Promise<{ kind: string; data?: any }[]>
  // Creates the row↔order link if it's missing (a run died between the row
  // insert and the link).
  ensureOrderLink(row: PrintTrailOrderRow): Promise<void>
  // The activation scan's add-only record (src/lib/pre-order.ts): a confirm
  // with a waiting fulfilment marks its SKUs.
  markPreOrderSeen(skus: string[]): Promise<void>
}

export type GateState = Pick<GraphOrder, "status" | "canceled_at" | "payment_collections">

export type SendContext = {
  store: SendStore
  client: PrintTrailClient
  options: PrintTrailPluginOptions
  // Re-reads the order's cancellation and payments just before the gate.
  reloadGateState?: (orderId: string) => Promise<GateState | null>
  now?: () => Date
}

export type CreateOutcome = {
  rowId: string | null
  outcome:
    | "draft"
    | "skip-confirmed"
    | "adopted-confirmed"
    | "remote-cancelled"
    | "blocked"
    | "transient"
    | "no-lines"
    | "retry-capped"
    | "order-canceled"
    | "held"
    | "target-refused"
  pt: PtOrder | null
  confirmedAt: string | null
  blockReason: string | null
  detail?: string
  posted: boolean
  sentLineNumbers: string[]
  methodByLine: Record<string, string>
  unmatchedSkus?: string[]
  // Attempts this run's leases counted, which the outcome step takes back.
  counted?: RetryAction[]
  cappedAction?: RetryAction
  // Set on "held" when this run created the held row (one timeline entry).
  heldNew?: boolean
  // Set on "adopted-confirmed" when adoption raised attention (a full refund
  // recorded before the confirm): its entry and event.
  raised?: string
  // Set on "transient" when the retry costs no attempt (deferralFor).
  deferral?: Deferral
}

export type GateOutcome = {
  ok: boolean
  reason?: string
  detail?: string
  body?: PtConfirmRequest
  notes?: string[]
}

export type ConfirmOutcome = {
  outcome:
    | "confirmed"
    | "stock"
    | "not-confirmable"
    | "shipping-unavailable"
    | "invalid"
    | "transient"
    | "rejected-403"
  pt: PtOrder | null
  detail?: string
  shortfall?: { sku: string; requested: number; available: number }[]
  // Set when the body was rebuilt; replaces the gate's notes.
  notes?: string[]
  // Set on "transient" when the retry costs no attempt (deferralFor).
  deferral?: Deferral
}

export type PrintTrailEvent = { name: string; data: Record<string, unknown> }

// The per-order send lock. Worst case per run: five Print Trail calls (get,
// create, find by number, confirm twice) at 67 s each (4 × 15 s timeouts + 7 s
// backoff), about 335 s. Under the 15-minute retry delay, so a crashed run's
// lock has expired before its lease is due.
export const SEND_LOCK_TTL_SECONDS = 600
export const SEND_LOCK_TIMEOUT_SECONDS = 30

// One Print Trail call at its worst: 4 × 15 s timeouts + 7 s backoff.
export const PT_CALL_SECONDS = 67
// How many rows a run may take to Print Trail inside the per-order lock's
// ttl (with a minute for everything else), at `callsPerRow` calls each. At
// least one, so every run makes progress; the rest stay scheduled.
export function rowsPerRun(ttlSeconds: number, callsPerRow: number, marginSeconds = 60): number {
  return Math.max(1, Math.floor((ttlSeconds - marginSeconds) / (callsPerRow * PT_CALL_SECONDS)))
}
// cancelRow: find by number, cancel, re-read after a 428.
export const CANCEL_CALLS_PER_ROW = 3
// amendRow: read, PUT, re-read; a PUT refused for no lines adds a cancel.
export const AMEND_CALLS_PER_ROW = 4

const nowOf = (ctx: SendContext) => (ctx.now ? ctx.now() : new Date())

// The parts of the Print Trail order kept on the row.
// With the row (as stored, for its record and its previous snapshot), also
// records the fulfilments waiting for a pre-order release (rememberWaiting):
// every path that stores a snapshot passes it.
export function snapshotFields(pt: PtOrder, now: Date, row?: { pre_order_fulfilments?: unknown; fulfilments?: unknown } | null) {
  return {
    pt_uuid: pt.uuid,
    print_trail_order_number: pt.printTrailOrderNumber ?? null,
    status: pt.status,
    fulfillable_status: pt.fulfillableStatus ?? null,
    fulfilments: (pt.fulfilments ?? []) as unknown as Record<string, unknown>,
    errors: (pt.errors ?? []) as unknown as Record<string, unknown>,
    last_synced_at: now,
    ...(row !== undefined ? rememberWaiting(row, pt) : {}),
  }
}

// A lease stands in for a pending send or confirm only; a pending cancel,
// amend or refetch belongs to another flow and is never overwritten. Every
// send-path write of pending_action/next_attempt_at checks it.
export const ownsPending = (row: Pick<PrintTrailOrderRow, "pending_action"> | null | undefined) =>
  !row?.pending_action || row.pending_action === "send" || row.pending_action === "confirm"

// Cancel and amend intent is written outside the lock, so the send path
// re-reads the row just before it writes a pending action.
async function ownsPendingNow(store: SendStore, rowId: string) {
  const [fresh] = await store.listPrintTrailOrders({ id: rowId })
  return ownsPending(fresh)
}

const isCanceled = (order: Pick<GraphOrder, "canceled_at" | "status">) =>
  !!order.canceled_at || order.status === "canceled"

// Lines filterLines held back: what was selected less what is being sent.
function heldLines(selected: SelectedLine[], lines: SelectedLine[]) {
  const sending = new Map<string, number>()
  for (const l of lines) sending.set(l.lineItemId, (sending.get(l.lineItemId) ?? 0) + l.quantity)
  const held: { lineItemId: string; quantity: number }[] = []
  for (const l of selected) {
    const quantity = l.quantity - (sending.get(l.lineItemId) ?? 0)
    if (quantity > 0) held.push({ lineItemId: l.lineItemId, quantity })
  }
  return held
}

// The confirm lease written with the uuid; counts the confirm attempt unless
// this run's first lease already did.
function confirmLease(row: PrintTrailOrderRow, counted: RetryAction[], now: Date) {
  if (counted.includes("confirm")) {
    return { pending_action: "confirm", next_attempt_at: lease(row, "confirm", now).next_attempt_at }
  }
  counted.push("confirm")
  return lease(row, "confirm", now)
}

async function findRow(store: SendStore, orderId: string, sequence: number) {
  const [row] = await store.listPrintTrailOrders({ order_id: orderId, sequence })
  return row ?? null
}

export type CreateDraftInput = {
  order: GraphOrder
  lines: SelectedLine[]
  sequence: number
  // The lines before filterLines (default: lines), to tell held from none.
  selected?: SelectedLine[]
  // What a new row carries (order-scope.ts source_ref).
  sourceRef?: string | null
  // From the orderNumber and payload steps; built here when absent. An
  // existing row keeps its own pt_order_number.
  orderNumber?: string
  prepared?: PreparedPayload
}

export async function createDraft(ctx: SendContext, input: CreateDraftInput): Promise<CreateOutcome> {
  const { store, client, options } = ctx
  const now = nowOf(ctx)
  const methodByLine = Object.fromEntries(input.lines.map((l) => [l.lineItemId, l.method]))
  // Attempts this run's leases count; every outcome carries them back.
  const counted: RetryAction[] = []
  const base = { posted: false, sentLineNumbers: [] as string[], methodByLine, confirmedAt: null, counted }

  let row = await findRow(store, input.order.id, input.sequence)
  // A target may name the row by source_ref only (a claim, a remainder).
  if (!row && input.sourceRef) {
    const [byRef] = await store.listPrintTrailOrders({ order_id: input.order.id, source_ref: input.sourceRef })
    row = byRef ?? null
  }
  if (row) {
    await store.ensureOrderLink(row)
  }

  // Gate check 1 comes first: a row confirmed locally is never touched again
  // by the send path, whatever its lines now are.
  if (row?.confirmed_at) {
    return {
      ...base,
      rowId: row.id,
      outcome: "skip-confirmed",
      pt: null,
      blockReason: null,
      confirmedAt: new Date(row.confirmed_at).toISOString(),
    }
  }

  // A Medusa-cancelled order is never posted; the outcome step queues a
  // cancel for a draft posted earlier.
  if (isCanceled(input.order)) {
    return { ...base, rowId: row?.id ?? null, outcome: "order-canceled", pt: null, blockReason: null }
  }

  const selected = input.selected ?? input.lines
  const held = heldLines(selected, input.lines)
  if (!input.lines.length && held.length && input.sequence === 1 && (!row || (row.block_reason === "held" && !row.pt_uuid))) {
    // Every Print Trail line is held back (filterLines): record a held row
    // so the sweep stops treating the order as missed. No lease.
    if (!row) {
      row = await store.createPrintTrailOrders({
        order_id: input.order.id,
        sequence: input.sequence,
        pt_order_number: printTrailOrderNumber(options.orderNumberPrefix, input.order.display_id, input.sequence),
        block_reason: "held",
        held_lines: held,
        pending_action: null,
        attention: null,
      })
      return { ...base, rowId: row.id, outcome: "held", pt: null, blockReason: "held", heldNew: true }
    }
    if (JSON.stringify(row.held_lines ?? null) !== JSON.stringify(held)) {
      await store.updatePrintTrailOrders({ id: row.id, held_lines: held })
    }
    return { ...base, rowId: row.id, outcome: "held", pt: null, blockReason: "held" }
  }

  if (!input.lines.length) {
    // Nothing to send (no Print Trail lines, or every line held back). An
    // existing draft that lost its lines is blocked; cancelling it is the
    // amend flow's job.
    return {
      ...base,
      rowId: row?.id ?? null,
      outcome: "no-lines",
      pt: null,
      blockReason: row ? "no-pt-lines" : null,
    }
  }

  const orderNumber =
    row?.pt_order_number ??
    input.orderNumber ??
    printTrailOrderNumber(options.orderNumberPrefix, input.order.display_id, input.sequence)
  if (row) {
    // Push the lease out for this run; a due retry keeps its action.
    if (ownsPending(row)) {
      const action = row.pending_action === "confirm" ? "confirm" : "send"
      // A pending action whose count has reached the cap means the earlier
      // runs died before recording an outcome: stop, as a capped retry does.
      if (row.pending_action === action && (row.attempts?.[action] ?? 0) >= RETRY_CAPS[action]) {
        return { ...base, rowId: row.id, outcome: "retry-capped", pt: null, blockReason: null, cappedAction: action }
      }
      const pushed = lease(row, action, now)
      await store.updatePrintTrailOrders({ id: row.id, ...pushed })
      row = { ...row, ...pushed }
      counted.push(action)
    }
  } else {
    row = await store.createPrintTrailOrders({
      order_id: input.order.id,
      sequence: input.sequence,
      pt_order_number: orderNumber,
      source_ref: input.sourceRef ?? null,
      ...lease({}, "send", now),
    })
    counted.push("send")
  }

  // A row with a uuid may already have been confirmed by a run that crashed
  // before writing confirmed_at: look before re-posting.
  let uuid = row.pt_uuid ?? undefined
  if (uuid) {
    let remote: PtOrder | null = null
    try {
      remote = await client.getOrder(uuid)
    } catch (e) {
      const deferral = deferralFor(e)
      if (e instanceof PrintTrailApiError && (deferral || e.isTransient)) {
        return { ...base, rowId: row.id, outcome: "transient", pt: null, blockReason: null, detail: e.detail, ...(deferral ? { deferral } : {}) }
      }
      if (!(e instanceof PrintTrailApiError) || e.status !== 404) {
        throw e
      }
      // Print Trail doesn't know the uuid: post afresh (it upserts by number).
      uuid = undefined
    }
    const adopted = remote ? await adopt(ctx, row, remote, now, { orderCanceled: isCanceled(input.order) }) : null
    if (adopted) {
      return { ...base, ...adopted }
    }
  }

  // Print Trail upserts drafts by order number: a number another row has
  // (a hook's, say) would overwrite that order's draft.
  // A row blocked on this check that never posted doesn't hold the number.
  const taken = (await store.listPrintTrailOrders({ pt_order_number: orderNumber })).some(
    (r) => r.id !== row!.id && !(r.block_reason === "order-number-taken" && !r.pt_uuid)
  )
  if (taken) {
    return {
      ...base,
      rowId: row.id,
      outcome: "blocked",
      pt: null,
      blockReason: "order-number-taken",
      detail: `Another Print Trail order already uses the number ${orderNumber}`,
    }
  }

  const missingSku = input.lines.filter((l) => !l.sku)
  if (missingSku.length) {
    return {
      ...base,
      rowId: row.id,
      outcome: "blocked",
      pt: null,
      blockReason: "unmatched-skus",
      detail: `Lines without a SKU: ${missingSku.map((l) => l.lineItemId).join(", ")}`,
    }
  }

  const prepared = input.prepared ?? preparePayload({ order: input.order, lines: input.lines, orderNumber, options })
  if (!prepared.ok) {
    return { ...base, rowId: row.id, outcome: "blocked", pt: null, blockReason: prepared.reason, detail: prepared.detail }
  }
  // The row's own number and uuid, whatever the steps before built.
  const built = { payload: { ...prepared.payload, orderNumber, ...(uuid ? { uuid } : {}) } }
  if (!uuid) delete built.payload.uuid
  // API 1.2.0 refuses these with a 422; the payload hook's number included.
  const over = orderOverLimits(built.payload)
  if (over) {
    return { ...base, rowId: row.id, outcome: "blocked", pt: null, blockReason: OVER_LIMITS, detail: over }
  }

  const sentLineNumbers = built.payload.orderLines.map((l) => l.lineNumber)
  let pt: PtOrder
  try {
    pt = await client.createOrder(built.payload)
  } catch (e) {
    if (!(e instanceof PrintTrailApiError)) {
      throw e
    }
    const deferral = deferralFor(e)
    if (deferral || e.isTransient) {
      return { ...base, rowId: row.id, outcome: "transient", pt: null, blockReason: null, detail: e.detail, ...(deferral ? { deferral } : {}) }
    }
    if (e.status === 409 && e.isProblem) {
      // Already confirmed or no longer updatable at Print Trail. Since API
      // 1.1.0 the 409 carries the order and a type that names the case; an
      // older Print Trail API sends neither, so the order is looked up by
      // number. Only an order with this order number is ours to adopt; anything
      // else (and its type) is ignored, and the order is looked up instead.
      const own = e.problemOrder?.orderNumber === orderNumber
      const problemType = own || !e.problemOrder ? e.problemType : null
      const carried = own ? e.problemOrder : null
      if (carried) {
        const adopted = await adopt(ctx, row, carried, now, { conflict: true, problemType, orderCanceled: isCanceled(input.order) })
        if (adopted) {
          return { ...base, ...adopted }
        }
        return { ...base, rowId: row.id, outcome: "blocked", pt: carried, blockReason: "conflict", detail: e.detail }
      }
      let remote: PtOrder | null
      try {
        remote = await client.findOrderByNumber(orderNumber)
      } catch (lookup) {
        if (!(lookup instanceof PrintTrailApiError)) {
          throw lookup
        }
        const deferral = deferralFor(lookup)
        if (deferral || lookup.isTransient) {
          return { ...base, rowId: row.id, outcome: "transient", pt: null, blockReason: null, detail: lookup.detail, ...(deferral ? { deferral } : {}) }
        }
        return { ...base, rowId: row.id, outcome: "blocked", pt: null, blockReason: "conflict", detail: e.detail }
      }
      const adopted = remote
        ? await adopt(ctx, row, remote, now, { conflict: true, problemType, orderCanceled: isCanceled(input.order) })
        : null
      if (adopted) {
        return { ...base, ...adopted }
      }
      return { ...base, rowId: row.id, outcome: "blocked", pt: remote, blockReason: "conflict", detail: e.detail }
    }
    if (e.unmatchedSkus.length) {
      return {
        ...base,
        rowId: row.id,
        outcome: "blocked",
        pt: null,
        blockReason: "unmatched-skus",
        detail: `Print Trail doesn't know these SKUs: ${e.unmatchedSkus.join(", ")}`,
        unmatchedSkus: e.unmatchedSkus,
      }
    }
    return {
      ...base,
      rowId: row.id,
      outcome: "blocked",
      pt: null,
      blockReason: `rejected-${e.status}`,
      detail: e.detail,
    }
  }

  // Persist the uuid before anything else, so a retry never creates a second draft.
  await store.updatePrintTrailOrders({
    id: row.id,
    ...snapshotFields(pt, now, row),
    submitted_lines: built.payload.orderLines as unknown as Record<string, unknown>,
    // Fingerprint of the address as prepared, before the payload hook.
    address_hash: prepared.addressHash,
    held_lines: held.length ? held : null,
    ...(row.block_reason === "held" ? { block_reason: null } : {}),
    ...((await ownsPendingNow(store, row.id)) ? confirmLease(row, counted, now) : {}),
  })
  return {
    ...base,
    rowId: row.id,
    outcome: "draft",
    pt,
    blockReason: null,
    posted: true,
    sentLineNumbers,
  }
}

// The order's lines as Print Trail has them, in submitted_lines' shape: one
// entry per line number (a line split across fulfilments is summed), lines
// without a number or quantity left out.
export function remoteSubmittedLines(remote: PtOrder): PtOrderLineInput[] {
  const byNumber = new Map<string, PtOrderLineInput>()
  for (const l of remote.orderLines ?? []) {
    const quantity = Number(l.quantity)
    if (typeof l.lineNumber !== "string" || !l.lineNumber || !(quantity > 0)) continue
    const seen = byNumber.get(l.lineNumber)
    if (seen) {
      seen.quantity += quantity
      if (!seen.product.sku && l.product?.sku) seen.product = { sku: l.product.sku }
    } else {
      byNumber.set(l.lineNumber, { quantity, lineNumber: l.lineNumber, product: l.product?.sku ? { sku: l.product.sku } : {} })
    }
  }
  return [...byNumber.values()]
}

// The lines an adopted row records as sent. A lost row (adopted from a 409,
// found by number, or whose create response was lost) never stored what it
// sent: record the lines Print Trail has, so completion's coverage check and
// the remainder target count them as sent. A row with lines keeps them.
export function adoptedLines(row: PrintTrailOrderRow, remote: PtOrder): Record<string, unknown> {
  const hasSent = Array.isArray(row.submitted_lines) && row.submitted_lines.length > 0
  const remoteLines = hasSent ? [] : remoteSubmittedLines(remote)
  return remoteLines.length ? { submitted_lines: remoteLines as unknown as Record<string, unknown> } : {}
}

// Attention the send path set: its block (block() records the reason as the
// attention too), a stock shortfall, a capped send or confirm.
const SEND_ATTENTION = new Set(["stock-shortfall", "retry-cap:send", "retry-cap:confirm"])
// Blocks the amend flow set from Medusa's side (every Print Trail item
// edited out, no Print Trail shipping method), which still hold for a
// confirmed order: adoption keeps them. A full refund's block becomes
// attention instead (adoptionClears).
const KEPT_BLOCKS = new Set(["no-pt-lines", "no-pt-shipping-method"])
const REFUNDED = "refunded-not-cancelled"

// What adopting a confirmed order clears: the send path's block, its
// attention and error. Another flow's attention is kept with its error.
// A full refund recorded before the confirm (block fully-refunded, its only
// trace) is handled as the refund flow handles a confirmed order, with its
// guards (not already noted, the Medusa order not cancelled, no cancel under
// way, something left to cancel): refund "raise" sets refunded-not-cancelled
// attention; "note" (the row keeps another flow's attention) only writes its
// timeline entry, so the refund stays on record either way.
export function adoptionClears(
  row: PrintTrailOrderRow | undefined,
  remote: PtOrder,
  ctx: { orderCanceled: boolean; noted: boolean }
): { columns: Record<string, unknown>; refund: "raise" | "note" | null } {
  const attention = row?.attention ?? null
  const block = row?.block_reason ?? null
  const keepBlock = !!block && KEPT_BLOCKS.has(block)
  const sendSide = !!attention && ((attention === block && !keepBlock) || SEND_ATTENTION.has(attention))
  const kept = sendSide ? null : attention
  const cancellable = !ctx.orderCanceled && !ctx.noted && !row?.cancel_status && !FINISHED_ORDER_STATUSES.has(remote.status)
  const refund = block === "fully-refunded" && cancellable ? (kept ? "note" : "raise") : null
  return {
    columns: {
      shortfall: null,
      ...(keepBlock ? {} : { block_reason: null }),
      ...(sendSide ? { attention: null } : {}),
      ...(refund === "raise" ? { attention: REFUNDED } : {}),
      // The error goes with the attention it explains: kept with another
      // flow's attention.
      ...(kept ? {} : { last_error: null }),
    },
    refund,
  }
}

// The timeline entry for an order found confirmed at Print Trail and
// recorded here (the send path's adoption and the sync's).
export const ADOPTED_MESSAGE = "Already confirmed at Print Trail; recorded it here"

type Entry = { kind: string; message: string; data?: Record<string, unknown> }

// What recording a confirmation made at Print Trail changes on the row (the
// send path finding the order confirmed, or the sync seeing it): when it was
// confirmed, and what adoptionClears clears, read against the row as stored
// now. The refund entry is returned for the caller to write after its update,
// `raised` names the attention it set (its event is the caller's), and
// `pendingAction` is the row's as stored now.
export async function adoptConfirmation(
  store: Pick<SendStore, "listPrintTrailOrders" | "listPrintTrailOrderEvents">,
  row: PrintTrailOrderRow,
  remote: PtOrder,
  now: Date,
  opts: { orderCanceled: boolean }
): Promise<{ columns: Record<string, unknown>; entries: Entry[]; raised: string | null; pendingAction: string | null }> {
  const [fresh] = await store.listPrintTrailOrders({ id: row.id })
  // The refund flow's marker: a refund it already flagged isn't again.
  const noted =
    fresh?.block_reason === "fully-refunded" &&
    (await store.listPrintTrailOrderEvents({ print_trail_order_id: row.id, kind: REFUNDED })).length > 0
  const clears = adoptionClears(fresh, remote, { orderCanceled: opts.orderCanceled, noted })
  return {
    // As a successful confirm does: a send block (a conflict an older
    // plugin recorded, say) and its error no longer apply. Attention
    // another flow set is kept.
    columns: { confirmed_at: confirmedAtOf(remote, now), ...clears.columns },
    // As the refund flow words it; data.kind marks it noted for that flow.
    entries: clears.refund
      ? [
          {
            kind: REFUNDED,
            message: `The order was refunded in full in Medusa, but Print Trail may still ship ${row.pt_order_number}. Cancel the order to stop it.`,
            data: { kind: REFUNDED, pt_uuid: remote.uuid },
          },
        ]
      : [],
    raised: clears.refund === "raise" ? REFUNDED : null,
    pendingAction: fresh?.pending_action ?? null,
  }
}

async function adopt(
  ctx: SendContext,
  row: PrintTrailOrderRow,
  remote: PtOrder,
  now: Date,
  opts: { conflict?: boolean; problemType?: string | null; orderCanceled?: boolean } = {}
): Promise<Omit<CreateOutcome, "posted" | "sentLineNumbers" | "methodByLine"> | null> {
  const decision = decideCreate(row, remote, opts)
  // "conflict" (only after a 409) returns null too: the caller blocks with
  // the 409's detail.
  if (decision === "post" || decision === "conflict") {
    if (remote.uuid !== row.pt_uuid) {
      await ctx.store.updatePrintTrailOrders({ id: row.id, ...snapshotFields(remote, now, row) })
    }
    return null
  }
  if (decision === "adopt-confirmed") {
    const adoption = await adoptConfirmation(ctx.store, row, remote, now, { orderCanceled: !!opts.orderCanceled })
    const confirmedAt = adoption.columns.confirmed_at as Date
    // The row as stored now, for the snapshot and the lease below (a cancel
    // or amend intent is written outside the lock).
    const [fresh] = await ctx.store.listPrintTrailOrders({ id: row.id })
    await ctx.store.updatePrintTrailOrders({
      id: row.id,
      ...snapshotFields(remote, now, fresh ?? row),
      ...adoptedLines(row, remote),
      ...adoption.columns,
      // In the same write: the send or confirm lease becomes a sync due now
      // (uncounted, run by the sweep), so a run that dies before recording
      // still ends synced. An adopted order may have moved on unseen (a lost
      // row's webhooks matched nothing), and one that has finished (API
      // 1.1.1's not-updatable) sends no more webhooks: only a sync creates
      // its Medusa fulfilments, completes it or flags it.
      // A new sync cycle: a refetch count capped earlier (before the confirm
      // was lost, say) would otherwise leave this one unrun.
      ...(ownsPending(fresh)
        ? { pending_action: "refetch", next_attempt_at: now, attempts: zeroAttempts({ ...(fresh?.attempts ?? {}) }, ["refetch"]) }
        : {}),
    })
    if (adoption.entries.length) {
      // Written here, next to the write that cleared the block, rather than
      // by the outcome step: the refund's trace survives a run that dies
      // before recording.
      await ctx.store.createPrintTrailOrderEvents(
        adoption.entries.map((e) => ({ order_id: row.order_id, print_trail_order_id: row.id, ...e }))
      )
    }
    return {
      rowId: row.id,
      outcome: "adopted-confirmed",
      pt: remote,
      blockReason: null,
      confirmedAt: confirmedAt.toISOString(),
      ...(adoption.raised ? { raised: adoption.raised } : {}),
    }
  }
  // Cancelled at Print Trail: record it and never re-confirm.
  await ctx.store.updatePrintTrailOrders({ id: row.id, ...snapshotFields(remote, now, row) })
  return { rowId: row.id, outcome: "remote-cancelled", pt: remote, blockReason: null, confirmedAt: null }
}

const GATE_FOR_OUTCOME: Partial<Record<CreateOutcome["outcome"], string>> = {
  "skip-confirmed": "already-confirmed",
  "adopted-confirmed": "already-confirmed",
  "remote-cancelled": "pt-cancelled",
  transient: "transient",
  "no-lines": "no-pt-lines",
  "retry-capped": "retry-capped",
  "order-canceled": "order-canceled",
  held: "held",
  "target-refused": "target-refused",
}

export function confirmGate(
  options: PrintTrailPluginOptions,
  order: GraphOrder,
  create: CreateOutcome
): GateOutcome {
  const fixed = GATE_FOR_OUTCOME[create.outcome]
  if (fixed) {
    return { ok: false, reason: fixed, detail: create.detail }
  }
  if (create.outcome === "blocked" || !create.pt) {
    return { ok: false, reason: `blocked:${create.blockReason ?? "unknown"}`, detail: create.detail }
  }
  const { captured, refunded } = paymentTotals(order)
  const gate = evaluateGate({
    confirmedAt: create.confirmedAt,
    canceled: !!order.canceled_at || order.status === "canceled",
    captured,
    refunded,
    confirmOn: options.confirmOn,
    blockReason: create.blockReason,
    pt: create.pt,
    sentLineNumbers: create.sentLineNumbers,
  })
  if (!gate.ok) {
    return gate
  }
  const body = buildConfirmBody(
    create.pt,
    new Map(Object.entries(create.methodByLine)),
    options.defaultShippingMethod
  )
  if (!body.ok) {
    return { ok: false, reason: `blocked:${body.reason}`, detail: body.detail }
  }
  return { ok: true, body: body.body, ...(body.notes ? { notes: body.notes } : {}) }
}

// The gate step: re-reads the order's cancellation and payments first, since
// the order was loaded before a possibly slow create, then decides.
export async function checkGate(ctx: SendContext, order: GraphOrder, create: CreateOutcome): Promise<GateOutcome> {
  const decidesOnOrder = !GATE_FOR_OUTCOME[create.outcome] && create.outcome !== "blocked" && !!create.pt
  const fresh = decidesOnOrder && ctx.reloadGateState ? await ctx.reloadGateState(order.id) : null
  return confirmGate(ctx.options, fresh ? { ...order, ...fresh } : order, create)
}

export async function confirm(
  ctx: SendContext,
  input: { rowId: string; pt: PtOrder; body: PtConfirmRequest; methodByLine: Record<string, string> }
): Promise<ConfirmOutcome> {
  const now = nowOf(ctx)
  let body = input.body
  let notes: string[] | undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const pt = await ctx.client.confirmOrder(input.pt.uuid, body)
      // Written in the same step as the 202, before anything else. A cancel
      // or amend asked for meanwhile keeps its pending action.
      const [fresh] = await ctx.store.listPrintTrailOrders({ id: input.rowId })
      await ctx.store.updatePrintTrailOrders({
        id: input.rowId,
        ...snapshotFields(pt, now, fresh ?? null),
        confirmed_at: now,
        ...(ownsPending(fresh) ? { pending_action: null, next_attempt_at: null } : {}),
      })
      return { outcome: "confirmed", pt, ...(notes ? { notes } : {}) }
    } catch (e) {
      if (!(e instanceof PrintTrailApiError)) {
        throw e
      }
      const deferral = deferralFor(e)
      if (deferral) {
        return { outcome: "transient", pt: input.pt, detail: e.detail, deferral }
      }
      const failure = interpretConfirmError(e)
      if (failure.kind === "shipping-conflict" && attempt === 0) {
        // Fulfilments were regenerated: rebuild against the new uuids, once.
        const [fresh] = await ctx.store.listPrintTrailOrders({ id: input.rowId })
        await ctx.store.updatePrintTrailOrders({ id: input.rowId, ...snapshotFields(failure.order, now, fresh ?? null) })
        const rebuilt = buildConfirmBody(
          failure.order,
          new Map(Object.entries(input.methodByLine)),
          ctx.options.defaultShippingMethod
        )
        if (!rebuilt.ok) {
          return { outcome: "shipping-unavailable", pt: failure.order, detail: rebuilt.detail }
        }
        body = rebuilt.body
        notes = rebuilt.notes ?? []
        continue
      }
      switch (failure.kind) {
        case "stock":
          return { outcome: "stock", pt: input.pt, shortfall: failure.shortfall, detail: e.detail }
        case "not-confirmable":
          return { outcome: "not-confirmable", pt: input.pt, detail: failure.detail }
        case "transient":
          return { outcome: "transient", pt: input.pt, detail: failure.detail }
        case "rejected-403":
          return { outcome: failure.kind, pt: input.pt, detail: e.detail }
        default:
          return { outcome: "invalid", pt: input.pt, detail: e.detail }
      }
    }
  }
  return { outcome: "invalid", pt: input.pt, detail: "Shipping selection conflict persisted" }
}

type Timeline = { kind: string; message: string; data?: Record<string, unknown> }

const retryMessage = (what: string, deferral: Deferral | undefined) =>
  deferral?.refusal
    ? `${ACCESS_REFUSED[deferral.refusal]}, so Print Trail didn't ${what}; it will be retried once access is restored`
    : deferral
      ? `Waiting for Print Trail's rate limit to ${what}; will retry`
      : `Couldn't reach Print Trail to ${what}; will retry`

export async function recordOutcome(
  ctx: SendContext,
  input: {
    orderId: string
    create: CreateOutcome
    gate: GateOutcome
    confirm?: ConfirmOutcome | null
  }
): Promise<PrintTrailEvent[]> {
  const { create, gate } = input
  const confirmed = input.confirm ?? null
  if (!create.rowId) {
    return []
  }
  const now = nowOf(ctx)
  const [row] = await ctx.store.listPrintTrailOrders({ id: create.rowId })
  const timeline: Timeline[] = []
  const events: PrintTrailEvent[] = []
  const update: Record<string, unknown> = { id: create.rowId }
  const eventData = { order_id: input.orderId, print_trail_order_id: create.rowId, pt_uuid: row?.pt_uuid ?? null }

  // The attempts as they were before this run's leases counted it.
  const prior = { attempts: uncount(row?.attempts, create.counted ?? []) }
  if (create.counted?.length) {
    update.attempts = prior.attempts
  }

  // Access refused earlier: any outcome but another refusal clears it (the
  // branches below set their own attention).
  if (row?.attention && ACCESS_ATTENTION.has(row.attention)) {
    update.attention = null
  }

  const retry = (action: RetryAction) => {
    const deferral = confirmed?.deferral ?? create.deferral
    if (deferral) {
      Object.assign(update, deferRetry(prior, action, now, deferral.delayMs), { last_error: confirmed?.detail ?? create.detail ?? null })
      const attention = refusalAttention(row?.attention, deferral.refusal)
      if (attention) {
        update.attention = attention
        if (row?.attention !== attention) {
          events.push({ name: "print_trail.order.attention", data: { ...eventData, attention } })
        }
      }
      return
    }
    const next = scheduleRetry(prior, action, now)
    Object.assign(update, next, { last_error: confirmed?.detail ?? create.detail ?? null })
    if (next.attention) {
      timeline.push({ kind: "retry-capped", message: `Stopped retrying ${action} after ${next.attempts[action]} attempts` })
      events.push({ name: "print_trail.order.attention", data: { ...eventData, attention: next.attention } })
    }
  }
  const block = (reason: string, detail?: string) => {
    Object.assign(update, { block_reason: reason, attention: reason })
    timeline.push({
      kind: "blocked",
      message: `Confirmation blocked: ${reason}${detail ? ` (${detail})` : ""}`,
      // The SKU check re-sends only orders blocked on the SKU it matched.
      ...(reason === "unmatched-skus" && create.unmatchedSkus?.length ? { data: { unmatched_skus: create.unmatchedSkus } } : {}),
    })
    events.push({ name: "print_trail.order.blocked", data: { ...eventData, reason } })
  }

  if (create.posted) {
    timeline.push({ kind: "sent", message: `Sent to Print Trail as ${row?.pt_order_number ?? "draft"}` })
    events.push({ name: "print_trail.order.sent", data: eventData })
  }

  if (confirmed?.outcome === "confirmed") {
    Object.assign(update, clearRetry(prior, "send"))
    update.attempts = clearRetry({ attempts: update.attempts as Record<string, number> }, "confirm").attempts
    // Since API 1.3.0 Print Trail can answer a confirm with an out-of-stock
    // back-order: its attention is set now, with its own event below. Anything else
    // is left to the sync, which emits the attention event and entry as before.
    const backOrderSkus = confirmed.pt ? outOfStockSkus(confirmed.pt) : []
    const attention = backOrderSkus.length && confirmed.pt
      ? remoteAttention({ confirmed_at: now, cancel_requested: row?.cancel_requested ?? null }, confirmed.pt)
      : null
    Object.assign(update, { block_reason: null, attention, shortfall: null, last_error: null })
    timeline.push({ kind: "confirmed", message: "Confirmed with Print Trail" })
    for (const note of confirmed.notes ?? gate.notes ?? []) {
      timeline.push({ kind: "shipping-downgraded", message: note })
    }
    events.push({ name: "print_trail.order.confirmed", data: eventData })
    // Accepted with an out-of-stock back-order (a warehouse that allows
    // them): no retry; the store sold what Print Trail hasn't got, so the
    // shortfall subscriber refreshes those SKUs' stock.
    if (confirmed.pt) {
      // Best effort: the activation scan's record (reconcile is the backstop).
      await markWaitingSkus(ctx.store, confirmed.pt).catch(() => undefined)
    }
    for (const f of confirmed.pt ? waitingFulfilments(confirmed.pt) : []) {
      timeline.push({
        kind: "pt-fulfilment-status",
        message: `Print Trail fulfilment ${f.fulfilmentNumber ?? f.uuid} is waiting for the pre-order release`,
      })
    }
    if (backOrderSkus.length) {
      timeline.push({
        kind: "back-order",
        message: `Print Trail accepted the order with a back-order: ${backOrderSkus.join(", ")} out of stock`,
      })
      events.push({ name: "print_trail.order.attention", data: { ...eventData, attention, back_order_skus: backOrderSkus } })
    }
  } else if (confirmed?.outcome === "transient") {
    retry("confirm")
    timeline.push({ kind: "retry", message: retryMessage("confirm", confirmed.deferral) })
  } else if (confirmed?.outcome === "stock") {
    update.shortfall = confirmed.shortfall as unknown as Record<string, unknown>
    retry("confirm")
    update.attention ??= "stock-shortfall"
    timeline.push({
      kind: "stock-shortfall",
      message: `Print Trail is short of stock: ${(confirmed.shortfall ?? []).map((s) => `${s.sku} (${s.available}/${s.requested})`).join(", ")}`,
    })
    events.push({ name: "print_trail.order.blocked", data: { ...eventData, reason: "stock-shortfall" } })
  } else if (confirmed) {
    const reason = confirmed.outcome === "shipping-unavailable" ? "shipping-method-unavailable" : confirmed.outcome
    Object.assign(update, { pending_action: null, next_attempt_at: null })
    block(reason, confirmed.detail)
  } else if (create.outcome === "transient") {
    retry("send")
    timeline.push({ kind: "retry", message: retryMessage("send the order", create.deferral) })
  } else if (create.outcome === "retry-capped") {
    const attention = `retry-cap:${create.cappedAction}`
    Object.assign(update, { pending_action: null, next_attempt_at: null, attention })
    timeline.push({ kind: "retry-capped", message: `Stopped retrying ${create.cappedAction} after repeated failures` })
    events.push({ name: "print_trail.order.attention", data: { ...eventData, attention } })
  } else if (create.outcome === "adopted-confirmed") {
    // adopt() replaced the lease with a due sync: kept (ownsPending below).
    timeline.push({ kind: "adopted", message: ADOPTED_MESSAGE })
    if (create.raised === REFUNDED) {
      // adopt() wrote its timeline entry.
      events.push({ name: "print_trail.order.attention", data: { ...eventData, attention: REFUNDED } })
    }
  } else if (create.outcome === "held") {
    if (create.heldNew) {
      timeline.push({ kind: "held", message: "All Print Trail items are held back; they'll be sent when released" })
    }
  } else if (create.outcome === "remote-cancelled") {
    Object.assign(update, { pending_action: null, next_attempt_at: null, attention: "pt-cancelled" })
    timeline.push({ kind: "pt-cancelled", message: "Print Trail has cancelled this order; it won't be confirmed again" })
    events.push({ name: "print_trail.order.attention", data: { ...eventData, attention: "pt-cancelled" } })
  } else if (!gate.ok && gate.reason !== "already-confirmed") {
    Object.assign(update, { pending_action: null, next_attempt_at: null })
    if (gate.reason === "order-canceled" || gate.reason === "fully-refunded" || gate.reason === "awaiting-payment") {
      update.block_reason = gate.reason
      timeline.push({ kind: "not-confirmed", message: `Not confirmed: ${gate.reason}` })
    } else {
      block((gate.reason ?? "unknown").replace(/^blocked:/, ""), gate.detail)
    }
  }

  // A pending cancel, amend or refetch belongs to another flow: the send
  // outcome never clears or replaces it.
  if (!ownsPending(row)) {
    delete update.pending_action
    delete update.next_attempt_at
  }

  // A Medusa cancel the send path found (its order.canceled may have been
  // missed): queue the cancel of the draft posted earlier.
  const canceled = create.outcome === "order-canceled" || gate.reason === "order-canceled"
  // A row without a uuid too: a create that timed out may still have
  // reached Print Trail, and cancelRow looks it up by number.
  if (canceled && row && !row.cancel_status) {
    const attempts = { ...((update.attempts as Record<string, number> | undefined) ?? row.attempts ?? {}) }
    zeroAttempts(attempts, ["send", "confirm"])
    Object.assign(update, {
      cancel_requested: true,
      cancel_status: "requested",
      pending_action: "cancel",
      next_attempt_at: now,
      attempts,
    })
    timeline.push({ kind: "cancel-requested", message: "The order was cancelled in Medusa; cancelling it at Print Trail" })
  }

  if (Object.keys(update).length > 1) {
    await ctx.store.updatePrintTrailOrders(update)
  }
  // "Resend as a new Print Trail order" answered the original's Print Trail
  // cancel: once the reissue reached Print Trail, the original no longer
  // needs attention (sync won't raise it again; see remoteAttentionFor).
  const reissueOf = row?.source_ref?.match(/^reissue:(\d+)$/)
  if (reissueOf && (create.posted || confirmed?.outcome === "confirmed")) {
    const [original] = await ctx.store.listPrintTrailOrders({ order_id: input.orderId, sequence: Number(reissueOf[1]) })
    if (original?.attention === "pt-cancelled") {
      await ctx.store.updatePrintTrailOrders({ id: original.id, attention: null })
    }
  }
  if (timeline.length) {
    await ctx.store.createPrintTrailOrderEvents(
      timeline.map((t) => ({
        order_id: input.orderId,
        print_trail_order_id: create.rowId,
        kind: t.kind,
        message: t.message,
        data: t.data ?? null,
      }))
    )
  }
  return events
}
