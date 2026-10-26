import type {
  PtFulfilment,
  PtOrder,
  PtOrderError,
  PtTrackingDetail,
} from "../modules/printTrail/client/types"
import { backOrderKind, isWaitingForRelease, waitsOnInactiveProduct, type BackOrderKind } from "./pre-order"

// Pure decisions behind syncPrintTrailOrder: what changed at Print Trail, what
// needs attention, which Medusa fulfilments to create or ship, and whether
// the order is complete.

export type RemoteChange =
  | { kind: "order-status"; from: string | null; to: string }
  | { kind: "fulfillable-status"; from: string | null; to: string | null }
  // waiting: now waiting for a pre-order release; released: was waiting, isn't.
  | {
      kind: "fulfilment-status"
      uuid: string
      number: string | null
      from: string | null
      to: string
      waiting?: true
      released?: true
    }
  // A back-order whose reason changed with its status unchanged (API 1.3.0:
  // pre-order → out-of-stock when the product goes live before its stock).
  | { kind: "back-order-reason"; uuid: string; number: string | null; from: BackOrderKind; to: BackOrderKind }
  | { kind: "tracking-added"; uuid: string; number: string | null; tracking: PtTrackingDetail[] }
  | { kind: "shipping-method"; uuid: string; number: string | null; from: string; to: string }
  | { kind: "errors"; errors: PtOrderError[] }

const asFulfilments = (v: unknown): PtFulfilment[] => (Array.isArray(v) ? (v as PtFulfilment[]) : [])

const trackingKey = (t: PtTrackingDetail) => t.trackingNumber ?? t.number ?? t.trackingUrl ?? t.url ?? null

// A waiting fulfilment that moves to one of these wasn't released: it was
// stopped, or needs attention. Not holding: Print Trail holds a released
// fulfilment (back to draft) whose warehouse send failed or that failed
// validation, and a waiting one reaches holding no other way (a refetch can
// miss the draft in between). It was released, and the
// hold is still attention.
const NOT_RELEASED = new Set(["cancelled", "invalid", "error", "failed"])

export function diffRemote(
  prev: { status?: string | null; fulfillable_status?: string | null; fulfilments?: unknown; errors?: unknown },
  next: PtOrder
): RemoteChange[] {
  const changes: RemoteChange[] = []
  const prevStatus = prev.status ?? null
  if (prevStatus !== next.status) {
    changes.push({ kind: "order-status", from: prevStatus, to: next.status })
  }
  const prevFulfillable = prev.fulfillable_status ?? null
  const nextFulfillable = next.fulfillableStatus ?? null
  if (prevFulfillable !== nextFulfillable) {
    changes.push({ kind: "fulfillable-status", from: prevFulfillable, to: nextFulfillable })
  }

  const before = asFulfilments(prev.fulfilments)
  for (const f of next.fulfilments ?? []) {
    const number = f.fulfilmentNumber ?? null
    const byUuid = before.find((p) => p.uuid === f.uuid)
    // Amends and confirm regenerate uuids; the number survives.
    const match = byUuid ?? (number ? before.find((p) => p.fulfilmentNumber === number) : undefined)
    const from = match?.status ?? null
    const wasWaiting = !!match && isWaitingForRelease(match)
    const waiting = isWaitingForRelease(f)
    if (from !== f.status) {
      changes.push({
        kind: "fulfilment-status",
        uuid: f.uuid,
        number,
        from,
        to: f.status,
        ...(waiting ? { waiting: true as const } : {}),
        ...(wasWaiting && !waiting && !NOT_RELEASED.has(f.status) ? { released: true as const } : {}),
      })
    } else if (match) {
      const was = backOrderKind(match)
      const is = backOrderKind(f)
      if (was && is && was !== is) {
        changes.push({ kind: "back-order-reason", uuid: f.uuid, number, from: was, to: is })
      }
    }
    const known = new Set((match?.trackingDetails ?? []).map(trackingKey).filter(Boolean))
    const added = (f.trackingDetails ?? []).filter((t) => {
      const key = trackingKey(t)
      return key !== null && !known.has(key)
    })
    if (added.length) {
      changes.push({ kind: "tracking-added", uuid: f.uuid, number, tracking: added })
    }
    const was = byUuid?.requestedShippingMethod
    const now = f.requestedShippingMethod
    if (byUuid && was && now && was !== now) {
      changes.push({ kind: "shipping-method", uuid: f.uuid, number, from: was, to: now })
    }
  }

  const prevErrors = Array.isArray(prev.errors) ? prev.errors : []
  const nextErrors = next.errors ?? []
  if (JSON.stringify(prevErrors) !== JSON.stringify(nextErrors)) {
    changes.push({ kind: "errors", errors: nextErrors })
  }
  return changes
}

// returned: Print Trail marks every fulfilment returned, so nothing ships or
// completes in Medusa; the merchant settles it (pt-returned).
export const ORDER_ATTENTION_STATUSES = ["holding", "back-order", "partial", "error", "invalid", "returned"] as const
// Print Trail's finished statuses: nothing at Print Trail moves these on, and
// a cancel can't stop them (428).
export const FINISHED_ORDER_STATUSES = new Set(["complete", "cancelled", "failed", "returned", "partial"])
export const FULFILMENT_ATTENTION_STATUSES = ["holding", "back-order", "error", "invalid", "failed", "returned"] as const

// Codes sync sets that come from Print Trail's state and are replaced on
// every refetch: any pt-* code and a capped refetch.
// reconcile-failed (a poison order reconcile skipped) clears the same way,
// on the next sync that works.
const REMOTE_SYNC_CODES = new Set(["retry-cap:refetch", "reconcile-failed"])
// Codes sync sets from what happened on the Medusa side. A refetch keeps
// them; their own steps clear them.
export const LOCAL_SYNC_CODES = new Set([
  "dispatch-mismatch",
  "medusa-fulfilment-failed",
  "medusa-complete-failed",
  "dispatched-after-cancel",
  "complete-manually",
])
export const OVERRIDING_ATTENTION = new Set(["pt-cancelled", "pt-draft-after-confirm"])

export function isSyncAttention(code: string | null | undefined): boolean {
  return !!code && (code.startsWith("pt-") || REMOTE_SYNC_CODES.has(code) || LOCAL_SYNC_CODES.has(code))
}

// Print Trail took a confirmed order back to draft (unqueued, unscheduled,
// rebuilt, fully edited). The status stays the test: Print Trail clears
// confirmedAt only together with a move to draft, and an order confirmed before
// confirmedAt existed can read null while queued or holding. confirmedAt only
// rules out a draft-looking order that is still confirmed (an amend's rebuild).
// Absent (an older Print Trail API): the status alone, as before.
export function ptBackToDraft(pt: Pick<PtOrder, "status" | "confirmedAt">): boolean {
  return pt.status === "draft" && typeof pt.confirmedAt !== "string"
}

// A fulfilment's attention key names it by number, which Print Trail keeps
// when it regenerates fulfilments (new uuids, same numbers); the uuid
// stands in without one.
const fulfilmentId = (f: PtFulfilment, i: number) => f.fulfilmentNumber || f.uuid || String(i)

// Every attention Print Trail's order calls for, highest first: the first is
// remoteAttention's code. Order-level codes are their own key; a held
// fulfilment's is `{code}:{fulfilment number}`, one per fulfilment, so a
// dismissal can name the parcels it covered.
export function remoteAttentionKeys(
  row: { confirmed_at?: Date | string | null; cancel_requested?: boolean | null },
  pt: PtOrder
): string[] {
  const fulfilments = pt.fulfilments ?? []
  const cancelled = fulfilments.filter((f) => f.status === "cancelled")
  const allCancelled = pt.status === "cancelled" || (fulfilments.length > 0 && cancelled.length === fulfilments.length)
  if (allCancelled) {
    // A cancel the plugin asked for is the expected outcome.
    return row.cancel_requested ? [] : ["pt-cancelled"]
  }
  if (row.confirmed_at && ptBackToDraft(pt)) {
    return ["pt-draft-after-confirm"]
  }
  const keys: string[] = []
  if (cancelled.length) {
    keys.push("pt-fulfilment-cancelled")
  }
  // A fulfilment waiting for a pre-order release (API 1.3.0) is expected,
  // not attention; a back-order order is attention unless every back-order
  // in it is such a wait.
  const backOrders = fulfilments.filter((f) => f.status === "back-order")
  const onlyWaiting = backOrders.length > 0 && backOrders.every(isWaitingForRelease)
  if ((ORDER_ATTENTION_STATUSES as readonly string[]).includes(pt.status) && !(pt.status === "back-order" && onlyWaiting)) {
    keys.push(`pt-${pt.status}`)
  }
  fulfilments.forEach((f, i) => {
    if ((FULFILMENT_ATTENTION_STATUSES as readonly string[]).includes(f.status) && !isWaitingForRelease(f)) {
      keys.push(`pt-fulfilment-${f.status}:${fulfilmentId(f, i)}`)
    }
  })
  if (
    row.confirmed_at &&
    (pt.fulfillableStatus === "not-fulfillable" || pt.fulfillableStatus === "partially-fulfillable")
  ) {
    keys.push(`pt-${pt.fulfillableStatus}`)
  }
  // Lowest: a pre-order whose product was set inactive while it waited.
  // Print Trail holds it until the product goes active, which may never
  // happen; nothing is wrong with the order itself. Confirmed only, like
  // not-fulfillable: a draft awaiting payment isn't waiting yet.
  if (row.confirmed_at) {
    fulfilments.forEach((f, i) => {
      if (waitsOnInactiveProduct(f)) keys.push(`${PRE_ORDER_INACTIVE}:${fulfilmentId(f, i)}`)
    })
  }
  return keys
}

// The attention code a key stands for (Print Trail codes have no colon).
export const attentionCode = (key: string) => key.split(":")[0]

export function remoteAttention(
  row: { confirmed_at?: Date | string | null; cancel_requested?: boolean | null },
  pt: PtOrder
): string | null {
  const [top] = remoteAttentionKeys(row, pt)
  return top ? attentionCode(top) : null
}

// A Print Trail cancel or full edit always shows. Otherwise a non-sync code
// (a send block, a capped send or confirm, a stock shortfall) is never
// replaced, nor is a Medusa-side sync code; a stale remote code is.
export function nextAttention(current: string | null, remote: string | null): string | null {
  if (remote && OVERRIDING_ATTENTION.has(remote)) {
    return remote
  }
  if (current && (!isSyncAttention(current) || LOCAL_SYNC_CODES.has(current))) {
    return current
  }
  return remote
}

// Final Print Trail codes an admin may dismiss: nothing at Print Trail will
// change them, so once dealt with they'd otherwise stay on the order for good.
export const FINAL_REMOTE_ATTENTION = new Set([
  "pt-returned",
  "pt-fulfilment-returned",
  "pt-partial",
  "pt-fulfilment-failed",
])
// A pre-order held because its product was set inactive (API 1.3.0: only the
// product going active releases it). Dismissable and sticky like the final
// codes: it can last for good, and is raised again only once Print Trail no
// longer calls for it and then does again.
export const PRE_ORDER_INACTIVE = "pt-pre-order-inactive"
// The Print Trail codes an admin may dismiss.
export const DISMISSABLE_REMOTE_ATTENTION = new Set([...FINAL_REMOTE_ATTENTION, PRE_ORDER_INACTIVE])

// The attention to raise from Print Trail's keys: the highest one an admin
// hasn't dismissed. A dismissed key holds back only itself, so a higher code
// coming and going, or another parcel in the same state, is still raised.
export function pickRemote(keys: string[], dismissed: string[]): string | null {
  const held = new Set(dismissed)
  const key = keys.find((k) => !held.has(k))
  return key ? attentionCode(key) : null
}

// The dismissed keys to keep: a Print Trail key is forgotten once Print
// Trail's order no longer calls for it, so it's raised afresh if it comes
// back. Other keys are their own step's to forget.
export function keepDismissed(dismissed: string[], keys: string[]): string[] {
  const now = new Set(keys)
  return dismissed.filter((k) => !k.startsWith("pt-") || now.has(k))
}

// dismissed_attention is text, `{pt_uuid}|{key},{key}` (each part
// percent-encoded): a JSON column would be merged by service updates, so a
// forgotten key couldn't be removed. The
// uuid ties the keys to the Print Trail order they were dismissed on: once
// the row points at another order (an adoption, a lost uuid re-posted) they
// read as nothing, and the next refetch clears them. Every write of pt_uuid
// is covered without each having to clear the column.
export function readDismissed(row: { pt_uuid?: string | null; dismissed_attention?: string | null }): string[] {
  const value = row.dismissed_attention
  if (!value || !row.pt_uuid) return []
  const bar = value.indexOf("|")
  if (bar < 0 || decode(value.slice(0, bar)) !== row.pt_uuid) return []
  return value
    .slice(bar + 1)
    .split(",")
    .filter(Boolean)
    .map(decode)
    .filter((k): k is string => k !== null)
}

// Each part is percent-encoded, so a fulfilment number holding "," or "|"
// can't split the list.
export function writeDismissed(ptUuid: string | null | undefined, keys: string[]): string | null {
  const unique = [...new Set(keys)]
  return unique.length ? `${encodeURIComponent(ptUuid ?? "")}|${unique.map(encodeURIComponent).join(",")}` : null
}

function decode(part: string): string | null {
  try {
    return decodeURIComponent(part)
  } catch {
    return null
  }
}

// remoteAttentionKeys from the row's stored snapshot (what the admin saw).
export function snapshotAttentionKeys(row: {
  status?: unknown
  fulfillable_status?: unknown
  fulfilments?: unknown
  confirmed_at?: Date | string | null
  cancel_requested?: boolean | null
}): string[] {
  const pt = {
    status: typeof row.status === "string" ? row.status : "",
    fulfillableStatus: typeof row.fulfillable_status === "string" ? row.fulfillable_status : null,
    fulfilments: Array.isArray(row.fulfilments) ? row.fulfilments : [],
  } as unknown as PtOrder
  return remoteAttentionKeys(row, pt)
}

export type Label = { tracking_number: string; tracking_url: string; label_url: string }

// Medusa label columns are non-null: missing values are "". The carrier goes
// in the fulfilment's metadata.
export function labelsFrom(tracking: PtTrackingDetail[] | undefined | null): Label[] {
  const labels: Label[] = []
  for (const t of tracking ?? []) {
    const number = t.trackingNumber ?? t.number ?? ""
    const url = t.trackingUrl ?? t.url ?? ""
    if (!number && !url) continue
    labels.push({ tracking_number: number, tracking_url: url, label_url: url })
  }
  return labels
}

export type DispatchOrder = {
  id: string
  status?: string | null
  canceled_at?: Date | string | null
  items: { id: string; quantity: number; fulfilled_quantity: number; shipping_profile_id: string | null }[]
  fulfillments: {
    id: string
    shipped_at?: Date | string | null
    canceled_at?: Date | string | null
    metadata?: Record<string, unknown> | null
    labels: (Label & { id: string })[]
  }[]
  ptOptionIdByProfile: Record<string, string>
}

export type CreateDispatch = {
  ptFulfilmentUuid: string
  ptFulfilmentNumber: string | null
  shippingOptionId: string
  items: { id: string; quantity: number }[]
  labels: Label[]
  metadata: Record<string, unknown>
}

export type DispatchPlan = {
  orderCanceled: boolean
  create: CreateDispatch[]
  ship: { fulfillmentId: string; items: { id: string; quantity: number }[]; labels: Label[] }[]
  addTracking: { fulfillmentId: string; keep: { id: string }[]; added: Label[] }[]
  mismatches: {
    ptFulfilment: string
    lineNumber: string | null
    reason: "unknown-line" | "over-quantity" | "no-print-trail-option"
  }[]
}

export function isOrderCanceled(order: Pick<DispatchOrder, "status" | "canceled_at">): boolean {
  return order.status === "canceled" || !!order.canceled_at
}

// One Medusa fulfilment per dispatched Print Trail fulfilment, created and
// shipped with its tracking. Matching is by the Print Trail fulfilment uuid,
// then its number, so re-runs find what an earlier run made.
export function planDispatch(
  pt: PtOrder,
  order: DispatchOrder,
  row: { id: string; order_id: string }
): DispatchPlan {
  const plan: DispatchPlan = { orderCanceled: false, create: [], ship: [], addTracking: [], mismatches: [] }
  if (isOrderCanceled(order)) {
    plan.orderCanceled = true
    return plan
  }
  const live = order.fulfillments.filter((f) => !f.canceled_at)
  const itemById = new Map(order.items.map((i) => [i.id, i]))
  // Quantity this plan has already given out, per item.
  const allocated = new Map<string, number>()

  for (const f of pt.fulfilments ?? []) {
    if (f.status !== "dispatched") continue
    const number = f.fulfilmentNumber ?? null
    const labels = labelsFrom(f.trackingDetails)
    const carrier = f.trackingDetails?.[0]?.carrier ?? f.trackingDetails?.[0]?.courier ?? null
    const isThis = (m: (typeof live)[number]) =>
      m.metadata?.print_trail_fulfilment_uuid === f.uuid ||
      (!!number && m.metadata?.print_trail_fulfilment_number === number)

    // A Print Trail fulfilment whose lines sit in more than one Print Trail
    // shipping profile becomes one Medusa fulfilment per option.
    const groups = new Map<string, { id: string; quantity: number }[]>()
    const unplaced: DispatchPlan["mismatches"] = []
    for (const line of f.orderLines ?? []) {
      const item = line.lineNumber ? itemById.get(line.lineNumber) : undefined
      if (!item) {
        unplaced.push({ ptFulfilment: f.uuid, lineNumber: line.lineNumber ?? null, reason: "unknown-line" })
        continue
      }
      const optionId = item.shipping_profile_id ? order.ptOptionIdByProfile[item.shipping_profile_id] : undefined
      if (!optionId) {
        unplaced.push({ ptFulfilment: f.uuid, lineNumber: item.id, reason: "no-print-trail-option" })
        continue
      }
      groups.set(optionId, [...(groups.get(optionId) ?? []), { id: item.id, quantity: line.quantity }])
    }

    // Fulfilments made before the option was recorded match any option.
    const matchFor = (optionId: string) =>
      live.find((m) => isThis(m) && m.metadata?.print_trail_shipping_option_id === optionId) ??
      live.find((m) => isThis(m) && !m.metadata?.print_trail_shipping_option_id)
    const matched = new Map([...groups.keys()].map((o) => [o, matchFor(o)] as const))
    // Reported once: when nothing has been created for this fulfilment yet.
    if (![...matched.values()].some(Boolean)) {
      plan.mismatches.push(...unplaced)
    }

    const used = new Set<string>()
    for (const [shippingOptionId, lines] of groups) {
      const match = matched.get(shippingOptionId)
      if (match && !used.has(match.id)) {
        used.add(match.id)
        if (!match.shipped_at) {
          const items = lines.map((l) => ({ id: l.id, quantity: Math.min(l.quantity, itemById.get(l.id)!.quantity) }))
          plan.ship.push({ fulfillmentId: match.id, items, labels })
        } else {
          const have = new Set(match.labels.map((l) => l.tracking_number))
          const added = labels.filter((l) => l.tracking_number && !have.has(l.tracking_number))
          if (added.length) {
            plan.addTracking.push({ fulfillmentId: match.id, keep: match.labels.map((l) => ({ id: l.id })), added })
          }
        }
        continue
      }
      if (match) continue
      const items: { id: string; quantity: number }[] = []
      for (const l of lines) {
        const item = itemById.get(l.id)!
        const remaining = item.quantity - item.fulfilled_quantity - (allocated.get(item.id) ?? 0)
        const quantity = Math.min(l.quantity, remaining)
        if (!(quantity > 0)) {
          plan.mismatches.push({ ptFulfilment: f.uuid, lineNumber: item.id, reason: "over-quantity" })
          continue
        }
        allocated.set(item.id, (allocated.get(item.id) ?? 0) + quantity)
        items.push({ id: item.id, quantity })
      }
      if (!items.length) continue
      plan.create.push({
        ptFulfilmentUuid: f.uuid,
        ptFulfilmentNumber: number,
        shippingOptionId,
        items,
        labels,
        metadata: {
          print_trail_fulfilment_uuid: f.uuid,
          print_trail_fulfilment_number: number,
          print_trail_order_uuid: pt.uuid,
          print_trail_order_id: row.id,
          order_id: row.order_id,
          carrier,
          print_trail_shipping_option_id: shippingOptionId,
        },
      })
    }
  }
  return plan
}

type SubmittedLine = { lineNumber: string; quantity: number }

const asSubmitted = (v: unknown): SubmittedLine[] =>
  Array.isArray(v) ? (v as SubmittedLine[]).filter((l) => l && typeof l.lineNumber === "string") : []

// Every submitted line, by number and quantity, shows dispatched: never
// auto-complete on dispatched fulfilments that don't cover the order.
export function coverageComplete(
  submitted: SubmittedLine[] | null | undefined,
  pt: Pick<PtOrder, "fulfilments">
): boolean {
  if (!submitted?.length) {
    return false
  }
  const shipped = new Map<string, number>()
  for (const f of pt.fulfilments ?? []) {
    if (f.status !== "dispatched") continue
    for (const l of f.orderLines ?? []) {
      if (l.lineNumber) shipped.set(l.lineNumber, (shipped.get(l.lineNumber) ?? 0) + Number(l.quantity))
    }
  }
  return submitted.every((s) => (shipped.get(s.lineNumber) ?? 0) >= Number(s.quantity))
}

export type CompletionInput = {
  autoComplete: boolean
  orderStatus: string | null | undefined
  orderItems: { id: string; quantity: number }[]
  rows: {
    submitted_lines?: unknown
    fulfilments?: unknown
    fulfillable_status?: string | null
    pt_uuid?: string | null
    status?: string | null
  }[]
}

// A Print Trail order cancelled as a whole has nothing to complete; its own
// attention (pt-cancelled) covers it.
const whollyCancelled = (r: CompletionInput["rows"][number]) => {
  const fulfilments = asFulfilments(r.fulfilments)
  return r.status === "cancelled" || (fulfilments.length > 0 && fulfilments.every((f) => f.status === "cancelled"))
}

const SETTLED_ORDER = new Set(["completed", "canceled", "archived"])
const NOT_ALL_SHIPPED = new Set(["partially-fulfillable", "not-fulfillable", "error"])

export function completionDecision(
  input: CompletionInput
): { action: "none" } | { action: "wait" } | { action: "complete" } | { action: "attention"; reason: "other-items" | "incomplete-dispatch" } {
  if (!input.autoComplete || SETTLED_ORDER.has(input.orderStatus ?? "")) {
    return { action: "none" }
  }
  const rows = input.rows.filter((r) => r.pt_uuid && !whollyCancelled(r))
  if (!rows.length) {
    return { action: "none" }
  }
  for (const r of rows) {
    const fulfilments = asFulfilments(r.fulfilments)
    if (!fulfilments.length || fulfilments.some((f) => f.status !== "dispatched" && f.status !== "cancelled")) {
      return { action: "wait" }
    }
  }
  for (const r of rows) {
    const fulfilments = asFulfilments(r.fulfilments)
    if (
      !coverageComplete(asSubmitted(r.submitted_lines), { fulfilments }) ||
      fulfilments.some((f) => f.status === "cancelled") ||
      NOT_ALL_SHIPPED.has(r.fulfillable_status ?? "")
    ) {
      return { action: "attention", reason: "incomplete-dispatch" }
    }
  }
  const sent = new Set(rows.flatMap((r) => asSubmitted(r.submitted_lines).map((l) => l.lineNumber)))
  // Any quantity above 0: an item can be fractional (sold by weight, say).
  if (input.orderItems.some((i) => Number(i.quantity) > 0 && !sent.has(i.id))) {
    return { action: "attention", reason: "other-items" }
  }
  return { action: "complete" }
}

export type MatchRow = { id: string; order_id: string; pt_uuid?: string | null; pt_order_number: string }

export type Match =
  | { kind: "row"; row: MatchRow }
  | { kind: "adopt"; row: MatchRow }
  | { kind: "copy"; row: MatchRow; copyNumber: string }
  | { kind: "unknown"; why: string }

const COPY = /^(.+)-COPY(?:-?\d+)?$/i

// Which local row a Print Trail order belongs to. Only our own create whose
// uuid was never stored is adopted; a copy made in the Print Trail app is
// recognised but never adopted.
export async function matchPrintTrailOrder(
  ref: { uuid?: string | null; orderNumber?: string | null },
  find: { byUuid(uuid: string): Promise<MatchRow | null>; byNumber(n: string): Promise<MatchRow[]> }
): Promise<Match> {
  if (ref.uuid) {
    const row = await find.byUuid(ref.uuid)
    if (row) {
      return { kind: "row", row }
    }
  }
  if (!ref.orderNumber) {
    return { kind: "unknown", why: "unknown-uuid" }
  }
  const exact = (await find.byNumber(ref.orderNumber)).filter((r) => r.pt_order_number === ref.orderNumber)
  const unclaimed = exact.find((r) => !r.pt_uuid)
  if (unclaimed) {
    return { kind: "adopt", row: unclaimed }
  }
  if (exact.length) {
    return { kind: "unknown", why: "number-known-uuid-differs" }
  }
  const copy = ref.orderNumber.match(COPY)
  if (copy) {
    const [base] = (await find.byNumber(copy[1])).filter((r) => r.pt_order_number === copy[1])
    if (base) {
      return { kind: "copy", row: base, copyNumber: ref.orderNumber }
    }
  }
  return { kind: "unknown", why: "unknown-uuid" }
}
