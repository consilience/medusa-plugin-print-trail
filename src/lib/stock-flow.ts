import type { PrintTrailPluginOptions } from "../config"
import type { PrintTrailClient } from "../modules/printTrail/client/client"
import type { PtStockLevel } from "../modules/printTrail/client/types"
import type { SkuCheckStatus } from "./sku-check"
import { readPreOrders, type PreOrderSeenStore, type PreOrderSku } from "./pre-order"
import { normaliseSku } from "./sku"
import {
  acceptDelivery,
  advanceWatermark,
  mergeUnmatched,
  METADATA_SCAN_DEADLINE_MS,
  METADATA_SCAN_PAGE,
  METADATA_SCAN_PAGES,
  planStockSync,
  STATE_KEYS,
  STOCK_FAILURE_CAP,
  type BackorderReason,
  type PreOrderField,
  type SkipReason,
  type StockPlan,
  type StockVariant,
  type Watermark,
} from "./stock"
import type { StateStore } from "./team-code"
import type { VariantCheckRow } from "./variant-checks"

// The stock sync's step logic over small ports: Print Trail's stock levels in,
// Medusa inventory levels and backorder flags out. The workflow takes the
// print-trail:stock lock around runStockSync.

export type StockTrigger = "schedule" | "webhook" | "shortfall" | "dispatch" | "sku-check" | "pending" | "admin"

export type StockSyncInput = {
  trigger: StockTrigger
  changedAt?: string | null
  // Only these SKUs (a shortfall refresh); absent means a full sync.
  skus?: string[]
  // A pending request made only of webhook deliveries: dropped under the lock
  // when the watermark has caught up with it.
  webhookOnly?: boolean
}

export type StockCatalogue = {
  ptProfileIds(): Promise<string[]>
  loadVariants(ptProfileIds: string[]): Promise<StockVariant[]>
  updateLevels(updates: StockPlan["levelUpdates"]): Promise<void>
  // Writes allow_backorder and the print_trail_backorder marker together:
  // on writes the reason's marker (print-on-demand when none is given); off
  // deletes it.
  setBackorder(variantIds: string[], on: boolean, reasonById?: Record<string, BackorderReason>): Promise<void>
  // Writes metadata.print_trail_pre_order (PRE_ORDER_FIELD_KEY); null deletes
  // it. A variant whose stored value already matches is left alone.
  setPreOrderFields(updates: { id: string; value: PreOrderField | null }[]): Promise<void>
  // Deletes the print_trail_backorder marker alone, where the variant still
  // has it; allow_backorder isn't written.
  clearBackorderMarkers(variantIds: string[]): Promise<void>
  // One page of the metadata scan: up to `take` variants with ids after
  // `after` (null: from the first), by id ascending.
  listPluginMetadata(after: string | null, take: number): Promise<MetadataPage>
  // The products in these Print Trail profiles (the run's loadVariants reads
  // the same link, so it may come from there).
  ptProductIds(ptProfileIds: string[]): Promise<Set<string>>
  // The variants Medusa still has (soft-deleted ones left out), of these ids.
  liveVariants(ids: string[]): Promise<{ id: string; productId: string }[]>
}

// print_trail_variant, the SKU checks (PrintTrailModuleService).
export type VariantRowStore = {
  rowPage(after: string | null, take: number): Promise<VariantCheckRow[]>
  forget(filter: { variantIds?: string[]; productIds?: string[] }): Promise<number>
  setCheckStatuses(
    updates: { id: string; expect: { sku: string | null; status: string }; status: SkuCheckStatus | null; at: Date }[]
  ): Promise<number>
  // Queues these variants for the SKU check (drained by the sweep).
  queueChecks(variantIds: string[]): Promise<void>
}

export type PluginMetadata = { id: string; preOrderField: unknown; backorderMarker: BackorderReason | null }

export type MetadataPage = {
  // The page's variants that carry print_trail_pre_order or the marker.
  found: PluginMetadata[]
  // The last id the page read, matched or not; null when it read none.
  lastId: string | null
  // How many variants it read: fewer than `take` means none are left.
  read: number
}

export type StockContext = {
  client: Pick<PrintTrailClient, "stockLevels">
  state: StateStore
  catalogue: StockCatalogue
  options: PrintTrailPluginOptions
  now?: () => Date
  logger?: { warn(msg: string): void; error(msg: string): void }
  // Where SKUs seen on pre-order are kept for the activation scan.
  seen: PreOrderSeenStore
  variants: VariantRowStore
}

export type StockWarning = { type: "duplicate-sku" | "unknown-figure" | "multi-location"; skus: string[] }

export type StockSyncResult =
  | { status: "disabled" | "dropped" }
  | { status: "failed"; error: string }
  | { status: "completed"; plan: StockPlan }

export type StockPending = { requestedAt: string; full: boolean; skus: string[]; changedAt: string | null; webhookOnly?: boolean }

export type StockLastRun = {
  trigger: StockTrigger
  startedAt: string
  completedAt: string
  levelsUpdated: number
  backorderOn: number
  backorderOff: number
  matched: number
  unmatched: number
  skipped: { variantId: string; reason: SkipReason }[]
  // For the admin's SKU health page.
  warnings?: StockWarning[]
  error?: string
}

export const LEVEL_CHUNK = 100
const ERROR_LIMIT = 500

const later = (a: string | null | undefined, b: string | null | undefined): string | null => {
  const ta = a ? Date.parse(a) : NaN
  const tb = b ? Date.parse(b) : NaN
  if (Number.isNaN(ta)) return Number.isNaN(tb) ? (a ?? b ?? null) : b!
  if (Number.isNaN(tb)) return a!
  return tb > ta ? b! : a!
}

const unionSkus = (a: string[], b: string[]) => {
  const out = new Map<string, string>()
  for (const s of [...a, ...b]) {
    const k = normaliseSku(s)
    if (k && !out.has(k)) out.set(k, s)
  }
  return [...out.values()]
}

const isWebhookOnly = (input: StockSyncInput) =>
  input.trigger === "webhook" || (input.trigger === "pending" && input.webhookOnly === true)

// Before the lock: "run" means take the lock and call runStockSync.
export async function admitStockRequest(
  ctx: Pick<StockContext, "state" | "options">,
  input: StockSyncInput
): Promise<"run" | "disabled" | "dropped"> {
  if (!ctx.options.stockSync.enabled) {
    return "disabled"
  }
  if (input.trigger === "webhook") {
    const watermark = await ctx.state.getState<NonNullable<Watermark>>(STATE_KEYS.watermark)
    if (!acceptDelivery(watermark, input.changedAt)) {
      return "dropped"
    }
  }
  return "run"
}

// Merges two requests: full wins, SKUs are unioned, the later changedAt kept.
export function mergeStockRequests(a: StockSyncInput, b: StockSyncInput): StockSyncInput {
  const full = !a.skus || !b.skus
  return {
    trigger: a.trigger,
    changedAt: later(a.changedAt, b.changedAt),
    skus: full ? undefined : unionSkus(a.skus!, b.skus!),
    webhookOnly: isWebhookOnly(a) && isWebhookOnly(b),
  }
}

// The lock is held: record the request for the sweep. A read-merge-write
// outside the lock; see the plan's Status for the window this leaves.
export async function deferStockRequest(state: StateStore, input: StockSyncInput, now: Date): Promise<void> {
  const current = await state.getState<StockPending>(STATE_KEYS.pending)
  const has = !!current?.requestedAt
  const next: StockPending = {
    requestedAt: now.toISOString(),
    full: (has && current!.full) || !input.skus,
    skus: unionSkus(has ? (current!.skus ?? []) : [], input.skus ?? []),
    changedAt: later(has ? current!.changedAt : null, input.changedAt ?? null),
    webhookOnly: (has ? current!.webhookOnly === true : true) && isWebhookOnly(input),
  }
  await state.setState(STATE_KEYS.pending, next)
}

// For the sweep, under the lock: reads and clears stock_sync_pending.
export async function takePendingStockRequest(state: StateStore): Promise<StockSyncInput | null> {
  const pending = await state.getState<StockPending>(STATE_KEYS.pending)
  if (!pending?.requestedAt) {
    return null
  }
  await state.setState(STATE_KEYS.pending, null)
  return {
    trigger: "pending",
    changedAt: pending.changedAt ?? null,
    skus: pending.full ? undefined : pending.skus,
    webhookOnly: pending.webhookOnly === true,
  }
}

// A full run replaces the record; a SKU-only run sets and deletes its own
// SKUs only.
async function recordPreOrders(state: StateStore, preOrders: PreOrderSku[], onlySkus: string[] | undefined, now: Date) {
  const skus: Record<string, PreOrderSku> = {}
  if (onlySkus) {
    for (const [k, v] of await readPreOrders(state)) skus[k] = v
    for (const s of onlySkus) delete skus[normaliseSku(s)]
  }
  for (const p of preOrders) skus[normaliseSku(p.sku)] = p
  await state.setState(STATE_KEYS.preOrders, { skus, updatedAt: now.toISOString() })
}

// The store-facing print_trail_pre_order flag. Tracked like backorders: a
// full run deletes it from a variant it set that has left the run's scope
// (Print Trail's profiles, or inventory management), since nothing else
// would see that variant again.
async function writePreOrderFields(ctx: StockContext, plan: StockPlan, inScope: Set<string>, full: boolean) {
  const flagged = new Set((await ctx.state.getState<{ ids: string[] }>(STATE_KEYS.preOrderFlagged))?.ids ?? [])
  const stale = full ? [...flagged].filter((id) => !inScope.has(id)).map((id) => ({ id, value: null })) : []
  const updates = [...(plan.preOrderFields ?? []), ...stale]
  // Recorded before the write, so a variant can't be flagged untracked.
  const before = flagged.size
  plan.preOrderFlagged?.forEach((id) => flagged.add(id))
  if (flagged.size !== before) await ctx.state.setState(STATE_KEYS.preOrderFlagged, { ids: [...flagged].sort() })
  if (!updates.length) return
  await ctx.catalogue.setPreOrderFields(updates)
  for (const u of updates) if (u.value === null) flagged.delete(u.id)
  await ctx.state.setState(STATE_KEYS.preOrderFlagged, { ids: [...flagged].sort() })
}

const message = (e: unknown) => String((e as Error)?.message ?? e).slice(0, ERROR_LIMIT)

// variant_metadata_scan, written whole after every page (setState replaces
// the stored value).
export type MetadataScan = {
  // The cursor: the last variant id read, ids ascending; null before the
  // first page.
  after: string | null
  // Variants read, and keys deleted, so far.
  scanned: number
  preOrderFields: number
  markers: number
  startedAt: string
  updatedAt: string
  // Set when a page came back short: every variant has been read.
  completedAt: string | null
}

export type MetadataScanLimits = { pageSize: number; maxPages: number; deadlineMs: number }

export const METADATA_SCAN_LIMITS: MetadataScanLimits = {
  pageSize: METADATA_SCAN_PAGE,
  maxPages: METADATA_SCAN_PAGES,
  deadlineMs: METADATA_SCAN_DEADLINE_MS,
}

// What the run that calls the scan knows, all from under its lock.
export type MetadataScanRun = { inScope: Set<string>; tracked: Set<string>; startedAt: Date }

const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n : 0)

// Where the stored scan stands: "done", or the record to continue from (a
// fresh one when there is none). A record with no cursor, such as the
// unreleased first 0.2.0 build's { at } (its offset pages could skip a
// variant), starts again from the first variant.
function resumeScan(stored: Partial<MetadataScan> | null, now: Date): MetadataScan | "done" {
  if (stored?.completedAt) return "done"
  const at = now.toISOString()
  return {
    after: typeof stored?.after === "string" ? stored.after : null,
    scanned: count(stored?.scanned),
    preOrderFields: count(stored?.preOrderFields),
    markers: count(stored?.markers),
    startedAt: stored?.startedAt ?? at,
    updatedAt: stored?.updatedAt ?? at,
    completedAt: null,
  }
}

// Once, spread over full runs until it has read every variant. Before 0.2.0,
// on Medusa 2.19+ (which merges variant metadata), a delete kept the key and
// the plugin then forgot the variant, so a variant that has since left the
// run's scope can't be found from the state rows. Every variant is read once:
// outside the scope, print_trail_pre_order is deleted, and an untracked
// variant's backorder marker (inside the scope the plan's staleMarkers do it).
//
// The stock lock isn't renewed, so a run reads at most limits.maxPages pages
// and starts none once it is limits.deadlineMs old, measured from the run's
// start. Each page is read by id after the cursor (keyset, so a variant
// deleted behind it can't make the scan skip one), its keys are deleted
// against this run's scope and tracking, and only then is the cursor
// stored. A failure is logged; the next full run retries that page.
export async function scanPluginMetadata(
  ctx: StockContext,
  run: MetadataScanRun,
  limits: MetadataScanLimits = METADATA_SCAN_LIMITS
): Promise<void> {
  const now = () => (ctx.now ? ctx.now() : new Date())
  const deadline = run.startedAt.getTime() + limits.deadlineMs
  try {
    let scan = resumeScan(await ctx.state.getState<Partial<MetadataScan>>(STATE_KEYS.metadataScan), now())
    if (scan === "done") return
    for (let page = 0; page < limits.maxPages; page++) {
      if (now().getTime() >= deadline) {
        if (page === 0) {
          ctx.logger?.warn("Print Trail stock sync: no time left in this run to check variant metadata for stale keys; continuing with the next full sync")
        }
        return
      }
      const { found, lastId, read } = await ctx.catalogue.listPluginMetadata(scan.after, limits.pageSize)
      const outside = found.filter((v) => !run.inScope.has(v.id))
      const fields = outside
        .filter((v) => v.preOrderField !== undefined && v.preOrderField !== null)
        .map((v) => ({ id: v.id, value: null }))
      const markers = outside.filter((v) => v.backorderMarker !== null && !run.tracked.has(v.id)).map((v) => v.id)
      if (fields.length) await ctx.catalogue.setPreOrderFields(fields)
      if (markers.length) await ctx.catalogue.clearBackorderMarkers(markers)
      const at = now().toISOString()
      scan = {
        after: lastId ?? scan.after,
        scanned: scan.scanned + read,
        preOrderFields: scan.preOrderFields + fields.length,
        markers: scan.markers + markers.length,
        startedAt: scan.startedAt,
        updatedAt: at,
        completedAt: read < limits.pageSize ? at : null,
      }
      await ctx.state.setState(STATE_KEYS.metadataScan, scan)
      if (scan.completedAt) return
    }
  } catch (e) {
    ctx.logger?.warn(`Print Trail stock sync: couldn't check variant metadata for stale keys: ${message(e)}; trying again with the next full sync`)
  }
}

export const VARIANT_ROW_PAGE = 500

// A trusted full run sees every Print Trail product: the SKU check of a
// variant Medusa no longer has (deleted without an event, as when a product
// update replaces its variants), or whose product has left Print Trail's
// profiles, is forgotten, so its SKU leaves the notice. A product that
// rejoins a profile is checked again when it's saved. A failure is logged;
// the run still completes.
export async function pruneVariantRows(ctx: StockContext, ptProducts: Set<string>): Promise<void> {
  try {
    let after: string | null = null
    for (;;) {
      const rows = await ctx.variants.rowPage(after, VARIANT_ROW_PAGE)
      if (!rows.length) return
      const live = new Map((await ctx.catalogue.liveVariants(rows.map((r) => r.variant_id))).map((v) => [v.id, v.productId]))
      const gone = rows.filter((r) => {
        const productId = live.get(r.variant_id)
        return productId === undefined || !ptProducts.has(productId)
      })
      if (gone.length) await ctx.variants.forget({ variantIds: gone.map((r) => r.variant_id) })
      if (rows.length < VARIANT_ROW_PAGE) return
      after = rows[rows.length - 1].id
    }
  } catch (e) {
    ctx.logger?.warn(`Print Trail stock sync: couldn't forget the SKU checks of deleted variants: ${message(e)}; trying again with the next full sync`)
  }
}

// Under the lock. Returns results; only a state-store error throws.
export async function runStockSync(ctx: StockContext, input: StockSyncInput): Promise<StockSyncResult> {
  const now = () => (ctx.now ? ctx.now() : new Date())
  const startedAt = now().toISOString()
  const watermark = await ctx.state.getState<NonNullable<Watermark>>(STATE_KEYS.watermark)

  // Admission read the watermark before the lock; a delivery that waited for
  // it (or a replay deferred meanwhile) may now be stale.
  if (isWebhookOnly(input) && !acceptDelivery(watermark, input.changedAt)) {
    return { status: "dropped" }
  }

  const record = async (plan: StockPlan | null, error?: string, warnings?: StockWarning[]) => {
    const run: StockLastRun = {
      trigger: input.trigger,
      startedAt,
      completedAt: now().toISOString(),
      levelsUpdated: plan?.levelUpdates.length ?? 0,
      backorderOn: plan?.backorderOn.length ?? 0,
      backorderOff: plan?.backorderOff.length ?? 0,
      matched: plan?.matched.length ?? 0,
      unmatched: plan?.unmatched.length ?? 0,
      skipped: plan?.skipped ?? [],
      ...(warnings?.length ? { warnings } : {}),
      ...(error ? { error } : {}),
    }
    await ctx.state.setState(STATE_KEYS.lastRun, run)
  }

  let levels: PtStockLevel[]
  try {
    levels = await ctx.client.stockLevels()
  } catch (e) {
    const error = message(e)
    await record(null, error)
    return { status: "failed", error }
  }

  // The activation scan's add-only record, from Print Trail's rows before
  // anything else can fail or return early: it changes nothing in Medusa.
  const preOrderRows = levels
    .filter((l) => l && l.status === "pre-order" && typeof l.sku === "string" && l.sku.trim())
    .map((l) => String(l.sku).trim())
  if (preOrderRows.length) {
    try {
      await ctx.seen.markPreOrderSeen(preOrderRows)
    } catch (e) {
      ctx.logger?.warn(`Print Trail stock sync: couldn't record pre-order SKUs: ${message(e)}`)
    }
  }

  // A run that can't see the catalogue or Print Trail's list isn't trusted:
  // nothing is written, switched off or forgotten.
  const untrusted = async (error: string) => {
    ctx.logger?.warn(`Print Trail stock sync (${input.trigger}): ${error}; nothing was changed`)
    await record(null, error)
    return { status: "failed" as const, error }
  }

  let plan: StockPlan | null = null
  let warnings: StockWarning[] = []
  try {
    const profiles = await ctx.catalogue.ptProfileIds()
    if (!profiles.length) {
      return await untrusted("no Print Trail shipping profiles (no shipping option uses the Print Trail provider)")
    }
    const variants = await ctx.catalogue.loadVariants(profiles)
    const tracked = new Set((await ctx.state.getState<{ ids: string[] }>(STATE_KEYS.backordered))?.ids ?? [])
    plan = planStockSync({
      levels,
      variants,
      ptProfileIds: new Set(profiles),
      stockLocationIds: ctx.options.stockLocationIds,
      onlySkus: input.skus,
      tracked,
    })
    if (plan.inScope.length && !levels.some((l) => normaliseSku(l.sku))) {
      plan = null
      return await untrusted("Print Trail returned no stock levels")
    }
    warnings = [
      { type: "duplicate-sku" as const, skus: plan.duplicateSkus },
      { type: "unknown-figure" as const, skus: plan.unknown },
      { type: "multi-location" as const, skus: plan.multiLocationSkus },
    ].filter((w) => w.skus.length)
    for (const w of warnings) {
      const why = {
        "duplicate-sku": "resolved by variants with different inventory items; not written",
        "unknown-figure": "listed by Print Trail without a stock figure; left alone",
        "multi-location": "written to every one of their stock locations (set stockLocationIds to choose)",
      }[w.type]
      ctx.logger?.warn(`Print Trail stock sync: ${w.skus.length} SKUs ${why}: ${w.skus.slice(0, 20).join(", ")}`)
    }

    for (let i = 0; i < plan.levelUpdates.length; i += LEVEL_CHUNK) {
      await ctx.catalogue.updateLevels(plan.levelUpdates.slice(i, i + LEVEL_CHUNK))
    }
    if (plan.backorderOn.length) {
      // Tracked before the write, so a variant can't be backordered untracked.
      plan.backorderOn.forEach((id) => tracked.add(id))
      await ctx.state.setState(STATE_KEYS.backordered, { ids: [...tracked].sort() })
      await ctx.catalogue.setBackorder(plan.backorderOn, true, plan.backorderReason)
    }
    // A full run sees every in-scope variant: a tracked one it didn't see has
    // left Print Trail's profiles (or inventory management), so its plugin
    // backorder comes off. Only tracked variants are ever switched off.
    const inScope = new Set(plan.inScope)
    const stale = input.skus ? [] : [...tracked].filter((id) => !inScope.has(id))
    const off = [...plan.backorderOff, ...stale]
    if (off.length) await ctx.catalogue.setBackorder(off, false)
    off.forEach((id) => tracked.delete(id))
    await ctx.state.setState(STATE_KEYS.backordered, { ids: [...tracked].sort() })
    if (plan.staleMarkers.length) await ctx.catalogue.clearBackorderMarkers(plan.staleMarkers)
    if (plan.preOrderFields) {
      await writePreOrderFields(ctx, plan, inScope, !input.skus)
    }
    if (plan.preOrders) {
      await recordPreOrders(ctx.state, plan.preOrders, input.skus, now())
    }
    // Full runs only: a SKU-only run (a confirm's shortfall, a dispatch, a
    // SKU check) stays short.
    if (!input.skus) {
      let ptProducts: Set<string> | null = null
      try {
        ptProducts = await ctx.catalogue.ptProductIds(profiles)
      } catch (e) {
        ctx.logger?.warn(`Print Trail stock sync: couldn't read the Print Trail products: ${message(e)}; SKU checks are pruned with the next full sync`)
      }
      if (ptProducts) await pruneVariantRows(ctx, ptProducts)
      await scanPluginMetadata(ctx, { inScope, tracked, startedAt: new Date(startedAt) })
    }
  } catch (e) {
    const error = message(e)
    await record(plan, error, warnings)
    return { status: "failed", error }
  }

  const current = (await ctx.state.getState<{ skus: string[] }>(STATE_KEYS.unmatched))?.skus ?? []
  const skus = input.skus
    ? mergeUnmatched(current, { forget: plan.matched, add: plan.unmatched })
    : mergeUnmatched(current, { replace: plan.unmatched })
  await ctx.state.setState(STATE_KEYS.unmatched, { skus, updatedAt: now().toISOString() })
  await record(plan, undefined, warnings)

  // Only a full sync can say stock is current up to changedAt.
  if (input.changedAt && !input.skus) {
    const next = advanceWatermark(watermark, input.changedAt)
    if (next && next !== watermark) {
      await ctx.state.setState(STATE_KEYS.watermark, next)
    }
  }
  return { status: "completed", plan }
}

// Under the lock: takes any pending request into this run. The sweep's own
// "pending" run runs the stored request as it is (so a stale webhook-only one
// is dropped and a SKU-only one stays SKU-only). A failed or throwing run puts
// its request back for the sweep.
export async function runLockedStockSync(ctx: StockContext, input: StockSyncInput): Promise<StockSyncResult> {
  const now = () => (ctx.now ? ctx.now() : new Date())
  const pending = await takePendingStockRequest(ctx.state)
  if (input.trigger === "pending" && !pending) {
    // Another sweep took it.
    return { status: "dropped" }
  }
  const run = input.trigger === "pending" ? pending! : pending ? mergeStockRequests(input, pending) : input
  let result: StockSyncResult
  try {
    result = await runStockSync(ctx, run)
  } catch (e) {
    try {
      await failed(ctx, run, now(), (e as Error)?.message ?? String(e))
    } catch (recordError) {
      // The run's own error is the one to report.
      ctx.logger?.error(`Print Trail stock sync: couldn't record the failure: ${(recordError as Error)?.message ?? recordError}`)
    }
    throw e
  }
  if (result.status === "failed") {
    await failed(ctx, run, now(), result.error)
  } else if (result.status === "completed") {
    if (await ctx.state.getState(STATE_KEYS.failures)) await ctx.state.setState(STATE_KEYS.failures, null)
  }
  return result
}

type StockFailures = { count: number; lastError: string; at: string }

// Keeps a failed run's request for the sweep, until STOCK_FAILURE_CAP runs in
// a row have failed; then it waits for the next scheduled run.
async function failed(ctx: StockContext, run: StockSyncInput, now: Date, error: string) {
  const prior = await ctx.state.getState<StockFailures>(STATE_KEYS.failures)
  const count = (prior?.count ?? 0) + 1
  await ctx.state.setState(STATE_KEYS.failures, { count, lastError: error.slice(0, 500), at: now.toISOString() })
  if (count < STOCK_FAILURE_CAP) {
    await deferStockRequest(ctx.state, run, now)
    return
  }
  ctx.logger?.error(
    `Print Trail stock sync failed ${count} times in a row (last: ${error.slice(0, 200)}); not retrying until the next scheduled run`
  )
}

// The lock is held. The sweep's own pending run records nothing: the request
// is still stored, or the lock holder has taken it.
export async function deferOnLockBusy(state: StateStore, input: StockSyncInput, now: Date): Promise<void> {
  if (input.trigger === "pending") return
  await deferStockRequest(state, input, now)
}
