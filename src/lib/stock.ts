import type { PtStockLevel } from "../modules/printTrail/client/types"
import { PRE_ORDERS_KEY, preOrderKind, type PreOrderSku } from "./pre-order"
import { normaliseSku } from "./sku"

// Stock sync decisions, free of Medusa. GET /stock-levels is Print Trail's
// on-hand stock (no reservations deducted), plus 10000 when print-on-demand
// is enabled for the product.

export const PRINT_ON_DEMAND_MARKER = 10000
export const STOCK_LOCK_KEY = "print-trail:stock"
export const STOCK_LOCK_TTL_SECONDS = 900
// The one-off variant metadata scan (stock-flow.ts) reads pages of
// METADATA_SCAN_PAGE variants, at most METADATA_SCAN_PAGES of them per full
// run (50,000 variants), and starts no page once the run is
// METADATA_SCAN_DEADLINE_MS old: a third of the stock lock's lease, which
// nothing renews. A page's work is bounded, so the run ends well inside it.
export const METADATA_SCAN_PAGE = 500
export const METADATA_SCAN_PAGES = 100
export const METADATA_SCAN_DEADLINE_MS = (STOCK_LOCK_TTL_SECONDS * 1000) / 3
export const STATE_KEYS = {
  watermark: "stock_watermark",
  pending: "stock_sync_pending",
  lastRun: "stock_last_run",
  // Written only by the stock sync, under the stock lock.
  unmatched: "unmatched_skus",
  // 0.2.0's list of the SKU check's not-found results. Read-only since
  // 1.0.0 (the not-found checks are rows now): the SKU check only forgets
  // SKUs from it, and the metadata scan deletes it once complete.
  skuCheckUnmatched: "sku_check_unmatched",
  // The SKU check's own failure count (apart from the stock sync's).
  skuCheckFailures: "sku_check_failures",
  // Re-sends and stock refreshes owed by SKU checks that changed to matched.
  skuCheckFollowUps: "sku_check_follow_ups",
  // The backorders the plugin turned on (Backordered): only those are ever
  // switched off, and each one's reason is shown on the variant page.
  backordered: "stock_backordered",
  // Consecutive failed runs: after STOCK_FAILURE_CAP the sweep stops retrying.
  failures: "stock_failures",
  // Pre-order SKUs from the last runs' rows (API 1.3.0), for the variant
  // widget: { skus: { [normalised]: PreOrderSku }, updatedAt }.
  preOrders: PRE_ORDERS_KEY,
  // Variant ids the plugin wrote print_trail_pre_order on, so one that
  // leaves Print Trail's profiles loses it: { ids }.
  preOrderFlagged: "pre_order_flagged",
  // The one-off scan of every variant's metadata for the plugin's keys,
  // spread over full runs: its cursor and counts (MetadataScan, stock-flow.ts).
  metadataScan: "variant_metadata_scan",
} as const
// Where 0.2.0 and earlier kept the backorder's reason, in variant metadata.
// Since 1.0.0 the reason is in stock_backordered; the metadata scan moves the
// marker there and deletes it.
export const LEGACY_BACKORDER_MARKER_KEY = "print_trail_backorder"

// The store-facing pre-order flag in variant metadata: Print Trail's
// publication date ("YYYY-MM-DD") while the SKU is on pre-order, or true
// when it has none; absent otherwise. Written by the stock sync on every
// variant it manages, whatever the backorder flag or the pre-order limit.
export const PRE_ORDER_FIELD_KEY = "print_trail_pre_order"

export type PreOrderField = string | true

// What a /stock-levels row says the flag should be, or null for none.
export function preOrderFieldOf(row: PtStockLevel | undefined): PreOrderField | null {
  if (row?.status !== "pre-order") return null
  return typeof row.publicationDate === "string" && row.publicationDate.trim() ? row.publicationDate.trim() : true
}

// Why the plugin turned a variant's backorders on.
export type BackorderReason = "print-on-demand" | "pre-order"

// stock_backordered. `ids` is the only authority for which backorders the
// plugin may switch off ("only turn off what the plugin turned on");
// `reasons` maps each id to why, for display. A record from 0.2.0 has no
// `reasons`. Written only by the stock sync, under the stock lock.
export type Backordered = { ids: string[]; reasons?: Record<string, BackorderReason> }

// The legacy marker's value: `true` for print-on-demand, "pre-order" for a
// pre-order product.
export function readBackorderMarker(value: unknown): BackorderReason | null {
  if (value === true) return "print-on-demand"
  if (value === "pre-order") return "pre-order"
  return null
}

// Why the plugin's backorder is on for this variant, or null when the plugin
// doesn't track it (a store's own backorder, or a stale legacy marker). A
// tracked id without a recorded reason reads the legacy marker, else
// print-on-demand (all a tracked id meant before pre-orders).
export function reasonFor(
  record: Backordered | null | undefined,
  variantId: string | null | undefined,
  metadata: Record<string, unknown> | null | undefined
): BackorderReason | null {
  if (!variantId || !record?.ids?.includes(variantId)) return null
  return record.reasons?.[variantId] ?? readBackorderMarker(metadata?.[LEGACY_BACKORDER_MARKER_KEY]) ?? "print-on-demand"
}
export const STOCK_FAILURE_CAP = 3

// 10000 or more is print-on-demand: the warehouse part is written, never the
// marker itself.
export function stockFigure(n: number): { stock: number; printOnDemand: boolean } {
  if (!Number.isFinite(n)) {
    return { stock: 0, printOnDemand: false }
  }
  if (n >= PRINT_ON_DEMAND_MARKER) {
    return { stock: Math.floor(n - PRINT_ON_DEMAND_MARKER), printOnDemand: true }
  }
  return { stock: Math.max(0, Math.floor(n)), printOnDemand: false }
}

export type StockVariant = {
  id: string
  sku: string | null // resolved: override, then sku
  profileId: string | null
  manageInventory: boolean
  allowBackorder: boolean
  // metadata.print_trail_pre_order as stored (undefined when absent).
  preOrderField?: unknown
  inventory: {
    inventoryItemId: string
    requiredQuantity: number
    // reservedQuantity: Medusa's reservations at the level (0 when unknown).
    levels: { locationId: string; stockedQuantity: number; reservedQuantity?: number }[]
  }[]
}

export type SkipReason = "no-sku" | "kit" | "no-level" | "shared-item-conflict" | "duplicate-sku" | "unknown-figure"

export type StockPlan = {
  levelUpdates: { inventory_item_id: string; location_id: string; stocked_quantity: number }[]
  backorderOn: string[]
  // One entry per id in backorderOn.
  backorderReason: Record<string, BackorderReason>
  backorderOff: string[]
  // The wanted reason of every variant whose plugin backorder is on after
  // this run (turned on now, or tracked and still wanted), apart from
  // conflicted items. A tracked variant whose reason changes isn't written
  // again: only its reason in the record changes.
  reasons: Record<string, BackorderReason>
  // SKUs whose row says pre-order (API 1.3.0). Absent when no row carries a
  // status key (an older Print Trail API): the stored record is left alone.
  preOrders?: PreOrderSku[]
  // The print_trail_pre_order writes (null deletes), only where the stored
  // value differs. Absent with preOrders.
  preOrderFields?: { id: string; value: PreOrderField | null }[]
  // In-scope variants whose flag is (or is being) set.
  preOrderFlagged?: string[]
  matched: string[]
  unmatched: string[]
  // SKUs Print Trail listed without a usable figure: left alone.
  unknown: string[]
  // SKUs resolved by variants with different inventory items: not written,
  // since each would get the full figure.
  duplicateSkus: string[]
  // SKUs whose figure went to more than one level (stockLocationIds unset).
  multiLocationSkus: string[]
  skipped: { variantId: string; reason: SkipReason }[]
  // Every variant that passed the own-stock guard (before onlySkus).
  inScope: string[]
}

// Print Trail's figure as a number, or null when it isn't one (null, "", junk).
const figureOf = (stock: unknown): number | null => {
  const n = typeof stock === "number" ? stock : typeof stock === "string" && stock.trim() ? Number(stock) : NaN
  return Number.isFinite(n) ? n : null
}

const dedupe = (skus: string[]): string[] => {
  const seen = new Map<string, string>()
  for (const s of skus) {
    const k = normaliseSku(s)
    if (k && !seen.has(k)) seen.set(k, s.trim())
  }
  return [...seen.values()]
}

const sortSkus = (skus: string[]) => [...skus].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }))

type Candidate = {
  v: StockVariant
  sku: string
  key: string
  figure: { stock: number; printOnDemand: boolean }
  // The backorder the plugin wants on, or null.
  reason: BackorderReason | null
  // A limited pre-order: the figure is what remains after Print Trail's
  // committed quantity, so each level adds back its own reservations.
  limited: boolean
  item: StockVariant["inventory"][0]
  levels: StockVariant["inventory"][0]["levels"]
}

// `tracked` is the plugin's own record of the backorders it switched on
// (stock_backordered's ids). Only those are ever switched off, and a store's
// own backorder (on, untracked) is never claimed.
export function planStockSync(input: {
  levels: PtStockLevel[]
  variants: StockVariant[]
  ptProfileIds: Set<string>
  stockLocationIds?: string[]
  onlySkus?: string[]
  tracked?: Set<string>
}): StockPlan {
  const pt = new Map<string, number>()
  const rowOf = new Map<string, PtStockLevel>()
  const unknownKeys = new Map<string, string>()
  for (const row of input.levels) {
    const k = normaliseSku(row.sku)
    if (!k) continue
    const n = figureOf(row.stock)
    if (n === null) {
      if (!unknownKeys.has(k)) unknownKeys.set(k, String(row.sku).trim())
    } else if (!pt.has(k)) {
      pt.set(k, n)
      rowOf.set(k, row)
    }
  }
  for (const k of pt.keys()) unknownKeys.delete(k)
  // The row whose status counts: the figure's row, else the SKU's first
  // (a status holds without a usable figure).
  const statusRow = new Map<string, PtStockLevel>()
  for (const row of input.levels) {
    const k = normaliseSku(row?.sku)
    if (k && !statusRow.has(k)) statusRow.set(k, rowOf.get(k) ?? row)
  }
  const hasStatus = input.levels.some((l) => l && typeof l === "object" && "status" in l)
  const only = input.onlySkus ? new Set(input.onlySkus.map(normaliseSku)) : null
  const locations = input.stockLocationIds?.length ? new Set(input.stockLocationIds) : null
  const tracked = input.tracked ?? new Set<string>()

  const plan: StockPlan = {
    levelUpdates: [],
    backorderOn: [],
    backorderReason: {},
    backorderOff: [],
    reasons: {},
    matched: [],
    unmatched: [],
    unknown: [],
    duplicateSkus: [],
    multiLocationSkus: [],
    skipped: [],
    inScope: [],
  }
  const off = (v: StockVariant) => tracked.has(v.id) && plan.backorderOff.push(v.id)
  if (hasStatus) {
    plan.preOrderFields = []
    plan.preOrderFlagged = []
  }
  // The store-facing flag is the SKU's status, apart from inventory: a kit,
  // a duplicate SKU or a variant with no level still gets it.
  const flag = (v: StockVariant, key: string) => {
    if (!hasStatus) return
    const value = key ? preOrderFieldOf(statusRow.get(key)) : null
    const stored = v.preOrderField
    const same = value === null ? stored === undefined || stored === null : stored === value
    if (!same) plan.preOrderFields!.push({ id: v.id, value })
    if (value !== null) plan.preOrderFlagged!.push(v.id)
  }
  const candidates: Candidate[] = []
  // The variants this run decides for (in scope, and in onlySkus).
  const seen: StockVariant[] = []

  for (const v of input.variants) {
    // The own-stock guard.
    if (!v.manageInventory || !v.profileId || !input.ptProfileIds.has(v.profileId)) continue
    plan.inScope.push(v.id)
    if (only && !only.has(normaliseSku(v.sku))) continue
    seen.push(v)

    const key = normaliseSku(v.sku)
    flag(v, key)
    if (!key) {
      plan.skipped.push({ variantId: v.id, reason: "no-sku" })
      // Can't confirm print-on-demand: a plugin backorder comes off.
      off(v)
      continue
    }
    const sku = v.sku!.trim()
    if (unknownKeys.has(key)) {
      // Listed without a figure: unknown, not unmatched. Nothing changes.
      plan.unknown.push(sku)
      plan.skipped.push({ variantId: v.id, reason: "unknown-figure" })
      continue
    }
    const n = pt.get(key)
    if (n === undefined) {
      plan.unmatched.push(sku)
      // Can't confirm print-on-demand any more: never leave a backorder the
      // plugin set, so nothing ships short.
      off(v)
      continue
    }
    if (v.inventory.length !== 1 || v.inventory[0].requiredQuantity !== 1) {
      plan.skipped.push({ variantId: v.id, reason: "kit" })
      off(v)
      continue
    }
    plan.matched.push(sku)
    const item = v.inventory[0]
    // A limited pre-order's figure is what remains of the limit (Print Trail
    // sends it as stock too), so Medusa stops at the cap; no backorders. An
    // unlimited one keeps its physical stock with backorders on.
    const row = rowOf.get(key)!
    const kind = preOrderKind(row)
    const remaining = kind === "limited" ? figureOf(row.preOrderRemaining) : null
    // Never the print-on-demand sentinel: Print Trail sends what remains instead.
    const figure = remaining !== null ? { stock: Math.max(0, Math.floor(remaining)), printOnDemand: false } : stockFigure(n)
    candidates.push({
      v,
      sku,
      key,
      figure,
      reason: figure.printOnDemand ? "print-on-demand" : kind === "unlimited" ? "pre-order" : null,
      limited: remaining !== null,
      item,
      levels: item.levels.filter((l) => !locations || locations.has(l.locationId)),
    })
  }

  // One SKU, several inventory items: each would get the full figure, so the
  // store would sell the stock twice.
  const itemsBySku = new Map<string, Set<string>>()
  for (const c of candidates) {
    itemsBySku.set(c.key, (itemsBySku.get(c.key) ?? new Set()).add(c.item.inventoryItemId))
  }
  const duplicate = new Set([...itemsBySku].filter(([, items]) => items.size > 1).map(([k]) => k))

  // Writes wanted per inventory item, so two variants sharing one can't
  // overwrite each other with different figures.
  const wanted = new Map<string, { stock: number; conflict: boolean; candidates: Candidate[] }>()
  for (const c of candidates) {
    if (duplicate.has(c.key)) {
      plan.skipped.push({ variantId: c.v.id, reason: "duplicate-sku" })
      plan.duplicateSkus.push(c.sku)
      if (!c.reason) off(c.v)
      continue
    }
    if (!c.levels.length) {
      plan.skipped.push({ variantId: c.v.id, reason: "no-level" })
    } else {
      const w = wanted.get(c.item.inventoryItemId)
      if (!w) wanted.set(c.item.inventoryItemId, { stock: c.figure.stock, conflict: false, candidates: [c] })
      else {
        w.candidates.push(c)
        if (w.stock !== c.figure.stock) w.conflict = true
      }
    }
  }

  const conflicted = new Set<string>()
  for (const [itemId, w] of wanted) {
    if (w.conflict) {
      conflicted.add(itemId)
      for (const c of w.candidates) plan.skipped.push({ variantId: c.v.id, reason: "shared-item-conflict" })
      continue
    }
    if (!locations && w.candidates[0].levels.length > 1) plan.multiLocationSkus.push(w.candidates[0].sku)
    const limited = w.candidates[0].limited
    // A limited pre-order's allowance is one figure, and Medusa sums
    // availability over levels: it goes to one level (the first configured
    // stockLocationIds entry, else the first by location id), and the
    // others are left with nothing available.
    const order = input.stockLocationIds ?? []
    const rank = (id: string) => (order.indexOf(id) === -1 ? order.length : order.indexOf(id))
    const home = limited
      ? [...w.candidates[0].levels].sort((a, b) => rank(a.locationId) - rank(b.locationId) || a.locationId.localeCompare(b.locationId))[0]
      : undefined
    for (const l of w.candidates[0].levels) {
      // Print Trail's preOrderRemaining already deducts the confirmed pre-orders
      // Medusa still holds reservations for: add those back, so Medusa's
      // availability (stocked − reserved) is what remains of the limit.
      const raw = Number(l.reservedQuantity ?? 0)
      const reserved = Number.isFinite(raw) && raw > 0 ? raw : 0
      const stock = !limited ? w.stock : l === home ? w.stock + reserved : reserved
      if (Number(l.stockedQuantity) !== stock) {
        plan.levelUpdates.push({ inventory_item_id: itemId, location_id: l.locationId, stocked_quantity: stock })
      }
    }
  }

  for (const c of candidates) {
    if (duplicate.has(c.key)) continue
    if (c.reason) {
      // A conflicting item's variants are left as they are.
      if (conflicted.has(c.item.inventoryItemId)) continue
      // On where it's off. A store's own backorder (on, untracked) is never
      // claimed; a tracked one only has its reason recorded.
      if (!c.v.allowBackorder) {
        plan.backorderOn.push(c.v.id)
        plan.backorderReason[c.v.id] = c.reason
        plan.reasons[c.v.id] = c.reason
      } else if (tracked.has(c.v.id)) {
        plan.reasons[c.v.id] = c.reason
      }
    } else {
      off(c.v)
    }
  }

  if (hasStatus) {
    const seen = new Set<string>()
    plan.preOrders = []
    for (const row of input.levels) {
      const k = normaliseSku(row.sku)
      if (!k || seen.has(k) || row.status !== "pre-order" || (only && !only.has(k))) continue
      seen.add(k)
      plan.preOrders.push({
        sku: String(row.sku).trim(),
        publicationDate: typeof row.publicationDate === "string" ? row.publicationDate : null,
        limit: figureOf(row.preOrderLimit),
        remaining: figureOf(row.preOrderRemaining),
      })
    }
  }

  plan.matched = sortSkus(dedupe(plan.matched))
  plan.unmatched = sortSkus(dedupe(plan.unmatched))
  plan.unknown = sortSkus(dedupe(plan.unknown))
  plan.duplicateSkus = sortSkus(dedupe(plan.duplicateSkus))
  plan.multiLocationSkus = sortSkus(dedupe(plan.multiLocationSkus))
  return plan
}

export type Watermark = { changedAt: string } | null

const instant = (s: string | null | undefined): number | null => {
  if (typeof s !== "string" || !s) return null
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : t
}

// Drops a stock-level-updated delivery that isn't later than the greatest
// changedAt already applied (Print Trail's clock, compared as instants).
export function acceptDelivery(watermark: Watermark, changedAt: string | null | undefined): boolean {
  const t = instant(changedAt)
  const w = instant(watermark?.changedAt)
  if (t === null || w === null) return true
  return t > w
}

export function advanceWatermark(watermark: Watermark, changedAt: string | null | undefined): Watermark {
  const t = instant(changedAt)
  if (t === null) return watermark
  const w = instant(watermark?.changedAt)
  if (w !== null && w >= t) return watermark
  return { changedAt: changedAt! }
}

export function mergeUnmatched(
  current: string[],
  opts: { replace?: string[]; add?: string[]; forget?: string[] }
): string[] {
  const forget = new Set((opts.forget ?? []).map(normaliseSku))
  const base = opts.replace ?? current
  const merged = dedupe([...base, ...(opts.add ?? [])]).filter((s) => !forget.has(normaliseSku(s)))
  return sortSkus(merged)
}

// print_trail_order.shortfall → distinct non-empty SKUs.
export function shortfallSkus(shortfall: unknown): string[] {
  if (!Array.isArray(shortfall)) return []
  return dedupe(
    shortfall.flatMap((s) => (s && typeof s === "object" && typeof (s as { sku?: unknown }).sku === "string" ? [(s as { sku: string }).sku] : []))
  )
}

// What readUnmatchedSkus reads; PrintTrailModuleService satisfies it.
export type UnmatchedSkuStore = {
  getState<T>(key: string): Promise<T | null>
  // The SKUs whose stored check is not-found (print_trail_variant).
  notFoundSkus(): Promise<string[]>
}

// The unmatched SKUs for the health page and the notice: the last stock
// sync's list, the SKU checks' not-found results (which leave with the
// variant's row), and the list 0.2.0's SKU check kept, while it exists.
export async function readUnmatchedSkus(store: UnmatchedSkuStore): Promise<string[]> {
  const stock = (await store.getState<{ skus: string[] }>(STATE_KEYS.unmatched))?.skus ?? []
  const notFound = await store.notFoundSkus()
  const legacy = (await store.getState<{ skus: string[] }>(STATE_KEYS.skuCheckUnmatched))?.skus ?? []
  return mergeUnmatched(stock, { add: [...notFound, ...legacy] })
}

type StoredLine = { lineNumber?: string | null; product?: { sku?: string | null } | null }

// The SKUs of one dispatched Print Trail fulfilment, from the row's stored
// fulfilments; a line whose product has no SKU there takes it from the lines
// the plugin submitted (matched on lineNumber).
export function dispatchedSkus(
  row: { fulfilments?: unknown; submitted_lines?: unknown },
  ptFulfilmentUuid: string
): string[] {
  const fulfilments = Array.isArray(row.fulfilments) ? (row.fulfilments as { uuid?: string; orderLines?: StoredLine[] }[]) : []
  const submitted = Array.isArray(row.submitted_lines) ? (row.submitted_lines as StoredLine[]) : []
  const f = fulfilments.find((x) => x?.uuid === ptFulfilmentUuid)
  const skus = (f?.orderLines ?? []).flatMap((line) => {
    const sku = line?.product?.sku || submitted.find((s) => s?.lineNumber && s.lineNumber === line?.lineNumber)?.product?.sku
    return typeof sku === "string" && sku.trim() ? [sku] : []
  })
  return dedupe(skus)
}
