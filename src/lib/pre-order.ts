import type { PtFulfilment, PtOrder, PtOrderLine, PtStockLevel } from "../modules/printTrail/client/types"
import { normaliseSku } from "./sku"

// STATE_KEYS.preOrders in ./stock (repeated here to keep this module free of
// the stock planner).
export const PRE_ORDERS_KEY = "pre_order_skus"

// Print Trail API 1.3.0 (pre-order products): pre-order lines are held at Print
// Trail as a back-order and released by Print Trail. Pure predicates; each
// field is used when Print Trail sends it, never gated on the API version.

export type BackOrderKind = "pre-order" | "out-of-stock" | "warehouse"

const KNOWN: readonly string[] = ["pre-order", "out-of-stock", "warehouse"]

export const isPreOrderLine = (line: PtOrderLine): boolean => line.product?.activeState === "pre-order"

// Why a back-order fulfilment waits, or null when it isn't back-order.
// backOrderReason decides when the key is present (an unknown value is an
// ordinary back-order). Without it, a fulfilment whose every line's product
// is pre-order waits for release.
export function backOrderKind(f: PtFulfilment): BackOrderKind | null {
  if (f.status !== "back-order") return null
  if ("backOrderReason" in f && f.backOrderReason !== undefined) {
    return typeof f.backOrderReason === "string" && KNOWN.includes(f.backOrderReason)
      ? (f.backOrderReason as BackOrderKind)
      : "out-of-stock"
  }
  const lines = f.orderLines ?? []
  return lines.length > 0 && lines.every(isPreOrderLine) ? "pre-order" : "out-of-stock"
}

export const isWaitingForRelease = (f: PtFulfilment): boolean => backOrderKind(f) === "pre-order"

// A waiting fulfilment with a line whose product was set inactive (Print
// Trail's reason stays pre-order: only the product going active releases it).
// Read from the snapshot's lines, which a stock event with status inactive
// refreshes (scheduleWaitingRefetches).
export const waitsOnInactiveProduct = (f: PtFulfilment): boolean =>
  isWaitingForRelease(f) && (f.orderLines ?? []).some((l) => l.product?.activeState === "inactive")

export const waitingFulfilments = (pt: Pick<PtOrder, "fulfilments">): PtFulfilment[] =>
  (pt.fulfilments ?? []).filter(isWaitingForRelease)

// print_trail_order.pre_order_fulfilments: the uuids of the Print Trail
// fulfilments ever seen waiting for their pre-order release. Add-only, so a
// parcel still counts as the pre-order once it's released and dispatched
// (when its backOrderReason is null).
export const preOrderFulfilmentsOf = (row: { pre_order_fulfilments?: unknown } | null | undefined): string[] =>
  Array.isArray(row?.pre_order_fulfilments) ? row.pre_order_fulfilments.filter((u): u is string => typeof u === "string" && !!u) : []

export const wasPreOrder = (row: { pre_order_fulfilments?: unknown } | null | undefined, ptFulfilmentUuid: string): boolean =>
  preOrderFulfilmentsOf(row).includes(ptFulfilmentUuid)

// Print Trail reports a fulfilment as waiting for its pre-order release when a
// line's product is merely inactive. With no pre-order line it never was a
// pre-order, so it isn't recorded (a genuine pre-order recorded earlier is
// kept: the record is add-only).
const waitsOnlyOnInactive = (f: PtFulfilment): boolean => {
  const lines = f.orderLines ?? []
  return lines.some((l) => l.product?.activeState === "inactive") && !lines.some(isPreOrderLine)
}

const storedFulfilments = (row: { fulfilments?: unknown } | null | undefined): PtFulfilment[] =>
  Array.isArray(row?.fulfilments) ? row.fulfilments.filter((f): f is PtFulfilment => !!f && typeof f === "object") : []

// The column write that adds this snapshot's waiting fulfilments to the
// row's record, or nothing when none is new. The row's stored snapshot
// counts too, as a backfill: a row from before 0.1.1 has no record, and its
// parcel may be released and dispatched before a sync sees it waiting. A
// JSON array is replaced on update, so the union is written whole.
export function rememberWaiting(
  row: { pre_order_fulfilments?: unknown; fulfilments?: unknown } | null | undefined,
  pt: Pick<PtOrder, "fulfilments">
): { pre_order_fulfilments?: string[] } {
  const known = preOrderFulfilmentsOf(row)
  const added = [...waitingFulfilments({ fulfilments: storedFulfilments(row) }), ...waitingFulfilments(pt)]
    .filter((f) => !waitsOnlyOnInactive(f))
    .map((f) => f.uuid)
    .filter((u) => typeof u === "string" && u && !known.includes(u))
  return added.length ? { pre_order_fulfilments: [...known, ...new Set(added)] } : {}
}

// The distinct line SKUs of the order's out-of-stock back-orders.
export function outOfStockSkus(pt: Pick<PtOrder, "fulfilments">): string[] {
  const skus = new Set<string>()
  for (const f of pt.fulfilments ?? []) {
    if (backOrderKind(f) !== "out-of-stock") continue
    for (const l of f.orderLines ?? []) {
      if (l.product?.sku) skus.add(l.product.sku)
    }
  }
  return [...skus]
}

// A fulfilment Print Trail has handed to the warehouse (so a cancel goes
// through it). Print Trail's rule: held ⇔ sentToWarehouseAt null. Without the
// key, anything past draft except a waiting pre-order.
export function hasStarted(f: PtFulfilment): boolean {
  if (f.status === "draft" || f.status === "cancelled") return false
  // Under way whatever sentToWarehouseAt says (Print Trail sends one only once
  // sent; a null here would hide the cancel warning).
  if (f.status === "processing" || f.status === "dispatched") return true
  if ("sentToWarehouseAt" in f && f.sentToWarehouseAt !== undefined) return f.sentToWarehouseAt !== null
  return f.backOrderReason !== "pre-order"
}

// A /stock-levels row's pre-order kind: null unless the row says pre-order
// and carries the limit key (API 1.3.0). preOrderLimit null is unlimited; a
// non-pre-order row's leftover limit is ignored.
export function preOrderKind(row: PtStockLevel): "unlimited" | "limited" | null {
  if (row.status !== "pre-order" || !("preOrderLimit" in row) || row.preOrderLimit === undefined) return null
  return row.preOrderLimit === null ? "unlimited" : "limited"
}

export type PreOrderSku = { sku: string; publicationDate: string | null; limit: number | null; remaining: number | null }

// The stock sync's record of pre-order SKUs (STATE_KEYS.preOrders), keyed by
// normalised SKU.
export async function readPreOrders(state: {
  getState<T>(key: string): Promise<T | null>
}): Promise<Map<string, PreOrderSku>> {
  const stored = await state.getState<{ skus?: Record<string, PreOrderSku> }>(PRE_ORDERS_KEY)
  const map = new Map<string, PreOrderSku>()
  for (const [k, v] of Object.entries(stored?.skus ?? {})) {
    if (v && typeof v === "object") map.set(normaliseSku(k), v)
  }
  return map
}

// The variant widget's lookup: the entry, null when the record doesn't list
// the SKU, undefined when there's no record yet.
export async function preOrderFor(
  state: { getState<T>(key: string): Promise<T | null> },
  sku: string | null
): Promise<PreOrderSku | null | undefined> {
  const stored = await state.getState<{ skus?: Record<string, PreOrderSku> }>(PRE_ORDERS_KEY)
  if (!stored?.skus) return undefined
  if (!sku) return null
  return (await readPreOrders(state)).get(normaliseSku(sku)) ?? null
}

// Every SKU the store has seen held at Print Trail (pre-order, inactive or
// out-of-stock): from a stock run's rows, a confirm or a sync with a held
// fulfilment. The key still says pre_order_seen (it's persisted). Add-only
// (one print_trail_state row per normalised SKU, written race-free by
// queueStateKeys), so a later stock run (a SKU-only refresh, the daily job,
// a fresh install's first run) can never hide a SKU from the activation
// scan. Print Trail puts a status on every stock-level-updated item; only these
// SKUs can have orders waiting on them.
export const PRE_ORDER_SEEN_PREFIX = "pre_order_seen:"

export type PreOrderSeenStore = {
  markPreOrderSeen(skus: string[]): Promise<void>
  // The given SKUs that have been seen, in the order given.
  preOrderSeen(skus: string[]): Promise<string[]>
}

export const preOrderSkusOf = (fulfilments: PtFulfilment[]): string[] => [
  ...new Set(fulfilments.flatMap((f) => (f.orderLines ?? []).map((l) => l.product?.sku ?? "")).filter(Boolean)),
]

// Marks the SKUs of an order's back-orders Print Trail holds: waiting for
// release, and out of stock too, since one switches to pre-order with no
// order webhook when its product goes back on pre-order or inactive, and the
// stock event's scan reads only seen SKUs. Every send and sync store must
// provide markPreOrderSeen: the type requires it, since an optional one let a
// store skip it silently.
export async function markWaitingSkus(store: Pick<PreOrderSeenStore, "markPreOrderSeen">, pt: Pick<PtOrder, "fulfilments">): Promise<void> {
  const held = (pt.fulfilments ?? []).filter((f) => {
    const kind = backOrderKind(f)
    return kind === "pre-order" || kind === "out-of-stock"
  })
  const skus = preOrderSkusOf(held)
  if (skus.length) await store.markPreOrderSeen(skus)
}

// For tests and the module's own unit runs.
export function memoryPreOrderSeen(): PreOrderSeenStore & { keys: Set<string> } {
  const keys = new Set<string>()
  return {
    keys,
    async markPreOrderSeen(skus) {
      for (const s of skus) if (normaliseSku(s)) keys.add(normaliseSku(s))
    },
    async preOrderSeen(skus) {
      return skus.filter((s) => keys.has(normaliseSku(s)))
    },
  }
}
